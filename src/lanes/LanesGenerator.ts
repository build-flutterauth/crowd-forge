// Procedural Lane Battle levels, built with the same philosophy as the runner:
//   generate lanes → simulate strategies → size castle / waves / base → validate → tune or regenerate.
// Every lane must be a meaningfully different strategy: a level is rejected when
// "just shoot one lane forever" does as well as smart play.
import { LANES, type LaneKind } from '../config/lanesConfig';
import { Rng, SeedManager } from '../core/SeedManager';
import type { EnvId } from '../core/types';
import { niceRound, fmt } from '../sim/rules';
import {
  casualPolicy, fixedPolicy, shotOutput, simulate, smartPolicy,
  type LaneDef, type LaneEvent, type LaneLevelData, type StrategyResult, type Wave,
} from './LaneSim';

export interface LanesParams {
  seed: number;
  level: number;
  D: number;
  fireRate: number;
  env: EnvId;
}

export class LanesGenerator {
  generate(p: LanesParams): LaneLevelData {
    const t0 = performance.now();
    let best: LaneLevelData | null = null;
    for (let attempt = 0; attempt < LANES.maxAttempts; attempt++) {
      const lv = this.attempt(p, attempt);
      if (lv.report.valid) {
        lv.genMs = performance.now() - t0;
        return lv;
      }
      if (!best || lv.report.reasons.length < best.report.reasons.length || (best.report.best && !best.report.best.won && lv.report.best.won)) best = lv;
    }
    best!.genMs = performance.now() - t0;
    return best!;
  }

  // ------------------------------------------------------------------
  // lanes
  // ------------------------------------------------------------------

  private pickKinds(rng: Rng, level: number, n: number): LaneKind[] {
    if (level <= 1) return rng.shuffle<LaneKind>(['stack', 'multiplier', 'mixed']);
    const kinds: LaneKind[] = [];
    const all = Object.keys(LANES.kinds) as LaneKind[];
    for (let i = 0; i < n; i++) {
      const k = rng.weighted(all, (x) => {
        const d = LANES.kinds[x];
        if (d.minLevel > level) return 0;
        if (x === 'tower' && kinds.includes('tower')) return 0;
        if (x === 'multiplier' && kinds.filter((k) => k === 'multiplier').length >= (n >= 4 ? 2 : 1)) return 0;
        return d.weight * (kinds.includes(x) ? 0.3 : 1);
      })!;
      kinds.push(k);
    }
    // always keep one steady "safe" lane
    if (!kinds.some((k) => k === 'stack' || k === 'mixed')) kinds[rng.int(0, n - 1)] = 'stack';
    return rng.shuffle(kinds);
  }

  private buildLane(rng: Rng, kind: LaneKind, level: number, L: number, x0: number, x1: number): LaneDef {
    const ev: LaneEvent[] = [];
    switch (kind) {
      case 'stack': {
        const count = 8 + rng.int(0, Math.min(12, 2 + level));
        const s0 = 6;
        const s1 = L * 0.8;
        for (let i = 0; i < count; i++) {
          const v = level >= 8 && rng.chance(0.3) ? 2 : 1;
          ev.push({ s: s0 + ((s1 - s0) * i) / Math.max(1, count - 1), kind: 'gate', op: 'add', v });
        }
        break;
      }
      case 'multiplier': {
        ev.push({ s: rng.range(6, 10), kind: 'gate', op: 'mul', v: rng.pick(LANES.multipliers(level)) });
        if (level >= 5 && rng.chance(0.4)) ev.push({ s: rng.range(16, 24), kind: 'gate', op: 'add', v: rng.pick([5, 10, 20]) });
        break;
      }
      case 'tower': {
        if (rng.chance(0.55)) ev.push({ s: 7, kind: 'gate', op: 'mul', v: rng.pick([2, 3]) });
        ev.push({ s: L * rng.range(0.42, 0.58), kind: 'tower', mult: rng.pick(LANES.towerMultipliers(level)), hp: 0 });
        break;
      }
      case 'mixed': {
        const k = rng.int(2, level >= 4 ? 4 : 3);
        const pool: [LaneEvent['op'], number][] = [['mul', 2], ['mul', 3], ['add', 5], ['add', 10], ['add', 20]];
        if (level >= 6) pool.push(['mul', 4]);
        let product = 1;
        for (let i = 0; i < k; i++) {
          let [op, v] = rng.pick(pool);
          if (level >= 4 && i > 0 && rng.chance(0.25)) [op, v] = ['div', 2];
          ev.push({ s: 7 + i * ((L * 0.6) / k), kind: 'gate', op, v });
          product *= op === 'mul' ? v : op === 'div' ? 1 / v : 1;
        }
        if (product < 2) ev.push({ s: 7 + k * ((L * 0.6) / k), kind: 'gate', op: 'mul', v: 2 });
        break;
      }
    }
    ev.sort((a, b) => a.s - b.s);
    return { kind, x0, x1, events: ev };
  }

