// Arena rules + fast aggregate simulation used by the generator.
//
// Model: every bay is a column through the gate zone (soldiers move straight,
// gates and hedges span the whole bay). Past the gate zone all soldiers merge
// into one shared front up to the fortress; the horde comes down that front.
// Enemies that win the front pour into the field and hunt the cannon (they're
// met by fresh, un-multiplied shots in whichever bay the cannon is aiming at).
import { ARENA, type BayKind } from '../config/arenaConfig';
import { Rng } from '../core/SeedManager';
import type { EnvId } from '../core/types';

export type ArenaOp = 'add' | 'mul' | 'sub' | 'div';

export interface ArenaGate { s: number; x0: number; x1: number; op: ArenaOp; v: number }
export interface Hedge { s0: number; s1: number; x0: number; x1: number; hp: number }

export interface Bay {
  kind: BayKind;
  x0: number;
  x1: number;
  gates: ArenaGate[];
  hedge?: Hedge;
}

export interface ArenaWave { t: number; count: number; final?: boolean }

export interface ArenaStrategy { name: string; won: boolean; time: number; baseLeft: number; kills: number }

export interface ArenaLevelData {
  seed: number;
  code: string;
  attempt: number;
  level: number;
  D: number;
  env: EnvId;
  fireRate: number;
  bays: Bay[];
  waves: ArenaWave[];
  castleHP: number;
  baseHP: number;
  targetTime: number;
  maxTime: number;
  report: {
    valid: boolean;
    reasons: string[];
    best: ArenaStrategy;
    strategies: ArenaStrategy[];
    casualWinRate: number;
    waveRatio: number;
    notes: string[];
  };
  genMs: number;
}

export function splitCount(v: number): number {
  return Math.max(1, Math.min(ARENA.splitMax, Math.floor(v)));
}

export function applyArenaGate(w: number, op: ArenaOp, v: number): number {
  switch (op) {
    case 'add': return w + v;
    case 'mul': return w * v;
    case 'sub': return Math.max(0, w - v);
    case 'div': return w / v;
  }
}

/** Output of one shot through a bay (hedge treated as broken or blocking). */
export function bayOutput(b: Bay, hedgeBroken: boolean): number {
  const events: { s: number; g?: ArenaGate; h?: Hedge }[] = b.gates.map((g) => ({ s: g.s, g }));
  if (b.hedge) events.push({ s: b.hedge.s0, h: b.hedge });
  events.sort((a, c) => a.s - c.s);
  let w = 1;
  for (const e of events) {
    if (e.h) {
      if (!hedgeBroken) return 0;
    } else w = applyArenaGate(w, e.g!.op, e.g!.v);
  }
  return w;
}

// ------------------------------------------------------------------

interface Pk { s: number; groups: number; per: number; ei: number }
interface Ek { s: number; count: number }

export interface ArenaView {
  t: number;
  bay: number;
  outs: number[]; // current per-shot output of each bay
  hedgeHp: number[];
  fieldEnemies: number;
  frontEnemies: number;
}

export type ArenaPolicy = (v: ArenaView, rng: Rng) => number;

export interface ArenaSimOpts {
  castleHP?: number;
  noWaves?: boolean;
  maxT?: number;
  rng?: Rng;
  curve?: number[];
  hedgeBreaks?: number[];
}

