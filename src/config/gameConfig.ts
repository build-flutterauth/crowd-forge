// Gameplay feel + rendering tunables.
import type { EnvId } from '../core/types';

export const GAME = {
  track: {
    halfWidth: 5,
    steerLimit: 4.4,
    forwardSpeed: 11,
    battleCreep: 1.2,
    boostMult: 1.55,
    boostDuration: 3.2,
    steerSmoothing: 14,
    keySteerSpeed: 11,
    dragSensitivity: 1.35, // track widths per screen width
  },
  army: {
    renderCap: 320,
    spiral: 0.235,
    unitScale: 1,
    spawnWindow: 0.55,
    speedChargeMult: 1.3,
    trailRate: 30,
  },
  enemy: {
    renderCap: 260,
    spiral: 0.26,
  },
  battle: {
    minDuration: 0.55,
    maxDuration: 2.2,
    bossMinDuration: 2.4,
    bossMaxDuration: 4.2,
  },
  camera: {
    height: 9.5,
    distance: 11.5,
    lookAhead: 9,
    zoomPerRadius: 1.4,
    maxExtraZoom: 9,
    fov: 55,
  },
  feel: {
    bigGainRatio: 4,
    slowmoScale: 0.35,
    slowmoTime: 0.55,
  },
  startArmyBase: 5,
};

export interface EnvDef {
  name: string;
  sky: [string, string];
  fog: string;
  fogNear: number;
  fogFar: number;
  ground: string;
  track: [string, string];
  rail: string;
  hemi: [string, string, number];
  sun: [string, number];
  deco: 'trees' | 'cacti' | 'pines' | 'rocks' | 'towers' | 'buildings' | 'palms' | 'islands' | 'lollipops' | 'neon' | 'columns';
  decoColors: string[];
  particles: 'none' | 'sand' | 'snow' | 'embers' | 'leaves' | 'sparkles' | 'fireflies' | 'dust';
  noGround?: boolean;
  unlockCost: number;
}

