// Offline simulation used by the generator: optimal-route search, simulated
// player populations, and whole-level validation.
import { Rng } from '../core/SeedManager';
import type { LossModel, PredictedRange, Stage, WorldOp } from '../core/types';
import {
  applyBattle, applyGate, applyLoss, applySplitRow, battleLoss, cloneArmy, newArmy, obstacleLoss,
  type ArmyState, type GateMode,
} from './rules';

/** Map a play-quality value t (0 = flawless, 0.5 = average, 1 = worst) to a loss fraction. */
export function lossFrac(m: LossModel, t: number): number {
  const c = Math.max(0, Math.min(1, t));
  return c < 0.5 ? m.best + (m.avg - m.best) * (c * 2) : m.avg + (m.worst - m.avg) * ((c - 0.5) * 2);
}

export interface OpResult {
  minRatio: number; // lowest (army / enemy loss) seen before a battle
  lost: number;
  gained: number;
  enemies: number;
}

export function applyOp(a: ArmyState, op: WorldOp, lossT: number, gateMode: GateMode, res?: OpResult): void {
  if (a.dead) return;
  switch (op.kind) {
    case 'gate': {
      const d = applyGate(a, op.gate, gateMode);
      if (res) {
        if (d > 0) res.gained += d;
        else res.lost -= d;
      }
      break;
    }
    case 'enemy':
    case 'boss': {
      const need = battleLoss(a, op.power);
      if (res) res.minRatio = Math.min(res.minRatio, need > 0 ? (a.n + a.shield) / need : Infinity);
      const l = applyBattle(a, op.power);
      if (res) {
        res.lost += l;
        res.enemies += op.power;
      }
      break;
    }
    case 'obstacle': {
      const l = applyLoss(a, obstacleLoss(a.n, lossFrac(op.loss, lossT)));
      if (res) res.lost += l;
      break;
    }
    case 'pickup': {
      a.n += op.n;
      a.lastGain = op.n;
      if (res) res.gained += op.n;
      break;
    }
  }
}

function isGateRow(stage: Stage): boolean {
  return stage.routes.length >= 2 && stage.routes.every((r) => r.ops.length === 1 && r.ops[0].kind === 'gate');
}

/** Run one route of a stage. Handles split armies on pure gate rows. */
export function runStage(a: ArmyState, stage: Stage, routeIdx: number, lossT: number, gateMode: GateMode, res?: OpResult): void {
  if (a.dead) return;
  if (a.split) {
    if (isGateRow(stage)) {
      const l = stage.routes[0].ops[0];
      const r = stage.routes[stage.routes.length - 1].ops[0];
      if (l.kind === 'gate' && r.kind === 'gate') {
        const before = a.n;
        applySplitRow(a, l.gate, r.gate, gateMode);
        if (res) {
          if (a.n > before) res.gained += a.n - before;
          else res.lost += before - a.n;
        }
        return;
      }
    }
    a.split = false; // split only persists until the next gate row
  }
  for (const op of stage.routes[routeIdx].ops) {
    applyOp(a, op, lossT, gateMode, res);
    if (a.dead) return;
  }
}

export function newResult(): OpResult {
  return { minRatio: Infinity, lost: 0, gained: 0, enemies: 0 };
}

/**
 * Best route through a list of stages by exhaustive enumeration (segments have
 * at most a handful of choice points). Exact within a segment, so combos like
 * "2× NEXT then ×3" or "SPLIT then two gates" are found.
 */
export function bestPath(
  start: ArmyState, stages: Stage[], lossT: number, gateMode: GateMode,
): { state: ArmyState; res: OpResult; choice: number[] } {
  let best = null as { state: ArmyState; res: OpResult; choice: number[] } | null;
  const choice: number[] = [];
  const score = (s: ArmyState, r: OpResult) => (s.dead ? -1 : s.n + s.shield * 0.5 + s.bank * 0.3 + Math.min(r.minRatio, 3) * 1e-3);

  const rec = (i: number, a: ArmyState, r: OpResult) => {
    if (i === stages.length || a.dead) {
      if (!best || score(a, r) > score(best.state, best.res)) best = { state: a, res: r, choice: choice.slice() };
      return;
    }
    const st = stages[i];
    const n = a.split && isGateRow(st) ? 1 : st.routes.length;
    for (let k = 0; k < n; k++) {
      const a2 = cloneArmy(a);
      const r2 = { ...r };
      runStage(a2, st, k, lossT, gateMode, r2);
      choice.push(k);
      rec(i + 1, a2, r2);
      choice.pop();
    }
  };
  rec(0, cloneArmy(start), newResult());
  return best!;
}

