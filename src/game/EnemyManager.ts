// Enemy groups: formations, clear strength labels, ambush entrances, and
// handing contact over to the CombatSystem.
import * as THREE from 'three';
import { GAME } from '../config/gameConfig';
import type { Formation, WorldOp } from '../core/types';
import { Crowd, spiralSlot } from '../render/Crowd';
import type { Overlay, Particles } from '../render/Effects';
import { unitGeometry } from '../render/UnitGeometry';
import { fmt } from '../sim/rules';
import type { ArmyManager } from './ArmyManager';
import type { CombatSystem } from './CombatSystem';

type EnemyOp = WorldOp & { kind: 'enemy' };

interface Group {
  op: EnemyOp;
  crowd: Crowd | null;
  label: HTMLDivElement | null;
  remaining: number;
  shownFull: number;
  state: 'wait' | 'fight' | 'dead';
  cx: number;
  slots: { x: number; d: number }[];
  ambush: number; // 0..1 entrance progress
  halfW: number;
  color: string;
}

const geos: Record<string, THREE.BufferGeometry> = {};
function geo(kind: string): THREE.BufferGeometry {
  return (geos[kind] ??= unitGeometry(kind === 'brute' || kind === 'champion' ? 'brute' : 'classic'));
}

const ENEMY_COLORS: Record<string, string> = {
  normal: '#e8413c', horde: '#c2388a', brute: '#a8231f', champion: '#7b1fa2', ambush: '#e8603c',
};

export function formationSlots(f: Formation, n: number, width: number, seed: number): { x: number; d: number }[] {
  const out: { x: number; d: number }[] = [];
  const sp = 0.46;
  const maxCols = Math.max(2, Math.floor(width / sp));
  const s = { x: 0, z: 0 };
  let rnd = seed || 1;
  const rand = () => ((rnd = (rnd * 16807) % 2147483647) / 2147483647);
  switch (f) {
    case 'line': {
      const cols = Math.min(maxCols, Math.max(1, n));
      for (let i = 0; i < n; i++) out.push({ x: ((i % cols) - (cols - 1) / 2) * sp, d: Math.floor(i / cols) * sp });
      break;
    }
    case 'wedge': {
      let row = 0;
      let i = 0;
      while (i < n) {
        const w = Math.min(maxCols, row + 1);
        for (let k = 0; k < w && i < n; k++, i++) out.push({ x: (k - (w - 1) / 2) * sp, d: row * sp * 0.9 });
        row++;
      }
      break;
    }
    case 'circle': {
      const R = 0.26 * Math.sqrt(n);
      for (let i = 0; i < n; i++) {
        spiralSlot(i, 0.26, s);
        out.push({ x: s.x, d: R + s.z });
      }
      break;
    }
    case 'ranks': {
      const cols = Math.min(maxCols, Math.max(2, Math.ceil(Math.sqrt(n * 2))));
      for (let i = 0; i < n; i++) {
        const r = Math.floor(i / cols);
        out.push({ x: ((i % cols) - (cols - 1) / 2) * sp, d: r * sp + Math.floor(r / 3) * 0.5 });
      }
      break;
    }
    case 'scatter': {
      const area = n * sp * sp * 1.6;
      const depth = Math.max(2, area / width);
      for (let i = 0; i < n; i++) out.push({ x: (rand() - 0.5) * width, d: rand() * depth });
      break;
    }
    default: {
      const cols = Math.min(maxCols, Math.max(1, Math.ceil(Math.sqrt(n * 1.4))));
      for (let i = 0; i < n; i++) out.push({ x: ((i % cols) - (cols - 1) / 2) * sp, d: Math.floor(i / cols) * sp });
    }
  }
  // front-most first so battles eat the front line
  out.sort((a, b) => a.d - b.d);
  return out;
}

export class EnemyManager {
  groups: Group[] = [];
  private scene: THREE.Scene;
  private overlay: Overlay;
  private particles: Particles;
  archers = false;
  onDefeated: (display: number, power: number) => void = () => {};
  onEncounter: (op: EnemyOp) => void = () => {};

  constructor(scene: THREE.Scene, overlay: Overlay, particles: Particles) {
    this.scene = scene;
    this.overlay = overlay;
    this.particles = particles;
  }

  add(op: WorldOp): void {
    if (op.kind !== 'enemy') return;
    this.groups.push({
      op, crowd: null, label: null, remaining: op.power, shownFull: 0, state: 'wait',
      cx: (op.x0 + op.x1) / 2, halfW: 0, slots: [], ambush: op.enemy === 'ambush' ? 0 : 1, color: ENEMY_COLORS[op.enemy] ?? '#e8413c',
    });
    this.groups.sort((a, b) => a.op.s - b.op.s);
  }

  clear(): void {
    for (const g of this.groups) this.dispose(g);
    this.groups = [];
  }

  private build(g: Group): void {
    const o = g.op;
    const cap = GAME.enemy.renderCap;
    let visible = Math.min(cap, o.display);
    let scale = 1;
    if (o.enemy === 'brute') {
      visible = Math.min(cap, Math.max(1, Math.ceil(o.display / 3)));
      scale = 1.4;
    } else if (o.enemy === 'horde') scale = 0.78;
    else if (o.enemy === 'champion') {
      visible = 1 + Math.min(12, Math.floor(o.display / 20));
      scale = 1;
    }
    const width = o.x1 - o.x0 - 0.6;
    g.slots = o.enemy === 'champion'
      ? [{ x: 0, d: 0.8 }, ...formationSlots('circle', visible - 1, width, o.id).map((s) => ({ x: s.x * 1.6, d: s.d + 2.2 }))]
      : formationSlots(o.formation, visible, width, o.id);
    g.halfW = g.slots.reduce((m, sl) => Math.max(m, Math.abs(sl.x)), 0);
    const crowd = new Crowd(this.scene, geo(o.enemy), g.color, visible, Math.PI);
    crowd.unitScale = scale;
    crowd.running = false;
    for (let i = 0; i < visible; i++) {
      const sl = g.slots[i];
      let x = g.cx + sl.x;
      if (g.ambush < 1) x += (sl.x < 0 ? -1 : 1) * 12;
      const u = crowd.spawn(x, -(o.s + sl.d + 0.3), -1);
      if (u && o.enemy === 'champion' && i === 0) u.sc = 3.2;
    }
    crowd.commit(0);
    g.crowd = crowd;
    g.shownFull = visible;
    g.label = this.overlay.label('enemy-count ' + o.enemy);
    this.updateLabel(g);
  }

