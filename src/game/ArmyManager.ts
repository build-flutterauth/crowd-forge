// The player's army: exact numeric state (ArmyState, shared rules with the
// simulator) + a visual crowd capped for rendering. At huge counts the crowd
// stays at the render cap while the number keeps the true value.
import * as THREE from 'three';
import { GAME } from '../config/gameConfig';
import { COLORS, TRAILS } from '../config/metaConfig';
import { applyLoss, newArmy, type ArmyState } from '../sim/rules';
import { Crowd, spiralRadius, spiralSlot } from '../render/Crowd';
import type { Overlay, Particles } from '../render/Effects';
import { unitGeometry, weaponGeometry } from '../render/UnitGeometry';
import { fmt } from '../sim/rules';

const HW = GAME.track.halfWidth;
const slot = { x: 0, z: 0 };

export interface Cosmetics {
  skin: string;
  color: string;
  trail: string;
  weapon: string;
  banner: string;
  victory: string;
}

export class ArmyManager {
  state: ArmyState = newArmy(5);
  x = 0;
  targetX = 0;
  s = 0;
  crowd: Crowd;
  display = 5;
  squeeze = 1;
  private squeezeT = 1;
  laneClamp: [number, number] | null = null;
  private splitBlend = 0;
  invincible = false;
  playerMult = 1;
  color = '#2f8cff';
  cos: Cosmetics = { skin: 'classic', color: 'blue', trail: 'none', weapon: 'none', banner: 'none', victory: 'cheer' };
  spawnFrom: { x: number; s: number } | null = null;
  private spawnAcc = 0;
  private trailAcc = 0;
  private label: HTMLDivElement;
  private banner: THREE.Group;
  private flagMat = new THREE.MeshLambertMaterial({ color: '#2f8cff', side: THREE.DoubleSide });
  private particles: Particles;
  private overlay: Overlay;
  celebrating = false;
  private celebrateT = 0;

  /** Units currently lost this frame etc — hooks for stats */
  onLoss: (n: number) => void = () => {};

