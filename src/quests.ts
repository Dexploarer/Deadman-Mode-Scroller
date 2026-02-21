import { addInventory, addXp, getInventoryQty, getSkillLevel, type XpGain } from "./progression";
import type { AgentProgress, SkillName, SpellName, WorldAgent } from "./types";

export type QuestStatus = "not_started" | "in_progress" | "completed";

type QuestObjective =
  | {
      objective_id: string;
      description: string;
      type: "collect_item";
      item_id: string;
      qty: number;
    }
  | {
      objective_id: string;
      description: string;
      type: "reach_skill";
      skill: SkillName;
      level: number;
    }
  | {
      objective_id: string;
      description: string;
      type: "visit_area";
      area_id: string;
      count: number;
    }
  | {
      objective_id: string;
      description: string;
      type: "cast_spell";
      spell: SpellName;
      count: number;
    }
  | {
      objective_id: string;
      description: string;
      type: "win_duel";
      count: number;
    };

interface QuestDefinition {
  quest_id: string;
  name: string;
  description: string;
  giver_npc_id: string;
  turn_in_npc_id: string;
  objectives: QuestObjective[];
  rewards: {
    xp: Partial<Record<SkillName, number>>;
    items: Record<string, number>;
  };
}

interface QuestRuntime {
  status: QuestStatus;
  objective_index: number;
  reward_claimed: boolean;
  started_at: number | null;
  completed_at: number | null;
}

interface AgentQuestRuntime {
  quests: Record<string, QuestRuntime>;
  visited_areas: Record<string, number>;
  spells_cast: Partial<Record<SpellName, number>>;
  duel_wins: number;
}

export interface QuestObjectiveView {
  objective_id: string;
  description: string;
  current: number;
  target: number;
  complete: boolean;
}

export interface QuestView {
  quest_id: string;
  name: string;
  description: string;
  giver_npc_id: string;
  turn_in_npc_id: string;
  status: QuestStatus;
  reward_claimed: boolean;
  started_at: number | null;
  completed_at: number | null;
  active_objective_index: number;
  objectives: QuestObjectiveView[];
}

export interface QuestUpdateEvent {
  quest_id: string;
  kind: "started" | "advanced" | "completed" | "reward_claimed";
  objective_index?: number;
}

export interface QuestRewardResult {
  quest_id: string;
  xp_gains: XpGain[];
  item_rewards: Record<string, number>;
}

type DialogueAction =
  | { type: "start_quest"; quest_id: string }
  | { type: "claim_reward"; quest_id: string }
  | { type: "close" };

interface DialogueChoice {
  choice_id: string;
  text: string;
  next_node_id?: string;
  action?: DialogueAction;
}

interface DialogueNode {
  node_id: string;
  speaker: string;
  text: string;
  choices: DialogueChoice[];
}

interface DialogueTree {
  npc_id: string;
  nodes: Record<string, DialogueNode>;
  root: (agentId: string) => string;
}

export interface DialogueNodeView {
  npc_id: string;
  node_id: string;
  speaker: string;
  text: string;
  choices: Array<{ choice_id: string; text: string }>;
}

interface DialogueResult {
  closed: boolean;
  node: DialogueNodeView | null;
  quest_updates: QuestUpdateEvent[];
  reward: QuestRewardResult | null;
}

