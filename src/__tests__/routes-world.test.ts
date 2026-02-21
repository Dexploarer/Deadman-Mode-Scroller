import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import api from "../routes";
import {
  accounts,
  activeSkillJobs,
  agentProfiles,
  agentProgress,
  agents,
  banks,
  characters,
  challenges,
  createCharacter,
  createSession,
  createOrGetAccount,
  duelQueue,
  duelQueueFallbackTimers,
  fights,
  fightSubscribers,
  fightTickTimers,
  getOrCreateProgress,
  marketOrders,
  nodeRespawnTimers,
  resourceNodes,
  selectedModes,
  sessions,
  tradeOffers,
  walletChallenges,
  worldAgents,
  worldSubscribers,
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
  accounts.clear();
  characters.clear();
  sessions.clear();
  banks.clear();
  tradeOffers.clear();
  marketOrders.clear();
  selectedModes.clear();
  walletChallenges.clear();
  agentProfiles.clear();
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

  it("lists pending challenges and supports decline plus accept transitions", async () => {
    const regA = await postJson("/arena/register", {
      agent_id: "ChallengeA",
      combat_class: "melee",
      prayer_book: "normal",
    });
    const regB = await postJson("/arena/register", {
      agent_id: "ChallengeB",
      combat_class: "ranged",
      prayer_book: "normal",
    });
    expect(regA.ok).toBe(true);
    expect(regB.ok).toBe(true);

    const challenge = await postJson("/arena/challenge", {
      agent_id: "ChallengeA",
      target_agent_id: "ChallengeB",
      arena: "duel_arena",
    });
    expect(challenge.ok).toBe(true);

    const pendingForTarget = await getJson("/arena/challenges/ChallengeB");
    expect(pendingForTarget.ok).toBe(true);
    expect(Array.isArray(pendingForTarget.data)).toBe(true);
    expect(pendingForTarget.data.length).toBe(1);
    expect(pendingForTarget.data[0].challenge_id).toBe(challenge.data.challenge.challenge_id);
    expect(pendingForTarget.data[0].status).toBe("pending");

    const declineWrongAgent = await postJson("/arena/decline", {
      agent_id: "ChallengeA",
      challenge_id: challenge.data.challenge.challenge_id,
    });
    expect(declineWrongAgent.ok).toBe(false);
    expect(declineWrongAgent.status).toBe(403);

    const decline = await postJson("/arena/decline", {
      agent_id: "ChallengeB",
      challenge_id: challenge.data.challenge.challenge_id,
    });
    expect(decline.ok).toBe(true);
    expect(decline.data.status).toBe("challenge_declined");
    expect(challenges.get(challenge.data.challenge.challenge_id)?.status).toBe("declined");

    const pendingAfterDecline = await getJson("/arena/challenges/ChallengeB");
    expect(pendingAfterDecline.ok).toBe(true);
    expect(pendingAfterDecline.data.length).toBe(0);

    const challenge2 = await postJson("/arena/challenge", {
      agent_id: "ChallengeA",
      target_agent_id: "ChallengeB",
      arena: "duel_arena",
    });
    expect(challenge2.ok).toBe(true);

    const accept = await postJson("/arena/accept", {
      agent_id: "ChallengeB",
      challenge_id: challenge2.data.challenge.challenge_id,
    });
    expect(accept.ok).toBe(true);
    expect(accept.data.status).toBe("fight_started");

    const pendingAfterAccept = await getJson("/arena/challenges/ChallengeB");
    expect(pendingAfterAccept.ok).toBe(true);
    expect(pendingAfterAccept.data.length).toBe(0);
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

  it("teleports to personal instances for shard-only spells", async () => {
    const reg = await postJson("/arena/register", {
      agent_id: "MageQuest",
      combat_class: "magic",
      prayer_book: "normal",
    });
    expect(reg.ok).toBe(true);

    const progress = getOrCreateProgress("MageQuest");
    progress.skills.magic = { level: 70, xp: 900_000 };
    progress.inventory.law_rune = 5;
    progress.inventory.nature_rune = 5;
    progress.inventory.air_rune = 20;
    selectedModes.set("MageQuest", "seasonal");

    const cast = await postJson("/world/spell/cast", {
      agent_id: "MageQuest",
      spell: "teleport_quest_shard",
    });

    expect(cast.ok).toBe(true);
    expect(cast.data.status).toBe("teleported");
    expect(cast.data.scope).toBe("personal");
    expect(cast.data.world.area_id).toBe("quest_shard");
    expect(cast.data.world.instance_id).toBe("MageQuest:quest_shard");
  });

  it("returns atlas metadata for visualization overlays", async () => {
    const atlasRes = await api.request("/world/atlas");
    expect(atlasRes.ok).toBe(true);
    const atlas = await atlasRes.json();

    expect(atlas.total_portals).toBeGreaterThan(0);
    expect(atlas.total_nodes).toBeGreaterThan(0);
    expect(atlas.skills).toContain("agility");
    expect(atlas.skills).toContain("construction");
    expect(atlas.areas.some((area: { area_id: string }) => area.area_id === "skills_guild")).toBe(true);
  });

  it("supports dialogue trees, quest progression, and reward claiming", async () => {
    const reg = await postJson("/arena/register", {
      agent_id: "QuestA",
      combat_class: "magic",
      prayer_book: "normal",
    });
    expect(reg.ok).toBe(true);

    const start = await postJson("/world/dialogue/start", {
      agent_id: "QuestA",
      npc_id: "cook",
    });
    expect(start.ok).toBe(true);
    expect(start.data.node.node_id).toBe("offer");

    const accept = await postJson("/world/dialogue/choose", {
      agent_id: "QuestA",
      npc_id: "cook",
      node_id: start.data.node.node_id,
      choice_id: "accept",
    });
    expect(accept.ok).toBe(true);

    const activeRes = await api.request("/world/quests/QuestA");
    expect(activeRes.ok).toBe(true);
    const activeData = await activeRes.json();
    const activeQuest = activeData.quests.find((quest: { quest_id: string }) => quest.quest_id === "cooks_assistant");
    expect(activeQuest?.status).toBe("in_progress");

    const progress = getOrCreateProgress("QuestA");
    progress.inventory.pot_of_flour = 1;
    progress.inventory.egg = 1;
    progress.inventory.bucket_of_milk = 1;
    const cookingXpBeforeReward = progress.skills.cooking.xp;

    const completeRes = await api.request("/world/quests/QuestA");
    expect(completeRes.ok).toBe(true);
    const completeData = await completeRes.json();
    const completeQuest = completeData.quests.find((quest: { quest_id: string }) => quest.quest_id === "cooks_assistant");
    expect(completeQuest?.status).toBe("completed");
    expect(completeQuest?.reward_claimed).toBe(false);

    const turnIn = await postJson("/world/dialogue/start", {
      agent_id: "QuestA",
      npc_id: "cook",
    });
    expect(turnIn.ok).toBe(true);
    expect(turnIn.data.node.node_id).toBe("turn_in");

    const claim = await postJson("/world/dialogue/choose", {
      agent_id: "QuestA",
      npc_id: "cook",
      node_id: "turn_in",
      choice_id: "claim",
    });
    expect(claim.ok).toBe(true);
    expect(claim.data.reward.quest_id).toBe("cooks_assistant");
    expect(claim.data.inventory.coins).toBeGreaterThanOrEqual(200);
    expect(claim.data.skills.cooking.xp).toBeGreaterThan(cookingXpBeforeReward);

    const finalRes = await api.request("/world/quests/QuestA");
    expect(finalRes.ok).toBe(true);
    const finalData = await finalRes.json();
    const finalQuest = finalData.quests.find((quest: { quest_id: string }) => quest.quest_id === "cooks_assistant");
    expect(finalQuest?.reward_claimed).toBe(true);
  });

  it("supports wallet auth challenge/verify and character session lookups", async () => {
    const challenge = await postJson("/auth/wallet/challenge", {
      wallet_address: "0xabc0000000000000000000000000000000000001",
    });
    expect(challenge.ok).toBe(true);
    expect(typeof challenge.data.nonce).toBe("string");

    const verify = await postJson("/auth/wallet/verify", {
      wallet_address: "0xabc0000000000000000000000000000000000001",
      nonce: challenge.data.nonce,
      signature: `signed:${challenge.data.nonce}`,
      character_name: "WalletHero",
      combat_class: "magic",
    });
    expect(verify.ok).toBe(true);
    expect(typeof verify.data.session_token).toBe("string");
    expect(verify.data.character.mode).toBe("f2p_2007");

    const me = await getJson("/character/me", {
      authorization: `Bearer ${verify.data.session_token}`,
    });
    expect(me.ok).toBe(true);
    expect(me.data.selected_character.name).toBe("WalletHero");
  });

  it("handles bank deposit/withdraw, trading, and ge order matching", async () => {
    const challengeA = await postJson("/auth/wallet/challenge", {
      wallet_address: "0xaaa0000000000000000000000000000000000001",
    });
    const challengeB = await postJson("/auth/wallet/challenge", {
      wallet_address: "0xbbb0000000000000000000000000000000000002",
    });

    const verifyA = await postJson("/auth/wallet/verify", {
      wallet_address: "0xaaa0000000000000000000000000000000000001",
      nonce: challengeA.data.nonce,
      signature: `signed:${challengeA.data.nonce}`,
      character_name: "TraderA",
      combat_class: "melee",
    });
    const verifyB = await postJson("/auth/wallet/verify", {
      wallet_address: "0xbbb0000000000000000000000000000000000002",
      nonce: challengeB.data.nonce,
      signature: `signed:${challengeB.data.nonce}`,
      character_name: "TraderB",
      combat_class: "ranged",
    });

    expect(verifyA.ok).toBe(true);
    expect(verifyB.ok).toBe(true);

    const characterA = verifyA.data.character.character_id as string;
    const characterB = verifyB.data.character.character_id as string;
    const tokenA = verifyA.data.session_token as string;
    const tokenB = verifyB.data.session_token as string;

    const progressA = getOrCreateProgress(characterA);
    const progressB = getOrCreateProgress(characterB);
    progressA.inventory.coins = 1000;
    progressA.inventory.logs = 5;
    progressB.inventory.raw_shrimp = 8;
    progressB.inventory.coins = 2000;

    const deposit = await postJson("/economy/bank/deposit", { item_id: "coins", qty: 40 }, {
      authorization: `Bearer ${tokenA}`,
    });
    expect(deposit.ok).toBe(true);
    expect(deposit.data.bank.coins).toBe(40);

    const withdraw = await postJson("/economy/bank/withdraw", { item_id: "coins", qty: 10 }, {
      authorization: `Bearer ${tokenA}`,
    });
    expect(withdraw.ok).toBe(true);
    expect(withdraw.data.bank.coins).toBe(30);

    const tradeRequest = await postJson(
      "/economy/trade/request",
      {
        to_character_id: characterB,
        offered_items: { logs: 2 },
        requested_items: { raw_shrimp: 3 },
      },
      { authorization: `Bearer ${tokenA}` }
    );
    expect(tradeRequest.ok).toBe(true);

    const pendingBeforeRespond = await getJson("/economy/trade/pending", {
      authorization: `Bearer ${tokenB}`,
    });
    expect(pendingBeforeRespond.ok).toBe(true);
    expect(
      pendingBeforeRespond.data.incoming.some(
        (offer: { trade_id: string; status: string }) =>
          offer.trade_id === tradeRequest.data.trade.trade_id && offer.status === "pending"
      )
    ).toBe(true);

    const tradeRespond = await postJson(
      "/economy/trade/respond",
      { trade_id: tradeRequest.data.trade.trade_id, decision: "accept" },
      { authorization: `Bearer ${tokenB}` }
    );
    expect(tradeRespond.ok).toBe(true);

    const tradeConfirm = await postJson(
      "/economy/trade/confirm",
      { trade_id: tradeRequest.data.trade.trade_id },
      { authorization: `Bearer ${tokenA}` }
    );
    expect(tradeConfirm.ok).toBe(true);
    expect(getOrCreateProgress(characterA).inventory.raw_shrimp).toBe(3);
    expect(getOrCreateProgress(characterB).inventory.logs).toBe(2);

    const sellOrder = await postJson(
      "/economy/ge/order",
      { item_id: "logs", side: "sell", qty: 2, price_each: 50 },
      { authorization: `Bearer ${tokenB}` }
    );
    expect(sellOrder.ok).toBe(true);

    const myOrdersAfterSell = await getJson("/economy/ge/my", {
      authorization: `Bearer ${tokenB}`,
    });
    expect(myOrdersAfterSell.ok).toBe(true);
    expect(
      myOrdersAfterSell.data.orders.some(
        (order: { order_id: string }) => order.order_id === sellOrder.data.order.order_id
      )
    ).toBe(true);

    const buyOrder = await postJson(
      "/economy/ge/order",
      { item_id: "logs", side: "buy", qty: 2, price_each: 50 },
      { authorization: `Bearer ${tokenA}` }
    );
    expect(buyOrder.ok).toBe(true);

    const book = await getJson("/economy/ge/book/logs");
    expect(book.ok).toBe(true);
    expect(Array.isArray(book.data.buys)).toBe(true);
    expect(Array.isArray(book.data.sells)).toBe(true);
  });

  it("creates/selects characters with slot limits, duplicate checks, and token rotation", async () => {
    const challenge = await postJson("/auth/wallet/challenge", {
      wallet_address: "0xccc0000000000000000000000000000000000003",
    });
    expect(challenge.ok).toBe(true);

    const verify = await postJson("/auth/wallet/verify", {
      wallet_address: "0xccc0000000000000000000000000000000000003",
      nonce: challenge.data.nonce,
      signature: `signed:${challenge.data.nonce}`,
      character_name: "MainOne",
      combat_class: "melee",
    });
    expect(verify.ok).toBe(true);
    const originalToken = verify.data.session_token as string;

    const createSecond = await postJson(
      "/character/create",
      { name: "SecondOne", combat_class: "magic", select: true },
      { authorization: `Bearer ${originalToken}` }
    );
    expect(createSecond.ok).toBe(true);
    expect(createSecond.data.status).toBe("character_created");
    expect(typeof createSecond.data.session_token).toBe("string");
    expect(createSecond.data.session_token).not.toBe(originalToken);

    const duplicate = await postJson(
      "/character/create",
      { name: "SecondOne", combat_class: "ranged" },
      { authorization: `Bearer ${createSecond.data.session_token}` }
    );
    expect(duplicate.ok).toBe(false);
    expect(duplicate.status).toBe(400);

    const createThird = await postJson(
      "/character/create",
      { name: "ThirdOne", combat_class: "ranged" },
      { authorization: `Bearer ${createSecond.data.session_token}` }
    );
    expect(createThird.ok).toBe(true);

    const createFourth = await postJson(
      "/character/create",
      { name: "FourthOne", combat_class: "ranged" },
      { authorization: `Bearer ${createSecond.data.session_token}` }
    );
    expect(createFourth.ok).toBe(false);
    expect(createFourth.status).toBe(400);
    expect(String(createFourth.data.error || "")).toContain("slot limit");

    const me = await getJson("/character/me", {
      authorization: `Bearer ${createSecond.data.session_token}`,
    });
    expect(me.ok).toBe(true);
    expect(me.data.selected_character.name).toBe("SecondOne");
    expect(me.data.characters.length).toBe(3);
  });

  it("keeps arena leaderboard alias backward-compatible with pvp leaderboard shape", async () => {
    const challengeA = await postJson("/auth/wallet/challenge", {
      wallet_address: "0xddd0000000000000000000000000000000000004",
    });
    const challengeB = await postJson("/auth/wallet/challenge", {
      wallet_address: "0xeee0000000000000000000000000000000000005",
    });
    const verifyA = await postJson("/auth/wallet/verify", {
      wallet_address: "0xddd0000000000000000000000000000000000004",
      nonce: challengeA.data.nonce,
      signature: `signed:${challengeA.data.nonce}`,
      character_name: "AliasA",
      combat_class: "melee",
    });
    const verifyB = await postJson("/auth/wallet/verify", {
      wallet_address: "0xeee0000000000000000000000000000000000005",
      nonce: challengeB.data.nonce,
      signature: `signed:${challengeB.data.nonce}`,
      character_name: "AliasB",
      combat_class: "ranged",
    });
    expect(verifyA.ok).toBe(true);
    expect(verifyB.ok).toBe(true);

    const agentA = agents.get(verifyA.data.character.character_id as string);
    const agentB = agents.get(verifyB.data.character.character_id as string);
    if (agentA) {
      agentA.elo = 1325;
      agentA.wins = 15;
      agentA.losses = 4;
      agents.set(agentA.agent_id, agentA);
    }
    if (agentB) {
      agentB.elo = 1180;
      agentB.wins = 9;
      agentB.losses = 7;
      agents.set(agentB.agent_id, agentB);
    }

    const canonical = await getJson("/leaderboards/pvp?limit=10&offset=0");
    const alias = await getJson("/arena/leaderboard?limit=10&offset=0");
    expect(canonical.ok).toBe(true);
    expect(alias.ok).toBe(true);
    expect(Array.isArray(canonical.data)).toBe(true);
    expect(Array.isArray(alias.data)).toBe(true);
    expect(alias.data.length).toBe(canonical.data.length);
    expect(alias.data[0].agent_id).toBe(canonical.data[0].character_id);
    expect(alias.data[0].elo).toBe(canonical.data[0].elo);
    expect(typeof alias.data[0].title).toBe("string");
  });

  it("gates guest auth by default and enforces guest restrictions for ranked/economy writes", async () => {
    const guestStart = await postJson("/auth/guest/start", {});
    expect(guestStart.ok).toBe(false);
    expect(guestStart.status).toBe(403);

    const guestAccount = createOrGetAccount("guest_manual_wallet", "guest");
    const guestCharacter = createCharacter(guestAccount.account_id, "GuestManual", "melee");
    guestAccount.account_type = "guest";
    accounts.set(guestAccount.account_id, guestAccount);
    const guestSession = createSession(guestAccount.account_id, guestCharacter.character_id, "guest");
    sessions.set(guestSession.session_token, guestSession);
    agents.set(guestCharacter.character_id, {
      agent_id: guestCharacter.character_id,
      skills_md: "",
      wallet_address: guestAccount.wallet_address,
      combat_class: "melee",
      prayer_book: "normal",
      wins: 0,
      losses: 0,
      elo: 1000,
      registered_at: Date.now(),
    });
    getOrCreateProgress(guestCharacter.character_id).inventory.coins = 5_000;

    const humanRegister = await postJson("/arena/register", {
      agent_id: "HumanTarget",
      combat_class: "ranged",
      prayer_book: "normal",
    });
    expect(humanRegister.ok).toBe(true);

    const geOrder = await postJson(
      "/economy/ge/order",
      { item_id: "logs", side: "buy", qty: 1, price_each: 1 },
      { authorization: `Bearer ${guestSession.session_token}` }
    );
    expect(geOrder.ok).toBe(false);
    expect(geOrder.status).toBe(403);

    const tradeRequest = await postJson(
      "/economy/trade/request",
      { to_character_id: "HumanTarget", offered_items: { coins: 1 }, requested_items: { logs: 1 } },
      { authorization: `Bearer ${guestSession.session_token}` }
    );
    expect(tradeRequest.ok).toBe(false);
    expect(tradeRequest.status).toBe(403);

    const queueJoin = await postJson("/arena/queue/join", {
      agent_id: guestCharacter.character_id,
      arena: "duel_arena",
    });
    expect(queueJoin.ok).toBe(false);
    expect(queueJoin.status).toBe(403);

    const challenge = await postJson("/arena/challenge", {
      agent_id: guestCharacter.character_id,
      target_agent_id: "HumanTarget",
      arena: "duel_arena",
    });
    expect(challenge.ok).toBe(false);
    expect(challenge.status).toBe(403);
  });
});
