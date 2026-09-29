// Twelve obstacle types. Each has animated placeholder geometry and a hazard
// test in track space (x, s). Obstacles remove units rather than killing the
// run outright, and every obstacle has a hard kill budget equal to the
// generator's "worst play" loss model — so the simulation's fairness guarantee
// holds in real play.
import * as THREE from 'three';
import { sfx } from '../audio/SoundSystem';
import { GAME } from '../config/gameConfig';
import type { ObstacleId, WorldOp } from '../core/types';
import { Rng } from '../core/SeedManager';
import type { CameraRig, Overlay, Particles } from '../render/Effects';
import { fmt, obstacleLoss } from '../sim/rules';
import type { ArmyManager } from './ArmyManager';

type ObsOp = WorldOp & { kind: 'obstacle' };

const M = {
  metal: new THREE.MeshLambertMaterial({ color: '#8d96a3', flatShading: true }),
  dark: new THREE.MeshLambertMaterial({ color: '#3b4250', flatShading: true }),
  red: new THREE.MeshLambertMaterial({ color: '#ff4d4d', flatShading: true }),
  hazard: new THREE.MeshLambertMaterial({ color: '#ffcc00', flatShading: true }),
  wood: new THREE.MeshLambertMaterial({ color: '#9b6b3f', flatShading: true }),
  stone: new THREE.MeshLambertMaterial({ color: '#8e8a82', flatShading: true }),
  lava: new THREE.MeshBasicMaterial({ color: '#ff6a1a' }),
  pit: new THREE.MeshBasicMaterial({ color: '#15121a' }),
  vortex: new THREE.MeshBasicMaterial({ color: '#8a3dff', transparent: true, opacity: 0.8 }),
  shadow: new THREE.MeshBasicMaterial({ color: '#000000', transparent: true, opacity: 0.35, depthWrite: false }),
  spike: new THREE.MeshLambertMaterial({ color: '#d7dde6', flatShading: true }),
  ball: new THREE.MeshLambertMaterial({ color: '#2b2f38', flatShading: true }),
  arrow: new THREE.MeshBasicMaterial({ color: '#ffe6a8' }),
};
const BOX = new THREE.BoxGeometry(1, 1, 1);
const CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 10);
const SPH = new THREE.SphereGeometry(0.5, 10, 8);
const CONE = new THREE.ConeGeometry(0.5, 1, 6);

function mesh(g: THREE.BufferGeometry, m: THREE.Material, parent: THREE.Object3D, x = 0, y = 0, z = 0, sx = 1, sy = 1, sz = 1): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  parent.add(o);
  return o;
}

function segDist(px: number, pz: number, ax: number, az: number, bx: number, bz: number): number {
  const dx = bx - ax;
  const dz = bz - az;
  const t = Math.max(0, Math.min(1, ((px - ax) * dx + (pz - az) * dz) / (dx * dx + dz * dz || 1)));
  const cx = ax + dx * t;
  const cz = az + dz * t;
  return Math.hypot(px - cx, pz - cz);
}

interface Ctx {
  armyX: number;
  armyS: number;
}

/** Base obstacle: local coordinates use x (lateral) and d = s - s0 (distance into the obstacle). */
abstract class Obstacle {
  readonly op: ObsOp;
  readonly group = new THREE.Group();
  readonly s0: number;
  readonly len: number;
  readonly x0: number;
  readonly x1: number;
  readonly cx: number;
  readonly w: number;
  readonly I: number;
  readonly rng: Rng;
  /** army squeeze (formation compression) while inside, 1 = none */
  squeeze = 1;
  constructor(op: ObsOp) {
    this.op = op;
    this.s0 = op.s;
    this.len = op.length;
    this.x0 = op.x0;
    this.x1 = op.x1;
    this.cx = (op.x0 + op.x1) / 2;
    this.w = op.x1 - op.x0;
    this.I = op.intensity;
    this.rng = new Rng(op.seed);
    this.group.position.z = -this.s0;
  }
  /** local z for a distance d into the obstacle */
  lz(d: number): number {
    return -d;
  }
  abstract update(t: number, ctx: Ctx, fx: Particles): void;
  abstract hit(x: number, d: number, t: number): boolean;
}

