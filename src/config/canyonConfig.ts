// Canyon Siege tuning: a special Arena level (every 5th level). The cannon sits
// on a plaza at the foot of a winding cliff-top canyon. At the canyon mouth a
// barricade holds a ×N gate flanked by two gatling turrets, which are built (and
// upgraded) by firing soldiers into them. A huge horde pours down the canyon:
// wipe it all out before it overruns the cannon.

export type TurretKind = 'small' | 'big';

export interface CanyonPath { amp: number; freq: number; phase: number }

export const CANYON = {
  halfWidth: 8,
  cannonS: 1.2,
  wallS: 12, // barricade line: turret pads + gate
  gateS: 11.6,
  slotHalf: 3.1, // the gate takes the middle; the turret pads take the sides
  mouthS: 13,
  topS: 48, // where the horde emerges
  pathHalf: 2.9,
  unitSpeed: 7.5,
  enemySpeed: 3,
  enemyChase: 2.4,
  turretRange: 26, // turrets reach this far up the canyon past the wall
  switchTime: 0.12,
  playerCap: 1600,
  enemyCap: 1600,
  simDt: 0.1,
  casualRuns: 16,
  maxAttempts: 6,
  tuneIterations: 10,

  isCanyonLevel(level: number): boolean {
    return level >= 5 && level % 5 === 0;
  },
  gateMults(level: number): number[] {
    return level < 15 ? [50, 88, 99] : level < 30 ? [99, 150] : [150, 250];
  },
  /** per tier, relative to the gate's throughput (fireRate × gate) */
  turrets: {
    small: { name: 'Gatling', cost: 1.4, costGrowth: 3.5, dps: [0.22, 0.45, 0.85] },
    big: { name: 'Mega Gatling', cost: 6, costGrowth: 3.2, dps: [0.65, 1.3, 2.3] },
  } as Record<TurretKind, { name: string; cost: number; costGrowth: number; dps: number[] }>,
  targetTime(level: number): number {
    return 45 + Math.min(30, level) * 0.5;
  },
  /** horde release rate relative to the gate's throughput */
  releaseRatio(D: number): number {
    return 0.95 + 0.6 * D;
  },
  casualWinBand(D: number): [number, number] {
    return [Math.max(0.15, 0.75 - 0.4 * D), Math.min(0.97, 1.05 - 0.3 * D)];
  },
};

function smooth(k: number): number {
  const c = Math.max(0, Math.min(1, k));
  return c * c * (3 - 2 * c);
}

/** Lateral centre of the canyon at depth s (straight at the mouth, S-curve above). */
export function pathCenter(p: CanyonPath, s: number): number {
  if (s <= CANYON.mouthS) return 0;
  return smooth((s - CANYON.mouthS) / 8) * p.amp * Math.sin((s - CANYON.mouthS) * p.freq + p.phase);
}

/** Aim slot for a cannon x: 0 = left turret, 1 = gate, 2 = right turret. */
export function slotAt(x: number): number {
  return x < -CANYON.slotHalf ? 0 : x > CANYON.slotHalf ? 2 : 1;
}
