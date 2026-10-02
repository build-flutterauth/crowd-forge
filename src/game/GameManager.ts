// Orchestrates a run: builds the world from generated segments, drives all
// gameplay systems each frame, records performance for the Difficulty
// Director, and reports results to meta progression.
import * as THREE from 'three';
import { sfx, haptic } from '../audio/SoundSystem';
import { ENVIRONMENTS, GAME } from '../config/gameConfig';
import { COLORS } from '../config/metaConfig';
import { GEN, RARE_EVENTS } from '../config/genConfig';
import { Rng, SeedManager } from '../core/SeedManager';
import type { EnvId, Level, Segment, WorldOp } from '../core/types';
import { DifficultyDirector, type RunRecord } from '../gen/DifficultyDirector';
import { EndlessGenerator, LevelGenerator, type ForceKind } from '../gen/LevelGenerator';
import { VarietyHistory } from '../gen/VarietyHistory';
import type { ProgressionSystem, RunRewards } from '../meta/ProgressionSystem';
import { EnvironmentRenderer } from '../render/EnvironmentRenderer';
import { CameraRig, Overlay, Particles } from '../render/Effects';
import { Stage3D } from '../render/Stage3D';
import { fmt } from '../sim/rules';
import { ArmyManager } from './ArmyManager';
import { BossManager } from './BossManager';
import { CombatSystem } from './CombatSystem';
import { EnemyManager } from './EnemyManager';
import { GateSystem, type GateEvent } from './GateSystem';
import { Input } from './Input';
import { ObstacleSystem } from './ObstacleSystem';
import { RewardSystem } from './RewardSystem';
import { LANES } from '../config/lanesConfig';
import { hashString } from '../core/SeedManager';
import type { LaneLevelData } from '../lanes/LaneSim';
import { LanesGenerator } from '../lanes/LanesGenerator';
import { LanesMode, type LanesStats } from '../lanes/LanesMode';
import { ARENA } from '../config/arenaConfig';
import type { ArenaLevelData } from '../arena/ArenaSim';
import { ArenaGenerator } from '../arena/ArenaGenerator';
import { ArenaMode, type ArenaStats } from '../arena/ArenaMode';

export type Phase = 'menu' | 'run' | 'dying' | 'runway' | 'over';

export interface HudState {
  mode: 'level' | 'endless' | 'lanes' | 'arena';
  sub?: string;
  level: number;
  progress: number;
  distance: number;
  army: number;
  boost: boolean;
  tier: number;
  debugLine: string;
}

export interface RunResult {
  mode: 'level' | 'endless' | 'lanes' | 'arena';
  lanes?: { time: number; castlePct: number; towers: number; reason: string; bestNote: string; seed: number };
  won: boolean;
  level: number;
  code: string;
  difficulty: number;
  finishArmy: number;
  maxArmy: number;
  mult: number;
  coinsBase: number;
  coinsBonus: number;
  coinsTotal: number;
  distance: number;
  enemies: number;
  highestMult: number;
  score: number;
  newBest: boolean;
  progress: number;
  rewards: RunRewards;
  lossPct: number;
}

export interface GameUI {
  hud(h: HudState): void;
  banner(text: string, cls?: string, dur?: number): void;
  toast(text: string): void;
  runEnded(r: RunResult): void;
}

interface RunTrack {
  startArmy: number;
  maxArmy: number;
  lost: number;
  gained: number;
  enemies: number;
  multGates: number;
  gatesTaken: number;
  bosses: number;
  rare: number;
  qSum: number;
  qN: number;
  rSum: number;
  rN: number;
  highestMult: number;
}

export interface DebugFlags {
  invincible: boolean;
  forceType: ForceKind | null;
  forceEnv: EnvId | null;
  difficulty: number | null;
  startArmy: number | null;
  showGen: boolean;
  seed: number | null;
  forceBoss: import('../core/types').BossId | null;
}

export class GameManager {
  readonly stage: Stage3D;
  readonly env: EnvironmentRenderer;
  readonly particles: Particles;
  readonly overlay: Overlay;
  readonly cam: CameraRig;
  readonly army: ArmyManager;
  readonly gates: GateSystem;
  readonly enemies: EnemyManager;
  readonly obstacles: ObstacleSystem;
  readonly bosses: BossManager;
  readonly combat: CombatSystem;
  readonly rewards: RewardSystem;
  readonly input: Input;
  readonly generator = new LevelGenerator();
  readonly lanesGen = new LanesGenerator();
  lanes: LanesMode | null = null;
  readonly arenaGen = new ArenaGenerator();
  arena: ArenaMode | null = null;
  readonly director = new DifficultyDirector();
  readonly variety = new VarietyHistory();
  readonly prog: ProgressionSystem;
  ui: GameUI | null = null;

