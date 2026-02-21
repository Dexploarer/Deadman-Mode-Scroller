import { Hono, type Context } from "hono";
import { nanoid } from "nanoid";
import type {
  ActionSubmission,
  Account,
  AccountType,
  Character,
  Agent,
  AgentProfile,
  GameMode,
  MarketOrder,
  PvpLeaderboardEntry,
  QuestLeaderboardEntry,
  SkillLeaderboardEntry,
  SkillName,
  TradeOffer,
  Challenge,
  CastSpellRequest,
  DuelQueueEntry,
  DuelRules,
  Fight,
  Arena,
  PortalTravelRequest,
  SpellName,
  WorldInteractRequest,
  ResourceNode,
} from "./types";
import {
  accounts,
  activeSkillJobs,
  banks,
  characters,
  createCharacter,
  createOrGetAccount,
  createSession,
  createWalletChallenge,
  destroySession,
  agentProgress,
  agents,
  agentProfiles,
  getAccountCharacters,
  getCharacterBank,
  getSession,
  challenges,
  duelQueue,
  duelQueueFallbackTimers,
  duelQueueSubscribers,
  fights,
  fightTickTimers,
  fightSubscribers,
  getActiveWorldAgents,
  getLeaderboard,
  getOrCreateProgress,
  getQueueEntries,
  getResourceNodes,
  nodeRespawnTimers,
  queueJoin,
  queueLeave,
  resourceNodes,
  marketOrders,
  selectCharacter,
  selectedModes,
  sessions,
  setResourceNodes,
  skillSubscribers,
  tradeOffers,
  type SocketLike,
  updateResourceNode,
  verifyWalletChallenge,
  getVisibleWorldAgents,
  upsertProgress,
  upsertWorldAgent,
  worldAgents,
  worldSubscribers,
  getEloTitle,
  updateElo,
} from "./store";
import { createPlayerState, resolveTick } from "./engine";
import {
  F2P_SKILL_ORDER,
  addInventory,
  addXp,
  applyCombatXp,
  consumeInventory,
  createDefaultProgress,
  getInventoryQty,
} from "./progression";
import {
  canGatherNode,
  distance,
  getGatherInterval,
  isNodeTrainableInMode,
  getPortalById,
  getSkillLevel,
  isTravelWithinBudget,
  getWorldAreaById,
  getWorldAreas,
  getWorldPortals,
  INTERACTION_MAX_DISTANCE,
  listPortalsForArea,
  makeDefaultResourceNodes,
  markNodeDepleted,
  markNodeRespawned,
  rollGatherSuccess,
} from "./world";
import {
  claimQuestReward,
  chooseDialogue,
  evaluateQuestProgress,
  getQuestLog,
  startQuest,
  recordAreaVisit,
  recordDuelWin,
  recordSpellCast,
  startDialogue,
} from "./quests";
import {
  appendDuelTick,
  deleteMarketOrder,
  deleteSessionRecord,
  deleteWalletNonce,
  appendSkillEvent,
  listOpenMarketOrders,
  loadAccountByWallet,
  loadAgentProgress,
  loadBankInventory,
  loadCharactersByAccount,
  loadSessionRecord,
  loadWalletNonce,
  loadResourceNodes,
  saveBankInventory,
  saveWalletNonce,
  saveAgentProgress,
  loadAgentProfile,
  upsertAccount,
  upsertAgent,
  upsertAgentProfile,
  upsertCharacter,
  upsertDuelSummary,
  upsertMarketOrder,
  upsertResourceNodes,
  upsertSessionRecord,
  upsertTradeOffer,
  queryPvpLeaderboard,
  queryQuestLeaderboard,
  querySkillLeaderboard,
} from "./db/repository";

const api = new Hono();

const DEFAULT_DUEL_RULES: DuelRules = {
  no_prayer: false,
  no_food: false,
  no_special_attack: false,
};

const BOT_FALLBACK_AFTER_MS = Number(process.env.BOT_FALLBACK_AFTER_MS ?? "12000");
const BOT_QUEUE_PREFIX = "QueueBot";
const DUEL_TICK_MS = Number(process.env.DUEL_TICK_MS ?? "600");
const ACTION_TIMEOUT_MS = Number(process.env.ACTION_TIMEOUT_MS ?? "1600");
const CHARACTER_SLOT_LIMIT = 3;
const DEV_GUEST_AUTH_ENABLED = process.env.DEV_GUEST_AUTH_ENABLED === "1";
const LEGACY_ARENA_REGISTER_ENABLED = process.env.ALLOW_LEGACY_ARENA_REGISTER !== "0";
const BASE_MODE: GameMode = "f2p_2007";
const MODES_AVAILABLE: Record<GameMode, { enabled: boolean; note: string }> = {
  f2p_2007: { enabled: true, note: "Base persistent mode" },
  seasonal: { enabled: false, note: "Seasonal worlds unlock after base parity milestone" },
  deadman: { enabled: false, note: "Deadman unlocks after seasonal systems are stable" },
};

function getModeForAgent(agentId: string): GameMode {
  return selectedModes.get(agentId) ?? BASE_MODE;
}

function parseSessionToken(c: Context): string | null {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim();
  }
  const direct = c.req.header("x-session-token");
  if (direct && direct.length > 0) return direct;
  const query = c.req.query("session_token");
  if (query && query.length > 0) return query;
  return null;
}

async function resolveSession(c: Context): Promise<{
  session_token: string;
  account_id: string;
  character_id: string | null;
  created_at: number;
  expires_at: number;
} | null> {
  const sessionToken = parseSessionToken(c);
  if (!sessionToken) return null;
  const inMemory = getSession(sessionToken);
  if (inMemory) return inMemory;

  const persisted = await loadSessionRecord(sessionToken);
  if (!persisted) return null;
  if (persisted.expires_at < Date.now()) {
    await deleteSessionRecord(sessionToken);
    return null;
  }

  sessions.set(sessionToken, persisted);
  return persisted;
}

function ensureProgressForAgent(agentId: string) {
  const progress = getOrCreateProgress(agentId);
  if (!agentProgress.has(agentId)) {
    agentProgress.set(agentId, progress);
  }
  return progress;
}

async function hydrateProgressFromDb(agentId: string): Promise<void> {
  if (agentProgress.has(agentId)) return;
  const persisted = await loadAgentProgress(agentId);
  if (persisted) {
    upsertProgress({
      ...createDefaultProgress(agentId),
      ...persisted,
      skills: {
        ...createDefaultProgress(agentId).skills,
        ...persisted.skills,
      },
    });
    return;
  }
  upsertProgress(getOrCreateProgress(agentId));
  await saveAgentProgress(getOrCreateProgress(agentId));
}

function ensureAgentForCharacter(character: Character): Agent {
  const existing = agents.get(character.character_id);
  if (existing) return existing;
  const created: Agent = {
    agent_id: character.character_id,
    skills_md: "",
    wallet_address: "",
    combat_class: character.combat_class,
    prayer_book: "normal",
    wins: 0,
    losses: 0,
    elo: 1000,
    registered_at: character.created_at,
  };
  agents.set(created.agent_id, created);
  return created;
}

function normalizeAccountType(value: unknown): AccountType {
  if (value === "agent" || value === "guest") return value;
  return "human";
}

function getAccountType(session: { account_id: string; actor_type?: AccountType } | null): AccountType {
  if (!session) return "human";
  if (session.actor_type) return session.actor_type;
  return accounts.get(session.account_id)?.account_type ?? "human";
}

function isGuestSession(session: { account_id: string; actor_type?: AccountType } | null): boolean {
  return getAccountType(session) === "guest";
}

function parseLimit(raw: string | undefined, fallback = 50): number {
  const parsed = Number(raw ?? fallback);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(1, Math.min(200, Math.floor(parsed)));
}

function parseOffset(raw: string | undefined): number {
  const parsed = Number(raw ?? 0);
  if (!Number.isFinite(parsed)) return 0;
  return Math.max(0, Math.floor(parsed));
}

function mapPvpLeaderboard(entries: PvpLeaderboardEntry[]): Array<PvpLeaderboardEntry & { title: string }> {
  return entries.map((entry) => ({
    ...entry,
    title: getEloTitle(entry.elo),
  }));
}

function buildPvpLeaderboardFromMemory(limit: number, offset: number): Array<PvpLeaderboardEntry & { title: string }> {
  const visible = getLeaderboard()
    .map((agent) => {
      const character = characters.get(agent.agent_id);
      if (!character) return null;
      const account = accounts.get(character.account_id);
      if (account?.account_type === "guest") return null;
      const wins = agent.wins;
      const losses = agent.losses;
      const entry: PvpLeaderboardEntry = {
        rank: 0,
        character_id: character.character_id,
        character_name: character.name,
        combat_class: agent.combat_class,
        elo: agent.elo,
        wins,
        losses,
        kd: losses > 0 ? (wins / losses).toFixed(2) : wins.toString(),
      };
      return entry;
    })
    .filter((entry): entry is PvpLeaderboardEntry => !!entry)
    .sort((a, b) => b.elo - a.elo || b.wins - a.wins || a.character_name.localeCompare(b.character_name));

  const page = visible.slice(offset, offset + limit).map((entry, index) => ({
    ...entry,
    rank: offset + index + 1,
    title: getEloTitle(entry.elo),
  }));
  return page;
}

function buildSkillLeaderboardFromMemory(
  skill: SkillName | null,
  metric: "xp" | "level",
  limit: number,
  offset: number
): SkillLeaderboardEntry[] {
  const entries = [...characters.values()]
    .map((character) => {
      const account = accounts.get(character.account_id);
      if (account?.account_type === "guest") return null;
      const progress = getOrCreateProgress(character.character_id);
      if (skill) {
        const state = progress.skills[skill];
        return {
          rank: 0,
          character_id: character.character_id,
          character_name: character.name,
          skill,
          level: state?.level ?? 1,
          xp: state?.xp ?? 0,
        } satisfies SkillLeaderboardEntry;
      }

      const total = Object.values(progress.skills).reduce(
        (acc, state) => {
          acc.total_level += state.level;
          acc.total_xp += state.xp;
          return acc;
        },
        { total_level: 0, total_xp: 0 }
      );
      return {
        rank: 0,
        character_id: character.character_id,
        character_name: character.name,
        skill: "overall",
        level: total.total_level,
        xp: total.total_xp,
        total_level: total.total_level,
        total_xp: total.total_xp,
      } satisfies SkillLeaderboardEntry;
    })
    .filter((entry): entry is SkillLeaderboardEntry => !!entry);

  entries.sort((a, b) => {
    if (metric === "level") {
      return b.level - a.level || b.xp - a.xp || a.character_name.localeCompare(b.character_name);
    }
    return b.xp - a.xp || b.level - a.level || a.character_name.localeCompare(b.character_name);
  });

  return entries.slice(offset, offset + limit).map((entry, index) => ({
    ...entry,
    rank: offset + index + 1,
  }));
}

function buildQuestLeaderboardFromMemory(limit: number, offset: number): QuestLeaderboardEntry[] {
  const entries = [...characters.values()]
    .map((character) => {
      const account = accounts.get(character.account_id);
      if (account?.account_type === "guest") return null;
      const progress = getOrCreateProgress(character.character_id);
      const quests = getQuestLog(character.character_id, progress, worldAgents.get(character.character_id) ?? null);
      const completed = quests.filter((quest) => quest.status === "completed");
      const lastCompletedAt = completed.reduce<number | null>((latest, quest) => {
        if (!quest.completed_at) return latest;
        if (!latest || quest.completed_at > latest) return quest.completed_at;
        return latest;
      }, null);
      const completedCount = completed.length;
      return {
        rank: 0,
        character_id: character.character_id,
        character_name: character.name,
        completed_count: completedCount,
        quest_points: completedCount,
        last_completed_at: lastCompletedAt,
      } satisfies QuestLeaderboardEntry;
    })
    .filter((entry): entry is QuestLeaderboardEntry => !!entry)
    .sort((a, b) =>
      b.completed_count - a.completed_count ||
      (b.last_completed_at ?? 0) - (a.last_completed_at ?? 0) ||
      a.character_name.localeCompare(b.character_name)
    );

  return entries.slice(offset, offset + limit).map((entry, index) => ({
    ...entry,
    rank: offset + index + 1,
  }));
}

