import type { Agent, AgentProgress, ResourceNode, SkillName } from "../types";
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
