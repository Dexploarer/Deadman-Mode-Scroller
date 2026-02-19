import type {
  Agent,
  AgentProgress,
  Challenge,
  DuelQueueEntry,
  Fight,
  ResourceNode,
  WorldAgent,
} from "./types";
import { createDefaultProgress } from "./progression";

export interface SocketLike {
  send: (message: string) => void;
  data?: Record<string, unknown>;
}

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