  level: Level | null = null;
  endless: EndlessGenerator | null = null;
  phase: Phase = 'menu';
  paused = false;
  time = 0;
  private timeScale = 1;
  private slowT = 0;
  private boostT = 0;
  private dyingT = 0;
  private overT = 0;
  private endlessRatio = 1;
  private segEntered = new Set<number>();
  private run!: RunTrack;
  private genLabels: { el: HTMLDivElement; seg: Segment }[] = [];
  private segments: Segment[] = [];
  debug: DebugFlags = { invincible: false, forceType: null, forceEnv: null, difficulty: null, startArmy: null, showGen: false, seed: null, forceBoss: null };
  lastRetrySeed: number | null = null;

  constructor(canvas: HTMLCanvasElement, overlayRoot: HTMLDivElement, prog: ProgressionSystem) {
    this.prog = prog;
    this.stage = new Stage3D(canvas);
    this.env = new EnvironmentRenderer(this.stage);
    this.particles = new Particles(this.stage.scene);
    this.overlay = new Overlay(this.stage, overlayRoot);
    this.cam = new CameraRig(this.stage);
    const scene = this.stage.scene;
    this.army = new ArmyManager(scene, this.particles, this.overlay);
    this.gates = new GateSystem(scene, this.overlay, this.particles);
    this.enemies = new EnemyManager(scene, this.overlay, this.particles);
    this.obstacles = new ObstacleSystem(scene, this.particles, this.overlay, this.cam);
    this.bosses = new BossManager(scene, this.overlay, this.particles, this.cam);
    this.combat = new CombatSystem(this.overlay, this.particles, this.cam);
    this.rewards = new RewardSystem(scene, this.overlay, this.particles, this.cam);
    this.input = new Input(canvas);
    this.input.onFirstInteraction = () => sfx.unlock();

    this.director.load(prog.data.director);
    this.variety.load(prog.data.variety);
    this.setQuality(prog.data.settings.quality);
    this.wireEvents();
    this.resetRunTrack(5);
    this.showAttract();
  }

  // ------------------------------------------------------------------
  // events from systems
  // ------------------------------------------------------------------

  private wireEvents(): void {
    this.army.onLoss = (n) => (this.run.lost += n);
    this.gates.onGate = (e: GateEvent) => {
      const r = this.run;
      r.gatesTaken++;
      if (e.after > e.before) r.gained += e.after - e.before;
      if (e.gate.op === 'mul' || (e.gate.op === 'mystery' && e.gate.hidden?.op === 'mul')) {
        r.multGates++;
        r.highestMult = Math.max(r.highestMult, e.gate.op === 'mul' ? e.gate.v : e.gate.hidden!.v);
      }
      if (e.options > 1) {
        r.qSum += e.quality;
        r.qN++;
        r.rSum += e.reaction;
        r.rN++;
      }
    };
    this.gates.onBigGain = (ratio) => {
      this.slowmo(GAME.feel.slowmoTime);
      this.cam.shake(Math.min(0.5, 0.15 + Math.log10(ratio) * 0.2));
      haptic(50);
    };
    this.gates.onBoost = () => (this.boostT = GAME.track.boostDuration);
    this.enemies.onDefeated = (display) => (this.run.enemies += display);
    this.enemies.onEncounter = (op) => {
      if (op.enemy === 'horde') this.ui?.banner('HORDE!', 'danger');
      if (op.enemy === 'ambush') this.ui?.banner('AMBUSH!', 'danger');
      if (op.power > this.army.n * 0.6) this.slowmo(0.4);
    };
    this.combat.onResolved = (o, won) => {
      if (won && o.kind === 'enemy' && o.power >= 150) {
        this.slowmo(0.35);
        this.cam.shake(0.4);
      }
    };
    this.bosses.onIntro = (title) => {
      this.ui?.banner(`⚠ ${title} ⚠`, 'boss', 2.2);
    };
    this.bosses.onDefeated = (op) => {
      this.run.bosses++;
      this.run.enemies += op.power;
      this.slowmo(1.2);
    };
    this.rewards.onStep = (mult) => {
      this.run.highestMult = Math.max(this.run.highestMult, mult);
    };
    this.obstacles.onEnter = (op) => {
      if (op.intensity > 1.2) this.ui?.banner('DANGER', 'danger', 0.9);
    };
  }

  private resetRunTrack(start: number): void {
    this.run = { startArmy: start, maxArmy: start, lost: 0, gained: 0, enemies: 0, multGates: 0, gatesTaken: 0, bosses: 0, rare: 0, qSum: 0, qN: 0, rSum: 0, rN: 0, highestMult: 0 };
  }

  setQuality(q: 'high' | 'low'): void {
    this.stage.setQuality(q);
    this.env.density = q === 'high' ? 1 : 0.45;
  }

  slowmo(t: number): void {
    this.slowT = Math.max(this.slowT, t);
  }

  // ------------------------------------------------------------------
  // run setup
  // ------------------------------------------------------------------

