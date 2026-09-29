// Lane Battle rules + a fast aggregate simulation. The generator runs this with
// several player policies (optimal, casual, "only ever shoot one lane") to size
// the castle, enemy waves and base, and to reject levels where lanes don't matter.
import { LANES } from '../config/lanesConfig';
import type { LaneKind } from '../config/lanesConfig';
import { Rng } from '../core/SeedManager';

export type LaneGateOp = 'add' | 'mul' | 'div';

export interface LaneEvent {
  s: number;
  kind: 'gate' | 'tower';
  op?: LaneGateOp;
  v?: number;
  hp?: number;
  mult?: number;
}

export interface LaneDef {
  kind: LaneKind;
  x0: number;
  x1: number;
  events: LaneEvent[]; // sorted by s
}

export interface Wave {
  t: number;
  lane: number;
  count: number;
  final?: boolean;
}

export interface StrategyResult {
  name: string;
  won: boolean;
  time: number;
  baseLeft: number;
  kills: number;
}

export interface LaneLevelData {
  seed: number;
  code: string;
  attempt: number;
  level: number;
  D: number;
  env: import('../core/types').EnvId;
  L: number;
  fireRate: number;
  lanes: LaneDef[];
  waves: Wave[];
  castleHP: number;
  baseHP: number;
  targetTime: number;
  maxTime: number;
  report: {
    valid: boolean;
    reasons: string[];
    best: StrategyResult;
    strategies: StrategyResult[];
    casualWinRate: number;
    waveRatio: number;
    notes: string[];
  };
  genMs: number;
}

// ------------------------------------------------------------------
// rules shared with gameplay
// ------------------------------------------------------------------

export function splitCount(v: number): number {
  return Math.max(1, Math.min(LANES.splitMax, Math.floor(v)));
}

/** Apply a lane gate to one group of weight w (fractional in sim, integer in play). */
export function applyLaneGate(w: number, op: LaneGateOp, v: number): number {
  switch (op) {
    case 'add': return w + v;
    case 'mul': return w * v;
    case 'div': return w / v;
  }
}

export function laneGateLabel(e: LaneEvent): string {
  if (e.kind === 'tower') return '×' + e.mult;
  return e.op === 'add' ? '+' + e.v : e.op === 'mul' ? '×' + e.v : '÷' + e.v;
}

/** Output of a single shot after passing events up to distance sLimit. */
export function shotOutput(lane: LaneDef, towerBroken: boolean, sLimit = Infinity): number {
  let w = 1;
  for (const e of lane.events) {
    if (e.s > sLimit) break;
    if (e.kind === 'gate') w = applyLaneGate(w, e.op!, e.v!);
    else if (towerBroken) w *= e.mult!;
    else return 0;
  }
  return w;
}

// ------------------------------------------------------------------
// aggregate simulation
// ------------------------------------------------------------------

interface PPacket { s: number; groups: number; per: number; ei: number }
interface EPacket { s: number; count: number }

export interface SimView {
  t: number;
  lane: number;
  lanes: { enemy: number; nearest: number; player: number; towerHp: number; towerBroken: boolean; out: number }[];
  L: number;
}

export type Policy = (v: SimView, rng: Rng) => number;

export interface SimOptions {
  castleHP?: number;
  noWaves?: boolean;
  maxT?: number;
  rng?: Rng;
  curve?: number[]; // filled with cumulative castle damage per second
  towerBreaks?: number[]; // filled with break time per lane (-1 never)
}

