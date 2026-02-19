import type {
  AgentProgress,
  GatheringSkill,
  ResourceNode,
  ResourceNodeType,
  SkillName,
  WorldArea,
  WorldPortal,
} from "./types";

export const INTERACTION_MAX_DISTANCE = 130;

export interface ResourceNodeTemplate {
  type: ResourceNodeType;
  skill: GatheringSkill;
  item_id: string;
  zone: string;
  area_id: string;
  instance_id?: string | null;
  level_required: number;
  xp: number;
  success_chance: number;
  respawn_ms: number;
  x: number;
  y: number;
}

const WORLD_AREAS: WorldArea[] = [
  {
    area_id: "surface_main",
    name: "Surface Kingdoms",
    description: "Lumbridge through Al Kharid with Emir's Arena access",
    environment: "mainline",
    shared: true,
    world_width: 12000,
    spawn_x: 320,
    spawn_y: 520,
    spawn_zone: "Lumbridge",
  },
  {
    area_id: "runecraft_nexus",
    name: "Runecraft Nexus",
    description: "Arcane altars used to craft runes for spellcasting",
    environment: "arcane",
    shared: true,
    world_width: 3400,
    spawn_x: 420,
    spawn_y: 520,
    spawn_zone: "Nexus Gate",
  },
  {
    area_id: "wilderness_depths",
    name: "Wilderness Depths",
    description: "Harsh PvP wilderness beyond the border",
    environment: "wilderness",
    shared: true,
    world_width: 3600,
    spawn_x: 380,
    spawn_y: 520,
    spawn_zone: "Depths Entry",
  },
  {
    area_id: "shadow_dungeon",
    name: "Shadow Dungeon",
    description: "Dark dungeon layered behind portal travel",
    environment: "dungeon",
    shared: true,
    world_width: 3000,
    spawn_x: 300,
    spawn_y: 520,
    spawn_zone: "Dungeon Gate",
  },
  {
    area_id: "quest_shard",
    name: "Quest Instance",
    description: "Personal quest area for one agent",
    environment: "quest",
    shared: false,
    world_width: 2200,
    spawn_x: 280,
    spawn_y: 520,
    spawn_zone: "Quest Start",
  },
  {
    area_id: "emirs_arena",
    name: "Emir's Arena",
    description: "Instanced duel battleground",
    environment: "minigame",
    shared: false,
    world_width: 2600,
    spawn_x: 760,
    spawn_y: 520,
    spawn_zone: "Arena Floor",
  },
];

const WORLD_PORTALS: WorldPortal[] = [
  {
    portal_id: "emirs_arena_portal",
    name: "Emir's Arena Portal",
    from_area_id: "surface_main",
    from_x: 6180,
    from_y: 520,
    to_area_id: "emirs_arena",
    to_x: 760,
    to_y: 520,
    to_zone: "Arena Floor",
    kind: "duel_queue",
    default_scope: "shared",
  },
  {
    portal_id: "nexus_portal",
    name: "Runecraft Nexus",
    from_area_id: "surface_main",
    from_x: 6040,
    from_y: 520,
    to_area_id: "runecraft_nexus",
    to_x: 420,
    to_y: 520,
    to_zone: "Nexus Gate",
    kind: "travel",
    default_scope: "shared",
  },
  {
    portal_id: "depths_portal",
    name: "Wilderness Depths",
    from_area_id: "surface_main",
    from_x: 6680,
    from_y: 520,
    to_area_id: "wilderness_depths",
    to_x: 380,
    to_y: 520,
    to_zone: "Depths Entry",
    kind: "travel",
    default_scope: "shared",
  },
  {
    portal_id: "shadow_portal",
    name: "Shadow Dungeon",
    from_area_id: "runecraft_nexus",
    from_x: 2340,
    from_y: 520,
    to_area_id: "shadow_dungeon",
    to_x: 300,
    to_y: 520,
    to_zone: "Dungeon Gate",
    kind: "travel",
    default_scope: "shared",
  },
  {
    portal_id: "quest_portal",
    name: "Quest Shard",
    from_area_id: "runecraft_nexus",
    from_x: 1920,
    from_y: 520,
    to_area_id: "quest_shard",
    to_x: 280,
    to_y: 520,
    to_zone: "Quest Start",
    kind: "travel",
    default_scope: "personal",
  },
  {
    portal_id: "return_surface_from_nexus",
    name: "Surface Return",
    from_area_id: "runecraft_nexus",
    from_x: 220,
    from_y: 520,
    to_area_id: "surface_main",
    to_x: 5980,
    to_y: 520,
    to_zone: "Al Kharid",
    kind: "travel",
    default_scope: "shared",
  },
  {
    portal_id: "return_surface_from_depths",
    name: "Surface Return",
    from_area_id: "wilderness_depths",
    from_x: 220,
    from_y: 520,
    to_area_id: "surface_main",
    to_x: 6540,
    to_y: 520,
    to_zone: "Wilderness Border",
    kind: "travel",
    default_scope: "shared",
  },
  {
    portal_id: "return_nexus_from_shadow",
    name: "Nexus Return",
    from_area_id: "shadow_dungeon",
    from_x: 220,
    from_y: 520,
    to_area_id: "runecraft_nexus",
    to_x: 2260,
    to_y: 520,
    to_zone: "Nexus Gate",
    kind: "travel",
    default_scope: "shared",
  },
  {
    portal_id: "return_nexus_from_quest",
    name: "Nexus Return",
    from_area_id: "quest_shard",
    from_x: 220,
    from_y: 520,
    to_area_id: "runecraft_nexus",
    to_x: 1840,
    to_y: 520,
    to_zone: "Nexus Gate",
    kind: "travel",
    default_scope: "shared",
  },
];

