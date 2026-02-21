import { describe, expect, it } from "bun:test";
import { createDefaultProgress } from "../progression";
import {
  canGatherNode,
  getPortalById,
  getPortalHopDistance,
  getWorldAreas,
  isTravelWithinBudget,
  getWorldPortals,
  makeDefaultResourceNodes,
  markNodeDepleted,
  markNodeRespawned,
} from "../world";

describe("world resource nodes", () => {
  it("includes key OSRS-inspired tiers", () => {
    const nodes = makeDefaultResourceNodes();
    const types = new Set(nodes.map((n) => n.type));

    expect(types.has("runite_rock")).toBe(true);
    expect(types.has("magic_tree")).toBe(true);
    expect(types.has("shark_spot")).toBe(true);
    expect(types.has("law_altar")).toBe(true);
    expect(types.has("cooking_range")).toBe(true);

    const membersLocked = nodes.filter((n) => n.members_only);
    expect(membersLocked.length).toBeGreaterThan(0);
    expect(membersLocked.some((n) => n.skill === "agility")).toBe(true);
    expect(membersLocked.some((n) => n.skill === "construction")).toBe(true);
  });

  it("blocks gather below required level", () => {
    const node = makeDefaultResourceNodes().find((n) => n.type === "runite_rock");
    if (!node) throw new Error("runite node missing");

    const progress = createDefaultProgress("Agent_4");
    const result = canGatherNode(progress, node);

    expect(result.ok).toBe(false);
    expect(result.reason).toContain("required");
  });

  it("supports depletion and respawn transitions", () => {
    const node = makeDefaultResourceNodes()[0];
    if (!node) throw new Error("resource nodes missing");
    const depleted = markNodeDepleted(node, Date.now());

    expect(depleted.depleted_until).not.toBeNull();

    const respawned = markNodeRespawned(depleted);
    expect(respawned.depleted_until).toBeNull();
  });

  it("exposes portal topology across shared and personal scopes", () => {
    const areas = getWorldAreas();
    const portals = getWorldPortals();
    const questPortal = getPortalById("quest_portal");

    expect(areas.some((area) => area.area_id === "runecraft_nexus")).toBe(true);
    expect(areas.some((area) => area.area_id === "skills_guild" && area.shared === true)).toBe(true);
    expect(areas.some((area) => area.area_id === "quest_shard" && area.shared === false)).toBe(true);
    expect(portals.some((portal) => portal.portal_id === "depths_portal")).toBe(true);
    expect(portals.some((portal) => portal.portal_id === "surface_loop_east")).toBe(true);
    expect(questPortal?.default_scope).toBe("personal");
  });

  it("keeps travel within portal hop budget for core activity regions", () => {
    expect(isTravelWithinBudget("surface_main", "runecraft_nexus")).toBe(true);
    expect(isTravelWithinBudget("surface_main", "shadow_dungeon")).toBe(true);
    expect(getPortalHopDistance("surface_main", "shadow_dungeon")).toBeLessThanOrEqual(2);
  });
});