async function authenticateWalletIdentity(params: {
  walletAddress: string;
  nonce: string;
  signature: string;
  requestedName: string;
  requestedClass: Character["combat_class"];
  accountType: AccountType;
}): Promise<{
  ok: true;
  session: {
    session_token: string;
    account_id: string;
    character_id: string | null;
    actor_type: AccountType;
    created_at: number;
    expires_at: number;
  };
  account: Account;
  character: Character;
  characters: Character[];
} | { ok: false; status: number; error: string }> {
  const { walletAddress, nonce, signature, requestedName, requestedClass, accountType } = params;

  if (!walletAddress || !nonce || !signature) {
    return { ok: false, status: 400, error: "wallet_address, nonce, signature required" };
  }

  let nonceOk = verifyWalletChallenge(walletAddress, nonce);
  if (!nonceOk) {
    const persisted = await loadWalletNonce(walletAddress);
    nonceOk = !!persisted && persisted.nonce === nonce && persisted.expires_at >= Date.now();
  }
  if (!nonceOk) {
    return { ok: false, status: 401, error: "Invalid or expired nonce" };
  }
  if (!signature.includes(nonce)) {
    return { ok: false, status: 401, error: "Invalid signature payload" };
  }

  const existing = await loadAccountByWallet(walletAddress);
  const account = existing ?? createOrGetAccount(walletAddress, accountType);
  account.account_type = normalizeAccountType(accountType || account.account_type);
  account.updated_at = Date.now();
  accounts.set(account.account_id, account);
  await upsertAccount(account);

  const persistedCharacters = await loadCharactersByAccount(account.account_id);
  for (const character of persistedCharacters) {
    characters.set(character.character_id, character);
    selectedModes.set(character.character_id, character.mode);
  }

  let accountCharacters = getAccountCharacters(account.account_id);
  if (accountCharacters.length === 0) {
    const created = createCharacter(account.account_id, requestedName, requestedClass, BASE_MODE);
    await upsertCharacter(created);
    accountCharacters = [created];
  }

  let selected = accountCharacters.find((character) => character.selected) ?? accountCharacters[0] ?? null;
  if (!selected) {
    return { ok: false, status: 500, error: "Failed to initialize character" };
  }
  selected = selectCharacter(account.account_id, selected.character_id) ?? selected;
  for (const character of getAccountCharacters(account.account_id)) {
    await upsertCharacter(character);
  }
  selectedModes.set(selected.character_id, selected.mode);

  const agent = ensureAgentForCharacter(selected);
  agent.wallet_address = walletAddress;
  agents.set(agent.agent_id, agent);
  await upsertAgent(agent);
  await hydrateProgressFromDb(agent.agent_id);

  if (!banks.has(agent.agent_id)) {
    const persistedBank = await loadBankInventory(agent.agent_id);
    banks.set(agent.agent_id, persistedBank);
  }

  const session = createSession(account.account_id, selected.character_id, account.account_type);
  await upsertSessionRecord(session);
  await deleteWalletNonce(walletAddress);

  return {
    ok: true,
    session,
    account,
    character: selected,
    characters: getAccountCharacters(account.account_id),
  };
}

function assertNonGuestForFeature(
  session: { account_id: string; actor_type?: AccountType } | null,
  feature: string
): { ok: true } | { ok: false; status: number; error: string } {
  if (isGuestSession(session)) {
    return {
      ok: false,
      status: 403,
      error: `${feature} is unavailable for guest sessions`,
    };
  }
  return { ok: true };
}

function isGuestAgent(agentId: string): boolean {
  const character = characters.get(agentId);
  if (!character) return false;
  const account = accounts.get(character.account_id);
  return account?.account_type === "guest";
}

function normalizeTradePayload(value: unknown): Record<string, number> {
  const raw = typeof value === "object" && value ? (value as Record<string, unknown>) : {};
  const normalized: Record<string, number> = {};
  for (const [key, maybeQty] of Object.entries(raw)) {
    const qty = Number(maybeQty);
    if (!key || !Number.isFinite(qty) || qty <= 0) continue;
    normalized[key] = Math.floor(qty);
  }
  return normalized;
}

function applyInventoryDelta(inventory: Record<string, number>, delta: Record<string, number>, direction: "add" | "sub"): boolean {
  for (const [itemId, qty] of Object.entries(delta)) {
    const current = inventory[itemId] ?? 0;
    if (direction === "sub" && current < qty) return false;
  }
  for (const [itemId, qty] of Object.entries(delta)) {
    const current = inventory[itemId] ?? 0;
    inventory[itemId] = direction === "add" ? current + qty : current - qty;
  }
  return true;
}

interface TeleportDestination {
  area_id: string;
  zone: string;
  x: number;
  y: number;
  default_scope?: "shared" | "personal";
}

interface SpellDefinition {
  spell: SpellName;
  magic_level_required: number;
  base_xp: number;
  runes: Record<string, number>;
  teleport?: TeleportDestination;
}

const SPELL_ORDER: SpellName[] = [
  "wind_strike",
  "teleport_runecraft_nexus",
  "teleport_lumbridge",
  "teleport_varrock",
  "teleport_al_kharid",
  "teleport_skills_guild",
  "teleport_emirs_arena",
  "teleport_wilderness",
  "teleport_quest_shard",
  "teleport_shadow_dungeon",
];

const F2P_ALLOWED_SPELLS = new Set<SpellName>([
  "wind_strike",
  "teleport_lumbridge",
  "teleport_varrock",
  "teleport_al_kharid",
  "teleport_runecraft_nexus",
]);

const SPELLBOOK: Record<SpellName, SpellDefinition> = {
  wind_strike: {
    spell: "wind_strike",
    magic_level_required: 1,
    base_xp: 5,
    runes: { air_rune: 1, mind_rune: 1 },
  },
  teleport_runecraft_nexus: {
    spell: "teleport_runecraft_nexus",
    magic_level_required: 18,
    base_xp: 30,
    runes: { air_rune: 2, mind_rune: 2 },
    teleport: {
      area_id: "runecraft_nexus",
      zone: "Nexus Gate",
      x: 420,
      y: 520,
      default_scope: "shared",
    },
  },
  teleport_lumbridge: {
    spell: "teleport_lumbridge",
    magic_level_required: 31,
    base_xp: 41,
    runes: { law_rune: 1, air_rune: 3 },
    teleport: {
      area_id: "surface_main",
      zone: "Lumbridge",
      x: 340,
      y: 520,
      default_scope: "shared",
    },
  },
  teleport_varrock: {
    spell: "teleport_varrock",
    magic_level_required: 25,
    base_xp: 35,
    runes: { law_rune: 1, air_rune: 3, mind_rune: 1 },
    teleport: {
      area_id: "surface_main",
      zone: "Varrock",
      x: 4040,
      y: 520,
      default_scope: "shared",
    },
  },
  teleport_al_kharid: {
    spell: "teleport_al_kharid",
    magic_level_required: 29,
    base_xp: 38,
    runes: { law_rune: 1, mind_rune: 2, air_rune: 2 },
    teleport: {
      area_id: "surface_main",
      zone: "Al Kharid",
      x: 5920,
      y: 520,
      default_scope: "shared",
    },
  },
  teleport_skills_guild: {
    spell: "teleport_skills_guild",
    magic_level_required: 34,
    base_xp: 46,
    runes: { law_rune: 1, air_rune: 3, mind_rune: 1 },
    teleport: {
      area_id: "skills_guild",
      zone: "Guild Courtyard",
      x: 360,
      y: 520,
      default_scope: "shared",
    },
  },
  teleport_emirs_arena: {
    spell: "teleport_emirs_arena",
    magic_level_required: 41,
    base_xp: 54,
    runes: { law_rune: 1, air_rune: 4, mind_rune: 2 },
    teleport: {
      area_id: "emirs_arena",
      zone: "Arena Floor",
      x: 760,
      y: 520,
      default_scope: "personal",
    },
  },
  teleport_wilderness: {
    spell: "teleport_wilderness",
    magic_level_required: 50,
    base_xp: 60,
    runes: { law_rune: 2, air_rune: 5, nature_rune: 1 },
    teleport: {
      area_id: "wilderness_depths",
      zone: "Depths Entry",
      x: 380,
      y: 520,
      default_scope: "shared",
    },
  },
  teleport_quest_shard: {
    spell: "teleport_quest_shard",
    magic_level_required: 52,
    base_xp: 66,
    runes: { law_rune: 2, nature_rune: 1, air_rune: 4 },
    teleport: {
      area_id: "quest_shard",
      zone: "Quest Start",
      x: 280,
      y: 520,
      default_scope: "personal",
    },
  },
  teleport_shadow_dungeon: {
    spell: "teleport_shadow_dungeon",
    magic_level_required: 62,
    base_xp: 74,
    runes: { law_rune: 2, nature_rune: 2, air_rune: 6 },
    teleport: {
      area_id: "shadow_dungeon",
      zone: "Dungeon Gate",
      x: 300,
      y: 520,
      default_scope: "shared",
    },
  },
};

let resourceInitPromise: Promise<void> | null = null;
const fightActionTimeouts = new Map<string, ReturnType<typeof setTimeout>>();

function emitToSockets(sockets: Set<SocketLike>, payload: unknown): void {
  const message = JSON.stringify(payload);
  for (const ws of sockets) {
    try {
      ws.send(message);
    } catch {
      // noop
    }
  }
}

function emitSkillEvent(agentId: string, payload: unknown): void {
  const sockets = skillSubscribers.get(agentId);
  if (!sockets || sockets.size === 0) return;
  emitToSockets(sockets, payload);
}

function emitQuestUpdate(
  agentId: string,
  progress: ReturnType<typeof getOrCreateProgress>,
  updates: ReturnType<typeof evaluateQuestProgress>
): void {
  if (updates.length === 0) return;
  const worldState = worldAgents.get(agentId) ?? null;
  emitSkillEvent(agentId, {
    type: "quest_update",
    updates,
    quests: getQuestLog(agentId, progress, worldState),
  });
}

function emitWorldShard(payload: unknown, areaId: string, instanceId: string | null): void {
  const message = JSON.stringify(payload);
  for (const ws of worldSubscribers) {
    const wsArea = typeof ws.data?.world_area_id === "string" ? ws.data?.world_area_id : "surface_main";
    const wsInstance = typeof ws.data?.world_instance_id === "string" ? ws.data?.world_instance_id : null;
    if (wsArea !== areaId || wsInstance !== instanceId) continue;
    try {
      ws.send(message);
    } catch {
      // noop
    }
  }
}

function broadcastQueueUpdate(): void {
  emitToSockets(duelQueueSubscribers, {
    type: "duel_queue_update",
    queue: getQueueEntries(),
  });
}

function broadcastNodeUpdate(node: ResourceNode): void {
  emitWorldShard({
    type: "resource_node_update",
    node,
  }, node.area_id, node.instance_id ?? null);
}

async function ensureResourceNodesInitialized(): Promise<void> {
  if (resourceInitPromise) {
    await resourceInitPromise;
    if (resourceNodes.size > 0) return;
  }

  resourceInitPromise = (async () => {
    const persisted = await loadResourceNodes();
    const defaults = makeDefaultResourceNodes();
    if (persisted.length > 0) {
      const persistedById = new Map(
        persisted.map((node) => [
          node.node_id,
          {
            ...node,
            area_id: node.area_id ?? "surface_main",
            instance_id: node.instance_id ?? null,
          },
        ])
      );
      const merged = defaults.map((node) => {
        const existing = persistedById.get(node.node_id);
        if (!existing) return node;
        return {
          ...node,
          depleted_until: existing.depleted_until,
        };
      });
      const mergedIds = new Set(merged.map((node) => node.node_id));
      for (const existing of persistedById.values()) {
        if (!mergedIds.has(existing.node_id)) {
          merged.push(existing);
        }
      }
      setResourceNodes(merged);
      await upsertResourceNodes(merged);
      return;
    }

    setResourceNodes(defaults);
    await upsertResourceNodes(defaults);
  })();

  return resourceInitPromise;
}

function stopSkillInteraction(agentId: string): boolean {
  const current = activeSkillJobs.get(agentId);
  if (!current) return false;

  if (current.timeout) {
    clearTimeout(current.timeout);
  }

  activeSkillJobs.delete(agentId);
  emitSkillEvent(agentId, {
    type: "skill_stopped",
    agent_id: agentId,
    node_id: current.node_id,
  });
  return true;
}

function scheduleNodeRespawn(nodeId: string): void {
  const existing = nodeRespawnTimers.get(nodeId);
  if (existing) clearTimeout(existing);

  const node = resourceNodes.get(nodeId);
  if (!node || node.depleted_until === null) return;

  const waitMs = Math.max(0, node.depleted_until - Date.now());
  const timer = setTimeout(async () => {
    nodeRespawnTimers.delete(nodeId);

    const current = resourceNodes.get(nodeId);
    if (!current || current.depleted_until === null || current.depleted_until > Date.now()) {
      return;
    }

    const respawned = markNodeRespawned(current);
    updateResourceNode(respawned);
    await upsertResourceNodes([respawned]);
    broadcastNodeUpdate(respawned);
  }, waitMs);

  nodeRespawnTimers.set(nodeId, timer);
}

