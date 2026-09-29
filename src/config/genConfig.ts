// Procedural generation parameters. Tune the game here, not in the systems.
import type { Beat, BossId, GateOp, LossModel, ObstacleId, RareEventId, SegmentType } from '../core/types';

export interface SegmentTypeDef {
  weight: number;
  minLevel: number;
  beats: Beat[];
  length: number;
}

export interface ObstacleDef {
  name: string;
  minLevel: number;
  length: number;
  /** fraction of the army lost for skilled / average / worst play (hard gameplay cap) */
  loss: LossModel;
  weight: number;
}

export interface RareDef {
  name: string;
  minLevel: number;
  weight: number;
  beats: Beat[];
  length: number;
  banner: string;
}

export const GEN = {
  // ---- level shape ----
  segmentsBase: 10,
  segmentsPerLevel: 0.6,
  segmentsMax: 30,
  segmentsJitter: 2,
  runwayStart: 34,
  segmentGap: 8,

  // ---- candidate search ----
  candidatesPerSlot: 14,
  topK: 3,
  maxLevelAttempts: 10,
  populationSize: 64,
  levelEvalAgentsPerSkill: 120,

  // ---- validation ----
  /** best route must beat every enemy by this ratio (avg obstacle losses) */
  minBattleMargin: 1.12,
  /** minimum army the best route should keep before an obstacle */
  minArmyBeforeObstacle: 6,
  /** hard ceiling for normal levels (mathematically broken above this) */
  softCapNormal: 40000,
  /** best route may not exceed the growth curve by more than this factor */
  maxGrowthOvershoot: 2.6,
  hardCapNormal: 250000,
  maxTypeShare: 0.4,
  maxGateOpShare: 0.5,
  maxConsecutiveSameType: 2,
  maxRarePerLevel: 2,
  minRareSpacing: 4,
  rareChance: 0.1,

  /** allowed per-segment death rate of the currently alive simulated population */
  segDeathBase: 0.04,
  segDeathPerIntensity: 0.16,

  /** level-wide acceptance bands on average-skill death rate, as a function of difficulty D */
  avgDeathBand(D: number): [number, number] {
    const lo = Math.max(0, 0.08 * (D - 0.55));
    const hi = Math.min(0.6, 0.1 + 0.34 * D);
    return [lo, hi];
  },
  /** random-choice players must fail at least this often (else level is trivial) */
  minRandomDeath(D: number): number {
    return D < 0.6 ? 0 : Math.min(0.35, 0.12 * (D - 0.5));
  },
  /** skilled players should rarely fail (else excessively punishing) */
  maxSkilledDeath(D: number): number {
    return Math.min(0.35, 0.05 + 0.18 * D);
  },

  // ---- difficulty ----
  baseDifficulty(level: number): number {
    return 0.3 + 0.9 * (1 - Math.exp(-(level - 1) / 14)) + 0.004 * Math.max(0, level - 30);
  },
  /** intensity multiplier across a level: easy start, rising middle, big finish */
  curve: [
    [0.0, 0.35],
    [0.15, 0.45],
    [0.35, 0.65],
    [0.55, 0.8],
    [0.7, 0.72], // breather dip before the climb
    [0.85, 0.95],
    [1.0, 1.1],
  ] as [number, number][],

  /** expected army of the best route at the end of level L (growth steering) */
  growthTarget(level: number, startArmy: number): number {
    return Math.max(startArmy * 6, 70 * Math.pow(level, 1.1));
  },

  enemyRatio: { min: 0.16, max: 0.62 },

  // ---- finale ----
  bossEvery: 5,
  bossChance: 0.18,
  finaleRatio: { min: 0.42, max: 0.8 },
  bossBounds(level: number): [number, number] {
    return [12 + 8 * level, 260 * Math.pow(level, 1.25)];
  },

  // ---- bonus runway ----
  runwayMults: [2, 3, 5, 10, 25, 50, 100, 500, 1000],
  runwayWallShare: [0.08, 0.1, 0.12, 0.15, 0.17, 0.18, 0.2, 0.35, 0.45],
  runwayStepSpacing: 26,

  // ---- endless ----
  endlessSegmentsPerTier: 5,
  endlessTierIntensity(tier: number): number {
    return 0.35 + 0.13 * tier;
  },
  endlessEnemyRatioCap: 0.95,
};

