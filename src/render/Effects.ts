// Game-feel toolkit: pooled particles, floating numbers, world-anchored DOM
// labels, banners and a camera rig with shake / zoom / slow-motion support.
import * as THREE from 'three';
import { GAME } from '../config/gameConfig';
import type { Stage3D } from './Stage3D';

const MAX_P = 1400;
const tmpC = new THREE.Color();

export class Particles {
  private mesh: THREE.InstancedMesh;
  private pos = new Float32Array(MAX_P * 3);
  private vel = new Float32Array(MAX_P * 3);
  private life = new Float32Array(MAX_P);
  private maxLife = new Float32Array(MAX_P);
  private size = new Float32Array(MAX_P);
  private grav = new Float32Array(MAX_P);
  private spin = new Float32Array(MAX_P);
  private next = 0;
  private alive = 0;

  constructor(scene: THREE.Scene) {
    const mat = new THREE.MeshBasicMaterial({ color: 0xffffff });
    this.mesh = new THREE.InstancedMesh(new THREE.BoxGeometry(1, 1, 1), mat, MAX_P);
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    for (let i = 0; i < MAX_P; i++) this.mesh.setColorAt(i, tmpC.set(0xffffff));
    this.mesh.count = MAX_P;
    scene.add(this.mesh);
  }

  emit(x: number, y: number, z: number, n: number, color: string | THREE.Color, o: { speed?: number; up?: number; life?: number; size?: number; gravity?: number; spread?: number } = {}): void {
    const speed = o.speed ?? 4;
    const up = o.up ?? 4;
    const life = o.life ?? 0.7;
    const size = o.size ?? 0.14;
    const gravity = o.gravity ?? 14;
    const spread = o.spread ?? 0.3;
    if (typeof color === 'string') tmpC.set(color);
    else tmpC.copy(color);
    for (let k = 0; k < n; k++) {
      const i = this.next;
      this.next = (this.next + 1) % MAX_P;
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.4 + Math.random() * 0.8);
      this.pos[i * 3] = x + (Math.random() - 0.5) * spread;
      this.pos[i * 3 + 1] = y + Math.random() * spread;
      this.pos[i * 3 + 2] = z + (Math.random() - 0.5) * spread;
      this.vel[i * 3] = Math.cos(a) * sp;
      this.vel[i * 3 + 1] = up * (0.5 + Math.random());
      this.vel[i * 3 + 2] = Math.sin(a) * sp;
      this.life[i] = this.maxLife[i] = life * (0.6 + Math.random() * 0.8);
      this.size[i] = size * (0.6 + Math.random() * 0.8);
      this.grav[i] = gravity;
      this.spin[i] = Math.random() * 6;
      this.mesh.setColorAt(i, tmpC);
    }
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
    this.alive = MAX_P;
  }

  update(dt: number): void {
    if (!this.alive) return;
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    let any = 0;
    for (let i = 0; i < MAX_P; i++) {
      const o = i * 16;
      if (this.life[i] <= 0) {
        arr[o] = arr[o + 5] = arr[o + 10] = 0;
        continue;
      }
      any++;
      this.life[i] -= dt;
      const j = i * 3;
      this.vel[j + 1] -= this.grav[i] * dt;
      this.pos[j] += this.vel[j] * dt;
      this.pos[j + 1] += this.vel[j + 1] * dt;
      this.pos[j + 2] += this.vel[j + 2] * dt;
      if (this.pos[j + 1] < 0.05) {
        this.pos[j + 1] = 0.05;
        this.vel[j + 1] *= -0.3;
        this.vel[j] *= 0.7;
        this.vel[j + 2] *= 0.7;
      }
      const s = this.size[i] * Math.max(0, this.life[i] / this.maxLife[i]);
      const r = this.spin[i] + this.life[i] * 5;
      const c = Math.cos(r) * s;
      const sn = Math.sin(r) * s;
      arr[o] = c; arr[o + 1] = sn; arr[o + 2] = 0; arr[o + 3] = 0;
      arr[o + 4] = -sn; arr[o + 5] = c; arr[o + 6] = 0; arr[o + 7] = 0;
      arr[o + 8] = 0; arr[o + 9] = 0; arr[o + 10] = s; arr[o + 11] = 0;
      arr[o + 12] = this.pos[j]; arr[o + 13] = this.pos[j + 1]; arr[o + 14] = this.pos[j + 2]; arr[o + 15] = 1;
    }
    this.alive = any;
    this.mesh.instanceMatrix.needsUpdate = true;
  }
}

// ------------------------------------------------------------------
// DOM overlays
// ------------------------------------------------------------------

interface Floater {
  el: HTMLDivElement;
  pos: THREE.Vector3;
  t: number;
  life: number;
}

export class Overlay {
  readonly root: HTMLDivElement;
  private stage: Stage3D;
  private floaters: Floater[] = [];
  private pt = { x: 0, y: 0 };

