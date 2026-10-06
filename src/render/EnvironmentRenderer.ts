// Procedural environments: sky, lighting, recycled track tiles, themed
// off-track decoration and ambient particles. Purely visual — decoration stays
// outside the play area so it never hurts readability.
import * as THREE from 'three';
import { ENVIRONMENTS, GAME, type EnvDef } from '../config/gameConfig';
import { Rng, mixSeed } from '../core/SeedManager';
import type { EnvId } from '../core/types';
import type { Stage3D } from './Stage3D';

const TILE = 40;
const TILE_COUNT = 11;
const HW = GAME.track.halfWidth;

function mat(color: string | number, emissive?: string, flat = true): THREE.MeshLambertMaterial {
  const m = new THREE.MeshLambertMaterial({ color, flatShading: flat });
  if (emissive) {
    m.emissive = new THREE.Color(emissive);
    m.emissiveIntensity = 0.9;
  }
  return m;
}

const G = {
  box: new THREE.BoxGeometry(1, 1, 1),
  cyl: new THREE.CylinderGeometry(0.5, 0.5, 1, 8),
  cone: new THREE.ConeGeometry(0.5, 1, 7),
  ico: new THREE.IcosahedronGeometry(0.5, 0),
  dodec: new THREE.DodecahedronGeometry(0.5, 0),
  sphere: new THREE.SphereGeometry(0.5, 10, 8),
  torus: new THREE.TorusGeometry(0.5, 0.12, 6, 14),
};

interface Tile {
  index: number;
  group: THREE.Group;
  deco: THREE.Group;
}

export class EnvironmentRenderer {
  private stage: Stage3D;
  env: EnvId = 'grasslands';
  def: EnvDef = ENVIRONMENTS.grasslands;
  private root = new THREE.Group();
  private ground: THREE.Mesh;
  private tiles: Tile[] = [];
  private tileMats: THREE.MeshLambertMaterial[] = [];
  private railMat = mat('#999');
  private decoMats: THREE.MeshLambertMaterial[] = [];
  private seed = 1;
  private particles: THREE.Points;
  private pVel: Float32Array;
  private pMat: THREE.PointsMaterial;
  private finishLine: THREE.Group | null = null;
  /** decoration density (lowered on the low quality setting) */
  density = 1;
  private hw = HW;
  private trackHidden = false;
  private white = mat('#ffffff');
  private dark = mat('#15122b');

  constructor(stage: Stage3D) {
    this.stage = stage;
    stage.scene.add(this.root);
    this.ground = new THREE.Mesh(new THREE.PlaneGeometry(600, 700), mat('#6c5'));
    this.ground.rotation.x = -Math.PI / 2;
    this.ground.position.y = -0.3;
    this.root.add(this.ground);
    this.tileMats = [mat('#eee', undefined, false), mat('#ddd', undefined, false)];

    for (let i = 0; i < TILE_COUNT; i++) {
      const group = new THREE.Group();
      for (let k = 0; k < 2; k++) {
        const m = new THREE.Mesh(new THREE.BoxGeometry(HW * 2, 0.6, TILE / 2), this.tileMats[k]);
        m.position.set(0, -0.3, -(k + 0.5) * (TILE / 2));
        group.add(m);
      }
      for (const side of [-1, 1]) {
        const rail = new THREE.Mesh(G.box, this.railMat);
        rail.scale.set(0.35, 0.5, TILE);
        rail.position.set(side * (HW + 0.18), 0.2, -TILE / 2);
        group.add(rail);
      }
      const deco = new THREE.Group();
      group.add(deco);
      this.root.add(group);
      this.tiles.push({ index: -999, group, deco });
    }

    const N = 360;
    const pos = new Float32Array(N * 3);
    this.pVel = new Float32Array(N * 3);
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    const dot = document.createElement('canvas');
    dot.width = dot.height = 32;
    const dx = dot.getContext('2d')!;
    const grad = dx.createRadialGradient(16, 16, 0, 16, 16, 16);
    grad.addColorStop(0, 'rgba(255,255,255,1)');
    grad.addColorStop(0.5, 'rgba(255,255,255,0.7)');
    grad.addColorStop(1, 'rgba(255,255,255,0)');
    dx.fillStyle = grad;
    dx.fillRect(0, 0, 32, 32);
    this.pMat = new THREE.PointsMaterial({ size: 0.25, color: 0xffffff, transparent: true, opacity: 0.85, depthWrite: false, map: new THREE.CanvasTexture(dot) });
    this.particles = new THREE.Points(geo, this.pMat);
    this.particles.frustumCulled = false;
    this.root.add(this.particles);
  }

