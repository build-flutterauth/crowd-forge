// Meta progression data: shop items, upgrades, missions, achievements.

export interface ShopItem {
  id: string;
  name: string;
  cost: number;
  hex?: string;
  desc?: string;
}

export const SKINS: ShopItem[] = [
  { id: 'classic', name: 'Classic', cost: 0 },
  { id: 'bot', name: 'Cube Bot', cost: 300 },
  { id: 'blob', name: 'Blob', cost: 450 },
  { id: 'wizard', name: 'Wizard', cost: 650 },
  { id: 'knight', name: 'Knight', cost: 900 },
  { id: 'ninja', name: 'Ninja', cost: 1200 },
];

export const COLORS: ShopItem[] = [
  { id: 'blue', name: 'Royal Blue', cost: 0, hex: '#2f8cff' },
  { id: 'cyan', name: 'Aqua', cost: 150, hex: '#1fd1c9' },
  { id: 'green', name: 'Lime', cost: 150, hex: '#3ccf4e' },
  { id: 'yellow', name: 'Sunny', cost: 200, hex: '#ffc21a' },
  { id: 'orange', name: 'Tangerine', cost: 200, hex: '#ff8a1f' },
  { id: 'purple', name: 'Violet', cost: 250, hex: '#8a4dff' },
  { id: 'pink', name: 'Bubblegum', cost: 250, hex: '#ff5fb0' },
  { id: 'white', name: 'Ivory', cost: 300, hex: '#f2f2f2' },
  { id: 'black', name: 'Shadow', cost: 350, hex: '#39404d' },
  { id: 'gold', name: 'Gold', cost: 1500, hex: '#ffcc33' },
];

export const TRAILS: ShopItem[] = [
  { id: 'none', name: 'None', cost: 0 },
  { id: 'dust', name: 'Dust', cost: 200 },
  { id: 'sparkle', name: 'Sparkles', cost: 400, hex: '#fff27a' },
  { id: 'hearts', name: 'Hearts', cost: 600, hex: '#ff5fa2' },
  { id: 'fire', name: 'Fire', cost: 750, hex: '#ff7a1a' },
  { id: 'rainbow', name: 'Rainbow', cost: 1200 },
];

export const WEAPONS: ShopItem[] = [
  { id: 'none', name: 'Bare Hands', cost: 0 },
  { id: 'sword', name: 'Sword', cost: 350 },
  { id: 'spear', name: 'Spear', cost: 450 },
  { id: 'shield', name: 'Shield', cost: 500 },
  { id: 'hammer', name: 'Hammer', cost: 650 },
  { id: 'staff', name: 'Magic Staff', cost: 850 },
];

export const BANNERS: ShopItem[] = [
  { id: 'none', name: 'No Banner', cost: 0 },
  { id: 'flag', name: 'Team Flag', cost: 200 },
  { id: 'star', name: 'Star Banner', cost: 400, hex: '#ffd23f' },
  { id: 'skull', name: 'Skull Banner', cost: 600, hex: '#222222' },
  { id: 'dragon', name: 'Dragon Banner', cost: 850, hex: '#c0392b' },
  { id: 'crown', name: 'Royal Crown', cost: 1500, hex: '#ffcc33' },
];

export const VICTORY: ShopItem[] = [
  { id: 'cheer', name: 'Cheer', cost: 0 },
  { id: 'jump', name: 'Jump', cost: 300 },
  { id: 'spin', name: 'Spin', cost: 400 },
  { id: 'wave', name: 'Stadium Wave', cost: 550 },
  { id: 'fireworks', name: 'Fireworks', cost: 900 },
];

export const SPECIAL_UNITS: ShopItem[] = [
  { id: 'knights', name: 'Knights', cost: 1500, desc: '+12% battle power' },
  { id: 'archers', name: 'Archers', cost: 2200, desc: 'Opening volley removes 8% of every enemy group' },
  { id: 'medics', name: 'Medics', cost: 2600, desc: 'Recover 25% of units lost to obstacles' },
];

export const UPGRADES = {
  startUnits: { name: 'Starting Recruits', max: 25, cost: (lvl: number) => Math.round(60 * Math.pow(1.32, lvl)) },
  coinBonus: { name: 'Coin Magnet', max: 10, cost: (lvl: number) => Math.round(150 * Math.pow(1.45, lvl)) },
};

export type ShopCategory = 'skins' | 'colors' | 'trails' | 'weapons' | 'banners' | 'victory' | 'special' | 'envs' | 'upgrades';

export const CATEGORY_ITEMS: Record<Exclude<ShopCategory, 'envs' | 'upgrades'>, ShopItem[]> = {
  skins: SKINS,
  colors: COLORS,
  trails: TRAILS,
  weapons: WEAPONS,
  banners: BANNERS,
  victory: VICTORY,
  special: SPECIAL_UNITS,
};

// ------------------------------------------------------------------
// Missions: rolling set, each completion advances that mission's tier
// ------------------------------------------------------------------