const QUESTS: QuestDefinition[] = [
  {
    quest_id: "black_knights_fortress",
    name: "Black Knights' Fortress",
    description: "Scout hostile territory and bring proof of sabotage.",
    giver_npc_id: "sir_amik",
    turn_in_npc_id: "sir_amik",
    objectives: [
      {
        objective_id: "visit_wilderness",
        description: "Scout the Wilderness Depths",
        type: "visit_area",
        area_id: "wilderness_depths",
        count: 1,
      },
      {
        objective_id: "collect_intel",
        description: "Collect 1 black_knight_intel",
        type: "collect_item",
        item_id: "black_knight_intel",
        qty: 1,
      },
    ],
    rewards: {
      xp: { attack: 250, defence: 200 },
      items: { coins: 500 },
    },
  },
  {
    quest_id: "cooks_assistant",
    name: "Cook's Assistant",
    description: "Gather ingredients and help prepare a royal feast.",
    giver_npc_id: "cook",
    turn_in_npc_id: "cook",
    objectives: [
      {
        objective_id: "collect_flour",
        description: "Collect 1 pot_of_flour",
        type: "collect_item",
        item_id: "pot_of_flour",
        qty: 1,
      },
      {
        objective_id: "collect_egg",
        description: "Collect 1 egg",
        type: "collect_item",
        item_id: "egg",
        qty: 1,
      },
      {
        objective_id: "collect_milk",
        description: "Collect 1 bucket_of_milk",
        type: "collect_item",
        item_id: "bucket_of_milk",
        qty: 1,
      },
    ],
    rewards: {
      xp: { cooking: 300 },
      items: { coins: 200 },
    },
  },
  {
    quest_id: "demon_slayer",
    name: "Demon Slayer",
    description: "Defeat a powerful demon and prove your courage.",
    giver_npc_id: "gypsy_aris",
    turn_in_npc_id: "gypsy_aris",
    objectives: [
      {
        objective_id: "duel_win",
        description: "Win 1 duel",
        type: "win_duel",
        count: 1,
      },
    ],
    rewards: {
      xp: { strength: 350, attack: 250 },
      items: { silverlight_relic: 1 },
    },
  },
  {
    quest_id: "dorics_quest",
    name: "Doric's Quest",
    description: "Mine ore and supply Doric's forge.",
    giver_npc_id: "doric",
    turn_in_npc_id: "doric",
    objectives: [
      {
        objective_id: "collect_copper",
        description: "Collect 6 copper_ore",
        type: "collect_item",
        item_id: "copper_ore",
        qty: 6,
      },
      {
        objective_id: "collect_clay",
        description: "Collect 6 clay",
        type: "collect_item",
        item_id: "clay",
        qty: 6,
      },
      {
        objective_id: "collect_iron",
        description: "Collect 2 iron_ore",
        type: "collect_item",
        item_id: "iron_ore",
        qty: 2,
      },
    ],
    rewards: {
      xp: { mining: 500 },
      items: { coins: 300 },
    },
  },
  {
    quest_id: "dragon_slayer",
    name: "Dragon Slayer",
    description: "Complete final combat proving grounds for F2P progression.",
    giver_npc_id: "ozyach",
    turn_in_npc_id: "ozyach",
    objectives: [
      {
        objective_id: "visit_shadow",
        description: "Visit Shadow Dungeon",
        type: "visit_area",
        area_id: "shadow_dungeon",
        count: 1,
      },
      {
        objective_id: "reach_combat_magic",
        description: "Reach magic level 33",
        type: "reach_skill",
        skill: "magic",
        level: 33,
      },
      {
        objective_id: "final_duel",
        description: "Win 1 duel",
        type: "win_duel",
        count: 1,
      },
    ],
    rewards: {
      xp: { strength: 800, defence: 800, magic: 600 },
      items: { dragonfire_shield_fragment: 1 },
    },
  },
  {
    quest_id: "ernest_the_chicken",
    name: "Ernest the Chicken",
    description: "Recover odd machine parts from quest instances.",
    giver_npc_id: "veronica",
    turn_in_npc_id: "veronica",
    objectives: [
      {
        objective_id: "visit_quest_shard",
        description: "Visit Quest Instance",
        type: "visit_area",
        area_id: "quest_shard",
        count: 1,
      },
      {
        objective_id: "collect_pressure_gauge",
        description: "Collect 1 pressure_gauge",
        type: "collect_item",
        item_id: "pressure_gauge",
        qty: 1,
      },
    ],
    rewards: {
      xp: { crafting: 300 },
      items: { coins: 300 },
    },
  },
  {
    quest_id: "goblin_diplomacy",
    name: "Goblin Diplomacy",
    description: "Resolve conflict by delivering dyed armor.",
    giver_npc_id: "general_bentnoze",
    turn_in_npc_id: "general_bentnoze",
    objectives: [
      {
        objective_id: "collect_orange_dye",
        description: "Collect 1 orange_dye",
        type: "collect_item",
        item_id: "orange_dye",
        qty: 1,
      },
      {
        objective_id: "collect_blue_dye",
        description: "Collect 1 blue_dye",
        type: "collect_item",
        item_id: "blue_dye",
        qty: 1,
      },
    ],
    rewards: {
      xp: { crafting: 250 },
      items: { coins: 180 },
    },
  },
  {
    quest_id: "imp_catcher",
    name: "Imp Catcher",
    description: "Retrieve magical beads to help the wizard tower.",
    giver_npc_id: "wizard_mizgog",
    turn_in_npc_id: "wizard_mizgog",
    objectives: [
      {
        objective_id: "collect_black_bead",
        description: "Collect 1 black_bead",
        type: "collect_item",
        item_id: "black_bead",
        qty: 1,
      },
      {
        objective_id: "collect_white_bead",
        description: "Collect 1 white_bead",
        type: "collect_item",
        item_id: "white_bead",
        qty: 1,
      },
      {
        objective_id: "collect_red_bead",
        description: "Collect 1 red_bead",
        type: "collect_item",
        item_id: "red_bead",
        qty: 1,
      },
      {
        objective_id: "collect_yellow_bead",
        description: "Collect 1 yellow_bead",
        type: "collect_item",
        item_id: "yellow_bead",
        qty: 1,
      },
    ],
    rewards: {
      xp: { magic: 875 },
      items: { air_rune: 30, mind_rune: 30 },
    },
  },
  {
    quest_id: "the_knights_sword",
    name: "The Knight's Sword",
    description: "Smithing-focused quest to restore a lost blade.",
    giver_npc_id: "squire",
    turn_in_npc_id: "squire",
    objectives: [
      {
        objective_id: "reach_smithing",
        description: "Reach smithing level 20",
        type: "reach_skill",
        skill: "smithing",
        level: 20,
      },
      {
        objective_id: "collect_blurite_ore",
        description: "Collect 1 blurite_ore",
        type: "collect_item",
        item_id: "blurite_ore",
        qty: 1,
      },
    ],
    rewards: {
      xp: { smithing: 1274 },
      items: { coins: 500 },
    },
  },
  {
    quest_id: "pirates_treasure",
    name: "Pirate's Treasure",
    description: "Recover hidden treasure from dangerous routes.",
    giver_npc_id: "redbeard_frank",
    turn_in_npc_id: "redbeard_frank",
    objectives: [
      {
        objective_id: "visit_shadow_dungeon",
        description: "Visit Shadow Dungeon",
        type: "visit_area",
        area_id: "shadow_dungeon",
        count: 1,
      },
      {
        objective_id: "collect_treasure_key",
        description: "Collect 1 treasure_key",
        type: "collect_item",
        item_id: "treasure_key",
        qty: 1,
      },
    ],
    rewards: {
      xp: { attack: 200 },
      items: { coins: 450 },
    },
  },
  {
    quest_id: "prince_ali_rescue",
    name: "Prince Ali Rescue",
    description: "Secure disguises and coordinate a high-risk extraction.",
    giver_npc_id: "hassan",
    turn_in_npc_id: "hassan",
    objectives: [
      {
        objective_id: "collect_key_print",
        description: "Collect 1 key_print",
        type: "collect_item",
        item_id: "key_print",
        qty: 1,
      },
      {
        objective_id: "collect_disguise",
        description: "Collect 1 rescue_disguise",
        type: "collect_item",
        item_id: "rescue_disguise",
        qty: 1,
      },
    ],
    rewards: {
      xp: { crafting: 350 },
      items: { coins: 700 },
    },
  },
  {
    quest_id: "restless_ghost",
    name: "The Restless Ghost",
    description: "Recover a missing skull and lay a spirit to rest.",
    giver_npc_id: "father_aereck",
    turn_in_npc_id: "father_aereck",
    objectives: [
      {
        objective_id: "collect_ghost_skull",
        description: "Collect 1 ghost_skull",
        type: "collect_item",
        item_id: "ghost_skull",
        qty: 1,
      },
    ],
    rewards: {
      xp: { prayer: 1125 },
      items: { bone_shard: 5 },
    },
  },
  {
    quest_id: "romeo_and_juliet",
    name: "Romeo & Juliet",
    description: "Carry messages between key contacts across the world.",
    giver_npc_id: "romeo",
    turn_in_npc_id: "romeo",
    objectives: [
      {
        objective_id: "visit_varrock",
        description: "Visit Surface Kingdoms",
        type: "visit_area",
        area_id: "surface_main",
        count: 1,
      },
      {
        objective_id: "collect_message_seal",
        description: "Collect 1 message_seal",
        type: "collect_item",
        item_id: "message_seal",
        qty: 1,
      },
    ],
    rewards: {
      xp: { crafting: 400 },
      items: { coins: 500 },
    },
  },
  {
    quest_id: "rune_mysteries",
    name: "Rune Mysteries",
    description: "Begin runecrafting by delivering research notes.",
    giver_npc_id: "duke_horacio",
    turn_in_npc_id: "duke_horacio",
    objectives: [
      {
        objective_id: "visit_nexus",
        description: "Visit Runecraft Nexus",
        type: "visit_area",
        area_id: "runecraft_nexus",
        count: 1,
      },
      {
        objective_id: "collect_research_notes",
        description: "Collect 1 rune_research_notes",
        type: "collect_item",
        item_id: "rune_research_notes",
        qty: 1,
      },
    ],
    rewards: {
      xp: { runecrafting: 600, magic: 100 },
      items: { air_rune: 25, mind_rune: 15 },
    },
  },
  {
    quest_id: "sheep_shearer",
    name: "Sheep Shearer",
    description: "Collect and process wool for local farmers.",
    giver_npc_id: "fred_farmer",
    turn_in_npc_id: "fred_farmer",
    objectives: [
      {
        objective_id: "collect_wool",
        description: "Collect 20 wool",
        type: "collect_item",
        item_id: "wool",
        qty: 20,
      },
    ],
    rewards: {
      xp: { crafting: 150 },
      items: { coins: 150 },
    },
  },
  {
    quest_id: "shield_of_arrav",
    name: "Shield of Arrav",
    description: "Recover both halves of a legendary shield through trade.",
    giver_npc_id: "reldo",
    turn_in_npc_id: "reldo",
    objectives: [
      {
        objective_id: "collect_left_half",
        description: "Collect 1 arrav_shield_left",
        type: "collect_item",
        item_id: "arrav_shield_left",
        qty: 1,
      },
      {
        objective_id: "collect_right_half",
        description: "Collect 1 arrav_shield_right",
        type: "collect_item",
        item_id: "arrav_shield_right",
        qty: 1,
      },
    ],
    rewards: {
      xp: { attack: 300, defence: 300 },
      items: { coins: 600 },
    },
  },
  {
    quest_id: "vampire_slayer",
    name: "Vampire Slayer",
    description: "Hunt and defeat a deadly vampire.",
    giver_npc_id: "morgan",
    turn_in_npc_id: "morgan",
    objectives: [
      {
        objective_id: "win_vampire_duel",
        description: "Win 1 duel",
        type: "win_duel",
        count: 1,
      },
    ],
    rewards: {
      xp: { attack: 4825 },
      items: { coins: 500 },
    },
  },
  {
    quest_id: "witchs_potion",
    name: "Witch's Potion",
    description: "Collect ingredients for a ritual brew.",
    giver_npc_id: "hetty",
    turn_in_npc_id: "hetty",
    objectives: [
      {
        objective_id: "collect_eye_of_newt",
        description: "Collect 1 eye_of_newt",
        type: "collect_item",
        item_id: "eye_of_newt",
        qty: 1,
      },
      {
        objective_id: "collect_burnt_meat",
        description: "Collect 1 burnt_meat",
        type: "collect_item",
        item_id: "burnt_meat",
        qty: 1,
      },
      {
        objective_id: "collect_onion",
        description: "Collect 1 onion",
        type: "collect_item",
        item_id: "onion",
        qty: 1,
      },
    ],
    rewards: {
      xp: { magic: 325 },
      items: { coins: 200 },
    },
  },
];

