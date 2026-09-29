import { describe, expect, it } from 'vitest';
import { GEN } from '../src/config/genConfig';
import { LanesGenerator } from '../src/lanes/LanesGenerator';
import { applyLaneGate, fixedPolicy, simulate, smartPolicy, splitCount } from '../src/lanes/LaneSim';

const gen = new LanesGenerator();

describe('lane battle', () => {
  it('gate rules and splitting', () => {
    expect(applyLaneGate(1, 'mul', 88)).toBe(88);
    expect(applyLaneGate(5, 'add', 1)).toBe(6);
    expect(splitCount(88)).toBe(6);
    expect(splitCount(2)).toBe(2);
  });

  it('is deterministic', () => {
    const p = { seed: 99, level: 7, D: 0.7, fireRate: 6, env: 'grasslands' as const };
    const a = gen.generate(p);
    const b = gen.generate(p);
    expect(JSON.stringify(a.lanes)).toBe(JSON.stringify(b.lanes));
    expect(JSON.stringify(a.waves)).toBe(JSON.stringify(b.waves));
    expect(a.castleHP).toBe(b.castleHP);
  });

  it('optimal play wins and lanes matter', () => {
    for (let i = 0; i < 12; i++) {
      const L = 1 + i * 2;
      const lv = gen.generate({ seed: 500 + i, level: L, D: GEN.baseDifficulty(L), fireRate: 6, env: 'grasslands' });
      const best = lv.lanes.map((_, j) => simulate(lv, smartPolicy(j))).filter((r) => r.won);
      expect(best.length, `L${L} ${lv.code}`).toBeGreaterThan(0);
      const naive = lv.lanes.map((_, j) => simulate(lv, fixedPolicy(j)));
      const bestT = Math.min(...best.map((b) => b.time));
      expect(naive.every((n) => n.won && n.time < bestT * 1.15), `L${L} lanes should matter`).toBe(false);
      expect(new Set(lv.lanes.map((l) => l.kind)).size).toBeGreaterThan(1);
    }
  });
});