export type StatKey =
  | 'maxArmy' | 'enemiesDefeated' | 'multGates' | 'flawlessFinish' | 'bossesDefeated'
  | 'endlessDistance' | 'bonusMult' | 'winStreak' | 'levelsWon' | 'gatesTaken' | 'rareEvents';

export interface MissionTemplate {
  id: string;
  stat: StatKey;
  /** 'run' = must be achieved in a single run, 'total' = accumulates */
  scope: 'run' | 'total';
  text: (target: number) => string;
  targets: number[];
  reward: (tier: number) => number;
  /** for flawless: lower is harder */
  lowerIsHarder?: boolean;
}

export const MISSIONS: MissionTemplate[] = [
  { id: 'army', stat: 'maxArmy', scope: 'run', text: (n) => `Reach ${n.toLocaleString()} units`, targets: [100, 250, 500, 1000, 2500, 5000, 10000, 50000, 250000], reward: (t) => 60 + t * 45 },
  { id: 'kills', stat: 'enemiesDefeated', scope: 'total', text: (n) => `Defeat ${n.toLocaleString()} enemies`, targets: [300, 800, 2000, 5000, 15000, 50000, 200000], reward: (t) => 50 + t * 50 },
  { id: 'mult', stat: 'multGates', scope: 'total', text: (n) => `Use ${n} multiplier gates`, targets: [5, 12, 25, 50, 100, 250], reward: (t) => 40 + t * 40 },
  { id: 'flawless', stat: 'flawlessFinish', scope: 'run', lowerIsHarder: true, text: (n) => `Finish a level losing no more than ${n}% of your army`, targets: [40, 30, 20, 12, 6], reward: (t) => 80 + t * 60 },
  { id: 'boss', stat: 'bossesDefeated', scope: 'total', text: (n) => `Defeat ${n} boss${n > 1 ? 'es' : ''}`, targets: [1, 3, 6, 12, 25], reward: (t) => 90 + t * 60 },
  { id: 'endless', stat: 'endlessDistance', scope: 'run', text: (n) => `Travel ${n.toLocaleString()}m in Endless`, targets: [500, 1200, 2500, 5000, 10000], reward: (t) => 70 + t * 60 },
  { id: 'bonus', stat: 'bonusMult', scope: 'run', text: (n) => `Reach ×${n} on the bonus runway`, targets: [3, 5, 10, 25, 50, 100], reward: (t) => 60 + t * 55 },
  { id: 'streak', stat: 'winStreak', scope: 'run', text: (n) => `Win ${n} levels in a row`, targets: [2, 3, 5, 8, 12], reward: (t) => 70 + t * 50 },
  { id: 'rare', stat: 'rareEvents', scope: 'total', text: (n) => `Encounter ${n} rare events`, targets: [3, 8, 20, 50], reward: (t) => 60 + t * 50 },
];

export interface AchievementDef {
  id: string;
  name: string;
  stat: StatKey;
  tiers: number[];
  desc: (n: number) => string;
  lowerIsHarder?: boolean;
}

export const ACHIEVEMENTS: AchievementDef[] = [
  { id: 'legion', name: 'Legion', stat: 'maxArmy', tiers: [100, 1000, 10000, 100000, 1000000], desc: (n) => `Command ${n.toLocaleString()} units at once` },
  { id: 'slayer', name: 'Slayer', stat: 'enemiesDefeated', tiers: [1000, 10000, 100000, 1000000], desc: (n) => `Defeat ${n.toLocaleString()} enemies in total` },
  { id: 'multiplier', name: 'Multiplier Maniac', stat: 'multGates', tiers: [10, 50, 200, 1000], desc: (n) => `Pass through ${n} multiplier gates` },
  { id: 'kingslayer', name: 'Kingslayer', stat: 'bossesDefeated', tiers: [1, 5, 20, 50], desc: (n) => `Defeat ${n} bosses` },
  { id: 'marathon', name: 'Marathon', stat: 'endlessDistance', tiers: [1000, 5000, 15000, 40000], desc: (n) => `Travel ${n.toLocaleString()}m in one Endless run` },
  { id: 'highroller', name: 'High Roller', stat: 'bonusMult', tiers: [10, 50, 100, 500, 1000], desc: (n) => `Reach ×${n} on the bonus runway` },
  { id: 'veteran', name: 'Veteran', stat: 'levelsWon', tiers: [5, 25, 100, 250], desc: (n) => `Win ${n} levels` },
  { id: 'untouchable', name: 'Untouchable', stat: 'flawlessFinish', tiers: [20, 10, 5, 1], lowerIsHarder: true, desc: (n) => `Finish a level losing ≤ ${n}% of your army` },
  { id: 'unstoppable', name: 'Unstoppable', stat: 'winStreak', tiers: [3, 7, 15, 30], desc: (n) => `Win ${n} levels in a row` },
  { id: 'explorer', name: 'Rare Hunter', stat: 'rareEvents', tiers: [5, 25, 100], desc: (n) => `Encounter ${n} rare events` },
];