class RotatingBar extends Obstacle {
  bars: THREE.Object3D[] = [];
  speed: number;
  half: number;
  constructor(op: ObsOp) {
    super(op);
    this.speed = (1.1 + 0.7 * this.I) * (this.rng.chance(0.5) ? 1 : -1);
    this.half = this.w / 2 - 0.1;
    const n = this.I > 0.9 && this.rng.chance(0.5) ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const pivot = new THREE.Group();
      pivot.position.set(this.cx, 0, this.lz(this.len * (n === 1 ? 0.5 : 0.3 + k * 0.4)));
      mesh(CYL, M.dark, pivot, 0, 0.6, 0, 0.8, 1.2, 0.8);
      const bar = mesh(BOX, M.red, pivot, 0, 0.55, 0, this.half * 2, 0.4, 0.4);
      mesh(BOX, M.hazard, bar, 0, 0.6, 0, 1.01, 0.2, 1.01);
      this.group.add(pivot);
      this.bars.push(pivot);
    }
  }
  angle(k: number, t: number): number {
    return t * this.speed + k * 1.3;
  }
  update(t: number): void {
    this.bars.forEach((b, k) => (b.rotation.y = this.angle(k, t)));
  }
  hit(x: number, d: number, t: number): boolean {
    for (let k = 0; k < this.bars.length; k++) {
      const a = this.angle(k, t);
      const pd = -this.bars[k].position.z;
      const dx = Math.cos(a) * this.half;
      // rotation.y maps local +x to (cos a, -sin a) in (x, z); track distance d = -z
      const dd = Math.sin(a) * this.half;
      if (segDist(x, d, this.cx - dx, pd - dd, this.cx + dx, pd + dd) < 0.38) return true;
    }
    return false;
  }
}

class Crushers extends Obstacle {
  blocks: { m: THREE.Mesh; x: number; d: number; w: number; phase: number }[] = [];
  period: number;
  constructor(op: ObsOp) {
    super(op);
    this.period = 2.2 - 0.6 * Math.min(1, this.I);
    const lanes = 3;
    const lw = this.w / lanes;
    for (let r = 0; r < 2; r++) {
      for (let l = 0; l < lanes; l++) {
        if (r === 1 && l === 1) continue;
        const x = this.x0 + lw * (l + 0.5);
        const d = this.len * (0.25 + r * 0.5);
        const m = mesh(BOX, M.metal, this.group, x, 3, this.lz(d), lw - 0.2, 1.2, 2.4);
        mesh(BOX, M.hazard, m, 0, -0.45, 0, 1.02, 0.12, 1.02);
        this.blocks.push({ m, x, d, w: lw - 0.2, phase: (l * 0.33 + r * 0.5) % 1 });
      }
    }
  }
  height(b: { phase: number }, t: number): number {
    const p = ((t / this.period + b.phase) % 1 + 1) % 1;
    if (p < 0.5) return 3.2; // up
    if (p < 0.58) return 3.2 - ((p - 0.5) / 0.08) * 2.6; // slam
    if (p < 0.78) return 0.6; // down
    return 0.6 + ((p - 0.78) / 0.22) * 2.6; // rise
  }
  update(t: number, _c: Ctx, fx: Particles): void {
    for (const b of this.blocks) {
      const h = this.height(b, t);
      if (b.m.position.y > 0.9 && h <= 0.9) fx.emit(b.x, 0.2, -this.s0 + this.lz(b.d), 8, '#bbb', { speed: 4, up: 2, size: 0.1 });
      b.m.position.y = h;
    }
  }
  hit(x: number, d: number, t: number): boolean {
    for (const b of this.blocks) {
      if (Math.abs(x - b.x) < b.w / 2 && Math.abs(d - b.d) < 1.2 && this.height(b, t) < 1.2) return true;
    }
    return false;
  }
}

