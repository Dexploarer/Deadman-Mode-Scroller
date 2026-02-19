import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import api from "../routes";
import {
  activeSkillJobs,
  agentProgress,
  agents,
  challenges,
  duelQueue,
  duelQueueFallbackTimers,
  fights,
  fightSubscribers,
  fightTickTimers,
  getOrCreateProgress,
  nodeRespawnTimers,
  resourceNodes,
  worldAgents,
  worldSubscribers,
} from "../store";

async function postJson(path: string, body: unknown) {
  const res = await api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    ok: res.ok,
    data: await res.json(),
  };
}

beforeEach(() => {
  agents.clear();
  challenges.clear();
  fights.clear();
  fightSubscribers.clear();
  fightTickTimers.forEach((timer) => {
    clearTimeout(timer);
  });
  fightTickTimers.clear();

  duelQueue.clear();
  duelQueueFallbackTimers.forEach((timer) => {
    clearTimeout(timer);
  });
  duelQueueFallbackTimers.clear();

  activeSkillJobs.forEach((job) => {
    if (job.timeout) clearTimeout(job.timeout);
  });
  activeSkillJobs.clear();

  nodeRespawnTimers.forEach((timer) => {
    clearTimeout(timer);
  });
  nodeRespawnTimers.clear();

  worldAgents.clear();
  worldSubscribers.clear();
  resourceNodes.clear();
  agentProgress.clear();
});

afterEach(() => {
  fightTickTimers.forEach((timer) => {
    clearTimeout(timer);
  });
  fightTickTimers.clear();
  duelQueueFallbackTimers.forEach((timer) => {
    clearTimeout(timer);
  });
  duelQueueFallbackTimers.clear();
  nodeRespawnTimers.forEach((timer) => {
    clearTimeout(timer);
  });
  nodeRespawnTimers.clear();
});

describe("routes duel ticks and spellbook", () => {
  it("exposes duel tick window metadata on created fights", async () => {
    const regA = await postJson("/arena/register", {
      agent_id: "TickA",
      combat_class: "melee",
      prayer_book: "normal",
    });
    const regB = await postJson("/arena/register", {
      agent_id: "TickB",
      combat_class: "ranged",
      prayer_book: "normal",
    });

    expect(regA.ok).toBe(true);
    expect(regB.ok).toBe(true);

    const challenge = await postJson("/arena/challenge", {
      agent_id: "TickA",
      target_agent_id: "TickB",
      arena: "duel_arena",
    });
    expect(challenge.ok).toBe(true);

    const accept = await postJson("/arena/accept", {
      agent_id: "TickB",
      challenge_id: challenge.data.challenge.challenge_id,
    });
    expect(accept.ok).toBe(true);

    const fightRes = await api.request(`/arena/fight/${accept.data.fight_id}`);
    expect(fightRes.ok).toBe(true);
    const fight = await fightRes.json();

    const now = Date.now();
    expect(fight.tick).toBe(0);
    expect(fight.tick_window_ms).toBe(600);
    expect(fight.next_tick_at).toBeGreaterThanOrEqual(now);
    expect(fight.next_tick_at - now).toBeLessThanOrEqual(2_000);

    const p1Action = await postJson("/arena/action", {
      agent_id: "TickA",
      fight_id: accept.data.fight_id,
      action: "slash",
      prayer: "none",
      food: "none",
      special: "none",
      movement: "none",
    });
    expect(p1Action.ok).toBe(true);
    expect(p1Action.data.status).toBe("action_submitted");

    const p2Action = await postJson("/arena/action", {
      agent_id: "TickB",
      fight_id: accept.data.fight_id,
      action: "rapid_shot",
      prayer: "none",
      food: "none",
      special: "none",
      movement: "none",
    });
    expect(p2Action.ok).toBe(true);
    expect(["tick_scheduled", "tick_resolved"]).toContain(p2Action.data.status);
  });

  it("casts teleport spells by consuming runes and moving world state", async () => {
    const reg = await postJson("/arena/register", {
      agent_id: "MageA",
      combat_class: "magic",
      prayer_book: "normal",
    });
    expect(reg.ok).toBe(true);

    const progress = getOrCreateProgress("MageA");
    progress.skills.magic = { level: 70, xp: 800_000 };
    progress.inventory.law_rune = 3;
    progress.inventory.air_rune = 12;
    progress.inventory.mind_rune = 4;

    const cast = await postJson("/world/spell/cast", {
      agent_id: "MageA",
      spell: "teleport_varrock",
    });

    expect(cast.ok).toBe(true);
    expect(cast.data.status).toBe("teleported");
    expect(cast.data.world.area_id).toBe("surface_main");
    expect(cast.data.world.zone).toBe("Varrock");
    expect(cast.data.inventory.law_rune).toBe(2);
    expect(cast.data.inventory.air_rune).toBe(9);
    expect(cast.data.inventory.mind_rune).toBe(3);

    const worldState = worldAgents.get("MageA");
    expect(worldState?.area_id).toBe("surface_main");
    expect(worldState?.zone).toBe("Varrock");
  });

  it("rejects spell casts when runes are missing", async () => {
    const reg = await postJson("/arena/register", {
      agent_id: "MageB",
      combat_class: "magic",
      prayer_book: "normal",
    });
    expect(reg.ok).toBe(true);

    const progress = getOrCreateProgress("MageB");
    progress.skills.magic = { level: 70, xp: 800_000 };
    progress.inventory.law_rune = 0;
    progress.inventory.air_rune = 0;

    const cast = await postJson("/world/spell/cast", {
      agent_id: "MageB",
      spell: "teleport_lumbridge",
    });

    expect(cast.ok).toBe(false);
    expect(cast.status).toBe(400);
    expect(cast.data.error).toBe("Insufficient runes");
  });
});
