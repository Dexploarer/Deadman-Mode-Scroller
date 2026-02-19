import type { AgentProgress, AttackAction, SkillName, SkillState } from "./types";

export const XP_MULTIPLIER = 1.12;
const MAX_LEVEL = 99;

const SKILL_ORDER: SkillName[] = [
  "attack",
  "strength",
  "defence",
  "hitpoints",
  "ranged",
  "magic",
  "prayer",
  "mining",
  "fishing",
  "woodcutting",
  "runecrafting",
  "sailing",
];

const XP_TABLE = buildXpTable();

function buildXpTable(): number[] {
  const table = [0];
  let points = 0;
  for (let level = 1; level <= MAX_LEVEL; level++) {
    points += Math.floor(level + 300 * 2 ** (level / 7));
    table[level] = Math.floor(points / 4);
  }
  return table;
}

export function getXpForLevel(level: number): number {
  if (level <= 1) return 0;
  if (level >= MAX_LEVEL) return XP_TABLE[MAX_LEVEL] ?? 0;
  return XP_TABLE[level - 1] ?? 0;
}

export function getLevelForXp(xp: number): number {
  let level = 1;
  for (let i = 1; i <= MAX_LEVEL; i++) {
    if (xp >= (XP_TABLE[i] ?? Number.MAX_SAFE_INTEGER)) {
      level = i + 1;
    } else {
      break;
    }
  }
  return Math.min(MAX_LEVEL, Math.max(1, level));
}

export function createDefaultSkills(): Record<SkillName, SkillState> {
  const base: Partial<Record<SkillName, SkillState>> = {};
  for (const skill of SKILL_ORDER) {
    base[skill] = { level: 1, xp: 0 };
  }

  // OSRS-like starting hitpoints.
  base.hitpoints = { level: 10, xp: getXpForLevel(10) };

  return base as Record<SkillName, SkillState>;
}

export function createDefaultProgress(agent_id: string): AgentProgress {
  return {
    agent_id,
    skills: createDefaultSkills(),
    inventory: {},
    updated_at: Date.now(),
  };
}

export interface XpGain {
  skill: SkillName;
  gained_xp: number;
  old_level: number;
  new_level: number;
  total_xp: number;
}

export function addXp(progress: AgentProgress, skill: SkillName, baseXp: number): XpGain {
  const scaled = Math.max(0, Math.floor(baseXp * XP_MULTIPLIER));
  const current = progress.skills[skill] ?? { level: 1, xp: 0 };
  const oldLevel = current.level;
  const nextXp = current.xp + scaled;
  const nextLevel = getLevelForXp(nextXp);

  progress.skills[skill] = {
    level: nextLevel,
    xp: nextXp,
  };
  progress.updated_at = Date.now();

  return {
    skill,
    gained_xp: scaled,
    old_level: oldLevel,
    new_level: nextLevel,
    total_xp: nextXp,
  };
}

export function addInventory(progress: AgentProgress, itemId: string, qty = 1): number {
  const nextQty = Math.max(0, (progress.inventory[itemId] ?? 0) + qty);
  progress.inventory[itemId] = nextQty;
  progress.updated_at = Date.now();
  return nextQty;
}

export function getInventoryQty(progress: AgentProgress, itemId: string): number {
  return Math.max(0, progress.inventory[itemId] ?? 0);
}

export function consumeInventory(progress: AgentProgress, itemId: string, qty = 1): boolean {
  if (qty <= 0) return true;
  const current = getInventoryQty(progress, itemId);
  if (current < qty) return false;
  progress.inventory[itemId] = current - qty;
  progress.updated_at = Date.now();
  return true;
}

export function getSkillLevel(progress: AgentProgress, skill: SkillName): number {
  return progress.skills[skill]?.level ?? 1;
}

function getMeleeXpSkill(action: AttackAction): SkillName {
  if (action === "slash") return "attack";
  if (action === "stab") return "defence";
  return "strength";
}

export function applyCombatXp(progress: AgentProgress, action: AttackAction | "none", damage: number): XpGain[] {
  if (action === "none" || damage <= 0) return [];

  const gains: XpGain[] = [];
  const baseDamageXp = Math.max(1, Math.floor(damage * 4));

  if (
    action === "slash" ||
    action === "stab" ||
    action === "crush" ||
    action === "whip_flick" ||
    action === "godsword_smash"
  ) {
    gains.push(addXp(progress, getMeleeXpSkill(action), baseDamageXp));
    gains.push(addXp(progress, "hitpoints", Math.max(1, Math.floor(damage * 1.33))));
    return gains;
  }

  if (
    action === "rapid_shot" ||
    action === "longrange_shot" ||
    action === "crossbow_bolt" ||
    action === "knife_throw" ||
    action === "dark_bow_spec"
  ) {
    gains.push(addXp(progress, "ranged", baseDamageXp));
    gains.push(addXp(progress, "hitpoints", Math.max(1, Math.floor(damage * 1.33))));
    return gains;
  }

  gains.push(addXp(progress, "magic", baseDamageXp));
  gains.push(addXp(progress, "hitpoints", Math.max(1, Math.floor(damage * 1.33))));
  return gains;
}