async function runSkillTick(agentId: string, nodeId: string): Promise<void> {
  const job = activeSkillJobs.get(agentId);
  if (!job || job.node_id !== nodeId) return;

  const node = resourceNodes.get(nodeId);
  if (!node) {
    stopSkillInteraction(agentId);
    return;
  }

  const worldState = worldAgents.get(agentId);
  if (!worldState) {
    stopSkillInteraction(agentId);
    return;
  }

  const agentAreaId = worldState.area_id ?? "surface_main";
  const agentInstanceId = worldState.instance_id ?? null;
  if (node.area_id !== agentAreaId || (node.instance_id ?? null) !== agentInstanceId) {
    stopSkillInteraction(agentId);
    emitSkillEvent(agentId, {
      type: "skill_error",
      message: "Resource node is not in your current area",
      node_id: nodeId,
    });
    return;
  }

  const dist = distance(worldState.x, worldState.y, node.x, node.y);
  if (dist > INTERACTION_MAX_DISTANCE) {
    stopSkillInteraction(agentId);
    emitSkillEvent(agentId, {
      type: "skill_error",
      message: "Too far from resource node",
      node_id: nodeId,
    });
    return;
  }

  const progress = getOrCreateProgress(agentId);
  const allowed = canGatherNode(progress, node);
  if (!allowed.ok) {
    stopSkillInteraction(agentId);
    emitSkillEvent(agentId, {
      type: "skill_error",
      message: allowed.reason,
      node_id: nodeId,
    });
    return;
  }

  const mode = getModeForAgent(agentId);
  if (!isNodeTrainableInMode(node, mode)) {
    stopSkillInteraction(agentId);
    emitSkillEvent(agentId, {
      type: "skill_error",
      message: `${node.skill} is members-locked in ${mode}`,
      node_id: nodeId,
    });
    return;
  }

  const level = getSkillLevel(progress, node.skill);
  const success = rollGatherSuccess(level, node);

  if (success) {
    const gain = addXp(progress, node.skill, node.xp, { mode });
    if (gain.gained_xp <= 0) {
      stopSkillInteraction(agentId);
      emitSkillEvent(agentId, {
        type: "skill_error",
        message: `${node.skill} is members-locked in ${mode}`,
        node_id: nodeId,
      });
      return;
    }
    const qty = addInventory(progress, node.item_id, 1);
    upsertProgress(progress);

    await saveAgentProgress(progress);
    await appendSkillEvent(agentId, gain, `train:${node.type}`);

    emitSkillEvent(agentId, {
      type: "skill_xp",
      agent_id: agentId,
      source: node.type,
      gain,
    });

    if (gain.new_level > gain.old_level) {
      emitSkillEvent(agentId, {
        type: "skill_level_up",
        agent_id: agentId,
        skill: gain.skill,
        old_level: gain.old_level,
        new_level: gain.new_level,
      });
    }

    emitSkillEvent(agentId, {
      type: "inventory_update",
      agent_id: agentId,
      item_id: node.item_id,
      qty,
      inventory: progress.inventory,
    });

    const questUpdates = evaluateQuestProgress(agentId, progress, worldState);
    emitQuestUpdate(agentId, progress, questUpdates);

    const depletionChance = ({
      fishing: 0.08,
      mining: 0.25,
      runecrafting: 0.12,
      cooking: 0.1,
      agility: 0.06,
      thieving: 0.1,
      smithing: 0.16,
      farming: 0.2,
      slayer: 0.18,
      construction: 0.14,
      prayer: 0.09,
    } as const)[node.skill] ?? 0.22;
    if (Math.random() < depletionChance) {
      const depleted = markNodeDepleted(node);
      updateResourceNode(depleted);
      await upsertResourceNodes([depleted]);
      broadcastNodeUpdate(depleted);
      scheduleNodeRespawn(depleted.node_id);
      stopSkillInteraction(agentId);
      return;
    }
  }

  const latest = activeSkillJobs.get(agentId);
  if (!latest || latest.node_id !== nodeId) return;

  const timer = setTimeout(() => {
    void runSkillTick(agentId, nodeId);
  }, getGatherInterval(node.skill));

  latest.timeout = timer;
  activeSkillJobs.set(agentId, latest);
}

function scheduleQueueFallback(agentId: string, ms: number): void {
  const existing = duelQueueFallbackTimers.get(agentId);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    void maybeStartFallbackBotFight(agentId);
  }, ms);

  duelQueueFallbackTimers.set(agentId, timer);
}

function clearQueueFallback(agentId: string): void {
  const timer = duelQueueFallbackTimers.get(agentId);
  if (timer) {
    clearTimeout(timer);
    duelQueueFallbackTimers.delete(agentId);
  }
}

function buildBotAgent(combatClass: Agent["combat_class"]): Agent {
  const id = `${BOT_QUEUE_PREFIX}_${nanoid(6)}`;
  return {
    agent_id: id,
    skills_md: "",
    wallet_address: "",
    combat_class: combatClass,
    prayer_book: "normal",
    wins: 0,
    losses: 0,
    elo: 1000,
    registered_at: Date.now(),
  };
}

function createFight(p1Agent: Agent, p2Agent: Agent, arena: Arena, wager = 0): Fight {
  return {
    fight_id: nanoid(12),
    arena,
    round: 1,
    tick: 0,
    tick_window_ms: DUEL_TICK_MS,
    next_tick_at: Date.now() + DUEL_TICK_MS,
    status: "in_progress",
    p1: createPlayerState(p1Agent.agent_id, p1Agent.combat_class),
    p2: createPlayerState(p2Agent.agent_id, p2Agent.combat_class),
    last_result: null,
    history: [],
    rounds_won: { p1: 0, p2: 0 },
    wager_amount: wager,
    pending_actions: { p1: null, p2: null },
  };
}

async function announceMatch(fight: Fight): Promise<void> {
  await upsertDuelSummary(
    fight.fight_id,
    fight.arena,
    fight.p1.agent_id,
    fight.p2.agent_id,
    fight.rounds_won.p1,
    fight.rounds_won.p2
  );

  emitToSockets(duelQueueSubscribers, {
    type: "duel_match_found",
    fight_id: fight.fight_id,
    arena: fight.arena,
    p1: fight.p1.agent_id,
    p2: fight.p2.agent_id,
  });
}

async function tryMatchmakeQueue(): Promise<void> {
  let queue = getQueueEntries();

  while (queue.length >= 2) {
    const p1 = queue[0];
    const p2 = queue[1];
    if (!p1 || !p2) break;

    queueLeave(p1.agent_id);
    queueLeave(p2.agent_id);
    clearQueueFallback(p1.agent_id);
    clearQueueFallback(p2.agent_id);

    const p1Agent = agents.get(p1.agent_id);
    const p2Agent = agents.get(p2.agent_id);
    if (!p1Agent || !p2Agent) {
      queue = getQueueEntries();
      continue;
    }

    const fight = createFight(p1Agent, p2Agent, p1.arena, 100);
    fights.set(fight.fight_id, fight);
    await announceMatch(fight);

    queue = getQueueEntries();
  }

  broadcastQueueUpdate();
}

async function maybeStartFallbackBotFight(agentId: string): Promise<void> {
  const queueEntry = duelQueue.get(agentId);
  if (!queueEntry) return;

  const elapsed = Date.now() - queueEntry.joined_at;
  if (elapsed < queueEntry.fallback_bot_after_ms) {
    scheduleQueueFallback(agentId, queueEntry.fallback_bot_after_ms - elapsed);
    return;
  }

  const player = agents.get(agentId);
  if (!player) {
    queueLeave(agentId);
    broadcastQueueUpdate();
    return;
  }

  queueLeave(agentId);
  clearQueueFallback(agentId);

  const classes: Agent["combat_class"][] = ["melee", "ranged", "magic"];
  const botClass = classes[Math.floor(Math.random() * classes.length)] ?? "melee";
  const bot = buildBotAgent(botClass);
  agents.set(bot.agent_id, bot);
  await upsertAgent(bot);

  if (!agentProgress.has(bot.agent_id)) {
    agentProgress.set(bot.agent_id, createDefaultProgress(bot.agent_id));
  }

  const fight = createFight(player, bot, queueEntry.arena, 0);
  fights.set(fight.fight_id, fight);
  await announceMatch(fight);
  broadcastQueueUpdate();
}

function sanitizeFight(fight: Fight) {
  return {
    fight_id: fight.fight_id,
    arena: fight.arena,
    round: fight.round,
    tick: fight.tick,
    tick_window_ms: fight.tick_window_ms,
    next_tick_at: fight.next_tick_at,
    status: fight.status,
    p1: { ...fight.p1 },
    p2: { ...fight.p2 },
    last_result: fight.last_result,
    history: fight.history,
    rounds_won: fight.rounds_won,
    wager_amount: fight.wager_amount,
  };
}

function serializeProfile(agentId: string) {
  const agent = agents.get(agentId);
  if (!agent) return null;

  const progress = getOrCreateProgress(agentId);
  const queueEntry = duelQueue.get(agentId) ?? null;
  const worldState = worldAgents.get(agentId) ?? null;
  const questUpdates = evaluateQuestProgress(agentId, progress, worldState);
  emitQuestUpdate(agentId, progress, questUpdates);

  return {
    agent,
    progress,
    queue: queueEntry,
    world: worldState,
    quests: getQuestLog(agentId, progress, worldState),
  };
}

function clearFightActionTimeout(fightId: string): void {
  const timer = fightActionTimeouts.get(fightId);
  if (!timer) return;
  clearTimeout(timer);
  fightActionTimeouts.delete(fightId);
}

function clearFightTickTimer(fightId: string): void {
  const timer = fightTickTimers.get(fightId);
  if (!timer) return;
  clearTimeout(timer);
  fightTickTimers.delete(fightId);
}

function makeIdleSubmission(fight: Fight, agentId: string): ActionSubmission {
  return {
    agent_id: agentId,
    fight_id: fight.fight_id,
    action: "none",
    prayer: "none",
    food: "none",
    special: "none",
    movement: "none",
  };
}

async function persistAndBroadcastTick(
  fight: Fight,
  result: ReturnType<typeof resolveTick>,
  p1Submission: ActionSubmission,
  p2Submission: ActionSubmission
): Promise<void> {
  const p1Progress = getOrCreateProgress(fight.p1.agent_id);
  const p2Progress = getOrCreateProgress(fight.p2.agent_id);

  const p1CombatGains = applyCombatXp(p1Progress, p1Submission.action, result.p1_damage_dealt);
  const p2CombatGains = applyCombatXp(p2Progress, p2Submission.action, result.p2_damage_dealt);

  upsertProgress(p1Progress);
  upsertProgress(p2Progress);

  await saveAgentProgress(p1Progress);
  await saveAgentProgress(p2Progress);

  for (const gain of p1CombatGains) {
    await appendSkillEvent(fight.p1.agent_id, gain, "combat");
    emitSkillEvent(fight.p1.agent_id, { type: "skill_xp", source: "combat", gain });
    if (gain.new_level > gain.old_level) {
      emitSkillEvent(fight.p1.agent_id, {
        type: "skill_level_up",
        skill: gain.skill,
        old_level: gain.old_level,
        new_level: gain.new_level,
      });
    }
  }

  for (const gain of p2CombatGains) {
    await appendSkillEvent(fight.p2.agent_id, gain, "combat");
    emitSkillEvent(fight.p2.agent_id, { type: "skill_xp", source: "combat", gain });
    if (gain.new_level > gain.old_level) {
      emitSkillEvent(fight.p2.agent_id, {
        type: "skill_level_up",
        skill: gain.skill,
        old_level: gain.old_level,
        new_level: gain.new_level,
      });
    }
  }

  await appendDuelTick(fight.fight_id, fight.round, result.tick, result);

  if (fight.status === "fight_over") {
    clearFightActionTimeout(fight.fight_id);
    clearFightTickTimer(fight.fight_id);
    const winner = fight.rounds_won.p1 >= 2 ? fight.p1.agent_id : fight.p2.agent_id;
    recordDuelWin(winner);
    const winnerProgress = getOrCreateProgress(winner);
    const winnerWorldState = worldAgents.get(winner) ?? null;
    const winnerQuestUpdates = evaluateQuestProgress(winner, winnerProgress, winnerWorldState);
    emitQuestUpdate(winner, winnerProgress, winnerQuestUpdates);
    await upsertDuelSummary(
      fight.fight_id,
      fight.arena,
      fight.p1.agent_id,
      fight.p2.agent_id,
      fight.rounds_won.p1,
      fight.rounds_won.p2,
      winner
    );
  }

  const subs = fightSubscribers.get(fight.fight_id);
  if (subs) {
    emitToSockets(subs, { type: "tick_update", fight_id: fight.fight_id, result, state: sanitizeFight(fight) });
  }
}

