// The single source of truth for army math. The generator's offline simulation
// and live gameplay both call these functions, so predicted outcomes match play.
import type { GateSpec } from '../core/types';

export interface ArmyState {
  n: number;
  shield: number;
  dbl: boolean;
  lastGain: number;
  charge: boolean;
  bank: number;
  split: boolean;
  dead: boolean;
}

export type GateMode = 'actual' | 'worst' | 'expected';

export const MAX_ARMY = 1e12;

export function newArmy(n: number): ArmyState {
  return { n, shield: 0, dbl: false, lastGain: 0, charge: false, bank: 0, split: false, dead: n <= 0 };
}

export function cloneArmy(a: ArmyState): ArmyState {
  return { ...a };
}

const NUMERIC = new Set(['add', 'mul', 'sub', 'div', 'recruit', 'merge']);

export function isNumericGate(g: GateSpec): boolean {
  return NUMERIC.has(g.op);
}

/** Gate as it will actually apply given a pending "double next" */
export function effectiveGate(g: GateSpec, dbl: boolean): GateSpec {
  if (!dbl || !isNumericGate(g)) return g;
  return { ...g, v: g.v * 2 };
}

function clampN(n: number): number {
  return Math.min(MAX_ARMY, Math.max(0, Math.floor(n)));
}

/** Apply a gate. Returns the signed unit change. */
export function applyGate(a: ArmyState, gate: GateSpec, mode: GateMode = 'actual'): number {
  if (a.dead) return 0;
  const before = a.n;
  let g = gate;

  if (g.op === 'mystery') {
    if (mode === 'actual' && g.hidden) g = g.hidden;
    else if (g.pool && g.pool.length) {
      const results = g.pool.map((p) => {
        const t = cloneArmy(a);
        applyGate(t, p, 'actual');
        return t.n;
      });
      if (mode === 'worst') g = g.pool[results.indexOf(Math.min(...results))];
      else {
        const mean = results.reduce((s, r) => s + r, 0) / results.length;
        g = { op: 'add', v: Math.round(mean - a.n) };
        if (g.v < 0) g = { op: 'sub', v: -g.v };
      }
    } else if (g.hidden) g = g.hidden;
  }

  if (isNumericGate(g) && a.dbl) {
    g = effectiveGate(g, true);
    a.dbl = false;
  }

  switch (g.op) {
    case 'add':
    case 'merge':
      a.n = clampN(a.n + g.v);
      break;
    case 'mul':
      a.n = clampN(a.n * g.v);
      break;
    case 'sub':
      a.n = clampN(a.n - g.v);
      break;
    case 'div':
      a.n = Math.max(a.n > 0 ? 1 : 0, Math.ceil(a.n / g.v));
      break;
    case 'recruit':
      a.n = clampN(a.n + Math.ceil((a.n * g.v) / 100));
      break;
    case 'clone': {
      const gain = Math.max(a.lastGain, Math.ceil(a.n * 0.1), 1);
      a.n = clampN(a.n + gain);
      break;
    }
    case 'doubleNext':
      a.dbl = true;
      break;
    case 'shield':
      a.shield = Math.max(a.shield, Math.ceil(a.n * (g.v / 100)) + 3);
      break;
    case 'speed':
      a.charge = true;
      break;
    case 'sacrifice': {
      const lost = Math.floor((a.n * g.v) / 100);
      a.n -= lost;
      a.bank += lost * 3;
      break;
    }
    case 'split':
      a.split = true;
      break;
    case 'bet': {
      const stake = Math.floor(a.n / 2);
      const win = mode === 'actual' ? !!g.win : mode === 'expected' ? null : false;
      if (win === null) a.n = clampN(a.n + stake);
      else if (win) a.n = clampN(a.n + stake * 3);
      else a.n -= stake;
      break;
    }
    case 'vault':
      a.n = clampN(a.n + a.bank);
      a.bank = 0;
      break;
    case 'mystery':
      break;
  }
  const delta = a.n - before;
  if (delta > 0) a.lastGain = delta;
  if (a.n <= 0) {
    a.n = 0;
    a.dead = true;
  }
  return delta;
}

/** Units lost when a shield absorbs part of the damage */
export function applyLoss(a: ArmyState, loss: number): number {
  if (a.dead || loss <= 0) return 0;
  let l = loss;
  if (a.shield > 0) {
    const absorbed = Math.min(a.shield, l);
    a.shield -= absorbed;
    l -= absorbed;
  }
  const actual = Math.min(a.n, l);
  a.n -= actual;
  if (a.n <= 0) {
    a.n = 0;
    a.dead = true;
  }
  return actual;
}

