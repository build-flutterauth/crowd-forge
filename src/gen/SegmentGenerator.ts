// Produces candidate segments (drafts). Each generator reasons about the
// simulated army sizes it is given so the numbers on gates and enemies are
// meaningful for the player right now — not arbitrary random values.
import {
  CANONICAL_ADDS, CANONICAL_SUBS, DIVISORS, GATE_UNLOCK, GEN, OBSTACLES, RARE_EVENTS, SEGMENT_TYPES,
  SPECIAL_GATE_WEIGHTS, unlockedMultipliers,
} from '../config/genConfig';
import type { Rng } from '../core/SeedManager';
import type {
  EnemyKind, Formation, GateOp, GateSpec, LossModel, ObstacleId, RareEventId, SegmentType, SimOp, VarietyKeys,
} from '../core/types';
import { applyGate, cloneArmy, niceRound, type ArmyState } from '../sim/rules';

const HW = 5;

export type DraftOp = SimOp & { ds: number };
export interface DraftRoute { x0: number; x1: number; ops: DraftOp[]; label?: string }
export interface StageDraft { ds: number; routes: DraftRoute[]; divider?: { x: number; ds0: number; ds1: number } }

export interface SegmentDraft {
  type: SegmentType;
  rare?: RareEventId;
  variant: string;
  length: number;
  stages: StageDraft[];
  sig: string;
  keys: VarietyKeys;
  spectacle: number;
  note: string;
}

export interface GenCtx {
  rng: Rng;
  level: number;
  D: number;
  I: number;
  progress: number;
  opt: ArmyState;
  ref: number; // median simulated player army
  refLow: number;
  refHigh: number;
  growthTarget: number; // desired best-route army after this segment
  mode: 'level' | 'endless';
  tier: number;
  obstacleRecency: (id: ObstacleId) => number; // 0 fresh .. 1 just used
}

// ------------------------------------------------------------------
// small builders
// ------------------------------------------------------------------

/** Identical options make a choice meaningless — nudge duplicates apart. */
function dedupe(gates: GateSpec[]): GateSpec[] {
  const seen = new Set<string>();
  return gates.map((g) => {
    let out = g;
    let key = g.op + ':' + g.v;
    let guard = 0;
    while (seen.has(key) && guard++ < 6) {
      if (out.op === 'add' || out.op === 'merge') out = { ...out, v: niceRound(out.v * 2 + 2) };
      else if (out.op === 'sub') out = { ...out, v: niceRound(out.v * 1.6 + 2) };
      else if (out.op === 'mul' || out.op === 'div') out = { ...out, v: out.v + 1 };
      else if (out.op === 'recruit' || out.op === 'shield' || out.op === 'sacrifice') out = { ...out, v: out.v + 10 };
      else break;
      key = out.op + ':' + out.v;
    }
    seen.add(key);
    return out;
  });
}

function gateRow(ds: number, gatesIn: GateSpec[]): StageDraft {
  const gates = dedupe(gatesIn);
  const w = (HW * 2) / gates.length;
  return {
    ds,
    routes: gates.map((g, i) => ({ x0: -HW + i * w, x1: -HW + (i + 1) * w, ops: [{ kind: 'gate', gate: g, ds }] })),
  };
}

function full(ds: number, op: SimOp): StageDraft {
  return { ds, routes: [{ x0: -HW, x1: HW, ops: [{ ...op, ds } as DraftOp] }] };
}

function enemy(power: number, kind: EnemyKind, formation: Formation, displayMult = 1): SimOp {
  const p = Math.max(1, Math.round(power));
  return { kind: 'enemy', power: p, display: Math.max(1, Math.round(p * displayMult)), enemy: kind, formation };
}

function scaleLoss(l: LossModel, I: number): LossModel {
  const k = 0.75 + 0.5 * Math.min(1.4, I);
  return { best: Math.min(0.2, l.best * k), avg: Math.min(0.35, l.avg * k), worst: Math.min(0.45, l.worst * k) };
}

function gateKey(gates: GateSpec[]): string {
  return gates
    .map((g) => (g.op === 'mul' || g.op === 'div' ? g.op + g.v : g.op))
    .sort()
    .join('|');
}

