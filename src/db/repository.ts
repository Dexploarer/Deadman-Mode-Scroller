import type {
  Account,
  AccountType,
  Agent,
  AgentProfile,
  AgentProgress,
  Character,
  QuestLeaderboardEntry,
  MarketOrder,
  PvpLeaderboardEntry,
  ResourceNode,
  SkillLeaderboardEntry,
  SkillName,
  TradeOffer,
} from "../types";
import type { Sql } from "postgres";
import { getDbClient } from "./client";
import { ensureSchema } from "./schema";
import type { XpGain } from "../progression";

async function withDb<T>(fallback: T, fn: (sql: Sql) => Promise<T>): Promise<T> {
  const sql = getDbClient();
  if (!sql) return fallback;

  try {
    await ensureSchema(sql);
    return await fn(sql);
  } catch (error) {
    console.warn("[db] operation failed", error);
    return fallback;
  }
}

export async function upsertAgent(agent: Agent): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into agents (
        agent_id, skills_md, wallet_address, combat_class, prayer_book,
        wins, losses, elo, registered_at
      ) values (
        ${agent.agent_id}, ${agent.skills_md}, ${agent.wallet_address}, ${agent.combat_class}, ${agent.prayer_book},
        ${agent.wins}, ${agent.losses}, ${agent.elo}, ${agent.registered_at}
      )
      on conflict (agent_id) do update set
        skills_md = excluded.skills_md,
        wallet_address = excluded.wallet_address,
        combat_class = excluded.combat_class,
        prayer_book = excluded.prayer_book,
        wins = excluded.wins,
        losses = excluded.losses,
        elo = excluded.elo,
        registered_at = excluded.registered_at
    `;
  });
}

export async function loadAgentProgress(agentId: string): Promise<AgentProgress | null> {
  return withDb<AgentProgress | null>(null, async (sql) => {
    const skillRows = await sql`
      select skill, level, xp
      from agent_skills
      where agent_id = ${agentId}
    `;

    const invRows = await sql`
      select item_id, qty
      from agent_inventory
      where agent_id = ${agentId}
    `;

    if (skillRows.length === 0 && invRows.length === 0) {
      return null;
    }

    const skills: Partial<AgentProgress["skills"]> = {};
    for (const row of skillRows as Array<{ skill: SkillName; level: number; xp: number }>) {
      skills[row.skill] = { level: row.level, xp: row.xp };
    }

    const inventory: Record<string, number> = {};
    for (const row of invRows as Array<{ item_id: string; qty: number }>) {
      inventory[row.item_id] = row.qty;
    }

    return {
      agent_id: agentId,
      skills: skills as AgentProgress["skills"],
      inventory,
      updated_at: Date.now(),
    };
  });
}

export async function saveAgentProgress(progress: AgentProgress): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql.begin(async (trx) => {
      for (const [skill, state] of Object.entries(progress.skills)) {
        await trx`
          insert into agent_skills (agent_id, skill, level, xp)
          values (${progress.agent_id}, ${skill}, ${state.level}, ${state.xp})
          on conflict (agent_id, skill) do update set
            level = excluded.level,
            xp = excluded.xp
        `;
      }

      for (const [item_id, qty] of Object.entries(progress.inventory)) {
        await trx`
          insert into agent_inventory (agent_id, item_id, qty)
          values (${progress.agent_id}, ${item_id}, ${qty})
          on conflict (agent_id, item_id) do update set
            qty = excluded.qty
        `;
      }
    });
  });
}

export async function appendSkillEvent(agentId: string, gain: XpGain, source: string): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into skill_events (
        agent_id, skill, gained_xp, old_level, new_level, total_xp, source, created_at
      ) values (
        ${agentId}, ${gain.skill}, ${gain.gained_xp}, ${gain.old_level}, ${gain.new_level}, ${gain.total_xp}, ${source}, ${Date.now()}
      )
    `;
  });
}

