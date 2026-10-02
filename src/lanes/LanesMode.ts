// Lane Battle gameplay: a cannon fires soldiers up walled lanes. Soldiers are
// multiplied by gates (a ×N gate splits a group — same rule the generator
// simulated), break jackpot towers, clash with enemy hordes marching down, and
// smash the enemy castle. Enemies reaching the bottom damage your base.
import * as THREE from 'three';
import { sfx, haptic } from '../audio/SoundSystem';
import { LANES } from '../config/lanesConfig';
import type { GateSpec } from '../core/types';
import { panelTexture } from '../game/GateSystem';
import type { Overlay, Particles } from '../render/Effects';
import type { Stage3D } from '../render/Stage3D';
import { unitGeometry, weaponGeometry } from '../render/UnitGeometry';
import { fmt } from '../sim/rules';
import { applyLaneGate, splitCount, type LaneEvent, type LaneLevelData } from './LaneSim';

interface PUnit { x: number; s: number; w: number; lane: number; ei: number; born: number }
interface EUnit { x: number; s: number; w: number; lane: number; phase: number }

interface RtEvent extends LaneEvent {
  hpLeft: number;
  broken: boolean;
  mesh: THREE.Object3D | null;
  panel: THREE.Mesh | null;
  pulse: number;
  label: HTMLDivElement | null;
}

export interface LanesStats {
  won: boolean;
  time: number;
  kills: number;
  peak: number;
  castlePct: number;
  towersBroken: number;
  reason: string;
}

const texCache = new Map<string, THREE.CanvasTexture>();
function gateTex(g: GateSpec): THREE.CanvasTexture {
  const k = `${g.op}:${g.v}:${g.golden ? 1 : 0}`;
  let t = texCache.get(k);
  if (!t) {
    t = panelTexture(g);
    texCache.set(k, t);
  }
  return t;
}

function towerTexture(mult: number): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 128;
  c.height = 512;
  const x = c.getContext('2d')!;
  x.fillStyle = '#8f9399';
  x.fillRect(0, 0, 128, 512);
  x.strokeStyle = 'rgba(0,0,0,.15)';
  for (let i = 0; i < 12; i++) x.strokeRect(0, i * 44, 128, 44);
  const chars = ('×' + mult).split('');
  const size = Math.min(110, 480 / chars.length);
  x.font = `900 ${size}px system-ui, sans-serif`;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.lineWidth = 8;
  chars.forEach((ch, i) => {
    const y = 256 + (i - (chars.length - 1) / 2) * size * 0.95;
    x.strokeStyle = '#6b4a00';
    x.strokeText(ch, 64, y);
    x.fillStyle = '#ffd23f';
    x.fillText(ch, 64, y);
  });
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}


export class LanesMode {
  readonly lv: LaneLevelData;
  private stage: Stage3D;
  private particles: Particles;
  private overlay: Overlay;
  private root = new THREE.Group();
  private players: PUnit[] = [];
  private enemies: EUnit[] = [];
  private events: RtEvent[][];
  private pMesh: THREE.InstancedMesh;
  private wMesh: THREE.InstancedMesh | null = null;
  private eMesh: THREE.InstancedMesh;
  private cannon: THREE.Group;
  private reticle: THREE.Group;
  private laneGlow: THREE.Mesh;
  private chevrons: THREE.Mesh[] = [];
  private castleGroup: THREE.Group;
  private castleLabel: HTMLDivElement;
  private baseLabel: HTMLDivElement;
  private laneWarn: HTMLDivElement[] = [];
  private waveState: { left: number; ents: number; spawned: number; started: boolean; per: number; rem: number }[];
  castle: number;
  base: number;
  t = 0;
  cannonX = 0;
  private fireAcc = 0;
  private moveLock = 0;
  private lastLane = -1;
  private shake = 0;
  private castleDmgAcc = 0;
  private castleFloatT = 0;
  private fireCd = 0;
  state: 'play' | 'won' | 'lost' = 'play';
  private endT = 0;
  private stats = { kills: 0, peak: 0, towers: 0 };
  slowmo = 0;
  private color: string;
  onEnd: (s: LanesStats) => void = () => {};
  onBanner: (text: string, cls?: string, dur?: number) => void = () => {};

