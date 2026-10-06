// Canyon Siege rules + fast aggregate simulation used by the generator.
//
// Model: one shared front up the canyon. Shots aimed at the gate are multiplied
// and march up to meet the horde; shots aimed at a turret pad are spent building
// or upgrading that turret. Built turrets shred the nearest enemies in range.
// Enemies that get past the barricade hunt the cannon through the plaza, where
// every fresh shot meets them. Soldiers that reach the top cut into the horde's
// reserve directly.
import { CANYON, type CanyonPath, type TurretKind } from '../config/canyonConfig';
import { Rng } from '../core/SeedManager';
import type { EnvId } from '../core/types';
import type { ArenaStrategy } from './ArenaSim';

export interface TurretSpec { kind: TurretKind; costs: number[]; dps: number[] }
export interface Surge { t: number; dur: number; mult: number }

export interface CanyonLevelData {
  seed: number;
  code: string;
  attempt: number;
  level: number;
  D: number;
  env: EnvId;
  fireRate: number;
  gateMult: number;
  /** [left pad, right pad] */
  turrets: [TurretSpec, TurretSpec];
  horde: number;
  baseHP: number;
  release: { rate: number; rampT: number; surges: Surge[] };
  path: CanyonPath;
  targetTime: number;
  maxTime: number;
  report: {
    valid: boolean;
    reasons: string[];
    best: ArenaStrategy;
    strategies: ArenaStrategy[];
    casualWinRate: number;
    ratio: number;
    notes: string[];
  };
  genMs: number;
}

/** Horde emerging from the top of the canyon per second. */
export function releaseRate(lv: CanyonLevelData, t: number): number {
  const r = lv.release;
  let m = 0.6 + 0.8 * Math.min(1, t / r.rampT);
  for (const s of r.surges) if (t >= s.t && t < s.t + s.dur) m *= s.mult;
  return r.rate * m;
}

/** Remaining charge needed for the next tier (Infinity once maxed). */
export function nextCost(t: TurretSpec, tier: number): number {
  return tier < t.costs.length ? t.costs[tier] : Infinity;
}

// ------------------------------------------------------------------

export interface CanyonView {
  t: number;
  slot: number;
  tiers: number[];
  maxed: boolean[];
  fieldEnemies: number;
  nearestS: number; // closest canyon enemy to the barricade
}

export type CanyonPolicy = (v: CanyonView, rng: Rng) => number;

interface Pk { s: number; w: number; slot: number }
interface Ek { s: number; w: number }

