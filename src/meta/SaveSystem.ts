// Persistent save data (localStorage, versioned, defensive against corruption).
import type { EnvId } from '../core/types';
import { SeedManager } from '../core/SeedManager';
import type { DirectorState } from '../gen/DifficultyDirector';
import type { StatKey } from '../config/metaConfig';

export interface MissionState {
  id: string;
  tier: number;
  target: number;
  progress: number;
  done: boolean;
}

export interface SaveData {
  v: 1;
  masterSeed: number;
  level: number;
  lanesLevel: number;
  arenaLevel: number;
  coins: number;
  totalCoins: number;
  owned: Record<string, string[]>;
  equipped: { skin: string; color: string; trail: string; weapon: string; banner: string; victory: string };
  upgrades: { startUnits: number; coinBonus: number };
  special: string[];
  envUnlocked: EnvId[];
  envPreferred: EnvId | 'random';
  missions: MissionState[];
  missionTier: Record<string, number>;
  achievements: Record<string, number>;
  stats: Record<StatKey, number> & { runs: number; deaths: number; playTime: number };
  streak: number;
  endlessBest: { distance: number; maxArmy: number; enemies: number; highestMult: number; score: number };
  director?: DirectorState;
  variety?: { envs?: string[]; bosses?: string[] };
  settings: { sound: boolean; haptics: boolean; quality: 'high' | 'low'; showHints: boolean; gameSpeed: number };
}

const KEY = 'crowdforge_save_v1';

export function defaultSave(): SaveData {
  return {
    v: 1,
    masterSeed: SeedManager.randomSeed(),
    level: 1,
    lanesLevel: 1,
    arenaLevel: 1,
    coins: 0,
    totalCoins: 0,
    owned: { skins: ['classic'], colors: ['blue'], trails: ['none'], weapons: ['none'], banners: ['none'], victory: ['cheer'], special: [] },
    equipped: { skin: 'classic', color: 'blue', trail: 'none', weapon: 'none', banner: 'none', victory: 'cheer' },
    upgrades: { startUnits: 0, coinBonus: 0 },
    special: [],
    envUnlocked: ['grasslands', 'desert', 'snow'],
    envPreferred: 'random',
    missions: [],
    missionTier: {},
    achievements: {},
    stats: {
      maxArmy: 0, enemiesDefeated: 0, multGates: 0, flawlessFinish: 100, bossesDefeated: 0, endlessDistance: 0,
      bonusMult: 0, winStreak: 0, levelsWon: 0, gatesTaken: 0, rareEvents: 0, runs: 0, deaths: 0, playTime: 0,
    },
    streak: 0,
    endlessBest: { distance: 0, maxArmy: 0, enemies: 0, highestMult: 0, score: 0 },
    settings: { sound: true, haptics: true, quality: 'high', showHints: true, gameSpeed: 1 },
  };
}

export const SaveSystem = {
  load(): SaveData {
    const d = defaultSave();
    try {
      const raw = localStorage.getItem(KEY);
      if (!raw) return d;
      const s = JSON.parse(raw) as Partial<SaveData>;
      return {
        ...d,
        ...s,
        owned: { ...d.owned, ...(s.owned ?? {}) },
        equipped: { ...d.equipped, ...(s.equipped ?? {}) },
        upgrades: { ...d.upgrades, ...(s.upgrades ?? {}) },
        stats: { ...d.stats, ...(s.stats ?? {}) },
        endlessBest: { ...d.endlessBest, ...(s.endlessBest ?? {}) },
        settings: { ...d.settings, ...(s.settings ?? {}) },
      } as SaveData;
    } catch {
      return d;
    }
  },

  save(d: SaveData): void {
    try {
      localStorage.setItem(KEY, JSON.stringify(d));
    } catch {
      /* storage unavailable (private mode) — keep playing */
    }
  },

  reset(): SaveData {
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
    return defaultSave();
  },
};
