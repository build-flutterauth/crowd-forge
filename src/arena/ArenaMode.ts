// Arena gameplay (main mode). A free-moving cannon fires soldiers up through
// bays of gates; ×N gates multiply (and split) groups, hedges must be chewed
// through to reach sealed jackpots. Past the gates the army converges into the
// hedge funnel and clashes with the horde pouring down toward the cannon.
import * as THREE from 'three';
import { sfx, haptic } from '../audio/SoundSystem';
import { ARENA, corridorHalf } from '../config/arenaConfig';
import type { GateSpec } from '../core/types';
import { panelTexture } from '../game/GateSystem';
import type { Overlay, Particles } from '../render/Effects';
import type { Stage3D } from '../render/Stage3D';
import { unitGeometry, weaponGeometry } from '../render/UnitGeometry';
import { fmt } from '../sim/rules';
import { applyArenaGate, enemyThroughGate, splitCount, type ArenaGate, type ArenaLevelData, type Bay } from './ArenaSim';

interface PUnit { x: number; s: number; w: number; bay: number; ei: number; born: number; off: number }
interface EUnit { x: number; s: number; w: number; phase: number; stun: number; hit: number; bay: number }

interface RtHedge {
  bay: number;
  x0: number; x1: number; s0: number; s1: number;
  hp: number; max: number;
  mesh: THREE.Group;
  label: HTMLDivElement;
  shake: number;
  broken: boolean;
}

interface RtGate { g: ArenaGate; mesh: THREE.Group; pulse: number }

type BayEvent = { s: number; gate?: RtGate; hedge?: RtHedge };

export interface ArenaStats {
  won: boolean;
  time: number;
  kills: number;
  peak: number;
  castlePct: number;
  hedges: number;
  reason: string;
}

const texCache = new Map<string, THREE.CanvasTexture>();
function gateTex(g: GateSpec): THREE.CanvasTexture {
  const k = `${g.op}:${g.v}:${g.golden ? 1 : 0}`;
  let t = texCache.get(k);
  if (!t) texCache.set(k, (t = panelTexture(g)));
  return t;
}

const HEDGE_MAT = new THREE.MeshLambertMaterial({ color: '#3f9a3a', flatShading: true });
const HEDGE_TOP = new THREE.MeshLambertMaterial({ color: '#56b84a', flatShading: true });
const FUNNEL_MAT = new THREE.MeshLambertMaterial({ color: '#3a8f37', flatShading: true });
const STONE = new THREE.MeshLambertMaterial({ color: '#9aa1ab', flatShading: true });
const POST = new THREE.MeshLambertMaterial({ color: '#8a6a45', flatShading: true });

export class ArenaMode {
  readonly lv: ArenaLevelData;
  private stage: Stage3D;
  private particles: Particles;
  private overlay: Overlay;
  private root = new THREE.Group();
  private players: PUnit[] = [];
  private enemies: EUnit[] = [];
  private bayEvents: BayEvent[][];
  private hedges: RtHedge[] = [];
  private gates: RtGate[] = [];
  private pMesh: THREE.InstancedMesh;
  private wMesh: THREE.InstancedMesh | null = null;
  private eMesh: THREE.InstancedMesh;
  private cannon: THREE.Group;
  private reticle: THREE.Group;
  private bayGlow: THREE.Mesh;
  private chevrons: THREE.Mesh[] = [];
  private fortress: THREE.Group;
  private fortressLabel: HTMLDivElement;
  private baseLabel: HTMLDivElement;
  private hordeLabel: HTMLDivElement;
  private leakLabel: HTMLDivElement;
  private waveState: { ents: number; spawned: number; started: boolean; per: number; rem: number }[];
  castle: number;
  base: number;
  t = 0;
  cannonX = 0;
  private lastBay = -1;
  private fireAcc = 0;
  private lock = 0;
  private fireCd = 0;
  private shake = 0;
  private dmgAcc = 0;
  private dmgT = 0;
  state: 'play' | 'won' | 'lost' = 'play';
  private endT = 0;
  private reason = '';
  private stats = { kills: 0, peak: 0, hedges: 0 };
  private color: string;
  slowmo = 0;
  onEnd: (s: ArenaStats) => void = () => {};
  onBanner: (text: string, cls?: string, dur?: number) => void = () => {};

