import { Hono } from "hono";
import { nanoid } from "nanoid";
import type {
  ActionSubmission,
  Agent,
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
  activeSkillJobs,
  agentProgress,
  agents,
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
  setResourceNodes,
  skillSubscribers,
  type SocketLike,
  updateResourceNode,
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
  getPortalById,
  getSkillLevel,
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
  appendDuelTick,
  appendSkillEvent,
  loadAgentProgress,
  loadResourceNodes,
  saveAgentProgress,
  upsertAgent,
  upsertDuelSummary,
  upsertResourceNodes,
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
  "teleport_wilderness",
  "teleport_shadow_dungeon",
];

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
  if (resourceInitPromise) return resourceInitPromise;

  resourceInitPromise = (async () => {
    const persisted = await loadResourceNodes();
    if (persisted.length > 0) {
      setResourceNodes(
        persisted.map((node) => ({
          ...node,
          area_id: node.area_id ?? "surface_main",
          instance_id: node.instance_id ?? null,
        }))
      );
      return;
    }

    const defaults = makeDefaultResourceNodes();
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

  const level = getSkillLevel(progress, node.skill);
  const success = rollGatherSuccess(level, node);

  if (success) {
    const gain = addXp(progress, node.skill, node.xp);
    const qty = addInventory(progress, node.item_id, 1);
    upsertProgress(progress);

    await saveAgentProgress(progress);
    await appendSkillEvent(agentId, gain, `gather:${node.type}`);

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

    const depletionChance =
      node.skill === "fishing" ? 0.08 :
      node.skill === "mining" ? 0.25 :
      node.skill === "runecrafting" ? 0.12 :
      0.22;
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

  return {
    agent,
    progress,
    queue: queueEntry,
    world: worldAgents.get(agentId) ?? null,
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

  return SPELL_ORDER.map((spellName) => {
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

// ── Register ──
api.post("/arena/register", async (c) => {
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
api.get("/arena/leaderboard", (c) => {
  const lb = getLeaderboard().map((a, i) => ({
    rank: i + 1,
    agent_id: a.agent_id,
    combat_class: a.combat_class,
    elo: a.elo,
    title: getEloTitle(a.elo),
    wins: a.wins,
    losses: a.losses,
    kd: a.losses > 0 ? (a.wins / a.losses).toFixed(2) : a.wins.toString(),
  }));
  return c.json(lb);
});

// ── Pending Challenges ──
api.get("/arena/challenges/:agent_id", (c) => {
  const id = c.req.param("agent_id");
  const pending = [...challenges.values()].filter(
    (ch) => (ch.target_id === id || ch.challenger_id === id) && ch.status === "pending"
  );
  return c.json(pending);
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

// ── Portal -> Queue ──
api.post("/world/portal/use", async (c) => {
  const body: PortalTravelRequest & { arena?: Arena; fallback_bot_after_ms?: number } = await c.req.json();
  const { agent_id, portal_id, scope, arena, fallback_bot_after_ms } = body;

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

    return c.json({
      status: "teleported",
      portal,
      area,
      world: nextWorld,
      scope: resolvedScope,
    });
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
  let nodes = getResourceNodes();
  if (areaId) {
    nodes = nodes.filter((node) => node.area_id === areaId && (node.instance_id ?? null) === instanceId);
  }
  return c.json(nodes);
});

// ── Open World Interactions ──
api.post("/world/interact", async (c) => {
  await ensureResourceNodesInitialized();
  const body: WorldInteractRequest = await c.req.json();
  const { agent_id, node_id, action } = body;

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

  const magicGain = addXp(progress, "magic", definition.base_xp);
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

    const scope = definition.teleport.default_scope ?? "shared";
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
    return c.json({
      status: "teleported",
      spell,
      gain: magicGain,
      world: worldState,
      inventory: progress.inventory,
    });
  }

  return c.json({
    status: "cast",
    spell,
    gain: magicGain,
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
    version: "1.1.0",
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