async function resolveFightTickWhenDue(fightId: string): Promise<void> {
  clearFightTickTimer(fightId);
  clearFightActionTimeout(fightId);

  const fight = fights.get(fightId);
  if (!fight || fight.status !== "in_progress") return;
  if (!fight.pending_actions.p1 || !fight.pending_actions.p2) return;

  const delay = Math.max(0, fight.next_tick_at - Date.now());
  if (delay > 0) {
    const timer = setTimeout(() => {
      void resolveFightTickWhenDue(fightId);
    }, delay);
    fightTickTimers.set(fightId, timer);
    return;
  }

  const p1Submission = fight.pending_actions.p1;
  const p2Submission = fight.pending_actions.p2;
  if (!p1Submission || !p2Submission) return;

  const result = resolveTick(fight);
  fight.next_tick_at = Date.now() + fight.tick_window_ms;
  await persistAndBroadcastTick(fight, result, p1Submission, p2Submission);
}

function scheduleMissingActionTimeout(fight: Fight): void {
  clearFightActionTimeout(fight.fight_id);

  const timer = setTimeout(() => {
    const current = fights.get(fight.fight_id);
    if (!current || current.status !== "in_progress") return;

    if (!current.pending_actions.p1) {
      current.pending_actions.p1 = makeIdleSubmission(current, current.p1.agent_id);
    }
    if (!current.pending_actions.p2) {
      current.pending_actions.p2 = makeIdleSubmission(current, current.p2.agent_id);
    }
    void resolveFightTickWhenDue(current.fight_id);
  }, ACTION_TIMEOUT_MS);

  fightActionTimeouts.set(fight.fight_id, timer);
}

function hasRequiredRunes(progress: ReturnType<typeof getOrCreateProgress>, spell: SpellDefinition): boolean {
  return Object.entries(spell.runes).every(([itemId, qty]) => getInventoryQty(progress, itemId) >= qty);
}

function consumeRequiredRunes(progress: ReturnType<typeof getOrCreateProgress>, spell: SpellDefinition): boolean {
  if (!hasRequiredRunes(progress, spell)) return false;
  for (const [itemId, qty] of Object.entries(spell.runes)) {
    const ok = consumeInventory(progress, itemId, qty);
    if (!ok) return false;
  }
  return true;
}

function serializeSpellbook(agentId: string) {
  const progress = getOrCreateProgress(agentId);
  const magicLevel = getSkillLevel(progress, "magic");
  const mode = getModeForAgent(agentId);

  return SPELL_ORDER.filter((spellName) => mode !== "f2p_2007" || F2P_ALLOWED_SPELLS.has(spellName)).map((spellName) => {
    const spell = SPELLBOOK[spellName];
    const unlocked = magicLevel >= spell.magic_level_required;
    const runes = Object.entries(spell.runes).map(([item_id, qty]) => ({
      item_id,
      qty_required: qty,
      qty_owned: getInventoryQty(progress, item_id),
    }));

    return {
      spell: spell.spell,
      magic_level_required: spell.magic_level_required,
      unlocked,
      can_cast: unlocked && hasRequiredRunes(progress, spell),
      runes,
      teleport: spell.teleport ?? null,
    };
  });
}

function serializeWorldAtlas() {
  const areas = getWorldAreas();
  const portals = getWorldPortals();
  const nodes = getResourceNodes();
  const coreActivityAreas = ["surface_main", "runecraft_nexus", "wilderness_depths", "shadow_dungeon", "skills_guild", "quest_shard"];

  const skills = [...new Set(nodes.map((node) => node.skill))].sort();
  const area_summaries = areas.map((area) => {
    const areaNodes = nodes.filter((node) => node.area_id === area.area_id);
    const skill_counts = areaNodes.reduce<Record<string, number>>((acc, node) => {
      acc[node.skill] = (acc[node.skill] ?? 0) + 1;
      return acc;
    }, {});
    return {
      area_id: area.area_id,
      environment: area.environment,
      shared: area.shared,
      node_count: areaNodes.length,
      skill_counts,
      portals_from: portals.filter((portal) => portal.from_area_id === area.area_id).length,
      portals_to: portals.filter((portal) => portal.to_area_id === area.area_id).length,
      scene_type: area.scene_type ?? "side_scroller",
      core_budget_ok: coreActivityAreas.every((targetAreaId) => isTravelWithinBudget(area.area_id, targetAreaId)),
    };
  });

  return {
    generated_at: Date.now(),
    total_nodes: nodes.length,
    total_portals: portals.length,
    skills,
    areas,
    portals,
    area_summaries,
  };
}

// ── Register ──
api.post("/arena/register/self", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const character = characters.get(session.character_id);
  if (!character) return c.json({ error: "Character not found" }, 404);
  const account = accounts.get(session.account_id);
  if (!account) return c.json({ error: "Account not found" }, 404);

  const combatClass =
    body.combat_class === "melee" || body.combat_class === "ranged" || body.combat_class === "magic"
      ? body.combat_class
      : character.combat_class;
  const avatarId =
    typeof body.avatar_id === "string" && body.avatar_id.trim().length > 0
      ? body.avatar_id.trim()
      : undefined;
  const prayerBook = body.prayer_book === "ancient_curses" ? "ancient_curses" : "normal";

  character.combat_class = combatClass;
  character.updated_at = Date.now();
  characters.set(character.character_id, character);
  await upsertCharacter(character);

  const agent = ensureAgentForCharacter(character);
  agent.combat_class = combatClass;
  agent.prayer_book = prayerBook;
  agent.wallet_address = account.wallet_address;
  agents.set(agent.agent_id, agent);
  await upsertAgent(agent);
  await hydrateProgressFromDb(agent.agent_id);

  if (!banks.has(agent.agent_id)) {
    const persistedBank = await loadBankInventory(agent.agent_id);
    banks.set(agent.agent_id, persistedBank);
  }

  return c.json({
    status: "registered",
    agent: {
      ...agent,
      avatar_id: avatarId,
    },
    character,
    account_type: account.account_type,
  });
});

api.post("/arena/register", async (c) => {
  if (!LEGACY_ARENA_REGISTER_ENABLED) {
    return c.json({ error: "Legacy register endpoint disabled" }, 403);
  }
  const body = await c.req.json();
  const { agent_id, skills_md, wallet_address, combat_class, prayer_book } = body;

  if (!agent_id || !combat_class) {
    return c.json({ error: "agent_id and combat_class required" }, 400);
  }

  if (!["melee", "ranged", "magic"].includes(combat_class)) {
    return c.json({ error: "combat_class must be melee, ranged, or magic" }, 400);
  }

  const existing = agents.get(agent_id);
  const agent: Agent = {
    agent_id,
    skills_md: skills_md || existing?.skills_md || "",
    wallet_address: wallet_address || existing?.wallet_address || "",
    combat_class,
    prayer_book: prayer_book || existing?.prayer_book || "normal",
    wins: existing?.wins ?? 0,
    losses: existing?.losses ?? 0,
    elo: existing?.elo ?? 1000,
    registered_at: existing?.registered_at ?? Date.now(),
  };

  agents.set(agent_id, agent);
  await upsertAgent(agent);

  const persistedProgress = await loadAgentProgress(agent_id);
  if (persistedProgress) {
    upsertProgress({
      ...createDefaultProgress(agent_id),
      ...persistedProgress,
      skills: {
        ...createDefaultProgress(agent_id).skills,
        ...persistedProgress.skills,
      },
    });
  } else {
    upsertProgress(getOrCreateProgress(agent_id));
    await saveAgentProgress(getOrCreateProgress(agent_id));
  }

  return c.json({ status: "registered", agent });
});

// ── List Agents ──
api.get("/arena/agents", (c) => {
  const list = [...agents.values()].map((a) => ({
    agent_id: a.agent_id,
    combat_class: a.combat_class,
    wins: a.wins,
    losses: a.losses,
    elo: a.elo,
    title: getEloTitle(a.elo),
    skills_md: a.skills_md,
  }));
  return c.json(list);
});

// ── Queue ──
api.post("/arena/queue/join", async (c) => {
  const body = await c.req.json();
  const { agent_id, arena, fallback_bot_after_ms } = body;

  const agent = agents.get(agent_id);
  if (!agent) return c.json({ error: "Agent not registered" }, 400);
  if (isGuestAgent(agent_id)) {
    return c.json({ error: "Ranked duel queue is unavailable for guest sessions" }, 403);
  }

  const entry: DuelQueueEntry = {
    agent_id,
    arena: (arena as Arena) || "duel_arena",
    combat_class: agent.combat_class,
    joined_at: Date.now(),
    fallback_bot_after_ms:
      typeof fallback_bot_after_ms === "number" && fallback_bot_after_ms >= 4_000
        ? fallback_bot_after_ms
        : BOT_FALLBACK_AFTER_MS,
  };

  queueJoin(entry);
  scheduleQueueFallback(agent_id, entry.fallback_bot_after_ms);
  await tryMatchmakeQueue();

  return c.json({ status: "queued", entry, queue_size: duelQueue.size });
});

api.post("/arena/queue/leave", async (c) => {
  const body = await c.req.json();
  const { agent_id } = body;

  const removed = queueLeave(agent_id);
  clearQueueFallback(agent_id);
  broadcastQueueUpdate();

  return c.json({ status: removed ? "left" : "not_queued" });
});

api.get("/arena/queue", (c) => {
  return c.json({ queue: getQueueEntries(), queue_size: duelQueue.size });
});

// ── Challenge ──
api.post("/arena/challenge", async (c) => {
  const body = await c.req.json();
  const { agent_id, target_agent_id, wager_amount, arena, rules } = body;

  if (!agents.has(agent_id)) return c.json({ error: "Challenger not registered" }, 400);
  if (!agents.has(target_agent_id)) return c.json({ error: "Target not registered" }, 400);
  if (agent_id === target_agent_id) return c.json({ error: "Can't challenge yourself" }, 400);
  if (isGuestAgent(agent_id) || isGuestAgent(target_agent_id)) {
    return c.json({ error: "Ranked challenges are unavailable for guest sessions" }, 403);
  }

  const challenge: Challenge = {
    challenge_id: nanoid(12),
    challenger_id: agent_id,
    target_id: target_agent_id,
    wager_amount: wager_amount || 0,
    arena: (arena as Arena) || "duel_arena",
    rules: rules || DEFAULT_DUEL_RULES,
    status: "pending",
    created_at: Date.now(),
  };

  challenges.set(challenge.challenge_id, challenge);
  return c.json({ status: "challenged", challenge });
});

// ── Accept Challenge ──
api.post("/arena/accept", async (c) => {
  const body = await c.req.json();
  const { agent_id, challenge_id } = body;

  const challenge = challenges.get(challenge_id);
  if (!challenge) return c.json({ error: "Challenge not found" }, 404);
  if (challenge.target_id !== agent_id) return c.json({ error: "Not your challenge to accept" }, 403);
  if (challenge.status !== "pending") return c.json({ error: "Challenge already resolved" }, 400);

  challenge.status = "accepted";

  const p1Agent = agents.get(challenge.challenger_id);
  const p2Agent = agents.get(challenge.target_id);
  if (!p1Agent || !p2Agent) {
    return c.json({ error: "One or more agents are not registered anymore" }, 400);
  }
  if (isGuestAgent(challenge.challenger_id) || isGuestAgent(challenge.target_id)) {
    return c.json({ error: "Ranked duels are unavailable for guest sessions" }, 403);
  }

  const fight = createFight(p1Agent, p2Agent, challenge.arena as Arena, challenge.wager_amount);
  fights.set(fight.fight_id, fight);
  await announceMatch(fight);

  return c.json({
    status: "fight_started",
    fight_id: fight.fight_id,
    p1: fight.p1.agent_id,
    p2: fight.p2.agent_id,
    arena: fight.arena,
  });
});