export const SEGMENT_TYPES: Record<Exclude<SegmentType, 'finale'>, SegmentTypeDef> = {
  gateChoice: { weight: 1.2, minLevel: 1, beats: ['decision'], length: 34 },
  enemyBattle: { weight: 1.0, minLevel: 1, beats: ['battle', 'majorBattle'], length: 34 },
  obstacle: { weight: 0.9, minLevel: 2, beats: ['obstacle'], length: 40 },
  reward: { weight: 0.55, minLevel: 1, beats: ['reward', 'breather', 'bigReward'], length: 30 },
  riskReward: { weight: 0.75, minLevel: 3, beats: ['decision', 'bigReward'], length: 50 },
  miniBoss: { weight: 0.35, minLevel: 4, beats: ['majorBattle', 'battle'], length: 38 },
  recruitment: { weight: 0.6, minLevel: 1, beats: ['reward', 'breather'], length: 34 },
  narrowSurvival: { weight: 0.5, minLevel: 3, beats: ['obstacle'], length: 46 },
  multiGatePuzzle: { weight: 0.55, minLevel: 3, beats: ['decision', 'bigReward'], length: 58 },
  combination: { weight: 0.75, minLevel: 2, beats: ['battle', 'decision', 'majorBattle'], length: 56 },
};

export const OBSTACLES: Record<ObstacleId, ObstacleDef> = {
  rotatingBar: { name: 'Rotating Bar', minLevel: 2, length: 16, loss: { best: 0.02, avg: 0.1, worst: 0.22 }, weight: 1 },
  crusher: { name: 'Crushers', minLevel: 2, length: 16, loss: { best: 0.0, avg: 0.09, worst: 0.2 }, weight: 1 },
  movingWall: { name: 'Moving Wall', minLevel: 3, length: 18, loss: { best: 0.03, avg: 0.12, worst: 0.25 }, weight: 1 },
  swingingHammer: { name: 'Swinging Hammers', minLevel: 3, length: 20, loss: { best: 0.02, avg: 0.1, worst: 0.22 }, weight: 1 },
  spikeZone: { name: 'Spike Zone', minLevel: 2, length: 18, loss: { best: 0.0, avg: 0.1, worst: 0.22 }, weight: 1 },
  narrowPassage: { name: 'Narrow Passage', minLevel: 3, length: 14, loss: { best: 0.03, avg: 0.14, worst: 0.3 }, weight: 0.9 },
  fallingObjects: { name: 'Falling Rocks', minLevel: 4, length: 22, loss: { best: 0.02, avg: 0.08, worst: 0.18 }, weight: 0.9 },
  enemyTower: { name: 'Archer Towers', minLevel: 5, length: 24, loss: { best: 0.03, avg: 0.08, worst: 0.16 }, weight: 0.8 },
  projectileLauncher: { name: 'Cannon', minLevel: 4, length: 24, loss: { best: 0.02, avg: 0.09, worst: 0.2 }, weight: 0.9 },
  movingPlatforms: { name: 'Moving Platforms', minLevel: 6, length: 12, loss: { best: 0.05, avg: 0.16, worst: 0.32 }, weight: 0.7 },
  lavaZone: { name: 'Lava Pools', minLevel: 5, length: 20, loss: { best: 0.0, avg: 0.1, worst: 0.24 }, weight: 0.9 },
  stealTrap: { name: 'Vortex Trap', minLevel: 6, length: 18, loss: { best: 0.02, avg: 0.1, worst: 0.2 }, weight: 0.8 },
};

export const RARE_EVENTS: Record<RareEventId, RareDef> = {
  goldenGate: { name: 'Golden Gate', minLevel: 3, weight: 1, beats: ['bigReward', 'decision'], length: 56, banner: 'GOLDEN GATE' },
  horde: { name: 'Horde', minLevel: 3, weight: 1, beats: ['majorBattle', 'battle'], length: 40, banner: 'HORDE!' },
  jackpot: { name: 'Jackpot', minLevel: 2, weight: 0.9, beats: ['bigReward', 'reward'], length: 62, banner: 'JACKPOT' },
  gauntlet: { name: 'Gauntlet', minLevel: 5, weight: 0.8, beats: ['obstacle'], length: 70, banner: 'GAUNTLET' },
  giantBattle: { name: 'Giant Battle', minLevel: 4, weight: 0.8, beats: ['majorBattle'], length: 56, banner: 'GIANT BATTLE' },
  doubleOrNothing: { name: 'Double or Nothing', minLevel: 4, weight: 0.9, beats: ['decision', 'bigReward'], length: 34, banner: 'DOUBLE OR NOTHING' },
  rescue: { name: 'Rescue', minLevel: 2, weight: 1, beats: ['reward', 'breather'], length: 44, banner: 'RESCUE!' },
  ambush: { name: 'Ambush', minLevel: 4, weight: 0.9, beats: ['battle', 'majorBattle'], length: 36, banner: 'AMBUSH!' },
  shortcut: { name: 'Shortcut', minLevel: 5, weight: 0.8, beats: ['decision', 'bigReward'], length: 60, banner: 'SHORTCUT' },
};

