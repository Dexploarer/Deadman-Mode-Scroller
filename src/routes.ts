import { Hono } from "hono";
import { nanoid } from "nanoid";
import type { Agent, Challenge, Fight, Arena, ActionSubmission } from "./types";
import { agents, challenges, fights, fightSubscribers, getLeaderboard, getEloTitle, updateElo, getActiveWorldAgents } from "./store";
import { createPlayerState, resolveTick } from "./engine";

const api = new Hono();

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

  const agent: Agent = {
    agent_id,
    skills_md: skills_md || "",
    wallet_address: wallet_address || "",
    combat_class,
    prayer_book: prayer_book || "normal",
    wins: 0,
    losses: 0,
    elo: 1000,
    registered_at: Date.now(),
  };

  agents.set(agent_id, agent);
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
    arena: arena || "duel_arena",
    rules: rules || { no_prayer: false, no_food: false, no_special_attack: false },
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

  const p1Agent = agents.get(challenge.challenger_id)!;
  const p2Agent = agents.get(challenge.target_id)!;

  const fight: Fight = {
    fight_id: nanoid(12),
    arena: challenge.arena as Arena,
    round: 1,
    tick: 0,
    status: "in_progress",
    p1: createPlayerState(p1Agent.agent_id, p1Agent.combat_class),
    p2: createPlayerState(p2Agent.agent_id, p2Agent.combat_class),
    last_result: null,
    history: [],
    rounds_won: { p1: 0, p2: 0 },
    wager_amount: challenge.wager_amount,
    pending_actions: { p1: null, p2: null },
  };

  fights.set(fight.fight_id, fight);

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

  // If both submitted, resolve tick
  if (fight.pending_actions.p1 && fight.pending_actions.p2) {
    const result = resolveTick(fight);

    // Broadcast to WebSocket subscribers
    const subs = fightSubscribers.get(fight_id);
    if (subs) {
      const msg = JSON.stringify({ type: "tick_update", fight_id, result, state: sanitizeFight(fight) });
      for (const ws of subs) {
        try { ws.send(msg); } catch {}
      }
    }

    return c.json({ status: "tick_resolved", result, fight: sanitizeFight(fight) });
  }

  return c.json({ status: "action_submitted", waiting_for: isP1 ? "p2" : "p1" });
});

// ── Next Round ──
api.post("/arena/next-round", async (c) => {
  const { fight_id } = await c.req.json();
  const fight = fights.get(fight_id);
  if (!fight) return c.json({ error: "Fight not found" }, 404);
  if (fight.status === "fight_over") {
    // Determine winner and update ELO
    const winnerId = fight.rounds_won.p1 >= 2 ? fight.p1.agent_id : fight.p2.agent_id;
    const loserId = winnerId === fight.p1.agent_id ? fight.p2.agent_id : fight.p1.agent_id;
    const winner = agents.get(winnerId);
    const loser = agents.get(loserId);
    if (winner && loser) updateElo(winner, loser);
    return c.json({ status: "fight_over", winner: winnerId, rounds_won: fight.rounds_won });
  }
  if (fight.status !== "round_over") return c.json({ error: "Round not over yet" }, 400);

  // Reset for next round
  fight.round++;
  fight.tick = 0;
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

// ── Open World Active Agents ──
api.get("/world/agents", (c) => {
  return c.json(getActiveWorldAgents());
});

// ── Agent Info Endpoint ──
api.get("/agent-info", (c) => {
  return c.json({
    name: "RuneScape Agent Arena",
    version: "1.0.0",
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

// Sanitize fight state for API response (hide pending actions)
function sanitizeFight(fight: Fight) {
  return {
    fight_id: fight.fight_id,
    arena: fight.arena,
    round: fight.round,
    tick: fight.tick,
    status: fight.status,
    p1: { ...fight.p1 },
    p2: { ...fight.p2 },
    last_result: fight.last_result,
    history: fight.history,
    rounds_won: fight.rounds_won,
    wager_amount: fight.wager_amount,
  };
}

export default api;