/** Deterministic combat: every enemy power point removes one unit (modified by charge / bonuses). */
export function battleLoss(a: ArmyState, power: number, playerMult = 1): number {
  const mult = playerMult * (a.charge ? 1.3 : 1);
  return Math.ceil(power / mult);
}

export function applyBattle(a: ArmyState, power: number, playerMult = 1): number {
  const loss = battleLoss(a, power, playerMult);
  a.charge = false;
  return applyLoss(a, loss);
}

/** Units lost to an obstacle at a given loss fraction (also the gameplay kill budget). */
export function obstacleLoss(n: number, frac: number): number {
  if (frac <= 0 || n <= 0) return 0;
  return Math.min(n, Math.ceil(n * frac));
}

/** Split armies apply the leftmost/rightmost gate of the next row to each half. */
export function applySplitRow(a: ArmyState, left: GateSpec, right: GateSpec, mode: GateMode): void {
  const h1 = cloneArmy(a);
  const h2 = cloneArmy(a);
  h1.n = Math.floor(a.n / 2);
  h2.n = a.n - h1.n;
  h1.split = h2.split = false;
  h2.dbl = h1.dbl;
  applyGate(h1, left, mode);
  applyGate(h2, right, mode);
  a.n = clampN(h1.n + h2.n);
  a.dbl = false;
  a.split = false;
  a.lastGain = Math.max(h1.lastGain, h2.lastGain);
  a.dead = a.n <= 0;
}

// ---------- presentation helpers ----------

export function gateLabel(g: GateSpec): { main: string; sub?: string } {
  switch (g.op) {
    case 'add': return { main: '+' + fmt(g.v) };
    case 'mul': return { main: '×' + fmt(g.v) };
    case 'sub': return { main: '−' + fmt(g.v) };
    case 'div': return { main: '÷' + fmt(g.v) };
    case 'recruit': return { main: '+' + g.v + '%', sub: 'RECRUIT' };
    case 'merge': return { main: '+' + fmt(g.v), sub: 'ALLIES' };
    case 'clone': return { main: 'CLONE', sub: 'repeat last gain' };
    case 'doubleNext': return { main: '2× NEXT', sub: 'doubles next gate' };
    case 'shield': return { main: 'SHIELD', sub: 'absorbs losses' };
    case 'speed': return { main: 'CHARGE', sub: 'speed + 30% power' };
    case 'mystery': return { main: '?', sub: 'MYSTERY' };
    case 'sacrifice': return { main: '−' + g.v + '%', sub: '×3 at VAULT' };
    case 'split': return { main: 'SPLIT', sub: 'take both gates' };
    case 'bet': return { main: '2× OR 0', sub: 'bet half' };
    case 'vault': return { main: 'VAULT', sub: 'sacrifice payout' };
  }
}

export type GateTone = 'good' | 'bad' | 'special' | 'golden';

export function gateTone(g: GateSpec): GateTone {
  if (g.golden) return 'golden';
  if (g.op === 'sub' || g.op === 'div') return 'bad';
  if (g.op === 'add' || g.op === 'mul' || g.op === 'recruit' || g.op === 'merge') return 'good';
  return 'special';
}

export function fmt(n: number): string {
  if (!Number.isFinite(n)) return '∞';
  const a = Math.abs(n);
  if (a < 10000) return String(Math.round(n));
  const units = ['K', 'M', 'B', 'T'];
  let v = a;
  let i = -1;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  const s = v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
  return (n < 0 ? '-' : '') + s.replace(/\.0+$/, '') + units[i];
}

const NICE = [1, 1.2, 1.5, 2, 2.5, 3, 4, 5, 6, 7.5, 8];
/** Round to a "designer-looking" number (5, 25, 150, 2.5K...) */
export function niceRound(x: number): number {
  if (x <= 1) return 1;
  if (x < 12) return Math.round(x);
  const p = Math.pow(10, Math.floor(Math.log10(x)));
  const m = x / p;
  let best = NICE[0];
  for (const c of NICE) if (Math.abs(c - m) < Math.abs(best - m)) best = c;
  if (Math.abs(10 - m) < Math.abs(best - m)) best = 10;
  return Math.round(best * p);
}