/** Level at which each gate operation starts appearing */
export const GATE_UNLOCK: Record<GateOp, number> = {
  add: 1, mul: 1, sub: 2, div: 3,
  shield: 4, speed: 4, recruit: 3, merge: 5,
  clone: 6, doubleNext: 6, mystery: 5,
  sacrifice: 8, split: 7, bet: 4, vault: 1,
};

/** Special gate weights inside a gate row (relative) */
export const SPECIAL_GATE_WEIGHTS: Partial<Record<GateOp, number>> = {
  shield: 1, speed: 0.8, recruit: 1, merge: 0.7, clone: 0.8, doubleNext: 0.7, mystery: 0.9, sacrifice: 0.6,
};

/** Multipliers available by level */
export function unlockedMultipliers(level: number, endlessTier = -1): number[] {
  const m = [2, 3];
  if (level >= 4 || endlessTier >= 1) m.push(4);
  if (level >= 6 || endlessTier >= 2) m.push(5);
  if (level >= 12 || endlessTier >= 4) m.push(10);
  if (endlessTier >= 7) m.push(25);
  return m;
}

export const CANONICAL_ADDS = [1, 5, 10, 25, 50];
export const CANONICAL_SUBS = [5, 10, 25, 50];
export const DIVISORS = [2, 3, 4];

/** Pacing grammar: phrases the Fun Director strings together */
export const PACING_PHRASES: { beats: Beat[]; weight: number; minProgress: number; maxProgress: number }[] = [
  { beats: ['decision', 'battle'], weight: 1.4, minProgress: 0, maxProgress: 1 },
  { beats: ['decision', 'reward'], weight: 1.0, minProgress: 0, maxProgress: 0.6 },
  { beats: ['reward', 'decision', 'battle'], weight: 0.8, minProgress: 0, maxProgress: 0.7 },
  { beats: ['obstacle', 'breather'], weight: 0.9, minProgress: 0.15, maxProgress: 1 },
  { beats: ['decision', 'decision', 'majorBattle'], weight: 0.8, minProgress: 0.35, maxProgress: 1 },
  { beats: ['bigReward', 'majorBattle'], weight: 0.7, minProgress: 0.45, maxProgress: 1 },
  { beats: ['obstacle', 'decision', 'battle'], weight: 0.9, minProgress: 0.2, maxProgress: 1 },
  { beats: ['breather'], weight: 0.4, minProgress: 0.2, maxProgress: 0.9 },
  { beats: ['bigReward', 'obstacle', 'decision', 'majorBattle'], weight: 0.5, minProgress: 0.55, maxProgress: 1 },
];

export const FUN_WEIGHTS = {
  novelty: 1.0,
  difficulty: 1.3,
  risk: 0.6,
  spectacle: 0.7,
  decision: 0.9,
  pacing: 1.1,
  growth: 1.0,
};

/** Recency penalties used by the variety history */
export const VARIETY = {
  historySize: 8,
  typePenalty: [0.55, 0.3, 0.15, 0.08],
  gateComboPenalty: 0.6,
  obstaclePenalty: [0.7, 0.4, 0.2, 0.1, 0.05],
  formationPenalty: 0.25,
  rarePenalty: 0.8,
  envHistory: 4,
  bossHistory: 3,
};

export const BOSSES: Record<BossId, { name: string; title: string; color: string; accent: string; weight: number }> = {
  giant: { name: 'Giant', title: 'THE GIANT', color: '#c9774a', accent: '#6b3a21', weight: 1 },
  tank: { name: 'Tank', title: 'IRON TANK', color: '#5f7a4a', accent: '#2f3d25', weight: 1 },
  castle: { name: 'Castle', title: 'LIVING CASTLE', color: '#9aa0a8', accent: '#5a4b3c', weight: 0.9 },
  dragon: { name: 'Dragon', title: 'EMBER DRAGON', color: '#c0392b', accent: '#f1c40f', weight: 0.9 },
  robot: { name: 'Robot', title: 'MEGA ROBOT', color: '#7f8c9d', accent: '#00d2ff', weight: 1 },
  megaArmy: { name: 'Mega Army', title: 'THE MEGA ARMY', color: '#e74c3c', accent: '#2c3e50', weight: 0.8 },
};

/** Minimum level at which each boss can appear */
export const BOSS_MIN_LEVEL: Record<BossId, number> = { giant: 1, tank: 3, castle: 5, dragon: 8, robot: 6, megaArmy: 4 };
