// Arena (main mode) tuning. Mob-Control style: a free-moving cannon fires
// soldiers through bays of multiplier gates (some sealed behind hedges); the
// army funnels into a hedge-lined gap where the enemy horde pours down.

export type BayKind = 'open' | 'stack' | 'hedged' | 'hedgeAfter' | 'trap';

export const ARENA = {
  halfWidth: 8,
  length: 44,
  cannonS: 1.2,
  gateZone: [7, 24] as [number, number],
  funnel: { mouthS: 29, mouthHalf: 2.6, topS: 41, topHalf: 6.2 },
  unitSpeed: 7.5,
  enemySpeed: 3.2,
  steerSpeed: 5, // lateral convergence into the funnel
  enemyChase: 2.4, // lateral speed of enemies hunting the cannon
  fireRate: 7,
  fireRatePerUpgrade: 0.3,
  splitMax: 6,
  playerCap: 1600,
  enemyCap: 1600,
  switchTime: 0.12, // seconds of no fire when moving between bays
  simDt: 0.1,
  casualRuns: 16,
  maxAttempts: 8,
  tuneIterations: 7,

  bayCount(level: number, roll: number): number {
    if (level <= 1) return 3;
    return roll < 0.2 ? 2 : roll < 0.75 ? 3 : 4;
  },
  bayKinds: {
    open: { weight: 1.2, minLevel: 1, name: 'Open gate' },
    stack: { weight: 1.0, minLevel: 1, name: 'Gate stack' },
    hedged: { weight: 1.1, minLevel: 1, name: 'Hedge-sealed jackpot' },
    hedgeAfter: { weight: 0.6, minLevel: 4, name: 'Gates then hedge' },
    trap: { weight: 0.5, minLevel: 3, name: 'Trap bay' },
  } as Record<BayKind, { weight: number; minLevel: number; name: string }>,
  smallMults(level: number): number[] {
    return level < 3 ? [2, 3, 5] : level < 8 ? [3, 5, 10] : level < 15 ? [5, 10, 20] : [10, 20, 30];
  },
  bigMults(level: number): number[] {
    return level < 3 ? [10, 15, 20] : level < 8 ? [20, 30, 50] : level < 15 ? [50, 88, 99] : [99, 150, 250];
  },
  targetTime(level: number): number {
    return 40 + Math.min(30, level) * 0.6;
  },
  waveRatio(D: number): number {
    return 0.5 + 0.5 * D;
  },
  baseRatio: 1.5,
  casualWinBand(D: number): [number, number] {
    return [Math.max(0.15, 0.75 - 0.4 * D), Math.min(0.97, 1.05 - 0.3 * D)];
  },
};

export function funnelHalf(s: number): number {
  const f = ARENA.funnel;
  if (s <= f.mouthS) return ARENA.halfWidth;
  const k = Math.min(1, (s - f.mouthS) / (f.topS - f.mouthS));
  return f.mouthHalf + (f.topHalf - f.mouthHalf) * k;
}

/** Below the mouth the field narrows toward the gap so the army converges. */
export function corridorHalf(s: number): number {
  const f = ARENA.funnel;
  const z1 = ARENA.gateZone[1] + 1;
  if (s <= z1) return ARENA.halfWidth;
  if (s <= f.mouthS) return ARENA.halfWidth + (f.mouthHalf - ARENA.halfWidth) * ((s - z1) / (f.mouthS - z1));
  return funnelHalf(s);
}
