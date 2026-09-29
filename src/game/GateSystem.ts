// Gates and recruit pickups: visuals, selection by steering, applying the
// shared rules, and measuring decision quality / reaction time for the director.
import * as THREE from 'three';
import { sfx, haptic } from '../audio/SoundSystem';
import { GAME } from '../config/gameConfig';
import type { GateSpec, WorldOp } from '../core/types';
import { Crowd, spiralSlot } from '../render/Crowd';
import type { Overlay, Particles } from '../render/Effects';
import { unitGeometry } from '../render/UnitGeometry';
import { applyGate, applySplitRow, cloneArmy, fmt, gateLabel, gateTone, type GateTone } from '../sim/rules';
import type { ArmyManager } from './ArmyManager';

const TONE: Record<GateTone, { fill: string; edge: string; text: string }> = {
  good: { fill: 'rgba(40,150,255,0.62)', edge: '#8fd0ff', text: '#ffffff' },
  bad: { fill: 'rgba(255,60,80,0.62)', edge: '#ffa0aa', text: '#ffffff' },
  special: { fill: 'rgba(150,80,255,0.62)', edge: '#d4b5ff', text: '#ffffff' },
  golden: { fill: 'rgba(255,200,40,0.78)', edge: '#fff2b0', text: '#5a3b00' },
};

export interface GateEvent {
  gate: GateSpec;
  before: number;
  after: number;
  quality: number; // 0..1 chosen vs best
  options: number;
  reaction: number;
  s: number;
}

interface GateRow {
  s: number;
  stage: number;
  opts: WorldOp[];
  group: THREE.Group | null;
  panels: THREE.Mesh[];
  done: boolean;
  fade: number;
  chosen: number[];
  t0: number;
  lastChange: number;
  lane: number;
}

interface Pickup {
  op: WorldOp & { kind: 'pickup' };
  crowd: Crowd | null;
  cage: THREE.Group | null;
  label: HTMLDivElement | null;
  done: boolean;
}

export function panelTexture(g: GateSpec): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 256;
  c.height = 192;
  const x = c.getContext('2d')!;
  const tone = TONE[gateTone(g)];
  x.fillStyle = tone.fill;
  x.fillRect(0, 0, 256, 192);
  x.strokeStyle = tone.edge;
  x.lineWidth = 10;
  x.strokeRect(5, 5, 246, 182);
  const { main, sub } = gateLabel(g);
  x.fillStyle = tone.text;
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  const size = main.length <= 4 ? 96 : main.length <= 6 ? 70 : 48;
  x.font = `900 ${size}px system-ui, -apple-system, "Segoe UI", sans-serif`;
  x.shadowColor = 'rgba(0,0,0,0.35)';
  x.shadowBlur = 6;
  x.fillText(main, 128, sub ? 84 : 98);
  if (sub) {
    x.font = '800 26px system-ui, -apple-system, "Segoe UI", sans-serif';
    x.fillText(sub.toUpperCase(), 128, 154);
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 4;
  return t;
}

const postMat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
const postGeo = new THREE.BoxGeometry(0.22, 3.2, 0.22);
const cageMat = new THREE.MeshLambertMaterial({ color: '#8a8f99' });

export class GateSystem {
  rows: GateRow[] = [];
  pickups: Pickup[] = [];
  private scene: THREE.Scene;
  private overlay: Overlay;
  private particles: Particles;
  private neutralGeo = unitGeometry('neutral');
  onGate: (e: GateEvent) => void = () => {};
  onBigGain: (ratio: number) => void = () => {};
  onBoost: () => void = () => {};
  onPickup: (n: number) => void = () => {};

  constructor(scene: THREE.Scene, overlay: Overlay, particles: Particles) {
    this.scene = scene;
    this.overlay = overlay;
    this.particles = particles;
  }

