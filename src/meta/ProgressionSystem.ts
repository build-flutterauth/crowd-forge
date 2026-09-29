// Coins, shop, upgrades, missions and achievements.
import { GAME, ENVIRONMENTS } from '../config/gameConfig';
import {
  ACHIEVEMENTS, CATEGORY_ITEMS, MISSIONS, UPGRADES, type ShopCategory, type StatKey,
} from '../config/metaConfig';
import type { EnvId } from '../core/types';
import { SaveSystem, type MissionState, type SaveData } from './SaveSystem';

export interface RunStats {
  mode: 'level' | 'endless' | 'lanes';
  won: boolean;
  maxArmy: number;
  enemiesDefeated: number;
  multGates: number;
  gatesTaken: number;
  bossesDefeated: number;
  rareEvents: number;
  lossPct: number; // only meaningful when won
  endlessDistance: number;
  bonusMult: number;
}

export interface RunRewards {
  missions: { text: string; reward: number }[];
  achievements: { name: string; tier: number; desc: string }[];
}

const TOTAL_STATS: StatKey[] = ['enemiesDefeated', 'multGates', 'bossesDefeated', 'levelsWon', 'gatesTaken', 'rareEvents'];

export class ProgressionSystem {
  data: SaveData;
  onChange: () => void = () => {};

  constructor(data: SaveData) {
    this.data = data;
    this.ensureMissions();
  }

  persist(): void {
    SaveSystem.save(this.data);
    this.onChange();
  }

  // ---------------- economy ----------------

  startArmy(): number {
    return GAME.startArmyBase + this.data.upgrades.startUnits;
  }

  coinMult(): number {
    return 1 + 0.1 * this.data.upgrades.coinBonus;
  }

  addCoins(n: number): void {
    this.data.coins += n;
    this.data.totalCoins += n;
  }

  isOwned(cat: ShopCategory, id: string): boolean {
    if (cat === 'envs') return this.data.envUnlocked.includes(id as EnvId);
    if (cat === 'special') return this.data.special.includes(id);
    return (this.data.owned[cat] ?? []).includes(id);
  }

  costOf(cat: ShopCategory, id: string): number {
    if (cat === 'envs') return ENVIRONMENTS[id as EnvId].unlockCost;
    if (cat === 'upgrades') {
      const u = UPGRADES[id as keyof typeof UPGRADES];
      return u.cost(this.data.upgrades[id as keyof SaveData['upgrades']]);
    }
    return CATEGORY_ITEMS[cat].find((i) => i.id === id)?.cost ?? Infinity;
  }

  buy(cat: ShopCategory, id: string): boolean {
    const cost = this.costOf(cat, id);
    if (this.data.coins < cost) return false;
    if (cat === 'upgrades') {
      const key = id as keyof SaveData['upgrades'];
      if (this.data.upgrades[key] >= UPGRADES[key].max) return false;
      this.data.upgrades[key]++;
    } else if (this.isOwned(cat, id)) return false;
    else if (cat === 'envs') this.data.envUnlocked.push(id as EnvId);
    else if (cat === 'special') this.data.special.push(id);
    else (this.data.owned[cat] ??= []).push(id);
    this.data.coins -= cost;
    if (cat !== 'upgrades' && cat !== 'envs' && cat !== 'special') this.equip(cat, id);
    this.persist();
    return true;
  }

  equip(cat: ShopCategory, id: string): void {
    if (cat === 'envs') {
      this.data.envPreferred = id as EnvId | 'random';
    } else {
      const map: Record<string, keyof SaveData['equipped']> = { skins: 'skin', colors: 'color', trails: 'trail', weapons: 'weapon', banners: 'banner', victory: 'victory' };
      const key = map[cat];
      if (key && this.isOwned(cat, id)) this.data.equipped[key] = id;
    }
    this.persist();
  }

  // ---------------- missions ----------------

