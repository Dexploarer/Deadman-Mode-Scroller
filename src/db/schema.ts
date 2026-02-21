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
    create table if not exists accounts (
      account_id text primary key,
      wallet_address text not null unique,
      display_name text not null,
      account_type text not null default 'human',
      created_at bigint not null,
      updated_at bigint not null
    )
  `;

  await sql`
    create table if not exists wallet_nonces (
      wallet_address text primary key,
      nonce text not null,
      expires_at bigint not null,
      created_at bigint not null
    )
  `;

  await sql`
    create table if not exists sessions (
      session_token text primary key,
      account_id text not null,
      character_id text,
      actor_type text not null default 'human',
      expires_at bigint not null,
      created_at bigint not null
    )
  `;

  await sql`
    create table if not exists characters (
      character_id text primary key,
      account_id text not null,
      name text not null,
      mode text not null,
      combat_class text not null,
      selected boolean not null default false,
      created_at bigint not null,
      updated_at bigint not null
    )
  `;

  await sql`
    create unique index if not exists idx_characters_account_name
    on characters (account_id, name)
  `;

  await sql`
    create table if not exists equipment (
      character_id text primary key,
      payload jsonb not null
    )
  `;

  await sql`
    create table if not exists bank_items (
      character_id text not null,
      item_id text not null,
      qty integer not null,
      primary key (character_id, item_id)
    )
  `;

  await sql`
    create table if not exists quest_states (
      character_id text not null,
      quest_id text not null,
      status text not null,
      objective_index integer not null,
      started_at bigint,
      completed_at bigint,
      reward_claimed boolean not null default false,
      primary key (character_id, quest_id)
    )
  `;

  await sql`
    create table if not exists dialogue_states (
      character_id text primary key,
      npc_id text not null,
      node_id text not null,
      updated_at bigint not null
    )
  `;

  await sql`
    create table if not exists trade_offers (
      trade_id text primary key,
      from_character_id text not null,
      to_character_id text not null,
      offered_items jsonb not null,
      requested_items jsonb not null,
      status text not null,
      created_at bigint not null,
      updated_at bigint not null
    )
  `;

  await sql`
    create table if not exists ge_orders (
      order_id text primary key,
      character_id text not null,
      item_id text not null,
      qty integer not null,
      price_each integer not null,
      side text not null,
      status text not null,
      filled_qty integer not null default 0,
      created_at bigint not null,
      updated_at bigint not null
    )
  `;

  await sql`
    create table if not exists shard_snapshots (
      id bigserial primary key,
      shard_id text not null,
      area_id text not null,
      instance_id text,
      mode text not null,
      online_count integer not null,
      created_at bigint not null
    )
  `;

  await sql`
    create table if not exists kill_logs (
      id bigserial primary key,
      attacker_character_id text,
      defender_character_id text,
      mode text not null,
      area_id text not null,
      created_at bigint not null
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
    alter table accounts
    add column if not exists account_type text not null default 'human'
  `;

  await sql`
    alter table sessions
    add column if not exists actor_type text not null default 'human'
  `;

  await sql`
    create table if not exists agent_profiles (
      account_id text primary key,
      runtime_label text not null,
      endpoint_url text,
      skills_md text not null default '',
      notes text not null default '',
      updated_at bigint not null
    )
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
