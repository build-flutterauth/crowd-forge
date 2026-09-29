// Remembers recently used content so the generator can steer away from repeats.
import { VARIETY } from '../config/genConfig';
import type { SegmentType, VarietyKeys } from '../core/types';

export interface HistoryEntry {
  type: SegmentType;
  sig: string;
  keys: VarietyKeys;
}

export class VarietyHistory {
  entries: HistoryEntry[] = [];
  envs: string[] = [];
  bosses: string[] = [];

  push(e: HistoryEntry): void {
    this.entries.push(e);
    if (this.entries.length > 40) this.entries.shift();
  }

  recent(n: number): HistoryEntry[] {
    return this.entries.slice(-n);
  }

  /** How many of the most recent segments share this type consecutively */
  consecutive(type: SegmentType): number {
    let c = 0;
    for (let i = this.entries.length - 1; i >= 0 && this.entries[i].type === type; i--) c++;
    return c;
  }

  sinceRare(): number {
    for (let i = this.entries.length - 1; i >= 0; i--) {
      if (this.entries[i].keys.rare) return this.entries.length - 1 - i;
    }
    return Infinity;
  }

  /** 0 = brand new, 1 = seen constantly. Weighted by recency. */
  repetition(type: SegmentType, keys: VarietyKeys, sig: string): number {
    const recent = this.recent(VARIETY.historySize).reverse();
    let p = 0;
    let typeHits = 0;
    let obsHits = 0;
    recent.forEach((e, i) => {
      if (e.type === type && typeHits < VARIETY.typePenalty.length && i < VARIETY.typePenalty.length) {
        p += VARIETY.typePenalty[i];
        typeHits++;
      }
      if (keys.gates && e.keys.gates === keys.gates) p += VARIETY.gateComboPenalty / (1 + i * 0.5);
      if (keys.obstacle && e.keys.obstacle === keys.obstacle && i < VARIETY.obstaclePenalty.length) {
        p += VARIETY.obstaclePenalty[obsHits++ === 0 ? i : Math.min(i + 1, VARIETY.obstaclePenalty.length - 1)];
      }
      if (keys.formation && e.keys.formation === keys.formation) p += VARIETY.formationPenalty / (1 + i);
      if (keys.rare && e.keys.rare === keys.rare) p += VARIETY.rarePenalty;
      if (e.sig === sig) p += 0.5 / (1 + i);
    });
    return Math.min(1, p);
  }

  typeRecencyWeight(type: SegmentType): number {
    const recent = this.recent(4).reverse();
    let w = 1;
    recent.forEach((e, i) => {
      if (e.type === type) w *= 0.45 + i * 0.15;
    });
    return w;
  }

  recentEnv(env: string): number {
    const i = this.envs.lastIndexOf(env);
    if (i < 0) return 0;
    return 1 - (this.envs.length - 1 - i) / VARIETY.envHistory;
  }

  pushEnv(env: string): void {
    this.envs.push(env);
    if (this.envs.length > VARIETY.envHistory) this.envs.shift();
  }

  pushBoss(b: string): void {
    this.bosses.push(b);
    if (this.bosses.length > VARIETY.bossHistory) this.bosses.shift();
  }

  toJSON() {
    return { envs: this.envs, bosses: this.bosses };
  }

  load(d: { envs?: string[]; bosses?: string[] } | undefined): void {
    if (!d) return;
    this.envs = d.envs ?? [];
    this.bosses = d.bosses ?? [];
  }
}