  private clearWorld(): void {
    if (this.arena) {
      this.arena.dispose();
      this.arena = null;
      this.env.setHalfWidth(GAME.track.halfWidth);
      this.army.setVisible(true);
    }
    if (this.lanes) {
      this.lanes.dispose();
      this.lanes = null;
      this.env.setHalfWidth(GAME.track.halfWidth);
      this.army.setVisible(true);
    }
    this.gates.clear();
    this.enemies.clear();
    this.obstacles.clear();
    this.bosses.clear();
    this.rewards.clear();
    this.combat.cancel();
    this.overlay.clearFloaters();
    for (const g of this.genLabels) g.el.remove();
    this.genLabels = [];
    this.segments = [];
    this.segEntered.clear();
    this.env.setFinish(null);
    for (const m of this.dividerMeshes) {
      this.stage.scene.remove(m);
      m.geometry.dispose();
    }
    this.dividerMeshes = [];
    this.army.stopCelebrate();
    this.cam.orbit = 0;
    this.cam.closeup = 0;
  }

  private applyCosmetics(): void {
    const d = this.prog.data;
    this.army.setCosmetics({ ...d.equipped });
    this.army.playerMult = d.special.includes('knights') ? 1.12 : 1;
    this.enemies.archers = d.special.includes('archers');
    this.obstacles.medics = d.special.includes('medics');
  }

  private chooseEnv(seed: number): EnvId {
    if (this.debug.forceEnv) return this.debug.forceEnv;
    const d = this.prog.data;
    if (d.envPreferred !== 'random' && d.envUnlocked.includes(d.envPreferred)) return d.envPreferred;
    const env = this.generator.pickEnv(new Rng(seed).fork('env'), d.envUnlocked, this.variety);
    return env;
  }

  startingArmy(): number {
    return this.debug.startArmy ?? this.prog.startArmy();
  }

  /** Build (or rebuild) the current level. The level is fully determined by seed + difficulty + start army. */
  generateLevel(levelNumber: number, seed?: number): Level {
    const D = this.debug.difficulty ?? this.director.levelDifficulty(levelNumber);
    const s = seed ?? this.debug.seed ?? SeedManager.levelSeed(this.prog.data.masterSeed, levelNumber);
    const env = this.chooseEnv(s);
    return this.generator.generate({
      seed: s, levelNumber, difficulty: D, startArmy: this.startingArmy(), env,
      forceType: this.debug.forceType, forceBoss: this.debug.forceBoss,
    });
  }

  startLevel(opts: { levelNumber?: number; seed?: number; level?: Level } = {}): void {
    const n = opts.levelNumber ?? this.prog.data.level;
    const level = opts.level ?? this.generateLevel(n, opts.seed);
    this.clearWorld();
    this.level = level;
    this.endless = null;
    this.env.apply(level.env, level.seed);
    this.variety.pushEnv(level.env);
    if (level.bossId) this.variety.pushBoss(level.bossId);
    this.applyCosmetics();
    this.army.reset(level.startArmy);
    this.army.invincible = this.debug.invincible;
    this.input.reset();
    this.resetRunTrack(level.startArmy);
    for (const seg of level.segments) this.addSegment(seg);
    this.env.setFinish(level.finishS);
    this.rewards.build(level);
    this.phase = 'run';
    this.paused = false;
    this.time = 0;
    this.slowT = this.boostT = 0;
    this.cam.snap(0, 0);
    this.ui?.banner(`LEVEL ${level.levelNumber}`, 'level', 1.4);
  }

  startEndless(seed?: number): void {
    this.clearWorld();
    this.level = null;
    const s = seed ?? this.debug.seed ?? SeedManager.randomSeed();
    const start = this.startingArmy();
    this.endless = new EndlessGenerator(this.generator, s, start, GEN.runwayStart);
    this.endless.forceType = this.debug.forceType;
    this.endlessRatio = 1;
    const env = this.chooseEnv(s);
    this.env.apply(env, s);
    this.applyCosmetics();
    this.army.reset(start);
    this.army.invincible = this.debug.invincible;
    this.input.reset();
    this.resetRunTrack(start);
    this.streamEndless();
    this.phase = 'run';
    this.paused = false;
    this.time = 0;
    this.slowT = this.boostT = 0;
    this.cam.snap(0, 0);
    this.ui?.banner('ENDLESS', 'level', 1.4);
  }

  private addSegment(seg: Segment): void {
    this.segments.push(seg);
    for (const st of seg.stages) for (const r of st.routes) for (const op of r.ops) this.addOp(op);
    if (this.debug.showGen) this.addGenLabel(seg);
    if (seg.stages.some((s) => s.divider)) this.buildDividers(seg);
  }

  private addOp(op: WorldOp): void {
    switch (op.kind) {
      case 'gate':
      case 'pickup': this.gates.add(op); break;
      case 'enemy': this.enemies.add(op); break;
      case 'obstacle': this.obstacles.add(op); break;
      case 'boss': this.bosses.add(op); break;
    }
  }

