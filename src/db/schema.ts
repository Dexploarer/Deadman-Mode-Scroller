import type { Sql } from "postgres";

let initialized = false;

export async function ensureSchema(sql: Sql): Promise<void> {
  if (initialized) return;

  await sql`
    create table if not exists agents (
      agent_id text primary key,
      skills_md text not null default '',
      wallet_address text not null default '',
      combat_class text not null,
      prayer_book text not null,
      wins integer not null default 0,
      losses integer not null default 0,
      elo integer not null default 1000,
      registered_at bigint not null
    )
  `;

  await sql`
    create table if not exists agent_skills (
      agent_id text not null,
      skill text not null,
      level integer not null,
      xp integer not null,
      primary key (agent_id, skill)
    )
  `;

  await sql`
    create table if not exists agent_inventory (
      agent_id text not null,
      item_id text not null,
      qty integer not null,
      primary key (agent_id, item_id)
    )
  `;

  await sql`
    create table if not exists duels (
      duel_id text primary key,
      arena text not null,
      p1 text not null,
      p2 text not null,
      created_at bigint not null,
      winner text,
      rounds_p1 integer not null default 0,
      rounds_p2 integer not null default 0
    )
  `;

  await sql`
    create table if not exists duel_rounds (
      duel_id text not null,
      round_no integer not null,
      winner text,
      ended_at bigint,
      primary key (duel_id, round_no)
    )
  `;

  await sql`
    create table if not exists duel_ticks (
      duel_id text not null,
      round_no integer not null,
      tick_no integer not null,
      payload jsonb not null,
      created_at bigint not null,
      primary key (duel_id, round_no, tick_no)
    )
  `;

  await sql`
    create table if not exists resource_nodes (
      node_id text primary key,
      type text not null,
      skill text not null,
      item_id text not null,
      x integer not null,
      y integer not null,
      zone text not null,
      area_id text not null default 'surface_main',
      instance_id text,
      level_required integer not null,
      xp integer not null,
      success_chance real not null,
      depleted_until bigint,
      respawn_ms integer not null
    )
  `;

  await sql`
    alter table resource_nodes
    add column if not exists area_id text not null default 'surface_main'
  `;

  await sql`
    alter table resource_nodes
    add column if not exists instance_id text
  `;

  await sql`
    create table if not exists skill_events (
      id bigserial primary key,
      agent_id text not null,
      skill text not null,
      gained_xp integer not null,
      old_level integer not null,
      new_level integer not null,
      total_xp integer not null,
      source text not null,
      created_at bigint not null
    )
  `;

  initialized = true;
}
