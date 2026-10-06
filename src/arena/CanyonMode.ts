// Canyon Siege gameplay (a special Arena level). The cannon slides across a
// plaza at the foot of a winding cliff-top canyon. Aim at the ×N gate to send a
// multiplied army up the canyon, or at a turret pad to build / upgrade a gatling
// that shreds the horde on its own. The horde pours down the canyon in a red
// river: destroy all of it before it overruns the cannon.
import * as THREE from 'three';
import { sfx, haptic } from '../audio/SoundSystem';
import { CANYON, pathCenter, slotAt } from '../config/canyonConfig';
import type { GateSpec } from '../core/types';
import { panelTexture } from '../game/GateSystem';
import type { Overlay, Particles } from '../render/Effects';
import type { Stage3D } from '../render/Stage3D';
import { unitGeometry, weaponGeometry } from '../render/UnitGeometry';
import { fmt } from '../sim/rules';
import type { ArenaStats } from './ArenaMode';
import { nextCost, releaseRate, type CanyonLevelData } from './CanyonSim';

interface PUnit { x: number; s: number; w: number; slot: number; up: boolean; born: number; off: number }
interface EUnit { x: number; s: number; w: number; phase: number; stun: number; hit: number; off: number }

interface RtTurret {
  i: number;
  x: number;
  tier: number;
  need: number;
  pool: number;
  tracerT: number;
  spin: number;
  heat: number;
  group: THREE.Group;
  head: THREE.Group;
  barrels: THREE.Group;
  label: HTMLDivElement;
  pulse: number;
}

const SPLIT_MAX = 10;
const TRACERS = 96;

const ROCK = new THREE.MeshLambertMaterial({ color: '#8d939c', flatShading: true });
const ROCK_DARK = new THREE.MeshLambertMaterial({ color: '#5f6670', flatShading: true });
const SAND = new THREE.MeshLambertMaterial({ color: '#d8c39a' });
const DIRT = new THREE.MeshLambertMaterial({ color: '#a8875e', flatShading: true });
const GRASS = new THREE.MeshLambertMaterial({ color: '#6fa64a', flatShading: true });
const POST = new THREE.MeshLambertMaterial({ color: '#8a6a45', flatShading: true });
const GOLD = new THREE.MeshLambertMaterial({ color: '#e0a526', flatShading: true });
const GOLD_DARK = new THREE.MeshLambertMaterial({ color: '#a8701a', flatShading: true });
const GHOST = new THREE.MeshLambertMaterial({ color: '#c9ced6', transparent: true, opacity: 0.55, flatShading: true });
const FENCE = new THREE.MeshLambertMaterial({ color: '#f2c230', flatShading: true });

export class CanyonMode {
  readonly lv: CanyonLevelData;
  private stage: Stage3D;
  private particles: Particles;
  private overlay: Overlay;
  private root = new THREE.Group();
  private players: PUnit[] = [];
  private enemies: EUnit[] = [];
  private turrets: RtTurret[] = [];
  private pMesh: THREE.InstancedMesh;
  private wMesh: THREE.InstancedMesh | null = null;
  private eMesh: THREE.InstancedMesh;
  private sourceMesh: THREE.InstancedMesh;
  private sourceSpots: { x: number; s: number; p: number }[] = [];
  private tracers: THREE.LineSegments;
  private tracerLife = new Float32Array(TRACERS);
  private tracerNext = 0;
  private cannon: THREE.Group;
  private reticle: THREE.Group;
  private slotGlow: THREE.Mesh;
  private chevrons: THREE.Mesh[] = [];
  private gate: THREE.Group;
  private gatePulse = 0;
  private hordeLabel: HTMLDivElement;
  private baseLabel: HTMLDivElement;
  private leakLabel: HTMLDivElement;
  reserve: number;
  base: number;
  t = 0;
  cannonX = 0;
  private releaseAcc = 0;
  private lastSlot = -1;
  private fireAcc = 0;
  private lock = 0;
  private fireCd = 0;
  private shake = 0;
  private doomT = 0;
  private doomCheckT = 0;
  state: 'play' | 'won' | 'lost' = 'play';
  private endT = 0;
  private reason = '';
  private stats = { kills: 0, peak: 0, tiers: 0 };
  private color: string;
  slowmo = 0;
  onEnd: (s: ArenaStats) => void = () => {};
  onBanner: (text: string, cls?: string, dur?: number) => void = () => {};

  constructor(stage: Stage3D, particles: Particles, overlay: Overlay, lv: CanyonLevelData, cos: { skin: string; color: string; weapon: string }) {
    this.stage = stage;
    this.particles = particles;
    this.overlay = overlay;
    this.lv = lv;
    this.color = cos.color;
    this.reserve = lv.horde;
    this.base = lv.baseHP;
    stage.scene.add(this.root);
    const C = CANYON;
    const HW = C.halfWidth;

    // --- units
    this.pMesh = new THREE.InstancedMesh(unitGeometry(cos.skin), new THREE.MeshLambertMaterial({ vertexColors: true }), C.playerCap);
    this.pMesh.frustumCulled = false;
    this.pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const pc = new THREE.Color(cos.color);
    for (let i = 0; i < C.playerCap; i++) this.pMesh.setColorAt(i, pc);
    this.root.add(this.pMesh);
    const wg = weaponGeometry(cos.weapon);
    if (wg) {
      this.wMesh = new THREE.InstancedMesh(wg.geo, new THREE.MeshLambertMaterial({ color: wg.color, vertexColors: true }), C.playerCap);
      this.wMesh.frustumCulled = false;
      this.root.add(this.wMesh);
    }
    const ec = new THREE.Color('#e8413c');
    this.eMesh = new THREE.InstancedMesh(unitGeometry('classic'), new THREE.MeshLambertMaterial({ vertexColors: true }), C.enemyCap);
    this.eMesh.frustumCulled = false;
    this.eMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < C.enemyCap; i++) this.eMesh.setColorAt(i, ec);
    this.root.add(this.eMesh);

