import type {
  AttackAction, AttackDef, SpecDef, SpecialAction, PrayerAction, FoodAction,
  PlayerState, CombatClass, TickResult, Fight, StatProfile,
} from "./types";
import { STAT_PROFILES } from "./types";

// ── Attack Definitions ──
const ATTACKS: Record<string, AttackDef> = {
  // Melee
  slash:          { name: "Slash", category: "melee", minDmg: 10, maxDmg: 25, speed: 4, accuracyBonus: 15 },
  stab:           { name: "Stab", category: "melee", minDmg: 12, maxDmg: 22, speed: 4, accuracyBonus: 20, special: "armor_pierce" },
  crush:          { name: "Crush", category: "melee", minDmg: 8, maxDmg: 30, speed: 5, accuracyBonus: 10 },
  whip_flick:     { name: "Whip Flick", category: "melee", minDmg: 14, maxDmg: 24, speed: 4, accuracyBonus: 18 },
  godsword_smash: { name: "Godsword Smash", category: "melee", minDmg: 20, maxDmg: 45, speed: 6, accuracyBonus: 5 },
  // Ranged
  rapid_shot:     { name: "Rapid Shot", category: "ranged", minDmg: 8, maxDmg: 18, speed: 3, accuracyBonus: 12 },
  longrange_shot: { name: "Longrange Shot", category: "ranged", minDmg: 12, maxDmg: 24, speed: 5, accuracyBonus: 22 },
  crossbow_bolt:  { name: "Crossbow Bolt", category: "ranged", minDmg: 14, maxDmg: 28, speed: 5, accuracyBonus: 16, special: "bolt_proc" },
  knife_throw:    { name: "Knife Throw", category: "ranged", minDmg: 6, maxDmg: 14, speed: 2, accuracyBonus: 8 },
  dark_bow_spec:  { name: "Dark Bow", category: "ranged", minDmg: 25, maxDmg: 48, speed: 7, accuracyBonus: 10, special: "double_hit" },
  // Magic
  fire_blast:     { name: "Fire Blast", category: "magic", minDmg: 12, maxDmg: 26, speed: 5, accuracyBonus: 18 },
  ice_barrage:    { name: "Ice Barrage", category: "magic", minDmg: 10, maxDmg: 30, speed: 5, accuracyBonus: 14, special: "freeze" },
  blood_barrage:  { name: "Blood Barrage", category: "magic", minDmg: 8, maxDmg: 28, speed: 5, accuracyBonus: 14, special: "heal" },
  entangle:       { name: "Entangle", category: "magic", minDmg: 0, maxDmg: 0, speed: 5, accuracyBonus: 20, special: "bind" },
  teleblock:      { name: "Teleblock", category: "magic", minDmg: 0, maxDmg: 0, speed: 5, accuracyBonus: 16, special: "teleblock" },
  vengeance:      { name: "Vengeance", category: "magic", minDmg: 0, maxDmg: 0, speed: 5, accuracyBonus: 100, special: "vengeance" },
};

const SPECIALS: Record<string, SpecDef> = {
  ags_spec:   { name: "AGS Spec", weapon: "Armadyl Godsword", cost: 50, minDmg: 30, maxDmg: 55, hits: 1, effect: "accuracy_boost" },
  dds_spec:   { name: "DDS Spec", weapon: "Dragon Dagger", cost: 25, minDmg: 8, maxDmg: 20, hits: 2, effect: "poison" },
  gmaul_spec: { name: "GMaul Spec", weapon: "Granite Maul", cost: 50, minDmg: 15, maxDmg: 35, hits: 1, effect: "instant" },
  vls_spec:   { name: "VLS Spec", weapon: "Vesta's Longsword", cost: 25, minDmg: 20, maxDmg: 40, hits: 1, effect: "ignore_def" },
  dbow_spec:  { name: "Dark Bow Spec", weapon: "Dark Bow", cost: 55, minDmg: 16, maxDmg: 24, hits: 2, effect: "guaranteed_min" },
  zcb_spec:   { name: "ZCB Spec", weapon: "Zaryte Crossbow", cost: 50, minDmg: 18, maxDmg: 38, hits: 1, effect: "prayer_punish" },
  sgs_spec:   { name: "SGS Spec", weapon: "Saradomin Godsword", cost: 50, minDmg: 20, maxDmg: 40, hits: 1, effect: "heal_prayer" },
  staff_spec: { name: "Volatile Staff Spec", weapon: "Volatile Staff", cost: 50, minDmg: 25, maxDmg: 58, hits: 1, effect: "ignore_mage_def" },
  claws_spec: { name: "Dragon Claws Spec", weapon: "Dragon Claws", cost: 50, minDmg: 10, maxDmg: 30, hits: 4, effect: "cascade" },
};

