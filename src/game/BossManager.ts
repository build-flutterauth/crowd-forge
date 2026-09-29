// Bosses: placeholder models, dramatic introductions, HP bars, and handing
// the fight to the CombatSystem. Boss power is chosen by the generator with
// bounded scaling (see GEN.bossBounds).
import * as THREE from 'three';
import { sfx, haptic } from '../audio/SoundSystem';
import { BOSSES } from '../config/genConfig';
import type { BossId, WorldOp } from '../core/types';
import { Crowd, spiralSlot } from '../render/Crowd';
import type { CameraRig, Overlay, Particles } from '../render/Effects';
import { unitGeometry } from '../render/UnitGeometry';
import { fmt } from '../sim/rules';
import type { ArmyManager } from './ArmyManager';
import type { CombatSystem } from './CombatSystem';

type BossOp = WorldOp & { kind: 'boss' };

function lm(color: string, emissive?: string): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: true });
  if (emissive) {
    m.emissive.set(emissive);
    m.emissiveIntensity = 1;
  }
  return m;
}

function add(p: THREE.Object3D, g: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sx = 1, sy = 1, sz = 1): THREE.Mesh {
  const o = new THREE.Mesh(g, m);
  o.position.set(x, y, z);
  o.scale.set(sx, sy, sz);
  p.add(o);
  return o;
}

const B = new THREE.BoxGeometry(1, 1, 1);
const S = new THREE.SphereGeometry(0.5, 12, 10);
const C = new THREE.CylinderGeometry(0.5, 0.5, 1, 12);
const K = new THREE.ConeGeometry(0.5, 1, 8);

function buildModel(id: BossId, scene: THREE.Scene): { root: THREE.Group; parts: THREE.Object3D[]; crowd?: Crowd } {
  const root = new THREE.Group();
  const def = BOSSES[id];
  const main = lm(def.color);
  const acc = lm(def.accent);
  const eye = lm('#ffffff', '#ffdd55');
  const parts: THREE.Object3D[] = [];
  switch (id) {
    case 'giant': {
      parts.push(add(root, C, main, 0, 2.6, 0, 2.6, 3.2, 2));
      parts.push(add(root, S, main, 0, 5, 0, 1.9, 1.9, 1.9));
      add(root, S, eye, -0.4, 5.2, 0.85, 0.3, 0.3, 0.2);
      add(root, S, eye, 0.4, 5.2, 0.85, 0.3, 0.3, 0.2);
      parts.push(add(root, B, main, -1.9, 3, 0, 0.8, 2.6, 0.8));
      parts.push(add(root, B, main, 1.9, 3, 0, 0.8, 2.6, 0.8));
      parts.push(add(root, C, acc, 2.2, 3.6, 1.2, 0.5, 3.4, 0.5));
      parts.push(add(root, B, acc, -0.7, 0.6, 0, 0.9, 1.2, 0.9));
      parts.push(add(root, B, acc, 0.7, 0.6, 0, 0.9, 1.2, 0.9));
      break;
    }
    case 'tank': {
      parts.push(add(root, B, main, 0, 1.2, 0, 5, 1.6, 6));
      parts.push(add(root, B, acc, -2.6, 0.7, 0, 0.9, 1.4, 6.4));
      parts.push(add(root, B, acc, 2.6, 0.7, 0, 0.9, 1.4, 6.4));
      const tur = add(root, B, main, 0, 2.5, -0.3, 3, 1.2, 3);
      parts.push(tur);
      const barrel = add(root, C, acc, 0, 2.5, 2.8, 0.5, 4, 0.5);
      barrel.rotation.x = Math.PI / 2;
      parts.push(barrel);
      break;
    }
    case 'castle': {
      parts.push(add(root, B, main, 0, 2.2, 0, 7, 4.4, 2));
      for (const x of [-3.6, 3.6]) {
        parts.push(add(root, C, main, x, 3, 0, 2.2, 6, 2.2));
        parts.push(add(root, K, acc, x, 6.8, 0, 2.6, 1.8, 2.6));
      }
      parts.push(add(root, B, acc, 0, 1.2, 1.05, 2, 2.4, 0.2));
      add(root, S, eye, -1, 3.4, 1.05, 0.5, 0.5, 0.2);
      add(root, S, eye, 1, 3.4, 1.05, 0.5, 0.5, 0.2);
      break;
    }
    case 'dragon': {
      parts.push(add(root, S, main, 0, 2.4, 0, 3.2, 2.6, 4.6));
      const neck = add(root, C, main, 0, 3.8, 2, 0.9, 2.6, 0.9);
      neck.rotation.x = 0.6;
      parts.push(neck);
      parts.push(add(root, B, main, 0, 5, 3, 1.4, 1.1, 2));
      add(root, S, eye, -0.45, 5.3, 3.9, 0.25, 0.25, 0.2);
      add(root, S, eye, 0.45, 5.3, 3.9, 0.25, 0.25, 0.2);
      for (const sd of [-1, 1]) {
        const w = add(root, B, acc, sd * 3, 3.6, -0.5, 4, 0.12, 2.6);
        w.rotation.z = sd * 0.35;
        w.name = 'wing';
        parts.push(w);
      }
      const tail = add(root, K, main, 0, 1.6, -3.4, 1.2, 3.6, 1.2);
      tail.rotation.x = -Math.PI / 2;
      parts.push(tail);
      break;
    }
    case 'robot': {
      parts.push(add(root, B, main, 0, 3, 0, 3.4, 3.2, 2.2));
      parts.push(add(root, B, main, 0, 5.3, 0, 2, 1.4, 1.8));
      add(root, B, lm('#111', '#00d2ff'), 0, 5.35, 0.92, 1.5, 0.3, 0.1);
      parts.push(add(root, B, acc, -2.3, 3.2, 0, 0.9, 3, 0.9));
      parts.push(add(root, B, acc, 2.3, 3.2, 0, 0.9, 3, 0.9));
      parts.push(add(root, B, main, -0.8, 0.8, 0, 1, 1.6, 1));
      parts.push(add(root, B, main, 0.8, 0.8, 0, 1, 1.6, 1));
      parts.push(add(root, C, lm('#333', '#00d2ff'), 0, 6.4, 0, 0.1, 1, 0.1));
      break;
    }
    case 'megaArmy': {
      const crowd = new Crowd(scene, unitGeometry('brute'), def.color, 220, Math.PI);
      crowd.running = false;
      const s = { x: 0, z: 0 };
      for (let i = 0; i < 220; i++) {
        spiralSlot(i, 0.34, s);
        crowd.spawn(s.x * 1.4, -s.z - 3, -1);
      }
      parts.push(add(root, C, acc, 0, 3, -2, 1.6, 6, 1.6));
      parts.push(add(root, S, lm(def.color), 0, 6.6, -2, 1.8, 1.8, 1.8));
      return { root, parts, crowd };
    }
  }
  return { root, parts };
}