class MovingWall extends Obstacle {
  walls: { l: THREE.Mesh; r: THREE.Mesh; d: number; phase: number; gap: number }[] = [];
  speed: number;
  constructor(op: ObsOp) {
    super(op);
    this.speed = 0.9 + 0.5 * this.I;
    const n = this.I > 0.7 ? 2 : 1;
    for (let k = 0; k < n; k++) {
      const d = this.len * (n === 1 ? 0.5 : 0.3 + 0.45 * k);
      const gap = Math.max(2.4, 4 - this.I * 1.2);
      const l = mesh(BOX, M.stone, this.group, 0, 0.9, this.lz(d), 1, 1.8, 0.6);
      const r = mesh(BOX, M.stone, this.group, 0, 0.9, this.lz(d), 1, 1.8, 0.6);
      this.walls.push({ l, r, d, phase: this.rng.range(0, 6), gap });
    }
  }
  gapX(w: { phase: number; gap: number }, t: number): number {
    return this.cx + Math.sin(t * this.speed + w.phase) * (this.w / 2 - w.gap / 2 - 0.2);
  }
  update(t: number): void {
    for (const w of this.walls) {
      const g = this.gapX(w, t);
      const lw = g - w.gap / 2 - this.x0;
      const rw = this.x1 - (g + w.gap / 2);
      w.l.scale.x = Math.max(0.01, lw);
      w.l.position.x = this.x0 + lw / 2;
      w.r.scale.x = Math.max(0.01, rw);
      w.r.position.x = this.x1 - rw / 2;
    }
  }
  hit(x: number, d: number, t: number): boolean {
    for (const w of this.walls) if (Math.abs(d - w.d) < 0.45 && Math.abs(x - this.gapX(w, t)) > w.gap / 2) return true;
    return false;
  }
}

class Hammers extends Obstacle {
  hs: { pivot: THREE.Group; d: number; phase: number }[] = [];
  speed: number;
  constructor(op: ObsOp) {
    super(op);
    this.speed = 1.6 + 0.8 * this.I;
    const n = 2 + (this.I > 0.9 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const d = this.len * ((k + 0.5) / n);
      mesh(BOX, M.wood, this.group, this.x0 - 0.3, 3.2, this.lz(d), 0.4, 6.4, 0.4);
      mesh(BOX, M.wood, this.group, this.x1 + 0.3, 3.2, this.lz(d), 0.4, 6.4, 0.4);
      mesh(BOX, M.wood, this.group, this.cx, 6.3, this.lz(d), this.w + 1, 0.4, 0.4);
      const pivot = new THREE.Group();
      pivot.position.set(this.cx, 6.1, this.lz(d));
      mesh(BOX, M.dark, pivot, 0, -2.8, 0, 0.18, 5.6, 0.18);
      const head = mesh(CYL, M.red, pivot, 0, -5.4, 0, 1.4, 1.8, 1.4);
      head.rotation.z = Math.PI / 2;
      this.group.add(pivot);
      this.hs.push({ pivot, d, phase: k * 1.7 });
    }
  }
  ang(h: { phase: number }, t: number): number {
    return Math.sin(t * this.speed + h.phase) * 1.0;
  }
  update(t: number): void {
    for (const h of this.hs) h.pivot.rotation.z = this.ang(h, t);
  }
  hit(x: number, d: number, t: number): boolean {
    for (const h of this.hs) {
      const a = this.ang(h, t);
      const hx = this.cx + Math.sin(a) * 5.4;
      const hy = 6.1 - Math.cos(a) * 5.4;
      if (hy < 1.4 && Math.abs(d - h.d) < 0.9 && Math.abs(x - hx) < 1.0) return true;
    }
    return false;
  }
}