// ── Helpers ──
function rand(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Combat triangle: returns accuracy modifier
function triangleModifier(attacker: CombatClass, defender: CombatClass): number {
  if (attacker === defender) return 1.0;
  if (
    (attacker === "melee" && defender === "ranged") ||
    (attacker === "ranged" && defender === "magic") ||
    (attacker === "magic" && defender === "melee")
  ) return 1.10; // 10% accuracy bonus
  return 0.90; // 10% penalty
}

// Accuracy roll (simplified RS formula)
function accuracyRoll(
  attackerAccBonus: number,
  attackerLevel: number,
  defenderDefLevel: number,
  triangleMod: number
): boolean {
  const attackRoll = Math.floor(attackerLevel * (attackerAccBonus + 64) * triangleMod);
  const defRoll = Math.floor(defenderDefLevel * 64);
  const maxRoll = Math.max(attackRoll, defRoll);
  if (maxRoll === 0) return true;
  const hitChance = attackRoll / (attackRoll + defRoll);
  return Math.random() < hitChance;
}

// ── Prayer Resolution ──
function normalizePrayerAction(prayer: PrayerAction): PrayerAction {
  if (prayer === "deflect_melee") return "protect_melee";
  if (prayer === "deflect_ranged") return "protect_ranged";
  if (prayer === "deflect_magic") return "protect_magic";
  return prayer;
}

function getPrayerDamageReduction(activePrayer: PrayerAction, incomingCategory: CombatClass): number {
  const protectionMap: Record<string, CombatClass> = {
    protect_melee: "melee",
    protect_ranged: "ranged",
    protect_magic: "magic",
  };
  const protects = protectionMap[normalizePrayerAction(activePrayer)];
  if (protects === incomingCategory) return 0.4;
  return 0;
}

function getPrayerDrain(prayer: PrayerAction): number {
  const normalized = normalizePrayerAction(prayer);
  if (normalized === "none") return 0;
  if (normalized.startsWith("protect_")) return 4;
  if (normalized === "smite") return 6;
  if (normalized === "piety" || normalized === "rigour" || normalized === "augury") return 5;
  return 4;
}

function getOffensivePrayerModifiers(prayer: PrayerAction, category: CombatClass): { accuracy: number; damage: number } {
  const normalized = normalizePrayerAction(prayer);
  if (normalized === "piety" && category === "melee") {
    return { accuracy: 1.2, damage: 1.23 };
  }
  if (normalized === "rigour" && category === "ranged") {
    return { accuracy: 1.2, damage: 1.23 };
  }
  if (normalized === "augury" && category === "magic") {
    return { accuracy: 1.25, damage: 1.04 };
  }
  return { accuracy: 1, damage: 1 };
}

// ── Food Resolution ──
function resolveFood(player: PlayerState, food: FoodAction): { healed: number; attackDelay: number; statDrain: boolean } {
  if (food === "none") return { healed: 0, attackDelay: 0, statDrain: false };

  const inv = player.food_remaining;
  switch (food) {
    case "eat_shark":
      if (inv.shark <= 0) return { healed: 0, attackDelay: 0, statDrain: false };
      inv.shark--;
      return { healed: 20, attackDelay: 1, statDrain: false };
    case "karambwan":
      if (inv.karambwan <= 0) return { healed: 0, attackDelay: 0, statDrain: false };
      inv.karambwan--;
      return { healed: 18, attackDelay: 0, statDrain: false }; // can combo
    case "brew_sip":
      if (inv.brew <= 0) return { healed: 0, attackDelay: 0, statDrain: false };
      inv.brew--;
      return { healed: 15, attackDelay: 1, statDrain: true };
    case "combo_eat": {
      let total = 0;
      let delay = 0;
      if (inv.shark > 0) { inv.shark--; total += 20; delay = 1; }
      if (inv.karambwan > 0) { inv.karambwan--; total += 18; }
      if (inv.brew > 0) { inv.brew--; total += 15; delay = 2; }
      return { healed: total, attackDelay: delay, statDrain: inv.brew >= 0 };
    }
    default:
      return { healed: 0, attackDelay: 0, statDrain: false };
  }
}

// ── Special Attack Resolution ──
function resolveSpecial(
  spec: SpecialAction,
  attacker: PlayerState,
  defender: PlayerState,
  _attackerStats: StatProfile,
  _defenderStats: StatProfile,
): { totalDamage: number; healed: number; prayerRestored: number; effects: string[] } {
  if (spec === "none") return { totalDamage: 0, healed: 0, prayerRestored: 0, effects: [] };

  const def = SPECIALS[spec];
  if (!def) return { totalDamage: 0, healed: 0, prayerRestored: 0, effects: [] };

  if (attacker.spec_bar < def.cost) return { totalDamage: 0, healed: 0, prayerRestored: 0, effects: ["not_enough_spec"] };

  attacker.spec_bar -= def.cost;
  let totalDamage = 0;
  let healed = 0;
  let prayerRestored = 0;
  const effects: string[] = [];

  for (let i = 0; i < def.hits; i++) {
    let hit = rand(def.minDmg, def.maxDmg);

    // Cascade effect for dragon claws
    if (def.effect === "cascade" && i > 0) {
      hit = Math.floor(hit * (1 - i * 0.2)); // diminishing hits
    }

    // Guaranteed minimum for dark bow
    if (def.effect === "guaranteed_min") {
      hit = Math.max(def.minDmg, hit);
    }

    // Prayer reduction
    const reduction = getPrayerDamageReduction(defender.active_prayer, attacker.combat_class);
    hit = Math.floor(hit * (1 - reduction));

    // ZCB bonus if praying
    if (def.effect === "prayer_punish" && defender.active_prayer !== "none") {
      hit = Math.floor(hit * 1.5);
    }

    totalDamage += hit;
  }

  // SGS heal + prayer restore
  if (def.effect === "heal_prayer") {
    healed = Math.floor(totalDamage * 0.5);
    prayerRestored = Math.floor(totalDamage * 0.25);
  }

  // DDS poison
  if (def.effect === "poison" && totalDamage > 0 && Math.random() < 0.25) {
    defender.poisoned = true;
    effects.push("poisoned");
  }

  // Ignore defence
  if (def.effect === "ignore_def") {
    effects.push("defence_ignored");
  }

  return { totalDamage, healed, prayerRestored, effects };
}

// ── Normal Attack Resolution ──
function resolveAttack(
  action: AttackAction | "none",
  attacker: PlayerState,
  defender: PlayerState,
  attackerStats: StatProfile,
  defenderStats: StatProfile,
): { damage: number; effects: string[] } {
  if (action === "none") return { damage: 0, effects: [] };

  const atk = ATTACKS[action];
  if (!atk) return { damage: 0, effects: [] };

  // Check attack delay
  if (attacker.attack_delay > 0) return { damage: 0, effects: ["delayed"] };

  const effects: string[] = [];

  // Get attacker level based on attack category
  let attackerLevel: number;
  if (atk.category === "melee") attackerLevel = Math.max(attackerStats.attack, attackerStats.strength);
  else if (atk.category === "ranged") attackerLevel = attackerStats.ranged;
  else attackerLevel = attackerStats.magic;

  const triMod = triangleModifier(atk.category, defender.combat_class);
  const prayerMods = getOffensivePrayerModifiers(attacker.active_prayer, atk.category);
  const effectiveAcc = Math.floor(atk.accuracyBonus * prayerMods.accuracy);
  const hit = accuracyRoll(effectiveAcc, attackerLevel, defenderStats.defence, triMod);

  if (!hit) return { damage: 0, effects: ["splash"] };

  let damage = rand(atk.minDmg, atk.maxDmg);
  damage = Math.floor(damage * prayerMods.damage);

  // Prayer reduction
  const reduction = getPrayerDamageReduction(defender.active_prayer, atk.category);
  if (reduction > 0) {
    damage = Math.floor(damage * (1 - reduction));
    effects.push("prayer_blocked");

  }

  // Bolt proc (25% chance for crossbow)
  if (atk.special === "bolt_proc" && Math.random() < 0.25) {
    const procDmg = rand(5, 15);
    damage += procDmg;
    effects.push(`bolt_proc_${procDmg}`);
  }

  // Freeze
  if (atk.special === "freeze" && damage > 0) {
    defender.frozen = 1;
    effects.push("frozen");
  }

  // Blood heal
  if (atk.special === "heal") {
    const heal = Math.floor(damage * 0.25);
    attacker.hp = Math.min(99, attacker.hp + heal);
    effects.push(`healed_${heal}`);
  }

  // Bind
  if (atk.special === "bind" && hit) {
    defender.frozen = 2;
    effects.push("bound");
  }

  // Teleblock
  if (atk.special === "teleblock" && hit) {
    defender.teleblocked = true;
    effects.push("teleblocked");
  }

  // Vengeance
  if (atk.special === "vengeance") {
    attacker.vengeance_active = true;
    effects.push("vengeance_cast");
    return { damage: 0, effects };
  }

  // Vengeance retaliation
  if (defender.vengeance_active && damage > 0) {
    const vengDmg = Math.floor(damage * 0.75);
    attacker.hp -= vengDmg;
    defender.vengeance_active = false;
    effects.push(`vengeance_hit_${vengDmg}`);
  }

  // Set attack cooldown
  attacker.attack_delay = atk.speed;

  return { damage, effects };
}

// ── Tick Resolution ──
export function resolveTick(fight: Fight): TickResult {
  const p1a = fight.pending_actions.p1;
  const p2a = fight.pending_actions.p2;
  if (!p1a || !p2a) {
    throw new Error("resolveTick requires both pending actions");
  }
  const p1 = fight.p1;
  const p2 = fight.p2;

  const p1Stats = STAT_PROFILES[p1.combat_class];
  const p2Stats = STAT_PROFILES[p2.combat_class];

  let p1DmgDealt = 0;
  let p2DmgDealt = 0;
  let p1Healed = 0;
  let p2Healed = 0;
  const narrativeParts: string[] = [];

  // 1. Prayer activation
  p1.active_prayer = normalizePrayerAction(p1a.prayer || "none");
  p2.active_prayer = normalizePrayerAction(p2a.prayer || "none");
  p1.prayer -= getPrayerDrain(p1.active_prayer);
  p2.prayer -= getPrayerDrain(p2.active_prayer);
  p1.prayer = Math.max(0, p1.prayer);
  p2.prayer = Math.max(0, p2.prayer);
  if (p1.prayer <= 0) p1.active_prayer = "none";
  if (p2.prayer <= 0) p2.active_prayer = "none";

  // 2. Food consumption
  const p1Food = resolveFood(p1, p1a.food || "none");
  const p2Food = resolveFood(p2, p2a.food || "none");
  p1.hp = Math.min(99, p1.hp + p1Food.healed);
  p2.hp = Math.min(99, p2.hp + p2Food.healed);
  p1.attack_delay = Math.max(p1.attack_delay, p1Food.attackDelay);
  p2.attack_delay = Math.max(p2.attack_delay, p2Food.attackDelay);
  p1Healed = p1Food.healed;
  p2Healed = p2Food.healed;
  if (p1Food.healed > 0) narrativeParts.push(`${p1.agent_id} eats for ${p1Food.healed} HP`);
  if (p2Food.healed > 0) narrativeParts.push(`${p2.agent_id} eats for ${p2Food.healed} HP`);

  // 3. Movement
  const p1Move = p1a.movement || "none";
  const p2Move = p2a.movement || "none";
  if (p1Move === "step_under") { p2.attack_delay = Math.max(p2.attack_delay, 1); narrativeParts.push(`${p1.agent_id} steps under`); }
  if (p2Move === "step_under") { p1.attack_delay = Math.max(p1.attack_delay, 1); narrativeParts.push(`${p2.agent_id} steps under`); }
  if (p1.frozen > 0 && (p1Move === "step_under" || p1Move === "run_away")) {
    narrativeParts.push(`${p1.agent_id} is frozen and can't move!`);
  }
  if (p2.frozen > 0 && (p2Move === "step_under" || p2Move === "run_away")) {
    narrativeParts.push(`${p2.agent_id} is frozen and can't move!`);
  }

  // 4. Special attacks
  const p1Spec = resolveSpecial(p1a.special || "none", p1, p2, p1Stats, p2Stats);
  const p2Spec = resolveSpecial(p2a.special || "none", p2, p1, p2Stats, p1Stats);

  if (p1Spec.totalDamage > 0) {
    p2.hp -= p1Spec.totalDamage;
    p1DmgDealt += p1Spec.totalDamage;
    p1.hp = Math.min(99, p1.hp + p1Spec.healed);
    p1.prayer = Math.min(99, p1.prayer + p1Spec.prayerRestored);
    const specName = SPECIALS[p1a.special || ""]?.weapon || p1a.special;
    narrativeParts.push(`${p1.agent_id} hits a ${specName} for ${p1Spec.totalDamage}!`);
  }
  if (p2Spec.totalDamage > 0) {
    p1.hp -= p2Spec.totalDamage;
    p2DmgDealt += p2Spec.totalDamage;
    p2.hp = Math.min(99, p2.hp + p2Spec.healed);
    p2.prayer = Math.min(99, p2.prayer + p2Spec.prayerRestored);
    const specName = SPECIALS[p2a.special || ""]?.weapon || p2a.special;
    narrativeParts.push(`${p2.agent_id} hits a ${specName} for ${p2Spec.totalDamage}!`);
  }

  // Smite drain from spec damage
  if (p1a.prayer === "smite" && p1DmgDealt > 0) {
    const drain = Math.floor(p1DmgDealt * 0.25);
    p2.prayer = Math.max(0, p2.prayer - drain);
  }
  if (p2a.prayer === "smite" && p2DmgDealt > 0) {
    const drain = Math.floor(p2DmgDealt * 0.25);
    p1.prayer = Math.max(0, p1.prayer - drain);
  }

  // 5. Normal attacks (only if no spec used and not delayed)
  if ((p1a.special || "none") === "none" && p1.attack_delay <= 0) {
    const p1Atk = resolveAttack(p1a.action || "none", p1, p2, p1Stats, p2Stats);
    if (p1Atk.damage > 0) {
      p2.hp -= p1Atk.damage;
      p1DmgDealt += p1Atk.damage;
      narrativeParts.push(`${p1.agent_id} hits ${p1a.action} for ${p1Atk.damage}`);
    } else if (p1a.action !== "none" && p1Atk.effects.includes("splash")) {
      narrativeParts.push(`${p1.agent_id}'s ${p1a.action} splashes!`);
    }
  }
  if ((p2a.special || "none") === "none" && p2.attack_delay <= 0) {
    const p2Atk = resolveAttack(p2a.action || "none", p2, p1, p2Stats, p1Stats);
    if (p2Atk.damage > 0) {
      p1.hp -= p2Atk.damage;
      p2DmgDealt += p2Atk.damage;
      narrativeParts.push(`${p2.agent_id} hits ${p2a.action} for ${p2Atk.damage}`);
    } else if (p2a.action !== "none" && p2Atk.effects.includes("splash")) {
      narrativeParts.push(`${p2.agent_id}'s ${p2a.action} splashes!`);
    }
  }

  // 6. Tick-end processing
  // Spec bar regen
  p1.spec_bar = Math.min(100, p1.spec_bar + 10);
  p2.spec_bar = Math.min(100, p2.spec_bar + 10);

  // Attack delay countdown
  p1.attack_delay = Math.max(0, p1.attack_delay - 1);
  p2.attack_delay = Math.max(0, p2.attack_delay - 1);

  // Freeze countdown
  p1.frozen = Math.max(0, p1.frozen - 1);
  p2.frozen = Math.max(0, p2.frozen - 1);

  // Poison tick
  if (p1.poisoned) { p1.hp -= 3; narrativeParts.push(`${p1.agent_id} takes 3 poison damage`); }
  if (p2.poisoned) { p2.hp -= 3; narrativeParts.push(`${p2.agent_id} takes 3 poison damage`); }

  // Clamp HP
  p1.hp = Math.max(0, p1.hp);
  p2.hp = Math.max(0, p2.hp);

  // Store last actions
  p1.last_action = p1a.action || "none";
  p2.last_action = p2a.action || "none";
  p1.last_special = p1a.special || "none";
  p2.last_special = p2a.special || "none";

  // Clear pending
  fight.pending_actions.p1 = null;
  fight.pending_actions.p2 = null;
  fight.tick++;

  const result: TickResult = {
    tick: fight.tick,
    p1_action: p1a.special !== "none" && p1a.special ? p1a.special : (p1a.action || "none"),
    p2_action: p2a.special !== "none" && p2a.special ? p2a.special : (p2a.action || "none"),
    p1_damage_dealt: p1DmgDealt,
    p2_damage_dealt: p2DmgDealt,
    p1_healed: p1Healed,
    p2_healed: p2Healed,
    narrative: narrativeParts.join(". ") || "Both fighters wait...",
  };

  fight.last_result = result;
  fight.history.push(result);

  // Check round end
  if (p1.hp <= 0 || p2.hp <= 0 || fight.tick >= 100) {
    fight.status = "round_over";
    if (p1.hp <= 0 && p2.hp > 0) {
      fight.rounds_won.p2++;
      result.narrative += ` ${p2.agent_id} wins the round! Sit.`;
    } else if (p2.hp <= 0 && p1.hp > 0) {
      fight.rounds_won.p1++;
      result.narrative += ` ${p1.agent_id} wins the round! Sit.`;
    } else if (fight.tick >= 100) {
      if (p1.hp > p2.hp) { fight.rounds_won.p1++; result.narrative += ` Timeout! ${p1.agent_id} wins on HP.`; }
      else if (p2.hp > p1.hp) { fight.rounds_won.p2++; result.narrative += ` Timeout! ${p2.agent_id} wins on HP.`; }
      // draw = no one gets a point
      else { result.narrative += " Timeout! Draw round."; }
    }

    // Check match end
    if (fight.rounds_won.p1 >= 2 || fight.rounds_won.p2 >= 2) {
      fight.status = "fight_over";
      const winner = fight.rounds_won.p1 >= 2 ? p1.agent_id : p2.agent_id;
      result.narrative += ` ${winner} wins the match! GG no re.`;
    }
  }

  return result;
}

// ── Create fresh player state ──
export function createPlayerState(agent_id: string, combat_class: CombatClass): PlayerState {
  return {
    agent_id,
    combat_class,
    hp: 99,
    prayer: 99,
    spec_bar: 100,
    food_remaining: { shark: 16, karambwan: 4, brew: 6 },
    active_prayer: "none",
    frozen: 0,
    teleblocked: false,
    poisoned: false,
    vengeance_active: false,
    attack_delay: 0,
    last_action: "none",
    last_special: "none",
  };
}