  constructor(scene: THREE.Scene, particles: Particles, overlay: Overlay) {
    this.crowd = new Crowd(scene, unitGeometry('classic'), this.color, GAME.army.renderCap, 0);
    this.particles = particles;
    this.overlay = overlay;
    this.label = overlay.label('army-count');
    this.banner = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 2.6, 6), new THREE.MeshLambertMaterial({ color: '#8a6a45' }));
    pole.position.y = 1.3;
    const flag = new THREE.Mesh(new THREE.PlaneGeometry(1.1, 0.7, 6, 1), this.flagMat);
    flag.position.set(0.58, 2.2, 0);
    flag.name = 'flag';
    this.banner.add(pole, flag);
    this.banner.visible = false;
    scene.add(this.banner);
  }

  setCosmetics(c: Cosmetics): void {
    this.cos = { ...c };
    this.color = COLORS.find((x) => x.id === c.color)?.hex ?? '#2f8cff';
    this.crowd.setGeometry(unitGeometry(c.skin));
    this.crowd.setColor(this.color);
    const w = weaponGeometry(c.weapon);
    this.crowd.setWeapon(w?.geo ?? null, w?.color);
    this.banner.visible = c.banner !== 'none';
    const bannerColors: Record<string, string> = { flag: this.color, star: '#ffd23f', skull: '#222222', dragon: '#c0392b', crown: '#ffcc33' };
    this.flagMat.color.set(bannerColors[c.banner] ?? this.color);
    this.label.style.setProperty('--team', this.color);
  }

  reset(n: number): void {
    this.state = newArmy(n);
    this.x = this.targetX = 0;
    this.s = 0;
    this.display = n;
    this.squeeze = this.squeezeT = 1;
    this.laneClamp = null;
    this.splitBlend = 0;
    this.spawnFrom = null;
    this.celebrating = false;
    this.crowd.clear();
    for (let i = 0; i < Math.min(n, this.crowd.cap); i++) {
      spiralSlot(i, GAME.army.spiral, slot);
      this.crowd.spawn(slot.x, -this.s + slot.z, -1);
    }
  }

  get n(): number {
    return this.state.n;
  }

  get visibleTarget(): number {
    return Math.min(this.state.n, this.crowd.cap);
  }

  get radius(): number {
    return spiralRadius(Math.max(1, this.crowd.count), GAME.army.spiral);
  }

  get front(): number {
    return this.s + Math.min(this.radius, 3) * 0.6;
  }

  get z(): number {
    return -this.s;
  }

  setSqueeze(v: number): void {
    this.squeezeT = v;
  }

  /** Apply damage respecting shields and invincibility. Returns units actually lost. */
  damage(loss: number): number {
    if (loss <= 0) return 0;
    if (this.invincible) {
      const allowed = Math.max(0, Math.min(loss, this.state.n - 1));
      const l = applyLoss(this.state, allowed);
      this.onLoss(l);
      return l;
    }
    const l = applyLoss(this.state, loss);
    this.onLoss(l);
    return l;
  }

  /** Hazard hit on a specific visual unit. Returns units removed. */
  hitUnit(i: number, budget: number, color = '#ff3b3b'): number {
    const u = this.crowd.units[i];
    if (!u || u.hitCd > 0 || budget <= 0 || this.state.n <= 0) return 0;
    const perRep = Math.max(1, Math.round(this.state.n / Math.max(1, this.crowd.count)));
    const lost = this.damage(Math.min(budget, perRep));
    if (lost <= 0) {
      u.hitCd = 0.4;
      return 0;
    }
    this.particles.emit(u.x, 0.4, u.z, 5, color, { speed: 3, up: 4, size: 0.12 });
    if (this.crowd.count > this.visibleTarget) {
      this.crowd.removeAt(i);
    } else {
      // representative of many units: respawn it inside the formation
      u.x = this.x;
      u.z = this.z;
      u.hitCd = 0.5;
    }
    return lost;
  }

  /** Remove visual units from the front line (battles). */
  removeFront(k: number, color: string): void {
    for (let j = 0; j < k && this.crowd.count > this.visibleTarget; j++) {
      const i = this.crowd.extremeIndex(-1);
      const u = this.crowd.units[i];
      if (!u) break;
      this.particles.emit(u.x, 0.4, u.z, 3, color, { speed: 3, up: 3, size: 0.1, life: 0.5 });
      this.crowd.removeAt(i);
    }
  }

  update(dt: number, time: number, playing: boolean): void {
    const T = GAME.track;
    // steering
    let lim0 = -T.steerLimit;
    let lim1 = T.steerLimit;
    if (this.laneClamp) {
      lim0 = Math.max(lim0, this.laneClamp[0] + 0.6);
      lim1 = Math.min(lim1, this.laneClamp[1] - 0.6);
      if (lim0 > lim1) lim0 = lim1 = (this.laneClamp[0] + this.laneClamp[1]) / 2;
    }
    this.targetX = Math.max(-T.steerLimit, Math.min(T.steerLimit, this.targetX));
    const tx = Math.max(lim0, Math.min(lim1, this.targetX));
    this.x += (tx - this.x) * (1 - Math.exp(-T.steerSmoothing * dt));
    this.squeeze += (this.squeezeT - this.squeeze) * Math.min(1, dt * 6);
    this.splitBlend += ((this.state.split ? 1 : 0) - this.splitBlend) * Math.min(1, dt * 5);

    // sync visible crowd with the true count (spawn gradually for satisfying growth)
    const target = this.visibleTarget;
    const cur = this.crowd.count;
    if (cur < target) {
      const deficit = target - cur;
      const rate = Math.max(45, deficit / GAME.army.spawnWindow);
      this.spawnAcc += rate * dt;
      let k = Math.min(deficit, Math.floor(this.spawnAcc));
      this.spawnAcc -= k;
      while (k-- > 0) {
        const fx = this.spawnFrom ? this.spawnFrom.x + (Math.random() - 0.5) * 2 : this.x;
        const fz = this.spawnFrom ? -this.spawnFrom.s : this.z;
        this.crowd.spawn(this.x, this.z, time, fx, fz);
      }
    } else {
      this.spawnAcc = 0;
      if (cur > target) {
        for (let k = cur - target; k > 0; k--) {
          const u = this.crowd.units[this.crowd.count - 1];
          this.particles.emit(u.x, 0.4, u.z, 2, this.color, { speed: 2, up: 3, size: 0.1, life: 0.4 });
          this.crowd.removeAt(this.crowd.count - 1);
        }
      }
    }

    // formation targets
    const c = GAME.army.spiral * (this.state.n > this.crowd.cap ? 0.97 : 1);
    const units = this.crowd.units;
    const sb = this.splitBlend;
    const clampL = this.laneClamp ? this.laneClamp[0] + 0.2 : -HW + 0.2;
    const clampR = this.laneClamp ? this.laneClamp[1] - 0.2 : HW - 0.2;
    for (let i = 0; i < units.length; i++) {
      const u = units[i];
      spiralSlot(i, c, slot);
      let ux = this.x + slot.x * this.squeeze;
      let uz = this.z + slot.z;
      if (sb > 0.01) {
        spiralSlot(i >> 1, c, slot);
        const cx = i & 1 ? 2.6 : -2.6;
        ux = ux * (1 - sb) + (cx + slot.x) * sb;
        uz = uz * (1 - sb) + (this.z + slot.z) * sb;
      }
      u.tx = Math.max(clampL, Math.min(clampR, ux));
      u.tz = uz;
    }
    this.crowd.running = playing;
    if (this.celebrating) this.animateVictory(dt, time);
    else for (const u of units) u.y = 0;
    this.crowd.update(dt, time);

    // number display counts toward truth quickly (log-space for huge jumps)
    const d = this.state.n;
    if (Math.abs(d - this.display) < 1) this.display = d;
    else {
      const ld = Math.log(Math.max(1, this.display));
      const lt = Math.log(Math.max(1, d));
      this.display = Math.exp(ld + (lt - ld) * Math.min(1, dt * 9));
      if (d === 0 && this.display < 1.5) this.display = 0;
    }

    // label + banner + trail
    const r = this.radius;
    const top = new THREE.Vector3(this.x * (1 - this.splitBlend), 1.3 + Math.min(r, 4) * 0.25, this.z);
    if (!this.hidden) this.overlay.place(this.label, top);
    this.label.innerHTML = fmt(Math.round(this.display)) + (this.state.shield > 0 ? ` <span class="shield-badge">🛡${fmt(this.state.shield)}</span>` : '') +
      (this.state.dbl ? ' <span class="dbl-badge">2×</span>' : '') + (this.state.bank > 0 ? ` <span class="bank-badge">🏦${fmt(this.state.bank)}</span>` : '');
    this.label.classList.toggle('charged', this.state.charge);
    if (this.banner.visible) {
      this.banner.position.set(this.x, 0.3, this.z + 0.2);
      const flag = this.banner.getObjectByName('flag') as THREE.Mesh;
      flag.rotation.y = Math.sin(time * 6) * 0.25;
    }
    if (playing && this.cos.trail !== 'none' && units.length) {
      this.trailAcc += dt * GAME.army.trailRate;
      while (this.trailAcc >= 1) {
        this.trailAcc--;
        const u = units[(Math.random() * units.length) | 0];
        const t = this.cos.trail;
        const col = t === 'rainbow' ? `hsl(${(time * 200) % 360},90%,60%)` : t === 'dust' ? '#c9b48a' : TRAILS.find((x) => x.id === t)?.hex ?? '#fff';
        this.particles.emit(u.x, 0.15, u.z + 0.3, 1, col, { speed: 0.6, up: t === 'fire' ? 2.5 : 1, life: 0.5, size: t === 'hearts' ? 0.16 : 0.1, gravity: t === 'fire' ? -2 : 3 });
      }
    }
  }

  celebrate(): void {
    this.celebrating = true;
    this.celebrateT = 0;
  }

  private animateVictory(dt: number, time: number): void {
    this.celebrateT += dt;
    const v = this.cos.victory;
    const units = this.crowd.units;
    units.forEach((u, i) => {
      const ph = u.phase;
      switch (v) {
        case 'jump': u.y = Math.max(0, Math.sin(time * 7 + ph)) * 0.8; break;
        case 'spin': u.y = 0.2 + Math.sin(time * 4 + ph) * 0.1; break;
        case 'wave': u.y = Math.max(0, Math.sin(time * 6 - (u.x - this.x) * 1.2)) * 0.7; break;
        case 'fireworks':
        case 'cheer':
        default: u.y = Math.abs(Math.sin(time * 9 + ph)) * 0.35;
      }
      if (v === 'spin') this.crowd.facing = time * 6;
      void i;
    });
    if (v === 'fireworks' && Math.random() < dt * 3) {
      const col = `hsl(${Math.random() * 360},95%,60%)`;
      this.particles.emit(this.x + (Math.random() - 0.5) * 8, 6 + Math.random() * 4, this.z - 4 - Math.random() * 6, 40, col, { speed: 7, up: 2, gravity: 4, life: 1.2, size: 0.18 });
    }
  }

  stopCelebrate(): void {
    this.celebrating = false;
    this.crowd.facing = 0;
  }

  setVisible(v: boolean): void {
    this.crowd.mesh.visible = v;
    if (this.crowd.weapon) this.crowd.weapon.visible = v;
    this.banner.visible = v && this.cos.banner !== 'none';
    this.label.style.display = v ? '' : 'none';
    this.hidden = !v;
  }
  hidden = false;

  hideLabel(h: boolean): void {
    this.label.style.visibility = h ? 'hidden' : '';
  }
}