  ensureMissions(): void {
    const d = this.data;
    d.missions = d.missions.filter((m) => MISSIONS.some((t) => t.id === m.id));
    const active = new Set(d.missions.map((m) => m.id));
    const pool = MISSIONS.filter((t) => !active.has(t.id) && (d.missionTier[t.id] ?? 0) < t.targets.length);
    let i = (d.stats.runs * 7 + d.level * 3) % Math.max(1, pool.length);
    while (d.missions.filter((m) => !m.done).length < 3 && pool.length) {
      const t = pool.splice(i % pool.length, 1)[0];
      i += 5;
      const tier = d.missionTier[t.id] ?? 0;
      d.missions.push({ id: t.id, tier, target: t.targets[tier], progress: t.lowerIsHarder ? 100 : 0, done: false });
    }
  }

  missionText(m: MissionState): string {
    return MISSIONS.find((t) => t.id === m.id)!.text(m.target);
  }

  missionReward(m: MissionState): number {
    return MISSIONS.find((t) => t.id === m.id)!.reward(m.tier);
  }

  private runValue(stat: StatKey, r: RunStats): number | null {
    switch (stat) {
      case 'maxArmy': return r.maxArmy;
      case 'enemiesDefeated': return r.enemiesDefeated;
      case 'multGates': return r.multGates;
      case 'gatesTaken': return r.gatesTaken;
      case 'bossesDefeated': return r.bossesDefeated;
      case 'rareEvents': return r.rareEvents;
      case 'flawlessFinish': return r.mode === 'level' && r.won ? r.lossPct : null;
      case 'endlessDistance': return r.mode === 'endless' ? r.endlessDistance : null;
      case 'bonusMult': return r.mode === 'level' && r.won ? r.bonusMult : null;
      case 'winStreak': return this.data.streak;
      case 'levelsWon': return r.mode === 'level' && r.won ? 1 : 0;
    }
  }

  /** Fold a finished run into stats, missions, achievements. */
  applyRun(r: RunStats): RunRewards {
    const d = this.data;
    const out: RunRewards = { missions: [], achievements: [] };
    d.stats.runs++;
    if (r.mode === 'level') {
      if (r.won) d.streak++;
      else {
        d.streak = 0;
        d.stats.deaths++;
      }
    }

    // lifetime stats
    for (const k of Object.keys(d.stats) as StatKey[]) {
      const v = this.runValue(k, r);
      if (v === null || v === undefined) continue;
      if (TOTAL_STATS.includes(k)) d.stats[k] += v;
      else if (k === 'flawlessFinish') d.stats[k] = Math.min(d.stats[k], v);
      else d.stats[k] = Math.max(d.stats[k], v);
    }

    // missions
    for (const m of d.missions) {
      if (m.done) continue;
      const t = MISSIONS.find((x) => x.id === m.id)!;
      const v = this.runValue(t.stat, r);
      if (v === null) continue;
      if (t.lowerIsHarder) m.progress = Math.min(m.progress, v);
      else if (t.scope === 'total') m.progress += v;
      else m.progress = Math.max(m.progress, v);
      const done = t.lowerIsHarder ? m.progress <= m.target : m.progress >= m.target;
      if (done) {
        m.done = true;
        const reward = t.reward(m.tier);
        this.addCoins(reward);
        out.missions.push({ text: t.text(m.target), reward });
        d.missionTier[m.id] = m.tier + 1;
      }
    }
    d.missions = d.missions.filter((m) => !m.done);
    this.ensureMissions();

    // achievements
    for (const a of ACHIEVEMENTS) {
      const have = d.achievements[a.id] ?? 0;
      const v = d.stats[a.stat];
      let tier = have;
      while (tier < a.tiers.length && (a.lowerIsHarder ? v <= a.tiers[tier] : v >= a.tiers[tier])) tier++;
      if (tier > have) {
        d.achievements[a.id] = tier;
        out.achievements.push({ name: a.name, tier, desc: a.desc(a.tiers[tier - 1]) });
        this.addCoins(100 * tier);
      }
    }
    this.persist();
    return out;
  }

  /** Live mission progress during a run (for HUD toasts) */
  liveMissionCheck(stat: StatKey, value: number): string | null {
    for (const m of this.data.missions) {
      const t = MISSIONS.find((x) => x.id === m.id)!;
      if (t.stat !== stat || t.scope !== 'run' || t.lowerIsHarder || m.done) continue;
      if (value >= m.target && m.progress < m.target) {
        m.progress = value;
        return t.text(m.target);
      }
    }
    return null;
  }
}
