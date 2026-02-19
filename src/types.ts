// ── Combat Classes & Prayer Books ──
export type CombatClass = "melee" | "ranged" | "magic";
export type PrayerBook = "normal" | "ancient_curses";
export type Arena = "duel_arena" | "wilderness_crater" | "clan_wars" | "fight_caves";

// ── Skills / Progression ──
export type SkillName =
  | "attack"
  | "strength"
  | "defence"
  | "hitpoints"
  | "ranged"
  | "magic"
  | "prayer"
  | "mining"
  | "fishing"
  | "woodcutting"
  | "runecrafting"
  | "sailing";

export interface SkillState {
  level: number;
  xp: number;
}

export interface AgentProgress {
  agent_id: string;
  skills: Record<SkillName, SkillState>;
  inventory: Record<string, number>;
  updated_at: number;
}

export interface InventoryItem {
  item_id: string;
  qty: number;
}

// ── Actions ──
export type MeleeAction = "slash" | "stab" | "crush" | "whip_flick" | "godsword_smash";
export type RangedAction = "rapid_shot" | "longrange_shot" | "crossbow_bolt" | "knife_throw" | "dark_bow_spec";
export type MagicAction = "fire_blast" | "ice_barrage" | "blood_barrage" | "entangle" | "teleblock" | "vengeance";
export type PrayerAction =
  | "protect_melee"
  | "protect_ranged"
  | "protect_magic"
  | "smite"
  | "piety"
  | "rigour"
  | "augury"
  | "none"
  // Compatibility shim for old clients; normalized server-side.
  | "deflect_melee"
  | "deflect_ranged"
  | "deflect_magic";
export type FoodAction = "eat_shark" | "brew_sip" | "karambwan" | "combo_eat" | "none";
export type MovementAction = "step_under" | "run_away" | "teleport_out" | "none";
export type SpecialAction = "ags_spec" | "dds_spec" | "gmaul_spec" | "vls_spec" | "dbow_spec" | "zcb_spec" | "sgs_spec" | "staff_spec" | "claws_spec" | "none";

export type AttackAction = MeleeAction | RangedAction | MagicAction;

export interface ActionSubmission {
  agent_id: string;
  fight_id: string;
  action: AttackAction | "none";
  prayer?: PrayerAction;
  food?: FoodAction;
  special?: SpecialAction;
  movement?: MovementAction;
}

// ── Attack Definitions ──
export interface AttackDef {
  name: string;
  category: CombatClass;
  minDmg: number;
  maxDmg: number;
  speed: number; // ticks
  accuracyBonus: number;
  special?: string;
}

export interface SpecDef {
  name: string;
  weapon: string;
  cost: number; // percentage of spec bar
  minDmg: number;
  maxDmg: number;
  hits: number;
  effect?: string;
}

// ── Player State ──
export interface FoodInventory {
  shark: number;
  karambwan: number;
  brew: number;
}

export interface PlayerState {
  agent_id: string;
  combat_class: CombatClass;
  hp: number;
  prayer: number;
  spec_bar: number;
  food_remaining: FoodInventory;
  active_prayer: PrayerAction;
  frozen: number; // ticks remaining
  teleblocked: boolean;
  poisoned: boolean;
  vengeance_active: boolean;
  attack_delay: number; // ticks until can attack
  last_action: AttackAction | "none";
  last_special: SpecialAction;
}

// ── Fight ──
export interface TickResult {
  tick: number;
  p1_action: string;
  p2_action: string;
  p1_damage_dealt: number;
  p2_damage_dealt: number;
  p1_healed: number;
  p2_healed: number;
  narrative: string;
}

export type FightStatus = "pending" | "in_progress" | "round_over" | "fight_over";

export interface Fight {
  fight_id: string;
  arena: Arena;
  round: number;
  tick: number;
  tick_window_ms: number;
  next_tick_at: number;
  status: FightStatus;
  p1: PlayerState;
  p2: PlayerState;
  last_result: TickResult | null;
  history: TickResult[];
  rounds_won: { p1: number; p2: number };
  wager_amount: number;
  // action submission tracking
  pending_actions: {
    p1: ActionSubmission | null;
    p2: ActionSubmission | null;
  };
}