const QUEST_BY_ID = new Map(QUESTS.map((quest) => [quest.quest_id, quest]));

const questRuntimeByAgent = new Map<string, AgentQuestRuntime>();

function getOrCreateAgentQuestRuntime(agentId: string): AgentQuestRuntime {
  const existing = questRuntimeByAgent.get(agentId);
  if (existing) return existing;

  const quests: Record<string, QuestRuntime> = {};
  for (const quest of QUESTS) {
    quests[quest.quest_id] = {
      status: "not_started",
      objective_index: 0,
      reward_claimed: false,
      started_at: null,
      completed_at: null,
    };
  }

  const created: AgentQuestRuntime = {
    quests,
    visited_areas: {},
    spells_cast: {},
    duel_wins: 0,
  };
  questRuntimeByAgent.set(agentId, created);
  return created;
}

function getRuntimeQuestStatus(agentId: string, questId: string): QuestRuntime {
  const runtime = getOrCreateAgentQuestRuntime(agentId);
  return runtime.quests[questId];
}

export function recordAreaVisit(agentId: string, areaId: string): void {
  const runtime = getOrCreateAgentQuestRuntime(agentId);
  runtime.visited_areas[areaId] = (runtime.visited_areas[areaId] ?? 0) + 1;
}

export function recordSpellCast(agentId: string, spell: SpellName): void {
  const runtime = getOrCreateAgentQuestRuntime(agentId);
  runtime.spells_cast[spell] = (runtime.spells_cast[spell] ?? 0) + 1;
}

