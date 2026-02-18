import { beforeEach, describe, expect, it } from "bun:test";
import {
  agents,
  challenges,
  fights,
  worldAgents,
  upsertWorldAgent,
  removeWorldAgent,
  getActiveWorldAgents,
} from "../store";

describe("world agent presence store", () => {
  beforeEach(() => {
    agents.clear();
    challenges.clear();
    fights.clear();
    worldAgents.clear();
  });

  it("upserts and returns active world agents", () => {
    upsertWorldAgent({
      agent_id: "Player_abc",
      combat_class: "melee",
      x: 1200,
      y: 520,
      zone: "Lumbridge",
    });

    const active = getActiveWorldAgents();
    expect(active).toHaveLength(1);
    expect(active[0]?.agent_id).toBe("Player_abc");
    expect(active[0]?.zone).toBe("Lumbridge");
  });

  it("prunes stale world agents by ttl", () => {
    upsertWorldAgent({
      agent_id: "Player_old",
      combat_class: "magic",
      x: 6000,
      y: 520,
      zone: "Varrock",
    });

    const current = worldAgents.get("Player_old");
    if (current) {
      current.updated_at = Date.now() - 20_000;
      worldAgents.set("Player_old", current);
    }

    const active = getActiveWorldAgents();
    expect(active).toHaveLength(0);
    expect(worldAgents.has("Player_old")).toBe(false);
  });

  it("removes agents explicitly", () => {
    upsertWorldAgent({
      agent_id: "Player_x",
      combat_class: "ranged",
      x: 8000,
      y: 520,
      zone: "Wilderness",
    });

    expect(removeWorldAgent("Player_x")).toBe(true);
    expect(removeWorldAgent("Player_x")).toBe(false);
    expect(getActiveWorldAgents()).toHaveLength(0);
  });
});
