// Procedural Arena levels: generate bay layouts → simulate strategies → size
// fortress / horde / base → validate (best play wins on time, casual players in
// a difficulty band, aim matters) → tune or regenerate deterministically.
import { ARENA, type BayKind } from '../config/arenaConfig';
import { Rng, SeedManager } from '../core/SeedManager';
import type { EnvId } from '../core/types';
import { fmt, niceRound } from '../sim/rules';
import {
  bayOutput, casualArenaPolicy, focusPolicy, simulateArena, smartArenaPolicy,
  type ArenaGate, type ArenaLevelData, type ArenaStrategy, type ArenaWave, type Bay,
} from './ArenaSim';

export interface ArenaParams {
  seed: number;
  level: number;
  D: number;
  fireRate: number;
  env: EnvId;
}

export class ArenaGenerator {
  generate(p: ArenaParams): ArenaLevelData {
    const t0 = performance.now();
    let best: ArenaLevelData | null = null;
    for (let a = 0; a < ARENA.maxAttempts; a++) {
      const lv = this.attempt(p, a);
      if (lv.report.valid) {
        lv.genMs = performance.now() - t0;
        return lv;
      }
      if (!best || lv.report.reasons.length < best.report.reasons.length) best = lv;
    }
    best!.genMs = performance.now() - t0;
    return best!;
  }

  private kinds(rng: Rng, level: number, n: number): BayKind[] {
    if (level <= 1) return rng.shuffle<BayKind>(['open', 'hedged', 'stack']);
    const all = Object.keys(ARENA.bayKinds) as BayKind[];
    const out: BayKind[] = [];
    for (let i = 0; i < n; i++) {
      out.push(rng.weighted(all, (k) => {
        const d = ARENA.bayKinds[k];
        if (d.minLevel > level) return 0;
        if ((k === 'hedged' || k === 'trap') && out.includes(k)) return 0.15;
        return d.weight * (out.includes(k) ? 0.35 : 1);
      })!);
    }
    // always something playable from the start, and something worth breaking into
    if (!out.some((k) => k === 'open' || k === 'stack')) out[rng.int(0, n - 1)] = 'open';
    if (!out.includes('hedged') && !out.includes('hedgeAfter') && rng.chance(0.75)) {
      const i = out.findIndex((k) => k !== 'open' && k !== 'stack');
      out[i >= 0 ? i : (out.indexOf('stack') >= 0 ? out.indexOf('stack') : 0)] = 'hedged';
      if (!out.some((k) => k === 'open' || k === 'stack')) out[(out.indexOf('hedged') + 1) % n] = 'open';
    }
    return rng.shuffle(out);
  }

  private bay(rng: Rng, kind: BayKind, level: number, x0: number, x1: number, D: number, fireRate: number): Bay {
    const [z0, z1] = ARENA.gateZone;
    const small = ARENA.smallMults(level);
    const big = ARENA.bigMults(level);
    const g = (s: number, op: ArenaGate['op'], v: number): ArenaGate => ({ s, x0, x1, op, v });
    const b: Bay = { kind, x0, x1, gates: [] };
    switch (kind) {
      case 'open':
        b.gates.push(g(z0 + rng.range(2, 5), 'mul', rng.pick(small)));
        if (level >= 3 && rng.chance(0.4)) b.gates.push(g(z0 + 9 + rng.range(0, 3), 'add', rng.pick([10, 20, 50])));
        break;
      case 'stack': {
        const k = rng.int(2, 3);
        for (let i = 0; i < k; i++) b.gates.push(g(z0 + 4 + i * 1.9, rng.chance(0.7) ? 'mul' : 'add', 0));
        for (const gt of b.gates) gt.v = gt.op === 'mul' ? rng.pick(small.slice(0, 2)) : rng.pick([5, 10, 20]);
        break;
      }
      case 'hedged': {
        const k = level <= 2 ? rng.int(1, 2) : rng.int(2, 3);
        const v = rng.pick(big);
        for (let i = 0; i < k; i++) b.gates.push(g(z1 - 6 + i * 1.9, 'mul', v));
        b.hedge = { s0: z0 + 2, s1: z0 + 5, x0, x1, hp: 0 };
        break;
      }
      case 'hedgeAfter': {
        b.gates.push(g(z0 + 2, 'mul', rng.pick(big)));
        b.gates.push(g(z0 + 4, 'mul', rng.pick(small)));
        b.hedge = { s0: z1 - 6, s1: z1 - 3, x0, x1, hp: 0 };
        break;
      }
      case 'trap': {
        b.gates.push(g(z0 + 3, rng.chance(0.5) ? 'div' : 'mul', rng.chance(0.5) ? 2 : 3));
        if (b.gates[0].op === 'mul') b.gates.push(g(z0 + 7, 'div', rng.pick([3, 4])));
        else b.gates.push(g(z0 + 7, 'add', rng.pick([5, 10])));
        break;
      }
    }
    if (b.hedge) {
      // seconds of raw fire needed to chew through, scaled by difficulty and what's before it
      const pre = b.gates.filter((gt) => gt.s < b.hedge!.s0).reduce((w, gt) => (gt.op === 'mul' ? w * gt.v : gt.op === 'add' ? w + gt.v : w), 1);
      b.hedge.hp = niceRound(fireRate * pre * rng.range(4, 7.5) * (0.8 + 0.4 * D));
    }
    b.gates.sort((a, c) => a.s - c.s);
    return b;
  }