export async function appendDuelTick(
  duelId: string,
  roundNo: number,
  tickNo: number,
  payload: unknown
): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into duel_ticks (duel_id, round_no, tick_no, payload, created_at)
      values (${duelId}, ${roundNo}, ${tickNo}, ${JSON.stringify(payload)}, ${Date.now()})
      on conflict (duel_id, round_no, tick_no) do update set
        payload = excluded.payload,
        created_at = excluded.created_at
    `;
  });
}

export async function upsertDuelSummary(
  duelId: string,
  arena: string,
  p1: string,
  p2: string,
  roundsP1: number,
  roundsP2: number,
  winner?: string
): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into duels (duel_id, arena, p1, p2, created_at, winner, rounds_p1, rounds_p2)
      values (${duelId}, ${arena}, ${p1}, ${p2}, ${Date.now()}, ${winner ?? null}, ${roundsP1}, ${roundsP2})
      on conflict (duel_id) do update set
        winner = excluded.winner,
        rounds_p1 = excluded.rounds_p1,
        rounds_p2 = excluded.rounds_p2
    `;
  });
}

export async function upsertResourceNodes(nodes: ResourceNode[]): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql.begin(async (trx) => {
      for (const node of nodes) {
        await trx`
          insert into resource_nodes (
            node_id, type, skill, item_id, x, y, zone, area_id, instance_id, level_required, xp, success_chance, depleted_until, respawn_ms
          ) values (
            ${node.node_id}, ${node.type}, ${node.skill}, ${node.item_id},
            ${Math.round(node.x)}, ${Math.round(node.y)}, ${node.zone}, ${node.area_id}, ${node.instance_id ?? null},
            ${node.level_required}, ${node.xp}, ${node.success_chance},
            ${node.depleted_until}, ${node.respawn_ms}
          )
          on conflict (node_id) do update set
            type = excluded.type,
            skill = excluded.skill,
            item_id = excluded.item_id,
            x = excluded.x,
            y = excluded.y,
            zone = excluded.zone,
            area_id = excluded.area_id,
            instance_id = excluded.instance_id,
            level_required = excluded.level_required,
            xp = excluded.xp,
            success_chance = excluded.success_chance,
            depleted_until = excluded.depleted_until,
            respawn_ms = excluded.respawn_ms
        `;
      }
    });
  });
}

export async function loadResourceNodes(): Promise<ResourceNode[]> {
  return withDb<ResourceNode[]>([], async (sql) => {
    const rows = await sql`
      select
        node_id,
        type,
        skill,
        item_id,
        x,
        y,
        zone,
        area_id,
        instance_id,
        level_required,
        xp,
        success_chance,
        depleted_until,
        respawn_ms
      from resource_nodes
      order by node_id asc
    `;

    return rows as ResourceNode[];
  });
}

export async function upsertAccount(account: Account): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into accounts (account_id, wallet_address, display_name, account_type, created_at, updated_at)
      values (
        ${account.account_id},
        ${account.wallet_address},
        ${account.display_name},
        ${account.account_type},
        ${account.created_at},
        ${account.updated_at}
      )
      on conflict (account_id) do update set
        wallet_address = excluded.wallet_address,
        display_name = excluded.display_name,
        account_type = excluded.account_type,
        updated_at = excluded.updated_at
    `;
  });
}

export async function loadAccountByWallet(walletAddress: string): Promise<Account | null> {
  return withDb<Account | null>(null, async (sql) => {
    const rows = await sql`
      select account_id, wallet_address, display_name, account_type, created_at, updated_at
      from accounts
      where wallet_address = ${walletAddress}
      limit 1
    `;
    return (rows[0] as Account | undefined) ?? null;
  });
}

export async function saveWalletNonce(walletAddress: string, nonce: string, expiresAt: number): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into wallet_nonces (wallet_address, nonce, expires_at, created_at)
      values (${walletAddress}, ${nonce}, ${expiresAt}, ${Date.now()})
      on conflict (wallet_address) do update set
        nonce = excluded.nonce,
        expires_at = excluded.expires_at,
        created_at = excluded.created_at
    `;
  });
}

