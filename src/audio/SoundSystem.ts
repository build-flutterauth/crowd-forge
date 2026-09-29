// Tiny synthesized sound library (no assets). Every gameplay moment calls a
// named hook, so real audio files can be swapped in later without touching game code.

export type SoundId =
  | 'gateGood' | 'gateBad' | 'gateSpecial' | 'gateGolden' | 'spawn' | 'hit' | 'battleStart' | 'battleWin'
  | 'death' | 'coin' | 'bossIntro' | 'bossHit' | 'bossDown' | 'win' | 'lose' | 'click' | 'multStep' | 'pickup' | 'rare';

export class SoundSystem {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  enabled = true;
  private last: Partial<Record<SoundId, number>> = {};

  unlock(): void {
    if (this.ctx) {
      if (this.ctx.state === 'suspended') void this.ctx.resume();
      return;
    }
    try {
      const AC = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      this.ctx = new AC();
      this.master = this.ctx.createGain();
      this.master.gain.value = 0.35;
      this.master.connect(this.ctx.destination);
    } catch {
      this.ctx = null;
    }
  }

  private tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.5, slideTo?: number, delay = 0): void {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    o.frequency.setValueAtTime(freq, t);
    if (slideTo) o.frequency.exponentialRampToValueAtTime(slideTo, t + dur);
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
    o.connect(g).connect(this.master!);
    o.start(t);
    o.stop(t + dur + 0.05);
  }

  private noise(dur: number, vol = 0.4, lp = 1200, delay = 0): void {
    const c = this.ctx!;
    const t = c.currentTime + delay;
    const len = Math.floor(c.sampleRate * dur);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * (1 - i / len);
    const src = c.createBufferSource();
    src.buffer = buf;
    const f = c.createBiquadFilter();
    f.type = 'lowpass';
    f.frequency.value = lp;
    const g = c.createGain();
    g.gain.value = vol;
    src.connect(f).connect(g).connect(this.master!);
    src.start(t);
  }

  play(id: SoundId, pitch = 1): void {
    if (!this.enabled || !this.ctx || !this.master) return;
    const now = this.ctx.currentTime;
    const minGap = id === 'spawn' || id === 'hit' ? 0.045 : id === 'coin' ? 0.06 : 0.02;
    if ((this.last[id] ?? -1) > now - minGap) return;
    this.last[id] = now;
    switch (id) {
      case 'gateGood':
        [523, 659, 784].forEach((f, i) => this.tone(f * pitch, 0.14, 'triangle', 0.35, undefined, i * 0.05));
        break;
      case 'gateGolden':
        [523, 659, 784, 1047, 1319].forEach((f, i) => this.tone(f, 0.22, 'triangle', 0.35, undefined, i * 0.06));
        break;
      case 'gateBad':
        this.tone(330, 0.3, 'sawtooth', 0.25, 140);
        break;
      case 'gateSpecial':
        this.tone(440, 0.2, 'square', 0.18, 880);
        this.tone(660, 0.2, 'triangle', 0.2, 1320, 0.08);
        break;
      case 'spawn':
        this.tone(900 + Math.random() * 500, 0.05, 'sine', 0.12);
        break;
      case 'pickup':
        this.tone(700, 0.08, 'triangle', 0.25, 1100);
        break;
      case 'hit':
        this.noise(0.08, 0.25, 900 + Math.random() * 600);
        break;
      case 'battleStart':
        this.noise(0.35, 0.5, 500);
        this.tone(110, 0.35, 'sawtooth', 0.25, 60);
        break;
      case 'battleWin':
        this.tone(392, 0.12, 'triangle', 0.3);
        this.tone(523, 0.2, 'triangle', 0.3, undefined, 0.1);
        break;
      case 'death':
        this.noise(0.15, 0.3, 400);
        break;
      case 'coin':
        this.tone(1320 * pitch, 0.08, 'square', 0.12);
        this.tone(1760 * pitch, 0.12, 'square', 0.1, undefined, 0.05);
        break;
      case 'bossIntro':
        this.tone(80, 1.2, 'sawtooth', 0.35, 40);
        this.noise(1.0, 0.35, 300, 0.1);
        break;
      case 'bossHit':
        this.noise(0.2, 0.4, 700);
        this.tone(90, 0.2, 'square', 0.25, 50);
        break;
      case 'bossDown':
        this.noise(1.2, 0.6, 600);
        [262, 330, 392, 523].forEach((f, i) => this.tone(f, 0.3, 'triangle', 0.3, undefined, 0.3 + i * 0.1));
        break;
      case 'win':
        [523, 659, 784, 1047].forEach((f, i) => this.tone(f, 0.25, 'triangle', 0.35, undefined, i * 0.12));
        break;
      case 'lose':
        [392, 330, 262, 196].forEach((f, i) => this.tone(f, 0.3, 'sawtooth', 0.18, undefined, i * 0.15));
        break;
      case 'click':
        this.tone(1000, 0.04, 'square', 0.1);
        break;
      case 'multStep':
        this.tone(400 * pitch, 0.18, 'triangle', 0.35, 800 * pitch);
        break;
      case 'rare':
        [659, 880, 1175].forEach((f, i) => this.tone(f, 0.3, 'sine', 0.3, undefined, i * 0.08));
        break;
    }
  }
}

export const sfx = new SoundSystem();

export const feel = { haptics: true };

export function haptic(ms: number): void {
  if (!feel.haptics) return;
  // Browsers reject vibration before the user has interacted with the page.
  const ua = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (ua && !ua.hasBeenActive) return;
  try {
    if (navigator.vibrate) navigator.vibrate(ms);
  } catch {
    /* unsupported */
  }
}