export function simulateArena(lv: ArenaLevelData, policy: ArenaPolicy, o: ArenaSimOpts = {}): ArenaStrategy & { castleLeft: number } {
  const dt = ARENA.simDt;
  const L = ARENA.length;
  const Z = ARENA.gateZone[1];
  const n = lv.bays.length;
  const rng = o.rng ?? new Rng(3);
  // per-bay ordered events
  const evs = lv.bays.map((b) => {
    const e: { s: number; g?: ArenaGate; hedge?: boolean }[] = b.gates.map((g) => ({ s: g.s, g }));
    if (b.hedge) e.push({ s: b.hedge.s0, hedge: true });
    return e.sort((a, c) => a.s - c.s);
  });
  const hedgeHp = lv.bays.map((b) => (b.hedge ? b.hedge.hp : 0));
  const breaks = lv.bays.map(() => -1);
  const bayP: Pk[][] = Array.from({ length: n }, () => []);
  const front: Pk[] = [];
  const frontE: Ek[] = [];
  const fieldE: Ek[] = [];
  let castle = o.castleHP ?? lv.castleHP;
  let base = lv.baseHP;
  let bay = Math.floor(n / 2);
  let lock = 0;
  let acc = 0;
  let kills = 0;
  let dealt = 0;
  const maxT = o.maxT ?? lv.maxTime;
  const waves = o.noWaves ? [] : lv.waves.map((w) => ({ ...w, left: w.count }));
  let nextDecision = 0;
  let t = 0;
  let step = 0;
  const perSec = Math.round(1 / dt);
  const view: ArenaView = { t: 0, bay, outs: [], hedgeHp: [], fieldEnemies: 0, frontEnemies: 0 };

  const clash = (ps: Pk[], es: Ek[]) => {
    // players ordered front-first (largest s first), enemies front-first (smallest s first)
    let pi = 0;
    let ej = 0;
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
  };

  for (; t < maxT; t += dt, step++) {
    if (t >= nextDecision) {
      nextDecision = t + 0.25;
      view.t = t;
      view.bay = bay;
      view.outs = lv.bays.map((b, i) => bayOutput(b, hedgeHp[i] <= 0));
      view.hedgeHp = hedgeHp.slice();
      view.fieldEnemies = fieldE.reduce((a, e) => a + e.count, 0);
      view.frontEnemies = frontE.reduce((a, e) => a + e.count, 0);
      const want = Math.max(0, Math.min(n - 1, policy(view, rng)));
      if (want !== bay) {
        lock = Math.abs(want - bay) * ARENA.switchTime;
        bay = want;
      }
    }
    if (lock > 0) lock -= dt;
    else {
      acc += lv.fireRate * dt;
      if (acc >= 1) {
        const k = Math.floor(acc);
        acc -= k;
        bayP[bay].push({ s: ARENA.cannonS, groups: k, per: 1, ei: 0 });
      }
    }
    for (const w of waves) {
      if (w.left <= 0 || t < w.t) continue;
      const chunk = Math.min(w.left, (w.count * dt) / 2);
      w.left -= chunk;
      frontE.push({ s: L - 0.5, count: chunk });
    }

    // bays: soldiers walk up, pass gates, chew hedges, leave into the front
    for (let b = 0; b < n; b++) {
      const ps = bayP[b];
      for (const p of ps) {
        p.s += ARENA.unitSpeed * dt;
        while (p.groups > 0 && p.ei < evs[b].length && p.s >= evs[b][p.ei].s) {
          const e = evs[b][p.ei];
          if (e.hedge) {
            if (hedgeHp[b] > 0) {
              hedgeHp[b] -= p.groups * p.per;
              p.groups = 0;
              if (hedgeHp[b] <= 0 && breaks[b] < 0) breaks[b] = t;
              break;
            }
          } else {
            const g = e.g!;
            p.per = applyArenaGate(p.per, g.op, g.v);
            if (g.op === 'mul') {
              const k = splitCount(g.v);
              p.groups *= k;
              p.per /= k;
            }
          }
          p.ei++;
        }
        if (p.groups > 0 && p.s >= Z) {
          front.unshift({ ...p });
          p.groups = 0;
        }
      }
    }
    // the field: enemies that broke through hunt the cannon (meet raw shots in the aimed bay)
    for (const e of fieldE) e.s -= ARENA.enemySpeed * dt;
    const aimed = bayP[bay].slice().sort((a, c) => c.s - a.s);
    clash(aimed, fieldE);
    for (const e of fieldE) if (e.count > 0 && e.s <= 0.6) {
      base -= e.count;
      e.count = 0;
    }
    // the front
    for (const p of front) p.s += ARENA.unitSpeed * dt;
    for (const e of frontE) e.s -= ARENA.enemySpeed * dt;
    front.sort((a, c) => c.s - a.s);
    clash(front, frontE);
    for (const p of front) if (p.groups > 0 && p.s >= L) {
      const dmg = p.groups * p.per;
      castle -= dmg;
      dealt += dmg;
      p.groups = 0;
    }
    for (const e of frontE) if (e.count > 0 && e.s < Z) {
      fieldE.push({ s: e.s, count: e.count });
      e.count = 0;
    }
    for (let b = 0; b < n; b++) bayP[b] = bayP[b].filter((p) => p.groups > 1e-9);
    const f2 = front.filter((p) => p.groups > 1e-9);
    front.length = 0;
    front.push(...f2);
    const e2 = frontE.filter((e) => e.count > 1e-9);
    frontE.length = 0;
    frontE.push(...e2);
    const e3 = fieldE.filter((e) => e.count > 1e-9).sort((a, c) => a.s - c.s);
    fieldE.length = 0;
    fieldE.push(...e3);

    if (o.curve && step % perSec === 0) o.curve.push(dealt);
    if (castle <= 0 || base <= 0) break;
  }
  if (o.hedgeBreaks) o.hedgeBreaks.push(...breaks);
  return { name: '', won: castle <= 0 && base > 0, time: t, baseLeft: base, kills, castleLeft: castle };
}

// ------------------------------------------------------------------
// policies
// ------------------------------------------------------------------

/** Pours everything into one bay (breaking its hedge first if it has one). */
export function focusPolicy(b: number): ArenaPolicy {
  return () => b;
}

/** Plays the best currently-open bay; switches to a hedge bay only when it judges the payoff worth it. */
export function smartArenaPolicy(target: number): ArenaPolicy {
  return (v) => {
    // break into the target bay; while it's sealed, a big leak is handled by the best open bay
    if (v.hedgeHp[target] > 0 && v.fieldEnemies > 0) {
      let best = 0;
      v.outs.forEach((o, i) => { if (o > v.outs[best]) best = i; });
      return best;
    }
    return target;
  };
}

/** Likes big numbers, gets distracted, reacts late to leaks. */
export function casualArenaPolicy(): ArenaPolicy {
  let focus = -1;
  let next = 0;
  return (v, rng) => {
    if (focus < 0 || v.t >= next) {
      focus = rng.weighted(v.outs.map((_, i) => i), (i) => 0.6 + Math.log10(1 + Math.max(v.outs[i], v.hedgeHp[i] > 0 ? 8 : 0))) ?? 0;
      next = v.t + rng.range(6, 12);
    }
    if (v.fieldEnemies > 0 && rng.chance(0.5)) {
      let best = 0;
      v.outs.forEach((o, i) => { if (o > v.outs[best]) best = i; });
      return best;
    }
    return focus;
  };
}