// ------------------------------------------------------------------
// Simulated player population
// ------------------------------------------------------------------

export interface Agent {
  a: ArmyState;
  skill: number;
  rng: Rng;
  lost: number;
  gained: number;
  maxN: number;
}

export function makePopulation(rng: Rng, size: number, startN: number, skills?: number[]): Agent[] {
  const out: Agent[] = [];
  for (let i = 0; i < size; i++) {
    const skill = skills ? skills[i % skills.length] : 0.35 + 0.65 * ((i + 0.5) / size);
    out.push({ a: newArmy(startN), skill, rng: rng.fork(i), lost: 0, gained: 0, maxN: startN });
  }
  return out;
}

export function clonePopulation(p: Agent[], rng: Rng): Agent[] {
  return p.map((ag, i) => ({ ...ag, a: cloneArmy(ag.a), rng: rng.fork(i) }));
}

/** How well an agent plays an obstacle this time. */
function agentLossT(ag: Agent): number {
  return Math.max(0, Math.min(1, (1 - ag.skill) * 0.95 + (ag.rng.next() - 0.5) * 0.45 + 0.08));
}

/** Choose a route: skilled agents evaluate outcomes (without knowing mystery results), others guess. */
export function agentChoose(ag: Agent, stage: Stage): number {
  if (stage.routes.length === 1) return 0;
  if (ag.a.split && isGateRow(stage)) return 0;
  if (ag.rng.next() < ag.skill) {
    let bestK = 0;
    let bestV = -Infinity;
    for (let k = 0; k < stage.routes.length; k++) {
      const t = cloneArmy(ag.a);
      runStage(t, stage, k, 0.5, 'expected');
      const v = t.dead ? -1 : t.n + t.shield * 0.5 + t.bank * 0.2 + (t.dbl ? t.n * 0.4 : 0) + (t.split ? t.n * 0.3 : 0);
      if (v > bestV) {
        bestV = v;
        bestK = k;
      }
    }
    return bestK;
  }
  // Guessing: anyone but a purely random player at least avoids red (−/÷) gates when a
  // better-looking option exists — they just can't do the math between the good ones.
  if (ag.skill > 0) {
    const ok = stage.routes.map((r, k) => ({ r, k })).filter(({ r }) => !r.ops.some((o) => o.kind === 'gate' && (o.gate.op === 'sub' || o.gate.op === 'div')));
    if (ok.length && ok.length < stage.routes.length) return ok[Math.floor(ag.rng.next() * ok.length)].k;
  }
  return Math.floor(ag.rng.next() * stage.routes.length);
}

export function stepAgent(ag: Agent, stage: Stage): void {
  if (ag.a.dead) return;
  const k = agentChoose(ag, stage);
  const r = newResult();
  runStage(ag.a, stage, k, agentLossT(ag), 'actual', r);
  ag.lost += r.lost;
  ag.gained += r.gained;
  ag.maxN = Math.max(ag.maxN, ag.a.n);
}

export function stepPopulation(pop: Agent[], stages: Stage[]): void {
  for (const st of stages) for (const ag of pop) stepAgent(ag, st);
}

export function quantile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const i = Math.min(sorted.length - 1, Math.max(0, Math.round(q * (sorted.length - 1))));
  return sorted[i];
}

export function populationRange(pop: Agent[], opt: ArmyState, optWorst: ArmyState): PredictedRange {
  const alive = pop.filter((p) => !p.a.dead).map((p) => p.a.n).sort((a, b) => a - b);
  return {
    min: alive[0] ?? 0,
    p25: quantile(alive, 0.25),
    med: quantile(alive, 0.5),
    p75: quantile(alive, 0.75),
    max: alive[alive.length - 1] ?? 0,
    opt: opt.dead ? 0 : opt.n,
    optWorst: optWorst.dead ? 0 : optWorst.n,
    alive: pop.length ? alive.length / pop.length : 0,
  };
}

export function aliveFrac(pop: Agent[]): number {
  let n = 0;
  for (const p of pop) if (!p.a.dead) n++;
  return pop.length ? n / pop.length : 0;
}