interface BossEntry {
  op: BossOp;
  model: ReturnType<typeof buildModel> | null;
  hp: HTMLDivElement | null;
  state: 'wait' | 'intro' | 'ready' | 'fight' | 'dead';
  remaining: number;
  introT: number;
  flash: number;
}

export class BossManager {
  entries: BossEntry[] = [];
  private scene: THREE.Scene;
  private overlay: Overlay;
  private particles: Particles;
  private cam: CameraRig;
  onIntro: (title: string) => void = () => {};
  onIntroEnd: () => void = () => {};
  onDefeated: (op: BossOp) => void = () => {};

  constructor(scene: THREE.Scene, overlay: Overlay, particles: Particles, cam: CameraRig) {
    this.scene = scene;
    this.overlay = overlay;
    this.particles = particles;
    this.cam = cam;
  }

  add(op: WorldOp): void {
    if (op.kind !== 'boss') return;
    this.entries.push({ op, model: null, hp: null, state: 'wait', remaining: op.power, introT: 0, flash: 0 });
  }

  clear(): void {
    for (const e of this.entries) this.dispose(e);
    this.entries = [];
  }

  private dispose(e: BossEntry): void {
    if (e.model) {
      this.scene.remove(e.model.root);
      e.model.crowd?.dispose();
    }
    e.model = null;
    e.hp?.remove();
    e.hp = null;
  }

  get introActive(): boolean {
    return this.entries.some((e) => e.state === 'intro');
  }