  private updateLabel(g: Group): void {
    if (!g.label) return;
    const o = g.op;
    const shown = Math.ceil(o.display * (g.remaining / o.power));
    const tag = o.enemy === 'horde' ? 'HORDE ' : o.enemy === 'champion' ? '👑 ' : o.enemy === 'brute' ? '💪 ' : '';
    g.label.innerHTML = `${tag}${fmt(shown)}${o.enemy === 'horde' ? `<small>power ${fmt(Math.ceil(g.remaining))}</small>` : ''}`;
  }

  private dispose(g: Group): void {
    g.crowd?.dispose();
    g.crowd = null;
    g.label?.remove();
    g.label = null;
  }

  update(dt: number, time: number, army: ArmyManager, combat: CombatSystem): void {
    for (const g of this.groups) {
      const o = g.op;
      const ahead = o.s - army.s;
      if (!g.crowd && g.state !== 'dead' && ahead < 175) this.build(g);
      if (g.crowd && ahead < -25) this.dispose(g);
      if (!g.crowd) continue;

      // full-width groups shift to meet the army head-on
      if (g.state === 'wait' && o.x1 - o.x0 > 9 && ahead < 32 && ahead > -2) {
        const lim = Math.max(0, (o.x1 - o.x0) / 2 - g.halfW - 0.3);
        const want = Math.max(-lim, Math.min(lim, army.x));
        g.cx += (want - g.cx) * Math.min(1, dt * 3);
      }
      // ambushers rush in from the flanks as the army approaches
      if (g.ambush < 1 && ahead < 38) {
        g.ambush = Math.min(1, g.ambush + dt * 1.6);
        g.crowd.running = true;
      }
      const units = g.crowd.units;
      const frac = g.remaining / o.power;
      const want = g.state === 'dead' ? 0 : Math.max(g.state === 'fight' ? 0 : 1, Math.ceil(g.shownFull * frac));
      while (units.length > want) {
        // the front line falls first; units behind glide forward into the freed slots
        let i = g.crowd.extremeIndex(1);
        if (o.enemy === 'champion' && units.length > 1 && units[i].sc) {
          // the champion falls last
          i = units.findIndex((u) => !u.sc);
        }
        const u = units[i];
        this.particles.emit(u.x, 0.4, u.z, 3, g.color, { speed: 3, up: 3, size: 0.11, life: 0.5 });
        g.crowd.removeAt(i);
      }
      const ease = g.ambush < 1 ? 1 - Math.pow(1 - g.ambush, 2) : 1;
      const champ = o.enemy === 'champion' ? units.findIndex((u) => u.sc) : -1;
      for (let i = 0; i < units.length; i++) {
        const u = units[i];
        const si = champ < 0 ? i : i === champ ? 0 : i < champ ? i + 1 : i;
        const sl = g.slots[si] ?? { x: 0, d: 0 };
        let tx = g.cx + sl.x;
        if (ease < 1) tx += (sl.x < 0 ? -1 : 1) * 12 * (1 - ease);
        u.tx = tx;
        const pushBack = g.state === 'fight' ? -0.6 : 0;
        u.tz = -(o.s + sl.d + 0.3) - pushBack;
        if (g.state === 'fight') u.tz = Math.max(u.tz, -(army.front + 0.9)) ;
      }
      g.crowd.running = g.state === 'fight' || g.ambush < 1;
      g.crowd.update(dt, time);
      if (g.label) {
        if (g.state === 'dead') g.label.style.display = 'none';
        else this.overlay.place(g.label, new THREE.Vector3(g.cx, 1.6 + (o.enemy === 'champion' ? 1.5 : 0), -(o.s + 0.5)));
      }

      // contact
      if (g.state === 'wait' && !combat.fighting && army.front >= o.s && army.n > 0) {
        const inLane = army.x >= o.x0 - 0.01 && army.x <= o.x1 + 0.01;
        if (!inLane) continue;
        this.onEncounter(o);
        if (this.archers) {
          const volley = Math.floor(g.remaining * 0.08);
          if (volley > 0) {
            g.remaining -= volley;
            this.overlay.float(`🏹 −${fmt(volley)}`, new THREE.Vector3(g.cx, 2.4, -o.s), 'special');
          }
        }
        g.state = 'fight';
        const startRemaining = g.remaining;
        combat.start(army, {
          kind: 'enemy',
          power: startRemaining,
          contactS: o.s,
          x: g.cx,
          color: g.color,
          onProgress: (rem) => {
            g.remaining = startRemaining * rem;
            this.updateLabel(g);
          },
          onEnd: (won) => {
            if (won) {
              g.remaining = 0;
              g.state = 'dead';
              this.onDefeated(o.display, o.power);
            } else g.state = 'wait';
            this.updateLabel(g);
          },
        });
      }
    }
  }

  /** Is there an unbeaten enemy blocking the army's forward movement? */
  blocking(army: ArmyManager): boolean {
    return this.groups.some((g) => g.state === 'fight');
  }
}
