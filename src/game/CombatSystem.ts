// Deterministic battles: each enemy power point removes one unit (modified by
// charge and special-unit bonuses). The loss is computed up front with the same
// rule the generator simulated, then played out over time for drama.
import * as THREE from 'three';
import { sfx, haptic } from '../audio/SoundSystem';
import { GAME } from '../config/gameConfig';
import type { CameraRig, Overlay, Particles } from '../render/Effects';
import { battleLoss, fmt } from '../sim/rules';
import type { ArmyManager } from './ArmyManager';

export interface Opponent {
  kind: 'enemy' | 'boss' | 'wall';
  power: number;
  contactS: number;
  x: number;
  color: string;
  /** remaining fraction 1 → 0 */
  onProgress(remaining: number, dt: number): void;
  onEnd(won: boolean): void;
}

export class CombatSystem {
  active: Opponent | null = null;
  private loss = 0;
  private applied = 0;
  private t = 0;
  private dur = 1;
  private startN = 0;
  private hitAcc = 0;
  private overlay: Overlay;
  private particles: Particles;
  private cam: CameraRig;
  onResolved: (o: Opponent, won: boolean, lost: number) => void = () => {};

  constructor(overlay: Overlay, particles: Particles, cam: CameraRig) {
    this.overlay = overlay;
    this.particles = particles;
    this.cam = cam;
  }

  get fighting(): boolean {
    return this.active !== null;
  }

  start(army: ArmyManager, o: Opponent): void {
    this.active = o;
    this.startN = army.n;
    this.loss = battleLoss(army.state, o.power, army.playerMult);
    this.applied = 0;
    this.t = 0;
    const B = GAME.battle;
    const big = Math.log10(o.power + 1);
    this.dur =
      o.kind === 'boss'
        ? Math.min(B.bossMaxDuration, B.bossMinDuration + big * 0.4)
        : o.kind === 'wall'
          ? 0.35 + big * 0.08
          : Math.min(B.maxDuration, B.minDuration + big * 0.35);
    if (o.kind !== 'wall') {
      sfx.play('battleStart');
      this.cam.shake(o.kind === 'boss' ? 0.6 : Math.min(0.5, 0.1 + big * 0.1), 0.3);
      haptic(30);
    }
    if (army.state.charge) this.overlay.float('CHARGE ×1.3', new THREE.Vector3(army.x, 2.5, army.z - 2), 'special');
  }

  update(dt: number, army: ArmyManager): void {
    const o = this.active;
    if (!o) return;
    this.t += dt;
    const p = Math.min(1, this.t / this.dur);
    const ease = 1 - Math.pow(1 - p, 1.6);
    const want = Math.floor(this.loss * ease);
    if (want > this.applied) {
      const got = army.damage(want - this.applied);
      this.applied = want;
      if (army.n > 0) army.removeFront(3, army.color);
      void got;
    }
    o.onProgress(1 - ease, dt);

    // clash effects along the contact line
    this.hitAcc += dt * (o.kind === 'wall' ? 30 : 45);
    const contactZ = -(army.front + 0.4);
    while (this.hitAcc >= 1) {
      this.hitAcc--;
      const x = o.x + (Math.random() - 0.5) * Math.min(9, 2 + army.radius * 1.5);
      this.particles.emit(x, 0.5, contactZ, 2, Math.random() < 0.5 ? o.color : army.color, { speed: 3, up: 4, size: 0.11, life: 0.45 });
    }
    if (Math.random() < dt * 12) sfx.play('hit');

    const dead = army.n <= 0 && !army.invincible;
    if (p >= 1 || dead) {
      army.state.charge = false;
      const won = !dead && army.n > 0;
      const lost = this.startN - army.n;
      this.active = null;
      o.onEnd(won);
      if (won && o.kind !== 'wall') {
        sfx.play('battleWin');
        this.overlay.float(`−${fmt(lost)}`, new THREE.Vector3(army.x, 2, army.z), 'bad');
      }
      this.onResolved(o, won, lost);
    }
  }

  cancel(): void {
    this.active = null;
  }
}