const TEMPLATES: ResourceNodeTemplate[] = [
  // Al Kharid Mining
  {
    type: "copper_rock",
    skill: "mining",
    item_id: "copper_ore",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 1,
    xp: 17,
    success_chance: 0.78,
    respawn_ms: 3500,
    x: 5750,
    y: 520,
  },
  {
    type: "tin_rock",
    skill: "mining",
    item_id: "tin_ore",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 1,
    xp: 17,
    success_chance: 0.78,
    respawn_ms: 3500,
    x: 5830,
    y: 520,
  },
  {
    type: "iron_rock",
    skill: "mining",
    item_id: "iron_ore",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 15,
    xp: 35,
    success_chance: 0.62,
    respawn_ms: 7000,
    x: 5920,
    y: 520,
  },
  {
    type: "coal_rock",
    skill: "mining",
    item_id: "coal",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 30,
    xp: 50,
    success_chance: 0.54,
    respawn_ms: 9000,
    x: 6010,
    y: 520,
  },
  {
    type: "mithril_rock",
    skill: "mining",
    item_id: "mithril_ore",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 55,
    xp: 80,
    success_chance: 0.45,
    respawn_ms: 12000,
    x: 6100,
    y: 520,
  },
  {
    type: "adamantite_rock",
    skill: "mining",
    item_id: "adamantite_ore",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 70,
    xp: 95,
    success_chance: 0.38,
    respawn_ms: 14000,
    x: 6185,
    y: 520,
  },
  {
    type: "runite_rock",
    skill: "mining",
    item_id: "runite_ore",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 85,
    xp: 125,
    success_chance: 0.24,
    respawn_ms: 25000,
    x: 6275,
    y: 520,
  },

  // Al Kharid Woodcutting
  {
    type: "normal_tree",
    skill: "woodcutting",
    item_id: "logs",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 1,
    xp: 25,
    success_chance: 0.82,
    respawn_ms: 3000,
    x: 5480,
    y: 520,
  },
  {
    type: "oak_tree",
    skill: "woodcutting",
    item_id: "oak_logs",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 15,
    xp: 37,
    success_chance: 0.66,
    respawn_ms: 6500,
    x: 5560,
    y: 520,
  },
  {
    type: "willow_tree",
    skill: "woodcutting",
    item_id: "willow_logs",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 30,
    xp: 67,
    success_chance: 0.56,
    respawn_ms: 9000,
    x: 5640,
    y: 520,
  },
  {
    type: "yew_tree",
    skill: "woodcutting",
    item_id: "yew_logs",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 60,
    xp: 100,
    success_chance: 0.42,
    respawn_ms: 16000,
    x: 5320,
    y: 520,
  },
  {
    type: "magic_tree",
    skill: "woodcutting",
    item_id: "magic_logs",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 75,
    xp: 125,
    success_chance: 0.32,
    respawn_ms: 22000,
    x: 5240,
    y: 520,
  },

  // Al Kharid Fishing
  {
    type: "shrimp_spot",
    skill: "fishing",
    item_id: "raw_shrimp",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 1,
    xp: 10,
    success_chance: 0.85,
    respawn_ms: 1000,
    x: 6360,
    y: 520,
  },
  {
    type: "anchovy_spot",
    skill: "fishing",
    item_id: "raw_anchovies",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 15,
    xp: 40,
    success_chance: 0.65,
    respawn_ms: 1400,
    x: 6420,
    y: 520,
  },
  {
    type: "trout_spot",
    skill: "fishing",
    item_id: "raw_trout",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 20,
    xp: 50,
    success_chance: 0.62,
    respawn_ms: 1600,
    x: 6480,
    y: 520,
  },
  {
    type: "salmon_spot",
    skill: "fishing",
    item_id: "raw_salmon",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 30,
    xp: 70,
    success_chance: 0.56,
    respawn_ms: 2000,
    x: 6540,
    y: 520,
  },
  {
    type: "lobster_spot",
    skill: "fishing",
    item_id: "raw_lobster",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 40,
    xp: 90,
    success_chance: 0.5,
    respawn_ms: 2200,
    x: 6600,
    y: 520,
  },
  {
    type: "swordfish_spot",
    skill: "fishing",
    item_id: "raw_swordfish",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 50,
    xp: 100,
    success_chance: 0.46,
    respawn_ms: 2800,
    x: 6660,
    y: 520,
  },
  {
    type: "shark_spot",
    skill: "fishing",
    item_id: "raw_shark",
    zone: "Al Kharid",
    area_id: "surface_main",
    level_required: 76,
    xp: 110,
    success_chance: 0.34,
    respawn_ms: 3400,
    x: 6720,
    y: 520,
  },

  // Runecrafting in Nexus
  {
    type: "air_altar",
    skill: "runecrafting",
    item_id: "air_rune",
    zone: "Runecraft Nexus",
    area_id: "runecraft_nexus",
    level_required: 1,
    xp: 12,
    success_chance: 0.9,
    respawn_ms: 900,
    x: 980,
    y: 520,
  },
  {
    type: "mind_altar",
    skill: "runecrafting",
    item_id: "mind_rune",
    zone: "Runecraft Nexus",
    area_id: "runecraft_nexus",
    level_required: 2,
    xp: 14,
    success_chance: 0.86,
    respawn_ms: 950,
    x: 1140,
    y: 520,
  },
  {
    type: "nature_altar",
    skill: "runecrafting",
    item_id: "nature_rune",
    zone: "Runecraft Nexus",
    area_id: "runecraft_nexus",
    level_required: 44,
    xp: 92,
    success_chance: 0.48,
    respawn_ms: 1800,
    x: 1460,
    y: 520,
  },
  {
    type: "law_altar",
    skill: "runecrafting",
    item_id: "law_rune",
    zone: "Runecraft Nexus",
    area_id: "runecraft_nexus",
    level_required: 54,
    xp: 105,
    success_chance: 0.41,
    respawn_ms: 2200,
    x: 1640,
    y: 520,
  },
];