export function simulate(lv: LaneLevelData, policy: Policy, o: SimOptions = {}): StrategyResult & { castleLeft: number } {
  const dt = LANES.simDt;
  const L = lv.L;
  const rng = o.rng ?? new Rng(1);
  const n = lv.lanes.length;
  const players: PPacket[][] = Array.from({ length: n }, () => []);
  const enemies: EPacket[][] = Array.from({ length: n }, () => []);
  const towerHp = lv.lanes.map((l) => l.events.find((e) => e.kind === 'tower')?.hp ?? 0);
  const broken = lv.lanes.map((l) => !l.events.some((e) => e.kind === 'tower'));
  const breaks = lv.lanes.map(() => -1);
  let castle = o.castleHP ?? lv.castleHP;
  let base = lv.baseHP;
  let lane = Math.floor(n / 2);
  let moveLock = 0;
  let fireAcc = 0;
  let kills = 0;
  let dealt = 0;
  const maxT = o.maxT ?? lv.maxTime;
  const waves = o.noWaves ? [] : lv.waves.map((w) => ({ ...w, left: w.count, spawnT: 0 }));
  const view: SimView = { t: 0, lane, L, lanes: lv.lanes.map(() => ({ enemy: 0, nearest: L, player: 0, towerHp: 0, towerBroken: false, out: 0 })) };
  let nextDecision = 0;
  let t = 0;
  let step = 0;
  const perSec = Math.round(1 / dt);
  for (; t < maxT; t += dt, step++) {
    // decision
    if (t >= nextDecision) {
      nextDecision = t + 0.25;
      view.t = t;
      view.lane = lane;
      for (let l = 0; l < n; l++) {
        const V = view.lanes[l];
        V.enemy = enemies[l].reduce((a, e) => a + e.count, 0);
        V.nearest = enemies[l].length ? enemies[l][0].s : L;
        V.player = players[l].reduce((a, p) => a + p.groups * p.per, 0);
        V.towerHp = towerHp[l];
        V.towerBroken = broken[l];
        V.out = shotOutput(lv.lanes[l], broken[l]);
      }
      const want = Math.max(0, Math.min(n - 1, policy(view, rng)));
      if (want !== lane) {
        moveLock = Math.abs(want - lane) * LANES.laneSwitchTime;
        lane = want;
      }
    }
    // fire
    if (moveLock > 0) moveLock -= dt;
    else {
      fireAcc += lv.fireRate * dt;
      if (fireAcc >= 1) {
        const k = Math.floor(fireAcc);
        fireAcc -= k;
        players[lane].push({ s: LANES.cannonS, groups: k, per: 1, ei: 0 });
      }
    }
    // waves
    for (const w of waves) {
      if (w.left <= 0 || t < w.t) continue;
      const chunk = Math.min(w.left, (w.count * dt) / 1.5);
      w.left -= chunk;
      enemies[w.lane].push({ s: L - 0.5, count: chunk });
    }
    // move + events
    for (let l = 0; l < n; l++) {
      const evs = lv.lanes[l].events;
      const ps = players[l];
      for (let i = 0; i < ps.length; i++) {
        const p = ps[i];
        p.s += LANES.unitSpeed * dt;
        while (p.ei < evs.length && p.s >= evs[p.ei].s) {
          const e = evs[p.ei];
          if (e.kind === 'gate') {
            p.per = applyLaneGate(p.per, e.op!, e.v!);
            if (e.op === 'mul') {
              const k = splitCount(e.v!);
              p.groups *= k;
              p.per /= k;
            }
          } else if (!broken[l]) {
            const dmg = p.groups * p.per;
            towerHp[l] -= dmg;
            p.groups = 0;
            if (towerHp[l] <= 0) {
              broken[l] = true;
              breaks[l] = t;
            }
            break;
          } else {
            const k = splitCount(e.mult!);
            p.per = (p.per * e.mult!) / k;
            p.groups *= k;
          }
          p.ei++;
        }
        if (p.groups > 0 && p.s >= L) {
          const dmg = p.groups * p.per;
          castle -= dmg;
          dealt += dmg;
          p.groups = 0;
        }
      }
      for (const e of enemies[l]) e.s -= LANES.enemySpeed * dt;
      // front-line collisions: players ordered oldest (front) first, enemies too
      let pi = 0;
      let ej = 0;
      const es = enemies[l];
      while (pi < ps.length && ej < es.length) {
        const p = ps[pi];
        const e = es[ej];
        if (p.groups <= 0) { pi++; continue; }
        if (e.count <= 0) { ej++; continue; }
        if (p.s < e.s) break;
        const pt = p.groups * p.per;
        const k = Math.min(pt, e.count);
        kills += k;
        e.count -= k;
        p.groups = pt - k <= 1e-9 ? 0 : (pt - k) / p.per;
      }
      for (const e of es) if (e.count > 0 && e.s <= 0.5) {
        base -= e.count;
        e.count = 0;
      }
      players[l] = ps.filter((p) => p.groups > 1e-9);
      enemies[l] = es.filter((e) => e.count > 1e-9);
    }
    if (o.curve && step % perSec === 0) o.curve.push(dealt);
    if (castle <= 0) break;
    if (base <= 0) break;
  }
  if (o.towerBreaks) o.towerBreaks.push(...breaks);
  return { name: '', won: castle <= 0 && base > 0, time: t, baseLeft: base, kills, castleLeft: castle };
}

// ------------------------------------------------------------------
// player policies
// ------------------------------------------------------------------

/** Defends threatened lanes, otherwise pours everything into its focus lane. */
export function smartPolicy(focus: number): Policy {
  return (v) => {
    let best = -1;
    let urgency = 0;
    v.lanes.forEach((ln, l) => {
      const deficit = ln.enemy * 1.08 - ln.player;
      if (ln.enemy > 0 && deficit > 0) {
        const u = deficit / Math.max(4, ln.nearest);
        if (u > urgency) {
          urgency = u;
          best = l;
        }
      }
    });
    return best >= 0 ? best : focus;
  };
}

/** Reacts late, and picks focus lanes by "biggest number" appeal with random switching. */
export function casualPolicy(): Policy {
  let focus = -1;
  let nextSwitch = 0;
  let lastDecision = -10;
  let current = 1;
  return (v, rng) => {
    if (v.t - lastDecision < 1.1) return current;
    lastDecision = v.t;
    if (focus < 0 || v.t >= nextSwitch) {
      focus = rng.weighted(v.lanes.map((_, i) => i), (i) => 1 + Math.log10(1 + v.lanes[i].out) + (v.lanes[i].towerBroken ? 0 : 0.8)) ?? 0;
      nextSwitch = v.t + rng.range(7, 14);
    }
    let best = -1;
    let near = v.L * 0.55;
    v.lanes.forEach((ln, l) => {
      if (ln.enemy > ln.player * 0.9 && ln.nearest < near) {
        near = ln.nearest;
        best = l;
      }
    });
    current = best >= 0 ? best : focus;
    return current;
  };
}

export function fixedPolicy(l: number): Policy {
  return () => l;
}
