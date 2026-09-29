import { describe, expect, it } from 'vitest';
import { GEN } from '../src/config/genConfig';
import { Rng, SeedManager } from '../src/core/SeedManager';
import { EndlessGenerator, LevelGenerator } from '../src/gen/LevelGenerator';
import { bestPath } from '../src/sim/Simulator';
import { applyBattle, applyGate, applySplitRow, newArmy, obstacleLoss } from '../src/sim/rules';

const gen = new LevelGenerator();

describe('rules', () => {
  it('applies arithmetic gates', () => {
    const a = newArmy(8);
    applyGate(a, { op: 'add', v: 20 });
    expect(a.n).toBe(28);
    applyGate(a, { op: 'mul', v: 3 });
    expect(a.n).toBe(84);
    applyGate(a, { op: 'div', v: 4 });
    expect(a.n).toBe(21);
    applyGate(a, { op: 'sub', v: 25 });
    expect(a.dead).toBe(true);
  });

  it('best choice depends on army size (the core decision)', () => {
    const small = newArmy(8), small2 = newArmy(8);
    applyGate(small, { op: 'add', v: 20 });
    applyGate(small2, { op: 'mul', v: 3 });
    expect(small.n).toBeGreaterThan(small2.n); // 28 > 24
    const big = newArmy(50), big2 = newArmy(50);
    applyGate(big, { op: 'add', v: 20 });
    applyGate(big2, { op: 'mul', v: 3 });
    expect(big2.n).toBeGreaterThan(big.n); // 150 > 70
  });

  it('double-next, shield, sacrifice/vault and split behave', () => {
    const a = newArmy(10);
    applyGate(a, { op: 'doubleNext', v: 1 });
    applyGate(a, { op: 'mul', v: 3 });
    expect(a.n).toBe(60);
    applyGate(a, { op: 'shield', v: 50 });
    applyBattle(a, 20);
    expect(a.n).toBe(60); // shield (33) absorbed it
    applyGate(a, { op: 'sacrifice', v: 50 });
    expect(a.n).toBe(30);
    applyGate(a, { op: 'vault', v: 0 });
    expect(a.n).toBe(120);
    const s = newArmy(10);
    applySplitRow(s, { op: 'mul', v: 3 }, { op: 'add', v: 20 }, 'actual');
    expect(s.n).toBe(15 + 25);
  });

  it('obstacle loss is bounded by the loss fraction', () => {
    expect(obstacleLoss(100, 0.2)).toBe(20);
    expect(obstacleLoss(3, 0.2)).toBe(1);
    expect(obstacleLoss(0, 0.5)).toBe(0);
  });
});

describe('level generator', () => {
  it('is deterministic for the same seed and parameters', () => {
    const p = { seed: 424242, levelNumber: 9, difficulty: 0.75, startArmy: 6 };
    const a = gen.generate(p);
    const b = gen.generate(p);
    expect(JSON.stringify(a.segments)).toBe(JSON.stringify(b.segments));
    expect(a.env).toBe(b.env);
  });

  it('different seeds produce different levels', () => {
    const a = gen.generate({ seed: 1, levelNumber: 5, difficulty: 0.6, startArmy: 5 });
    const b = gen.generate({ seed: 2, levelNumber: 5, difficulty: 0.6, startArmy: 5 });
    expect(a.segments.map((s) => s.sig).join()).not.toBe(b.segments.map((s) => s.sig).join());
  });

  it('every generated level has a surviving route under worst-case obstacle play', () => {
    for (let i = 0; i < 30; i++) {
      const L = 1 + (i % 25);
      const lv = gen.generate({ seed: SeedManager.levelSeed(77, i), levelNumber: L, difficulty: GEN.baseDifficulty(L), startArmy: 5 });
      let st = newArmy(lv.startArmy);
      for (const seg of lv.segments) st = bestPath(st, seg.stages, 1, 'worst').state;
      expect(st.dead, `seed ${lv.code} L${L}`).toBe(false);
      expect(lv.segments.length).toBeGreaterThanOrEqual(GEN.segmentsBase - 1);
      expect(lv.segments.length).toBeLessThanOrEqual(GEN.segmentsMax + 1);
    }
  });

  it('never repeats a segment type more than twice in a row', () => {
    for (let i = 0; i < 20; i++) {
      const lv = gen.generate({ seed: 1000 + i, levelNumber: 10, difficulty: 0.9, startArmy: 5 });
      const types = lv.segments.map((s) => s.type);
      for (let k = 2; k < types.length; k++) expect(types[k] === types[k - 1] && types[k] === types[k - 2]).toBe(false);
    }
  });

  it('records why each segment was chosen', () => {
    const lv = gen.generate({ seed: 5, levelNumber: 6, difficulty: 0.7, startArmy: 5 });
    for (const s of lv.segments) {
      expect(s.reason.length).toBeGreaterThan(5);
      expect(s.before).toBeDefined();
    }
    expect(lv.genLog.length).toBe(lv.segments.length);
  });
});

describe('endless generator', () => {
  it('keeps producing valid segments as tiers rise', () => {
    const e = new EndlessGenerator(gen, 99, 5, 30);
    let army = newArmy(5);
    const rng = new Rng(3);
    for (let i = 0; i < 40; i++) {
      const seg = e.next(1, 0.7, 1);
      expect(seg.stages.length).toBeGreaterThan(0);
      // play the best route to keep the army realistic
      army = bestPath(army, seg.stages, 0.5, 'actual').state;
      if (army.dead) army = newArmy(10 + rng.int(0, 50));
    }
    expect(e.tier).toBeGreaterThanOrEqual(7);
  });
});
