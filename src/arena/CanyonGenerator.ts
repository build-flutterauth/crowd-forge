// Procedural Canyon Siege levels: roll gate, turrets and canyon shape → simulate
// build orders → size the horde so the best plan wins near the target time and
// casual players land in a difficulty band → reject layouts where turrets don't
// matter. Deterministic per seed + attempt, like every other generator.
import { CANYON, type TurretKind } from '../config/canyonConfig';
import { Rng, SeedManager } from '../core/SeedManager';
import { fmt, niceRound } from '../sim/rules';
import type { ArenaStrategy } from './ArenaSim';
import type { ArenaParams } from './ArenaGenerator';
import { casualCanyonPolicy, simulateCanyon, smartCanyonPolicy, type CanyonLevelData, type TurretSpec } from './CanyonSim';

export class CanyonGenerator {
  generate(p: ArenaParams): CanyonLevelData {
    const t0 = performance.now();
    let best: CanyonLevelData | null = null;
    for (let a = 0; a < CANYON.maxAttempts; a++) {
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

  private turret(rng: Rng, kind: TurretKind, fireRate: number, C: number): TurretSpec {
    const d = CANYON.turrets[kind];
    const c0 = niceRound(fireRate * d.cost * rng.range(0.9, 1.2));
    const costs = d.dps.map((_, i) => (i === 0 ? c0 : niceRound(c0 * Math.pow(d.costGrowth, i))));
    const f = rng.range(0.9, 1.1);
    return { kind, costs, dps: d.dps.map((x) => x * C * f) };
  }

  private attempt(p: ArenaParams, attempt: number): CanyonLevelData {
    const seed = SeedManager.attemptSeed(p.seed, attempt);
    const rng = new Rng(seed);
    const gateMult = rng.pick(CANYON.gateMults(p.level));
    const C = p.fireRate * gateMult;
    const small = this.turret(rng.fork('small'), 'small', p.fireRate, C);
    const big = this.turret(rng.fork('big'), 'big', p.fireRate, C);
    const smallLeft = rng.chance(0.5);
    const T = CANYON.targetTime(p.level);
    const surges = [];
    for (let t = 14 + rng.range(0, 4); t < T * 2; t += rng.range(11, 16)) surges.push({ t, dur: rng.range(2.5, 3.5), mult: rng.range(1.5, 1.9) });
    const lv: CanyonLevelData = {
      seed: p.seed, code: SeedManager.toCode(p.seed), attempt, level: p.level, D: p.D, env: p.env, fireRate: p.fireRate,
      gateMult, turrets: smallLeft ? [small, big] : [big, small],
      horde: niceRound(C * T * 1.2), baseHP: 1,
      release: { rate: 0, rampT: T * 0.8, surges },
      path: { amp: rng.range(2.6, 4), freq: (Math.PI * 2) / rng.range(26, 34), phase: rng.chance(0.5) ? 0 : Math.PI },
      targetTime: T, maxTime: T * 2,
      report: { valid: false, reasons: [], best: { name: '', won: false, time: 0, baseLeft: 0, kills: 0 }, strategies: [], casualWinRate: 0, ratio: 0, notes: [] },
      genMs: 0,
    };
    const S = smallLeft ? 0 : 1;
    const B = 1 - S;
    const nm = (i: number) => CANYON.turrets[lv.turrets[i].kind].name;
    const plans: number[][] = [[], [S], [B], [S, B], [B, S], [S, B, S], [S, B, B], [S, S, B], [S, B, S, B], [S, B, S, B, S, B]];
    const planName = (pl: number[]) => {
      if (!pl.length) return 'Gate only, no turrets';
      const seen = [0, 0];
      return 'Build ' + pl.map((i) => `${nm(i)} ${++seen[i] > 1 ? `Lv${seen[i]}` : ''}`.trim()).join(' → ') + ', then gate';
    };

    let ratio = CANYON.releaseRatio(p.D);
    const reasons: string[] = [];
    let strategies: ArenaStrategy[] = [];
    let best: ArenaStrategy = lv.report.best;
    let casual = 0;
    for (let it = 0; it < CANYON.tuneIterations; it++) {
      reasons.length = 0;
      lv.release.rate = ratio * C;
      lv.baseHP = Math.max(20, niceRound(ratio * C * 2.5));
      strategies = plans.map((pl) => ({ ...simulateCanyon(lv, smartCanyonPolicy(pl)), name: planName(pl) }));
      const won = strategies.filter((s) => s.won).sort((a, b) => a.time - b.time);
      best = won[0] ?? strategies.slice().sort((a, b) => b.baseLeft - a.baseLeft)[0];
      if (!best.won) {
        ratio *= 0.85;
        reasons.push('impossible: best plan loses');
        continue;
      }
      if (best.time > T * 1.25 || best.time < T * 0.75) {
        lv.horde = niceRound(lv.horde * Math.max(0.5, Math.min(1.8, T / best.time)));
        reasons.push(best.time > T ? 'too slow for best play' : 'too quick for best play');
        continue;
      }
      let wins = 0;
      const crng = rng.fork('c' + it);
      for (let k = 0; k < CANYON.casualRuns; k++) if (simulateCanyon(lv, casualCanyonPolicy(), { rng: crng.fork(k) }).won) wins++;
      casual = wins / CANYON.casualRuns;
      const [lo, hi] = CANYON.casualWinBand(p.D);
      if (casual > hi) {
        ratio *= 1.15;
        reasons.push(`trivially easy (casual win ${Math.round(casual * 100)}%)`);
        continue;
      }
      if (casual < lo) {
        ratio *= 0.87;
        reasons.push(`excessively punishing (casual win ${Math.round(casual * 100)}%)`);
        continue;
      }
      break;
    }
    // turrets must matter
    const gateOnly = strategies[0];
    if (gateOnly.won && gateOnly.time < best.time * 1.1) reasons.push('turrets do not matter (gate only wins as fast)');

    lv.report = {
      valid: reasons.length === 0,
      reasons: reasons.slice(),
      best: { ...best },
      strategies,
      casualWinRate: casual,
      ratio,
      notes: [
        `best: ${best.name} in ${best.time.toFixed(0)}s (target ${T.toFixed(0)}s)`,
        `horde ${fmt(lv.horde)} · base ${fmt(lv.baseHP)} · gate ×${gateMult} · release ${fmt(lv.release.rate)}/s`,
        `turrets: ${lv.turrets.map((tu) => `${CANYON.turrets[tu.kind].name} [${tu.costs.join('/')}]`).join(' | ')}`,
      ],
    };
    return lv;
  }
}