class SpikeZone extends Obstacle {
  tiles: { g: THREE.Group; x: number; d: number; w: number; dd: number; phase: number }[] = [];
  period: number;
  constructor(op: ObsOp) {
    super(op);
    this.period = 1.9 - 0.5 * Math.min(1, this.I);
    const cols = 3;
    const rows = 4;
    const tw = this.w / cols;
    const td = this.len / rows;
    for (let r = 0; r < rows; r++) for (let c = 0; c < cols; c++) {
      const x = this.x0 + tw * (c + 0.5);
      const d = td * (r + 0.5);
      mesh(BOX, M.dark, this.group, x, 0.02, this.lz(d), tw - 0.15, 0.06, td - 0.15);
      const g = new THREE.Group();
      g.position.set(x, 0, this.lz(d));
      for (let i = 0; i < 9; i++) {
        const sp = mesh(CONE, M.spike, g, ((i % 3) - 1) * tw * 0.28, 0.35, (Math.floor(i / 3) - 1) * td * 0.28, 0.35, 0.7, 0.35);
        void sp;
      }
      this.group.add(g);
      this.tiles.push({ g, x, d, w: tw, dd: td, phase: ((c + r) % 2) * 0.5 });
    }
  }
  up(p: { phase: number }, t: number): number {
    const k = ((t / this.period + p.phase) % 1 + 1) % 1;
    return k < 0.45 ? 1 : k < 0.5 ? 1 - (k - 0.45) / 0.05 : k < 0.95 ? 0 : (k - 0.95) / 0.05;
  }
  update(t: number): void {
    for (const p of this.tiles) p.g.position.y = -0.7 + this.up(p, t) * 0.7;
  }
  hit(x: number, d: number, t: number): boolean {
    for (const p of this.tiles) if (Math.abs(x - p.x) < p.w / 2 && Math.abs(d - p.d) < p.dd / 2 && this.up(p, t) > 0.6) return true;
    return false;
  }
}

class NarrowPassage extends Obstacle {
  gc: number;
  gap: number;
  constructor(op: ObsOp) {
    super(op);
    this.gap = Math.max(2.6, 4.6 - this.I * 1.4);
    this.gc = this.cx + this.rng.range(-1, 1) * (this.w / 2 - this.gap / 2 - 0.3);
    const lw = this.gc - this.gap / 2 - this.x0;
    const rw = this.x1 - (this.gc + this.gap / 2);
    mesh(BOX, M.stone, this.group, this.x0 + lw / 2, 1.1, this.lz(this.len / 2), lw, 2.2, this.len);
    mesh(BOX, M.stone, this.group, this.x1 - rw / 2, 1.1, this.lz(this.len / 2), rw, 2.2, this.len);
    mesh(BOX, M.hazard, this.group, this.gc - this.gap / 2 - 0.05, 2.25, this.lz(this.len / 2), 0.12, 0.1, this.len);
    mesh(BOX, M.hazard, this.group, this.gc + this.gap / 2 + 0.05, 2.25, this.lz(this.len / 2), 0.12, 0.1, this.len);
    this.squeeze = 0.55;
  }
  update(): void {}
  hit(x: number, d: number): boolean {
    return d > 0.3 && d < this.len && Math.abs(x - this.gc) > this.gap / 2;
  }
}