function outcome(a: ArmyState | number, g: GateSpec, mode: 'actual' | 'expected' = 'expected'): number {
  const s = typeof a === 'number' ? { n: a, shield: 0, dbl: false, lastGain: 0, charge: false, bank: 0, split: false, dead: false } : cloneArmy(a);
  applyGate(s, g, mode);
  return s.n;
}

export class SegmentGenerator {
  // ------------------------------------------------------------------
  // value helpers
  // ------------------------------------------------------------------

  gateAllowed(op: GateOp, c: GenCtx): boolean {
    return c.mode === 'endless' ? GATE_UNLOCK[op] <= Math.max(4, c.tier * 2 + 3) : GATE_UNLOCK[op] <= c.level;
  }

  muls(c: GenCtx): number[] {
    return unlockedMultipliers(c.level, c.mode === 'endless' ? c.tier : -1);
  }

  /** Desired growth factor for this segment's best choice */
  desiredGrowth(c: GenCtx): number {
    return Math.max(1.1, Math.min(8, c.growthTarget / Math.max(1, c.opt.n)));
  }

  pickMul(c: GenCtx, bias = 1): number {
    const g = this.desiredGrowth(c) * bias;
    const ms = this.muls(c);
    return c.rng.weighted(ms, (m) => Math.exp(-Math.pow(Math.log(m / g), 2) / 0.9) + 0.05) ?? 2;
  }

  addValue(c: GenCtx, A: number, f: number): number {
    const raw = Math.max(2, A * f);
    if (raw <= 55 && c.rng.chance(0.7)) {
      let best = CANONICAL_ADDS[1];
      for (const v of [...CANONICAL_ADDS, 2, 3, 8, 15, 20, 30, 40]) if (v > 1 && Math.abs(v - raw) < Math.abs(best - raw)) best = v;
      return best;
    }
    return niceRound(raw);
  }

  subValue(c: GenCtx, A: number, f: number): number {
    const raw = Math.max(2, A * f);
    if (raw <= 55 && c.rng.chance(0.7)) {
      let best = CANONICAL_SUBS[0];
      for (const v of [...CANONICAL_SUBS, 15, 20, 30, 40]) if (Math.abs(v - raw) < Math.abs(best - raw)) best = v;
      return best;
    }
    return niceRound(raw);
  }

  badGate(c: GenCtx, A: number): GateSpec {
    if (this.gateAllowed('div', c) && c.rng.chance(0.4)) return { op: 'div', v: c.rng.pick(DIVISORS) };
    if (this.gateAllowed('sub', c)) {
      // Early on a bad gate should hurt, not end the run for weaker players.
      const cap = c.level <= 4 && c.mode === 'level' ? Math.max(1, Math.floor(c.refLow * 0.6)) : Infinity;
      return { op: 'sub', v: Math.min(cap, this.subValue(c, A, c.rng.range(0.25, 0.6))) };
    }
    return { op: 'add', v: this.addValue(c, A, 0.1) };
  }

  specialGate(c: GenCtx, A: number): GateSpec | null {
    const ops = (Object.keys(SPECIAL_GATE_WEIGHTS) as GateOp[]).filter((o) => this.gateAllowed(o, c));
    const op = c.rng.weighted(ops, (o) => SPECIAL_GATE_WEIGHTS[o] ?? 0);
    if (!op) return null;
    switch (op) {
      case 'shield': return { op, v: c.rng.pick([40, 50, 60]) };
      case 'speed': return { op, v: 1 };
      case 'recruit': return { op, v: c.rng.pick([25, 40, 50, 75]) };
      case 'merge': return { op, v: this.addValue(c, A, c.rng.range(0.4, 0.9)) };
      case 'clone': return { op, v: 1 };
      case 'doubleNext': return { op, v: 1 };
      case 'mystery': return this.mystery(c, A);
      case 'sacrifice': return { op, v: c.rng.pick([20, 30, 40]) };
      default: return null;
    }
  }