  add(op: WorldOp): void {
    if (op.kind === 'gate') {
      let row = this.rows.find((r) => r.stage === op.stage && Math.abs(r.s - op.s) < 0.01);
      if (!row) {
        row = { s: op.s, stage: op.stage, opts: [], group: null, panels: [], done: false, fade: 0, chosen: [], t0: -1, lastChange: -1, lane: -1 };
        this.rows.push(row);
        this.rows.sort((a, b) => a.s - b.s);
      }
      row.opts.push(op);
      row.opts.sort((a, b) => a.x0 - b.x0);
    } else if (op.kind === 'pickup') {
      this.pickups.push({ op, crowd: null, cage: null, label: null, done: false });
    }
  }

  clear(): void {
    for (const r of this.rows) this.disposeRow(r);
    for (const p of this.pickups) this.disposePickup(p);
    this.rows = [];
    this.pickups = [];
  }

  private buildRow(r: GateRow): void {
    const g = new THREE.Group();
    g.position.z = -r.s;
    const edges = new Set<number>();
    for (const o of r.opts) {
      if (o.kind !== 'gate') continue;
      const w = o.x1 - o.x0;
      const mat = new THREE.MeshBasicMaterial({ map: panelTexture(o.gate), transparent: true, side: THREE.DoubleSide, depthWrite: false });
      const p = new THREE.Mesh(new THREE.PlaneGeometry(w - 0.25, 2.5), mat);
      p.position.set((o.x0 + o.x1) / 2, 1.55, 0);
      g.add(p);
      r.panels.push(p);
      edges.add(o.x0);
      edges.add(o.x1);
    }
    for (const e of edges) {
      const post = new THREE.Mesh(postGeo, postMat);
      post.position.set(e, 1.6, 0);
      g.add(post);
    }
    this.scene.add(g);
    r.group = g;
  }

  private disposeRow(r: GateRow): void {
    if (!r.group) return;
    this.scene.remove(r.group);
    for (const p of r.panels) {
      const m = p.material as THREE.MeshBasicMaterial;
      m.map?.dispose();
      m.dispose();
      p.geometry.dispose();
    }
    r.group = null;
    r.panels = [];
  }

