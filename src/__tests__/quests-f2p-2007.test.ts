import { describe, expect, it } from "bun:test";
import { createDefaultProgress } from "../progression";
import { getQuestLog, startDialogue, startQuest } from "../quests";

const F2P_QUEST_IDS = [
  "black_knights_fortress",
  "cooks_assistant",
  "demon_slayer",
  "dorics_quest",
  "dragon_slayer",
  "ernest_the_chicken",
  "goblin_diplomacy",
  "imp_catcher",
  "the_knights_sword",
  "pirates_treasure",
  "prince_ali_rescue",
  "restless_ghost",
  "romeo_and_juliet",
  "rune_mysteries",
  "sheep_shearer",
  "shield_of_arrav",
  "vampire_slayer",
  "witchs_potion",
] as const;

const F2P_GIVER_NPCS = [
  "sir_amik",
  "cook",
  "gypsy_aris",
  "doric",
  "ozyach",
  "veronica",
  "general_bentnoze",
  "wizard_mizgog",
  "squire",
  "redbeard_frank",
  "hassan",
  "father_aereck",
  "romeo",
  "duke_horacio",
  "fred_farmer",
  "reldo",
  "morgan",
  "hetty",
] as const;

describe("2007 f2p quest canon", () => {
  it("contains the full 18-quest roster", () => {
    const progress = createDefaultProgress("QuestMatrix");
    const log = getQuestLog("QuestMatrix", progress, null);
    const ids = new Set(log.map((quest) => quest.quest_id));

    expect(log.length).toBe(18);
    for (const questId of F2P_QUEST_IDS) {
      expect(ids.has(questId)).toBe(true);
    }
  });

  it("supports dialogue offers for every quest giver", () => {
    for (const npcId of F2P_GIVER_NPCS) {
      const node = startDialogue("QuestDialogue", npcId);
      expect(node).not.toBeNull();
      expect(node?.node_id).toBe("offer");
    }
  });

  it("starts each quest via quest state machine", () => {
    for (const questId of F2P_QUEST_IDS) {
      const updates = startQuest(`QuestStarter_${questId}`, questId);
      expect(updates.length).toBe(1);
      expect(updates[0]?.kind).toBe("started");
      expect(updates[0]?.quest_id).toBe(questId);
    }
  });
});