export function recordDuelWin(agentId: string): void {
  const runtime = getOrCreateAgentQuestRuntime(agentId);
  runtime.duel_wins += 1;
}

function getObjectiveProgress(
  agentId: string,
  objective: QuestObjective,
  progress: AgentProgress,
  world: WorldAgent | null
): { current: number; target: number } {
  const runtime = getOrCreateAgentQuestRuntime(agentId);
  if (objective.type === "collect_item") {
    return {
      current: getInventoryQty(progress, objective.item_id),
      target: objective.qty,
    };
  }

  if (objective.type === "reach_skill") {
    return {
      current: getSkillLevel(progress, objective.skill),
      target: objective.level,
    };
  }

  if (objective.type === "visit_area") {
    const areaVisits = runtime.visited_areas[objective.area_id] ?? 0;
    const worldBonus = world && world.area_id === objective.area_id ? 1 : 0;
    return {
      current: areaVisits + worldBonus,
      target: objective.count,
    };
  }

  if (objective.type === "cast_spell") {
    return {
      current: runtime.spells_cast[objective.spell] ?? 0,
      target: objective.count,
    };
  }

  return {
    current: runtime.duel_wins,
    target: objective.count,
  };
}

export function startQuest(agentId: string, questId: string): QuestUpdateEvent[] {
  const runtime = getRuntimeQuestStatus(agentId, questId);
  if (!runtime || runtime.status !== "not_started") return [];
  runtime.status = "in_progress";
  runtime.objective_index = 0;
  runtime.started_at = Date.now();
  runtime.completed_at = null;
  runtime.reward_claimed = false;
  return [{ quest_id: questId, kind: "started", objective_index: 0 }];
}