class FallingRocks extends Obstacle {
  rocks: { m: THREE.Mesh; sh: THREE.Mesh; x: number; d: number; period: number; phase: number }[] = [];
  constructor(op: ObsOp) {
    super(op);
    const n = 5 + Math.round(this.I * 4);
    for (let i = 0; i < n; i++) {
      const x = this.rng.range(this.x0 + 0.8, this.x1 - 0.8);
      const d = this.rng.range(1, this.len - 1);
      const sh = mesh(CYL, M.shadow, this.group, x, 0.03, this.lz(d), 2.2, 0.02, 2.2);
      const m = mesh(new THREE.DodecahedronGeometry(0.9, 0), M.stone, this.group, x, 20, this.lz(d));
      this.rocks.push({ m, sh, x, d, period: this.rng.range(1.6, 2.4), phase: this.rng.range(0, 1) });
    }
  }
  k(r: { period: number; phase: number }, t: number): number {
    return ((t / r.period + r.phase) % 1 + 1) % 1;
  }
  update(t: number, _c: Ctx, fx: Particles): void {
    for (const r of this.rocks) {
      const k = this.k(r, t);
      const y = k < 0.6 ? 18 - (k / 0.6) * (k / 0.6) * 17.4 : 0.6 - (k - 0.6) * 1.5;
      if (r.m.position.y > 0.8 && y <= 0.8) fx.emit(r.x, 0.3, -this.s0 + this.lz(r.d), 10, '#9a948a', { speed: 5, up: 3 });
      r.m.position.y = y;
      r.m.rotation.x = t * 3;
      (r.sh.material as THREE.MeshBasicMaterial).opacity = 0.35;
      r.sh.scale.setScalar(k < 0.6 ? 0.5 + k * 2.5 : 2);
      r.sh.scale.y = 0.02;
    }
  }
  hit(x: number, d: number, t: number): boolean {
    for (const r of this.rocks) {
      const k = this.k(r, t);
      if (k > 0.56 && k < 0.66 && Math.hypot(x - r.x, d - r.d) < 1.2) return true;
    }
    return false;
  }
}

class Towers extends Obstacle {
  shots: { m: THREE.Mesh; fx0: number; fd0: number; tx: number; td: number; t0: number; alive: boolean }[] = [];
  towers: { x: number; d: number; next: number }[] = [];
  interval: number;
  constructor(op: ObsOp) {
    super(op);
    this.interval = 1.0 - 0.35 * Math.min(1, this.I);
    for (const side of [-1, 1]) for (const f of [0.3, 0.75]) {
      const x = side < 0 ? this.x0 - 1.6 : this.x1 + 1.6;
      const d = this.len * f;
      mesh(CYL, M.stone, this.group, x, 2, this.lz(d), 1.6, 4, 1.6);
      mesh(CONE, M.red, this.group, x, 4.7, this.lz(d), 2, 1.4, 2);
      this.towers.push({ x, d, next: this.rng.range(0, this.interval) });
    }
  }
  update(t: number, c: Ctx, fx: Particles): void {
    const armyD = c.armyS - this.s0;
    for (const tw of this.towers) {
      if (t >= tw.next && armyD > -20 && armyD < this.len + 4) {
        tw.next = t + this.interval * this.rng.range(0.8, 1.2);
        const lead = 11 * 0.8;
        const m = mesh(new THREE.ConeGeometry(0.12, 0.8, 4), M.arrow, this.group, tw.x, 4, this.lz(tw.d));
        this.shots.push({ m, fx0: tw.x, fd0: tw.d, tx: c.armyX + this.rng.range(-1.2, 1.2), td: armyD + lead + this.rng.range(-1, 1), t0: t, alive: true });
      }
    }
    for (const s of this.shots) {
      if (!s.alive) continue;
      const k = (t - s.t0) / 0.8;
      if (k >= 1.05) {
        s.alive = false;
        this.group.remove(s.m);
        fx.emit(s.tx, 0.2, -this.s0 + this.lz(s.td), 6, '#ffe6a8', { speed: 3, up: 2, size: 0.08 });
        continue;
      }
      const x = s.fx0 + (s.tx - s.fx0) * k;
      const d = s.fd0 + (s.td - s.fd0) * k;
      s.m.position.set(x, 4 * (1 - k) + Math.sin(k * Math.PI) * 2, this.lz(d));
      s.m.rotation.x = -Math.PI / 2 * k;
    }
    this.shots = this.shots.filter((s) => s.alive);
  }
  hit(x: number, d: number, t: number): boolean {
    for (const s of this.shots) {
      const k = (t - s.t0) / 0.8;
      if (k > 0.92 && k < 1.05 && Math.hypot(x - s.tx, d - s.td) < 0.9) return true;
    }
    return false;
  }
}

