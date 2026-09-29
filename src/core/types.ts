// Shared data shapes used by generation, simulation and gameplay.

export type GateOp =
  | 'add' | 'mul' | 'sub' | 'div'
  | 'clone' | 'doubleNext' | 'shield' | 'speed' | 'recruit'
  | 'mystery' | 'sacrifice' | 'split' | 'merge' | 'bet' | 'vault';

export interface GateSpec {
  op: GateOp;
  v: number;
  /** mystery: the real outcome (decided at generation, seeded) */
  hidden?: GateSpec;
  /** mystery: outcomes the gate could have been, used for worst/expected evaluation */
  pool?: GateSpec[];
  /** bet: seeded outcome */
  win?: boolean;
  golden?: boolean;
}

export type SegmentType =
  | 'gateChoice' | 'enemyBattle' | 'obstacle' | 'reward' | 'riskReward'
  | 'miniBoss' | 'recruitment' | 'narrowSurvival' | 'multiGatePuzzle' | 'combination'
  | 'finale';

export type RareEventId =
  | 'goldenGate' | 'horde' | 'jackpot' | 'gauntlet' | 'giantBattle'
  | 'doubleOrNothing' | 'rescue' | 'ambush' | 'shortcut';

export type Beat = 'decision' | 'reward' | 'battle' | 'breather' | 'obstacle' | 'bigReward' | 'majorBattle';

export type ObstacleId =
  | 'rotatingBar' | 'crusher' | 'movingWall' | 'swingingHammer' | 'spikeZone' | 'narrowPassage'
  | 'fallingObjects' | 'enemyTower' | 'projectileLauncher' | 'movingPlatforms' | 'lavaZone' | 'stealTrap';

export type EnvId =
  | 'grasslands' | 'desert' | 'snow' | 'volcanic' | 'castle' | 'futuristic'
  | 'jungle' | 'floating' | 'candy' | 'neon' | 'ruins';

export type BossId = 'giant' | 'tank' | 'castle' | 'dragon' | 'robot' | 'megaArmy';

export type EnemyKind = 'normal' | 'horde' | 'brute' | 'champion' | 'ambush';
export type Formation = 'block' | 'wedge' | 'line' | 'circle' | 'ranks' | 'scatter';

export interface LossModel { best: number; avg: number; worst: number }

export type SimOp =
  | { kind: 'gate'; gate: GateSpec }
  | { kind: 'enemy'; power: number; display: number; enemy: EnemyKind; formation: Formation }
  | { kind: 'obstacle'; obstacle: ObstacleId; length: number; intensity: number; loss: LossModel; seed: number }
  | { kind: 'pickup'; n: number; style: 'crowd' | 'cage' | 'ally' }
  | { kind: 'boss'; power: number; boss: BossId };

/** An op placed in the world. s = distance along track, x0..x1 = lateral span. */
export type WorldOp = SimOp & { s: number; x0: number; x1: number; id: number; stage: number };

export interface Route {
  x0: number;
  x1: number;
  ops: WorldOp[];
  label?: string;
}

export interface Stage {
  id: number;
  s: number;
  routes: Route[];
  /** Lane lock: army can't cross x while s in [s0,s1] */
  divider?: { x: number; s0: number; s1: number };
}

export interface PredictedRange {
  min: number; p25: number; med: number; p75: number; max: number; opt: number; optWorst: number;
  alive: number; // fraction of simulated population still alive
}

export interface ScoreBreakdown {
  novelty: number; difficulty: number; risk: number; spectacle: number;
  decision: number; pacing: number; growth: number; total: number;
}

export interface Segment {
  index: number;
  type: SegmentType;
  rare?: RareEventId;
  beat: Beat;
  s0: number;
  length: number;
  stages: Stage[];
  sig: string;
  keys: VarietyKeys;
  reason: string;
  scores?: ScoreBreakdown;
  before?: PredictedRange;
  after?: PredictedRange;
  candidatesTried?: number;
  rejections?: Record<string, number>;
}

export interface VarietyKeys {
  gates?: string;
  obstacle?: string;
  formation?: string;
  boss?: string;
  rare?: string;
}

export interface RunwayStep { mult: number; wall: number; s: number }

export interface LevelReport {
  valid: boolean;
  reasons: string[];
  optimalFinal: number;
  optimalWorstFinal: number;
  optimalMinMargin: number;
  deathRate: { random: number; casual: number; average: number; skilled: number };
  medianFinal: { random: number; casual: number; average: number; skilled: number };
  optimalDifficulty: number; // 0..1 how close the best route gets to failing
  averageDifficulty: number; // 0..1 death rate of average players
  typeShare: Record<string, number>;
  gateShare: Record<string, number>;
  maxCount: number;
}

export interface GenDecision {
  slot: number;
  beat: Beat;
  intensity: number;
  chosen: string;
  reason: string;
  candidates: { label: string; valid: boolean; score?: number; reject?: string }[];
}

export interface Level {
  mode: 'level' | 'endless';
  seed: number;
  code: string;
  attempt: number;
  levelNumber: number;
  difficulty: number;
  startArmy: number;
  env: EnvId;
  segments: Segment[];
  finishS: number;
  runway: RunwayStep[];
  runwayEnd: number;
  expectedFinish: number;
  bossId?: BossId;
  report: LevelReport;
  genLog: GenDecision[];
  genMs: number;
}
