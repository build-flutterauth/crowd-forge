// Lane Battle tuning. A cannon fires soldiers up parallel walled lanes; each lane
// is a different strategy (gate stacks, big multipliers, breakable jackpot towers)
// while enemy waves march down lanes toward your base.

export type LaneKind = 'stack' | 'multiplier' | 'tower' | 'mixed';

export const LANES = {
  halfWidth: 7,
  length: 62,
  cannonS: 1.2,
  unitSpeed: 9,
  enemySpeed: 2.8,
  fireRate: 6,
  fireRatePerUpgrade: 0.25,
  /** a ×N gate splits a group into min(N, splitMax) groups (same rule in sim and play) */
  splitMax: 6,
  playerCap: 1400,
  enemyCap: 1400,
  laneSwitchTime: 0.22, // seconds of no fire per lane moved
  simDt: 0.1,
  casualRuns: 16,
  maxAttempts: 8,
  tuneIterations: 7,

  kinds: {
    stack: { weight: 1.2, minLevel: 1, name: 'Gate Stack' },
    multiplier: { weight: 1.1, minLevel: 1, name: 'Big Multiplier' },
    tower: { weight: 1.0, minLevel: 2, name: 'Jackpot Tower' },
    mixed: { weight: 0.9, minLevel: 1, name: 'Mixed Gates' },
  } as Record<LaneKind, { weight: number; minLevel: number; name: string }>,

  laneCount(level: number, roll: number): number {
    if (level <= 1) return 3;
    if (level >= 6 && roll < 0.3) return 4;
    return roll < 0.12 ? 2 : 3;
  },
  /** seconds the best strategy should take to win */
  targetTime(level: number): number {
    return 48 + Math.min(30, level) * 0.7;
  },
  multipliers(level: number): number[] {
    if (level < 3) return [4, 5, 8, 10];
    if (level < 8) return [8, 10, 15, 20, 25];
    if (level < 15) return [20, 25, 40, 50, 88];
    return [40, 50, 88, 100, 150];
  },
  towerMultipliers(level: number): number[] {
    if (level < 4) return [20, 30, 50];
    if (level < 10) return [88, 100, 250];
    if (level < 18) return [250, 500, 888];
    return [888, 2500, 8888];
  },
  /** enemy wave size relative to what the defending lane can output */
  waveRatio(D: number): number {
    return 0.45 + 0.5 * D;
  },
  baseRatio: 1.6,
  /** acceptable casual-player win rate for difficulty D */
  casualWinBand(D: number): [number, number] {
    return [Math.max(0.15, 0.75 - 0.4 * D), Math.min(0.97, 1.05 - 0.3 * D)];
  },
};
