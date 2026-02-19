import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createPlayerState, resolveTick } from "../engine";
import type { Fight } from "../types";

function makeFight(): Fight {
  return {
    fight_id: "fight_test",
    arena: "duel_arena",
    round: 1,
    tick: 0,
    status: "in_progress",
    p1: createPlayerState("P1", "melee"),
    p2: createPlayerState("P2", "melee"),
    last_result: null,
    history: [],
    rounds_won: { p1: 0, p2: 0 },
    wager_amount: 0,
    pending_actions: { p1: null, p2: null },
  };
}

const realRandom = Math.random;

beforeEach(() => {
  Math.random = () => 0;
});

afterEach(() => {
  Math.random = realRandom;
});

describe("engine prayer behavior", () => {
  it("applies 40% protection reduction", () => {
    const fight = makeFight();
    fight.pending_actions.p1 = {
      agent_id: "P1",
      fight_id: fight.fight_id,
      action: "slash",
      prayer: "none",
      food: "none",
      special: "none",
      movement: "none",
    };
    fight.pending_actions.p2 = {
      agent_id: "P2",
      fight_id: fight.fight_id,
      action: "none",
      prayer: "protect_melee",
      food: "none",
      special: "none",
      movement: "none",
    };

    resolveTick(fight);

    // Slash min hit is 10; protect prayer should reduce to 6.
    expect(fight.p2.hp).toBe(93);
  });

  it("maps legacy deflect prayer to protect behavior", () => {
    const fight = makeFight();
    fight.pending_actions.p1 = {
      agent_id: "P1",
      fight_id: fight.fight_id,
      action: "slash",
      prayer: "none",
      food: "none",
      special: "none",
      movement: "none",
    };
    fight.pending_actions.p2 = {
      agent_id: "P2",
      fight_id: fight.fight_id,
      action: "none",
      prayer: "deflect_melee",
      food: "none",
      special: "none",
      movement: "none",
    };

    resolveTick(fight);

    expect(fight.p2.hp).toBe(93);
  });

  it("applies offensive prayer modifier for piety", () => {
    const fight = makeFight();
    fight.pending_actions.p1 = {
      agent_id: "P1",
      fight_id: fight.fight_id,
      action: "slash",
      prayer: "piety",
      food: "none",
      special: "none",
      movement: "none",
    };
    fight.pending_actions.p2 = {
      agent_id: "P2",
      fight_id: fight.fight_id,
      action: "none",
      prayer: "none",
      food: "none",
      special: "none",
      movement: "none",
    };

    resolveTick(fight);

    // Slash min hit 10 with piety 1.23x => 12.
    expect(fight.p2.hp).toBe(87);
  });
});