// ── Submit Action ──
api.post("/arena/action", async (c) => {
  const body: ActionSubmission = await c.req.json();
  const { agent_id, fight_id, action, prayer, food, special, movement } = body;

  const fight = fights.get(fight_id);
  if (!fight) return c.json({ error: "Fight not found" }, 404);
  if (fight.status !== "in_progress") return c.json({ error: `Fight status: ${fight.status}` }, 400);

  const isP1 = fight.p1.agent_id === agent_id;
  const isP2 = fight.p2.agent_id === agent_id;
  if (!isP1 && !isP2) return c.json({ error: "You're not in this fight" }, 403);

  const submission: ActionSubmission = {
    agent_id,
    fight_id,
    action: action || "none",
    prayer: prayer || "none",
    food: food || "none",
    special: special || "none",
    movement: movement || "none",
  };

  if (isP1) fight.pending_actions.p1 = submission;
  else fight.pending_actions.p2 = submission;

  if (fight.pending_actions.p1 && fight.pending_actions.p2) {
    clearFightActionTimeout(fight.fight_id);

    const resolveInMs = Math.max(0, fight.next_tick_at - Date.now());
    if (resolveInMs <= 0) {
      await resolveFightTickWhenDue(fight.fight_id);
      if (fight.last_result) {
        return c.json({ status: "tick_resolved", result: fight.last_result, fight: sanitizeFight(fight) });
      }
      return c.json({ status: "tick_scheduled", resolve_in_ms: fight.tick_window_ms, fight: sanitizeFight(fight) });
    }

    if (!fightTickTimers.has(fight.fight_id)) {
      const timer = setTimeout(() => {
        void resolveFightTickWhenDue(fight.fight_id);
      }, resolveInMs);
      fightTickTimers.set(fight.fight_id, timer);
    }

    return c.json({ status: "tick_scheduled", resolve_in_ms: resolveInMs, fight: sanitizeFight(fight) });
  }

  scheduleMissingActionTimeout(fight);
  return c.json({ status: "action_submitted", waiting_for: isP1 ? "p2" : "p1" });
});

// ── Next Round ──
api.post("/arena/next-round", async (c) => {
  const { fight_id } = await c.req.json();
  const fight = fights.get(fight_id);
  if (!fight) return c.json({ error: "Fight not found" }, 404);
  clearFightActionTimeout(fight_id);
  clearFightTickTimer(fight_id);
  if (fight.status === "fight_over") {
    const winnerId = fight.rounds_won.p1 >= 2 ? fight.p1.agent_id : fight.p2.agent_id;
    const loserId = winnerId === fight.p1.agent_id ? fight.p2.agent_id : fight.p1.agent_id;
    const winner = agents.get(winnerId);
    const loser = agents.get(loserId);
    if (winner && loser) {
      updateElo(winner, loser);
      await upsertAgent(winner);
      await upsertAgent(loser);
    }

    await upsertDuelSummary(
      fight.fight_id,
      fight.arena,
      fight.p1.agent_id,
      fight.p2.agent_id,
      fight.rounds_won.p1,
      fight.rounds_won.p2,
      winnerId
    );

    return c.json({ status: "fight_over", winner: winnerId, rounds_won: fight.rounds_won });
  }
  if (fight.status !== "round_over") return c.json({ error: "Round not over yet" }, 400);

  fight.round++;
  fight.tick = 0;
  fight.next_tick_at = Date.now() + fight.tick_window_ms;
  fight.status = "in_progress";
  fight.p1 = createPlayerState(fight.p1.agent_id, fight.p1.combat_class);
  fight.p2 = createPlayerState(fight.p2.agent_id, fight.p2.combat_class);
  fight.history = [];
  fight.last_result = null;
  fight.pending_actions = { p1: null, p2: null };

  return c.json({ status: "round_started", round: fight.round, fight: sanitizeFight(fight) });
});

// ── Get Fight State ──
api.get("/arena/fight/:fight_id", (c) => {
  const fight = fights.get(c.req.param("fight_id"));
  if (!fight) return c.json({ error: "Fight not found" }, 404);
  return c.json(sanitizeFight(fight));
});

// ── Leaderboard ──
api.get("/leaderboards/pvp", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 50);
  const offset = parseOffset(c.req.query("offset"));
  const dbEntries = await queryPvpLeaderboard(limit, offset);
  const rows = dbEntries.length > 0 ? mapPvpLeaderboard(dbEntries) : buildPvpLeaderboardFromMemory(limit, offset);
  return c.json(rows);
});

api.get("/leaderboards/skills", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 50);
  const offset = parseOffset(c.req.query("offset"));
  const metric = c.req.query("metric") === "level" ? "level" : "xp";
  const skillRaw = c.req.query("skill");
  const skill = typeof skillRaw === "string" && skillRaw.length > 0 ? (skillRaw as SkillName) : null;

  const dbRows = await querySkillLeaderboard({ skill: skill ?? undefined, metric, limit, offset });
  const rows = dbRows.length > 0 ? dbRows : buildSkillLeaderboardFromMemory(skill, metric, limit, offset);
  return c.json(rows);
});

api.get("/leaderboards/quests", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 50);
  const offset = parseOffset(c.req.query("offset"));
  const dbRows = await queryQuestLeaderboard(limit, offset);
  const memoryRows = buildQuestLeaderboardFromMemory(limit, offset);
  const dbMaxCompleted = dbRows.reduce((max, row) => Math.max(max, row.completed_count), 0);
  const memoryMaxCompleted = memoryRows.reduce((max, row) => Math.max(max, row.completed_count), 0);
  const shouldUseMemory = dbRows.length === 0 || memoryMaxCompleted > dbMaxCompleted;
  const rows = shouldUseMemory ? memoryRows : dbRows;
  return c.json(rows);
});

api.get("/arena/leaderboard", async (c) => {
  const limit = parseLimit(c.req.query("limit"), 50);
  const offset = parseOffset(c.req.query("offset"));
  const dbEntries = await queryPvpLeaderboard(limit, offset);
  const rows = dbEntries.length > 0 ? mapPvpLeaderboard(dbEntries) : buildPvpLeaderboardFromMemory(limit, offset);
  return c.json(
    rows.map((entry) => ({
      rank: entry.rank,
      agent_id: entry.character_id,
      character_name: entry.character_name,
      combat_class: entry.combat_class,
      elo: entry.elo,
      title: entry.title,
      wins: entry.wins,
      losses: entry.losses,
      kd: entry.kd,
    }))
  );
});

// ── Pending Challenges ──
api.get("/arena/challenges/:agent_id", (c) => {
  const id = c.req.param("agent_id");
  const pending = [...challenges.values()].filter(
    (ch) => (ch.target_id === id || ch.challenger_id === id) && ch.status === "pending"
  );
  return c.json(pending);
});

// ── Wallet Auth / Sessions ──
api.post("/auth/wallet/challenge", async (c) => {
  const body = await c.req.json();
  const walletAddress = typeof body.wallet_address === "string" ? body.wallet_address.trim().toLowerCase() : "";
  if (!walletAddress || !walletAddress.startsWith("0x")) {
    return c.json({ error: "wallet_address required" }, 400);
  }

  const challenge = createWalletChallenge(walletAddress);
  await saveWalletNonce(walletAddress, challenge.nonce, challenge.expires_at);

  return c.json({
    wallet_address: walletAddress,
    nonce: challenge.nonce,
    expires_at: challenge.expires_at,
    message: `Sign this nonce to authenticate: ${challenge.nonce}`,
  });
});

api.post("/auth/agent/challenge", async (c) => {
  const body = await c.req.json();
  const walletAddress = typeof body.wallet_address === "string" ? body.wallet_address.trim().toLowerCase() : "";
  if (!walletAddress || !walletAddress.startsWith("0x")) {
    return c.json({ error: "wallet_address required" }, 400);
  }
  const challenge = createWalletChallenge(walletAddress);
  await saveWalletNonce(walletAddress, challenge.nonce, challenge.expires_at);
  return c.json({
    wallet_address: walletAddress,
    nonce: challenge.nonce,
    expires_at: challenge.expires_at,
    message: `Sign this nonce to authenticate agent identity: ${challenge.nonce}`,
  });
});