  mystery(c: GenCtx, A: number): GateSpec {
    const k = this.pickMul(c);
    const pool: GateSpec[] = [
      { op: 'add', v: this.addValue(c, A, 0.5) },
      { op: 'add', v: this.addValue(c, A, 1.2) },
      { op: 'mul', v: k },
      { op: 'mul', v: Math.min(10, k + 1) },
      { op: 'sub', v: this.subValue(c, A, 0.3) },
      { op: 'div', v: 2 },
    ];
    const hidden = c.rng.weighted(pool, (g) => (g.op === 'sub' || g.op === 'div' ? 0.7 : 1))!;
    return { op: 'mystery', v: 0, pool, hidden };
  }

  formation(c: GenCtx): Formation {
    return c.rng.pick<Formation>(['block', 'wedge', 'line', 'circle', 'ranks', 'block', 'wedge']);
  }

  enemyPower(c: GenCtx, ratioBias = 1): number {
    const cap = c.mode === 'endless' ? GEN.endlessEnemyRatioCap : GEN.enemyRatio.max;
    const t = Math.min(1, c.I / 1.2);
    const ratio = Math.min(cap, (GEN.enemyRatio.min + (cap - GEN.enemyRatio.min) * t) * ratioBias) * c.rng.range(0.85, 1.15);
    return Math.max(2, Math.round(c.ref * ratio));
  }

  pickObstacle(c: GenCtx, exclude: ObstacleId[] = []): ObstacleId {
    const minLvl = c.mode === 'endless' ? 99 : c.level;
    const ids = (Object.keys(OBSTACLES) as ObstacleId[]).filter(
      (id) => !exclude.includes(id) && (c.mode === 'endless' ? OBSTACLES[id].minLevel <= 2 + c.tier * 2 : OBSTACLES[id].minLevel <= minLvl),
    );
    const pool = ids.length ? ids : (['spikeZone', 'rotatingBar'] as ObstacleId[]);
    return c.rng.weighted(pool, (id) => OBSTACLES[id].weight * (1.05 - c.obstacleRecency(id))) ?? pool[0];
  }

  obstacleOp(c: GenCtx, id: ObstacleId, boost = 1): SimOp {
    const I = Math.min(1.5, c.I * boost);
    return { kind: 'obstacle', obstacle: id, length: OBSTACLES[id].length, intensity: I, loss: scaleLoss(OBSTACLES[id].loss, I), seed: Math.floor(c.rng.next() * 1e9) };
  }

  /** Two options whose better choice depends on the army size (the core decision). */
  crossover(c: GenCtx, A: number): GateSpec[] {
    const k = this.pickMul(c);
    const n = this.addValue(c, A, (k - 1) * c.rng.range(0.7, 1.35));
    return c.rng.shuffle<GateSpec>([{ op: 'mul', v: k }, { op: 'add', v: n }]);
  }

  // ------------------------------------------------------------------
  // segment type generators
  // ------------------------------------------------------------------

  generate(type: SegmentType, c: GenCtx): SegmentDraft | null {
    switch (type) {
      case 'gateChoice': return this.gateChoice(c);
      case 'enemyBattle': return this.enemyBattle(c);
      case 'obstacle': return this.obstacle(c);
      case 'reward': return this.reward(c);
      case 'riskReward': return this.riskReward(c);
      case 'miniBoss': return this.miniBoss(c);
      case 'recruitment': return this.recruitment(c);
      case 'narrowSurvival': return this.narrowSurvival(c);
      case 'multiGatePuzzle': return this.multiGatePuzzle(c);
      case 'combination': return this.combination(c);
      default: return null;
    }
  }

  private draft(
    type: SegmentType, variant: string, stages: StageDraft[], keys: VarietyKeys, spectacle: number, note: string, rare?: RareEventId,
  ): SegmentDraft {
    const last = stages.reduce((m, s) => Math.max(m, s.ds, s.divider?.ds1 ?? 0), 0);
    const base = rare ? RARE_EVENTS[rare].length : type === 'finale' ? 40 : SEGMENT_TYPES[type].length;
    return {
      type, rare, variant, stages, keys, spectacle, note,
      length: Math.max(base, last + 16),
      sig: `${rare ?? type}:${variant}:${keys.gates ?? ''}:${keys.obstacle ?? ''}`,
    };
  }