export function evaluateQuestProgress(
  agentId: string,
  progress: AgentProgress,
  world: WorldAgent | null
): QuestUpdateEvent[] {
  if (world?.area_id) {
    recordAreaVisit(agentId, world.area_id);
  }

  const updates: QuestUpdateEvent[] = [];
  const runtime = getOrCreateAgentQuestRuntime(agentId);

  for (const quest of QUESTS) {
    const runtimeQuest = runtime.quests[quest.quest_id];
    if (!runtimeQuest || runtimeQuest.status !== "in_progress") continue;

    while (runtimeQuest.objective_index < quest.objectives.length) {
      const objective = quest.objectives[runtimeQuest.objective_index];
      if (!objective) break;
      const { current, target } = getObjectiveProgress(agentId, objective, progress, world);
      if (current < target) break;
      runtimeQuest.objective_index += 1;
      updates.push({
        quest_id: quest.quest_id,
        kind: "advanced",
        objective_index: runtimeQuest.objective_index,
      });
    }

    if (runtimeQuest.objective_index >= quest.objectives.length) {
      runtimeQuest.status = "completed";
      runtimeQuest.completed_at = Date.now();
      updates.push({ quest_id: quest.quest_id, kind: "completed" });
    }
  }

  return updates;
}

export function claimQuestReward(
  agentId: string,
  questId: string,
  progress: AgentProgress
): QuestRewardResult | null {
  const quest = QUEST_BY_ID.get(questId);
  if (!quest) return null;
  const runtimeQuest = getRuntimeQuestStatus(agentId, questId);
  if (!runtimeQuest || runtimeQuest.status !== "completed" || runtimeQuest.reward_claimed) return null;

  const xp_gains: XpGain[] = [];
  for (const [skill, xp] of Object.entries(quest.rewards.xp) as Array<[SkillName, number]>) {
    xp_gains.push(addXp(progress, skill, xp));
  }

  const item_rewards: Record<string, number> = {};
  for (const [itemId, qty] of Object.entries(quest.rewards.items)) {
    const finalQty = addInventory(progress, itemId, qty);
    item_rewards[itemId] = finalQty;
  }

  runtimeQuest.reward_claimed = true;

  return {
    quest_id: questId,
    xp_gains,
    item_rewards,
  };
}

