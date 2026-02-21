import type {
  Account,
  AccountType,
  Agent,
  AgentProfile,
  AgentProgress,
  Character,
  Challenge,
  DialogueState,
  DuelQueueEntry,
  Fight,
  GameMode,
  MarketOrder,
  QuestState,
  ResourceNode,
  TradeOffer,
  WorldAgent,
} from "./types";
import { createDefaultProgress } from "./progression";

export interface SocketLike {
  send: (message: string) => void;
  data?: Record<string, unknown>;
}

export interface WalletChallengeState {
  wallet_address: string;
  nonce: string;
  expires_at: number;
}

export interface SessionState {
  session_token: string;
  account_id: string;
  character_id: string | null;
  actor_type: AccountType;
  created_at: number;
  expires_at: number;
}

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 7;
const CHALLENGE_TTL_MS = 1000 * 60 * 5;

// Identity / persistence-oriented store
export const accounts = new Map<string, Account>(); // account_id -> account
export const accountByWallet = new Map<string, string>(); // wallet -> account_id
export const walletChallenges = new Map<string, WalletChallengeState>(); // wallet -> nonce
export const sessions = new Map<string, SessionState>(); // token -> session
export const characters = new Map<string, Character>(); // character_id -> character
export const banks = new Map<string, Record<string, number>>(); // character_id -> bank inventory
export const questStates = new Map<string, Record<string, QuestState>>(); // character_id -> quest state cache
export const dialogueStates = new Map<string, DialogueState>(); // character_id -> dialogue state
export const tradeOffers = new Map<string, TradeOffer>(); // trade_id -> offer
export const marketOrders = new Map<string, MarketOrder>(); // order_id -> order
export const selectedModes = new Map<string, GameMode>(); // character_id -> mode
export const agentProfiles = new Map<string, AgentProfile>(); // account_id -> profile

// In-memory store
export const agents = new Map<string, Agent>();
export const challenges = new Map<string, Challenge>();
export const fights = new Map<string, Fight>();
export const fightTickTimers = new Map<string, ReturnType<typeof setTimeout>>();

// WebSocket subscribers per fight
export const fightSubscribers = new Map<string, Set<SocketLike>>(); // fight_id -> Set<ws>
export const duelQueueSubscribers = new Set<SocketLike>(); // Set<ws>
export const skillSubscribers = new Map<string, Set<SocketLike>>(); // agent_id -> Set<ws>

// Open world presence
export const worldAgents = new Map<string, WorldAgent>(); // agent_id -> latest state
export const worldSubscribers = new Set<SocketLike>(); // Set<ws>

// Open world progression, queue, and resources
export const agentProgress = new Map<string, AgentProgress>();
export const duelQueue = new Map<string, DuelQueueEntry>(); // agent_id -> queue entry
export const duelQueueFallbackTimers = new Map<string, ReturnType<typeof setTimeout>>(); // agent_id -> timer
export const resourceNodes = new Map<string, ResourceNode>(); // node_id -> node state

export interface ActiveSkillJob {
  agent_id: string;
  node_id: string;
  started_at: number;
  timeout: ReturnType<typeof setTimeout> | null;
}

export const activeSkillJobs = new Map<string, ActiveSkillJob>(); // agent_id -> active job
export const nodeRespawnTimers = new Map<string, ReturnType<typeof setTimeout>>(); // node_id -> timer

const WORLD_AGENT_TTL_MS = 15_000;

export function getCharacterBank(characterId: string): Record<string, number> {
  const current = banks.get(characterId);
  if (current) return current;
  const created: Record<string, number> = {};
  banks.set(characterId, created);
  return created;
}

export function createOrGetAccount(walletAddress: string, accountType: AccountType = "human"): Account {
  const normalized = walletAddress.trim().toLowerCase();
  const existingAccountId = accountByWallet.get(normalized);
  if (existingAccountId) {
    const existing = accounts.get(existingAccountId);
    if (existing) {
      if (existing.account_type !== accountType && existing.account_type === "human") {
        existing.account_type = accountType;
        existing.updated_at = Date.now();
        accounts.set(existing.account_id, existing);
      }
      return existing;
    }
  }

  const created: Account = {
    account_id: crypto.randomUUID(),
    wallet_address: normalized,
    display_name: `player_${normalized.slice(2, 8) || "anon"}`,
    account_type: accountType,
    created_at: Date.now(),
    updated_at: Date.now(),
  };
  accounts.set(created.account_id, created);
  accountByWallet.set(normalized, created.account_id);
  return created;
}

export function createWalletChallenge(walletAddress: string): WalletChallengeState {
  const normalized = walletAddress.trim().toLowerCase();
  const nonce = crypto.randomUUID();
  const challenge: WalletChallengeState = {
    wallet_address: normalized,
    nonce,
    expires_at: Date.now() + CHALLENGE_TTL_MS,
  };
  walletChallenges.set(normalized, challenge);
  return challenge;
}

export function verifyWalletChallenge(walletAddress: string, nonce: string): boolean {
  const normalized = walletAddress.trim().toLowerCase();
  const challenge = walletChallenges.get(normalized);
  if (!challenge) return false;
  if (challenge.expires_at < Date.now()) {
    walletChallenges.delete(normalized);
    return false;
  }
  const ok = challenge.nonce === nonce;
  if (ok) {
    walletChallenges.delete(normalized);
  }
  return ok;
}