  gateChoice(c: GenCtx): SegmentDraft {
    const A = c.ref;
    const r = c.rng;
    const variants: [string, number][] = [
      ['crossover', 3],
      ['trap', c.level <= 3 ? 2.5 : 0.8],
      ['triple', c.level >= 2 ? 1.6 : 0.4],
      ['special', c.level >= 4 ? 1.3 : 0],
      ['lesserEvil', c.level >= 5 && c.progress > 0.2 ? 0.45 : 0],
      ['four', c.level >= 7 ? 0.8 : 0],
    ];
    const v = r.weighted(variants, ([, w]) => w)![0];
    let gates: GateSpec[];
    let note: string;
    switch (v) {
      case 'trap':
        gates = r.shuffle([{ op: 'add', v: this.addValue(c, A, (this.desiredGrowth(c) - 1) * r.range(0.8, 1.2)) }, this.badGate(c, A)]);
        note = 'Easy read: one good gate, one bad';
        break;
      case 'triple': {
        gates = r.shuffle([...this.crossover(c, A), this.badGate(c, A)]);
        note = 'Three-way choice with a trap';
        break;
      }
      case 'special': {
        const sp = this.specialGate(c, A);
        gates = r.shuffle([sp ?? this.badGate(c, A), { op: 'add', v: this.addValue(c, A, (this.desiredGrowth(c) - 1) * r.range(0.6, 1)) }]);
        note = `Special ${sp?.op ?? 'gate'} vs a sure gain`;
        break;
      }
      case 'lesserEvil': {
        // -n is sized so the better option flips around the reference army size (≈ half the army)
        const n = this.subValue(c, A, r.range(0.35, 0.6));
        gates = r.shuffle<GateSpec>([{ op: 'div', v: 2 }, { op: 'sub', v: n }]);
        note = 'Lesser of two evils — math decides';
        break;
      }
      case 'four': {
        const cross = this.crossover(c, A);
        gates = r.shuffle([...cross, this.badGate(c, A), this.specialGate(c, A) ?? { op: 'add', v: this.addValue(c, A, 0.3) }]);
        note = 'Four-way gate spread';
        break;
      }
      default:
        gates = this.crossover(c, A);
        note = 'Add vs multiply — best pick depends on army size';
    }
    return this.draft('gateChoice', v, [gateRow(14, gates)], { gates: gateKey(gates) }, 0.1, note);
  }

  enemyBattle(c: GenCtx): SegmentDraft {
    const r = c.rng;
    const kindRoll = c.level >= 5 || c.tier >= 2 ? r.weighted<[EnemyKind, number]>([['normal', 3], ['brute', 1]], (x) => x[1])![0] : 'normal';
    const f = this.formation(c);
    const p = this.enemyPower(c);
    const op = enemy(p, kindRoll, f);
    return this.draft('enemyBattle', kindRoll, [full(16, op)], { formation: f }, Math.min(0.5, p / Math.max(1, c.ref)), `Enemy ${kindRoll} squad (${p}) in ${f} formation`);
  }

  obstacle(c: GenCtx): SegmentDraft {
    const id = this.pickObstacle(c);
    const stages: StageDraft[] = [full(10, this.obstacleOp(c, id))];
    let note = `${OBSTACLES[id].name}`;
    if (c.rng.chance(0.45)) {
      const gates = [{ op: 'add', v: this.addValue(c, c.ref, 0.3) } as GateSpec, { op: 'add', v: this.addValue(c, c.ref, 0.15) } as GateSpec];
      stages.push(gateRow(10 + OBSTACLES[id].length + 14, c.rng.shuffle(gates)));
      note += ' with a small reward after';
    }
    return this.draft('obstacle', id, stages, { obstacle: id }, 0.15, note);
  }

  reward(c: GenCtx): SegmentDraft {
    const r = c.rng;
    const A = c.ref;
    if (r.chance(0.5)) {
      const gates: GateSpec[] = r.shuffle([
        { op: 'add', v: this.addValue(c, A, r.range(0.3, 0.7)) },
        { op: 'mul', v: 2 },
        ...(r.chance(0.5) ? [{ op: 'add', v: this.addValue(c, A, r.range(0.1, 0.25)) } as GateSpec] : []),
      ]);
      return this.draft('reward', 'allGood', [gateRow(12, gates)], { gates: gateKey(gates) }, 0.25, 'Breather: every gate helps');
    }
    const n = Math.max(3, Math.round(A * r.range(0.15, 0.4)));
    return this.draft('reward', 'pickup', [full(12, { kind: 'pickup', n, style: 'crowd' })], {}, 0.2, `Free recruits (+${n}) on the road`);
  }