api.post("/auth/wallet/verify", async (c) => {
  const body = await c.req.json();
  const walletAddress = typeof body.wallet_address === "string" ? body.wallet_address.trim().toLowerCase() : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const requestedName = typeof body.character_name === "string" && body.character_name.trim().length > 0
    ? body.character_name.trim()
    : `Adventurer_${walletAddress.slice(2, 8)}`;
  const requestedClass = body.combat_class === "ranged" || body.combat_class === "magic" ? body.combat_class : "melee";

  if (!walletAddress || !nonce || !signature) {
    return c.json({ error: "wallet_address, nonce, signature required" }, 400);
  }

  const result = await authenticateWalletIdentity({
    walletAddress,
    nonce,
    signature,
    requestedName,
    requestedClass,
    accountType: "human",
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);

  return c.json({
    status: "authenticated",
    session_token: result.session.session_token,
    account: result.account,
    character: result.character,
    characters: result.characters,
    mode: result.character.mode,
    active_f2p_skills: F2P_SKILL_ORDER,
  });
});

api.post("/auth/agent/verify", async (c) => {
  const body = await c.req.json();
  const walletAddress = typeof body.wallet_address === "string" ? body.wallet_address.trim().toLowerCase() : "";
  const nonce = typeof body.nonce === "string" ? body.nonce : "";
  const signature = typeof body.signature === "string" ? body.signature : "";
  const requestedName = typeof body.character_name === "string" && body.character_name.trim().length > 0
    ? body.character_name.trim()
    : `Agent_${walletAddress.slice(2, 8)}`;
  const requestedClass = body.combat_class === "ranged" || body.combat_class === "magic" ? body.combat_class : "melee";
  const result = await authenticateWalletIdentity({
    walletAddress,
    nonce,
    signature,
    requestedName,
    requestedClass,
    accountType: "agent",
  });
  if (!result.ok) return c.json({ error: result.error }, result.status);
  return c.json({
    status: "authenticated",
    session_token: result.session.session_token,
    account: result.account,
    character: result.character,
    characters: result.characters,
    mode: result.character.mode,
    active_f2p_skills: F2P_SKILL_ORDER,
  });
});

api.post("/auth/guest/start", async (c) => {
  if (!DEV_GUEST_AUTH_ENABLED) {
    return c.json({ error: "Guest mode disabled" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const requestedClass = body.combat_class === "ranged" || body.combat_class === "magic" ? body.combat_class : "melee";
  const now = Date.now();
  const walletAddress = `guest_${now}_${nanoid(6)}`;
  const account = createOrGetAccount(walletAddress, "guest");
  account.display_name = typeof body.display_name === "string" && body.display_name.trim().length > 0
    ? body.display_name.trim()
    : `guest_${account.account_id.slice(0, 8)}`;
  account.account_type = "guest";
  account.updated_at = now;
  accounts.set(account.account_id, account);
  await upsertAccount(account);

  const characterName =
    typeof body.character_name === "string" && body.character_name.trim().length > 0
      ? body.character_name.trim()
      : `Guest_${account.account_id.slice(0, 6)}`;
  const character = createCharacter(account.account_id, characterName, requestedClass, BASE_MODE);
  await upsertCharacter(character);
  const session = createSession(account.account_id, character.character_id, "guest");
  await upsertSessionRecord(session);

  const agent = ensureAgentForCharacter(character);
  agent.wallet_address = walletAddress;
  agents.set(agent.agent_id, agent);
  await upsertAgent(agent);
  await hydrateProgressFromDb(agent.agent_id);

  return c.json({
    status: "authenticated",
    session_token: session.session_token,
    account,
    character,
    characters: getAccountCharacters(account.account_id),
    mode: character.mode,
    active_f2p_skills: F2P_SKILL_ORDER,
  });
});

api.post("/auth/logout", async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const fallbackToken = typeof body.session_token === "string" ? body.session_token : null;
  const sessionToken = parseSessionToken(c) ?? fallbackToken;
  if (!sessionToken) return c.json({ error: "session_token required" }, 400);

  destroySession(sessionToken);
  await deleteSessionRecord(sessionToken);
  return c.json({ status: "logged_out" });
});

api.put("/agents/profile", async (c) => {
  const session = await resolveSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const account = accounts.get(session.account_id);
  if (!account) return c.json({ error: "Account not found" }, 404);
  if (account.account_type !== "agent") {
    return c.json({ error: "Agent profile can only be updated by agent accounts" }, 403);
  }

  const body = await c.req.json().catch(() => ({}));
  const runtimeLabel = typeof body.runtime_label === "string" ? body.runtime_label.trim() : "";
  const endpointUrl = typeof body.endpoint_url === "string" ? body.endpoint_url.trim() : "";
  const skillsMd = typeof body.skills_md === "string" ? body.skills_md : "";
  const notes = typeof body.notes === "string" ? body.notes : "";

  if (!runtimeLabel || runtimeLabel.length > 120) {
    return c.json({ error: "runtime_label is required (1-120 chars)" }, 400);
  }
  if (endpointUrl && !/^https?:\/\//i.test(endpointUrl)) {
    return c.json({ error: "endpoint_url must start with http:// or https://" }, 400);
  }

  const profile: AgentProfile = {
    account_id: account.account_id,
    runtime_label: runtimeLabel,
    endpoint_url: endpointUrl || null,
    skills_md: skillsMd || null,
    notes: notes || null,
    updated_at: Date.now(),
  };

  agentProfiles.set(account.account_id, profile);
  await upsertAgentProfile(profile);

  return c.json({ status: "agent_profile_updated", profile });
});

api.get("/agents/profile/me", async (c) => {
  const session = await resolveSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const account = accounts.get(session.account_id);
  if (!account) return c.json({ error: "Account not found" }, 404);

  let profile = agentProfiles.get(account.account_id) ?? null;
  if (!profile) {
    profile = await loadAgentProfile(account.account_id);
    if (profile) {
      agentProfiles.set(account.account_id, profile);
    }
  }

  return c.json({
    account_id: account.account_id,
    account_type: account.account_type,
    profile,
  });
});

// ── Character + Mode APIs ──
api.get("/character/me", async (c) => {
  const session = await resolveSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const account = accounts.get(session.account_id);
  if (!account) return c.json({ error: "Account not found" }, 404);

  const characterList = getAccountCharacters(account.account_id);
  return c.json({
    account,
    actor_type: getAccountType(session),
    characters: characterList,
    selected_character: characterList.find((character) => character.selected) ?? null,
  });
});

api.post("/character/select", async (c) => {
  const session = await resolveSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const characterId = typeof body.character_id === "string" ? body.character_id : "";
  if (!characterId) return c.json({ error: "character_id required" }, 400);

  const selected = selectCharacter(session.account_id, characterId);
  if (!selected) return c.json({ error: "Character not found" }, 404);

  const updatedSession = createSession(session.account_id, selected.character_id, getAccountType(session));
  sessions.delete(session.session_token);
  await deleteSessionRecord(session.session_token);
  await upsertSessionRecord(updatedSession);
  for (const character of getAccountCharacters(session.account_id)) {
    await upsertCharacter(character);
  }
  selectedModes.set(selected.character_id, selected.mode);

  ensureAgentForCharacter(selected);
  await hydrateProgressFromDb(selected.character_id);

  return c.json({
    status: "character_selected",
    session_token: updatedSession.session_token,
    actor_type: updatedSession.actor_type,
    character: selected,
  });
});

api.post("/character/create", async (c) => {
  const session = await resolveSession(c);
  if (!session) return c.json({ error: "Unauthorized" }, 401);

  const body = await c.req.json().catch(() => ({}));
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const combatClass = body.combat_class === "ranged" || body.combat_class === "magic" ? body.combat_class : "melee";
  const mode = body.mode as GameMode | undefined;
  const select = body.select === true;

  if (!name || name.length < 2 || name.length > 20 || !/^[A-Za-z0-9_ ]+$/.test(name)) {
    return c.json({ error: "name must be 2-20 chars using letters, numbers, spaces, or underscore" }, 400);
  }

  const existing = getAccountCharacters(session.account_id);
  if (existing.length >= CHARACTER_SLOT_LIMIT) {
    return c.json({ error: `Character slot limit reached (${CHARACTER_SLOT_LIMIT})` }, 400);
  }
  if (existing.some((character) => character.name.toLowerCase() === name.toLowerCase())) {
    return c.json({ error: "Character name already exists on this account" }, 400);
  }

  const normalizedMode = mode && mode in MODES_AVAILABLE ? mode : BASE_MODE;
  if (!MODES_AVAILABLE[normalizedMode].enabled) {
    return c.json({ error: MODES_AVAILABLE[normalizedMode].note }, 400);
  }

  const created = createCharacter(session.account_id, name, combatClass, normalizedMode);
  await upsertCharacter(created);
  selectedModes.set(created.character_id, created.mode);
  ensureAgentForCharacter(created);
  await hydrateProgressFromDb(created.character_id);

  let sessionToken: string | undefined;
  if (select) {
    const selected = selectCharacter(session.account_id, created.character_id) ?? created;
    for (const character of getAccountCharacters(session.account_id)) {
      await upsertCharacter(character);
    }
    const rotated = createSession(session.account_id, selected.character_id, getAccountType(session));
    sessions.delete(session.session_token);
    await deleteSessionRecord(session.session_token);
    await upsertSessionRecord(rotated);
    sessionToken = rotated.session_token;
  }

  return c.json({
    status: "character_created",
    character: select ? (selectCharacter(session.account_id, created.character_id) ?? created) : created,
    characters: getAccountCharacters(session.account_id),
    ...(sessionToken ? { session_token: sessionToken } : {}),
  });
});

api.get("/character/state", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);

  await hydrateProgressFromDb(session.character_id);
  const progress = ensureProgressForAgent(session.character_id);
  const world = worldAgents.get(session.character_id) ?? null;
  const bank = getCharacterBank(session.character_id);

  return c.json({
    character_id: session.character_id,
    mode: getModeForAgent(session.character_id),
    progress,
    bank,
    world,
    quests: getQuestLog(session.character_id, progress, world),
  });
});

api.get("/modes", (c) => {
  return c.json({
    current_base_mode: BASE_MODE,
    modes: MODES_AVAILABLE,
  });
});

api.post("/modes/select", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const mode = body.mode as GameMode;
  if (!mode || !(mode in MODES_AVAILABLE)) return c.json({ error: "Invalid mode" }, 400);

  const availability = MODES_AVAILABLE[mode];
  if (!availability.enabled) {
    return c.json({ error: availability.note, mode }, 400);
  }

  const character = characters.get(session.character_id);
  if (!character) return c.json({ error: "Character not found" }, 404);
  character.mode = mode;
  character.updated_at = Date.now();
  characters.set(character.character_id, character);
  selectedModes.set(character.character_id, mode);
  await upsertCharacter(character);

  return c.json({ status: "mode_selected", character_id: character.character_id, mode });
});

// ── World Movement API ──
api.post("/world/move", async (c) => {
  const body = await c.req.json();
  const auth = await resolveSession(c);
  const agentId = auth?.character_id ?? (typeof body.agent_id === "string" ? body.agent_id : "");
  const x = Number(body.x);
  const y = Number(body.y);
  const zone = typeof body.zone === "string" ? body.zone : "Unknown";
  const areaId = typeof body.area_id === "string" ? body.area_id : "surface_main";
  const instanceId = typeof body.instance_id === "string" ? body.instance_id : null;
  const avatarId = typeof body.avatar_id === "string" && body.avatar_id.length > 0 ? body.avatar_id : undefined;
  if (!agentId || !Number.isFinite(x) || !Number.isFinite(y)) {
    return c.json({ error: "agent_id, x, y required" }, 400);
  }

  const agent = agents.get(agentId);
  if (!agent) return c.json({ error: "Agent not registered" }, 400);

  const moved = upsertWorldAgent({
    agent_id: agentId,
    combat_class: agent.combat_class,
    x,
    y,
    zone,
    avatar_id: avatarId,
    area_id: areaId,
    instance_id: instanceId,
  });

  emitWorldShard({ type: "world_update", agent: moved }, moved.area_id ?? "surface_main", moved.instance_id ?? null);
  return c.json({ status: "moved", world: moved });
});

// ── Economy: Bank ──
api.post("/economy/bank/deposit", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  const qty = Math.max(1, Math.floor(Number(body.qty ?? 1)));
  if (!itemId) return c.json({ error: "item_id required" }, 400);

  const progress = ensureProgressForAgent(session.character_id);
  if (!consumeInventory(progress, itemId, qty)) {
    return c.json({ error: "Insufficient inventory" }, 400);
  }
  const bank = getCharacterBank(session.character_id);
  bank[itemId] = (bank[itemId] ?? 0) + qty;

  await saveAgentProgress(progress);
  await saveBankInventory(session.character_id, bank);
  return c.json({ status: "deposited", inventory: progress.inventory, bank });
});

api.post("/economy/bank/withdraw", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  const qty = Math.max(1, Math.floor(Number(body.qty ?? 1)));
  if (!itemId) return c.json({ error: "item_id required" }, 400);

  const bank = getCharacterBank(session.character_id);
  if ((bank[itemId] ?? 0) < qty) return c.json({ error: "Insufficient bank quantity" }, 400);
  bank[itemId] -= qty;

  const progress = ensureProgressForAgent(session.character_id);
  addInventory(progress, itemId, qty);
  await saveAgentProgress(progress);
  await saveBankInventory(session.character_id, bank);
  return c.json({ status: "withdrawn", inventory: progress.inventory, bank });
});

// ── Economy: Direct Player Trades ──
api.post("/economy/trade/request", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const guestCheck = assertNonGuestForFeature(session, "Trading");
  if (!guestCheck.ok) return c.json({ error: guestCheck.error }, guestCheck.status);
  const body = await c.req.json();
  const toCharacterId = typeof body.to_character_id === "string" ? body.to_character_id : "";
  const offered = normalizeTradePayload(body.offered_items);
  const requested = normalizeTradePayload(body.requested_items);
  if (!toCharacterId) return c.json({ error: "to_character_id required" }, 400);
  if (toCharacterId === session.character_id) return c.json({ error: "Cannot trade with yourself" }, 400);

  const fromProgress = ensureProgressForAgent(session.character_id);
  if (!applyInventoryDelta({ ...fromProgress.inventory }, offered, "sub")) {
    return c.json({ error: "Insufficient offered items" }, 400);
  }

  const offer: TradeOffer = {
    trade_id: nanoid(12),
    from_character_id: session.character_id,
    to_character_id: toCharacterId,
    offered_items: offered,
    requested_items: requested,
    status: "pending",
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  tradeOffers.set(offer.trade_id, offer);
  await upsertTradeOffer(offer);
  return c.json({ status: "trade_pending", trade: offer });
});

api.post("/economy/trade/respond", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const guestCheck = assertNonGuestForFeature(session, "Trading");
  if (!guestCheck.ok) return c.json({ error: guestCheck.error }, guestCheck.status);
  const body = await c.req.json();
  const tradeId = typeof body.trade_id === "string" ? body.trade_id : "";
  const decision = body.decision === "accept" ? "accept" : "decline";
  const trade = tradeOffers.get(tradeId);
  if (!trade) return c.json({ error: "Trade not found" }, 404);
  if (trade.to_character_id !== session.character_id) return c.json({ error: "Forbidden" }, 403);
  if (trade.status !== "pending") return c.json({ error: `Trade is ${trade.status}` }, 400);

  trade.status = decision === "accept" ? "accepted" : "declined";
  trade.updated_at = Date.now();
  tradeOffers.set(trade.trade_id, trade);
  await upsertTradeOffer(trade);
  return c.json({ status: trade.status, trade });
});

api.post("/economy/trade/confirm", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const guestCheck = assertNonGuestForFeature(session, "Trading");
  if (!guestCheck.ok) return c.json({ error: guestCheck.error }, guestCheck.status);
  const body = await c.req.json();
  const tradeId = typeof body.trade_id === "string" ? body.trade_id : "";
  const trade = tradeOffers.get(tradeId);
  if (!trade) return c.json({ error: "Trade not found" }, 404);
  if (trade.status !== "accepted") return c.json({ error: "Trade is not accepted yet" }, 400);
  if (trade.from_character_id !== session.character_id && trade.to_character_id !== session.character_id) {
    return c.json({ error: "Forbidden" }, 403);
  }

  const fromProgress = ensureProgressForAgent(trade.from_character_id);
  const toProgress = ensureProgressForAgent(trade.to_character_id);

  const fromCheck = applyInventoryDelta({ ...fromProgress.inventory }, trade.offered_items, "sub");
  const toCheck = applyInventoryDelta({ ...toProgress.inventory }, trade.requested_items, "sub");
  if (!fromCheck || !toCheck) {
    return c.json({ error: "Trade inventory validation failed" }, 400);
  }

  applyInventoryDelta(fromProgress.inventory, trade.offered_items, "sub");
  applyInventoryDelta(toProgress.inventory, trade.requested_items, "sub");
  applyInventoryDelta(fromProgress.inventory, trade.requested_items, "add");
  applyInventoryDelta(toProgress.inventory, trade.offered_items, "add");

  await saveAgentProgress(fromProgress);
  await saveAgentProgress(toProgress);

  trade.status = "completed";
  trade.updated_at = Date.now();
  tradeOffers.set(trade.trade_id, trade);
  await upsertTradeOffer(trade);

  return c.json({
    status: "trade_completed",
    trade,
    from_inventory: fromProgress.inventory,
    to_inventory: toProgress.inventory,
  });
});