class Cannon extends Obstacle {
  balls: { m: THREE.Mesh; x: number; d: number; alive: boolean }[] = [];
  next = 0;
  interval: number;
  speed: number;
  armed = false;
  private lastT = -1;
  constructor(op: ObsOp) {
    super(op);
    this.interval = 0.75 - 0.25 * Math.min(1, this.I);
    this.speed = 7 + 3 * this.I;
    const base = mesh(BOX, M.dark, this.group, this.cx, 0.7, this.lz(this.len + 1.5), 2.4, 1.4, 2);
    const barrel = mesh(CYL, M.ball, this.group, this.cx, 0.9, this.lz(this.len + 0.3), 1.1, 2.2, 1.1);
    barrel.rotation.x = Math.PI / 2;
    void base;
  }
  update(t: number, c: Ctx, fx: Particles): void {
    const armyD = c.armyS - this.s0;
    if (!this.armed && armyD > -45) {
      this.armed = true;
      this.next = t;
    }
    if (this.armed && t >= this.next && armyD < this.len) {
      this.next = t + this.interval;
      const x = this.rng.chance(0.5) ? c.armyX + this.rng.range(-1.5, 1.5) : this.rng.range(this.x0 + 0.8, this.x1 - 0.8);
      const m = mesh(SPH, M.ball, this.group, x, 0.7, this.lz(this.len));
      m.scale.setScalar(1.4);
      this.balls.push({ m, x: Math.max(this.x0 + 0.7, Math.min(this.x1 - 0.7, x)), d: this.len, alive: true });
      fx.emit(this.cx, 1, -this.s0 + this.lz(this.len), 6, '#777', { speed: 2, up: 2 });
      sfx.play('hit');
    }
    // balls roll toward the player (decreasing d)
    const dt = this.lastT < 0 ? 0 : Math.min(0.1, t - this.lastT);
    this.lastT = t;
    for (const b of this.balls) {
      b.d -= this.speed * dt;
      b.m.position.set(b.x, 0.7, this.lz(b.d));
      b.m.rotation.x -= 0.2;
      if (b.d < -30) {
        b.alive = false;
        this.group.remove(b.m);
      }
    }
    this.balls = this.balls.filter((b) => b.alive);
  }
  hit(x: number, d: number): boolean {
    for (const b of this.balls) if (Math.hypot(x - b.x, d - b.d) < 0.85) return true;
    return false;
  }
}

class Platforms extends Obstacle {
  plats: { m: THREE.Mesh; phase: number; w: number }[] = [];
  speed: number;
  constructor(op: ObsOp) {
    super(op);
    this.speed = 0.8 + 0.4 * this.I;
    const pit = mesh(BOX, M.pit, this.group, this.cx, -0.25, this.lz(this.len / 2), this.w + 0.02, 0.52, this.len);
    void pit;
    const n = 2;
    for (let k = 0; k < n; k++) {
      const w = Math.max(3, 4.2 - this.I);
      const m = mesh(BOX, M.hazard, this.group, 0, 0.0, this.lz(this.len / 2), w, 0.3, this.len);
      this.plats.push({ m, phase: k * Math.PI, w });
    }
    this.squeeze = 0.6;
  }
  px(p: { phase: number; w: number }, t: number): number {
    return this.cx + Math.sin(t * this.speed + p.phase) * (this.w / 2 - p.w / 2);
  }
  update(t: number): void {
    for (const p of this.plats) p.m.position.x = this.px(p, t);
  }
  hit(x: number, d: number, t: number): boolean {
    if (d < 0.4 || d > this.len - 0.2) return false;
    for (const p of this.plats) if (Math.abs(x - this.px(p, t)) < p.w / 2) return false;
    return true;
  }
}