export async function loadWalletNonce(walletAddress: string): Promise<{ nonce: string; expires_at: number } | null> {
  return withDb<{ nonce: string; expires_at: number } | null>(null, async (sql) => {
    const rows = await sql`
      select nonce, expires_at
      from wallet_nonces
      where wallet_address = ${walletAddress}
      limit 1
    `;
    return (rows[0] as { nonce: string; expires_at: number } | undefined) ?? null;
  });
}

export async function deleteWalletNonce(walletAddress: string): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`delete from wallet_nonces where wallet_address = ${walletAddress}`;
  });
}

export async function upsertSessionRecord(record: {
  session_token: string;
  account_id: string;
  character_id: string | null;
  actor_type: AccountType;
  expires_at: number;
  created_at: number;
}): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into sessions (session_token, account_id, character_id, actor_type, expires_at, created_at)
      values (
        ${record.session_token},
        ${record.account_id},
        ${record.character_id},
        ${record.actor_type},
        ${record.expires_at},
        ${record.created_at}
      )
      on conflict (session_token) do update set
        account_id = excluded.account_id,
        character_id = excluded.character_id,
        actor_type = excluded.actor_type,
        expires_at = excluded.expires_at
    `;
  });
}

export async function loadSessionRecord(sessionToken: string): Promise<{
  session_token: string;
  account_id: string;
  character_id: string | null;
  actor_type: AccountType;
  expires_at: number;
  created_at: number;
} | null> {
  return withDb<{
    session_token: string;
    account_id: string;
    character_id: string | null;
    actor_type: AccountType;
    expires_at: number;
    created_at: number;
  } | null>(null, async (sql) => {
    const rows = await sql`
      select session_token, account_id, character_id, actor_type, expires_at, created_at
      from sessions
      where session_token = ${sessionToken}
      limit 1
    `;
    return (rows[0] as {
      session_token: string;
      account_id: string;
      character_id: string | null;
      actor_type: AccountType;
      expires_at: number;
      created_at: number;
    } | undefined) ?? null;
  });
}

export async function deleteSessionRecord(sessionToken: string): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`delete from sessions where session_token = ${sessionToken}`;
  });
}

export async function upsertAgentProfile(profile: AgentProfile): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into agent_profiles (account_id, runtime_label, endpoint_url, skills_md, notes, updated_at)
      values (
        ${profile.account_id},
        ${profile.runtime_label},
        ${profile.endpoint_url},
        ${profile.skills_md},
        ${profile.notes},
        ${profile.updated_at}
      )
      on conflict (account_id) do update set
        runtime_label = excluded.runtime_label,
        endpoint_url = excluded.endpoint_url,
        skills_md = excluded.skills_md,
        notes = excluded.notes,
        updated_at = excluded.updated_at
    `;
  });
}

export async function loadAgentProfile(accountId: string): Promise<AgentProfile | null> {
  return withDb<AgentProfile | null>(null, async (sql) => {
    const rows = await sql`
      select account_id, runtime_label, endpoint_url, skills_md, notes, updated_at
      from agent_profiles
      where account_id = ${accountId}
      limit 1
    `;
    return (rows[0] as AgentProfile | undefined) ?? null;
  });
}

