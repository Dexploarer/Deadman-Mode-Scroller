import { describe, expect, it } from "bun:test";
import {
  addXp,
  applyCombatXp,
  consumeInventory,
  createDefaultProgress,
  getInventoryQty,
  getLevelForXp,
  getXpForLevel,
  XP_MULTIPLIER,
} from "../progression";

describe("progression", () => {
  it("creates OSRS-like defaults", () => {
    const progress = createDefaultProgress("Agent_1");
    expect(progress.skills.hitpoints.level).toBe(10);
    expect(progress.skills.hitpoints.xp).toBe(getXpForLevel(10));
    expect(progress.skills.mining.level).toBe(1);
    expect(progress.skills.runecrafting.level).toBe(1);
  });

  it("adds xp with configured multiplier", () => {
    const progress = createDefaultProgress("Agent_2");
    const gain = addXp(progress, "mining", 100);

    expect(gain.gained_xp).toBe(Math.floor(100 * XP_MULTIPLIER));
    expect(progress.skills.mining.xp).toBe(gain.total_xp);
    expect(gain.new_level).toBe(getLevelForXp(gain.total_xp));
  });

  it("awards combat xp to correct skills", () => {
    const progress = createDefaultProgress("Agent_3");

    const gains = applyCombatXp(progress, "slash", 10);
    const attackGain = gains.find((g) => g.skill === "attack");
    const hpGain = gains.find((g) => g.skill === "hitpoints");

    expect(gains.length).toBe(2);
    expect(attackGain?.gained_xp).toBe(Math.floor(40 * XP_MULTIPLIER));
    expect(hpGain?.gained_xp).toBe(Math.floor(13 * XP_MULTIPLIER));
  });

  it("consumes inventory deterministically", () => {
    const progress = createDefaultProgress("Agent_4");
    progress.inventory.air_rune = 5;

    const consumed = consumeInventory(progress, "air_rune", 3);
    const failed = consumeInventory(progress, "air_rune", 3);

    expect(consumed).toBe(true);
    expect(failed).toBe(false);
    expect(getInventoryQty(progress, "air_rune")).toBe(2);
  });
});