class Lava extends Obstacle {
  pools: { x: number; d: number; w: number; dd: number; m: THREE.Mesh }[] = [];
  constructor(op: ObsOp) {
    super(op);
    const rows = 4;
    const cols = 3;
    const tw = this.w / cols;
    const td = this.len / rows;
    let safe = this.rng.int(0, cols - 1);
    for (let r = 0; r < rows; r++) {
      // each row has one safe lane which drifts by at most one lane per row → always passable
      safe = Math.max(0, Math.min(cols - 1, safe + this.rng.int(-1, 1)));
      for (let c = 0; c < cols; c++) {
        if (c === safe) continue;
        if (this.I < 0.6 && this.rng.chance(0.35)) continue;
        const x = this.x0 + tw * (c + 0.5);
        const d = td * (r + 0.5);
        const m = mesh(BOX, M.lava, this.group, x, 0.03, this.lz(d), tw - 0.1, 0.05, td - 0.3);
        this.pools.push({ x, d, w: tw - 0.1, dd: td - 0.3, m });
      }
    }
  }
  update(t: number, _c: Ctx, fx: Particles): void {
    if (Math.random() < 0.3 && this.pools.length) {
      const p = this.pools[(Math.random() * this.pools.length) | 0];
      fx.emit(p.x + (Math.random() - 0.5) * p.w, 0.1, -this.s0 + this.lz(p.d), 1, '#ffb13a', { speed: 0.5, up: 3, gravity: 6, size: 0.1, life: 0.6 });
    }
    void t;
  }
  hit(x: number, d: number): boolean {
    for (const p of this.pools) if (Math.abs(x - p.x) < p.w / 2 && Math.abs(d - p.d) < p.dd / 2) return true;
    return false;
  }
}

class Vortex extends Obstacle {
  vs: { m: THREE.Mesh; phase: number; d: number; r: number }[] = [];
  constructor(op: ObsOp) {
    super(op);
    const n = 2 + (this.I > 0.8 ? 1 : 0);
    for (let k = 0; k < n; k++) {
      const r = 1.3 + this.I * 0.3;
      const m = mesh(new THREE.TorusGeometry(r, 0.25, 6, 20), M.vortex, this.group, 0, 0.1, 0);
      m.rotation.x = -Math.PI / 2;
      this.vs.push({ m, phase: k * 2.1, d: this.len * ((k + 0.5) / n), r });
    }
  }
  vx(v: { phase: number; r: number }, t: number): number {
    return this.cx + Math.sin(t * 0.9 + v.phase) * (this.w / 2 - v.r - 0.2);
  }
  update(t: number, _c: Ctx, fx: Particles): void {
    for (const v of this.vs) {
      v.m.position.set(this.vx(v, t), 0.1, this.lz(v.d));
      v.m.rotation.z = t * 4;
      if (Math.random() < 0.3) fx.emit(v.m.position.x, 0.2, -this.s0 + this.lz(v.d), 1, '#b58cff', { speed: 1, up: 2, gravity: -1, size: 0.1, life: 0.5 });
    }
  }
  hit(x: number, d: number, t: number): boolean {
    for (const v of this.vs) if (Math.hypot(x - this.vx(v, t), d - v.d) < v.r) return true;
    return false;
  }
}

const CLASSES: Record<ObstacleId, new (op: ObsOp) => Obstacle> = {
  rotatingBar: RotatingBar,
  crusher: Crushers,
  movingWall: MovingWall,
  swingingHammer: Hammers,
  spikeZone: SpikeZone,
  narrowPassage: NarrowPassage,
  fallingObjects: FallingRocks,
  enemyTower: Towers,
  projectileLauncher: Cannon,
  movingPlatforms: Platforms,
  lavaZone: Lava,
  stealTrap: Vortex,
};