  private buildPickup(p: Pickup): void {
    const o = p.op;
    const cx = (o.x0 + o.x1) / 2;
    const visible = Math.min(o.n, 60);
    const crowd = new Crowd(this.scene, this.neutralGeo, o.style === 'cage' ? '#f0c24a' : '#b8bec8', Math.max(1, visible), Math.PI);
    crowd.running = false;
    const slot = { x: 0, z: 0 };
    for (let i = 0; i < visible; i++) {
      spiralSlot(i, 0.26, slot);
      crowd.spawn(cx + slot.x, -o.s - 1.2 + slot.z, -1);
    }
    crowd.commit(0);
    p.crowd = crowd;
    if (o.style === 'cage') {
      const cage = new THREE.Group();
      const r = Math.min(1.5, 0.3 + 0.26 * Math.sqrt(visible));
      for (let k = 0; k < 10; k++) {
        const a = (k / 10) * Math.PI * 2;
        const bar = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 1.6, 4), cageMat);
        bar.position.set(cx + Math.cos(a) * r, 0.8, -o.s - 1.2 + Math.sin(a) * r);
        cage.add(bar);
      }
      const top = new THREE.Mesh(new THREE.CylinderGeometry(r + 0.1, r + 0.1, 0.12, 12), cageMat);
      top.position.set(cx, 1.6, -o.s - 1.2);
      cage.add(top);
      this.scene.add(cage);
      p.cage = cage;
    }
    p.label = this.overlay.label('pickup-count');
    p.label.textContent = '+' + fmt(o.n);
  }

  private disposePickup(p: Pickup): void {
    p.crowd?.dispose();
    p.crowd = null;
    if (p.cage) this.scene.remove(p.cage);
    p.cage = null;
    p.label?.remove();
    p.label = null;
  }

  update(dt: number, time: number, army: ArmyManager): void {
    const HW = GAME.track.halfWidth;
    for (const r of this.rows) {
      const ahead = r.s - army.s;
      if (!r.group && ahead < 190 && ahead > -30) this.buildRow(r);
      if (r.group && ahead < -30) this.disposeRow(r);
      if (!r.group) continue;

      if (!r.done) {
        // reaction-time tracking
        const lane = r.opts.findIndex((o) => army.x >= o.x0 - 1e-6 && army.x < o.x1 + (o.x1 >= HW ? 1 : 0));
        if (ahead < 45) {
          if (r.t0 < 0) {
            r.t0 = time;
            r.lastChange = time;
            r.lane = lane;
          } else if (lane !== r.lane) {
            r.lane = lane;
            r.lastChange = time;
          }
        }
        // highlight the panel the army is heading into
        r.panels.forEach((p, i) => {
          const m = p.material as THREE.MeshBasicMaterial;
          const hot = i === lane || (army.state.split && (i === 0 || i === r.panels.length - 1));
          const s = hot && ahead < 40 ? 1.06 + Math.sin(time * 10) * 0.02 : 1;
          p.scale.setScalar(s);
          m.opacity = hot || ahead > 40 ? 1 : 0.8;
        });
        if (army.front >= r.s) this.trigger(r, army, time, lane);
      } else if (r.fade < 1) {
        r.fade = Math.min(1, r.fade + dt * 2.5);
        r.panels.forEach((p, i) => {
          const m = p.material as THREE.MeshBasicMaterial;
          if (r.chosen.includes(i)) {
            p.scale.setScalar(1 + r.fade * 0.6);
            p.position.y = 1.55 + r.fade * 1.2;
          }
          m.opacity = 1 - r.fade;
        });
      }
    }

    for (const p of this.pickups) {
      const o = p.op;
      const ahead = o.s - army.s;
      if (!p.crowd && !p.done && ahead < 170) this.buildPickup(p);
      if (p.crowd && ahead < -25) this.disposePickup(p);
      if (!p.crowd) continue;
      if (p.label) this.overlay.place(p.label, new THREE.Vector3((o.x0 + o.x1) / 2, 1.6, -o.s - 1.2));
      if (!p.done) {
        p.crowd.commit(time);
        const reach = army.front >= o.s - 1.2 && army.front <= o.s + 2;
        const inLane = army.x >= o.x0 - 0.35 && army.x <= o.x1 + 0.35;
        if (reach && inLane) {
          p.done = true;
          const before = army.n;
          army.state.n += o.n;
          army.state.lastGain = o.n;
          army.spawnFrom = { x: (o.x0 + o.x1) / 2, s: o.s + 1.2 };
          this.onPickup(o.n);
          this.onGate({ gate: { op: 'add', v: o.n }, before, after: army.n, quality: 1, options: 1, reaction: 0, s: o.s });
          this.overlay.float('+' + fmt(o.n), new THREE.Vector3((o.x0 + o.x1) / 2, 1.5, -o.s), 'good');
          sfx.play('pickup');
          if (p.cage) {
            this.particles.emit((o.x0 + o.x1) / 2, 1, -o.s - 1.2, 30, '#c9ccd4', { speed: 5, up: 5 });
            this.scene.remove(p.cage);
            p.cage = null;
          }
          p.crowd.clear();
          p.label?.remove();
          p.label = null;
        }
      }
    }
  }

  private trigger(r: GateRow, army: ArmyManager, time: number, lane: number): void {
    r.done = true;
    const st = army.state;
    const before = st.n;
    const opts = r.opts.filter((o): o is WorldOp & { kind: 'gate' } => o.kind === 'gate');
    const reaction = r.t0 >= 0 ? Math.max(0, r.lastChange - r.t0) : 0;

    // choice quality: compare every option's outcome from the current army
    const outcomes = opts.map((o) => {
      const t = cloneArmy(st);
      applyGate(t, o.gate, 'expected');
      return t.dead ? 0 : t.n + (t.dbl ? t.n * 0.4 : 0) + t.shield * 0.5;
    });
    const best = Math.max(...outcomes);

    let gate: GateSpec;
    let pos: THREE.Vector3;
    if (st.split && opts.length >= 2) {
      const L = opts[0].gate;
      const R = opts[opts.length - 1].gate;
      applySplitRow(st, L, R, 'actual');
      r.chosen = [0, opts.length - 1];
      gate = { op: 'add', v: st.n - before };
      pos = new THREE.Vector3(0, 2, -r.s);
      this.overlay.float(`SPLIT → ${fmt(st.n)}`, pos, 'special big');
      sfx.play('gateSpecial');
    } else {
      const idx = Math.max(0, lane < 0 ? (army.x < 0 ? 0 : opts.length - 1) : Math.min(lane, opts.length - 1));
      const o = opts[idx];
      r.chosen = [idx];
      gate = o.gate;
      pos = new THREE.Vector3((o.x0 + o.x1) / 2, 2.2, -r.s);
      applyGate(st, gate, 'actual');
      this.feedback(gate, before, st.n, pos, army);
    }
    if (st.dead && army.invincible) {
      st.dead = false;
      st.n = Math.max(1, st.n);
    }
    const tone = gateTone(gate);
    this.particles.emit(pos.x, 1.5, pos.z, 26, tone === 'bad' ? '#ff5566' : tone === 'golden' ? '#ffd23f' : tone === 'special' ? '#b58cff' : '#58b6ff', { speed: 5, up: 5, size: 0.16 });
    if (st.n > before) army.spawnFrom = { x: pos.x, s: r.s };
    const chosenOutcome = outcomes[r.chosen[0]] ?? 0;
    this.onGate({ gate, before, after: st.n, quality: opts.length > 1 && best > 0 ? chosenOutcome / best : 1, options: opts.length, reaction, s: r.s });
    if (before > 0 && st.n / before >= GAME.feel.bigGainRatio && st.n - before >= 40) this.onBigGain(st.n / before);
    if (gate.op === 'speed') this.onBoost();
    void time;
  }

  private feedback(g: GateSpec, before: number, after: number, pos: THREE.Vector3, army: ArmyManager): void {
    const d = after - before;
    const tone = gateTone(g);
    let text = `${d >= 0 ? '+' : ''}${fmt(d)}`;
    let cls = d >= 0 ? 'good' : 'bad';
    switch (g.op) {
      case 'mul': text = `×${g.v} → ${fmt(after)}`; cls = 'good big'; break;
      case 'div': text = `÷${g.v} → ${fmt(after)}`; break;
      case 'mystery': {
        const h = g.hidden ? gateLabel(g.hidden).main : '?';
        text = `? = ${h}  (${d >= 0 ? '+' : ''}${fmt(d)})`;
        cls = d >= 0 ? 'good big' : 'bad big';
        break;
      }
      case 'bet': text = d >= 0 ? `JACKPOT! +${fmt(d)}` : `BUST! −${fmt(-d)}`; cls = d >= 0 ? 'golden big' : 'bad big'; break;
      case 'shield': text = `SHIELD ${fmt(army.state.shield)}`; cls = 'special'; break;
      case 'speed': text = 'CHARGE!'; cls = 'special'; break;
      case 'doubleNext': text = 'NEXT GATE ×2'; cls = 'special'; break;
      case 'split': text = 'SPLIT!'; cls = 'special big'; break;
      case 'sacrifice': text = `−${fmt(-d)} → VAULT ${fmt(army.state.bank)}`; cls = 'special'; break;
      case 'vault': text = d > 0 ? `VAULT +${fmt(d)}` : 'VAULT EMPTY'; cls = d > 0 ? 'golden big' : 'bad'; break;
      case 'clone': text = `CLONE +${fmt(d)}`; cls = 'good big'; break;
    }
    if (g.golden) cls = 'golden big';
    this.overlay.float(text, pos, cls, 1.3);
    if (tone === 'golden') sfx.play('gateGolden');
    else if (d < 0 || tone === 'bad') {
      sfx.play('gateBad');
      haptic(40);
    } else if (tone === 'special' && g.op !== 'mystery') sfx.play('gateSpecial');
    else sfx.play('gateGood', Math.min(1.6, 1 + Math.log10(Math.max(1, after / Math.max(1, before))) * 0.5));
  }

  /** Next unresolved gate row ahead (for debug/lookahead) */
  nextRow(s: number): GateRow | undefined {
    return this.rows.find((r) => !r.done && r.s > s);
  }
}