  riskReward(c: GenCtx): SegmentDraft {
    const r = c.rng;
    const A = c.ref;
    const opts: [string, number][] = [
      ['guarded', 3],
      ['mystery', this.gateAllowed('mystery', c) ? 1.5 : 0],
      ['hazardLane', c.level >= 4 || c.tier >= 1 ? 1.4 : 0],
      ['bet', this.gateAllowed('bet', c) ? 0.8 : 0],
    ];
    const v = r.weighted(opts, (x) => x[1])![0];
    if (v === 'mystery') {
      const m = this.mystery(c, A);
      const sure: GateSpec = { op: 'add', v: this.addValue(c, A, (this.desiredGrowth(c) - 1) * 0.6) };
      const gates = r.shuffle([m, sure]);
      return this.draft('riskReward', v, [gateRow(14, gates)], { gates: gateKey(gates) }, 0.3, 'Mystery gate vs a sure thing');
    }
    if (v === 'bet') {
      const bet: GateSpec = { op: 'bet', v: 1, win: r.chance(0.5) };
      const sure: GateSpec = { op: 'add', v: this.addValue(c, A, r.range(0.25, 0.5)) };
      const gates = r.shuffle([bet, sure]);
      return this.draft('riskReward', v, [gateRow(14, gates)], { gates: gateKey(gates) }, 0.35, 'Gamble half the army or take a safe bonus');
    }
    const bigK = Math.max(3, this.pickMul(c, 1.6));
    const safe: GateSpec = r.chance(0.5) ? { op: 'mul', v: 2 } : { op: 'add', v: this.addValue(c, A, r.range(0.5, 1)) };
    const riskLeft = r.chance(0.5);
    const riskOps: DraftOp[] = [];
    let note: string;
    let keys: VarietyKeys;
    if (v === 'guarded') {
      const e = enemy(this.enemyPower(c, 0.8), 'normal', 'block');
      riskOps.push({ ...e, ds: 10 } as DraftOp);
      note = `Guarded ×${bigK} (enemy ${(e as { power: number }).power}) vs safe lane`;
      keys = { gates: 'guarded|mul' + bigK, formation: 'block' };
    } else {
      const id = this.pickObstacle(c, ['narrowPassage', 'movingPlatforms', 'enemyTower']);
      riskOps.push({ ...this.obstacleOp(c, id, 1.3), ds: 6 } as DraftOp);
      note = `Hazard lane (${OBSTACLES[id].name}) hides ×${bigK}`;
      keys = { gates: 'hazard|mul' + bigK, obstacle: id };
    }
    const gateDs = v === 'guarded' ? 30 : 8 + 26;
    riskOps.push({ kind: 'gate', gate: { op: 'mul', v: bigK, golden: bigK >= 5 }, ds: gateDs });
    const riskRoute: DraftRoute = { x0: riskLeft ? -HW : 0, x1: riskLeft ? 0 : HW, ops: riskOps, label: 'risk' };
    const safeRoute: DraftRoute = { x0: riskLeft ? 0 : -HW, x1: riskLeft ? HW : 0, ops: [{ kind: 'gate', gate: safe, ds: gateDs }], label: 'safe' };
    const stage: StageDraft = {
      ds: 4,
      routes: riskLeft ? [riskRoute, safeRoute] : [safeRoute, riskRoute],
      divider: { x: 0, ds0: 2, ds1: gateDs + 3 },
    };
    return this.draft('riskReward', v, [stage], keys, 0.45, note);
  }

  miniBoss(c: GenCtx): SegmentDraft {
    const p = this.enemyPower(c, 1.25);
    const loot: GateSpec[] = c.rng.shuffle([
      { op: 'mul', v: 2 },
      { op: 'add', v: this.addValue(c, c.ref, c.rng.range(0.5, 1)) },
    ]);
    return this.draft(
      'miniBoss', 'champion',
      [full(14, enemy(p, 'champion', 'circle')), gateRow(14 + 26, loot)],
      { formation: 'champion', gates: gateKey(loot) }, 0.6, `Champion (${p}) guards loot`,
    );
  }