export function simulateCanyon(lv: CanyonLevelData, policy: CanyonPolicy, o: { rng?: Rng; maxT?: number } = {}): ArenaStrategy & { hordeLeft: number } {
  const C = CANYON;
  const dt = C.simDt;
  const rng = o.rng ?? new Rng(3);
  const maxT = o.maxT ?? lv.maxTime;
  const tiers = [0, 0];
  const need = lv.turrets.map((tu) => nextCost(tu, 0));
  let reserve = lv.horde;
  let base = lv.baseHP;
  let slot = 1;
  let lock = 0;
  let acc = 0;
  let kills = 0;
  let next = 0;
  let plazaP: Pk[] = [];
  let canyonP: Pk[] = [];
  let canyonE: Ek[] = [];
  let fieldE: Ek[] = [];
  const view: CanyonView = { t: 0, slot, tiers, maxed: [false, false], fieldEnemies: 0, nearestS: Infinity };

  const clash = (ps: Pk[], es: Ek[]) => {
    // players front-first (largest s), enemies front-first (smallest s)
    let pi = 0;
    let ej = 0;
    while (pi < ps.length && ej < es.length) {
      const p = ps[pi];
      const e = es[ej];
      if (p.w <= 1e-9) { pi++; continue; }
      if (e.w <= 1e-9) { ej++; continue; }
      if (p.s < e.s) break;
      const k = Math.min(p.w, e.w);
      kills += k;
      p.w -= k;
      e.w -= k;
    }
  };

  let t = 0;
  let won = false;
  for (; t < maxT; t += dt) {
    if (t >= next) {
      next = t + 0.25;
      view.t = t;
      view.slot = slot;
      view.maxed = tiers.map((k, i) => k >= lv.turrets[i].costs.length);
      view.fieldEnemies = fieldE.reduce((a, e) => a + e.w, 0);
      view.nearestS = canyonE.length ? canyonE[0].s : Infinity;
      const want = Math.max(0, Math.min(2, policy(view, rng)));
      if (want !== slot) {
        lock = Math.abs(want - slot) * C.switchTime;
        slot = want;
      }
    }
    if (lock > 0) lock -= dt;
    else {
      acc += lv.fireRate * dt;
      if (acc >= 1) {
        const k = Math.floor(acc);
        acc -= k;
        plazaP.push({ s: C.cannonS, w: k, slot });
      }
    }
    if (reserve > 0) {
      const r = Math.min(reserve, releaseRate(lv, t) * dt);
      reserve -= r;
      canyonE.push({ s: C.topS, w: r });
    }

    // plaza: fresh shots walk up to the gate or a turret pad
    for (const p of plazaP) {
      p.s += C.unitSpeed * dt;
      if (p.slot === 1 && p.s >= C.gateS) {
        canyonP.push({ s: p.s, w: p.w * lv.gateMult, slot: 1 });
        p.w = 0;
      } else if (p.slot !== 1 && p.s >= C.wallS - 1) {
        const i = p.slot === 0 ? 0 : 1;
        need[i] -= p.w;
        while (need[i] <= 0 && tiers[i] < lv.turrets[i].costs.length) {
          tiers[i]++;
          need[i] += nextCost(lv.turrets[i], tiers[i]);
        }
        p.w = 0;
      }
    }
    for (const e of fieldE) e.s -= C.enemySpeed * dt;
    plazaP.sort((a, c) => c.s - a.s);
    clash(plazaP, fieldE);
    for (const e of fieldE) if (e.w > 0 && e.s <= 0.6) {
      base -= e.w;
      e.w = 0;
    }

    // canyon
    for (const p of canyonP) p.s += C.unitSpeed * dt;
    for (const e of canyonE) e.s -= C.enemySpeed * dt;
    canyonP.sort((a, c) => c.s - a.s);
    clash(canyonP, canyonE);
    for (const p of canyonP) if (p.w > 0 && p.s >= C.topS) {
      const k = Math.min(reserve, p.w);
      reserve -= k;
      kills += k;
      p.w = 0;
    }
    for (const e of canyonE) if (e.w > 0 && e.s < C.wallS) {
      fieldE.push({ s: e.s, w: e.w });
      e.w = 0;
    }

    // turrets: nearest enemies first
    let pool = 0;
    tiers.forEach((k, i) => { if (k > 0) pool += lv.turrets[i].dps[k - 1] * dt; });
    for (const list of [fieldE, canyonE]) {
      for (const e of list) {
        if (pool <= 0) break;
        if (e.s > C.wallS + C.turretRange) break;
        const k = Math.min(pool, e.w);
        e.w -= k;
        pool -= k;
        kills += k;
      }
    }

    plazaP = plazaP.filter((p) => p.w > 1e-9);
    canyonP = canyonP.filter((p) => p.w > 1e-9);
    canyonE = canyonE.filter((e) => e.w > 1e-9).sort((a, c) => a.s - c.s);
    fieldE = fieldE.filter((e) => e.w > 1e-9).sort((a, c) => a.s - c.s);

    if (base <= 0) break;
    if (reserve <= 1e-6 && !canyonE.length && !fieldE.length) {
      won = true;
      break;
    }
  }
  const left = reserve + canyonE.reduce((a, e) => a + e.w, 0) + fieldE.reduce((a, e) => a + e.w, 0);
  return { name: '', won, time: t, baseLeft: base, kills, hordeLeft: left };
}

// ------------------------------------------------------------------
// policies
// ------------------------------------------------------------------

/** Turret index → aim slot */
export const turretSlot = (i: number) => (i === 0 ? 0 : 2);

/**
 * Builds turrets in the given order (a list of turret indices, repeats = upgrades),
 * then pours everything through the gate. Defends through the gate whenever the
 * horde is about to break through.
 */
export function smartCanyonPolicy(plan: number[]): CanyonPolicy {
  return (v) => {
    if (v.fieldEnemies > 0 || v.nearestS < CANYON.wallS + 4) return 1;
    const want = [0, 0];
    for (const i of plan) {
      want[i]++;
      if (v.tiers[i] < want[i] && !v.maxed[i]) return turretSlot(i);
    }
    return 1;
  };
}

/** Likes the big gate, sometimes wanders off to a turret, reacts late to leaks. */
export function casualCanyonPolicy(): CanyonPolicy {
  let focus = 1;
  let next = 0;
  return (v, rng) => {
    if (v.t >= next) {
      focus = rng.weighted([0, 1, 2], (s) => (s === 1 ? 1.2 : v.maxed[s === 0 ? 0 : 1] ? 0 : 0.45)) ?? 1;
      next = v.t + rng.range(focus === 1 ? 6 : 2, focus === 1 ? 12 : 6);
    }
    if (v.fieldEnemies > 0 && rng.chance(0.4)) return 1;
    return focus;
  };
}