  /** Widen/narrow the playfield (Lane Battle uses a wider field than the runner). */
  setHalfWidth(hw: number): void {
    if (hw === this.hw) return;
    this.hw = hw;
    for (const t of this.tiles) {
      const c = t.group.children;
      c[0].scale.x = c[1].scale.x = hw / HW;
      c[2].position.x = -(hw + 0.18);
      c[3].position.x = hw + 0.18;
      t.index = -999;
    }
  }

  /** Hide the runner track, its decoration and the ground (Canyon Siege builds its own world). */
  setTrackVisible(v: boolean): void {
    for (const t of this.tiles) t.group.visible = v;
    this.trackHidden = !v;
    this.ground.visible = v && !this.def.noGround;
  }
  apply(env: EnvId, seed: number): void {
    this.env = env;
    this.def = ENVIRONMENTS[env];
    this.seed = seed;
    const d = this.def;
    const scene = this.stage.scene;
    scene.background = skyTexture(d.sky[0], d.sky[1]);
    scene.fog = new THREE.Fog(d.fog, d.fogNear, d.fogFar);
    this.stage.hemi.color.set(d.hemi[0]);
    this.stage.hemi.groundColor.set(d.hemi[1]);
    this.stage.hemi.intensity = d.hemi[2];
    this.stage.sun.color.set(d.sun[0]);
    this.stage.sun.intensity = d.sun[1];
    (this.ground.material as THREE.MeshLambertMaterial).color.set(d.ground);
    this.ground.visible = !d.noGround && !this.trackHidden;
    this.tileMats[0].color.set(d.track[0]);
    this.tileMats[1].color.set(d.track[1]);
    this.railMat.color.set(d.rail);
    if (env === 'neon' || env === 'volcanic') {
      this.railMat.emissive.set(d.rail);
      this.railMat.emissiveIntensity = 0.7;
    } else this.railMat.emissive.set('#000');
    this.decoMats = d.decoColors.map((c, i) => mat(c, env === 'neon' && i < 3 ? c : env === 'volcanic' && i >= 2 ? c : undefined));
    for (const t of this.tiles) t.index = -999;
    this.setupParticles();
    this.setFinish(null);
  }

  private setupParticles(): void {
    const kind = this.def.particles;
    this.particles.visible = kind !== 'none';
    const colors: Record<string, string> = {
      sand: '#e8c07a', snow: '#ffffff', embers: '#ff7a2a', leaves: '#5fbf4a', sparkles: '#fff7a8', fireflies: '#e4ff5a', dust: '#d8c8a8', none: '#fff',
    };
    this.pMat.color.set(colors[kind]);
    this.pMat.size = kind === 'snow' ? 0.3 : kind === 'leaves' ? 0.35 : kind === 'fireflies' || kind === 'sparkles' ? 0.22 : 0.16;
    this.pMat.blending = kind === 'embers' || kind === 'fireflies' || kind === 'sparkles' ? THREE.AdditiveBlending : THREE.NormalBlending;
    const pos = this.particles.geometry.getAttribute('position') as THREE.BufferAttribute;
    const r = new Rng(this.seed ^ 0xabc);
    for (let i = 0; i < pos.count; i++) {
      pos.setXYZ(i, r.range(-30, 30), r.range(0, 20), r.range(-100, -4));
      const v = this.pVel;
      if (kind === 'snow') v.set([r.range(-0.5, 0.5), r.range(-2.5, -1), 0], i * 3);
      else if (kind === 'embers') v.set([r.range(-0.4, 0.4), r.range(1, 3), 0], i * 3);
      else if (kind === 'sand' || kind === 'dust') v.set([r.range(3, 6), r.range(-0.2, 0.2), 0], i * 3);
      else if (kind === 'leaves') v.set([r.range(0.5, 1.5), r.range(-1.2, -0.4), 0], i * 3);
      else v.set([r.range(-0.3, 0.3), r.range(-0.3, 0.3), r.range(-0.3, 0.3)], i * 3);
    }
    pos.needsUpdate = true;
  }

