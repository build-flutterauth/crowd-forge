// Deterministic randomness. Every procedural decision flows through an Rng
// forked from a level seed, so the same seed + parameters always rebuild the
// same level.

export function hashString(s: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mixSeed(a: number, b: number): number {
  let h = Math.imul((a ^ 0x9e3779b9) >>> 0, 0x85ebca6b) ^ (b >>> 0);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return h >>> 0;
}

export class Rng {
  private s: number;
  readonly seed: number;

  constructor(seed: number) {
    this.seed = seed >>> 0;
    this.s = this.seed || 0x1234567;
  }

  /** mulberry32 */
  next(): number {
    let t = (this.s = (this.s + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(a: number, b: number): number {
    return a + (b - a) * this.next();
  }

  int(a: number, b: number): number {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)];
  }

  weighted<T>(items: readonly T[], weight: (t: T) => number): T | undefined {
    let total = 0;
    for (const it of items) total += Math.max(0, weight(it));
    if (total <= 0) return undefined;
    let r = this.next() * total;
    for (const it of items) {
      r -= Math.max(0, weight(it));
      if (r <= 0) return it;
    }
    return items[items.length - 1];
  }

  shuffle<T>(arr: T[]): T[] {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Independent child stream; deterministic given call order. */
  fork(label: string | number): Rng {
    const l = typeof label === 'number' ? label : hashString(label);
    return new Rng(mixSeed(Math.floor(this.next() * 4294967296), l));
  }
}

export const SeedManager = {
  randomSeed(): number {
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      const a = new Uint32Array(1);
      crypto.getRandomValues(a);
      return a[0] >>> 0;
    }
    return Math.floor(Math.random() * 4294967296) >>> 0;
  },

  levelSeed(masterSeed: number, levelNumber: number): number {
    return mixSeed(masterSeed, hashString('level:' + levelNumber));
  },

  attemptSeed(seed: number, attempt: number): number {
    return attempt === 0 ? seed : mixSeed(seed, hashString('attempt:' + attempt));
  },

  toCode(seed: number): string {
    return (seed >>> 0).toString(36).toUpperCase().padStart(7, '0');
  },

  /** Accepts a base36 seed code, a decimal number, or any text (hashed). */
  fromCode(code: string): number {
    const t = code.trim();
    if (/^\d+$/.test(t) && Number(t) < 4294967296) return Number(t) >>> 0;
    if (/^[0-9A-Za-z]{1,7}$/.test(t)) {
      const v = parseInt(t, 36);
      if (Number.isFinite(v) && v < 4294967296) return v >>> 0;
    }
    return hashString(t);
  },
};