// ── Agent Registration ──
export interface Agent {
  agent_id: string;
  skills_md: string;
  wallet_address: string;
  combat_class: CombatClass;
  prayer_book: PrayerBook;
  wins: number;
  losses: number;
  elo: number;
  registered_at: number;
}

// ── Open World Presence ──
export interface WorldAgent {
  agent_id: string;
  combat_class: CombatClass;
  x: number;
  y: number;
  zone: string;
  area_id?: string;
  instance_id?: string | null;
  updated_at: number;
}

// ── Challenge ──
export interface Challenge {
  challenge_id: string;
  challenger_id: string;
  target_id: string;
  wager_amount: number;
  arena: Arena;
  rules: DuelRules;
  status: "pending" | "accepted" | "declined" | "expired";
  created_at: number;
}

export interface DuelRules {
  no_prayer: boolean;
  no_food: boolean;
  no_special_attack: boolean;
}

export interface DuelQueueEntry {
  agent_id: string;
  arena: Arena;
  combat_class: CombatClass;
  joined_at: number;
  fallback_bot_after_ms: number;
}

export type GatheringSkill = "mining" | "fishing" | "woodcutting" | "runecrafting";

export type ResourceNodeType =
  | "copper_rock"
  | "tin_rock"
  | "iron_rock"
  | "coal_rock"
  | "mithril_rock"
  | "adamantite_rock"
  | "runite_rock"
  | "normal_tree"
  | "oak_tree"
  | "willow_tree"
  | "yew_tree"
  | "magic_tree"
  | "shrimp_spot"
  | "anchovy_spot"
  | "trout_spot"
  | "salmon_spot"
  | "lobster_spot"
  | "swordfish_spot"
  | "shark_spot"
  | "air_altar"
  | "mind_altar"
  | "law_altar"
  | "nature_altar";

export interface ResourceNode {
  node_id: string;
  type: ResourceNodeType;
  skill: GatheringSkill;
  item_id: string;
  x: number;
  y: number;
  zone: string;
  area_id: string;
  instance_id?: string | null;
  level_required: number;
  xp: number;
  success_chance: number;
  depleted_until: number | null;
  respawn_ms: number;
}

export type WorldInteractAction = "start" | "stop";

export interface WorldInteractRequest {
  agent_id: string;
  node_id: string;
  action: WorldInteractAction;
}

export type PortalScope = "shared" | "personal";

export interface PortalTravelRequest {
  agent_id: string;
  portal_id: string;
  scope?: PortalScope;
}

export type SpellName =
  | "wind_strike"
  | "teleport_lumbridge"
  | "teleport_varrock"
  | "teleport_al_kharid"
  | "teleport_wilderness"
  | "teleport_runecraft_nexus"
  | "teleport_shadow_dungeon";

export interface CastSpellRequest {
  agent_id: string;
  spell: SpellName;
}

export interface WorldArea {
  area_id: string;
  name: string;
  description: string;
  environment: "mainline" | "desert" | "wilderness" | "dungeon" | "minigame" | "arcane" | "quest";
  shared: boolean;
  world_width: number;
  spawn_x: number;
  spawn_y: number;
  spawn_zone: string;
}

export interface WorldPortal {
  portal_id: string;
  name: string;
  from_area_id: string;
  from_x: number;
  from_y: number;
  to_area_id: string;
  to_x: number;
  to_y: number;
  to_zone: string;
  kind: "travel" | "duel_queue";
  default_scope: PortalScope;
}

// ── Stat Profiles ──
export interface StatProfile {
  attack: number;
  strength: number;
  defence: number;
  ranged: number;
  magic: number;
  hp: number;
  prayer: number;
}

export const STAT_PROFILES: Record<CombatClass, StatProfile> = {
  melee: { attack: 99, strength: 99, defence: 99, ranged: 75, magic: 75, hp: 99, prayer: 99 },
  ranged: { attack: 75, strength: 75, defence: 75, ranged: 99, magic: 75, hp: 99, prayer: 99 },
  magic: { attack: 75, strength: 75, defence: 75, ranged: 75, magic: 99, hp: 99, prayer: 99 },
};