export async function upsertCharacter(character: Character): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into characters (
        character_id, account_id, name, mode, combat_class, selected, created_at, updated_at
      ) values (
        ${character.character_id},
        ${character.account_id},
        ${character.name},
        ${character.mode},
        ${character.combat_class},
        ${character.selected},
        ${character.created_at},
        ${character.updated_at}
      )
      on conflict (character_id) do update set
        name = excluded.name,
        mode = excluded.mode,
        combat_class = excluded.combat_class,
        selected = excluded.selected,
        updated_at = excluded.updated_at
    `;
  });
}

export async function loadCharactersByAccount(accountId: string): Promise<Character[]> {
  return withDb<Character[]>([], async (sql) => {
    const rows = await sql`
      select character_id, account_id, name, mode, combat_class, selected, created_at, updated_at
      from characters
      where account_id = ${accountId}
      order by created_at asc
    `;
    return rows as Character[];
  });
}

export async function loadBankInventory(characterId: string): Promise<Record<string, number>> {
  return withDb<Record<string, number>>({}, async (sql) => {
    const rows = await sql`
      select item_id, qty
      from bank_items
      where character_id = ${characterId}
    `;
    const inventory: Record<string, number> = {};
    for (const row of rows as Array<{ item_id: string; qty: number }>) {
      inventory[row.item_id] = row.qty;
    }
    return inventory;
  });
}

export async function saveBankInventory(characterId: string, inventory: Record<string, number>): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql.begin(async (trx) => {
      await trx`delete from bank_items where character_id = ${characterId}`;
      for (const [item_id, qty] of Object.entries(inventory)) {
        await trx`
          insert into bank_items (character_id, item_id, qty)
          values (${characterId}, ${item_id}, ${qty})
        `;
      }
    });
  });
}

export async function upsertTradeOffer(offer: TradeOffer): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into trade_offers (
        trade_id, from_character_id, to_character_id, offered_items, requested_items, status, created_at, updated_at
      ) values (
        ${offer.trade_id},
        ${offer.from_character_id},
        ${offer.to_character_id},
        ${JSON.stringify(offer.offered_items)},
        ${JSON.stringify(offer.requested_items)},
        ${offer.status},
        ${offer.created_at},
        ${offer.updated_at}
      )
      on conflict (trade_id) do update set
        offered_items = excluded.offered_items,
        requested_items = excluded.requested_items,
        status = excluded.status,
        updated_at = excluded.updated_at
    `;
  });
}

export async function upsertMarketOrder(order: MarketOrder): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`
      insert into ge_orders (
        order_id, character_id, item_id, qty, price_each, side, status, filled_qty, created_at, updated_at
      ) values (
        ${order.order_id},
        ${order.character_id},
        ${order.item_id},
        ${order.qty},
        ${order.price_each},
        ${order.side},
        ${order.status},
        ${order.filled_qty},
        ${order.created_at},
        ${order.updated_at}
      )
      on conflict (order_id) do update set
        qty = excluded.qty,
        price_each = excluded.price_each,
        status = excluded.status,
        filled_qty = excluded.filled_qty,
        updated_at = excluded.updated_at
    `;
  });
}

export async function deleteMarketOrder(orderId: string): Promise<void> {
  await withDb<void>(undefined, async (sql) => {
    await sql`delete from ge_orders where order_id = ${orderId}`;
  });
}

export async function listOpenMarketOrders(itemId: string): Promise<MarketOrder[]> {
  return withDb<MarketOrder[]>([], async (sql) => {
    const rows = await sql`
      select order_id, character_id, item_id, qty, price_each, side, status, filled_qty, created_at, updated_at
      from ge_orders
      where item_id = ${itemId}
        and status in ('open', 'partially_filled')
      order by price_each asc, created_at asc
    `;
    return rows as MarketOrder[];
  });
}

export async function queryPvpLeaderboard(limit = 50, offset = 0): Promise<PvpLeaderboardEntry[]> {
  return withDb<PvpLeaderboardEntry[]>([], async (sql) => {
    const rows = await sql`
      select
        c.character_id,
        c.name as character_name,
        c.combat_class,
        a.elo,
        a.wins,
        a.losses
      from agents a
      join characters c on c.character_id = a.agent_id
      join accounts ac on ac.account_id = c.account_id
      where ac.account_type <> 'guest'
      order by a.elo desc, a.wins desc, c.created_at asc
      limit ${limit}
      offset ${offset}
    `;
    return (rows as Array<{
      character_id: string;
      character_name: string;
      combat_class: "melee" | "ranged" | "magic";
      elo: number;
      wins: number;
      losses: number;
    }>).map((row, index) => ({
      rank: offset + index + 1,
      character_id: row.character_id,
      character_name: row.character_name,
      combat_class: row.combat_class,
      elo: row.elo,
      wins: row.wins,
      losses: row.losses,
      kd: row.losses > 0 ? (row.wins / row.losses).toFixed(2) : row.wins.toString(),
    }));
  });
}