interface Entry {
  op: ObsOp;
  obs: Obstacle | null;
  entered: boolean;
  exited: boolean;
  budget: number;
  lost: number;
}

export class ObstacleSystem {
  entries: Entry[] = [];
  private scene: THREE.Scene;
  private particles: Particles;
  private overlay: Overlay;
  private cam: CameraRig;
  medics = false;
  onLoss: (n: number) => void = () => {};
  onEnter: (op: ObsOp) => void = () => {};

  constructor(scene: THREE.Scene, particles: Particles, overlay: Overlay, cam: CameraRig) {
    this.scene = scene;
    this.particles = particles;
    this.overlay = overlay;
    this.cam = cam;
  }

  add(op: WorldOp): void {
    if (op.kind !== 'obstacle') return;
    this.entries.push({ op, obs: null, entered: false, exited: false, budget: 0, lost: 0 });
  }

  clear(): void {
    for (const e of this.entries) if (e.obs) this.scene.remove(e.obs.group);
    this.entries = [];
  }

  update(dt: number, time: number, army: ArmyManager): void {
    let squeeze = 1;
    const ctx = { armyX: army.x, armyS: army.s };
    for (const e of this.entries) {
      const o = e.op;
      const ahead = o.s - army.s;
      if (!e.obs && ahead < 170 && ahead > -o.length - 20) {
        e.obs = new CLASSES[o.obstacle](o);
        this.scene.add(e.obs.group);
      }
      if (e.obs && ahead < -o.length - 25) {
        this.scene.remove(e.obs.group);
        e.obs = null;
        continue;
      }
      if (!e.obs) continue;
      const ob = e.obs;
      ob.update(time, ctx, this.particles);

      const inLane = army.x >= o.x0 - 0.5 && army.x <= o.x1 + 0.5;
      const d = army.s - o.s;
      if (!e.entered && army.front >= o.s - 1 && inLane) {
        e.entered = true;
        // hard budget = generator's worst-case loss → simulated fairness holds in play
        e.budget = obstacleLoss(army.n, o.loss.worst);
        this.onEnter(o);
      }
      if (e.entered && !e.exited) {
        if (ob.squeeze < 1 && d > -3 && d < o.length + 1 && inLane) squeeze = Math.min(squeeze, ob.squeeze);
        const units = army.crowd.units;
        for (let i = units.length - 1; i >= 0 && e.budget > 0; i--) {
          const u = units[i];
          const ud = -u.z - o.s;
          if (ud < -0.5 || ud > o.length + 1.5) continue;
          if (u.x < o.x0 - 0.4 || u.x > o.x1 + 0.4) continue;
          if (u.hitCd > 0) continue;
          if (ob.hit(u.x, ud, time)) {
            const lost = army.hitUnit(i, e.budget, o.obstacle === 'lavaZone' ? '#ff7a1a' : o.obstacle === 'stealTrap' ? '#b58cff' : '#ff3b3b');
            e.budget -= lost;
            e.lost += lost;
            if (lost > 0) {
              this.onLoss(lost);
              if (Math.random() < 0.3) sfx.play('death');
            }
          }
        }
        if (army.s - army.radius > o.s + o.length + 1 || !inLane && d > 0) {
          e.exited = true;
          if (e.lost > 0) {
            this.overlay.float(`−${fmt(e.lost)}`, new THREE.Vector3(army.x, 2.2, army.z), 'bad');
            if (this.medics) {
              const heal = Math.floor(e.lost * 0.25);
              if (heal > 0) {
                army.state.n += heal;
                this.overlay.float(`✚ +${fmt(heal)}`, new THREE.Vector3(army.x + 1, 2.8, army.z), 'good');
              }
            }
            if (e.lost > army.n * 0.2) this.cam.shake(0.25);
          }
        }
      }
    }
    army.setSqueeze(squeeze);
  }
}