    // --- the reserve: a sea of red waiting at the top of the canyon (thins out as it's spent)
    const SRC = 900;
    this.sourceMesh = new THREE.InstancedMesh(unitGeometry('classic'), new THREE.MeshLambertMaterial({ vertexColors: true }), SRC);
    this.sourceMesh.frustumCulled = false;
    for (let i = 0; i < SRC; i++) this.sourceMesh.setColorAt(i, ec);
    for (let i = 0; i < SRC; i++) {
      const s = C.topS + 0.5 + Math.pow(Math.random(), 0.8) * 13;
      const half = 3 + (s - C.topS) * 1.6;
      this.sourceSpots.push({ x: pathCenter(lv.path, C.topS) * 0.5 + (Math.random() * 2 - 1) * Math.min(18, half), s, p: Math.random() * 6 });
    }
    // front rows (closest to the canyon) leave first
    this.sourceSpots.sort((a, b) => b.s - a.s);
    this.root.add(this.sourceMesh);

    this.buildWorld();

    // --- barricade: yellow fence, ×N gate in the middle, turret pads on the sides
    const ws = C.wallS;
    for (const side of [-1, 1]) {
      const rail = new THREE.Mesh(new THREE.BoxGeometry(HW - C.slotHalf, 0.35, 0.35), FENCE);
      rail.position.set(side * (C.slotHalf + (HW - C.slotHalf) / 2), 0.55, -ws - 0.6);
      this.root.add(rail);
    }
    this.gate = new THREE.Group();
    const spec: GateSpec = { op: 'mul', v: lv.gateMult, golden: true };
    const gw = C.slotHalf * 2 - 0.4;
    const face = new THREE.MeshBasicMaterial({ map: panelTexture(spec) });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(gw, 2.2, 0.35), [FENCE, FENCE, FENCE, FENCE, face, FENCE]);
    panel.position.y = 1.2;
    panel.rotation.x = -0.85;
    this.gate.add(panel);
    for (const x of [-gw / 2 - 0.12, gw / 2 + 0.12]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.3, 2, 0.3), FENCE);
      p.position.set(x, 1, 0.1);
      this.gate.add(p);
    }
    this.gate.position.set(0, 0, -C.gateS);
    this.root.add(this.gate);

    lv.turrets.forEach((spec, i) => {
      const x = (i === 0 ? -1 : 1) * (C.slotHalf + HW) / 2;
      const big = spec.kind === 'big';
      const group = new THREE.Group();
      const pad = new THREE.Mesh(new THREE.BoxGeometry(HW - C.slotHalf - 0.4, 0.9, 2.6), GOLD_DARK);
      pad.position.y = 0.45;
      group.add(pad);
      const head = new THREE.Group();
      head.position.y = 0.9;
      const k = big ? 1.45 : 1;
      const housing = new THREE.Mesh(new THREE.CylinderGeometry(0.8 * k, 0.95 * k, 0.8 * k, 12), GHOST);
      housing.position.y = 0.4 * k;
      head.add(housing);
      const barrels = new THREE.Group();
      barrels.position.set(0, 1.05 * k, -0.2);
      const n = big ? 12 : 6;
      const drum = new THREE.Mesh(new THREE.CylinderGeometry(0.62 * k, 0.62 * k, 1.5 * k, 14), GHOST);
      drum.rotation.x = Math.PI / 2;
      barrels.add(drum);
      for (let j = 0; j < n; j++) {
        const a = (j / n) * Math.PI * 2;
        const r = (big ? 0.42 : 0.36) * k;
        const b = new THREE.Mesh(new THREE.CylinderGeometry(0.11 * k, 0.11 * k, 1.9 * k, 8), GHOST);
        b.rotation.x = Math.PI / 2;
        b.position.set(Math.cos(a) * r, Math.sin(a) * r, -0.35 * k);
        b.name = 'tube';
        barrels.add(b);
      }
      head.add(barrels);
      group.add(head);
      group.position.set(x, 0, -(ws + 0.2));
      this.root.add(group);
      this.turrets.push({
        i, x, tier: 0, need: nextCost(spec, 0), pool: 0, tracerT: 0, spin: 0, heat: 0,
        group, head, barrels, label: overlay.label('pad-cost' + (big ? ' big' : '')), pulse: 0,
      });
    });

    // --- tracers
    const tg = new THREE.BufferGeometry();
    tg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(TRACERS * 6), 3));
    this.tracers = new THREE.LineSegments(tg, new THREE.LineBasicMaterial({ color: '#ffe066', transparent: true, opacity: 0.95 }));
    this.tracers.frustumCulled = false;
    this.root.add(this.tracers);

    // --- cannon + aiming aids
    this.cannon = new THREE.Group();
    const cm = new THREE.MeshLambertMaterial({ color: '#3a3f4a', flatShading: true });
    const team = new THREE.MeshLambertMaterial({ color: cos.color, flatShading: true });
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 1.9, 12), cm);
    barrel.rotation.x = -Math.PI / 2.3;
    barrel.position.set(0, 1.1, -0.3);
    barrel.name = 'barrel';
    const ringM = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.12, 8, 16), team);
    ringM.position.set(0, 0.95, 0);
    ringM.rotation.set(Math.PI / 2, 0, 0);
    barrel.add(ringM);
    const carriage = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.5, 1.5), POST);
    carriage.position.y = 0.45;
    this.cannon.add(carriage, barrel);
    for (const sx of [-0.75, 0.75]) for (const sz of [-0.5, 0.5]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.32, 0.2, 12), POST);
      wh.rotation.z = Math.PI / 2;
      wh.position.set(sx, 0.32, sz);
      this.cannon.add(wh);
    }
    this.cannon.position.z = -0.2;
    this.root.add(this.cannon);

    const glowMat = new THREE.MeshBasicMaterial({ color: cos.color, transparent: true, opacity: 0.9, depthWrite: false });
    this.reticle = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.35, 40), glowMat);
    ring.rotation.x = -Math.PI / 2;
    ring.name = 'ring';
    this.reticle.add(ring);
    this.reticle.position.set(0, 0.06, -0.2);
    this.root.add(this.reticle);
    const chevGeo = new THREE.ShapeGeometry(new THREE.Shape([
      new THREE.Vector2(-0.5, 0), new THREE.Vector2(0, 0.42), new THREE.Vector2(0.5, 0),
      new THREE.Vector2(0.5, -0.2), new THREE.Vector2(0, 0.2), new THREE.Vector2(-0.5, -0.2),
    ]));
    for (let i = 0; i < 5; i++) {
      const c = new THREE.Mesh(chevGeo, new THREE.MeshBasicMaterial({ color: cos.color, transparent: true, opacity: 0.8, depthWrite: false }));
      c.rotation.x = -Math.PI / 2;
      this.root.add(c);
      this.chevrons.push(c);
    }
    this.slotGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, ws - 1), new THREE.MeshBasicMaterial({ color: cos.color, transparent: true, opacity: 0.16, depthWrite: false }));
    this.slotGlow.rotation.x = -Math.PI / 2;
    this.slotGlow.position.set(0, 0.025, -(ws - 1) / 2);
    this.root.add(this.slotGlow);

    this.hordeLabel = overlay.label('boss-hp');
    this.baseLabel = overlay.label('base-hp');
    this.leakLabel = overlay.label('lane-warn leak');
  }

  /** Cliff-top plaza and causeway over a misty abyss. */
  private buildWorld(): void {
    const C = CANYON;
    const HW = C.halfWidth;
    const p = this.lv.path;
    const abyss = new THREE.Mesh(new THREE.PlaneGeometry(400, 400), new THREE.MeshBasicMaterial({ color: '#22384a' }));
    abyss.rotation.x = -Math.PI / 2;
    abyss.position.set(0, -10, -40);
    this.root.add(abyss);

    // plaza block
    const pl = C.wallS + 1.2;
    const plaza = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 1.2, 10, pl + 4), [ROCK, ROCK, SAND, ROCK, ROCK, ROCK]);
    plaza.position.set(0, -5, -(pl - 4) / 2);
    this.root.add(plaza);
    for (const side of [-1, 1]) {
      const rim = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.7, pl + 4), ROCK_DARK);
      rim.position.set(side * (HW + 0.3), 0.35, -(pl - 4) / 2);
      this.root.add(rim);
    }
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 0.45), new THREE.MeshBasicMaterial({ color: '#ff4b5c', transparent: true, opacity: 0.45 }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.03, -0.6);
    this.root.add(line);

    // causeway: top ribbon + rock skirts down into the abyss
    const s0 = C.wallS + 0.6;
    const s1 = C.topS + 1.5;
    const N = 60;
    const top: number[] = [];
    const skirt: number[] = [];
    const H = C.pathHalf + 0.5;
    for (let i = 0; i < N; i++) {
      const a = s0 + ((s1 - s0) * i) / N;
      const b = s0 + ((s1 - s0) * (i + 1)) / N;
      const ca = pathCenter(p, a);
      const cb = pathCenter(p, b);
      top.push(ca - H, 0, -a, ca + H, 0, -a, cb + H, 0, -b, ca - H, 0, -a, cb + H, 0, -b, cb - H, 0, -b);
      for (const sd of [-1, 1]) {
        const xa = ca + sd * H;
        const xb = cb + sd * H;
        skirt.push(xa, 0, -a, xb, 0, -b, xb, -10, -b, xa, 0, -a, xb, -10, -b, xa, -10, -a);
      }
    }
    const geo = (arr: number[]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(arr, 3));
      g.computeVertexNormals();
      return g;
    };
    this.root.add(new THREE.Mesh(geo(top), DIRT));
    this.root.add(new THREE.Mesh(geo(skirt), new THREE.MeshLambertMaterial({ color: '#8d939c', flatShading: true, side: THREE.DoubleSide })));
    // grassy verges and boulders along the edges
    for (let s = s0; s < s1; s += 1.3) {
      const c = pathCenter(p, s);
      for (const sd of [-1, 1]) {
        const r = 0.35 + Math.random() * 0.45;
        const b = new THREE.Mesh(new THREE.DodecahedronGeometry(r, 0), Math.random() < 0.35 ? GRASS : ROCK_DARK);
        b.position.set(c + sd * (H - 0.15), r * 0.4, -s - Math.random() * 0.6);
        b.rotation.set(Math.random() * 3, Math.random() * 3, 0);
        this.root.add(b);
      }
    }
    // tall cliffs rising out of the abyss beside the causeway
    for (let s = s0 + 2; s < C.topS - 2; s += 3.2 + Math.random() * 2) {
      const d = 2.5 + Math.random() * 2;
      // stay clear of the causeway wherever it bends within this block's depth
      let lo = Infinity;
      let hi = -Infinity;
      for (let k = -d; k <= d; k += 0.5) {
        const c = pathCenter(p, s + k);
        lo = Math.min(lo, c);
        hi = Math.max(hi, c);
      }
      for (const sd of [-1, 1]) {
        if (Math.random() < 0.35) continue;
        const h = 10 + Math.random() * 4;
        const w = 2.5 + Math.random() * 3;
        const edge = sd < 0 ? lo - H : hi + H;
        const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), Math.random() < 0.5 ? ROCK : ROCK_DARK);
        m.position.set(edge + sd * (1.2 + w / 2 + Math.random() * 3), -10 + h / 2 + Math.random() * 1.2, -s);
        this.root.add(m);
      }
    }
    // the horde's plateau
    const src = new THREE.Mesh(new THREE.BoxGeometry(44, 10, 18), [ROCK, ROCK, DIRT, ROCK, ROCK, ROCK]);
    src.position.set(pathCenter(p, C.topS) * 0.5, -5, -(C.topS + 9.5));
    this.root.add(src);
  }

  // ------------------------------------------------------------------

  update(dt: number, realDt: number, inputTarget: number, time: number): void {
    const lv = this.lv;
    if (this.state === 'play') this.t += dt;
    const lim = CANYON.halfWidth - 0.8;
    const target = Math.max(-lim, Math.min(lim, (inputTarget / 4.4) * lim));
    this.cannonX += (target - this.cannonX) * (1 - Math.exp(-14 * realDt));
    this.cannon.position.x = this.cannonX;
    const slot = slotAt(this.cannonX);
    if (slot !== this.lastSlot) {
      if (this.lastSlot >= 0) this.lock = CANYON.switchTime;
      this.lastSlot = slot;
    }
    if (this.state === 'play') {
      if (this.lock > 0) this.lock -= dt;
      else {
        this.fireAcc += lv.fireRate * dt;
        while (this.fireAcc >= 1) {
          this.fireAcc--;
          this.spawnPlayer(slot);
        }
      }
      this.release(dt);
    }
    this.fireCd -= dt;
    const barrel = this.cannon.getObjectByName('barrel')!;
    barrel.position.z = -0.3 + Math.max(0, this.fireCd) * 0.8;

    this.stepPlayers(dt);
    this.stepEnemies(dt, time);
    this.collide();
    this.fireTurrets(dt);
    this.render(time, realDt, slot);
    this.labels();
    this.camera(realDt);

    if (this.state === 'play') {
      if (this.base <= 0) this.finish(false, 'The horde reached your cannon');
      else if (this.reserve <= 0 && !this.enemies.length) this.finish(true, 'The whole horde is destroyed');
      else if (this.t >= lv.maxTime) this.finish(false, 'Out of time — the horde kept coming');
      else this.checkDoomed(dt);
    } else {
      this.endT += realDt;
      if (this.endT > 1.6 && this.endT - realDt <= 1.6) this.onEnd(this.result());
    }
  }

  hordeLeft(): number {
    let a = this.reserve;
    for (const e of this.enemies) a += e.w;
    return a;
  }

  private camera(realDt: number): void {
    const cam = this.stage.camera;
    const portrait = window.innerWidth / window.innerHeight < 0.75;
    cam.position.set(this.cannonX * 0.1, portrait ? 38 : 30, portrait ? 12 : 15);
    if (this.shake > 0) {
      this.shake -= realDt;
      cam.position.x += (Math.random() - 0.5) * this.shake * 1.4;
      cam.position.y += (Math.random() - 0.5) * this.shake * 1.4;
    }
    cam.lookAt(0, 0, portrait ? -23 : -21);
  }

  /** Generous to the player: only ends early when a breakthrough outweighs the base even after every shot left. */
  private checkDoomed(dt: number): void {
    this.doomCheckT -= dt;
    if (this.doomCheckT > 0) return;
    this.doomCheckT = 0.25;
    let leak = 0;
    let far = 0;
    for (const e of this.enemies) if (e.s < CANYON.wallS - 0.5) {
      leak += e.w;
      far = Math.max(far, e.s);
    }
    let dps = 0;
    for (const t of this.turrets) if (t.tier > 0) dps += this.lv.turrets[t.i].dps[t.tier - 1];
    const arrival = far / (CANYON.enemySpeed * 0.25);
    const doomed = leak > 0 && leak - (this.lv.fireRate + dps) * arrival >= this.base;
    this.doomT = doomed ? this.doomT + 0.25 : 0;
    if (doomed && this.doomT >= 1.25) {
      this.onBanner('NO WAY BACK', 'danger', 1.6);
      this.finish(false, `A breakthrough of ${fmt(leak)} outweighs your base (${fmt(Math.max(0, this.base))})`, true);
    }
  }

  private finish(won: boolean, reason: string, early = false): void {
    this.state = won ? 'won' : 'lost';
    this.reason = reason;
    this.endT = 0;
    this.slowmo = 1.2;
    this.shake = won ? 1 : 0.6;
    if (won) {
      sfx.play('bossDown');
      haptic(150);
      this.onBanner('HORDE DESTROYED!', 'golden', 1.8);
      for (let k = 0; k < 6; k++) this.particles.emit((Math.random() - 0.5) * 10, 2, -(CANYON.topS + 2), 30, k % 2 ? '#ffd23f' : this.color, { speed: 9, up: 8, size: 0.3, life: 1.3 });
    } else {
      sfx.play('lose');
      haptic(200);
      if (!early) this.onBanner(this.t >= this.lv.maxTime ? 'TIME UP' : 'OVERRUN', 'danger', 1.6);
    }
  }

  result(): ArenaStats {
    return {
      won: this.state === 'won', time: this.t, kills: this.stats.kills, peak: this.stats.peak,
      castlePct: this.state === 'won' ? 1 : 1 - this.hordeLeft() / this.lv.horde, hedges: this.stats.tiers, reason: this.reason,
    };
  }

  // ------------------------------------------------------------------

  private spawnPlayer(slot: number): void {
    if (this.players.length >= CANYON.playerCap) return;
    const C = CANYON;
    const [x0, x1] = slot === 1 ? [-C.slotHalf, C.slotHalf] : slot === 0 ? [-C.halfWidth, -C.slotHalf] : [C.slotHalf, C.halfWidth];
    const x = Math.max(x0 + 0.3, Math.min(x1 - 0.3, this.cannonX + (Math.random() - 0.5) * 0.35));
    this.players.push({ x, s: C.cannonS + 0.6, w: 1, slot, up: false, born: this.t, off: Math.random() * 2 - 1 });
    this.fireCd = 0.07;
    sfx.play('spawn');
  }

  private release(dt: number): void {
    const C = CANYON;
    if (this.reserve <= 0) return;
    const rate = releaseRate(this.lv, this.t);
    const amt = Math.min(this.reserve, rate * dt);
    this.reserve -= amt;
    this.releaseAcc += amt;
    const per = Math.max(1, rate / 55);
    while (this.releaseAcc >= per || (this.reserve <= 0 && this.releaseAcc > 0)) {
      const w = Math.min(per, this.releaseAcc);
      this.releaseAcc -= w;
      if (this.enemies.length >= C.enemyCap) {
        this.enemies[this.enemies.length - 1].w += w;
        continue;
      }
      const s = C.topS - Math.random() * 1.5;
      const off = Math.random() * 2 - 1;
      this.enemies.push({ x: pathCenter(this.lv.path, s) + off * (C.pathHalf - 0.35), s, w, phase: Math.random() * 6, stun: 0, hit: 0, off });
    }
  }

  private stepPlayers(dt: number): void {
    const C = CANYON;
    const P = this.players;
    for (let i = P.length - 1; i >= 0; i--) {
      const u = P[i];
      if (this.state === 'won') continue;
      u.s += C.unitSpeed * dt;
      let dead = false;
      if (!u.up) {
        if (u.slot === 1 && u.s >= C.gateS) {
          // through the gate: multiply, split into groups, head up the canyon
          u.up = true;
          this.gatePulse = 0.12;
          const total = Math.round(u.w * this.lv.gateMult);
          const room = C.playerCap - 300 - P.length;
          const k = Math.max(1, Math.min(SPLIT_MAX, room > 0 ? room + 1 : 1));
          const base = Math.floor(total / k);
          let rem = total - base * k;
          u.w = base + (rem-- > 0 ? 1 : 0);
          for (let j = 1; j < k; j++) {
            P.push({ x: u.x + (Math.random() - 0.5) * 2, s: u.s - Math.random() * 0.8, w: base + (rem-- > 0 ? 1 : 0), slot: 1, up: true, born: this.t, off: Math.random() * 2 - 1 });
          }
          if (Math.random() < 0.3) this.particles.emit(u.x, 1, -C.gateS, 3, '#ffd23f', { speed: 3, up: 3, size: 0.12 });
        } else if (u.slot !== 1 && u.s >= C.wallS - 1) {
          this.chargeTurret(this.turrets[u.slot === 0 ? 0 : 1], u.w, u.x);
          dead = true;
        }
      } else {
        // fill the causeway across its width, following its bends
        const tx = pathCenter(this.lv.path, u.s + 1.5) + u.off * (C.pathHalf - 0.4);
        u.x += Math.sign(tx - u.x) * Math.min(Math.abs(tx - u.x), 7 * dt);
        if (u.s >= C.topS) {
          const k = Math.min(this.reserve, u.w);
          this.reserve -= k;
          this.stats.kills += k;
          if (Math.random() < 0.3) this.particles.emit(u.x, 1, -u.s, 4, Math.random() < 0.5 ? '#e8413c' : this.color, { speed: 4, up: 4, size: 0.14 });
          dead = true;
        }
      }
      if (dead) {
        P[i] = P[P.length - 1];
        P.pop();
      }
    }
    let tot = 0;
    for (const u of P) tot += u.w;
    this.stats.peak = Math.max(this.stats.peak, tot);
  }

  private chargeTurret(t: RtTurret, w: number, x: number): void {
    const spec = this.lv.turrets[t.i];
    if (t.tier >= spec.costs.length) {
      if (Math.random() < 0.3) this.particles.emit(x, 1, -(CANYON.wallS - 1), 2, '#c9ced6', { speed: 2, up: 2, size: 0.1 });
      return;
    }
    t.need -= w;
    t.pulse = 0.1;
    if (Math.random() < 0.5) this.particles.emit(x, 1, -(CANYON.wallS - 1), 2, '#ffd23f', { speed: 2, up: 3, size: 0.1 });
    while (t.need <= 0 && t.tier < spec.costs.length) {
      t.tier++;
      this.stats.tiers++;
      t.need += nextCost(spec, t.tier);
      this.upgradeVisual(t);
      this.shake = 0.35;
      sfx.play('gateGolden');
      haptic(60);
      const name = CANYON.turrets[spec.kind].name.toUpperCase();
      this.onBanner(t.tier === 1 ? `${name} ONLINE!` : `${name} LV${t.tier}!`, 'golden', 1.2);
      for (let k = 0; k < 3; k++) this.particles.emit(t.x, 2, -(CANYON.wallS + 0.2), 20, k % 2 ? '#ffd23f' : '#fff3b0', { speed: 6, up: 6, size: 0.18, life: 0.9 });
    }
    if (t.tier >= spec.costs.length) t.need = 0;
  }

  private upgradeVisual(t: RtTurret): void {
    t.head.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) m.material = m.name === 'tube' ? ROCK_DARK : GOLD;
    });
    const sc = 1 + (t.tier - 1) * 0.12;
    t.head.scale.setScalar(sc);
  }

  private stepEnemies(dt: number, time: number): void {
    const C = CANYON;
    const E = this.enemies;
    for (let i = E.length - 1; i >= 0; i--) {
      const e = E[i];
      if (this.state !== 'play') continue;
      if (e.hit > 0) e.hit -= dt;
      if (e.stun > 0) e.stun -= dt;
      const slow = e.stun > 0 ? 0.25 : 1;
      e.s -= C.enemySpeed * slow * dt;
      if (e.s > C.wallS - 0.4) {
        // pour down the causeway; squeeze into the gate gap at the bottom
        let tx = pathCenter(this.lv.path, e.s - 1) + e.off * (C.pathHalf - 0.35);
        if (e.s < C.mouthS + 1) tx = Math.max(-C.slotHalf + 0.4, Math.min(C.slotHalf - 0.4, tx));
        e.x += (tx - e.x) * Math.min(1, dt * 4) + Math.sin(time * 2 + e.phase) * 0.15 * dt;
      } else {
        // broke through: hunt the cannon
        const d = this.cannonX - e.x;
        e.x += Math.sign(d) * Math.min(Math.abs(d), C.enemyChase * slow * dt);
      }
      if (e.w > 0 && e.s <= 0.6) {
        this.base -= e.w;
        this.shake = Math.max(this.shake, 0.25);
        this.particles.emit(e.x, 0.6, -0.6, 6, '#ff4b5c', { speed: 3, up: 3 });
        this.overlay.float(`−${fmt(e.w)}`, new THREE.Vector3(e.x, 1.5, -1), 'bad');
        sfx.play('death');
        e.w = 0;
      }
      if (e.w <= 1e-6) {
        E[i] = E[E.length - 1];
        E.pop();
      }
    }
  }

  private collide(): void {
    const E = this.enemies;
    const P = this.players;
    if (!E.length || !P.length) return;
    const cell = 1;
    const key = (cx: number, cs: number) => (cx << 10) | cs;
    const grid = new Map<number, number[]>();
    E.forEach((e, i) => {
      const k = key(Math.floor((e.x + 30) / cell), Math.floor(e.s / cell));
      let b = grid.get(k);
      if (!b) grid.set(k, (b = []));
      b.push(i);
    });
    let fx = 0;
    for (const p of P) {
      if (p.w <= 0) continue;
      const cx = Math.floor((p.x + 30) / cell);
      const cs = Math.floor(p.s / cell);
      for (let dx = -1; dx <= 1 && p.w > 0; dx++) for (let ds = -1; ds <= 1 && p.w > 0; ds++) {
        const b = grid.get(key(cx + dx, cs + ds));
        if (!b) continue;
        for (const ei of b) {
          const e = E[ei];
          if (e.w <= 0 || Math.abs(e.s - p.s) > 0.75 || Math.abs(e.x - p.x) > 0.85) continue;
          const k = Math.min(p.w, e.w);
          p.w -= k;
          e.w -= k;
          e.stun = 0.3;
          e.hit = 0.12;
          this.stats.kills += k;
          if (fx++ < 8) this.particles.emit((p.x + e.x) / 2, 0.5, -(p.s + e.s) / 2, 3, Math.random() < 0.5 ? '#e8413c' : this.color, { speed: 3, up: 3, size: 0.1, life: 0.4 });
          if (p.w <= 0) break;
        }
      }
    }
    if (fx) sfx.play('hit');
    this.players = P.filter((p) => p.w > 1e-6);
    this.enemies = E.filter((e) => e.w > 1e-6);
  }

  /** Built turrets shred the enemies nearest the barricade (same targeting as the simulator). */
  private fireTurrets(dt: number): void {
    const C = CANYON;
    const live = this.turrets.filter((t) => t.tier > 0);
    for (const t of this.turrets) t.heat = Math.max(0, t.heat - dt * 3);
    if (!live.length || this.state !== 'play') return;
    const reach = C.wallS + C.turretRange;
    const targets = this.enemies.filter((e) => e.s <= reach).sort((a, b) => a.s - b.s);
    if (!targets.length) return;
    let ti = 0;
    for (const t of live) {
      t.pool += this.lv.turrets[t.i].dps[t.tier - 1] * dt;
      t.heat = 1;
      const aim = targets[Math.min(ti, targets.length - 1)];
      while (t.pool > 0 && ti < targets.length) {
        const e = targets[ti];
        const k = Math.min(t.pool, e.w);
        e.w -= k;
        t.pool -= k;
        this.stats.kills += k;
        e.hit = 0.08;
        if (e.w <= 1e-6) {
          ti++;
          if (Math.random() < 0.15) this.particles.emit(e.x, 0.6, -e.s, 3, '#e8413c', { speed: 3, up: 3, size: 0.12, life: 0.4 });
        }
      }
      t.pool = 0;
      // look + tracers
      const dx = aim.x - t.x;
      const dz = -aim.s + (C.wallS + 0.2);
      t.head.rotation.y = Math.atan2(-dx, -dz);
      t.tracerT -= dt;
      const big = this.lv.turrets[t.i].kind === 'big';
      while (t.tracerT <= 0) {
        t.tracerT += big ? 0.035 : 0.06;
        const tgt = targets[Math.min(targets.length - 1, Math.floor(Math.random() * Math.min(6, targets.length)))];
        this.addTracer(t, tgt);
      }
    }
    this.enemies = this.enemies.filter((e) => e.w > 1e-6);
    if (Math.random() < dt * 20) sfx.play('hit', 1.6);
  }

  private addTracer(t: RtTurret, e: EUnit): void {
    const i = this.tracerNext;
    this.tracerNext = (i + 1) % TRACERS;
    const a = this.tracers.geometry.getAttribute('position') as THREE.BufferAttribute;
    const arr = a.array as Float32Array;
    const y = 1.9 * t.head.scale.x * (this.lv.turrets[t.i].kind === 'big' ? 1.3 : 1);
    arr.set([t.x + (Math.random() - 0.5) * 0.4, y, -(CANYON.wallS + 0.2), e.x + (Math.random() - 0.5) * 0.6, 0.7, -e.s], i * 6);
    this.tracerLife[i] = 0.05;
  }

  // ------------------------------------------------------------------

  private render(time: number, realDt: number, slot: number): void {
    const won = this.state === 'won';
    const C = CANYON;
    const pa = this.pMesh.instanceMatrix.array as Float32Array;
    const wa = this.wMesh ? (this.wMesh.instanceMatrix.array as Float32Array) : null;
    let n = 0;
    for (const u of this.players) {
      const age = this.t - u.born;
      const sc = (0.95 + Math.min(0.8, Math.log10(Math.max(1, u.w)) * 0.18)) * (age < 0.15 ? 0.4 + age * 4 : 1);
      const bob = won ? Math.max(0, Math.sin(time * 8 + u.x * 3)) * 0.8 : Math.abs(Math.sin(time * 14 + u.x * 5)) * 0.12;
      const o = n * 16;
      pa[o] = sc; pa[o + 1] = 0; pa[o + 2] = 0; pa[o + 3] = 0;
      pa[o + 4] = 0; pa[o + 5] = sc; pa[o + 6] = 0; pa[o + 7] = 0;
      pa[o + 8] = 0; pa[o + 9] = 0; pa[o + 10] = sc; pa[o + 11] = 0;
      pa[o + 12] = u.x; pa[o + 13] = bob; pa[o + 14] = -u.s; pa[o + 15] = 1;
      if (wa) for (let j = 0; j < 16; j++) wa[o + j] = pa[o + j];
      n++;
    }
    this.pMesh.count = n;
    this.pMesh.instanceMatrix.needsUpdate = true;
    if (this.wMesh) {
      this.wMesh.count = n;
      this.wMesh.instanceMatrix.needsUpdate = true;
    }
    const ea = this.eMesh.instanceMatrix.array as Float32Array;
    let m = 0;
    for (const e of this.enemies) {
      const sc = (0.95 + Math.min(1, Math.log10(Math.max(1, e.w)) * 0.22)) * (e.hit > 0 ? 1.25 : 1);
      const o = m * 16;
      ea[o] = -sc; ea[o + 1] = 0; ea[o + 2] = 0; ea[o + 3] = 0;
      ea[o + 4] = 0; ea[o + 5] = sc; ea[o + 6] = 0; ea[o + 7] = 0;
      ea[o + 8] = 0; ea[o + 9] = 0; ea[o + 10] = -sc; ea[o + 11] = 0;
      ea[o + 12] = e.x; ea[o + 13] = Math.abs(Math.sin(time * 12 + e.phase)) * 0.1; ea[o + 14] = -e.s; ea[o + 15] = 1;
      m++;
    }
    this.eMesh.count = m;
    this.eMesh.instanceMatrix.needsUpdate = true;

    // the waiting horde thins out as the reserve is spent
    const sa = this.sourceMesh.instanceMatrix.array as Float32Array;
    const shown = Math.ceil(this.sourceSpots.length * Math.sqrt(Math.max(0, this.reserve) / this.lv.horde));
    let k = 0;
    for (let i = this.sourceSpots.length - shown; i < this.sourceSpots.length; i++) {
      const sp = this.sourceSpots[i];
      const o = k * 16;
      const sc = 1.1;
      sa[o] = -sc; sa[o + 1] = 0; sa[o + 2] = 0; sa[o + 3] = 0;
      sa[o + 4] = 0; sa[o + 5] = sc; sa[o + 6] = 0; sa[o + 7] = 0;
      sa[o + 8] = 0; sa[o + 9] = 0; sa[o + 10] = -sc; sa[o + 11] = 0;
      sa[o + 12] = sp.x; sa[o + 13] = Math.abs(Math.sin(time * 6 + sp.p)) * 0.15; sa[o + 14] = -sp.s; sa[o + 15] = 1;
      k++;
    }
    this.sourceMesh.count = k;
    this.sourceMesh.instanceMatrix.needsUpdate = true;

    // tracers
    const ta = this.tracers.geometry.getAttribute('position') as THREE.BufferAttribute;
    const tarr = ta.array as Float32Array;
    for (let i = 0; i < TRACERS; i++) {
      if (this.tracerLife[i] > 0) {
        this.tracerLife[i] -= realDt;
        if (this.tracerLife[i] <= 0) for (let j = 0; j < 3; j++) tarr[i * 6 + j] = tarr[i * 6 + 3 + j];
      }
    }
    ta.needsUpdate = true;

    for (const t of this.turrets) {
      if (t.pulse > 0) t.pulse -= realDt;
      t.group.scale.setScalar(1 + Math.max(0, t.pulse) * 0.6);
      t.spin += realDt * t.heat * 25;
      t.barrels.rotation.z = t.spin;
    }
    if (this.gatePulse > 0) this.gatePulse -= realDt;
    this.gate.scale.setScalar(1 + Math.max(0, this.gatePulse) * 0.5);

    // aiming aids
    this.reticle.position.x = this.cannonX;
    const pulse = 1 + Math.sin(time * 6) * 0.08;
    this.reticle.getObjectByName('ring')!.scale.set(pulse, pulse, 1);
    const [x0, x1] = slot === 1 ? [-C.slotHalf, C.slotHalf] : slot === 0 ? [-C.halfWidth, -C.slotHalf] : [C.slotHalf, C.halfWidth];
    this.slotGlow.position.x += ((x0 + x1) / 2 - this.slotGlow.position.x) * Math.min(1, realDt * 18);
    this.slotGlow.scale.x = x1 - x0 - 0.3;
    this.chevrons.forEach((c, i) => {
      const k = (time * 1.4 + i / this.chevrons.length) % 1;
      c.position.set(this.cannonX, 0.05, -(2 + k * 5));
      (c.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k) * (this.state === 'play' ? 1 : 0);
    });
  }

  private labels(): void {
    const C = CANYON;
    const left = this.hordeLeft();
    const frac = Math.max(0, left) / this.lv.horde;
    this.hordeLabel.style.display = this.state === 'won' ? 'none' : '';
    this.overlay.place(this.hordeLabel, new THREE.Vector3(pathCenter(this.lv.path, C.topS) * 0.5, 4, -(C.topS + 3)));
    this.hordeLabel.innerHTML = `<b>THE HORDE</b><div class="bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></div><span>${fmt(Math.ceil(left))}</span>`;
    this.overlay.place(this.baseLabel, new THREE.Vector3(this.cannonX, 2.6, 0));
    this.baseLabel.innerHTML = `❤ ${fmt(Math.max(0, Math.ceil(this.base)))}`;
    for (const t of this.turrets) {
      const spec = this.lv.turrets[t.i];
      this.overlay.place(t.label, new THREE.Vector3(t.x, 0.2, -(C.wallS - 1.1)));
      const max = t.tier >= spec.costs.length;
      t.label.innerHTML = max ? `<small>LV${t.tier}</small>MAX` : `${t.tier ? `<small>LV${t.tier}▸${t.tier + 1}</small>` : ''}${fmt(Math.ceil(t.need))}`;
    }
    let leak = 0;
    let front: EUnit | null = null;
    for (const e of this.enemies) if (e.s < C.wallS) {
      leak += e.w;
      if (!front || e.s < front.s) front = e;
    }
    if (front) {
      this.leakLabel.style.display = '';
      this.overlay.place(this.leakLabel, new THREE.Vector3(front.x, 1.9, -front.s));
      this.leakLabel.textContent = `⚠ ${fmt(Math.ceil(leak))}`;
    } else this.leakLabel.style.display = 'none';
  }

  dispose(): void {
    this.stage.scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.hordeLabel.remove();
    this.baseLabel.remove();
    this.leakLabel.remove();
    for (const t of this.turrets) t.label.remove();
  }
}