  update(dt: number, realDt: number, time: number, army: ArmyManager, combat: CombatSystem): void {
    for (const e of this.entries) {
      const o = e.op;
      const ahead = o.s - army.s;
      if (!e.model && e.state !== 'dead' && ahead < 180) {
        e.model = buildModel(o.boss, this.scene);
        e.model.root.position.set(0, 0, -(o.s + 3.5));
        this.scene.add(e.model.root);
        e.hp = this.overlay.label('boss-hp');
      }
      if (!e.model) continue;
      const m = e.model;
      if (e.state === 'dead') continue;

      // idle / fight animation
      const fight = e.state === 'fight';
      m.root.position.y = fight ? Math.abs(Math.sin(time * 9)) * 0.25 : Math.sin(time * 2) * 0.1;
      m.root.rotation.y = Math.sin(time * (fight ? 7 : 1.2)) * (fight ? 0.08 : 0.05);
      m.parts.forEach((p) => {
        if (p.name === 'wing') p.rotation.x = Math.sin(time * 5) * 0.4;
      });
      if (m.crowd) {
        const want = Math.max(fight ? 0 : 1, Math.ceil(220 * (e.remaining / o.power)));
        while (m.crowd.units.length > want) {
          const i = m.crowd.extremeIndex(1);
          const u = m.crowd.units[i];
          this.particles.emit(u.x, 0.4, u.z, 3, BOSSES.megaArmy.color, { speed: 3, up: 3, size: 0.12 });
          m.crowd.removeAt(i);
        }
        m.crowd.running = fight;
        m.crowd.update(dt, time);
        m.crowd.units.forEach((u) => (u.tz = Math.max(u.z, -(army.front + 1))));
      }
      if (e.flash > 0) {
        e.flash -= dt;
        m.root.scale.setScalar(1 + e.flash * 0.3);
      } else m.root.scale.setScalar(1);

      if (e.hp) e.hp.style.visibility = ahead < 60 && e.state !== 'intro' ? '' : 'hidden';
      if (e.hp) {
        const top = new THREE.Vector3(0, o.boss === 'castle' ? 8.5 : 7.5, -(o.s + 3.5));
        this.overlay.place(e.hp, top);
        const frac = e.remaining / o.power;
        e.hp.innerHTML = `<b>${BOSSES[o.boss].title}</b><div class="bar"><i style="width:${(frac * 100).toFixed(1)}%"></i></div><span>${fmt(Math.ceil(e.remaining))}</span>`;
      }

      // dramatic introduction
      if (e.state === 'wait' && ahead < 42) {
        e.state = 'intro';
        e.introT = 0;
        sfx.play('bossIntro');
        haptic(80);
        this.cam.shake(0.5, 0.8);
        this.onIntro(BOSSES[o.boss].title);
      }
      if (e.state === 'intro') {
        e.introT += realDt;
        const k = Math.min(1, e.introT * 1.6) * (e.introT < 1.5 ? 1 : Math.max(0, 1 - (e.introT - 1.5) * 2.2));
        this.cam.focus.set(0, 3, -(o.s + 3.5));
        this.cam.focusBlend = k * k * (3 - 2 * k);
        if (e.introT > 0.35 && e.introT < 1.3 && Math.random() < realDt * 6) {
          m.root.scale.setScalar(1.12);
          this.cam.shake(0.3, 0.15);
        }
        if (Math.random() < realDt * 8) this.particles.emit((Math.random() - 0.5) * 6, 0.2, -(o.s + 1), 4, '#9a8f80', { speed: 4, up: 2 });
        if (e.introT > 2) {
          e.state = 'ready';
          this.cam.focusBlend = 0;
          this.onIntroEnd();
        }
      }

      if (e.state === 'ready' && !combat.fighting && army.front >= o.s && army.n > 0) {
        e.state = 'fight';
        const start = e.remaining;
        let slam = 0;
        combat.start(army, {
          kind: 'boss',
          power: start,
          contactS: o.s,
          x: 0,
          color: BOSSES[o.boss].color,
          onProgress: (rem, pdt) => {
            e.remaining = start * rem;
            slam += pdt;
            if (slam > 0.55) {
              slam = 0;
              e.flash = 0.25;
              this.cam.shake(0.35, 0.2);
              sfx.play('bossHit');
              this.particles.emit((Math.random() - 0.5) * 4, 2 + Math.random() * 3, -(o.s + 1.5), 14, BOSSES[o.boss].accent, { speed: 6, up: 5, size: 0.2 });
            }
          },
          onEnd: (won) => {
            if (won) {
              e.state = 'dead';
              e.remaining = 0;
              this.explode(e);
              this.onDefeated(o);
            } else e.state = 'ready';
          },
        });
      }
    }
  }

  private explode(e: BossEntry): void {
    const o = e.op;
    sfx.play('bossDown');
    haptic(150);
    this.cam.shake(1.1, 0.9);
    const z = -(o.s + 3.5);
    for (let k = 0; k < 6; k++) {
      this.particles.emit((Math.random() - 0.5) * 5, 1 + Math.random() * 5, z + (Math.random() - 0.5) * 3, 40, k % 2 ? BOSSES[o.boss].color : BOSSES[o.boss].accent, { speed: 9, up: 8, size: 0.35, life: 1.4 });
    }
    this.particles.emit(0, 3, z, 80, '#ffd23f', { speed: 12, up: 6, size: 0.18, life: 1.2 });
    this.overlay.float('BOSS DEFEATED!', new THREE.Vector3(0, 5, z), 'golden huge', 2);
    this.dispose(e);
  }
}
