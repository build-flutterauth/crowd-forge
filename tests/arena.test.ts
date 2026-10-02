import { describe, expect, it } from 'vitest';
import { GEN } from '../src/config/genConfig';
import { ArenaGenerator } from '../src/arena/ArenaGenerator';
import { applyArenaGate, bayOutput, focusPolicy, simulateArena, smartArenaPolicy, splitCount } from '../src/arena/ArenaSim';

const gen = new ArenaGenerator();

describe('arena (main mode)', () => {
  it('gate rules', () => {
    expect(applyArenaGate(1, 'mul', 99)).toBe(99);
    expect(applyArenaGate(10, 'sub', 20)).toBe(0);
    expect(splitCount(99)).toBe(6);
  });

  it('hedges seal their bay until broken', () => {
    const lv = gen.generate({ seed: 3, level: 6, D: 0.6, fireRate: 7, env: 'grasslands' });
    for (const b of lv.bays) if (b.hedge && b.gates.every((g) => g.s > b.hedge!.s0)) expect(bayOutput(b, false)).toBe(0);
  });

  it('is deterministic', () => {
    const p = { seed: 41, level: 9, D: 0.75, fireRate: 7, env: 'grasslands' as const };
    const a = gen.generate(p);
    const b = gen.generate(p);
    expect(JSON.stringify(a.bays)).toBe(JSON.stringify(b.bays));
    expect(JSON.stringify(a.waves)).toBe(JSON.stringify(b.waves));
    expect(a.castleHP).toBe(b.castleHP);
  });

  it('best play wins and aiming matters', () => {
    for (let i = 0; i < 10; i++) {
      const L = 1 + i * 3;
      const lv = gen.generate({ seed: 900 + i, level: L, D: GEN.baseDifficulty(L), fireRate: 7, env: 'grasslands' });
      const smart = lv.bays.map((_, j) => simulateArena(lv, smartArenaPolicy(j))).filter((r) => r.won);
      expect(smart.length, `L${L} ${lv.code}`).toBeGreaterThan(0);
      const best = Math.min(...smart.map((s) => s.time));
      const fixed = lv.bays.map((_, j) => simulateArena(lv, focusPolicy(j)));
      expect(fixed.every((f) => f.won && f.time < best * 1.15), `L${L} aim should matter`).toBe(false);
    }
  });
});