api.get("/economy/trade/pending", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const characterId = session.character_id;
  const relevant = [...tradeOffers.values()]
    .filter((offer) =>
      offer.from_character_id === characterId || offer.to_character_id === characterId
    )
    .sort((a, b) => b.updated_at - a.updated_at);

  return c.json({
    incoming: relevant.filter((offer) => offer.to_character_id === characterId),
    outgoing: relevant.filter((offer) => offer.from_character_id === characterId),
  });
});

// ── Economy: Grand Exchange-Style Orders ──
api.post("/economy/ge/order", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const guestCheck = assertNonGuestForFeature(session, "Grand Exchange");
  if (!guestCheck.ok) return c.json({ error: guestCheck.error }, guestCheck.status);
  const body = await c.req.json();
  const itemId = typeof body.item_id === "string" ? body.item_id : "";
  const qty = Math.max(1, Math.floor(Number(body.qty ?? 0)));
  const priceEach = Math.max(1, Math.floor(Number(body.price_each ?? 0)));
  const side = body.side === "buy" ? "buy" : body.side === "sell" ? "sell" : null;
  if (!itemId || !side || qty <= 0 || priceEach <= 0) {
    return c.json({ error: "item_id, side, qty, price_each required" }, 400);
  }

  const progress = ensureProgressForAgent(session.character_id);
  if (side === "sell") {
    if (!consumeInventory(progress, itemId, qty)) {
      return c.json({ error: "Insufficient item quantity to list sell order" }, 400);
    }
  } else {
    const reserve = qty * priceEach;
    if (!consumeInventory(progress, "coins", reserve)) {
      return c.json({ error: "Insufficient coins to list buy order" }, 400);
    }
  }
  await saveAgentProgress(progress);

  const order: MarketOrder = {
    order_id: nanoid(12),
    character_id: session.character_id,
    item_id: itemId,
    qty,
    price_each: priceEach,
    side,
    status: "open",
    filled_qty: 0,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  marketOrders.set(order.order_id, order);
  await upsertMarketOrder(order);

  const opposite = [...marketOrders.values()]
    .filter((candidate) => candidate.item_id === itemId && candidate.side !== side && candidate.status === "open")
    .sort((a, b) => a.price_each - b.price_each || a.created_at - b.created_at);

  let remaining = order.qty - order.filled_qty;
  for (const candidate of opposite) {
    if (remaining <= 0) break;
    const candidateRemaining = candidate.qty - candidate.filled_qty;
    if (candidateRemaining <= 0) continue;
    const priceCrossed = side === "buy"
      ? order.price_each >= candidate.price_each
      : candidate.price_each >= order.price_each;
    if (!priceCrossed) continue;

    const fillQty = Math.min(remaining, candidateRemaining);
    const tradePrice = candidate.price_each;
    const buyer = side === "buy" ? order : candidate;
    const seller = side === "sell" ? order : candidate;
    const buyerProgress = ensureProgressForAgent(buyer.character_id);
    const sellerProgress = ensureProgressForAgent(seller.character_id);
    const total = fillQty * tradePrice;

    addInventory(buyerProgress, itemId, fillQty);
    addInventory(sellerProgress, "coins", total);
    await saveAgentProgress(buyerProgress);
    await saveAgentProgress(sellerProgress);

    order.filled_qty += fillQty;
    candidate.filled_qty += fillQty;
    order.status = order.filled_qty >= order.qty ? "filled" : "partially_filled";
    candidate.status = candidate.filled_qty >= candidate.qty ? "filled" : "partially_filled";
    order.updated_at = Date.now();
    candidate.updated_at = Date.now();
    marketOrders.set(order.order_id, order);
    marketOrders.set(candidate.order_id, candidate);
    await upsertMarketOrder(order);
    await upsertMarketOrder(candidate);

    remaining = order.qty - order.filled_qty;
  }

  return c.json({ status: "order_created", order });
});

api.delete("/economy/ge/order/:order_id", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const guestCheck = assertNonGuestForFeature(session, "Grand Exchange");
  if (!guestCheck.ok) return c.json({ error: guestCheck.error }, guestCheck.status);
  const orderId = c.req.param("order_id");
  const order = marketOrders.get(orderId);
  if (!order) return c.json({ error: "Order not found" }, 404);
  if (order.character_id !== session.character_id) return c.json({ error: "Forbidden" }, 403);
  if (order.status === "filled" || order.status === "cancelled") {
    return c.json({ error: `Order already ${order.status}` }, 400);
  }

  const remaining = order.qty - order.filled_qty;
  const progress = ensureProgressForAgent(order.character_id);
  if (remaining > 0) {
    if (order.side === "sell") {
      addInventory(progress, order.item_id, remaining);
    } else {
      addInventory(progress, "coins", remaining * order.price_each);
    }
    await saveAgentProgress(progress);
  }

  order.status = "cancelled";
  order.updated_at = Date.now();
  marketOrders.set(order.order_id, order);
  await upsertMarketOrder(order);
  await deleteMarketOrder(orderId);
  return c.json({ status: "order_cancelled", order });
});

api.get("/economy/ge/book/:item_id", async (c) => {
  const itemId = c.req.param("item_id");
  const inMemory = [...marketOrders.values()].filter(
    (order) => order.item_id === itemId && (order.status === "open" || order.status === "partially_filled")
  );
  const persisted = await listOpenMarketOrders(itemId);
  const merged = [...inMemory, ...persisted].reduce<Record<string, MarketOrder>>((acc, order) => {
    acc[order.order_id] = order;
    return acc;
  }, {});

  const orders = Object.values(merged);
  const buys = orders.filter((order) => order.side === "buy").sort((a, b) => b.price_each - a.price_each);
  const sells = orders.filter((order) => order.side === "sell").sort((a, b) => a.price_each - b.price_each);
  return c.json({ item_id: itemId, buys, sells });
});

api.get("/economy/ge/my", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const orders = [...marketOrders.values()]
    .filter((order) => order.character_id === session.character_id)
    .sort((a, b) => b.updated_at - a.updated_at);
  return c.json({ orders });
});

// ── Canonical Quests API ──
api.get("/quests", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const progress = ensureProgressForAgent(session.character_id);
  const worldState = worldAgents.get(session.character_id) ?? null;
  const updates = evaluateQuestProgress(session.character_id, progress, worldState);
  return c.json({
    quests: getQuestLog(session.character_id, progress, worldState),
    updates,
  });
});

api.post("/quests/start", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const questId = typeof body.quest_id === "string" ? body.quest_id : "";
  if (!questId) return c.json({ error: "quest_id required" }, 400);
  const progress = ensureProgressForAgent(session.character_id);
  const updates = startQuest(session.character_id, questId);
  return c.json({
    status: updates.length > 0 ? "started" : "unchanged",
    updates,
    quests: getQuestLog(session.character_id, progress, worldAgents.get(session.character_id) ?? null),
  });
});

api.post("/quests/advance", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const progress = ensureProgressForAgent(session.character_id);
  const worldState = worldAgents.get(session.character_id) ?? null;
  const updates = evaluateQuestProgress(session.character_id, progress, worldState);
  return c.json({
    updates,
    quests: getQuestLog(session.character_id, progress, worldState),
  });
});

api.post("/quests/claim", async (c) => {
  const session = await resolveSession(c);
  if (!session || !session.character_id) return c.json({ error: "Unauthorized" }, 401);
  const body = await c.req.json();
  const questId = typeof body.quest_id === "string" ? body.quest_id : "";
  if (!questId) return c.json({ error: "quest_id required" }, 400);

  const progress = ensureProgressForAgent(session.character_id);
  const reward = claimQuestReward(session.character_id, questId, progress);
  if (!reward) return c.json({ error: "Quest reward not claimable" }, 400);

  await saveAgentProgress(progress);
  return c.json({
    status: "claimed",
    reward,
    skills: progress.skills,
    inventory: progress.inventory,
    quests: getQuestLog(session.character_id, progress, worldAgents.get(session.character_id) ?? null),
  });
});

// ── World Areas / Portals ──
api.get("/world/areas", (c) => {
  return c.json(getWorldAreas());
});

api.get("/world/portals", (c) => {
  const areaId = c.req.query("area_id");
  if (areaId) {
    return c.json(listPortalsForArea(areaId));
  }
  return c.json(getWorldPortals());
});

api.get("/world/atlas", async (c) => {
  await ensureResourceNodesInitialized();
  return c.json(serializeWorldAtlas());
});

// ── Portal -> Queue ──
api.post("/world/portal/use", async (c) => {
  const body: PortalTravelRequest & { arena?: Arena; fallback_bot_after_ms?: number } = await c.req.json();
  const auth = await resolveSession(c);
  const agent_id = auth?.character_id ?? body.agent_id;
  const { portal_id, scope, arena, fallback_bot_after_ms } = body;

  if (!agent_id || typeof agent_id !== "string") {
    return c.json({ error: "agent_id required" }, 400);
  }

  const agent = agents.get(agent_id);
  if (!agent) return c.json({ error: "Agent not registered" }, 400);

  if (portal_id) {
    const portal = getPortalById(portal_id);
    if (!portal) {
      return c.json({ error: "Portal not found" }, 404);
    }

    const currentWorld = worldAgents.get(agent_id);
    const currentArea = currentWorld?.area_id ?? "surface_main";
    if (currentArea !== portal.from_area_id) {
      return c.json({ error: `Portal is not in your current area (${currentArea})` }, 400);
    }

    if (currentWorld) {
      const d = distance(currentWorld.x, currentWorld.y, portal.from_x, portal.from_y);
      if (d > INTERACTION_MAX_DISTANCE + 30) {
        return c.json({ error: "Move closer to the portal before using it" }, 400);
      }
    }

    if (portal.kind === "duel_queue") {
      if (isGuestAgent(agent_id)) {
        return c.json({ error: "Ranked duel queue is unavailable for guest sessions" }, 403);
      }
      const entry: DuelQueueEntry = {
        agent_id,
        arena: arena || "duel_arena",
        combat_class: agent.combat_class,
        joined_at: Date.now(),
        fallback_bot_after_ms:
          typeof fallback_bot_after_ms === "number" && fallback_bot_after_ms >= 4_000
            ? fallback_bot_after_ms
            : BOT_FALLBACK_AFTER_MS,
      };

      queueJoin(entry);
      scheduleQueueFallback(agent_id, entry.fallback_bot_after_ms);
      await tryMatchmakeQueue();
      return c.json({
        status: "portal_queued",
        portal,
        entry,
        queue_size: duelQueue.size,
      });
    }

    if (!isTravelWithinBudget(currentArea, portal.to_area_id)) {
      return c.json({
        error: `Travel budget exceeded for ${currentArea} -> ${portal.to_area_id}`,
        travel_budget: "max_2_hops",
      }, 400);
    }

    const area = getWorldAreaById(portal.to_area_id);
    const resolvedScope = area && !area.shared ? "personal" : (scope ?? portal.default_scope);
    const instanceId = resolvedScope === "personal" ? `${agent_id}:${portal.to_area_id}` : null;
    stopSkillInteraction(agent_id);
    const previousWorld = worldAgents.get(agent_id);
    const nextWorld = upsertWorldAgent({
      agent_id,
      combat_class: agent.combat_class,
      x: portal.to_x,
      y: portal.to_y,
      zone: portal.to_zone,
      area_id: portal.to_area_id,
      instance_id: instanceId,
    });
    if (previousWorld) {
      const prevArea = previousWorld.area_id ?? "surface_main";
      const prevInstance = previousWorld.instance_id ?? null;
      const nextArea = nextWorld.area_id ?? "surface_main";
      const nextInstance = nextWorld.instance_id ?? null;
      if (prevArea !== nextArea || prevInstance !== nextInstance) {
        emitWorldShard({ type: "world_leave", agent_id }, prevArea, prevInstance);
      }
    }
    emitWorldShard({ type: "world_update", agent: nextWorld }, nextWorld.area_id ?? "surface_main", nextWorld.instance_id ?? null);

    recordAreaVisit(agent_id, nextWorld.area_id ?? "surface_main");
    const progress = getOrCreateProgress(agent_id);
    const questUpdates = evaluateQuestProgress(agent_id, progress, nextWorld);
    emitQuestUpdate(agent_id, progress, questUpdates);

    return c.json({
      status: "teleported",
      portal,
      area,
      world: nextWorld,
      scope: resolvedScope,
    });
  }

  if (isGuestAgent(agent_id)) {
    return c.json({ error: "Ranked duel queue is unavailable for guest sessions" }, 403);
  }

  const entry: DuelQueueEntry = {
    agent_id,
    arena: (arena as Arena) || "duel_arena",
    combat_class: agent.combat_class,
    joined_at: Date.now(),
    fallback_bot_after_ms:
      typeof fallback_bot_after_ms === "number" && fallback_bot_after_ms >= 4_000
        ? fallback_bot_after_ms
        : BOT_FALLBACK_AFTER_MS,
  };

  queueJoin(entry);
  scheduleQueueFallback(agent_id, entry.fallback_bot_after_ms);
  await tryMatchmakeQueue();

  return c.json({ status: "portal_queued", entry, queue_size: duelQueue.size });
});

