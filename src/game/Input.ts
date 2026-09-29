// Steering input: drag anywhere (touch or mouse) or A/D / arrow keys.
// Relative drag = smooth analog steering rather than lanes.
import { GAME } from '../config/gameConfig';

export class Input {
  private dragging = false;
  private startX = 0;
  private startTarget = 0;
  private keys = new Set<string>();
  enabled = true;
  /** set by the game: current steering target in track units */
  target = 0;
  onFirstInteraction: () => void = () => {};
  private interacted = false;

  constructor(el: HTMLElement) {
    el.addEventListener('pointerdown', (e) => {
      this.first();
      if (!this.enabled) return;
      this.dragging = true;
      this.startX = e.clientX;
      this.startTarget = this.target;
      el.setPointerCapture?.(e.pointerId);
    });
    el.addEventListener('pointermove', (e) => {
      if (!this.dragging || !this.enabled) return;
      const w = Math.max(320, window.innerWidth);
      const dx = (e.clientX - this.startX) / w;
      this.target = this.startTarget + dx * GAME.track.halfWidth * 2 * GAME.track.dragSensitivity;
      this.clamp();
    });
    const end = () => (this.dragging = false);
    el.addEventListener('pointerup', end);
    el.addEventListener('pointercancel', end);
    window.addEventListener('keydown', (e) => {
      if ((e.target as HTMLElement)?.tagName === 'INPUT') return;
      this.first();
      this.keys.add(e.key.toLowerCase());
    });
    window.addEventListener('keyup', (e) => this.keys.delete(e.key.toLowerCase()));
    window.addEventListener('blur', () => this.keys.clear());
  }

  private first(): void {
    if (!this.interacted) {
      this.interacted = true;
      this.onFirstInteraction();
    }
  }

  private clamp(): void {
    const l = GAME.track.steerLimit;
    this.target = Math.max(-l, Math.min(l, this.target));
  }

  update(dt: number): void {
    if (!this.enabled) return;
    let d = 0;
    if (this.keys.has('a') || this.keys.has('arrowleft')) d -= 1;
    if (this.keys.has('d') || this.keys.has('arrowright')) d += 1;
    if (d) {
      this.target += d * GAME.track.keySteerSpeed * dt;
      this.clamp();
    }
  }

  reset(): void {
    this.target = 0;
    this.dragging = false;
  }
}