  // ------------------------------------------------------------------
  // waves
  // ------------------------------------------------------------------

  private genWaves(rng: Rng, lv: LaneLevelData, ratio: number, breaks: number[], focus: number): Wave[] {
    const T = lv.targetTime;
    const waves: Wave[] = [];
    const recent: number[] = [];
    const laneW: Record<LaneKind, number> = { multiplier: 2, tower: 1.4, mixed: 1.1, stack: 1 };
    let t = 6 + rng.range(0, 2);
    while (t < lv.maxTime) {
      const l = rng.weighted(lv.lanes.map((_, i) => i), (i) => laneW[lv.lanes[i].kind] * (recent.length >= 2 && recent.slice(-2).every((r) => r === i) ? 0 : 1))!;
      recent.push(l);
      const lane = lv.lanes[l];
      const broken = breaks[l] >= 0 && t > breaks[l] + 4;
      const tower = lane.events.find((e) => e.kind === 'tower');
      let out = shotOutput(lane, broken, lv.L * 0.55);
      if (out === 0 && tower) out = shotOutput(lane, false, tower.s - 0.01);
      const ramp = 0.75 + 0.6 * Math.min(1.6, t / T);
      const count = Math.max(3, Math.round(ratio * ramp * lv.fireRate * out * 2.2 * rng.range(0.8, 1.2)));
      waves.push({ t, lane: l, count });
      t += rng.range(6.5, 9.5) * (t > T ? 0.8 : 1);
    }
    // a big final push down the lane the optimal player relies on
    const ft = T * 0.82;
    const fl = lv.lanes[focus];
    const fbroken = breaks[focus] >= 0 && ft > breaks[focus] + 4;
    const fout = Math.max(1, shotOutput(fl, fbroken, lv.L * 0.55));
    waves.push({ t: ft, lane: focus, count: Math.round(ratio * 1.7 * lv.fireRate * fout * 2.2), final: true });
    waves.sort((a, b) => a.t - b.t);
    return waves;
  }

  // ------------------------------------------------------------------
  // one attempt
  // ------------------------------------------------------------------