  setFinish(s: number | null): void {
    if (this.finishLine) {
      this.root.remove(this.finishLine);
      this.finishLine = null;
    }
    if (s === null) return;
    const g = new THREE.Group();
    const c = document.createElement('canvas');
    c.width = 256;
    c.height = 32;
    const x = c.getContext('2d')!;
    for (let i = 0; i < 16; i++) for (let j = 0; j < 2; j++) {
      x.fillStyle = (i + j) % 2 ? '#111' : '#fff';
      x.fillRect(i * 16, j * 16, 16, 16);
    }
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    const line = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 1.25), new THREE.MeshBasicMaterial({ map: tex }));
    line.rotation.x = -Math.PI / 2;
    line.position.y = 0.02;
    g.add(line);
    for (const side of [-1, 1]) {
      const post = new THREE.Mesh(G.box, mat('#ffffff'));
      post.scale.set(0.35, 5, 0.35);
      post.position.set(side * (HW + 0.5), 2.5, 0);
      g.add(post);
    }
    const banner = new THREE.Mesh(new THREE.BoxGeometry(HW * 2 + 1.4, 1, 0.2), new THREE.MeshBasicMaterial({ map: tex }));
    banner.position.set(0, 5, 0);
    g.add(banner);
    g.position.z = -s;
    this.finishLine = g;
    this.root.add(g);
  }

  update(dt: number, s: number, camPos: THREE.Vector3): void {
    this.ground.position.z = camPos.z - 200;
    this.ground.position.x = camPos.x;
    const first = Math.floor((s - 60) / TILE);
    for (let k = 0; k < TILE_COUNT; k++) {
      const idx = first + k;
      const slot = ((idx % TILE_COUNT) + TILE_COUNT) % TILE_COUNT;
      const t = this.tiles[slot];
      if (t.index !== idx) {
        t.index = idx;
        t.group.position.z = -idx * TILE;
        this.buildDeco(t);
      }
    }
    // ambient particles drift around the camera
    if (this.particles.visible) {
      const pos = this.particles.geometry.getAttribute('position') as THREE.BufferAttribute;
      const a = pos.array as Float32Array;
      const cz = camPos.z;
      for (let i = 0; i < pos.count; i++) {
        const j = i * 3;
        a[j] += this.pVel[j] * dt;
        a[j + 1] += this.pVel[j + 1] * dt;
        a[j + 2] += this.pVel[j + 2] * dt;
        if (a[j + 1] < 0) a[j + 1] += 20;
        if (a[j + 1] > 20) a[j + 1] -= 20;
        if (a[j] > camPos.x + 30) a[j] -= 60;
        if (a[j] < camPos.x - 30) a[j] += 60;
        if (a[j + 2] > cz - 4) a[j + 2] -= 104;
        if (a[j + 2] < cz - 104) a[j + 2] += 96;
      }
      pos.needsUpdate = true;
    }
  }

  // ------------------------------------------------------------------
  // decoration
  // ------------------------------------------------------------------

  private add(t: Tile, geo: THREE.BufferGeometry, m: THREE.Material, x: number, y: number, z: number, sx: number, sy: number, sz: number, ry = 0, rz = 0): THREE.Mesh {
    const mesh = new THREE.Mesh(geo, m);
    mesh.position.set(x, y, z);
    mesh.scale.set(sx, sy, sz);
    mesh.rotation.set(0, ry, rz);
    t.deco.add(mesh);
    return mesh;
  }

  private buildDeco(t: Tile): void {
    t.deco.clear();
    const r = new Rng(mixSeed(this.seed, t.index + 100000));
    const M = this.decoMats;
    const kind = this.def.deco;
    const count = Math.max(2, Math.round((kind === 'buildings' || kind === 'towers' ? 5 : 8) * this.density));
    for (let i = 0; i < count; i++) {
      const side = i % 2 ? 1 : -1;
      const x = side * r.range(this.hw + 2.8, this.hw + 26);
      const z = -r.range(0, TILE);
      const s = r.range(0.8, 1.6);
      switch (kind) {
        case 'trees': {
          this.add(t, G.cyl, M[3], x, 0.8 * s, z, 0.4 * s, 1.6 * s, 0.4 * s);
          this.add(t, G.ico, M[r.int(0, 2)], x, 2.3 * s, z, 2.2 * s, 2.4 * s, 2.2 * s, r.range(0, 3));
          if (r.chance(0.4)) this.add(t, G.ico, M[1], x + r.range(-2, 2), 0.3, z + r.range(-2, 2), 0.9, 0.6, 0.9);
          break;
        }
        case 'cacti': {
          if (r.chance(0.6)) {
            this.add(t, G.cyl, M[0], x, 1.3 * s, z, 0.6 * s, 2.6 * s, 0.6 * s);
            this.add(t, G.cyl, M[1], x + 0.5 * s, 1.5 * s, z, 0.35 * s, 1 * s, 0.35 * s, 0, 0.9);
            this.add(t, G.cyl, M[1], x - 0.45 * s, 1.1 * s, z, 0.3 * s, 0.9 * s, 0.3 * s, 0, -0.9);
          } else this.add(t, G.dodec, M[r.int(2, 3)], x, 0.4 * s, z, 1.8 * s, 1.1 * s, 1.5 * s, r.range(0, 3));
          break;
        }
        case 'pines': {
          this.add(t, G.cyl, M[3], x, 0.5 * s, z, 0.3 * s, 1 * s, 0.3 * s);
          for (let k = 0; k < 3; k++) this.add(t, G.cone, M[k === 2 ? 2 : r.int(0, 1)], x, (1.4 + k * 0.9) * s, z, (2.4 - k * 0.6) * s, 1.4 * s, (2.4 - k * 0.6) * s);
          break;
        }
        case 'rocks': {
          this.add(t, G.dodec, M[r.int(0, 1)], x, 0.6 * s, z, 2 * s, 1.6 * s, 2 * s, r.range(0, 3));
          if (r.chance(0.5)) this.add(t, G.cone, M[1], x, 2.5 * s, z, 1.5 * s, 5 * s, 1.5 * s);
          if (r.chance(0.5)) this.add(t, G.box, M[r.int(2, 3)], x + r.range(-2, 2), 0.02, z, r.range(1, 3), 0.05, r.range(1, 4));
          break;
        }
        case 'towers': {
          const h = r.range(4, 9);
          this.add(t, G.cyl, M[0], x, h / 2, z, 2.6, h, 2.6);
          this.add(t, G.cone, M[r.int(2, 3)], x, h + 1.2, z, 3.2, 2.4, 3.2);
          this.add(t, G.box, M[1], x - side * 3, 1.2, z, 1.2, 2.4, r.range(4, 9));
          break;
        }
        case 'buildings': {
          const h = r.range(6, 22);
          const w = r.range(3, 6);
          this.add(t, G.box, M[r.int(0, 1)], x - side * 1.5, h / 2, z, w, h, w);
          this.add(t, G.box, M[r.int(2, 3)], x - side * 1.5, h * r.range(0.3, 0.9), z, w + 0.1, 0.25, w + 0.1);
          break;
        }
        case 'palms': {
          const lean = side * r.range(0.1, 0.35);
          this.add(t, G.cyl, M[2], x, 1.8 * s, z, 0.35 * s, 3.6 * s, 0.35 * s, 0, lean);
          for (let k = 0; k < 5; k++) {
            const a = (k / 5) * Math.PI * 2;
            const leaf = this.add(t, G.cone, M[r.int(0, 1)], x - lean * 3.6 * s + Math.cos(a) * 1.1, 3.6 * s, z + Math.sin(a) * 1.1, 0.6, 2.6, 0.3, -a, 1.3);
            leaf.rotation.order = 'YZX';
          }
          if (r.chance(0.5)) this.add(t, G.ico, M[0], x + r.range(-3, 3), 0.5, z + r.range(-3, 3), 2.2, 1.2, 2.2);
          break;
        }
        case 'islands': {
          const y = r.range(-6, 5);
          this.add(t, G.cone, M[1], x, y - 1.8 * s, z, 4 * s, 3.6 * s, 4 * s, 0, Math.PI);
          this.add(t, G.cyl, M[0], x, y, z, 4 * s, 0.5, 4 * s);
          if (r.chance(0.6)) this.add(t, G.ico, M[0], x, y + 1.3, z, 1.5, 1.8, 1.5);
          if (r.chance(0.4)) this.add(t, G.sphere, M[2], x + r.range(-6, 6), r.range(6, 12), z, 5, 1.6, 3);
          break;
        }
        case 'lollipops': {
          if (r.chance(0.55)) {
            this.add(t, G.cyl, this.white, x, 1.6 * s, z, 0.15, 3.2 * s, 0.15);
            this.add(t, G.cyl, M[r.int(0, 3)], x, 3.4 * s, z, 1.9 * s, 0.35, 1.9 * s, 0, Math.PI / 2);
          } else {
            this.add(t, G.sphere, M[r.int(0, 3)], x, 0.5 * s, z, 1.6 * s, 1.2 * s, 1.6 * s);
          }
          break;
        }
        case 'neon': {
          const h = r.range(4, 14);
          this.add(t, G.box, this.dark, x, h / 2, z, 2, h, 2);
          this.add(t, G.box, M[r.int(0, 2)], x, h * r.range(0.4, 1), z, 2.2, 0.2, 2.2);
          if (r.chance(0.5)) this.add(t, G.torus, M[r.int(0, 3)], x, h + 1, z, 1.3, 1.3, 1.3, r.range(0, 3));
          break;
        }
        case 'columns': {
          const h = r.chance(0.4) ? r.range(1, 3) : r.range(4, 6);
          this.add(t, G.cyl, M[0], x, h / 2, z, 1, h, 1);
          this.add(t, G.box, M[1], x, 0.2, z, 1.6, 0.4, 1.6);
          if (h > 4 && r.chance(0.5)) this.add(t, G.box, M[1], x - side * 1.5, h + 0.3, z, 4.2, 0.6, 1.4);
          if (r.chance(0.4)) this.add(t, G.ico, M[2], x + r.range(-2, 2), 0.4, z + 2, 1.3, 0.8, 1.3);
          break;
        }
      }
    }
  }
}

function skyTexture(top: string, bottom: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 4;
  c.height = 256;
  const x = c.getContext('2d')!;
  const g = x.createLinearGradient(0, 0, 0, 256);
  g.addColorStop(0, top);
  g.addColorStop(0.75, bottom);
  g.addColorStop(1, bottom);
  x.fillStyle = g;
  x.fillRect(0, 0, 4, 256);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}
