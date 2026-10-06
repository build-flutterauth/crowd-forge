import { describe, expect, it } from 'vitest';
import { GEN } from '../src/config/genConfig';
import { CANYON, pathCenter, slotAt } from '../src/config/canyonConfig';
import { CanyonGenerator } from '../src/arena/CanyonGenerator';
import { nextCost, simulateCanyon, smartCanyonPolicy } from '../src/arena/CanyonSim';

const gen = new CanyonGenerator();

describe('canyon siege (special arena level)', () => {
  it('every 5th arena level is a canyon siege', () => {
    expect([1, 4, 5, 6, 10, 15].map((l) => CANYON.isCanyonLevel(l))).toEqual([false, false, true, false, true, true]);
  });

  it('layout rules', () => {
    expect([slotAt(-6), slotAt(0), slotAt(6)]).toEqual([0, 1, 2]);
    const p = { amp: 3.5, freq: 0.2, phase: 0 };
    expect(pathCenter(p, CANYON.mouthS)).toBe(0);
    for (let s = CANYON.mouthS; s <= CANYON.topS; s += 1) expect(Math.abs(pathCenter(p, s))).toBeLessThanOrEqual(3.5);
    const lv = gen.generate({ seed: 5, level: 5, D: 0.5, fireRate: 7, env: 'grasslands' });
    expect(lv.turrets.map((t) => t.kind).sort()).toEqual(['big', 'small']);
    for (const t of lv.turrets) {
      expect(nextCost(t, t.costs.length)).toBe(Infinity);
      for (let i = 1; i < t.costs.length; i++) expect(t.costs[i]).toBeGreaterThan(t.costs[i - 1]);
    }
  });

  it('is deterministic', () => {
    const p = { seed: 41, level: 10, D: 0.75, fireRate: 7, env: 'grasslands' as const };
    const a = gen.generate(p);
    const b = gen.generate(p);
    expect(JSON.stringify({ ...a, genMs: 0 })).toBe(JSON.stringify({ ...b, genMs: 0 }));
  });

  it('best play wins and turrets matter', () => {
    for (let i = 0; i < 6; i++) {
      const L = 5 + i * 5;
      const lv = gen.generate({ seed: 900 + i, level: L, D: GEN.baseDifficulty(L), fireRate: 7, env: 'grasslands' });
      expect(lv.report.best.won, `L${L} ${lv.code}`).toBe(true);
      const gateOnly = simulateCanyon(lv, smartCanyonPolicy([]));
      expect(gateOnly.won && gateOnly.time < lv.report.best.time * 1.1, `L${L} turrets should matter`).toBe(false);
    }
  }, 60000);
});