export async function querySkillLeaderboard(
  params: { skill?: SkillName; metric?: "xp" | "level"; limit?: number; offset?: number } = {}
): Promise<SkillLeaderboardEntry[]> {
  const skill = params.skill;
  const metric = params.metric === "level" ? "level" : "xp";
  const limit = Math.max(1, Math.min(200, Math.floor(Number(params.limit ?? 50))));
  const offset = Math.max(0, Math.floor(Number(params.offset ?? 0)));
  return withDb<SkillLeaderboardEntry[]>([], async (sql) => {
    if (skill) {
      const rows = await sql`
        select
          c.character_id,
          c.name as character_name,
          s.skill,
          s.level,
          s.xp
        from agent_skills s
        join characters c on c.character_id = s.agent_id
        join accounts ac on ac.account_id = c.account_id
        where s.skill = ${skill}
          and ac.account_type <> 'guest'
        order by ${metric === "level" ? sql` s.level desc, s.xp desc ` : sql` s.xp desc, s.level desc `}, c.created_at asc
        limit ${limit}
        offset ${offset}
      `;
      return (rows as Array<{
        character_id: string;
        character_name: string;
        skill: SkillName;
        level: number;
        xp: number;
      }>).map((row, index) => ({
        rank: offset + index + 1,
        character_id: row.character_id,
        character_name: row.character_name,
        skill: row.skill,
        level: row.level,
        xp: row.xp,
      }));
    }

    const rows = await sql`
      select
        c.character_id,
        c.name as character_name,
        coalesce(sum(s.level), 0) as total_level,
        coalesce(sum(s.xp), 0) as total_xp
      from characters c
      join accounts ac on ac.account_id = c.account_id
      left join agent_skills s on s.agent_id = c.character_id
      where ac.account_type <> 'guest'
      group by c.character_id, c.name, c.created_at
      order by ${metric === "level" ? sql` total_level desc, total_xp desc ` : sql` total_xp desc, total_level desc `}, c.created_at asc
      limit ${limit}
      offset ${offset}
    `;
    return (rows as Array<{
      character_id: string;
      character_name: string;
      total_level: number;
      total_xp: number;
    }>).map((row, index) => ({
      rank: offset + index + 1,
      character_id: row.character_id,
      character_name: row.character_name,
      skill: "overall",
      level: row.total_level,
      xp: row.total_xp,
      total_level: row.total_level,
      total_xp: row.total_xp,
    }));
  });
}

export async function queryQuestLeaderboard(limit = 50, offset = 0): Promise<QuestLeaderboardEntry[]> {
  return withDb<QuestLeaderboardEntry[]>([], async (sql) => {
    const rows = await sql`
      select
        c.character_id,
        c.name as character_name,
        coalesce(sum(case when q.status = 'completed' then 1 else 0 end), 0) as completed_count,
        max(q.completed_at) as last_completed_at
      from characters c
      join accounts ac on ac.account_id = c.account_id
      left join quest_states q on q.character_id = c.character_id
      where ac.account_type <> 'guest'
      group by c.character_id, c.name, c.created_at
      order by completed_count desc, last_completed_at desc nulls last, c.created_at asc
      limit ${limit}
      offset ${offset}
    `;
    return (rows as Array<{
      character_id: string;
      character_name: string;
      completed_count: number;
      last_completed_at: number | null;
    }>).map((row, index) => ({
      rank: offset + index + 1,
      character_id: row.character_id,
      character_name: row.character_name,
      completed_count: row.completed_count,
      quest_points: row.completed_count,
      last_completed_at: row.last_completed_at,
    }));
  });
}