export const ENVIRONMENTS: Record<EnvId, EnvDef> = {
  grasslands: {
    name: 'Grasslands', sky: ['#5fb8f5', '#e3f5ff'], fog: '#d5eefc', fogNear: 60, fogFar: 190,
    ground: '#6dc75a', track: ['#f4e9cf', '#ecdcb6'], rail: '#b98b5d',
    hemi: ['#ffffff', '#5f9e47', 0.95], sun: ['#fff3d6', 1.35], deco: 'trees',
    decoColors: ['#3f9d3a', '#58b947', '#2f7d30', '#8b5a2b'], particles: 'none', unlockCost: 0,
  },
  desert: {
    name: 'Desert', sky: ['#f5a55f', '#ffe9c7'], fog: '#f8dcb4', fogNear: 55, fogFar: 180,
    ground: '#e8c27a', track: ['#fbe7c0', '#f3d9a6'], rail: '#b77a3e',
    hemi: ['#fff5e0', '#c89a55', 1.0], sun: ['#ffe2b0', 1.4], deco: 'cacti',
    decoColors: ['#4e9a45', '#3e7f37', '#c9955a', '#a8743f'], particles: 'sand', unlockCost: 0,
  },
  snow: {
    name: 'Snowfields', sky: ['#9cc8ec', '#f2f8ff'], fog: '#e6f0fa', fogNear: 45, fogFar: 160,
    ground: '#f4f8fc', track: ['#dfe9f3', '#d2e0ee'], rail: '#8aa3bd',
    hemi: ['#ffffff', '#a9c2dc', 1.0], sun: ['#ffffff', 1.1], deco: 'pines',
    decoColors: ['#2f6b4f', '#3f7f5f', '#ffffff', '#6b4a2f'], particles: 'snow', unlockCost: 0,
  },
  volcanic: {
    name: 'Volcanic', sky: ['#2a0f12', '#a13a1c'], fog: '#5a1e14', fogNear: 40, fogFar: 150,
    ground: '#2a2222', track: ['#4a3e3a', '#3f3431'], rail: '#ff6a2a',
    hemi: ['#ffb38a', '#3a1010', 0.8], sun: ['#ff8a4a', 1.2], deco: 'rocks',
    decoColors: ['#3a302e', '#241d1c', '#ff5a1f', '#ffae3a'], particles: 'embers', unlockCost: 400,
  },
  castle: {
    name: 'Castle Keep', sky: ['#7aa4d6', '#dfe8f5'], fog: '#cfd9e8', fogNear: 55, fogFar: 175,
    ground: '#6f9a58', track: ['#b8b2a6', '#aaa396'], rail: '#6e655a',
    hemi: ['#ffffff', '#6b7a58', 0.95], sun: ['#fff0d0', 1.25], deco: 'towers',
    decoColors: ['#a09a90', '#8a8378', '#c0392b', '#2c3e50'], particles: 'none', unlockCost: 500,
  },
  futuristic: {
    name: 'Future City', sky: ['#4b6cb7', '#c3d3f5'], fog: '#aebfe6', fogNear: 55, fogFar: 185,
    ground: '#3b4252', track: ['#dfe6ee', '#cfd8e3'], rail: '#00c8ff',
    hemi: ['#e6f0ff', '#3b4252', 0.95], sun: ['#ffffff', 1.2], deco: 'buildings',
    decoColors: ['#5c6b82', '#7a8aa3', '#00d2ff', '#ff4fd8'], particles: 'none', unlockCost: 700,
  },
  jungle: {
    name: 'Jungle', sky: ['#5fae8f', '#dff5e6'], fog: '#bfe3cc', fogNear: 45, fogFar: 160,
    ground: '#3f8f3a', track: ['#d9c79a', '#cdb986'], rail: '#7a5230',
    hemi: ['#f4fff0', '#2f6f2a', 1.0], sun: ['#fff7c9', 1.2], deco: 'palms',
    decoColors: ['#2e8b3a', '#1f6f2d', '#8a5a2b', '#e0c050'], particles: 'leaves', unlockCost: 500,
  },
  floating: {
    name: 'Sky Islands', sky: ['#7cc7ff', '#ffffff'], fog: '#e4f4ff', fogNear: 60, fogFar: 200,
    ground: '#86d06f', track: ['#fff4de', '#f7e6c4'], rail: '#e0a45a',
    hemi: ['#ffffff', '#9fd4ff', 1.05], sun: ['#fffbe8', 1.2], deco: 'islands',
    decoColors: ['#7ccf5f', '#a57a52', '#ffffff', '#ffd66b'], particles: 'sparkles', noGround: true, unlockCost: 900,
  },
  candy: {
    name: 'Candy Land', sky: ['#ff9ad5', '#fff0fa'], fog: '#ffd9ef', fogNear: 55, fogFar: 180,
    ground: '#ffc2e2', track: ['#fff7fb', '#ffe8f4'], rail: '#ff6fb5',
    hemi: ['#ffffff', '#ff9ad5', 1.05], sun: ['#fff5fb', 1.2], deco: 'lollipops',
    decoColors: ['#ff5fa2', '#7fd6ff', '#ffe36e', '#a0f0b0'], particles: 'sparkles', unlockCost: 900,
  },
  neon: {
    name: 'Neon Night', sky: ['#07061a', '#2a0d4a'], fog: '#150b2e', fogNear: 40, fogFar: 150,
    ground: '#0d0b1f', track: ['#1f1b3a', '#191632'], rail: '#ff2fd0',
    hemi: ['#8a7cff', '#110822', 0.75], sun: ['#b0a0ff', 0.7], deco: 'neon',
    decoColors: ['#ff2fd0', '#00f0ff', '#faff00', '#7a2cff'], particles: 'fireflies', unlockCost: 1200,
  },
  ruins: {
    name: 'Ancient Ruins', sky: ['#d9a86c', '#f7ecd8'], fog: '#eadcc0', fogNear: 50, fogFar: 170,
    ground: '#a9a26a', track: ['#e6dcc4', '#d9cdb1'], rail: '#8c7a58',
    hemi: ['#fff8ea', '#8a7a4a', 0.95], sun: ['#ffe7c0', 1.3], deco: 'columns',
    decoColors: ['#d8ceb6', '#bfb49a', '#6f8f4a', '#8c7a58'], particles: 'dust', unlockCost: 700,
  },
};