  constructor(stage: Stage3D, root: HTMLDivElement) {
    this.stage = stage;
    this.root = root;
  }

  float(text: string, pos: THREE.Vector3, cls = '', life = 1.1): void {
    const el = document.createElement('div');
    el.className = 'floater ' + cls;
    el.textContent = text;
    this.root.appendChild(el);
    this.floaters.push({ el, pos: pos.clone(), t: 0, life });
    if (this.floaters.length > 40) this.kill(0);
  }

  private kill(i: number): void {
    this.floaters[i].el.remove();
    this.floaters.splice(i, 1);
  }

  label(cls: string): HTMLDivElement {
    const el = document.createElement('div');
    el.className = 'wlabel ' + cls;
    this.root.appendChild(el);
    return el;
  }

  place(el: HTMLElement, pos: THREE.Vector3): boolean {
    const ok = this.stage.project(pos, this.pt);
    if (!ok) {
      el.style.display = 'none';
      return false;
    }
    el.style.display = '';
    el.style.transform = `translate(${this.pt.x.toFixed(1)}px, ${this.pt.y.toFixed(1)}px) translate(-50%, -100%)`;
    return true;
  }

  update(dt: number): void {
    for (let i = this.floaters.length - 1; i >= 0; i--) {
      const f = this.floaters[i];
      f.t += dt;
      if (f.t >= f.life) {
        this.kill(i);
        continue;
      }
      const k = f.t / f.life;
      if (!this.stage.project(f.pos, this.pt)) continue;
      const y = this.pt.y - 20 - k * 70;
      const sc = k < 0.15 ? 0.6 + (k / 0.15) * 0.6 : 1.2 - (k - 0.15) * 0.3;
      f.el.style.transform = `translate(${this.pt.x}px, ${y}px) translate(-50%, -50%) scale(${sc.toFixed(3)})`;
      f.el.style.opacity = String(k > 0.7 ? 1 - (k - 0.7) / 0.3 : 1);
    }
  }

  clearFloaters(): void {
    while (this.floaters.length) this.kill(0);
  }
}

// ------------------------------------------------------------------
// Camera
// ------------------------------------------------------------------

export class CameraRig {
  private stage: Stage3D;
  private pos = new THREE.Vector3(0, 10, 12);
  private look = new THREE.Vector3();
  private shakeT = 0;
  private shakeAmp = 0;
  zoom = 0;
  targetZoom = 0;
  /** extra offsets for cinematic moments */
  orbit = 0;
  closeup = 0;
  /** cinematic focus point (e.g. a boss) and how strongly to frame it (0..1) */
  focus = new THREE.Vector3();
  focusBlend = 0;

  constructor(stage: Stage3D) {
    this.stage = stage;
  }

  shake(amp: number, dur = 0.35): void {
    this.shakeAmp = Math.max(this.shakeAmp, amp);
    this.shakeT = Math.max(this.shakeT, dur);
  }

  snap(x: number, z: number): void {
    this.update(10, x, z, true);
  }

  update(dt: number, x: number, z: number, instant = false): void {
    const c = GAME.camera;
    this.zoom += (this.targetZoom - this.zoom) * Math.min(1, dt * 2.5);
    const zoom = this.zoom * (1 - this.closeup * 0.6);
    const h = c.height + zoom * 0.75 - this.closeup * 2;
    const d = c.distance + zoom;
    const ox = Math.sin(this.orbit) * d;
    const oz = Math.cos(this.orbit) * d;
    const target = new THREE.Vector3(x * 0.55 + ox, h, z + oz);
    const lookT = new THREE.Vector3(x * 0.65, 0.5, z - c.lookAhead * (1 - this.closeup * 0.5) * Math.cos(this.orbit));
    if (this.focusBlend > 0.001) {
      const f = this.focusBlend;
      const fpos = new THREE.Vector3(this.focus.x + 7, this.focus.y + 4, this.focus.z + 17);
      target.lerp(fpos, f);
      lookT.lerp(this.focus, f);
    }
    if (instant) {
      this.pos.copy(target);
      this.look.copy(lookT);
    } else {
      const k = 1 - Math.exp(-dt * 6);
      this.pos.lerp(target, k);
      this.look.lerp(lookT, 1 - Math.exp(-dt * 8));
    }
    const cam = this.stage.camera;
    cam.position.copy(this.pos);
    if (this.shakeT > 0) {
      this.shakeT -= dt;
      const a = this.shakeAmp * Math.min(1, this.shakeT * 4);
      cam.position.x += (Math.random() - 0.5) * a;
      cam.position.y += (Math.random() - 0.5) * a;
      if (this.shakeT <= 0) this.shakeAmp = 0;
    }
    cam.lookAt(this.look);
  }

  get position(): THREE.Vector3 {
    return this.stage.camera.position;
  }
}