export function getQuestLog(agentId: string, progress: AgentProgress, world: WorldAgent | null): QuestView[] {
  const runtime = getOrCreateAgentQuestRuntime(agentId);
  return QUESTS.map((quest) => {
    const runtimeQuest = runtime.quests[quest.quest_id];
    const objectives = quest.objectives.map((objective) => {
      const status = getObjectiveProgress(agentId, objective, progress, world);
      return {
        objective_id: objective.objective_id,
        description: objective.description,
        current: status.current,
        target: status.target,
        complete: status.current >= status.target,
      };
    });

    return {
      quest_id: quest.quest_id,
      name: quest.name,
      description: quest.description,
      giver_npc_id: quest.giver_npc_id,
      turn_in_npc_id: quest.turn_in_npc_id,
      status: runtimeQuest.status,
      reward_claimed: runtimeQuest.reward_claimed,
      started_at: runtimeQuest.started_at,
      completed_at: runtimeQuest.completed_at,
      active_objective_index: Math.min(runtimeQuest.objective_index, objectives.length),
      objectives,
    };
  });
}

function resolveQuestNpcRoot(agentId: string, questId: string): string {
  const runtimeQuest = getRuntimeQuestStatus(agentId, questId);
  if (!runtimeQuest) return "offer";
  if (runtimeQuest.status === "not_started") return "offer";
  if (runtimeQuest.status === "in_progress") return "in_progress";
  if (runtimeQuest.status === "completed" && !runtimeQuest.reward_claimed) return "turn_in";
  return "completed";
}

const DIALOGUE_TREES: Record<string, DialogueTree> = {
  guide: {
    npc_id: "guide",
    root: () => "start",
    nodes: {
      start: {
        node_id: "start",
        speaker: "Gielinor Guide",
        text: "Welcome adventurer. Train F2P skills, use portals for short travel, and progress through the full 2007 quest roster.",
        choices: [
          { choice_id: "quests", text: "How do I track quests?", next_node_id: "quests_help" },
          { choice_id: "travel", text: "How do I travel quickly?", next_node_id: "travel_help" },
          { choice_id: "close", text: "Thanks.", action: { type: "close" } },
        ],
      },
      quests_help: {
        node_id: "quests_help",
        speaker: "Gielinor Guide",
        text: "Start quests by speaking to quest NPCs, then use /quests or the quest panel to track objectives and rewards.",
        choices: [
          { choice_id: "back", text: "Back", next_node_id: "start" },
          { choice_id: "close", text: "Done", action: { type: "close" } },
        ],
      },
      travel_help: {
        node_id: "travel_help",
        speaker: "Gielinor Guide",
        text: "Portal routing keeps travel under two hops for core areas. Spells and atlas overlays reduce backtracking.",
        choices: [
          { choice_id: "back", text: "Back", next_node_id: "start" },
          { choice_id: "close", text: "Done", action: { type: "close" } },
        ],
      },
    },
  },
};

