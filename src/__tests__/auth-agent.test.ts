import { beforeEach, describe, expect, it } from "bun:test";
import api from "../routes";
import {
  accounts,
  agentProfiles,
  agents,
  characters,
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

async function putJson(path: string, body: unknown, headers: Record<string, string> = {}) {
  const res = await api.request(path, {
    method: "PUT",
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
  accounts.clear();
  agents.clear();
  characters.clear();
  sessions.clear();
  walletChallenges.clear();
  agentProfiles.clear();
});

describe("agent auth + identity parity", () => {
  it("authenticates agents on dedicated routes, assigns actor_type, and persists agent profile", async () => {
    const challenge = await postJson("/auth/agent/challenge", {
      wallet_address: "0x1230000000000000000000000000000000000001",
    });
    expect(challenge.ok).toBe(true);
    expect(typeof challenge.data.nonce).toBe("string");

    const verify = await postJson("/auth/agent/verify", {
      wallet_address: "0x1230000000000000000000000000000000000001",
      nonce: challenge.data.nonce,
      signature: `signed:${challenge.data.nonce}`,
      character_name: "AgentParity",
      combat_class: "magic",
    });
    expect(verify.ok).toBe(true);
    expect(verify.data.account.account_type).toBe("agent");
    expect(typeof verify.data.session_token).toBe("string");

    const me = await getJson("/character/me", {
      authorization: `Bearer ${verify.data.session_token}`,
    });
    expect(me.ok).toBe(true);
    expect(me.data.actor_type).toBe("agent");

    const updateProfile = await putJson(
      "/agents/profile",
      {
        runtime_label: "ElizaOS Runtime",
        endpoint_url: "https://agent.example/api",
        skills_md: "- pvp\n- runecrafting\n- quests",
        notes: "autonomous shard pilot",
      },
      { authorization: `Bearer ${verify.data.session_token}` }
    );
    expect(updateProfile.ok).toBe(true);
    expect(updateProfile.data.status).toBe("agent_profile_updated");

    const profile = await getJson("/agents/profile/me", {
      authorization: `Bearer ${verify.data.session_token}`,
    });
    expect(profile.ok).toBe(true);
    expect(profile.data.account_type).toBe("agent");
    expect(profile.data.profile.runtime_label).toBe("ElizaOS Runtime");
    expect(profile.data.profile.endpoint_url).toBe("https://agent.example/api");
  });

  it("rejects agent profile update for non-agent accounts", async () => {
    const challenge = await postJson("/auth/wallet/challenge", {
      wallet_address: "0x4560000000000000000000000000000000000002",
    });
    const verify = await postJson("/auth/wallet/verify", {
      wallet_address: "0x4560000000000000000000000000000000000002",
      nonce: challenge.data.nonce,
      signature: `signed:${challenge.data.nonce}`,
      character_name: "HumanProfile",
      combat_class: "melee",
    });
    expect(verify.ok).toBe(true);
    expect(verify.data.account.account_type).toBe("human");

    const updateProfile = await putJson(
      "/agents/profile",
      {
        runtime_label: "Should Fail",
      },
      { authorization: `Bearer ${verify.data.session_token}` }
    );
    expect(updateProfile.ok).toBe(false);
    expect(updateProfile.status).toBe(403);
  });
});