  recruitment(c: GenCtx): SegmentDraft {
    const r = c.rng;
    const A = c.ref;
    const lanes = r.int(2, 3);
    // distinct lane values so steering to the right crowd is a real (small) decision
    const base = Math.max(8, A);
    const fr = r.shuffle([0.12, 0.3, 0.55].slice(0, lanes).map((f) => f * r.range(0.8, 1.25)));
    const sizes = fr.map((f, i) => Math.max(2 + i, Math.round(base * f)));
    const w = (HW * 2) / lanes;
    const stage: StageDraft = {
      ds: 12,
      routes: sizes.map((n, i) => ({ x0: -HW + i * w, x1: -HW + (i + 1) * w, ops: [{ kind: 'pickup', n, style: 'crowd', ds: 12 } as DraftOp] })),
    };
    const stages = [stage];
    if (r.chance(0.5)) {
      const s2 = r.shuffle(sizes.map((n) => Math.max(2, Math.round(n * r.range(0.4, 0.8)))));
      stages.push({
        ds: 30,
        routes: s2.map((n, i) => ({ x0: -HW + i * w, x1: -HW + (i + 1) * w, ops: [{ kind: 'pickup', n, style: 'crowd', ds: 30 } as DraftOp] })),
      });
    }
    return this.draft('recruitment', `${lanes}lane`, stages, { gates: 'pickup' + lanes }, 0.2, `Recruit crowds across ${lanes} lanes`);
  }

  narrowSurvival(c: GenCtx): SegmentDraft {
    const first = c.rng.chance(0.6) ? 'narrowPassage' : this.pickObstacle(c);
    const second = this.pickObstacle(c, [first as ObstacleId]);
    const o1 = this.obstacleOp(c, first as ObstacleId);
    const o2 = this.obstacleOp(c, second, 0.9);
    const l1 = OBSTACLES[first as ObstacleId].length;
    return this.draft(
      'narrowSurvival', `${first}+${second}`,
      [full(8, o1), full(8 + l1 + 8, o2)],
      { obstacle: first }, 0.3, `Survival run: ${OBSTACLES[first as ObstacleId].name} → ${OBSTACLES[second].name}`,
    );
  }

  multiGatePuzzle(c: GenCtx): SegmentDraft {
    const r = c.rng;
    const A = c.ref;
    const opts: [string, number][] = [
      ['twoRows', 2],
      ['double', this.gateAllowed('doubleNext', c) ? 1.5 : 0],
      ['split', this.gateAllowed('split', c) ? 1.3 : 0],
      ['clone', this.gateAllowed('clone', c) ? 1 : 0],
    ];
    const v = r.weighted(opts, (x) => x[1])![0];
    const k = this.pickMul(c);
    let row1: GateSpec[];
    let row2: GateSpec[];
    let note: string;
    switch (v) {
      case 'double':
        row1 = r.shuffle<GateSpec>([{ op: 'doubleNext', v: 1 }, { op: 'add', v: this.addValue(c, A, 0.6) }]);
        row2 = r.shuffle<GateSpec>([{ op: 'mul', v: k }, { op: 'add', v: this.addValue(c, A, k * 0.8) }]);
        note = `2× NEXT then ×${k} — combo or safe?`;
        break;
      case 'split':
        row1 = r.shuffle<GateSpec>([{ op: 'split', v: 1 }, { op: 'add', v: this.addValue(c, A, 0.5) }]);
        row2 = [{ op: 'mul', v: k }, { op: 'add', v: this.addValue(c, A, (k - 1) * r.range(0.6, 1.1)) }];
        r.shuffle(row2);
        note = 'Split the army to take both gates';
        break;
      case 'clone':
        row1 = this.crossover(c, A);
        row2 = r.shuffle<GateSpec>([{ op: 'clone', v: 1 }, { op: 'add', v: this.addValue(c, A, 0.8) }]);
        note = 'Clone repeats your last gain — choose row 1 wisely';
        break;
      default: {
        row1 = this.crossover(c, A);
        const a2 = outcome(A, row1[0]);
        row2 = this.crossover(c, a2);
        note = 'Two decisions back to back';
      }
    }
    return this.draft('multiGatePuzzle', v, [gateRow(12, row1), gateRow(34, row2)], { gates: gateKey([...row1, ...row2]) }, 0.35, note);
  }