  constructor(stage: Stage3D, particles: Particles, overlay: Overlay, lv: ArenaLevelData, cos: { skin: string; color: string; weapon: string }) {
    this.stage = stage;
    this.particles = particles;
    this.overlay = overlay;
    this.lv = lv;
    this.color = cos.color;
    this.castle = lv.castleHP;
    this.base = lv.baseHP;
    stage.scene.add(this.root);
    const HW = ARENA.halfWidth;
    const L = ARENA.length;
    const [z0, z1] = ARENA.gateZone;

    // --- units
    this.pMesh = new THREE.InstancedMesh(unitGeometry(cos.skin), new THREE.MeshLambertMaterial({ vertexColors: true }), ARENA.playerCap);
    this.pMesh.frustumCulled = false;
    this.pMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const pc = new THREE.Color(cos.color);
    for (let i = 0; i < ARENA.playerCap; i++) this.pMesh.setColorAt(i, pc);
    this.root.add(this.pMesh);
    const wg = weaponGeometry(cos.weapon);
    if (wg) {
      this.wMesh = new THREE.InstancedMesh(wg.geo, new THREE.MeshLambertMaterial({ color: wg.color, vertexColors: true }), ARENA.playerCap);
      this.wMesh.frustumCulled = false;
      this.root.add(this.wMesh);
    }
    this.eMesh = new THREE.InstancedMesh(unitGeometry('classic'), new THREE.MeshLambertMaterial({ vertexColors: true }), ARENA.enemyCap);
    this.eMesh.frustumCulled = false;
    this.eMesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    const ec = new THREE.Color('#e8413c');
    for (let i = 0; i < ARENA.enemyCap; i++) this.eMesh.setColorAt(i, ec);
    this.root.add(this.eMesh);

    // --- floor: stone plaza over the play area
    const plaza = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, z1 + 3), new THREE.MeshLambertMaterial({ color: '#d9dde3' }));
    plaza.rotation.x = -Math.PI / 2;
    plaza.position.set(0, 0.01, -(z1 + 3) / 2);
    this.root.add(plaza);
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 0.45), new THREE.MeshBasicMaterial({ color: '#ff4b5c', transparent: true, opacity: 0.45 }));
    line.rotation.x = -Math.PI / 2;
    line.position.set(0, 0.03, -0.6);
    this.root.add(line);

    // --- funnel hedges (V shape) on both sides
    for (const side of [-1, 1]) {
      const pts: [number, number][] = [];
      const steps = 12;
      const sA = z1 + 1;
      const sB = L + 5;
      for (let i = 0; i <= steps; i++) {
        const s = sA + ((sB - sA) * i) / steps;
        pts.push([corridorHalf(Math.min(s, ARENA.funnel.topS)), s]);
      }
      const shape = new THREE.Shape();
      shape.moveTo(side * (HW + 3), sA);
      for (const [x, s] of pts) shape.lineTo(side * x, s);
      shape.lineTo(side * (HW + 3), sB);
      shape.closePath();
      const geo = new THREE.ExtrudeGeometry(shape, { depth: 1.8, bevelEnabled: false });
      geo.rotateX(-Math.PI / 2);
      const m = new THREE.Mesh(geo, FUNNEL_MAT);
      this.root.add(m);
    }

    // --- bays: fences, gates, hedges
    this.bayEvents = lv.bays.map((b, bi) => {
      const ev: BayEvent[] = [];
      for (const g of b.gates) {
        const rg = this.makeGate(g);
        this.gates.push(rg);
        ev.push({ s: g.s, gate: rg });
      }
      if (b.hedge) {
        const h = b.hedge;
        const grp = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(h.x1 - h.x0 - 0.15, 1.5, h.s1 - h.s0), HEDGE_MAT);
        body.position.y = 0.75;
        const top = new THREE.Mesh(new THREE.BoxGeometry(h.x1 - h.x0 - 0.05, 0.3, h.s1 - h.s0 + 0.1), HEDGE_TOP);
        top.position.y = 1.55;
        grp.add(body, top);
        grp.position.set((h.x0 + h.x1) / 2, 0, -(h.s0 + h.s1) / 2);
        this.root.add(grp);
        const rh: RtHedge = { bay: bi, x0: h.x0, x1: h.x1, s0: h.s0, s1: h.s1, hp: h.hp, max: h.hp, mesh: grp, label: overlay.label('tower-hp'), shake: 0, broken: false };
        this.hedges.push(rh);
        ev.push({ s: h.s0, hedge: rh });
      }
      return ev.sort((a, c) => a.s - c.s);
    });
    lv.bays.slice(0, -1).forEach((b) => {
      const f = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.8, z1 - z0 + 2), STONE);
      f.position.set(b.x1, 0.4, -(z0 + z1) / 2);
      this.root.add(f);
    });

    // --- fortress at the top of the funnel
    this.fortress = new THREE.Group();
    const fm = new THREE.MeshLambertMaterial({ color: '#b54a3c', flatShading: true });
    const fr = new THREE.MeshLambertMaterial({ color: '#6d2a22', flatShading: true });
    const th = ARENA.funnel.topHalf;
    const wall = new THREE.Mesh(new THREE.BoxGeometry(th * 2 + 1, 3.6, 2.4), fm);
    wall.position.y = 1.8;
    this.fortress.add(wall);
    for (const x of [-th - 0.2, th + 0.2]) {
      const tw = new THREE.Mesh(new THREE.CylinderGeometry(1.2, 1.4, 6, 10), fm);
      tw.position.set(x, 3, 0);
      const roof = new THREE.Mesh(new THREE.ConeGeometry(1.7, 2.2, 10), fr);
      roof.position.set(x, 7.1, 0);
      this.fortress.add(tw, roof);
    }
    this.fortress.position.z = -(L + 1.5);
    this.root.add(this.fortress);

    // --- cannon + aiming aids
    this.cannon = new THREE.Group();
    const cm = new THREE.MeshLambertMaterial({ color: '#3a3f4a', flatShading: true });
    const team = new THREE.MeshLambertMaterial({ color: cos.color, flatShading: true });
    const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.55, 1.9, 12), cm);
    barrel.rotation.x = -Math.PI / 2.3;
    barrel.position.set(0, 1.1, -0.3);
    barrel.name = 'barrel';
    const ringM = new THREE.Mesh(new THREE.TorusGeometry(0.45, 0.12, 8, 16), team);
    ringM.position.set(0, 1.45, -1.1);
    ringM.rotation.x = -0.3;
    barrel.add(ringM);
    ringM.position.set(0, 0.95, 0);
    ringM.rotation.set(Math.PI / 2, 0, 0);
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
    const tick = new THREE.PlaneGeometry(0.16, 0.7);
    for (const [x, z, r] of [[0, -1.75, 0], [0, 1.75, 0], [-1.75, 0, Math.PI / 2], [1.75, 0, Math.PI / 2]] as const) {
      const tm = new THREE.Mesh(tick, glowMat);
      tm.rotation.set(-Math.PI / 2, 0, r);
      tm.position.set(x, 0, z);
      this.reticle.add(tm);
    }
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
    this.bayGlow = new THREE.Mesh(new THREE.PlaneGeometry(1, z1), new THREE.MeshBasicMaterial({ color: cos.color, transparent: true, opacity: 0.16, depthWrite: false }));
    this.bayGlow.rotation.x = -Math.PI / 2;
    this.bayGlow.position.set(0, 0.025, -z1 / 2);
    this.root.add(this.bayGlow);

    this.fortressLabel = overlay.label('boss-hp');
    this.baseLabel = overlay.label('base-hp');
    this.hordeLabel = overlay.label('lane-warn');
    this.leakLabel = overlay.label('lane-warn leak');
    this.waveState = lv.waves.map((w) => {
      const ents = Math.max(4, Math.min(320, Math.round(Math.sqrt(w.count) * 7)));
      return { ents, spawned: 0, started: false, per: Math.floor(w.count / ents), rem: w.count % ents };
    });
  }

  private makeGate(g: ArenaGate): RtGate {
    const spec: GateSpec = { op: g.op, v: g.v, golden: g.op === 'mul' && g.v >= 50 };
    const w = g.x1 - g.x0 - 0.3;
    const grp = new THREE.Group();
    const face = new THREE.MeshBasicMaterial({ map: gateTex(spec) });
    const edge = new THREE.MeshLambertMaterial({ color: spec.golden ? '#e0a800' : g.op === 'div' || g.op === 'sub' ? '#c0303e' : '#1f6fd6' });
    const panel = new THREE.Mesh(new THREE.BoxGeometry(w, 1.55, 0.4), [edge, edge, edge, edge, face, edge]);
    panel.position.y = 1.05;
    panel.rotation.x = -0.5;
    grp.add(panel);
    for (const x of [-w / 2 - 0.08, w / 2 + 0.08]) {
      const p = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.9, 0.18), POST);
      p.position.set(x, 0.95, 0.2);
      grp.add(p);
    }
    grp.position.set((g.x0 + g.x1) / 2, 0, -g.s);
    this.root.add(grp);
    return { g, mesh: grp, pulse: 0 };
  }

  bayAt(x: number): number {
    const b = this.lv.bays;
    for (let i = 0; i < b.length; i++) if (x < b[i].x1) return i;
    return b.length - 1;
  }

  // ------------------------------------------------------------------

  update(dt: number, realDt: number, inputTarget: number, time: number): void {
    const lv = this.lv;
    if (this.state === 'play') this.t += dt;
    const lim = ARENA.halfWidth - 0.8;
    const target = Math.max(-lim, Math.min(lim, (inputTarget / 4.4) * lim));
    this.cannonX += (target - this.cannonX) * (1 - Math.exp(-14 * realDt));
    this.cannon.position.x = this.cannonX;
    const bay = this.bayAt(this.cannonX);
    if (bay !== this.lastBay) {
      if (this.lastBay >= 0) this.lock = ARENA.switchTime;
      this.lastBay = bay;
    }

    if (this.state === 'play') {
      if (this.lock > 0) this.lock -= dt;
      else {
        this.fireAcc += lv.fireRate * dt;
        while (this.fireAcc >= 1) {
          this.fireAcc--;
          this.spawnPlayer(bay);
        }
      }
      this.spawnWaves();
    }
    this.fireCd -= dt;
    const barrel = this.cannon.getObjectByName('barrel')!;
    barrel.position.z = -0.3 + Math.max(0, this.fireCd) * 0.8;

    this.stepPlayers(dt);
    this.stepEnemies(dt, time);
    this.collide();
    this.render(time, realDt, bay);
    this.labels(realDt);
    this.camera(realDt);

    if (this.state === 'play') {
      if (this.castle <= 0) this.finish(true, 'Fortress destroyed');
      else if (this.base <= 0) this.finish(false, 'The horde reached your cannon');
      else if (this.t >= lv.maxTime) this.finish(false, 'Out of time — the horde kept coming');
      else this.checkDoomed(dt);
    } else {
      this.endT += realDt;
      if (this.endT > 1.6 && this.endT - realDt <= 1.6) this.onEnd(this.result());
    }
  }

  private camera(realDt: number): void {
    const cam = this.stage.camera;
    const aspect = window.innerWidth / window.innerHeight;
    const portrait = aspect < 0.75;
    cam.position.set(this.cannonX * 0.1, portrait ? 31 : 25, portrait ? 13 : 15);
    if (this.shake > 0) {
      this.shake -= realDt;
      cam.position.x += (Math.random() - 0.5) * this.shake * 1.4;
      cam.position.y += (Math.random() - 0.5) * this.shake * 1.4;
    }
    cam.lookAt(0, 0, portrait ? -18 : -16);
  }

  // ------------------------------------------------------------------
  // "No way back": end early once the outcome is mathematically decided
  // ------------------------------------------------------------------

  private doomT = 0;
  private doomCheckT = 0;
  private dmgHist: { t: number; castle: number }[] = [];

  /** Generous to the player: only fires when even the best case can't recover. */
  private doomReason(): string | null {
    const lv = this.lv;
    // 1) a breakthrough past all gates that outweighs the base, even after every shot the cannon can still fire
    const z0 = ARENA.gateZone[0];
    let leak = 0;
    let farthest = 0;
    for (const e of this.enemies) if (e.s < z0 - 0.5) {
      leak += e.w;
      farthest = Math.max(farthest, e.s);
    }
    if (leak > 0) {
      const maxArrival = farthest / (ARENA.enemySpeed * 0.25); // as if slowed the whole way
      const killable = lv.fireRate * maxArrival;
      if (leak - killable >= this.base) return `A breakthrough of ${fmt(leak)} outweighs your base (${fmt(Math.max(0, this.base))})`;
    }
    // 2) not enough time left, even at the best damage rate reached so far
    const left = lv.maxTime - this.t;
    if (left < 20 && this.dmgHist.length > 6) {
      let best = 0;
      for (let i = 0; i < this.dmgHist.length; i++) {
        for (let j = i + 1; j < this.dmgHist.length; j++) {
          const span = this.dmgHist[j].t - this.dmgHist[i].t;
          if (span >= 2.5) {
            best = Math.max(best, (this.dmgHist[i].castle - this.dmgHist[j].castle) / span);
            break;
          }
        }
      }
      if (Math.max(0, this.castle) > best * 1.5 * left + 1) return `Not enough time: ${fmt(this.castle)} fortress HP left with ${Math.ceil(left)}s to go`;
    }
    return null;
  }

  private checkDoomed(dt: number): void {
    this.doomCheckT -= dt;
    if (this.doomCheckT > 0) return;
    this.doomCheckT = 0.25;
    this.dmgHist.push({ t: this.t, castle: this.castle });
    if (this.dmgHist.length > 240) this.dmgHist.shift();
    const why = this.doomReason();
    this.doomT = why ? this.doomT + 0.25 : 0;
    if (why && this.doomT >= 1.25) {
      this.onBanner('NO WAY BACK', 'danger', 1.6);
      this.finish(false, why, true);
    }
  }

  private finish(won: boolean, reason: string, early = false): void {
    this.state = won ? 'won' : 'lost';
    this.reason = reason;
    this.endT = 0;
    this.slowmo = 1.2;
    this.shake = won ? 1 : 0.6;
    if (won) {
      this.castle = 0;
      for (let k = 0; k < 8; k++) this.particles.emit((Math.random() - 0.5) * 10, 2 + Math.random() * 3, -(ARENA.length + 1.5), 40, k % 2 ? '#b54a3c' : '#ffd23f', { speed: 10, up: 8, size: 0.35, life: 1.4 });
      this.fortress.visible = false;
      sfx.play('bossDown');
      haptic(150);
      this.onBanner('FORTRESS DESTROYED!', 'golden', 1.8);
    } else {
      sfx.play('lose');
      haptic(200);
      if (!early) this.onBanner(this.t >= this.lv.maxTime ? 'TIME UP' : 'OVERRUN', 'danger', 1.6);
    }
  }

  result(): ArenaStats {
    return {
      won: this.state === 'won', time: this.t, kills: this.stats.kills, peak: this.stats.peak,
      castlePct: 1 - Math.max(0, this.castle) / this.lv.castleHP, hedges: this.stats.hedges, reason: this.reason,
    };
  }

  // ------------------------------------------------------------------

  private spawnPlayer(bay: number): void {
    if (this.players.length >= ARENA.playerCap) return;
    const b = this.lv.bays[bay];
    const x = Math.max(b.x0 + 0.3, Math.min(b.x1 - 0.3, this.cannonX + (Math.random() - 0.5) * 0.35));
    this.players.push({ x, s: ARENA.cannonS + 0.6, w: 1, bay, ei: 0, born: this.t, off: Math.random() * 2 - 1 });
    this.fireCd = 0.07;
    sfx.play('spawn');
  }

  private stepPlayers(dt: number): void {
    const P = this.players;
    const L = ARENA.length;
    const z1 = ARENA.gateZone[1];
    for (let i = P.length - 1; i >= 0; i--) {
      const u = P[i];
      if (this.state === 'won') continue;
      u.s += ARENA.unitSpeed * dt;
      let dead = false;
      if (u.s < z1 + 0.5) {
        const evs = this.bayEvents[u.bay];
        while (u.ei < evs.length && u.s >= evs[u.ei].s) {
          const e = evs[u.ei];
          if (e.hedge) {
            if (!e.hedge.broken) {
              this.hitHedge(e.hedge, u.w, u.x);
              dead = true;
              break;
            }
          } else {
            const g = e.gate!.g;
            e.gate!.pulse = 0.12;
            const total = Math.max(0, Math.round(g.op === 'div' ? Math.ceil(applyArenaGate(u.w, g.op, g.v)) : applyArenaGate(u.w, g.op, g.v)));
            if (total <= 0) {
              dead = true;
              break;
            }
            if (g.op === 'mul') {
              // keep slots in reserve for fresh shots: when crowded, groups get heavier instead of splitting
              const room = ARENA.playerCap - 350 - P.length;
              const k = Math.max(1, Math.min(splitCount(g.v), room > 0 ? room + 1 : 1));
              const base = Math.floor(total / k);
              let rem = total - base * k;
              u.w = base + (rem-- > 0 ? 1 : 0);
              for (let j = 1; j < k; j++) {
                const x = Math.max(g.x0 + 0.3, Math.min(g.x1 - 0.3, u.x + (Math.random() - 0.5) * (g.x1 - g.x0) * 0.7));
                P.push({ x, s: u.s - Math.random() * 0.6, w: base + (rem-- > 0 ? 1 : 0), bay: u.bay, ei: u.ei + 1, born: this.t, off: Math.random() * 2 - 1 });
              }
              if (g.v >= 20 && Math.random() < 0.3) this.particles.emit(u.x, 1, -g.s, 3, g.v >= 50 ? '#ffd23f' : '#58b6ff', { speed: 3, up: 3, size: 0.12 });
            } else u.w = total;
          }
          u.ei++;
        }
      } else {
        // fill the funnel gap across its whole width (each soldier keeps its own slot) so the horde can't slip past
        const lim = corridorHalf(u.s + 2.5) - 0.45;
        const tx = u.off * lim;
        u.x += Math.sign(tx - u.x) * Math.min(Math.abs(tx - u.x), ARENA.steerSpeed * dt);
      }
      if (!dead && u.s >= L) {
        this.castle -= u.w;
        this.dmgAcc += u.w;
        if (Math.random() < 0.3) this.particles.emit(u.x, 1.5, -(L + 0.3), 3, '#b54a3c', { speed: 4, up: 4, size: 0.15 });
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

  private hitHedge(h: RtHedge, w: number, x: number): void {
    h.hp -= w;
    h.shake = 0.15;
    if (Math.random() < 0.4) this.particles.emit(x, 1.2, -h.s0, 3, Math.random() < 0.5 ? '#3f9a3a' : '#7cc95f', { speed: 3, up: 4, size: 0.12 });
    if (h.hp <= 0 && !h.broken) {
      h.broken = true;
      this.stats.hedges++;
      this.root.remove(h.mesh);
      h.label.remove();
      for (let k = 0; k < 4; k++) this.particles.emit((h.x0 + h.x1) / 2 + (Math.random() - 0.5) * (h.x1 - h.x0), 1, -(h.s0 + h.s1) / 2, 30, k % 2 ? '#3f9a3a' : '#8bd36a', { speed: 7, up: 6, size: 0.22, life: 1 });
      this.shake = 0.5;
      sfx.play('gateGolden');
      haptic(60);
      this.onBanner('HEDGE CLEARED!', 'golden', 1.2);
    }
  }

  private spawnWaves(): void {
    const th = ARENA.funnel.topHalf;
    this.lv.waves.forEach((w, i) => {
      const st = this.waveState[i];
      if (this.t < w.t || st.spawned >= st.ents) return;
      if (!st.started) {
        st.started = true;
        sfx.play('battleStart');
        if (w.final) this.onBanner('FINAL WAVE!', 'danger', 1.5);
      }
      const want = Math.min(st.ents, Math.ceil(((this.t - w.t) / 2) * st.ents));
      while (st.spawned < want) {
        const wgt = st.per + (st.spawned < st.rem ? 1 : 0);
        st.spawned++;
        if (wgt <= 0) continue;
        if (this.enemies.length >= ARENA.enemyCap) {
          this.enemies[this.enemies.length - 1].w += wgt;
          continue;
        }
        this.enemies.push({ x: (Math.random() * 2 - 1) * (th - 0.6), s: ARENA.length - 0.3 - Math.random() * 3, w: wgt, phase: Math.random() * 6, stun: 0, hit: 0, bay: -1 });
      }
    });
  }

  private stepEnemies(dt: number, time: number): void {
    const E = this.enemies;
    const z1 = ARENA.gateZone[1];
    for (let i = E.length - 1; i >= 0; i--) {
      const e = E[i];
      if (this.state !== 'play') continue;
      if (e.hit > 0) e.hit -= dt;
      // enemies under fire are slowed to a crawl (not pinned — a big leak still gets through eventually)
      if (e.stun > 0) e.stun -= dt;
      const slow = e.stun > 0 ? 0.25 : 1;
      const prevS = e.s;
      e.s -= ARENA.enemySpeed * slow * dt;
      if (e.s > z1 + 1) {
        // squeeze through the funnel gap
        const l2 = Math.max(0.3, corridorHalf(e.s - 1.5) - 0.4);
        if (Math.abs(e.x) > l2) e.x += (Math.sign(e.x) * l2 - e.x) * Math.min(1, dt * 6);
        e.x += Math.sin(time * 2 + e.phase) * 0.15 * dt;
      } else {
        // broke through: commit to the bay the cannon is aiming into and march down it,
        // staying inside the fences (so they pass that bay's gates and hedge); below the
        // gates they hunt the cannon freely
        const [gz0, gz1] = ARENA.gateZone;
        if (e.s > gz0 - 0.5) {
          if (e.bay < 0 && e.s <= gz1 + 0.5) e.bay = this.bayAt(this.cannonX);
          if (e.bay >= 0) {
            const b = this.lv.bays[e.bay];
            const tx = Math.max(b.x0 + 0.35, Math.min(b.x1 - 0.35, e.x));
            e.x += Math.sign(tx - e.x) * Math.min(Math.abs(tx - e.x), 10 * dt);
          } else {
            const d = this.cannonX - e.x;
            e.x += Math.sign(d) * Math.min(Math.abs(d), ARENA.enemyChase * slow * dt);
          }
        } else {
          const d = this.cannonX - e.x;
          e.x += Math.sign(d) * Math.min(Math.abs(d), ARENA.enemyChase * slow * dt);
        }
        // walking down through your gates weakens them (×N gate → ÷N)
        for (const g of this.gates) {
          const gg = g.g;
          if (prevS > gg.s && e.s <= gg.s && e.x >= gg.x0 && e.x <= gg.x1 && (gg.op === 'mul' || gg.op === 'div')) {
            const before = e.w;
            e.w = Math.max(gg.op === 'div' ? 1 : 0, Math.round(enemyThroughGate(e.w, gg.op, gg.v)));
            g.pulse = 0.12;
            if (e.w <= 0) {
              this.stats.kills += before;
              this.particles.emit(e.x, 0.6, -gg.s, 5, '#58b6ff', { speed: 3, up: 3, size: 0.12 });
            }
            if (this.gateFloatT <= 0) {
              this.overlay.float(gg.op === 'mul' ? `÷${gg.v}` : `×${gg.v}`, new THREE.Vector3(e.x, 1.6, -gg.s), gg.op === 'mul' ? 'good' : 'bad', 0.8);
              this.gateFloatT = 0.25;
            }
          }
        }
        // hedges block (and are chewed by) enemies too
        for (const h of this.hedges) {
          if (!h.broken && e.x > h.x0 && e.x < h.x1 && e.s < h.s1 && e.s > h.s0 - 0.5) {
            this.hitHedge(h, e.w, e.x);
            e.w = 0;
            break;
          }
        }
      }
      if (e.w > 0 && e.s <= 0.6) {
        this.base -= e.w;
        this.shake = Math.max(this.shake, 0.25);
        this.particles.emit(e.x, 0.6, -0.6, 6, '#ff4b5c', { speed: 3, up: 3 });
        this.overlay.float(`−${fmt(e.w)}`, new THREE.Vector3(e.x, 1.5, -1), 'bad');
        sfx.play('death');
        e.w = 0;
      }
      if (e.w <= 0) {
        E[i] = E[E.length - 1];
        E.pop();
      }
    }
  }

  private gateFloatT = 0;

  private collide(): void {
    const E = this.enemies;
    const P = this.players;
    if (!E.length || !P.length) return;
    const cell = 0.9;
    const key = (x: number, s: number) => (Math.floor((x + 20) / cell) << 10) | Math.floor(s / cell);
    const grid = new Map<number, number[]>();
    E.forEach((e, i) => {
      const k = key(e.x, e.s);
      let b = grid.get(k);
      if (!b) grid.set(k, (b = []));
      b.push(i);
    });
    let fx = 0;
    for (const p of P) {
      if (p.w <= 0) continue;
      const cx = Math.floor((p.x + 20) / cell);
      const cs = Math.floor(p.s / cell);
      for (let dx = -1; dx <= 1 && p.w > 0; dx++) for (let ds = -1; ds <= 1 && p.w > 0; ds++) {
        const b = grid.get(((cx + dx) << 10) | (cs + ds));
        if (!b) continue;
        for (const ei of b) {
          const e = E[ei];
          if (e.w <= 0 || Math.abs(e.s - p.s) > 0.7 || Math.abs(e.x - p.x) > 0.7) continue;
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
    this.players = P.filter((p) => p.w > 0);
    this.enemies = E.filter((e) => e.w > 0);
  }

  // ------------------------------------------------------------------

  private render(time: number, realDt: number, bay: number): void {
    const won = this.state === 'won';
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

    for (const g of this.gates) {
      if (g.pulse > 0) g.pulse -= realDt;
      g.mesh.scale.setScalar(1 + Math.max(0, g.pulse) * 0.8);
    }
    for (const h of this.hedges) {
      if (h.broken) continue;
      if (h.shake > 0) h.shake -= realDt;
      h.mesh.position.x = (h.x0 + h.x1) / 2 + (h.shake > 0 ? (Math.random() - 0.5) * 0.12 : 0);
      h.mesh.scale.y = 0.55 + 0.45 * Math.max(0, h.hp / h.max);
    }

    // aiming aids
    this.reticle.position.x = this.cannonX;
    const pulse = 1 + Math.sin(time * 6) * 0.08;
    this.reticle.getObjectByName('ring')!.scale.set(pulse, pulse, 1);
    this.reticle.rotation.y = time * 0.6;
    const b: Bay = this.lv.bays[bay];
    this.bayGlow.position.x += ((b.x0 + b.x1) / 2 - this.bayGlow.position.x) * Math.min(1, realDt * 18);
    this.bayGlow.scale.x = b.x1 - b.x0 - 0.3;
    this.chevrons.forEach((c, i) => {
      const k = (time * 1.4 + i / this.chevrons.length) % 1;
      c.position.set(this.cannonX, 0.05, -(2 + k * 5));
      (c.material as THREE.MeshBasicMaterial).opacity = 0.85 * (1 - k) * (this.state === 'play' ? 1 : 0);
    });
  }

  private labels(realDt: number): void {
    const L = ARENA.length;
    const frac = Math.max(0, this.castle) / this.lv.castleHP;
    this.fortressLabel.style.display = this.state === 'won' ? 'none' : '';
    this.overlay.place(this.fortressLabel, new THREE.Vector3(0, 5, -(L + 0.5)));
    this.fortressLabel.innerHTML = `<b>ENEMY FORTRESS</b><div class="bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></div><span>${fmt(Math.ceil(Math.max(0, this.castle)))}</span>`;
    this.overlay.place(this.baseLabel, new THREE.Vector3(this.cannonX, 2.6, 0));
    this.baseLabel.innerHTML = `❤ ${fmt(Math.max(0, Math.ceil(this.base)))}`;
    for (const h of this.hedges) {
      if (h.broken) continue;
      this.overlay.place(h.label, new THREE.Vector3((h.x0 + h.x1) / 2, 2.4, -(h.s0 + h.s1) / 2));
      h.label.textContent = `🌿 ${fmt(Math.max(0, Math.ceil(h.hp)))}`;
    }
    let tot = 0;
    for (const e of this.enemies) tot += e.w;
    if (tot > 0) {
      this.hordeLabel.style.display = '';
      this.overlay.place(this.hordeLabel, new THREE.Vector3(0, 2.2, -ARENA.funnel.mouthS));
      this.hordeLabel.textContent = `⚔ ${fmt(tot)}`;
    } else this.hordeLabel.style.display = 'none';
    this.gateFloatT -= realDt;
    // strength of whatever has broken through, shown over the front-most leaked enemy
    let leak = 0;
    let front: EUnit | null = null;
    for (const e of this.enemies) if (e.s < ARENA.gateZone[1] + 1) {
      leak += e.w;
      if (!front || e.s < front.s) front = e;
    }
    if (front) {
      this.leakLabel.style.display = '';
      this.overlay.place(this.leakLabel, new THREE.Vector3(front.x, 1.9, -front.s));
      this.leakLabel.textContent = `⚠ ${fmt(leak)}`;
    } else this.leakLabel.style.display = 'none';
    this.dmgT += realDt;
    if (this.dmgT > 0.35 && this.dmgAcc > 0) {
      this.overlay.float(`−${fmt(this.dmgAcc)}`, new THREE.Vector3((Math.random() - 0.5) * 6, 2.5, -(L - 0.5)), 'golden');
      this.dmgAcc = 0;
      this.dmgT = 0;
    }
  }

  dispose(): void {
    this.stage.scene.remove(this.root);
    this.root.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.geometry) m.geometry.dispose();
    });
    this.fortressLabel.remove();
    this.baseLabel.remove();
    this.hordeLabel.remove();
    this.leakLabel.remove();
    for (const h of this.hedges) h.label.remove();
  }
}