// ── Open World Nodes ──
api.get("/world/nodes", async (c) => {
  await ensureResourceNodesInitialized();
  const areaId = c.req.query("area_id");
  const instanceId = c.req.query("instance_id") ?? null;
  const agentId = c.req.query("agent_id");
  const mode = agentId ? getModeForAgent(agentId) : BASE_MODE;
  let nodes = getResourceNodes();
  if (areaId) {
    nodes = nodes.filter((node) => node.area_id === areaId && (node.instance_id ?? null) === instanceId);
  }
  nodes = nodes.filter((node) => isNodeTrainableInMode(node, mode));
  return c.json(nodes);
});

// ── Open World Interactions ──
api.post("/world/interact", async (c) => {
  await ensureResourceNodesInitialized();
  const body: WorldInteractRequest = await c.req.json();
  const auth = await resolveSession(c);
  const agent_id = auth?.character_id ?? body.agent_id;
  const { node_id, action } = body;

  if (!agent_id || !node_id || !action) {
    return c.json({ error: "agent_id, node_id, action required" }, 400);
  }

  if (!agents.has(agent_id)) {
    return c.json({ error: "Agent not registered" }, 400);
  }

  if (action === "stop") {
    const stopped = stopSkillInteraction(agent_id);
    return c.json({ status: stopped ? "stopped" : "idle" });
  }

  const node = resourceNodes.get(node_id);
  if (!node) {
    return c.json({ error: "Node not found" }, 404);
  }

  const progress = getOrCreateProgress(agent_id);
  const worldState = worldAgents.get(agent_id);
  if (!worldState) {
    return c.json({ error: "Agent world position unknown. Send world_update first." }, 400);
  }

  const agentAreaId = worldState.area_id ?? "surface_main";
  const agentInstanceId = worldState.instance_id ?? null;
  if (node.area_id !== agentAreaId || (node.instance_id ?? null) !== agentInstanceId) {
    return c.json({ error: "Node not reachable in current area" }, 400);
  }

  const dist = distance(worldState.x, worldState.y, node.x, node.y);
  if (dist > INTERACTION_MAX_DISTANCE) {
    return c.json({ error: "Too far from node" }, 400);
  }

  const allowed = canGatherNode(progress, node);
  if (!allowed.ok) {
    return c.json({ error: allowed.reason }, 400);
  }

  const mode = getModeForAgent(agent_id);
  if (!isNodeTrainableInMode(node, mode)) {
    return c.json({ error: `${node.skill} is members-locked in ${mode}` }, 400);
  }

  stopSkillInteraction(agent_id);

  activeSkillJobs.set(agent_id, {
    agent_id,
    node_id,
    started_at: Date.now(),
    timeout: null,
  });

  emitSkillEvent(agent_id, {
    type: "skill_started",
    agent_id,
    node_id,
    skill: node.skill,
  });

  const timer = setTimeout(() => {
    void runSkillTick(agent_id, node_id);
  }, getGatherInterval(node.skill));

  const current = activeSkillJobs.get(agent_id);
  if (current) {
    current.timeout = timer;
    activeSkillJobs.set(agent_id, current);
  }

  return c.json({ status: "started", node });
});

// ── Quests ──
api.get("/world/quests/:agent_id", (c) => {
  const agentId = c.req.param("agent_id");
  if (!agents.has(agentId)) {
    return c.json({ error: "Agent not registered" }, 404);
  }
  const progress = getOrCreateProgress(agentId);
  const worldState = worldAgents.get(agentId) ?? null;
  const questUpdates = evaluateQuestProgress(agentId, progress, worldState);
  emitQuestUpdate(agentId, progress, questUpdates);
  return c.json({
    quests: getQuestLog(agentId, progress, worldState),
    updates: questUpdates,
  });
});

// ── Dialogue Trees ──
api.post("/world/dialogue/start", async (c) => {
  const body = await c.req.json();
  const { agent_id, npc_id } = body;

  if (!agent_id || !npc_id) {
    return c.json({ error: "agent_id and npc_id required" }, 400);
  }
  if (!agents.has(agent_id)) {
    return c.json({ error: "Agent not registered" }, 400);
  }

  const progress = getOrCreateProgress(agent_id);
  const worldState = worldAgents.get(agent_id) ?? null;
  const questUpdates = evaluateQuestProgress(agent_id, progress, worldState);
  const node = startDialogue(agent_id, npc_id);
  if (!node) {
    return c.json({ error: "Dialogue not found for npc" }, 404);
  }

  emitQuestUpdate(agent_id, progress, questUpdates);

  return c.json({
    node,
    quests: getQuestLog(agent_id, progress, worldState),
    updates: questUpdates,
  });
});

api.post("/world/dialogue/choose", async (c) => {
  const body = await c.req.json();
  const { agent_id, npc_id, node_id, choice_id } = body;

  if (!agent_id || !npc_id || !node_id || !choice_id) {
    return c.json({ error: "agent_id, npc_id, node_id, choice_id required" }, 400);
  }
  if (!agents.has(agent_id)) {
    return c.json({ error: "Agent not registered" }, 400);
  }

  const progress = getOrCreateProgress(agent_id);
  const worldState = worldAgents.get(agent_id) ?? null;
  const result = chooseDialogue(agent_id, npc_id, node_id, choice_id, progress, worldState);
  if (!result) {
    return c.json({ error: "Invalid dialogue node or choice" }, 400);
  }

  if (result.reward) {
    upsertProgress(progress);
    await saveAgentProgress(progress);

    for (const gain of result.reward.xp_gains) {
      await appendSkillEvent(agent_id, gain, `quest:${result.reward.quest_id}`);
      emitSkillEvent(agent_id, { type: "skill_xp", source: `quest:${result.reward.quest_id}`, gain });
      if (gain.new_level > gain.old_level) {
        emitSkillEvent(agent_id, {
          type: "skill_level_up",
          skill: gain.skill,
          old_level: gain.old_level,
          new_level: gain.new_level,
        });
      }
    }

    for (const item_id of Object.keys(result.reward.item_rewards)) {
      emitSkillEvent(agent_id, {
        type: "inventory_update",
        agent_id,
        item_id,
        qty: getInventoryQty(progress, item_id),
        inventory: progress.inventory,
      });
    }
  }

  emitQuestUpdate(agent_id, progress, result.quest_updates);

  return c.json({
    closed: result.closed,
    node: result.node,
    reward: result.reward,
    updates: result.quest_updates,
    quests: getQuestLog(agent_id, progress, worldState),
    skills: progress.skills,
    inventory: progress.inventory,
  });
});

// ── Spellbook ──
api.get("/world/spellbook/:agent_id", (c) => {
  const agentId = c.req.param("agent_id");
  if (!agents.has(agentId)) {
    return c.json({ error: "Agent not registered" }, 404);
  }
  const progress = getOrCreateProgress(agentId);
  return c.json({
    magic_level: getSkillLevel(progress, "magic"),
    runecrafting_level: getSkillLevel(progress, "runecrafting"),
    spells: serializeSpellbook(agentId),
  });
});

api.post("/world/spell/cast", async (c) => {
  const body: CastSpellRequest = await c.req.json();
  const { agent_id, spell } = body;

  if (!agent_id || !spell) {
    return c.json({ error: "agent_id and spell required" }, 400);
  }
  if (!agents.has(agent_id)) {
    return c.json({ error: "Agent not registered" }, 400);
  }

  const definition = SPELLBOOK[spell];
  if (!definition) {
    return c.json({ error: "Unknown spell" }, 400);
  }
  const mode = getModeForAgent(agent_id);
  if (mode === "f2p_2007" && !F2P_ALLOWED_SPELLS.has(spell)) {
    return c.json({ error: `${spell} is not available in f2p_2007 mode` }, 400);
  }

  const progress = getOrCreateProgress(agent_id);
  const magicLevel = getSkillLevel(progress, "magic");
  if (magicLevel < definition.magic_level_required) {
    return c.json({
      error: `Magic level ${definition.magic_level_required} required`,
      spell,
      magic_level: magicLevel,
    }, 400);
  }

  if (!consumeRequiredRunes(progress, definition)) {
    return c.json({ error: "Insufficient runes", spell, runes: definition.runes }, 400);
  }

  const magicGain = addXp(progress, "magic", definition.base_xp, { mode });
  recordSpellCast(agent_id, spell);
  upsertProgress(progress);
  await saveAgentProgress(progress);
  await appendSkillEvent(agent_id, magicGain, `spell:${spell}`);

  emitSkillEvent(agent_id, { type: "skill_xp", source: "spellcasting", gain: magicGain });
  if (magicGain.new_level > magicGain.old_level) {
    emitSkillEvent(agent_id, {
      type: "skill_level_up",
      skill: magicGain.skill,
      old_level: magicGain.old_level,
      new_level: magicGain.new_level,
    });
  }

  for (const [item_id] of Object.entries(definition.runes)) {
    emitSkillEvent(agent_id, {
      type: "inventory_update",
      agent_id,
      item_id,
      qty: getInventoryQty(progress, item_id),
      inventory: progress.inventory,
    });
  }

  if (definition.teleport) {
    const caster = agents.get(agent_id);
    if (!caster) return c.json({ error: "Agent not registered" }, 400);

    const targetArea = getWorldAreaById(definition.teleport.area_id);
    const scope =
      targetArea && !targetArea.shared
        ? "personal"
        : (definition.teleport.default_scope ?? "shared");
    const instanceId = scope === "personal" ? `${agent_id}:${definition.teleport.area_id}` : null;
    stopSkillInteraction(agent_id);
    const previousWorld = worldAgents.get(agent_id);
    const worldState = upsertWorldAgent({
      agent_id,
      combat_class: caster.combat_class,
      x: definition.teleport.x,
      y: definition.teleport.y,
      zone: definition.teleport.zone,
      area_id: definition.teleport.area_id,
      instance_id: instanceId,
    });
    if (previousWorld) {
      const prevArea = previousWorld.area_id ?? "surface_main";
      const prevInstance = previousWorld.instance_id ?? null;
      const nextArea = worldState.area_id ?? "surface_main";
      const nextInstance = worldState.instance_id ?? null;
      if (prevArea !== nextArea || prevInstance !== nextInstance) {
        emitWorldShard({ type: "world_leave", agent_id }, prevArea, prevInstance);
      }
    }

    emitWorldShard({ type: "world_update", agent: worldState }, worldState.area_id ?? "surface_main", worldState.instance_id ?? null);
    recordAreaVisit(agent_id, worldState.area_id ?? "surface_main");
    const questUpdates = evaluateQuestProgress(agent_id, progress, worldState);
    emitQuestUpdate(agent_id, progress, questUpdates);
    return c.json({
      status: "teleported",
      spell,
      gain: magicGain,
      world: worldState,
      scope,
      quest_updates: questUpdates,
      inventory: progress.inventory,
    });
  }

  const questUpdates = evaluateQuestProgress(agent_id, progress, worldAgents.get(agent_id) ?? null);
  emitQuestUpdate(agent_id, progress, questUpdates);

  return c.json({
    status: "cast",
    spell,
    gain: magicGain,
    quest_updates: questUpdates,
    inventory: progress.inventory,
  });
});

// ── Open World Active Agents ──
api.get("/world/agents", (c) => {
  const areaId = c.req.query("area_id");
  if (!areaId) {
    return c.json(getActiveWorldAgents());
  }
  const instanceId = c.req.query("instance_id") ?? null;
  return c.json(getVisibleWorldAgents(areaId, instanceId));
});

// ── Profile ──
api.get("/profile/:agent_id", (c) => {
  const id = c.req.param("agent_id");
  const profile = serializeProfile(id);
  if (!profile) return c.json({ error: "Agent not found" }, 404);
  return c.json(profile);
});

// ── Agent Info Endpoint ──
api.get("/agent-info", (c) => {
  return c.json({
    name: "RuneScape Agent Arena",
    version: "1.3.0",
    api_base: "/api/v1",
    ws_endpoint: "/ws/arena",
    skills_md_url: "/api/v1/skills.md",
  });
});

// ── Skills.md ──
api.get("/skills.md", async (c) => {
  try {
    const file = Bun.file("../SKILLS.md");
    const text = await file.text();
    return c.text(text);
  } catch {
    return c.text("# Skills doc not found", 404);
  }
});

// Initialize resources in background.
void ensureResourceNodesInitialized();

export default api;