  combination(c: GenCtx): SegmentDraft {
    const r = c.rng;
    const A = c.ref;
    const v = r.weighted<[string, number]>([['pressure', 3], ['obstacleGate', 1.2], ['gateEnemyGate', 1]], (x) => x[1])![0];
    if (v === 'pressure') {
      // The enemy is sized between what the two choices produce, so the gate decision matters.
      const gates = this.crossover(c, A);
      const outs = gates.map((g) => outcome(A, g)).sort((a, b) => a - b);
      const t = Math.min(1, c.I / 1.1);
      const lo = outs[0] * (0.5 + 0.42 * t);
      const hi = Math.max(lo, outs[outs.length - 1] * 0.82);
      const p = Math.round(lo + (hi - lo) * r.range(0, 0.25 + 0.4 * t));
      const f = this.formation(c);
      return this.draft(
        'combination', v, [gateRow(12, gates), full(34, enemy(p, 'normal', f))],
        { gates: gateKey(gates), formation: f }, 0.4,
        `Pressure: pick right or lose to ${p} (choices give ${outs.join(' / ')})`,
      );
    }
    if (v === 'obstacleGate') {
      const id = this.pickObstacle(c);
      const gates = this.crossover(c, A);
      return this.draft(
        'combination', v, [full(8, this.obstacleOp(c, id)), gateRow(8 + OBSTACLES[id].length + 14, gates)],
        { obstacle: id, gates: gateKey(gates) }, 0.3, `${OBSTACLES[id].name} into a gate choice`,
      );
    }
    const g1 = this.crossover(c, A);
    const a1 = Math.max(...g1.map((g) => outcome(A, g)));
    const p = Math.round(a1 * r.range(0.25, 0.45));
    const g2: GateSpec[] = r.shuffle([{ op: 'add', v: this.addValue(c, a1 - p, 0.4) }, this.badGate(c, a1 - p)]);
    const f = this.formation(c);
    return this.draft(
      'combination', v, [gateRow(10, g1), full(30, enemy(p, 'normal', f)), gateRow(56, g2)],
      { gates: gateKey([...g1, ...g2]), formation: f }, 0.35, 'Gate → battle → gate',
    );
  }

  // ------------------------------------------------------------------
  // rare events
  // ------------------------------------------------------------------

