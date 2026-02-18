import type { Agent, Challenge, Fight, WorldAgent } from "./types";

// In-memory store
export const agents = new Map<string, Agent>();
export const challenges = new Map<string, Challenge>();
export const fights = new Map<string, Fight>();

// WebSocket subscribers per fight
export const fightSubscribers = new Map<string, Set<any>>(); // fight_id -> Set<ws>

// Open world presence
export const worldAgents = new Map<string, WorldAgent>(); // agent_id -> latest state
export const worldSubscribers = new Set<any>(); // Set<ws>

const WORLD_AGENT_TTL_MS = 15_000;

export function upsertWorldAgent(agent: Omit<WorldAgent, "updated_at">): WorldAgent {
  const next: WorldAgent = {
    ...agent,
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
  const expectedW = 1 / (1 + Math.pow(10, (loser.elo - winner.elo) / 400));
  const expectedL = 1 / (1 + Math.pow(10, (winner.elo - loser.elo) / 400));
  winner.elo = Math.round(winner.elo + K * (1 - expectedW));
  loser.elo = Math.round(loser.elo + K * (0 - expectedL));
  winner.wins++;
  loser.losses++;
}
