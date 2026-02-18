// ── Combat Classes & Prayer Books ──
export type CombatClass = "melee" | "ranged" | "magic";
export type PrayerBook = "normal" | "ancient_curses";
export type Arena = "duel_arena" | "wilderness_crater" | "clan_wars" | "fight_caves";

// ── Actions ──
export type MeleeAction = "slash" | "stab" | "crush" | "whip_flick" | "godsword_smash";
export type RangedAction = "rapid_shot" | "longrange_shot" | "crossbow_bolt" | "knife_throw" | "dark_bow_spec";
export type MagicAction = "fire_blast" | "ice_barrage" | "blood_barrage" | "entangle" | "teleblock" | "vengeance";
export type PrayerAction = "protect_melee" | "protect_ranged" | "protect_magic" | "deflect_melee" | "deflect_ranged" | "deflect_magic" | "smite" | "none";
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
  updated_at: number;
}

// ── Challenge ──
export interface Challenge {
  challenge_id: string;
  challenger_id: string;
  target_id: string;
  wager_amount: number;
  arena: Arena;
  rules: {
    no_prayer: boolean;
    no_food: boolean;
    no_special_attack: boolean;
  };
  status: "pending" | "accepted" | "declined" | "expired";
  created_at: number;
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
