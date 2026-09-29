// A crowd of units drawn as a single InstancedMesh (plus an optional weapon
// mesh). Units ease toward formation slots, pop in when spawned and bob as
// they run. Used for the player army, enemy groups and neutral recruits.
import * as THREE from 'three';

export interface Unit {
  x: number;
  z: number;
  y: number;
  tx: number;
  tz: number;
  born: number;
  phase: number;
  hitCd: number;
  dying: number; // >0 = death animation remaining
  sc?: number; // per-unit scale multiplier
}

const tmpColor = new THREE.Color();

function easeOutBack(t: number): number {
  const c1 = 1.9;
  const c3 = c1 + 1;
  return 1 + c3 * Math.pow(t - 1, 3) + c1 * Math.pow(t - 1, 2);
}

export class Crowd {
  readonly mesh: THREE.InstancedMesh;
  weapon: THREE.InstancedMesh | null = null;
  units: Unit[] = [];
  readonly cap: number;
  facing: number;
  running = true;
  unitScale = 1;
  follow = 12; // how quickly units reach their slot
  private parent: THREE.Object3D;
  private material: THREE.MeshLambertMaterial;

  constructor(parent: THREE.Object3D, geo: THREE.BufferGeometry, color: string, cap: number, facing = 0) {
    this.parent = parent;
    this.cap = cap;
    this.facing = facing;
    this.material = new THREE.MeshLambertMaterial({ vertexColors: true });
    this.mesh = new THREE.InstancedMesh(geo, this.material, cap);
    this.mesh.count = 0;
    this.mesh.frustumCulled = false;
    this.mesh.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
    tmpColor.set(color);
    for (let i = 0; i < cap; i++) this.mesh.setColorAt(i, tmpColor);
    parent.add(this.mesh);
  }

  get count(): number {
    return this.units.length;
  }

  setColor(color: string): void {
    tmpColor.set(color);
    for (let i = 0; i < this.cap; i++) this.mesh.setColorAt(i, tmpColor);
    if (this.mesh.instanceColor) this.mesh.instanceColor.needsUpdate = true;
  }

  setGeometry(geo: THREE.BufferGeometry): void {
    this.mesh.geometry = geo;
  }

  setWeapon(geo: THREE.BufferGeometry | null, color = '#ccc'): void {
    if (this.weapon) {
      this.parent.remove(this.weapon);
      (this.weapon.material as THREE.Material).dispose();
      this.weapon = null;
    }
    if (!geo) return;
    this.weapon = new THREE.InstancedMesh(geo, new THREE.MeshLambertMaterial({ color, vertexColors: true }), this.cap);
    this.weapon.count = 0;
    this.weapon.frustumCulled = false;
    this.parent.add(this.weapon);
  }

  spawn(x: number, z: number, time: number, fromX = x, fromZ = z): Unit | null {
    if (this.units.length >= this.cap) return null;
    const u: Unit = { x: fromX, z: fromZ, y: 0, tx: x, tz: z, born: time, phase: Math.random() * 6.28, hitCd: 0, dying: 0 };
    this.units.push(u);
    return u;
  }

  /** Swap-remove so indices stay dense; the swapped unit glides into the freed slot. */
  removeAt(i: number): Unit | undefined {
    const u = this.units[i];
    if (!u) return undefined;
    const last = this.units.pop()!;
    if (i < this.units.length) this.units[i] = last;
    return u;
  }

  /** Index of the unit closest to a z position (front line for battles). */
  extremeIndex(dir: 1 | -1): number {
    let best = -1;
    let bz = dir > 0 ? -Infinity : Infinity;
    for (let i = 0; i < this.units.length; i++) {
      const z = this.units[i].z;
      if (dir > 0 ? z > bz : z < bz) {
        bz = z;
        best = i;
      }
    }
    return best;
  }

  clear(): void {
    this.units.length = 0;
    this.mesh.count = 0;
    if (this.weapon) this.weapon.count = 0;
  }

  update(dt: number, time: number): void {
    const k = 1 - Math.exp(-this.follow * dt);
    for (const u of this.units) {
      u.x += (u.tx - u.x) * k;
      u.z += (u.tz - u.z) * k;
      if (u.hitCd > 0) u.hitCd -= dt;
    }
    this.commit(time);
  }

  commit(time: number): void {
    const arr = this.mesh.instanceMatrix.array as Float32Array;
    const warr = this.weapon ? (this.weapon.instanceMatrix.array as Float32Array) : null;
    const cos = Math.cos(this.facing);
    const sin = Math.sin(this.facing);
    const n = this.units.length;
    for (let i = 0; i < n; i++) {
      const u = this.units[i];
      const age = time - u.born;
      let s = this.unitScale * (u.sc ?? 1) * (age < 0.3 ? Math.max(0.01, easeOutBack(Math.max(0, age) / 0.3)) : 1);
      const bob = this.running ? Math.abs(Math.sin(time * 13 + u.phase)) * 0.13 : 0;
      const sy = s * (this.running ? 1 - bob * 0.25 : 1);
      const o = i * 16;
      arr[o] = cos * s; arr[o + 1] = 0; arr[o + 2] = -sin * s; arr[o + 3] = 0;
      arr[o + 4] = 0; arr[o + 5] = sy; arr[o + 6] = 0; arr[o + 7] = 0;
      arr[o + 8] = sin * s; arr[o + 9] = 0; arr[o + 10] = cos * s; arr[o + 11] = 0;
      arr[o + 12] = u.x; arr[o + 13] = u.y + bob; arr[o + 14] = u.z; arr[o + 15] = 1;
      if (warr) for (let j = 0; j < 16; j++) warr[o + j] = arr[o + j];
      s = 0;
    }
    this.mesh.count = n;
    this.mesh.instanceMatrix.needsUpdate = true;
    if (this.weapon && warr) {
      this.weapon.count = n;
      this.weapon.instanceMatrix.needsUpdate = true;
    }
  }

  dispose(): void {
    this.parent.remove(this.mesh);
    this.material.dispose();
    if (this.weapon) {
      this.parent.remove(this.weapon);
      (this.weapon.material as THREE.Material).dispose();
    }
  }
}

/** Vogel (sunflower) spiral slot — a compact, natural-looking crowd for any count. */
export function spiralSlot(i: number, c: number, out: { x: number; z: number }): void {
  const r = c * Math.sqrt(i + 0.5);
  const a = i * 2.399963;
  out.x = r * Math.cos(a);
  out.z = r * Math.sin(a);
}

export function spiralRadius(n: number, c: number): number {
  return c * Math.sqrt(Math.max(1, n));
}