  rare(id: RareEventId, c: GenCtx): SegmentDraft | null {
    const r = c.rng;
    const A = c.ref;
    const banner = RARE_EVENTS[id].banner;
    switch (id) {
      case 'goldenGate': {
        const k = Math.min(10, Math.max(4, this.pickMul(c, 2)));
        const gates: GateSpec[] = r.shuffle([{ op: 'mul', v: k, golden: true }, { op: 'add', v: this.addValue(c, A, 0.5) }]);
        const id2 = this.pickObstacle(c);
        return this.draft('riskReward', 'golden', [gateRow(12, gates), full(34, this.obstacleOp(c, id2, 1.5))],
          { gates: gateKey(gates), obstacle: id2, rare: id }, 0.9, `${banner}: ×${k} then a brutal ${OBSTACLES[id2].name}`, id);
      }
      case 'horde': {
        const p = this.enemyPower(c, 1.1);
        return this.draft('enemyBattle', 'horde', [full(16, enemy(p, 'horde', 'scatter', 3))],
          { formation: 'horde', rare: id }, 0.8, `${banner}: ${p * 3} weak enemies (power ${p})`, id);
      }
      case 'jackpot': {
        const rows: StageDraft[] = [];
        const all: GateSpec[] = [];
        let a = A;
        for (let i = 0; i < 3; i++) {
          const gates: GateSpec[] = r.shuffle([
            { op: 'add', v: this.addValue(c, a, r.range(0.2, 0.5)) },
            { op: 'mul', v: r.chance(0.3) ? 3 : 2 },
            { op: 'add', v: this.addValue(c, a, r.range(0.1, 0.3)) },
          ]);
          rows.push(gateRow(10 + i * 18, gates));
          all.push(...gates);
          a = Math.max(...gates.map((g) => outcome(a, g))) * 0.8;
        }
        return this.draft('reward', 'jackpot', rows, { gates: 'jackpot', rare: id }, 0.9, `${banner}: three rows of pure upside`, id);
      }
      case 'gauntlet': {
        const ids: ObstacleId[] = [];
        const stages: StageDraft[] = [];
        let ds = 6;
        for (let i = 0; i < 3; i++) {
          const o = this.pickObstacle(c, ids);
          ids.push(o);
          stages.push(full(ds, this.obstacleOp(c, o, 0.85)));
          ds += OBSTACLES[o].length + 6;
        }
        return this.draft('narrowSurvival', 'gauntlet', stages, { obstacle: ids[0], rare: id }, 0.7, `${banner}: ${ids.map((o) => OBSTACLES[o].name).join(' → ')}`, id);
      }
      case 'giantBattle': {
        const k = this.pickMul(c, 1.4);
        const gates: GateSpec[] = r.shuffle([{ op: 'mul', v: k }, { op: 'add', v: this.addValue(c, A, (k - 1) * 0.8) }]);
        const best = Math.max(...gates.map((g) => outcome(c.opt, g)));
        const p = Math.round(best * r.range(0.55, 0.72));
        return this.draft('combination', 'giant', [gateRow(12, gates), full(36, enemy(p, 'normal', 'ranks'))],
          { gates: gateKey(gates), formation: 'giant', rare: id }, 1, `${banner}: build up, then clash with ${p}`, id);
      }
      case 'doubleOrNothing': {
        if (!this.gateAllowed('bet', c)) return null;
        const gates: GateSpec[] = r.shuffle([{ op: 'bet', v: 1, win: r.chance(0.55) }, { op: 'add', v: this.addValue(c, A, 0.2) }]);
        return this.draft('riskReward', 'bet', [gateRow(14, gates)], { gates: 'bet', rare: id }, 0.8, `${banner}: stake half the army`, id);
      }
      case 'rescue': {
        const id2 = c.level >= 2 ? 'spikeZone' : 'crusher';
        const lanes = 3;
        const w = (HW * 2) / lanes;
        const cages = Array.from({ length: lanes }, () => Math.max(3, Math.round(A * r.range(0.2, 0.7))));
        return this.draft('recruitment', 'rescue', [
          full(6, this.obstacleOp(c, id2 as ObstacleId, 0.6)),
          { ds: 36, routes: cages.map((n, i) => ({ x0: -HW + i * w, x1: -HW + (i + 1) * w, ops: [{ kind: 'pickup', n, style: 'cage', ds: 36 } as DraftOp] })) },
        ], { gates: 'rescue', obstacle: id2, rare: id }, 0.7, `${banner}: free the caged units`, id);
      }
      case 'ambush': {
        const p = this.enemyPower(c, 0.9);
        return this.draft('enemyBattle', 'ambush', [full(18, enemy(p, 'ambush', 'scatter'))], { formation: 'ambush', rare: id }, 0.8, `${banner}: ${p} enemies charge from the flanks`, id);
      }
      case 'shortcut': {
        const k = Math.max(4, this.pickMul(c, 2.2));
        const o = this.pickObstacle(c, ['narrowPassage', 'movingPlatforms', 'enemyTower']);
        const left = r.chance(0.5);
        const div = left ? -1.5 : 1.5;
        const rs: DraftRoute = {
          x0: left ? -HW : div, x1: left ? div : HW, label: 'shortcut',
          ops: [{ ...this.obstacleOp(c, o, 1.6), ds: 6 } as DraftOp, { kind: 'gate', gate: { op: 'mul', v: k, golden: true }, ds: 40 }],
        };
        const main: DraftRoute = {
          x0: left ? div : -HW, x1: left ? HW : div, label: 'main',
          ops: [{ kind: 'gate', gate: { op: 'add', v: this.addValue(c, A, 0.6) }, ds: 40 }],
        };
        return this.draft('riskReward', 'shortcut', [{ ds: 4, routes: left ? [rs, main] : [main, rs], divider: { x: div, ds0: 2, ds1: 43 } }],
          { gates: 'shortcut', obstacle: o, rare: id }, 0.85, `${banner}: narrow ${OBSTACLES[o].name} lane with ×${k}`, id);
      }
    }
  }
}