  private waves(rng: Rng, lv: ArenaLevelData, ratio: number, focus: number, breaks: number[]): ArenaWave[] {
    const T = lv.targetTime;
    const out: ArenaWave[] = [];
    let t = 4 + rng.range(0, 2);
    const fb = lv.bays[focus];
    while (t < lv.maxTime) {
      const broken = breaks[focus] >= 0 && t > breaks[focus] + 3;
      // the horde is sized against what the best plan can push through the gap right now
      let o = bayOutput(fb, broken || !fb.hedge);
      if (o === 0) o = Math.max(...lv.bays.map((b) => bayOutput(b, false)));
      const ramp = 0.7 + 0.6 * Math.min(1.6, t / T);
      out.push({ t, count: Math.max(4, Math.round(ratio * ramp * lv.fireRate * o * 2.4 * rng.range(0.8, 1.2))) });
      t += rng.range(5.5, 8.5) * (t > T ? 0.8 : 1);
    }
    const fo = Math.max(1, bayOutput(fb, breaks[focus] >= 0 || !fb.hedge));
    out.push({ t: T * 0.8, count: Math.round(ratio * 1.6 * lv.fireRate * fo * 2.4), final: true });
    return out.sort((a, c) => a.t - c.t);
  }

  private attempt(p: ArenaParams, attempt: number): ArenaLevelData {
    const seed = SeedManager.attemptSeed(p.seed, attempt);
    const rng = new Rng(seed);
    const n = ARENA.bayCount(p.level, rng.next());
    const kinds = this.kinds(rng.fork('kinds'), p.level, n);
    // bay widths: the middle bays a little wider, like a real arena layout
    const HW = ARENA.halfWidth;
    const ws = kinds.map((_, i) => (i === 0 || i === n - 1 ? 1 : 1.35) * rng.range(0.85, 1.15));
    const tot = ws.reduce((a, b) => a + b, 0);
    let x = -HW;
    const bays = kinds.map((k, i) => {
      const w = (ws[i] / tot) * HW * 2;
      const b = this.bay(rng.fork('bay' + i), k, p.level, x, x + w, p.D, p.fireRate);
      x += w;
      return b;
    });
    const T = ARENA.targetTime(p.level);
    const lv: ArenaLevelData = {
      seed: p.seed, code: SeedManager.toCode(p.seed), attempt, level: p.level, D: p.D, env: p.env, fireRate: p.fireRate,
      bays, waves: [], castleHP: 1, baseHP: 1, targetTime: T, maxTime: T * 2.2,
      report: { valid: false, reasons: [], best: { name: '', won: false, time: 0, baseLeft: 0, kills: 0 }, strategies: [], casualWinRate: 0, waveRatio: 0, notes: [] },
      genMs: 0,
    };
    const names = bays.map((b, i) => `${ARENA.bayKinds[b.kind].name} (bay ${i + 1})`);

    // 1) fortress HP from the best focus without enemies
    let focus = 0;
    let curve: number[] = [];
    let breaks: number[] = [];
    const at = Math.round(T * 0.72);
    bays.forEach((_, j) => {
      const c: number[] = [];
      const br: number[] = [];
      simulateArena(lv, focusPolicy(j), { noWaves: true, castleHP: Infinity, maxT: T, curve: c, hedgeBreaks: br });
      if ((c[at] ?? 0) > (curve[at] ?? -1)) {
        focus = j;
        curve = c;
        breaks = br;
      }
    });
    lv.castleHP = Math.max(150, niceRound(curve[at] ?? 150));

    // 2) horde + base, tuned against simulated players
    let ratio = ARENA.waveRatio(p.D);
    const reasons: string[] = [];
    let strategies: ArenaStrategy[] = [];
    let best: ArenaStrategy = lv.report.best;
    let casual = 0;
    for (let it = 0; it < ARENA.tuneIterations; it++) {
      reasons.length = 0;
      lv.waves = this.waves(rng.fork('w' + it), lv, ratio, focus, breaks);
      const counts = lv.waves.map((w) => w.count).sort((a, b) => a - b);
      lv.baseHP = Math.max(20, niceRound(counts[counts.length >> 1] * ARENA.baseRatio));
      strategies = bays.map((_, j) => ({ ...simulateArena(lv, smartArenaPolicy(j)), name: `Smart, target ${names[j]}` }));
      const won = strategies.filter((s) => s.won).sort((a, b) => a.time - b.time);
      best = won[0] ?? strategies.slice().sort((a, b) => b.baseLeft - a.baseLeft)[0];
      if (!best.won) {
        ratio *= 0.8;
        reasons.push('impossible: best plan loses');
        continue;
      }
      if (best.time > T * 1.3) {
        lv.castleHP = niceRound(lv.castleHP * 0.8);
        reasons.push('too slow for best play');
        continue;
      }
      if (best.time < T * 0.5) {
        lv.castleHP = niceRound(lv.castleHP * 1.25);
        reasons.push('too quick for best play');
        continue;
      }
      let wins = 0;
      const crng = rng.fork('c' + it);
      for (let k = 0; k < ARENA.casualRuns; k++) if (simulateArena(lv, casualArenaPolicy(), { rng: crng.fork(k) }).won) wins++;
      casual = wins / ARENA.casualRuns;
      const [lo, hi] = ARENA.casualWinBand(p.D);
      if (casual > hi) {
        ratio *= 1.2;
        reasons.push(`trivially easy (casual win ${Math.round(casual * 100)}%)`);
        continue;
      }
      if (casual < lo) {
        ratio *= 0.86;
        reasons.push(`excessively punishing (casual win ${Math.round(casual * 100)}%)`);
        continue;
      }
      break;
    }
    // 3) aiming must matter
    const fixed = bays.map((_, j) => ({ ...simulateArena(lv, focusPolicy(j)), name: `Only ever aim at ${names[j]}` }));
    if (fixed.every((s) => s.won && s.time < best.time * 1.15)) reasons.push('aim does not matter (every bay wins as fast)');
    if (new Set(bays.map((b) => Math.round(bayOutput(b, true)))).size < 2) reasons.push('bays too similar');

    lv.report = {
      valid: reasons.length === 0,
      reasons: reasons.slice(),
      best: { ...best },
      strategies: [...strategies, ...fixed],
      casualWinRate: casual,
      waveRatio: ratio,
      notes: [
        `best: ${best.name} in ${best.time.toFixed(0)}s (target ${T.toFixed(0)}s)`,
        `fortress ${fmt(lv.castleHP)} · base ${fmt(lv.baseHP)} · ${lv.waves.length} waves (biggest ${fmt(Math.max(...lv.waves.map((w) => w.count)))})`,
      ],
    };
    return lv;
  }
}
