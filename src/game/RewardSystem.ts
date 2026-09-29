// End-of-level multiplier runway and coin rewards.
import * as THREE from 'three';
import { sfx, haptic } from '../audio/SoundSystem';
import { GAME } from '../config/gameConfig';
import type { Level, RunwayStep } from '../core/types';
import type { CameraRig, Overlay, Particles } from '../render/Effects';
import { fmt } from '../sim/rules';
import type { ArmyManager } from './ArmyManager';
import type { CombatSystem } from './CombatSystem';

const HW = GAME.track.halfWidth;

function stepColor(i: number, n: number): string {
  const h = 130 - (i / Math.max(1, n - 1)) * 170;
  return `hsl(${(h + 360) % 360}, 85%, 55%)`;
}

function floorTexture(text: string, color: string): THREE.CanvasTexture {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 160;
  const x = c.getContext('2d')!;
  x.fillStyle = color;
  x.fillRect(0, 0, 512, 160);
  x.fillStyle = 'rgba(255,255,255,0.18)';
  for (let i = 0; i < 16; i++) x.fillRect(i * 32, 0, 16, 160);
  x.fillStyle = '#fff';
  x.font = '900 110px system-ui, sans-serif';
  x.textAlign = 'center';
  x.textBaseline = 'middle';
  x.shadowColor = 'rgba(0,0,0,0.4)';
  x.shadowBlur = 8;
  x.fillText(text, 256, 86);
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return t;
}

interface StepView {
  step: RunwayStep;
  group: THREE.Group;
  wall: THREE.Group;
  label: HTMLDivElement;
  state: 'wait' | 'fight' | 'broken';
  remaining: number;
}

export class RewardSystem {
  private scene: THREE.Scene;
  private overlay: Overlay;
  private particles: Particles;
  private cam: CameraRig;
  private views: StepView[] = [];
  active = false;
  finished = false;
  reached = 1;
  private endS = 0;
  onStep: (mult: number) => void = () => {};

  constructor(scene: THREE.Scene, overlay: Overlay, particles: Particles, cam: CameraRig) {
    this.scene = scene;
    this.overlay = overlay;
    this.particles = particles;
    this.cam = cam;
  }

  build(level: Level): void {
    this.clear();
    const n = level.runway.length;
    level.runway.forEach((step, i) => {
      const g = new THREE.Group();
      g.position.z = -step.s;
      const col = stepColor(i, n);
      const floor = new THREE.Mesh(new THREE.PlaneGeometry(HW * 2, 3.2), new THREE.MeshBasicMaterial({ map: floorTexture('×' + step.mult, col) }));
      floor.rotation.x = -Math.PI / 2;
      floor.position.set(0, 0.03, -2.2);
      g.add(floor);
      const wall = new THREE.Group();
      const bm = new THREE.MeshLambertMaterial({ color: '#d8403a', flatShading: true });
      const cols = 10;
      const rows = Math.min(4, 1 + Math.floor(Math.log10(step.wall + 1)));
      for (let r = 0; r < rows; r++) for (let k = 0; k < cols; k++) {
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.95, 0.7, 0.8), bm);
        b.position.set(-HW + 0.5 + k, 0.35 + r * 0.72, 0);
        wall.add(b);
      }
      g.add(wall);
      this.scene.add(g);
      const label = this.overlay.label('wall-count');
      label.innerHTML = `<b>×${step.mult}</b> ${fmt(step.wall)}`;
      this.views.push({ step, group: g, wall, label, state: 'wait', remaining: step.wall });
    });
    this.endS = level.runwayEnd;
    this.active = false;
    this.finished = false;
    this.reached = 1;
  }

  clear(): void {
    for (const v of this.views) {
      this.scene.remove(v.group);
      v.label.remove();
    }
    this.views = [];
    this.active = false;
    this.finished = false;
  }

  start(): void {
    this.active = true;
    this.reached = 1;
  }

  update(dt: number, time: number, army: ArmyManager, combat: CombatSystem): void {
    for (const v of this.views) {
      const ahead = v.step.s - army.s;
      const vis = ahead < 150 && ahead > -20 && v.state !== 'broken';
      v.label.style.display = vis ? '' : 'none';
      if (vis) this.overlay.place(v.label, new THREE.Vector3(0, 3.6, -v.step.s));
      if (v.state === 'fight') {
        v.wall.children.forEach((b, i) => {
          b.position.y += Math.sin(time * 40 + i) * 0.004;
        });
      }
    }
    if (!this.active || this.finished) return;

    const next = this.views.find((v) => v.state !== 'broken');
    if (!next) {
      if (army.s >= this.endS - 6) this.finished = true;
      return;
    }
    if (next.state === 'wait' && !combat.fighting && army.front >= next.step.s - 2.5 && army.n <= next.remaining) {
      // Not strong enough for the next wall: halt here and celebrate what we reached.
      this.finished = true;
      this.overlay.float('STOP!', new THREE.Vector3(0, 3, -next.step.s), 'bad big', 1.2);
      return;
    }
    if (next.state === 'wait' && !combat.fighting && army.front >= next.step.s - 0.4) {
      next.state = 'fight';
      const start = next.remaining;
      combat.start(army, {
        kind: 'wall',
        power: start,
        contactS: next.step.s,
        x: 0,
        color: '#d8403a',
        onProgress: (rem) => {
          next.remaining = start * rem;
          next.label.innerHTML = `<b>×${next.step.mult}</b> ${fmt(Math.ceil(next.remaining))}`;
        },
        onEnd: (won) => {
          if (won) {
            next.state = 'broken';
            this.reached = next.step.mult;
            this.shatter(next);
            this.onStep(next.step.mult);
            sfx.play('multStep', 1 + this.views.indexOf(next) * 0.12);
            haptic(25);
            this.overlay.float('×' + next.step.mult, new THREE.Vector3(0, 3, -next.step.s), 'golden huge', 1.2);
          } else {
            this.finished = true;
          }
        },
      });
    }
    void dt;
  }

  private shatter(v: StepView): void {
    for (const b of v.wall.children) {
      this.particles.emit(b.position.x, b.position.y, -v.step.s, 3, '#d8403a', { speed: 6, up: 6, size: 0.25 });
    }
    this.cam.shake(0.25, 0.2);
    v.group.remove(v.wall);
    v.label.style.display = 'none';
  }

  static levelCoins(level: Level, finishArmy: number, coinMult: number): number {
    return Math.round((15 + 2 * level.levelNumber + 3 * Math.sqrt(Math.max(0, finishArmy))) * coinMult);
  }

  static bonusCoins(level: Level, mult: number, coinMult: number): number {
    return mult <= 1 ? 0 : Math.round(mult * (1 + Math.floor(level.levelNumber / 5)) * coinMult);
  }
}