  constructor(stage: Stage3D, particles: Particles, overlay: Overlay, lv: LaneLevelData, cos: { skin: string; color: string; weapon: string }) {
    this.stage = stage;
    this.particles = particles;
    this.overlay = overlay;
    this.lv = lv;
    this.color = cos.color;
    this.castle = lv.castleHP;
    this.base = lv.baseHP;
    stage.scene.add(this.root);
    const HW = LANES.halfWidth;
    const L = lv.L;

    // units
    const pm = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.pMesh = new THREE.InstancedMesh(unitGeometry(cos.skin), pm, LANES.playerCap);
    this.pMesh.frustumCulled = false;
    this.pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const pc = new THREE.Color(cos.color);
    for (let i = 0; i < LANES.playerCap; i++) this.pMesh.setColorAt(i, pc);
    this.root.add(this.pMesh);
    const wg = weaponGeometry(cos.weapon);
    if (wg) {
      this.wMesh = new THREE.InstancedMesh(wg.geo, new THREE.MeshLambertMaterial({ color: wg.color, vertexColors: true }), LANES.playerCap);
      this.wMesh.frustumCulled = false;
      this.root.add(this.wMesh);
    }
    this.eMesh = new THREE.InstancedMesh(unitGeometry('classic'), new THREE.MeshLambertMaterial({ vertexColors: true }), LANES.enemyCap);
    this.eMesh.frustumCulled = false;
    this.eMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const ec = new THREE.Color('#e8413c');
    for (let i = 0; i < LANES.enemyCap; i++) this.eMesh.setColorAt(i, ec);
    this.root.add(this.eMesh);

    // lane walls
    const wallMat = new THREE.MeshLambertMaterial({ color: '#9aa1ab', flatShading: true });
    lv.lanes.slice(0, -1).forEach((ln) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.9, L), wallMat);
      wall.position.set(ln.x1, 0.45, -L / 2);
      this.root.add(wall);
    });
    // defense line
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 0.5), new THREE.MeshBasicMaterial({ color: '#ff4b5c', transparent: true, opacity: 0.45 }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.03, -0.6);
    this.root.add(line);

    // gates and towers
    this.events = lv.lanes.map((ln, li) =>
      ln.events.map((e) => {
        const r: RtEvent = { ...e, hpLeft: e.hp ?? 0, broken: false, mesh: null, panel: null, pulse: 0, label: null };
        const w = ln.x1 - ln.x0 - 0.5;
        const cx = (ln.x0 + ln.x1) / 2;
        if (e.kind === 'gate') {
          r.panel = this.makePanel({ op: e.op!, v: e.v! }, w, cx, e.s);
        } else {
          const g = new THREE.Group();
          const stone = new THREE.MeshLambertMaterial({ color: '#8f9399', flatShading: true });
          const body = new THREE.Mesh(new THREE.BoxGeometry(w, 7, 2), [stone, stone, stone, stone, new THREE.MeshLambertMaterial({ map: towerTexture(e.mult!) }), stone]);
          body.position.y = 3.5;
          g.add(body);
          const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.4, 0.5, 2.4), new THREE.MeshLambertMaterial({ color: '#6f747b' }));
          cap.position.y = 7.2;
          g.add(cap);
          g.position.set(cx, 0, -e.s - 1);
          this.root.add(g);
          r.mesh = g;
          r.label = overlay.label('tower-hp');
        }
        void li;
        return r;
      }),
    );

    // castle
    this.castleGroup = new THREE.Group();
    const cm = new THREE.MeshLambertMaterial({ color: '#b54a3c', flatShading: true });
    const cr = new THREE.MeshLambertMaterial({ color: '#6d2a22', flatShading: true });
    const wallB = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 1, 4, 3), cm);
    wallB.position.y = 2;
    this.castleGroup.add(wallB);
    for (let i = 0; i < 8; i++) {
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.8, 3.1), cm);
      m.position.set(-HW + i * ((HW * 2) / 7), 4.4, 0);
      this.castleGroup.add(m);
    }
    for (const x of [-HW - 0.3, HW + 0.3]) {
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(1.4, 1.6, 7, 10), cm);
      tw.position.set(x, 3.5, 0);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.9, 2.4, 10), cr);
      roof.position.set(x, 8.2, 0);
      this.castleGroup.add(tw, roof);
    }
    this.castleGroup.position.z = -(L + 1.5);
    this.root.add(this.castleGroup);
    this.castleLabel = overlay.label('boss-hp');
    this.baseLabel = overlay.label('base-hp');

    // cannon
    this.cannon = new THREE.Group();
    const cmat = new THREE.MeshLambertMaterial({ color: cos.color, flatShading: true });
    const dark = new THREE.MeshLambertMaterial({ color: '#3a3f4a', flatShading: true });
    const baseM = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 1.4), cmat);
    baseM.position.y = 0.55;
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 1.8, 10), cmat);
    barrel.rotation.x = -Math.PI / 2.4;
    barrel.position.set(0, 1.2, -0.4);
    barrel.name = 'barrel';
    this.cannon.add(baseM, barrel);
    for (const sx of [-0.55, 0.55]) for (const sz of [-0.45, 0.45]) {
      const wh = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.3, 0.25, 10), dark);
      wh.rotation.z = Math.PI / 2;
      wh.position.set(sx * 1.25, 0.3, sz);
      this.cannon.add(wh);
    }
    this.cannon.position.z = -0.2;
    this.root.add(this.cannon);

    // aiming aids: ring under the cannon, chevrons along the firing line, active-lane glow
    const teamGlow = new THREE.MeshBasicMaterial({ color: cos.color, transparent: true, opacity: 0.9, depthWrite: false });
    this.reticle = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.RingGeometry(1.05, 1.35, 40), teamGlow);
    ring.rotation.x = -Math.PI / 2;
    ring.name = 'ring';
    const inner = new THREE.Mesh(new THREE.RingGeometry(0.25, 0.4, 24), teamGlow);
    inner.rotation.x = -Math.PI / 2;
    const tick = new THREE.PlaneGeometry(0.16, 0.7);
    for (const [x, z, r] of [[0, -1.75, 0], [0, 1.75, 0], [-1.75, 0, Math.PI / 2], [1.75, 0, Math.PI / 2]] as const) {
      const t = new THREE.Mesh(tick, teamGlow);
      t.rotation.set(-Math.PI / 2, 0, r);
      t.position.set(x, 0, z);
      this.reticle.add(t);
    }
    this.reticle.add(ring, inner);
    this.reticle.position.set(0, 0.06, -0.2);
    this.root.add(this.reticle);
    const chevGeo = new THREE.ShapeGeometry(new THREE.Shape([
      new THREE.Vector2(-0.55, 0), new THREE.Vector2(0, 0.45), new THREE.Vector2(0.55, 0),
      new THREE.Vector2(0.55, -0.22), new THREE.Vector2(0, 0.22), new THREE.Vector2(-0.55, -0.22),
    ]));
    for (let i = 0; i < 6; i++) {
      const c = new THREE.Mesh(chevGeo, new THREE.MeshBasicMaterial({ color: cos.color, transparent: true, opacity: 0.8, depthWrite: false }));
      c.rotation.x = -Math.PI / 2;
      this.root.add(c);
      this.chevrons.push(c);
    }
    this.laneGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, L), new THREE.MeshBasicMaterial({ color: cos.color, transparent: true, opacity: 0.2, depthWrite: false }));
    this.laneGlow.rotation.x = -Math.PI / 2;
    this.laneGlow.position.set(0, 0.025, -L / 2);
    this.root.add(this.laneGlow);

    this.waveState = lv.waves.map((w) => {
      const ents = Math.max(3, Math.min(240, Math.round(Math.sqrt(w.count) * 6)));
      return { left: w.count, ents, spawned: 0, started: false, per: Math.floor(w.count / ents), rem: w.count % ents };
    });
    for (let i = 0; i < lv.lanes.length; i++) this.laneWarn.push(overlay.label('lane-warn'));
  }

  private makePanel(g: GateSpec, w: number, cx: number, s: number): THREE.Mesh {
    const p = new THREE.Mesh(new THREE.PlaneGeometry(w, 1.25), new THREE.MeshBasicMaterial({ map: gateTex(g), transparent: true, side: THREE.DoubleSide, depthWrite: false }));
    p.position.set(cx, 0.75, -s);
    p.rotation.x = -0.35;
    this.root.add(p);
    return p;
  }

  laneAt(x: number): number {
    const ls = this.lv.lanes;
    for (let i = 0; i < ls.length; i++) if (x < ls[i].x1) return i;
    return ls.length - 1;
  }

  // ------------------------------------------------------------------

  update(dt: number, realDt: number, inputTarget: number, time: number): void {
    const lv = this.lv;
    const L = lv.L;
    if (this.state === 'play') this.t += dt;

    // cannon steering (input range ±4.4 → field)
    const lim = LANES.halfWidth - 0.9;
    const target = Math.max(-lim, Math.min(lim, (inputTarget / 4.4) * lim));
    this.cannonX += (target - this.cannonX) * (1 - Math.exp(-14 * realDt));
    this.cannon.position.x = this.cannonX;
    const lane = this.laneAt(this.cannonX);
    if (lane !== this.lastLane) {
      if (this.lastLane >= 0) this.moveLock = LANES.laneSwitchTime * 0.5;
      this.lastLane = lane;
    }

    if (this.state === 'play') {
      // fire
      if (this.moveLock > 0) this.moveLock -= dt;
      else {
        this.fireAcc += lv.fireRate * dt;
        while (this.fireAcc >= 1) {
          this.fireAcc--;
          this.spawnPlayer(lane);
        }
      }
      this.spawnWaves(dt);
    }
    this.fireCd -= dt;
    // aiming aids follow the cannon; the lane glow snaps to the lane being fed
    this.reticle.position.x = this.cannonX;
    const pulse = 1 + Math.sin(time * 6) * 0.08;
    this.reticle.getObjectByName('ring')!.scale.set(pulse, pulse, 1);
    this.reticle.rotation.y = time * 0.6;
    const ln = lv.lanes[lane];
    this.laneGlow.position.x += ((ln.x0 + ln.x1) / 2 - this.laneGlow.position.x) * Math.min(1, realDt * 18);
    this.laneGlow.scale.x = ln.x1 - ln.x0 - 0.4;
    const shotX = Math.max(ln.x0 + 0.35, Math.min(ln.x1 - 0.35, this.cannonX));
    this.chevrons.forEach((c, i) => {
      const k = ((time * 1.4 + i / this.chevrons.length) % 1);
      c.position.set(shotX, 0.05, -(2 + k * 9));
      (c.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k) * (this.state === 'play' ? 1 : 0);
    });
    const barrel = this.cannon.getObjectByName('barrel')!;
    barrel.position.z = -0.4 + Math.max(0, this.fireCd) * 0.8;

    this.stepPlayers(dt, L);
    this.stepEnemies(dt, time);
    this.collide();
    this.render(time);
    this.updateLabels(realDt);

    // camera: high three-quarter view down the lanes
    const cam = this.stage.camera;
    const aspect = window.innerWidth / window.innerHeight;
    const portrait = aspect < 0.75;
    // framed so the cannon/reticle (s≈0) and the castle are both always on screen
    const back = portrait ? 15 : 18;
    const h = portrait ? 27 : 23;
    cam.position.set(this.cannonX * 0.12, h, back);
    if (this.shake > 0) {
      this.shake -= realDt;
      cam.position.x += (Math.random() - 0.5) * this.shake * 1.4;
      cam.position.y += (Math.random() - 0.5) * this.shake * 1.4;
    }
    cam.lookAt(0, 0, -L * (portrait ? 0.4 : 0.35));

    // end conditions
    if (this.state === 'play') {
      if (this.castle <= 0) this.finish(true, 'Castle destroyed');
      else if (this.base <= 0) this.finish(false, 'Your base was overrun');
      else if (this.t >= lv.maxTime) this.finish(false, 'Out of time — reinforcements overwhelmed you');
    } else {
      this.endT += realDt;
      if (this.endT > 1.6 && this.endT - realDt <= 1.6) this.onEnd(this.result());
    }
  }

  private finish(won: boolean, reason: string): void {
    this.state = won ? 'won' : 'lost';
    this.endReason = reason;
    this.endT = 0;
    this.slowmo = 1.2;
    this.shake = won ? 1 : 0.6;
    if (won) {
      this.castle = 0;
      for (let k = 0; k < 8; k++) this.particles.emit((Math.random() - 0.5) * 14, 2 + Math.random() * 3, -(this.lv.L + 1.5), 40, k % 2 ? '#b54a3c' : '#ffd23f', { speed: 10, up: 8, size: 0.35, life: 1.4 });
      this.castleGroup.visible = false;
      sfx.play('bossDown');
      haptic(150);
      this.onBanner('CASTLE DESTROYED!', 'golden', 1.8);
    } else {
      sfx.play('lose');
      haptic(200);
      this.onBanner(this.t >= this.lv.maxTime ? 'TIME UP' : 'BASE OVERRUN', 'danger', 1.6);
    }
  }
  private endReason = '';

  result(): LanesStats {
    return {
      won: this.state === 'won', time: this.t, kills: this.stats.kills, peak: this.stats.peak,
      castlePct: 1 - Math.max(0, this.castle) / this.lv.castleHP, towersBroken: this.stats.towers, reason: this.endReason,
    };
  }

  // ------------------------------------------------------------------
  // units
  // ------------------------------------------------------------------

  private spawnPlayer(lane: number): void {
    if (this.players.length >= LANES.playerCap) return;
    const ln = this.lv.lanes[lane];
    const x = Math.max(ln.x0 + 0.35, Math.min(ln.x1 - 0.35, this.cannonX + (Math.random() - 0.5) * 0.3));
    this.players.push({ x, s: LANES.cannonS + 0.6, w: 1, lane, ei: 0, born: this.t });
    this.fireCd = 0.08;
    sfx.play('spawn');
  }

  private stepPlayers(dt: number, L: number): void {
    const P = this.players;
    for (let i = P.length - 1; i >= 0; i--) {
      const u = P[i];
      if (this.state === 'won') {
        continue;
      }
      u.s += LANES.unitSpeed * dt;
      const evs = this.events[u.lane];
      let dead = false;
      while (u.ei < evs.length && u.s >= evs[u.ei].s) {
        const e = evs[u.ei];
        if (e.kind === 'tower' && !e.broken) {
          e.hpLeft -= u.w;
          e.pulse = 0.12;
          if (Math.random() < 0.35) this.particles.emit(u.x, 1 + Math.random() * 4, -e.s, 3, '#bfc3c9', { speed: 3, up: 3, size: 0.14 });
          if (e.hpLeft <= 0) this.breakTower(e, u.lane);
          dead = true;
          break;
        }
        const op = e.kind === 'tower' ? 'mul' : e.op!;
        const v = e.kind === 'tower' ? e.mult! : e.v!;
        const total = Math.max(1, Math.round(op === 'div' ? Math.ceil(applyLaneGate(u.w, op, v)) : applyLaneGate(u.w, op, v)));
        e.pulse = 0.12;
        u.ei++;
        if (op === 'mul') {
          const room = LANES.playerCap - 300 - P.length;
          const k = Math.max(1, Math.min(splitCount(v), room > 0 ? room + 1 : 1));
          const base = Math.floor(total / k);
          let rem = total - base * k;
          u.w = base + (rem-- > 0 ? 1 : 0);
          const ln = this.lv.lanes[u.lane];
          for (let j = 1; j < k; j++) {
            const x = Math.max(ln.x0 + 0.35, Math.min(ln.x1 - 0.35, u.x + (Math.random() - 0.5) * (ln.x1 - ln.x0) * 0.8));
            P.push({ x, s: u.s - Math.random() * 0.5, w: base + (rem-- > 0 ? 1 : 0), lane: u.lane, ei: u.ei, born: this.t });
          }
          if (v >= 10) this.particles.emit(u.x, 1, -e.s, 4, e.kind === 'tower' ? '#ffd23f' : '#58b6ff', { speed: 3, up: 3, size: 0.12 });
        } else u.w = total;
      }
      if (!dead && u.s >= L) {
        this.castle -= u.w;
        this.castleDmgAcc += u.w;
        if (Math.random() < 0.3) this.particles.emit(u.x, 1.5, -(L + 0.2), 3, '#b54a3c', { speed: 4, up: 4, size: 0.15 });
        dead = true;
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

  private breakTower(e: RtEvent, lane: number): void {
    e.broken = true;
    this.stats.towers++;
    const ln = this.lv.lanes[lane];
    const cx = (ln.x0 + ln.x1) / 2;
    if (e.mesh) this.root.remove(e.mesh);
    e.label?.remove();
    e.label = null;
    for (let k = 0; k < 5; k++) this.particles.emit(cx, 1 + k, -e.s - 1, 30, k % 2 ? '#8f9399' : '#ffd23f', { speed: 8, up: 7, size: 0.3, life: 1.2 });
    e.panel = this.makePanel({ op: 'mul', v: e.mult!, golden: true }, ln.x1 - ln.x0 - 0.5, cx, e.s);
    this.shake = 0.7;
    this.slowmo = 0.6;
    sfx.play('gateGolden');
    haptic(80);
    this.onBanner(`×${e.mult} UNLOCKED!`, 'golden', 1.6);
  }

  private spawnWaves(dt: number): void {
    const lv = this.lv;
    lv.waves.forEach((w, i) => {
      const st = this.waveState[i];
      if (this.t < w.t || st.spawned >= st.ents) return;
      if (!st.started) {
        st.started = true;
        sfx.play('battleStart');
        const ln = lv.lanes[w.lane];
        if (w.final) this.onBanner('FINAL WAVE!', 'danger', 1.5);
        this.overlay.float(`⚠ ${fmt(w.count)}`, new THREE.Vector3((ln.x0 + ln.x1) / 2, 2, -(lv.L - 3)), 'bad big', 1.6);
      }
      const want = Math.min(st.ents, Math.ceil(((this.t - w.t) / 1.5) * st.ents));
      const ln = lv.lanes[w.lane];
      while (st.spawned < want) {
        const wgt = st.per + (st.spawned < st.rem ? 1 : 0);
        st.spawned++;
        if (wgt <= 0) continue;
        if (this.enemies.length >= LANES.enemyCap) {
          // merge into the most recent enemy in this lane rather than dropping strength
          const last = [...this.enemies].reverse().find((e) => e.lane === w.lane);
          if (last) last.w += wgt;
          continue;
        }
        this.enemies.push({ x: ln.x0 + 0.4 + Math.random() * (ln.x1 - ln.x0 - 0.8), s: lv.L - 0.3 - Math.random() * 2.5, w: wgt, lane: w.lane, phase: Math.random() * 6 });
      }
    });
    void dt;
  }

  private stepEnemies(dt: number, time: number): void {
    const E = this.enemies;
    for (let i = E.length - 1; i >= 0; i--) {
      const e = E[i];
      if (this.state !== 'play') continue;
      e.s -= LANES.enemySpeed * dt;
      e.x += Math.sin(time * 2 + e.phase) * 0.2 * dt;
      if (e.s <= 0.6) {
        this.base -= e.w;
        this.shake = Math.max(this.shake, 0.25);
        this.particles.emit(e.x, 0.6, -0.6, 6, '#ff4b5c', { speed: 3, up: 3 });
        this.overlay.float(`−${fmt(e.w)}`, new THREE.Vector3(e.x, 1.5, -1), 'bad');
        sfx.play('death');
        E[i] = E[E.length - 1];
        E.pop();
      }
    }
  }

  private collide(): void {
    const E = this.enemies;
    const P = this.players;
    if (!E.length || !P.length) return;
    const buckets = new Map<number, number[]>();
    const key = (lane: number, s: number) => lane * 1000 + Math.floor(s * 1.25);
    E.forEach((e, i) => {
      const k = key(e.lane, e.s);
      let b = buckets.get(k);
      if (!b) buckets.set(k, (b = []));
      b.push(i);
    });
    let fx = 0;
    for (const p of P) {
      if (p.w <= 0) continue;
      const kb = key(p.lane, p.s);
      for (let d = -1; d <= 1 && p.w > 0; d++) {
        const b = buckets.get(kb + d);
        if (!b) continue;
        for (const ei of b) {
          const e = E[ei];
          if (e.w <= 0) continue;
          if (Math.abs(e.s - p.s) > 0.7 || Math.abs(e.x - p.x) > 0.8) continue;
          const k = Math.min(p.w, e.w);
          p.w -= k;
          e.w -= k;
          this.stats.kills += k;
          if (fx++ < 6) this.particles.emit((p.x + e.x) / 2, 0.5, -(p.s + e.s) / 2, 3, Math.random() < 0.5 ? '#e8413c' : this.color, { speed: 3, up: 3, size: 0.1, life: 0.4 });
          if (p.w <= 0) break;
        }
      }
    }
    if (fx) sfx.play('hit');
    this.players = P.filter((p) => p.w > 0);
    this.enemies = E.filter((e) => e.w > 0);
  }

  // ------------------------------------------------------------------
  // rendering
  // ------------------------------------------------------------------

  private render(time: number): void {
    const pa = this.pMesh.instanceMatrix.array as Float32Array;
    const wa = this.wMesh ? (this.wMesh.instanceMatrix.array as Float32Array) : null;
    const won = this.state === 'won';
    let n = 0;
    for (const u of this.players) {
      const age = this.t - u.born;
      const sc = (0.95 + Math.min(0.9, Math.log10(u.w) * 0.22)) * (age < 0.15 ? 0.4 + age * 4 : 1);
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
      const sc = 0.95 + Math.min(1.1, Math.log10(e.w) * 0.25);
      const o = m * 16;
      ea[o] = -sc; ea[o + 1] = 0; ea[o + 2] = 0; ea[o + 3] = 0;
      ea[o + 4] = 0; ea[o + 5] = sc; ea[o + 6] = 0; ea[o + 7] = 0;
      ea[o + 8] = 0; ea[o + 9] = 0; ea[o + 10] = -sc; ea[o + 11] = 0;
      ea[o + 12] = e.x; ea[o + 13] = Math.abs(Math.sin(time * 12 + e.phase)) * 0.1; ea[o + 14] = -e.s; ea[o + 15] = 1;
      m++;
    }
    this.eMesh.count = m;
    this.eMesh.instanceMatrix.needsUpdate = true;

    for (const lane of this.events) for (const e of lane) {
      if (e.pulse > 0) e.pulse -= 1 / 60;
      const sc = 1 + Math.max(0, e.pulse) * 1.2;
      if (e.panel) e.panel.scale.set(sc, sc, 1);
      if (e.mesh && !e.broken) e.mesh.scale.setScalar(1 + Math.max(0, e.pulse) * 0.25);
    }
  }

  private updateLabels(realDt: number): void {
    const lv = this.lv;
    const frac = Math.max(0, this.castle) / lv.castleHP;
    this.castleLabel.style.display = this.state === 'won' ? 'none' : '';
    this.overlay.place(this.castleLabel, new THREE.Vector3(0, 5.6, -(lv.L - 0.2)));
    this.castleLabel.innerHTML = `<b>ENEMY CASTLE</b><div class="bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></div><span>${fmt(Math.ceil(Math.max(0, this.castle)))}</span>`;
    this.overlay.place(this.baseLabel, new THREE.Vector3(this.cannonX, 2.6, 0));
    this.baseLabel.innerHTML = `❤ ${fmt(Math.max(0, Math.ceil(this.base)))}`;
    this.lv.lanes.forEach((ln, li) => {
      for (const e of this.events[li]) {
        if (e.label && !e.broken) {
          this.overlay.place(e.label, new THREE.Vector3((ln.x0 + ln.x1) / 2, 7.8, -e.s - 1));
          e.label.textContent = fmt(Math.max(0, Math.ceil(e.hpLeft)));
        }
      }
      // incoming-threat marker per lane
      let tot = 0;
      for (const en of this.enemies) if (en.lane === li) tot += en.w;
      const w = this.laneWarn[li];
      if (tot > 0) {
        w.style.display = '';
        this.overlay.place(w, new THREE.Vector3((ln.x0 + ln.x1) / 2, 0.2, -5));
        w.textContent = `⚔ ${fmt(tot)}`;
      } else w.style.display = 'none';
    });
    this.castleFloatT += realDt;
    if (this.castleFloatT > 0.35 && this.castleDmgAcc > 0) {
      this.overlay.float(`−${fmt(this.castleDmgAcc)}`, new THREE.Vector3((Math.random() - 0.5) * 8, 2.5, -(lv.L - 0.5)), 'golden');
      this.castleDmgAcc = 0;
      this.castleFloatT = 0;
    }
  }

  dispose(): void {
    this.stage.scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.castleLabel.remove();
    this.baseLabel.remove();
    for (const w of this.laneWarn) w.remove();
    for (const lane of this.events) for (const e of lane) e.label?.remove();
  }
}
