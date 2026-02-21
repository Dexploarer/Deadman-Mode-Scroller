import { beforeEach, describe, expect, it } from "bun:test";
import api from "../routes";
import {
  accounts,
  agentProgress,
  agents,
  characters,
  getOrCreateProgress,
  sessions,
  walletChallenges,
} from "../store";

async function postJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await api.request(path, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  });
  return {
    status: res.status,
    ok: res.ok,
    data: await res.json(),
  };
}

async function getJson(path: string, headers: Record<string, string> = {}) {
  const res = await api.request(path, { headers });
  return {
    status: res.status,
    ok: res.ok,
    data: await res.json(),
  };
}

async function authCharacter(wallet: string, name: string, combatClass: "melee" | "ranged" | "magic" = "melee") {
  const challenge = await postJson("/auth/wallet/challenge", { wallet_address: wallet });
  expect(challenge.ok).toBe(true);

  const verify = await postJson("/auth/wallet/verify", {
    wallet_address: wallet,
    nonce: challenge.data.nonce,
    signature: `signed:${challenge.data.nonce}`,
    character_name: name,
    combat_class: combatClass,
  });
  expect(verify.ok).toBe(true);

  return {
    token: verify.data.session_token as string,
    characterId: verify.data.character.character_id as string,
    name,
  };
}

beforeEach(() => {
  accounts.clear();
  agents.clear();
  characters.clear();
  sessions.clear();
  walletChallenges.clear();
  agentProgress.clear();
});

describe("leaderboards", () => {
  it("orders pvp rows by elo/wins and handles deterministic ties", async () => {
    const alpha = await authCharacter("0xa110000000000000000000000000000000000001", "Alpha", "melee");
    const beta = await authCharacter("0xb220000000000000000000000000000000000002", "Beta", "ranged");
    const gamma = await authCharacter("0xc330000000000000000000000000000000000003", "Gamma", "magic");

    const agentAlpha = agents.get(alpha.characterId);
    const agentBeta = agents.get(beta.characterId);
    const agentGamma = agents.get(gamma.characterId);

    if (agentAlpha) {
      agentAlpha.elo = 1400;
      agentAlpha.wins = 20;
      agentAlpha.losses = 5;
      agents.set(alpha.characterId, agentAlpha);
    }
    if (agentBeta) {
      agentBeta.elo = 1400;
      agentBeta.wins = 20;
      agentBeta.losses = 10;
      agents.set(beta.characterId, agentBeta);
    }
    if (agentGamma) {
      agentGamma.elo = 1100;
      agentGamma.wins = 10;
      agentGamma.losses = 10;
      agents.set(gamma.characterId, agentGamma);
    }

    const pvp = await getJson("/leaderboards/pvp?limit=10&offset=0");
    expect(pvp.ok).toBe(true);
    expect(pvp.data.length).toBeGreaterThanOrEqual(3);
    expect(pvp.data[0].character_name).toBe("Alpha");
    expect(pvp.data[1].character_name).toBe("Beta");
    expect(pvp.data[0].rank).toBe(1);
    expect(pvp.data[1].rank).toBe(2);
  });

  it("supports skills leaderboard for overall and per-skill queries", async () => {
    const miner = await authCharacter("0xd440000000000000000000000000000000000004", "Miner", "melee");
    const mage = await authCharacter("0xe550000000000000000000000000000000000005", "Mage", "magic");

    const minerProgress = getOrCreateProgress(miner.characterId);
    minerProgress.skills.mining = { level: 45, xp: 61_000 };
    minerProgress.skills.magic = { level: 20, xp: 5_000 };

    const mageProgress = getOrCreateProgress(mage.characterId);
    mageProgress.skills.magic = { level: 62, xp: 280_000 };
    mageProgress.skills.mining = { level: 8, xp: 400 };

    const overall = await getJson("/leaderboards/skills?metric=xp&limit=10&offset=0");
    expect(overall.ok).toBe(true);
    expect(overall.data[0].character_name).toBe("Mage");
    expect(overall.data[0].skill).toBe("overall");

    const magicOnly = await getJson("/leaderboards/skills?skill=magic&metric=level&limit=10&offset=0");
    expect(magicOnly.ok).toBe(true);
    expect(magicOnly.data[0].character_name).toBe("Mage");
    expect(magicOnly.data[0].skill).toBe("magic");
    expect(magicOnly.data[0].level).toBe(62);
  });

  it("orders quest completion rows and resolves ties deterministically", async () => {
    const top = await authCharacter("0xf660000000000000000000000000000000000006", "QuestTop", "melee");
    await authCharacter("0x1770000000000000000000000000000000000007", "TieAlpha", "melee");
    await authCharacter("0x1880000000000000000000000000000000000008", "TieBeta", "melee");

    const topProgress = getOrCreateProgress(top.characterId);
    topProgress.inventory.pot_of_flour = 1;
    topProgress.inventory.egg = 1;
    topProgress.inventory.bucket_of_milk = 1;

    const startQuest = await postJson(
      "/quests/start",
      { quest_id: "cooks_assistant" },
      { authorization: `Bearer ${top.token}` }
    );
    expect(startQuest.ok).toBe(true);

    const advanceQuest = await postJson(
      "/quests/advance",
      { quest_id: "cooks_assistant" },
      { authorization: `Bearer ${top.token}` }
    );
    expect(advanceQuest.ok).toBe(true);

    const quests = await getJson("/leaderboards/quests?limit=10&offset=0");
    expect(quests.ok).toBe(true);
    expect(quests.data[0].character_name).toBe("QuestTop");
    expect(quests.data[0].completed_count).toBeGreaterThanOrEqual(1);

    const tieRows = quests.data.filter((row: { completed_count: number }) => row.completed_count === 0);
    expect(tieRows[0].character_name).toBe("TieAlpha");
    expect(tieRows[1].character_name).toBe("TieBeta");
  });
});