for (const quest of QUESTS) {
  const baseNodes: Record<string, DialogueNode> = {
    offer: {
      node_id: "offer",
      speaker: quest.name,
      text: `${quest.description} Accept this quest now?`,
      choices: [
        { choice_id: "accept", text: "Accept quest", action: { type: "start_quest", quest_id: quest.quest_id }, next_node_id: "accepted" },
        { choice_id: "decline", text: "Maybe later", action: { type: "close" } },
      ],
    },
    accepted: {
      node_id: "accepted",
      speaker: quest.name,
      text: "Quest accepted. Return once objectives are complete.",
      choices: [{ choice_id: "close", text: "On it", action: { type: "close" } }],
    },
    in_progress: {
      node_id: "in_progress",
      speaker: quest.name,
      text: "You still have objectives left to complete.",
      choices: [{ choice_id: "close", text: "Continuing", action: { type: "close" } }],
    },
    turn_in: {
      node_id: "turn_in",
      speaker: quest.name,
      text: "Objectives complete. Claim your reward now?",
      choices: [
        { choice_id: "claim", text: "Claim reward", action: { type: "claim_reward", quest_id: quest.quest_id }, next_node_id: "completed" },
        { choice_id: "wait", text: "Later", action: { type: "close" } },
      ],
    },
    completed: {
      node_id: "completed",
      speaker: quest.name,
      text: "Quest complete. Well done.",
      choices: [{ choice_id: "close", text: "Done", action: { type: "close" } }],
    },
  };

  DIALOGUE_TREES[quest.giver_npc_id] = {
    npc_id: quest.giver_npc_id,
    root: (agentId) => resolveQuestNpcRoot(agentId, quest.quest_id),
    nodes: baseNodes,
  };

  if (!DIALOGUE_TREES[quest.turn_in_npc_id]) {
    DIALOGUE_TREES[quest.turn_in_npc_id] = {
      npc_id: quest.turn_in_npc_id,
      root: (agentId) => resolveQuestNpcRoot(agentId, quest.quest_id),
      nodes: baseNodes,
    };
  }
}

function toDialogueNodeView(npcId: string, node: DialogueNode): DialogueNodeView {
  return {
    npc_id: npcId,
    node_id: node.node_id,
    speaker: node.speaker,
    text: node.text,
    choices: node.choices.map((choice) => ({
      choice_id: choice.choice_id,
      text: choice.text,
    })),
  };
}

export function startDialogue(agentId: string, npcId: string): DialogueNodeView | null {
  const tree = DIALOGUE_TREES[npcId];
  if (!tree) return null;
  const rootId = tree.root(agentId);
  const node = tree.nodes[rootId];
  if (!node) return null;
  return toDialogueNodeView(npcId, node);
}

export function chooseDialogue(
  agentId: string,
  npcId: string,
  nodeId: string,
  choiceId: string,
  progress: AgentProgress,
  world: WorldAgent | null
): DialogueResult | null {
  const tree = DIALOGUE_TREES[npcId];
  if (!tree) return null;
  const node = tree.nodes[nodeId];
  if (!node) return null;
  const choice = node.choices.find((candidate) => candidate.choice_id === choiceId);
  if (!choice) return null;

  const quest_updates: QuestUpdateEvent[] = [];
  let reward: QuestRewardResult | null = null;

  if (choice.action?.type === "start_quest") {
    quest_updates.push(...startQuest(agentId, choice.action.quest_id));
  }

  if (choice.action?.type === "claim_reward") {
    reward = claimQuestReward(agentId, choice.action.quest_id, progress);
    if (reward) {
      quest_updates.push({ quest_id: choice.action.quest_id, kind: "reward_claimed" });
    }
  }

  quest_updates.push(...evaluateQuestProgress(agentId, progress, world));

  if (choice.action?.type === "close") {
    return {
      closed: true,
      node: null,
      quest_updates,
      reward,
    };
  }

  if (choice.next_node_id) {
    const next = tree.nodes[choice.next_node_id];
    if (next) {
      return {
        closed: false,
        node: toDialogueNodeView(npcId, next),
        quest_updates,
        reward,
      };
    }
  }

  const fallback = tree.nodes[tree.root(agentId)];
  return {
    closed: false,
    node: fallback ? toDialogueNodeView(npcId, fallback) : null,
    quest_updates,
    reward,
  };
}