export function createCharacter(accountId: string, name: string, combatClass: Character["combat_class"], mode: GameMode = "f2p_2007"): Character {
  const now = Date.now();
  const existing = [...characters.values()].find((candidate) => candidate.account_id === accountId && candidate.name === name);
  if (existing) return existing;
  const alreadySelected = [...characters.values()].some((candidate) => candidate.account_id === accountId && candidate.selected);
  const created: Character = {
    character_id: crypto.randomUUID(),
    account_id: accountId,
    name,
    mode,
    combat_class: combatClass,
    selected: !alreadySelected,
    created_at: now,
    updated_at: now,
  };
  characters.set(created.character_id, created);
  selectedModes.set(created.character_id, mode);
  return created;
}

export function getAccountCharacters(accountId: string): Character[] {
  return [...characters.values()].filter((candidate) => candidate.account_id === accountId);
}

export function getSelectedCharacter(accountId: string): Character | null {
  return getAccountCharacters(accountId).find((candidate) => candidate.selected) ?? null;
}

export function selectCharacter(accountId: string, characterId: string): Character | null {
  const target = characters.get(characterId);
  if (!target || target.account_id !== accountId) return null;
  for (const character of getAccountCharacters(accountId)) {
    character.selected = character.character_id === characterId;
    character.updated_at = Date.now();
    characters.set(character.character_id, character);
  }
  return characters.get(characterId) ?? null;
}

export function createSession(
  accountId: string,
  characterId: string | null,
  actorType: AccountType = "human"
): SessionState {
  const now = Date.now();
  const session: SessionState = {
    session_token: crypto.randomUUID(),
    account_id: accountId,
    character_id: characterId,
    actor_type: actorType,
    created_at: now,
    expires_at: now + SESSION_TTL_MS,
  };
  sessions.set(session.session_token, session);
  return session;
}

export function getSession(sessionToken: string): SessionState | null {
  const session = sessions.get(sessionToken);
  if (!session) return null;
  if (session.expires_at < Date.now()) {
    sessions.delete(sessionToken);
    return null;
  }
  return session;
}

export function destroySession(sessionToken: string): boolean {
  return sessions.delete(sessionToken);
}

export function upsertWorldAgent(agent: Omit<WorldAgent, "updated_at">): WorldAgent {
  const existing = worldAgents.get(agent.agent_id);
  const next: WorldAgent = {
    ...existing,
    ...agent,
    area_id: agent.area_id ?? existing?.area_id ?? "surface_main",
    instance_id: agent.instance_id ?? existing?.instance_id ?? null,
    updated_at: Date.now(),
  };
  worldAgents.set(agent.agent_id, next);
  return next;
}

export function removeWorldAgent(agentId: string): boolean {
  return worldAgents.delete(agentId);
}

export function getActiveWorldAgents(): WorldAgent[] {
  const now = Date.now();
  for (const [agentId, state] of worldAgents) {
    if (now - state.updated_at > WORLD_AGENT_TTL_MS) {
      worldAgents.delete(agentId);
    }
  }
  return [...worldAgents.values()];
}

export function getVisibleWorldAgents(
  areaId: string,
  instanceId: string | null,
  excludeAgentId?: string
): WorldAgent[] {
  return getActiveWorldAgents().filter((agent) => {
    if (excludeAgentId && agent.agent_id === excludeAgentId) return false;
    if ((agent.area_id ?? "surface_main") !== areaId) return false;
    return (agent.instance_id ?? null) === instanceId;
  });
}

export function getOrCreateProgress(agentId: string): AgentProgress {
  const existing = agentProgress.get(agentId);
  if (existing) return existing;
  const created = createDefaultProgress(agentId);
  agentProgress.set(agentId, created);
  return created;
}

export function upsertProgress(progress: AgentProgress): AgentProgress {
  progress.updated_at = Date.now();
  agentProgress.set(progress.agent_id, progress);
  return progress;
}

export function getQueueEntries(): DuelQueueEntry[] {
  return [...duelQueue.values()].sort((a, b) => a.joined_at - b.joined_at);
}

export function queueJoin(entry: DuelQueueEntry): DuelQueueEntry {
  duelQueue.set(entry.agent_id, entry);
  return entry;
}

export function queueLeave(agentId: string): boolean {
  return duelQueue.delete(agentId);
}

export function setResourceNodes(nodes: ResourceNode[]): void {
  resourceNodes.clear();
  for (const node of nodes) {
    resourceNodes.set(node.node_id, node);
  }
}

export function getResourceNodes(): ResourceNode[] {
  return [...resourceNodes.values()].sort((a, b) => a.node_id.localeCompare(b.node_id));
}

export function updateResourceNode(node: ResourceNode): ResourceNode {
  resourceNodes.set(node.node_id, node);
  return node;
}

export function getLeaderboard(): Agent[] {
  return [...agents.values()]
    .sort((a, b) => b.elo - a.elo);
}

export function getEloTitle(elo: number): string {
  if (elo >= 2000) return "Completionist";
  if (elo >= 1800) return "Maxed";
  if (elo >= 1500) return "Dragon";
  if (elo >= 1200) return "Rune";
  if (elo >= 900) return "Adamant";
  return "Bronze";
}

// ELO calculation
export function updateElo(winner: Agent, loser: Agent) {
  const K = 32;
  const expectedW = 1 / (1 + 10 ** ((loser.elo - winner.elo) / 400));
  const expectedL = 1 / (1 + 10 ** ((winner.elo - loser.elo) / 400));
  winner.elo = Math.round(winner.elo + K * (1 - expectedW));
  loser.elo = Math.round(loser.elo + K * (0 - expectedL));
  winner.wins++;
  loser.losses++;
}