  private attempt(p: LanesParams, attempt: number): LaneLevelData {
    const seed = SeedManager.attemptSeed(p.seed, attempt);
    const rng = new Rng(seed);
    const L = LANES.length;
    const n = LANES.laneCount(p.level, rng.next());
    const kinds = this.pickKinds(rng.fork('kinds'), p.level, n);
    const w = (LANES.halfWidth * 2) / n;
    const lanes = kinds.map((k, i) => this.buildLane(rng.fork('lane' + i), k, p.level, L, -LANES.halfWidth + i * w, -LANES.halfWidth + (i + 1) * w));
    const T = LANES.targetTime(p.level);
    const notes: string[] = [];

    // tower HP: a few seconds of that lane's pre-tower fire, scaled by difficulty
    for (const lane of lanes) {
      const tw = lane.events.find((e) => e.kind === 'tower');
      if (tw) {
        const pre = shotOutput(lane, false, tw.s - 0.01);
        tw.hp = niceRound(p.fireRate * pre * rng.range(5, 8.5) * (0.85 + 0.35 * p.D));
      }
    }

    const lv: LaneLevelData = {
      seed: p.seed, code: SeedManager.toCode(p.seed), attempt, level: p.level, D: p.D, env: p.env, L,
      fireRate: p.fireRate, lanes, waves: [], castleHP: 1e18, baseHP: 1, targetTime: T, maxTime: T * 2.2,
      report: { valid: false, reasons: [], best: { name: '', won: false, time: 0, baseLeft: 0, kills: 0 }, strategies: [], casualWinRate: 0, waveRatio: 0, notes },
      genMs: 0,
    };
    const names = lanes.map((l, i) => `${LANES.kinds[l.kind].name} (lane ${i + 1})`);

    // 1) Castle HP from the optimal strategy's damage curve without enemies.
    let bestFocus = 0;
    let bestCurve: number[] = [];
    let bestBreaks: number[] = [];
    lanes.forEach((_, j) => {
      const curve: number[] = [];
      const breaks: number[] = [];
      simulate(lv, smartPolicy(j), { noWaves: true, castleHP: Infinity, maxT: T, curve, towerBreaks: breaks });
      const v = curve[Math.round(T * 0.72)] ?? curve[curve.length - 1] ?? 0;
      if (v > (bestCurve[Math.round(T * 0.72)] ?? -1)) {
        bestFocus = j;
        bestCurve = curve;
        bestBreaks = breaks;
      }
    });
    lv.castleHP = Math.max(100, niceRound(bestCurve[Math.round(T * 0.72)] ?? 100));
    let ratio = LANES.waveRatio(p.D);

    // 2) Waves + base, then tune against simulated players.
    const reasons: string[] = [];
    let strategies: StrategyResult[] = [];
    let best: StrategyResult = { name: '', won: false, time: 0, baseLeft: 0, kills: 0 };
    let casualWin = 0;
    for (let it = 0; it < LANES.tuneIterations; it++) {
      reasons.length = 0;
      lv.waves = this.genWaves(rng.fork('waves' + it), lv, ratio, bestBreaks, bestFocus);
      const counts = lv.waves.map((w) => w.count).sort((a, b) => a - b);
      lv.baseHP = Math.max(20, niceRound(counts[counts.length >> 1] * LANES.baseRatio));
      lv.report.waveRatio = ratio;

      strategies = lanes.map((_, j) => ({ ...simulate(lv, smartPolicy(j)), name: `Smart, focus ${names[j]}` }));
      const won = strategies.filter((s) => s.won).sort((a, b) => a.time - b.time);
      best = won[0] ?? strategies.slice().sort((a, b) => b.baseLeft - a.baseLeft)[0];
      if (!best.won) {
        ratio *= 0.8;
        reasons.push('impossible: optimal strategy loses');
        continue;
      }
      if (best.time > T * 1.3) {
        lv.castleHP = niceRound(lv.castleHP * 0.8);
        reasons.push('too slow for optimal play');
        continue;
      }
      if (best.time < T * 0.5) {
        lv.castleHP = niceRound(lv.castleHP * 1.25);
        reasons.push('too quick for optimal play');
        continue;
      }
      let wins = 0;
      const crng = rng.fork('casual' + it);
      for (let k = 0; k < LANES.casualRuns; k++) if (simulate(lv, casualPolicy(), { rng: crng.fork(k) }).won) wins++;
      casualWin = wins / LANES.casualRuns;
      const [lo, hi] = LANES.casualWinBand(p.D);
      if (casualWin > hi) {
        ratio *= 1.2;
        reasons.push(`trivially easy (casual win ${Math.round(casualWin * 100)}%)`);
        continue;
      }
      if (casualWin < lo) {
        ratio *= 0.86;
        reasons.push(`excessively punishing (casual win ${Math.round(casualWin * 100)}%)`);
        continue;
      }
      break;
    }

    // 3) Lanes must matter: single-lane play should be clearly worse than smart play.
    const naive = lanes.map((_, j) => ({ ...simulate(lv, fixedPolicy(j)), name: `Only ever shoot ${names[j]}` }));
    const naiveGood = naive.filter((s) => s.won && s.time < best.time * 1.15);
    if (naiveGood.length === naive.length) reasons.push('lanes do not matter (every single-lane strategy wins)');
    if (new Set(kinds).size < 2) reasons.push('dominated by one lane type');

    lv.report = {
      valid: reasons.length === 0,
      reasons: reasons.slice(),
      best: { ...best },
      strategies: [...strategies, ...naive],
      casualWinRate: casualWin,
      waveRatio: ratio,
      notes: [
        `optimal: ${best.name} in ${best.time.toFixed(0)}s (target ${T.toFixed(0)}s)`,
        `castle ${fmt(lv.castleHP)} · base ${fmt(lv.baseHP)} · ${lv.waves.length} waves (biggest ${fmt(Math.max(...lv.waves.map((w) => w.count)))})`,
      ],
    };
    return lv;
  }
}