  private dividerMeshes: THREE.Mesh[] = [];
  private buildDividers(seg: Segment): void {
    for (const st of seg.stages) {
      if (!st.divider) continue;
      const d = st.divider;
      const len = d.s1 - d.s0;
      const m = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.1, len), new THREE.MeshLambertMaterial({ color: '#ffffff' }));
      m.position.set(d.x, 0.55, -(d.s0 + len / 2));
      this.stage.scene.add(m);
      this.dividerMeshes.push(m);
    }
  }

  private addGenLabel(seg: Segment): void {
    const el = this.overlay.label('gen-label');
    const b = seg.before;
    el.innerHTML = `<b>#${seg.index} ${seg.rare ? '★' + seg.rare : seg.type}</b> <i>${seg.beat}</i>` +
      (b ? `<br>pred med ${fmt(b.med)} [${fmt(b.p25)}–${fmt(b.p75)}] opt ${fmt(b.opt)}` : '') +
      (seg.scores ? `<br>score ${(seg.scores.total * 100) | 0}` : '');
    this.genLabels.push({ el, seg });
  }

  setShowGen(v: boolean): void {
    this.debug.showGen = v;
    for (const g of this.genLabels) g.el.remove();
    this.genLabels = [];
    if (v) for (const s of this.segments) this.addGenLabel(s);
  }

  private streamEndless(): void {
    const e = this.endless;
    if (!e) return;
    let guard = 0;
    while (e.nextS < this.army.s + 240 && guard++ < 4) {
      const seg = e.next(this.endlessRatio, this.director.state.skill, this.director.state.modifier);
      this.addSegment(seg);
      if (seg.rare) this.run.rare++;
    }
  }

  /** Debug: jump to the start of the next segment. */
  skipForward(): void {
    if (this.phase !== 'run' || this.combat.fighting) return;
    const next = this.segments.find((s) => s.s0 > this.army.s + 2);
    if (next) {
      this.army.s = next.s0 - 6;
      for (const u of this.army.crowd.units) u.z = this.army.z;
      this.cam.snap(this.army.x, this.army.z);
    } else if (this.level) this.army.s = this.level.finishS - 5;
  }

  showAttract(): void {
    this.clearWorld();
    const env = this.prog.data.envPreferred !== 'random' ? this.prog.data.envPreferred : this.prog.data.envUnlocked[this.prog.data.level % this.prog.data.envUnlocked.length];
    this.env.apply(env, 7);
    this.applyCosmetics();
    this.army.reset(24);
    this.phase = 'menu';
    this.level = null;
    this.endless = null;
    this.cam.snap(0, 0);
  }

  // ------------------------------------------------------------------
  // frame
  // ------------------------------------------------------------------

  update(realDt: number): void {
    realDt = Math.min(realDt, 0.05);
    if (this.lanes) return this.updateLanes(realDt);
    if (this.arena) return this.updateArena(realDt);
    const target = this.bosses.introActive ? 0.22 : this.slowT > 0 ? GAME.feel.slowmoScale : 1;
    if (this.slowT > 0) this.slowT -= realDt;
    this.timeScale += (target - this.timeScale) * Math.min(1, realDt * 10);
    const dt = this.paused ? 0 : realDt * this.timeScale;
    this.time += dt;

    this.input.update(this.paused ? 0 : realDt);
    const playing = this.phase === 'run' || this.phase === 'runway';

    if (this.phase === 'menu') {
      this.army.s += dt * 4;
      this.army.targetX = Math.sin(this.time * 0.6) * 1.5;
      this.cam.orbit = Math.sin(this.time * 0.2) * 0.5;
    } else if (playing && !this.paused) {
      this.army.targetX = this.input.target;
      this.stepRun(dt);
    } else if (this.phase === 'dying') {
      this.dyingT -= realDt;
      if (this.dyingT <= 0) this.endRun(false);
    } else if (this.phase === 'over') {
      this.overT += realDt;
      this.cam.orbit = Math.min(0.9, this.overT * 0.25);
    }

    this.army.update(dt, this.time, playing && !this.paused && !this.combat.fighting);
    this.env.update(dt, this.army.s, this.cam.position);
    const r = this.army.radius;
    this.cam.targetZoom = Math.min(GAME.camera.maxExtraZoom, Math.max(0, r - 1.1) * GAME.camera.zoomPerRadius) + (this.combat.fighting ? -0.8 : 0);
    this.cam.update(realDt, this.army.x, this.army.z);
    this.particles.update(dt);
    this.overlay.update(realDt);
    for (const g of this.genLabels) {
      const vis = g.seg.s0 - this.army.s;
      if (vis > -10 && vis < 120) this.overlay.place(g.el, new THREE.Vector3(-GAME.track.halfWidth - 1.2, 0.2, -g.seg.s0));
      else g.el.style.display = 'none';
    }
    this.pushHud();
    this.stage.render();
  }

  private stepRun(dt: number): void {
    const a = this.army;
    const T = GAME.track;
    if (this.boostT > 0) this.boostT -= dt;

    // forward motion
    if (this.combat.fighting) {
      const o = this.combat.active!;
      const frontOff = a.front - a.s;
      a.s = Math.min(a.s + T.battleCreep * dt, o.contactS - frontOff + 0.3);
    } else if (this.phase === 'runway' && this.rewards.finished) {
      // halted in front of a wall
    } else if (!this.bosses.introActive) {
      a.s += T.forwardSpeed * (this.boostT > 0 ? T.boostMult : 1) * dt;
    }

    // lane locks from dividers (risk/reward routes)
    a.laneClamp = null;
    for (const seg of this.segments) {
      if (seg.s0 > a.s + 5 || seg.s0 + seg.length < a.s - 5) continue;
      for (const st of seg.stages) {
        const d = st.divider;
        if (d && a.s >= d.s0 - 1 && a.s <= d.s1) a.laneClamp = a.x < d.x ? [-T.halfWidth, d.x] : [d.x, T.halfWidth];
      }
      if (!this.segEntered.has(seg.index) && a.s >= seg.s0) {
        this.segEntered.add(seg.index);
        this.onEnterSegment(seg);
      }
    }

    this.gates.update(dt, this.time, a);
    this.enemies.update(dt, this.time, a, this.combat);
    this.obstacles.update(dt, this.time, a);
    this.bosses.update(dt, dt / Math.max(0.05, this.timeScale), this.time, a, this.combat);
    this.combat.update(dt, a);
    this.rewards.update(dt, this.time, a, this.combat);
    if (this.endless) this.streamEndless();
    this.cleanupDividers();

    if (a.n > this.run.maxArmy) {
      this.run.maxArmy = a.n;
      const m = this.prog.liveMissionCheck('maxArmy', a.n);
      if (m) this.ui?.toast('✔ ' + m);
    }

    if (this.phase === 'run' && a.n <= 0) {
      this.phase = 'dying';
      this.dyingT = 1.4;
      this.slowmo(1.4);
      sfx.play('lose');
      haptic(200);
      this.cam.shake(0.5);
      this.ui?.banner('DEFEATED', 'danger', 1.4);
      return;
    }

    if (this.phase === 'run' && this.level && a.s >= this.level.finishS && !this.combat.fighting) {
      this.phase = 'runway';
      this.run.maxArmy = Math.max(this.run.maxArmy, a.n);
      this.finishArmy = a.n;
      this.lostAtFinish = this.run.lost;
      this.rewards.start();
      this.ui?.banner('FINISH! BONUS RUN', 'golden', 1.6);
      sfx.play('win');
      this.slowmo(0.6);
    }
    if (this.phase === 'runway' && (this.rewards.finished || a.n <= 0)) {
      this.endRun(true);
    }
  }

  private finishArmy = 0;
  private lostAtFinish = 0;

  private onEnterSegment(seg: Segment): void {
    if (seg.rare) {
      this.run.rare += this.endless ? 0 : 1;
      this.ui?.banner(RARE_EVENTS[seg.rare].banner, 'rare', 1.6);
      sfx.play('rare');
    }
    if (this.endless && seg.before && seg.before.opt > 0) {
      // Record performance → adjust future generation: rescale predictions to the real army.
      this.endlessRatio = Math.max(0.25, Math.min(4, this.army.n / seg.before.opt));
    }
  }

  private cleanupDividers(): void {
    for (let i = this.dividerMeshes.length - 1; i >= 0; i--) {
      const m = this.dividerMeshes[i];
      if (-m.position.z < this.army.s - 60) {
        this.stage.scene.remove(m);
        m.geometry.dispose();
        this.dividerMeshes.splice(i, 1);
      }
    }
  }

  private pushHud(): void {
    if (!this.ui) return;
    const a = this.army;
    const lv = this.level;
    let debugLine = '';
    if (this.debug.showGen) {
      const seg = [...this.segments].reverse().find((s) => s.s0 <= a.s);
      if (seg?.before) {
        const b = seg.before;
        const af = seg.after!;
        debugLine = `#${seg.index} ${seg.rare ? '★' + seg.rare : seg.type} (${seg.beat}) · entry pred med ${fmt(b.med)} [${fmt(b.p25)}–${fmt(b.p75)}] opt ${fmt(b.opt)} → exit med ${fmt(af.med)} opt ${fmt(af.opt)} · you ${fmt(a.n)}`;
      }
    }
    this.ui.hud({
      mode: this.endless ? 'endless' : 'level',
      level: lv?.levelNumber ?? 0,
      progress: lv ? Math.min(1, a.s / lv.finishS) : 0,
      distance: a.s,
      army: a.n,
      boost: this.boostT > 0,
      tier: this.endless?.tier ?? 0,
      debugLine,
    });
  }

  // ------------------------------------------------------------------
  // end of run
  // ------------------------------------------------------------------

  private endRun(won: boolean): void {
    if (this.phase === 'over') return;
    this.phase = 'over';
    this.overT = 0;
    const a = this.army;
    const r = this.run;
    const lv = this.level;
    const d = this.prog.data;
    const coinMult = this.prog.coinMult();

    const progress = lv ? Math.min(1, a.s / lv.finishS) : 0;
    const finishArmy = won ? this.finishArmy : 0;
    const mult = won ? this.rewards.reached : 1;
    let coinsBase = 0;
    let coinsBonus = 0;
    let score = 0;
    let newBest = false;
    if (this.endless) {
      score = Math.round(a.s + 220 * Math.log10(1 + r.maxArmy) + 60 * Math.log10(1 + r.enemies));
      coinsBase = Math.round((a.s / 18 + Math.sqrt(r.enemies)) * coinMult);
      const b = d.endlessBest;
      newBest = score > b.score;
      b.distance = Math.max(b.distance, Math.round(a.s));
      b.maxArmy = Math.max(b.maxArmy, r.maxArmy);
      b.enemies = Math.max(b.enemies, r.enemies);
      b.highestMult = Math.max(b.highestMult, r.highestMult);
      b.score = Math.max(b.score, score);
    } else if (lv) {
      if (won) {
        coinsBase = RewardSystem.levelCoins(lv, finishArmy, coinMult);
        coinsBonus = RewardSystem.bonusCoins(lv, mult, coinMult);
      } else coinsBase = Math.round(RewardSystem.levelCoins(lv, r.maxArmy, coinMult) * 0.25 * progress);
    }
    this.prog.addCoins(coinsBase + coinsBonus);
    if (won && lv && lv.levelNumber === d.level && lv.seed === SeedManager.levelSeed(d.masterSeed, lv.levelNumber)) d.level++;

    const lostMain = won ? this.lostAtFinish : r.lost;
    const lossPct = Math.round((100 * lostMain) / Math.max(1, lostMain + finishArmy));
    const rec: RunRecord = {
      mode: this.endless ? 'endless' : 'level',
      level: lv?.levelNumber ?? 0,
      won,
      progress,
      startArmy: r.startArmy,
      finalArmy: finishArmy,
      maxArmy: r.maxArmy,
      unitsLost: r.lost,
      unitsGained: r.gained,
      enemiesDefeated: r.enemies,
      gatesChosen: r.gatesTaken,
      choiceQuality: r.qN ? r.qSum / r.qN : 0.5,
      avgReaction: r.rN ? r.rSum / r.rN : 0,
    };
    this.director.recordRun(rec);
    d.director = this.director.state;
    d.variety = this.variety.toJSON();
    d.stats.playTime += this.time;
    const rewards = this.prog.applyRun({
      mode: rec.mode, won, maxArmy: r.maxArmy, enemiesDefeated: r.enemies, multGates: r.multGates, gatesTaken: r.gatesTaken,
      bossesDefeated: r.bosses, rareEvents: r.rare, lossPct, endlessDistance: Math.round(a.s), bonusMult: mult,
    });

    if (won) {
      a.celebrate();
      sfx.play('coin');
    }
    this.ui?.runEnded({
      mode: rec.mode, won, level: lv?.levelNumber ?? 0, code: lv?.code ?? SeedManager.toCode(this.endless?.seed ?? 0),
      difficulty: lv?.difficulty ?? 0, finishArmy, maxArmy: r.maxArmy, mult, coinsBase, coinsBonus,
      coinsTotal: coinsBase + coinsBonus, distance: Math.round(a.s), enemies: r.enemies, highestMult: r.highestMult,
      score, newBest, progress, rewards, lossPct,
    });
  }

  // ------------------------------------------------------------------
  // Lane Battle mode
  // ------------------------------------------------------------------

  lanesSeed(level: number): number {
    return SeedManager.levelSeed(this.prog.data.masterSeed ^ hashString('lanes'), level);
  }

  generateLanes(level: number, seed?: number): LaneLevelData {
    const s = seed ?? this.debug.seed ?? this.lanesSeed(level);
    const D = this.debug.difficulty ?? this.director.levelDifficulty(level);
    const fireRate = LANES.fireRate + LANES.fireRatePerUpgrade * this.prog.data.upgrades.startUnits;
    return this.lanesGen.generate({ seed: s, level, D, fireRate, env: this.chooseEnv(s) });
  }

  startLanes(opts: { level?: number; seed?: number } = {}): void {
    const level = opts.level ?? this.prog.data.lanesLevel;
    const lv = this.generateLanes(level, opts.seed);
    this.clearWorld();
    this.level = null;
    this.endless = null;
    this.env.apply(lv.env, lv.seed);
    this.env.setHalfWidth(LANES.halfWidth);
    this.applyCosmetics();
    this.army.reset(1);
    this.army.setVisible(false);
    this.input.reset();
    const d = this.prog.data;
    const color = COLORS.find((c) => c.id === d.equipped.color)?.hex ?? '#2f8cff';
    this.lanes = new LanesMode(this.stage, this.particles, this.overlay, lv, { skin: d.equipped.skin, color, weapon: d.equipped.weapon });
    this.lanes.onBanner = (t, c, dur) => this.ui?.banner(t, c, dur);
    this.lanes.onEnd = (st) => this.endLanes(st);
    this.phase = 'run';
    this.paused = false;
    this.time = 0;
    this.ui?.banner(`LANE BATTLE ${level}`, 'level', 1.4);
  }

  private updateLanes(realDt: number): void {
    const ln = this.lanes!;
    if (ln.slowmo > 0) ln.slowmo -= realDt;
    const target = ln.slowmo > 0 ? 0.35 : 1;
    this.timeScale += (target - this.timeScale) * Math.min(1, realDt * 10);
    const dt = this.paused ? 0 : realDt * this.timeScale;
    this.time += dt;
    this.input.update(this.paused ? 0 : realDt);
    ln.update(dt, this.paused ? 0 : realDt, this.input.target, this.time);
    this.env.update(dt, 20, this.stage.camera.position);
    this.particles.update(dt);
    this.overlay.update(realDt);
    if (this.ui) {
      const lv = ln.lv;
      const left = Math.max(0, lv.maxTime - ln.t);
      this.ui.hud({
        mode: 'lanes', level: lv.level, progress: 1 - Math.max(0, ln.castle) / lv.castleHP, distance: 0, army: 0, boost: false, tier: 0,
        sub: `🏰 ${fmt(Math.max(0, Math.ceil(ln.castle)))} · ❤ ${fmt(Math.max(0, Math.ceil(ln.base)))} · ⏱ ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`,
        debugLine: this.debug.showGen ? `lanes ${lv.lanes.map((l) => l.kind).join(' | ')} · ${lv.report.notes[0]}` : '',
      });
    }
    this.stage.render();
  }

  private endLanes(st: LanesStats): void {
    const ln = this.lanes!;
    const lv = ln.lv;
    const d = this.prog.data;
    this.phase = 'over';
    const coinMult = this.prog.coinMult();
    const speedBonus = st.won ? Math.max(0, Math.min(0.8, (lv.targetTime * 1.3 - st.time) / lv.targetTime)) : 0;
    const coinsBase = Math.round((18 + 3 * lv.level) * coinMult * (st.won ? 1 : 0.25 * st.castlePct + 0.1));
    const coinsBonus = Math.round((18 + 3 * lv.level) * coinMult * speedBonus);
    this.prog.addCoins(coinsBase + coinsBonus);
    if (st.won && lv.level === d.lanesLevel && lv.seed === this.lanesSeed(lv.level)) d.lanesLevel++;
    this.director.recordRun({
      mode: 'lanes', level: lv.level, won: st.won, progress: st.castlePct, startArmy: 1, finalArmy: st.won ? 1 : 0,
      maxArmy: st.peak, unitsLost: 0, unitsGained: 0, enemiesDefeated: st.kills, gatesChosen: 0, choiceQuality: st.won ? 0.8 : 0.4, avgReaction: 0,
    });
    d.director = this.director.state;
    d.stats.playTime += this.time;
    const rewards = this.prog.applyRun({
      mode: 'lanes', won: st.won, maxArmy: st.peak, enemiesDefeated: Math.round(st.kills), multGates: 0, gatesTaken: 0,
      bossesDefeated: 0, rareEvents: 0, lossPct: 0, endlessDistance: 0, bonusMult: 0,
    });
    this.ui?.runEnded({
      mode: 'lanes', won: st.won, level: lv.level, code: lv.code, difficulty: lv.D, finishArmy: 0, maxArmy: Math.round(st.peak),
      mult: 1, coinsBase, coinsBonus, coinsTotal: coinsBase + coinsBonus, distance: 0, enemies: Math.round(st.kills), highestMult: 0,
      score: 0, newBest: false, progress: st.castlePct, rewards, lossPct: 0,
      lanes: { time: st.time, castlePct: st.castlePct, towers: st.towersBroken, reason: st.reason, bestNote: lv.report.best.name.replace('Smart, focus ', ''), seed: lv.seed },
    });
  }

  // ------------------------------------------------------------------
  // Arena (main mode)
  // ------------------------------------------------------------------

  arenaSeed(level: number): number {
    return SeedManager.levelSeed(this.prog.data.masterSeed ^ hashString('arena'), level);
  }

  generateArena(level: number, seed?: number): ArenaLevelData {
    const s = seed ?? this.debug.seed ?? this.arenaSeed(level);
    const D = this.debug.difficulty ?? this.director.levelDifficulty(level);
    const fireRate = ARENA.fireRate + ARENA.fireRatePerUpgrade * this.prog.data.upgrades.startUnits;
    return this.arenaGen.generate({ seed: s, level, D, fireRate, env: this.chooseEnv(s) });
  }

  startArena(opts: { level?: number; seed?: number } = {}): void {
    const level = opts.level ?? this.prog.data.arenaLevel;
    const lv = this.generateArena(level, opts.seed);
    this.clearWorld();
    this.level = null;
    this.endless = null;
    this.env.apply(lv.env, lv.seed);
    this.env.setHalfWidth(ARENA.halfWidth);
    this.applyCosmetics();
    this.army.reset(1);
    this.army.setVisible(false);
    this.input.reset();
    const d = this.prog.data;
    const color = COLORS.find((c) => c.id === d.equipped.color)?.hex ?? '#2f8cff';
    this.arena = new ArenaMode(this.stage, this.particles, this.overlay, lv, { skin: d.equipped.skin, color, weapon: d.equipped.weapon });
    this.arena.onBanner = (t, c, dur) => this.ui?.banner(t, c, dur);
    this.arena.onEnd = (st) => this.endArena(st);
    this.phase = 'run';
    this.paused = false;
    this.time = 0;
    this.ui?.banner(`LEVEL ${level}`, 'level', 1.4);
  }

  private updateArena(realDt: number): void {
    const ar = this.arena!;
    if (ar.slowmo > 0) ar.slowmo -= realDt;
    const target = ar.slowmo > 0 ? 0.35 : 1;
    this.timeScale += (target - this.timeScale) * Math.min(1, realDt * 10);
    const dt = this.paused ? 0 : realDt * this.timeScale;
    this.time += dt;
    this.input.update(this.paused ? 0 : realDt);
    ar.update(dt, this.paused ? 0 : realDt, this.input.target, this.time);
    this.env.update(dt, 20, this.stage.camera.position);
    this.particles.update(dt);
    this.overlay.update(realDt);
    if (this.ui) {
      const lv = ar.lv;
      const left = Math.max(0, lv.maxTime - ar.t);
      this.ui.hud({
        mode: 'arena', level: lv.level, progress: 1 - Math.max(0, ar.castle) / lv.castleHP, distance: 0, army: 0, boost: false, tier: 0,
        sub: `🏰 ${fmt(Math.max(0, Math.ceil(ar.castle)))} · ❤ ${fmt(Math.max(0, Math.ceil(ar.base)))} · ⏱ ${Math.floor(left / 60)}:${String(Math.floor(left % 60)).padStart(2, '0')}`,
        debugLine: this.debug.showGen ? `bays ${lv.bays.map((b) => b.kind).join(' | ')} · ${lv.report.notes[0]}` : '',
      });
    }
    this.stage.render();
  }

  private endArena(st: ArenaStats): void {
    const lv = this.arena!.lv;
    const d = this.prog.data;
    this.phase = 'over';
    const coinMult = this.prog.coinMult();
    const speedBonus = st.won ? Math.max(0, Math.min(0.8, (lv.targetTime * 1.3 - st.time) / lv.targetTime)) : 0;
    const base = (20 + 3 * lv.level) * coinMult;
    const coinsBase = Math.round(base * (st.won ? 1 : 0.25 * st.castlePct + 0.1));
    const coinsBonus = Math.round(base * speedBonus);
    this.prog.addCoins(coinsBase + coinsBonus);
    if (st.won && lv.level === d.arenaLevel && lv.seed === this.arenaSeed(lv.level)) d.arenaLevel++;
    this.director.recordRun({
      mode: 'arena', level: lv.level, won: st.won, progress: st.castlePct, startArmy: 1, finalArmy: st.won ? 1 : 0,
      maxArmy: st.peak, unitsLost: 0, unitsGained: 0, enemiesDefeated: st.kills, gatesChosen: 0, choiceQuality: st.won ? 0.8 : 0.4, avgReaction: 0,
    });
    d.director = this.director.state;
    d.stats.playTime += this.time;
    const rewards = this.prog.applyRun({
      mode: 'arena', won: st.won, maxArmy: st.peak, enemiesDefeated: Math.round(st.kills), multGates: 0, gatesTaken: 0,
      bossesDefeated: 0, rareEvents: 0, lossPct: 0, endlessDistance: 0, bonusMult: 0,
    });
    this.ui?.runEnded({
      mode: 'arena', won: st.won, level: lv.level, code: lv.code, difficulty: lv.D, finishArmy: 0, maxArmy: Math.round(st.peak),
      mult: 1, coinsBase, coinsBonus, coinsTotal: coinsBase + coinsBonus, distance: 0, enemies: Math.round(st.kills), highestMult: 0,
      score: 0, newBest: false, progress: st.castlePct, rewards, lossPct: 0,
      lanes: { time: st.time, castlePct: st.castlePct, towers: st.hedges, reason: st.reason, bestNote: lv.report.best.name.replace('Smart, target ', ''), seed: lv.seed },
    });
  }

  quitToMenu(): void {
    this.paused = false;
    this.showAttract();
  }

  envName(): string {
    return ENVIRONMENTS[this.env.env].name;
  }
}