const SKILL_INTERVAL_MS: Record<GatheringSkill, number> = {
  mining: 2400,
  woodcutting: 2600,
  fishing: 2200,
  runecrafting: 1800,
};

export function getGatherInterval(skill: GatheringSkill): number {
  return SKILL_INTERVAL_MS[skill];
}

export function getWorldAreas(): WorldArea[] {
  return WORLD_AREAS.map((area) => ({ ...area }));
}

export function getWorldAreaById(areaId: string): WorldArea | null {
  const area = WORLD_AREAS.find((candidate) => candidate.area_id === areaId);
  return area ? { ...area } : null;
}

export function getWorldPortals(): WorldPortal[] {
  return WORLD_PORTALS.map((portal) => ({ ...portal }));
}

export function listPortalsForArea(areaId: string): WorldPortal[] {
  return WORLD_PORTALS.filter((portal) => portal.from_area_id === areaId).map((portal) => ({ ...portal }));
}

export function getPortalById(portalId: string): WorldPortal | null {
  const portal = WORLD_PORTALS.find((candidate) => candidate.portal_id === portalId);
  return portal ? { ...portal } : null;
}

export function makeDefaultResourceNodes(): ResourceNode[] {
  return TEMPLATES.map((template, index) => ({
    node_id: `${template.type}_${index + 1}`,
    ...template,
    depleted_until: null,
  }));
}

export function isNodeAvailable(node: ResourceNode, now = Date.now()): boolean {
  return node.depleted_until === null || node.depleted_until <= now;
}

export function getSkillLevel(progress: AgentProgress, skill: SkillName): number {
  return progress.skills[skill]?.level ?? 1;
}

export function canGatherNode(progress: AgentProgress, node: ResourceNode): { ok: boolean; reason?: string } {
  const level = getSkillLevel(progress, node.skill);
  if (level < node.level_required) {
    return { ok: false, reason: `${node.skill} level ${node.level_required} required` };
  }
  if (!isNodeAvailable(node)) {
    return { ok: false, reason: "Resource is depleted" };
  }
  return { ok: true };
}

export function rollGatherSuccess(level: number, node: ResourceNode): boolean {
  const bonus = Math.max(0, level - node.level_required) * 0.012;
  const chance = Math.max(0.08, Math.min(0.96, node.success_chance + bonus));
  return Math.random() < chance;
}

export function markNodeDepleted(node: ResourceNode, now = Date.now()): ResourceNode {
  return {
    ...node,
    depleted_until: now + node.respawn_ms,
  };
}

export function markNodeRespawned(node: ResourceNode): ResourceNode {
  return {
    ...node,
    depleted_until: null,
  };
}

export function distance(aX: number, aY: number, bX: number, bY: number): number {
  return Math.hypot(aX - bX, aY - bY);
}
