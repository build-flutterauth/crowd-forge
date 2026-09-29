// Constrained procedural level generation.
//
//   GENERATE CANDIDATES → SIMULATE → REJECT BAD → SCORE VALID → SELECT → (play) → RECORD → ADJUST
//
// For every slot the generator creates many candidate segments, runs them
// through the offline simulator (optimal route + a population of simulated
// players), throws away anything unfair or broken, scores the rest with the
// Fun Director and picks among the best. Whole levels are then validated
// again end-to-end and regenerated (deterministically) if they fail.
import { BOSSES, BOSS_MIN_LEVEL, GEN, RARE_EVENTS, SEGMENT_TYPES } from '../config/genConfig';
import { ENVIRONMENTS } from '../config/gameConfig';
import { Rng, SeedManager } from '../core/SeedManager';
import type {
  Beat, BossId, EnvId, GenDecision, Level, LevelReport, RareEventId, RunwayStep, ScoreBreakdown, Segment,
  SegmentType, Stage, WorldOp,
} from '../core/types';
import {
  aliveFrac, bestPath, clonePopulation, makePopulation, newResult, populationRange, quantile, runStage,
  stepPopulation, type Agent,
} from '../sim/Simulator';
import { cloneArmy, newArmy, type ArmyState } from '../sim/rules';
import { sampleCurve } from './DifficultyDirector';
import { FunDirector, type CandidateMetrics } from './FunDirector';
import { SegmentGenerator, type GenCtx, type SegmentDraft } from './SegmentGenerator';
import { VarietyHistory } from './VarietyHistory';

export type ForceKind = SegmentType | `rare:${RareEventId}`;

export interface GenParams {
  seed: number;
  levelNumber: number;
  difficulty: number;
  startArmy: number;
  env?: EnvId;
  forceType?: ForceKind | null;
  forceBoss?: BossId | null;
}

interface SlotState {
  opt: ArmyState;
  optWorst: ArmyState;
  pop: Agent[];
  hist: VarietyHistory;
  s: number;
  opId: number;
  stageId: number;
  rareCount: number;
  segIndex: number;
}

interface SlotParams {
  rng: Rng;
  level: number;
  D: number;
  I: number;
  progress: number;
  beat: Beat;
  growthTarget: number;
  mode: 'level' | 'endless';
  tier: number;
  forced?: ForceKind | null;
  rareChance: number;
}

interface Evaluated {
  draft: SegmentDraft;
  seg: Segment;
  opt: ArmyState;
  optWorst: ArmyState;
  pop: Agent[];
  score: ScoreBreakdown;
  metrics: CandidateMetrics;
}

const SEG_TYPES = Object.keys(SEGMENT_TYPES) as Exclude<SegmentType, 'finale'>[];
const RARE_IDS = Object.keys(RARE_EVENTS) as RareEventId[];

export class LevelGenerator {
  readonly segGen = new SegmentGenerator();
  readonly fun = new FunDirector();

  // ------------------------------------------------------------------
  // public API
  // ------------------------------------------------------------------

  generate(p: GenParams): Level {
    const t0 = now();
    let best: Level | null = null;
    let bestPenalty = Infinity;
    for (let attempt = 0; attempt < GEN.maxLevelAttempts; attempt++) {
      const level = this.attempt(p, attempt);
      if (level.report.valid) {
        level.genMs = now() - t0;
        return level;
      }
      const penalty = level.report.reasons.length;
      if (penalty < bestPenalty) {
        best = level;
        bestPenalty = penalty;
      }
    }
    best!.genMs = now() - t0;
    return best!;
  }

  pickEnv(rng: Rng, pool: EnvId[], hist?: VarietyHistory): EnvId {
    return rng.weighted(pool, (e) => 1 - 0.85 * (hist?.recentEnv(e) ?? 0)) ?? pool[0];
  }

  // ------------------------------------------------------------------
  // one deterministic attempt
  // ------------------------------------------------------------------

  private attempt(p: GenParams, attempt: number): Level {
    const seed = SeedManager.attemptSeed(p.seed, attempt);
    const rng = new Rng(seed);
    const L = p.levelNumber;
    const D = p.difficulty;

    const env: EnvId = p.env ?? this.pickEnv(new Rng(p.seed).fork('env'), Object.keys(ENVIRONMENTS) as EnvId[]);
    const nSeg = Math.max(
      GEN.segmentsBase - 2,
      Math.min(GEN.segmentsMax, Math.round(GEN.segmentsBase + (L - 1) * GEN.segmentsPerLevel + rng.range(-GEN.segmentsJitter, GEN.segmentsJitter))),
    );
    const beats = this.fun.planBeats(rng.fork('beats'), nSeg);
    const growthFinal = GEN.growthTarget(L, p.startArmy);

    const st: SlotState = {
      opt: newArmy(p.startArmy),
      optWorst: newArmy(p.startArmy),
      pop: makePopulation(rng.fork('pop'), GEN.populationSize, p.startArmy),
      hist: new VarietyHistory(),
      s: GEN.runwayStart,
      opId: 1,
      stageId: 1,
      rareCount: 0,
      segIndex: 0,
    };

    const segments: Segment[] = [];
    const genLog: GenDecision[] = [];
    for (let i = 0; i < nSeg; i++) {
      const progress = nSeg > 1 ? i / (nSeg - 1) : 1;
      const I = D * sampleCurve(GEN.curve, progress);
      // Blend geometric and linear growth so early gates feel generous (+5/+10/×2), not stingy.
      const t = (i + 1) / nSeg;
      const geo = p.startArmy * Math.pow(growthFinal / p.startArmy, t);
      const lin = p.startArmy + (growthFinal - p.startArmy) * t;
      const growthTarget = Math.sqrt(geo * lin);
      const { seg, decision } = this.fillSlot(st, {
        rng: rng.fork('slot' + i), level: L, D, I, progress, beat: beats[i], growthTarget, mode: 'level', tier: 0,
        forced: p.forceType, rareChance: GEN.rareChance,
      });
      segments.push(seg);
      genLog.push(decision);
    }

    // ---- finale: boss or giant army ----
    const fin = this.buildFinale(st, rng.fork('finale'), L, D, segments, p.forceBoss ?? null);
    segments.push(fin.seg);
    genLog.push(fin.decision);

    const finishS = st.s + 6;
    const expectedFinish = Math.max(1, st.opt.n);
    const runway: RunwayStep[] = [];
    let rs = finishS + 18;
    GEN.runwayMults.forEach((mult, i) => {
      runway.push({ mult, wall: Math.max(1, Math.round(expectedFinish * GEN.runwayWallShare[i])), s: rs });
      rs += GEN.runwayStepSpacing;
    });

    const level: Level = {
      mode: 'level', seed: p.seed, code: SeedManager.toCode(p.seed), attempt, levelNumber: L, difficulty: D,
      startArmy: p.startArmy, env, segments, finishS, runway, runwayEnd: rs + 10, expectedFinish,
      bossId: fin.boss, report: undefined as unknown as LevelReport, genLog, genMs: 0,
    };
    level.report = this.evaluateLevel(level, rng.fork('eval'));
    return level;
  }

  // ------------------------------------------------------------------
  // slot filling: candidates → simulate → reject → score → select
  // ------------------------------------------------------------------

  fillSlot(st: SlotState, sp: SlotParams): { seg: Segment; decision: GenDecision } {
    const aliveBefore = st.pop.filter((a) => !a.a.dead);
    const counts = aliveBefore.map((a) => a.a.n).sort((a, b) => a - b);
    const med = quantile(counts, 0.5) || st.opt.n;
    const before = populationRange(st.pop, st.opt, st.optWorst);

    const ctx: GenCtx = {
      rng: sp.rng, level: sp.level, D: sp.D, I: sp.I, progress: sp.progress,
      opt: st.opt,
      ref: Math.max(1, Math.round(med * 0.65 + st.opt.n * 0.35)),
      refLow: quantile(counts, 0.25) || med,
      refHigh: quantile(counts, 0.75) || med,
      growthTarget: sp.growthTarget, mode: sp.mode, tier: sp.tier,
      obstacleRecency: (id) => {
        const r = st.hist.recent(5).reverse();
        const i = r.findIndex((e) => e.keys.obstacle === id);
        return i < 0 ? 0 : 1 - i / 5;
      },
    };

    const decision: GenDecision = { slot: st.segIndex, beat: sp.beat, intensity: sp.I, chosen: '', reason: '', candidates: [] };
    const valid: Evaluated[] = [];
    const rejections: Record<string, number> = {};
    const reject = (label: string, why: string) => {
      rejections[why] = (rejections[why] ?? 0) + 1;
      decision.candidates.push({ label, valid: false, reject: why });
    };

    const rareOk =
      st.rareCount < (sp.mode === 'endless' ? 99 : GEN.maxRarePerLevel) &&
      st.hist.sinceRare() >= GEN.minRareSpacing &&
      sp.progress > 0.12;
    const wantsRare = rareOk && sp.rng.chance(sp.rareChance * 3); // then 1/3 of candidates may be rare

    for (let k = 0; k < GEN.candidatesPerSlot; k++) {
      const draft = this.makeCandidate(ctx, st, sp, wantsRare && k % 3 === 0);
      if (!draft) continue;
      const label = draft.rare ? `rare:${draft.rare}` : `${draft.type}/${draft.variant}`;

      if (st.hist.consecutive(draft.type) >= GEN.maxConsecutiveSameType) {
        reject(label, 'same type 3× in a row');
        continue;
      }
      const ev = this.evaluateCandidate(draft, ctx, st, sp);
      if (typeof ev === 'string') {
        reject(label, ev);
        continue;
      }
      valid.push(ev);
      decision.candidates.push({ label, valid: true, score: ev.score.total });
    }

    let chosen = this.fun.select(sp.rng, valid, GEN.topK);
    let reason: string;
    if (!chosen) {
      // Guaranteed-safe fallback: a breather reward.
      const draft = this.segGen.reward({ ...ctx, rng: sp.rng.fork('fallback') });
      const ev = this.evaluateCandidate(draft, ctx, st, sp, true) as Evaluated;
      chosen = ev;
      reason = `Fallback breather — all ${GEN.candidatesPerSlot} candidates rejected (${Object.keys(rejections).join(', ')})`;
    } else {
      reason = this.fun.explain(chosen.draft, chosen.score, sp.beat);
    }

    const seg = chosen.seg;
    seg.reason = reason;
    seg.scores = chosen.score;
    seg.before = before;
    seg.after = populationRange(chosen.pop, chosen.opt, chosen.optWorst);
    seg.candidatesTried = decision.candidates.length;
    seg.rejections = rejections;

    // commit
    st.opt = chosen.opt;
    st.optWorst = chosen.optWorst;
    st.pop = chosen.pop;
    st.hist.push({ type: seg.type, sig: seg.sig, keys: seg.keys });
    if (seg.rare) st.rareCount++;
    st.s = seg.s0 + seg.length + GEN.segmentGap;
    st.opId += 100;
    st.stageId += 10;
    st.segIndex++;

    decision.chosen = seg.rare ? `rare:${seg.rare}` : `${seg.type}`;
    decision.reason = reason;
    return { seg, decision };
  }

  private makeCandidate(ctx: GenCtx, st: SlotState, sp: SlotParams, tryRare: boolean): SegmentDraft | null {
    const r = sp.rng;
    const f = sp.forced;
    if (f) {
      if (f.startsWith('rare:')) {
        const d = this.segGen.rare(f.slice(5) as RareEventId, ctx);
        if (d) return d;
      } else {
        const d = this.segGen.generate(f as SegmentType, ctx);
        if (d) return d;
      }
    }
    if (tryRare) {
      const minLvl = sp.mode === 'endless' ? 2 + sp.tier * 2 : sp.level;
      const ids = RARE_IDS.filter((id) => RARE_EVENTS[id].minLevel <= minLvl);
      const id = r.weighted(ids, (x) => RARE_EVENTS[x].weight * (RARE_EVENTS[x].beats.includes(sp.beat) ? 1.5 : 0.5) * (1 - st.hist.repetition('reward', { rare: x }, '') * 0.8));
      if (id) {
        const d = this.segGen.rare(id, ctx);
        if (d) return d;
      }
    }
    const lvl = sp.mode === 'endless' ? 3 + sp.tier * 2 : sp.level;
    const type = r.weighted(SEG_TYPES, (t) => {
      const def = SEGMENT_TYPES[t];
      if (def.minLevel > lvl) return 0;
      if (st.hist.consecutive(t) >= GEN.maxConsecutiveSameType) return 0;
      const matches = def.beats.includes(sp.beat);
      if (!matches && st.segIndex === 0) return 0; // open every level on-beat (gentle)
      const beatAff = matches ? 1 : 0.3;
      return def.weight * beatAff * st.hist.typeRecencyWeight(t);
    });
    return type ? this.segGen.generate(type, ctx) : null;
  }

  private place(draft: SegmentDraft, st: SlotState): Segment {
    const s0 = st.s;
    let opId = st.opId;
    const stages: Stage[] = draft.stages.map((sd, i) => {
      const id = st.stageId + i;
      return {
        id,
        s: s0 + sd.ds,
        routes: sd.routes.map((r) => ({
          x0: r.x0, x1: r.x1, label: r.label,
          ops: r.ops.map((o) => {
            const { ds, ...rest } = o;
            return { ...rest, s: s0 + ds, x0: r.x0, x1: r.x1, id: opId++, stage: id } as WorldOp;
          }),
        })),
        divider: sd.divider ? { x: sd.divider.x, s0: s0 + sd.divider.ds0, s1: s0 + sd.divider.ds1 } : undefined,
      };
    });
    return {
      index: st.segIndex, type: draft.type, rare: draft.rare, beat: 'decision', s0, length: draft.length, stages,
      sig: draft.sig, keys: draft.keys, reason: draft.note,
    };
  }

  private evaluateCandidate(draft: SegmentDraft, ctx: GenCtx, st: SlotState, sp: SlotParams, force = false): Evaluated | string {
    const seg = this.place(draft, st);
    seg.beat = sp.beat;
    const stages = seg.stages;

    const hasObstacle = stages.some((s) => s.routes.some((r) => r.ops.some((o) => o.kind === 'obstacle')));
    if (!force && hasObstacle && st.opt.n < GEN.minArmyBeforeObstacle) return 'army too small for obstacle';

    // opt = typical best play (expected outcomes); optWorst = fairness guarantee (worst luck + worst obstacle play)
    const best = bestPath(st.opt, stages, 0.5, 'expected');
    const worst = bestPath(st.optWorst, stages, 1, 'worst');
    if (!force) {
      if (best.state.dead) return 'best route dies';
      // Endless tiers gradually demand near-perfect play: margins tighten, worst-case guarantee lapses.
      const relax = sp.mode === 'endless' ? Math.min(1, sp.tier / 10) : 0;
      if (worst.state.dead && relax < 0.5) return 'best route dies with worst obstacle play';
      if (best.res.minRatio < GEN.minBattleMargin - (GEN.minBattleMargin - 1.02) * relax) return 'battle margin too thin';
      if (sp.mode === 'level' && best.state.n > GEN.hardCapNormal) return 'army overflow (broken math)';
      if (sp.mode === 'level' && best.state.n > GEN.softCapNormal && best.state.n > st.opt.n * 1.5) return 'growth above soft cap';
      if (sp.mode === 'level' && best.state.n > sp.growthTarget * GEN.maxGrowthOvershoot && best.state.n > st.opt.n * 1.25)
        return 'overgrowth vs difficulty curve';
    }

    const pop = clonePopulation(st.pop, sp.rng.fork('pop'));
    const aliveBefore = pop.filter((a) => !a.a.dead);
    const beforeN = new Map(aliveBefore.map((a) => [a, a.a.n]));
    const beforeLost = new Map(aliveBefore.map((a) => [a, a.lost]));
    const beforeGain = new Map(aliveBefore.map((a) => [a, a.gained]));
    stepPopulation(pop, stages);
    const died = aliveBefore.filter((a) => a.a.dead).length;
    const popDeath = aliveBefore.length ? died / aliveBefore.length : 0;
    const allowed = GEN.segDeathBase + GEN.segDeathPerIntensity * sp.I;
    if (!force && popDeath > allowed) return `too punishing (${Math.round(popDeath * 100)}% of players die)`;
    if (!force && aliveFrac(pop) < 0.25 && sp.mode === 'level') return 'population wiped';

    const lossFr = aliveBefore.map((a) => (a.lost - beforeLost.get(a)!) / Math.max(1, beforeN.get(a)!)).sort((a, b) => a - b);
    const gainFr = aliveBefore.map((a) => (a.gained - beforeGain.get(a)!) / Math.max(1, beforeN.get(a)!)).sort((a, b) => a - b);

    // Choice analysis from the median player's point of view.
    let routeSpread = 0;
    let decisionGap = -1;
    const choiceStage = stages.find((s) => s.routes.length >= 2);
    if (choiceStage) {
      const base = newArmy(ctx.ref);
      const outs = choiceStage.routes.map((_, k) => {
        const t = cloneArmy(base);
        runStage(t, choiceStage, k, 0.5, 'expected', newResult());
        return t.dead ? 0 : t.n;
      });
      const mean = outs.reduce((a, b) => a + b, 0) / outs.length;
      const sd = Math.sqrt(outs.reduce((a, b) => a + (b - mean) ** 2, 0) / outs.length);
      routeSpread = mean > 0 ? sd / mean : 0;
      const sorted = outs.slice().sort((a, b) => b - a);
      decisionGap = sorted[0] > 0 ? (sorted[0] - sorted[1]) / sorted[0] : 0;
    }

    const metrics: CandidateMetrics = {
      popDeath,
      medianLoss: quantile(lossFr, 0.5),
      medianGain: quantile(gainFr, 0.5),
      routeSpread,
      decisionGap,
      optBefore: st.opt.n,
      optAfter: best.state.n,
      growthTarget: sp.growthTarget,
      repetition: st.hist.repetition(draft.type, draft.keys, draft.sig),
    };
    const score = this.fun.score(draft, metrics, sp.beat, sp.I, sp.mode === 'endless' ? 5 + sp.tier : sp.level);
    if (draft.rare) score.total = Math.min(1, score.total + 0.06);
    return { draft, seg, opt: best.state, optWorst: worst.state, pop, score, metrics };
  }

  // ------------------------------------------------------------------
  // finale
  // ------------------------------------------------------------------

  private buildFinale(st: SlotState, rng: Rng, L: number, D: number, segments: Segment[], forceBoss: BossId | null) {
    const isBoss = forceBoss !== null || L % GEN.bossEvery === 0 || rng.chance(GEN.bossChance);
    const bosses = (Object.keys(BOSSES) as BossId[]).filter((b) => BOSS_MIN_LEVEL[b] <= L);
    const boss: BossId | undefined = isBoss
      ? forceBoss ?? rng.weighted(bosses, (b) => BOSSES[b].weight * (st.hist.bosses.includes(b) ? 0.3 : 1)) ?? 'giant'
      : undefined;

    const counts = st.pop.filter((a) => !a.a.dead).map((a) => a.a.n).sort((a, b) => a - b);
    const med = quantile(counts, 0.5) || st.opt.n;
    const p25 = quantile(counts, 0.25) || med;
    const t = Math.min(1, D / 1.3);
    const ratio = GEN.finaleRatio.min + (GEN.finaleRatio.max - GEN.finaleRatio.min) * t;
    // Low difficulty sizes the finale for weaker players; high difficulty for strong ones.
    const high = med * 0.5 + st.opt.n * 0.5;
    const ref = p25 + (high - p25) * Math.min(1, D / 1.2);
    let power = ref * ratio * (boss ? 1.05 : 1);
    if (boss) {
      // Bounded scaling: boss grows with the player but stays inside level bounds,
      // so starting upgrades and good play still matter.
      const [lo, hi] = GEN.bossBounds(L);
      power = Math.max(lo, Math.min(hi, power));
    }
    power = Math.min(power, Math.floor(st.opt.n / 1.15), Math.floor((st.optWorst.n + st.optWorst.shield) / 1.05));
    power = Math.max(1, Math.round(power));

    const usesSacrifice = segments.some((s) => s.stages.some((g) => g.routes.some((r) => r.ops.some((o) => o.kind === 'gate' && o.gate.op === 'sacrifice'))));
    const stagesD: SegmentDraft['stages'] = [];
    if (usesSacrifice) stagesD.push({ ds: 8, routes: [{ x0: -5, x1: 5, ops: [{ kind: 'gate', gate: { op: 'vault', v: 0 }, ds: 8 }] }] });
    const op = boss
      ? { kind: 'boss' as const, power, boss, ds: 26 }
      : { kind: 'enemy' as const, power, display: power, enemy: 'normal' as const, formation: 'ranks' as const, ds: 26 };
    stagesD.push({ ds: 26, routes: [{ x0: -5, x1: 5, ops: [op] }] });

    const draft: SegmentDraft = {
      type: 'finale', variant: boss ?? 'army', length: 50, stages: stagesD, sig: 'finale:' + (boss ?? 'army'),
      keys: { boss }, spectacle: 1,
      note: boss ? `Boss: ${BOSSES[boss].title} (power ${power}, bounded ${GEN.bossBounds(L).map(Math.round).join('–')})` : `Final army battle (${power})`,
    };
    const ev = this.evaluateCandidate(draft, { rng } as GenCtx, st, {
      rng, level: L, D, I: D, progress: 1, beat: 'majorBattle', growthTarget: st.opt.n, mode: 'level', tier: 0, rareChance: 0,
    }, true) as Evaluated;
    const seg = ev.seg;
    seg.reason = draft.note;
    seg.scores = ev.score;
    seg.before = populationRange(st.pop, st.opt, st.optWorst);
    seg.after = populationRange(ev.pop, ev.opt, ev.optWorst);
    st.opt = ev.opt;
    st.optWorst = ev.optWorst;
    st.pop = ev.pop;
    st.s = seg.s0 + seg.length;
    st.segIndex++;
    return {
      seg, boss,
      decision: { slot: seg.index, beat: 'majorBattle' as Beat, intensity: D, chosen: 'finale:' + (boss ?? 'army'), reason: draft.note, candidates: [] },
    };
  }

  // ------------------------------------------------------------------
  // whole-level mathematical validation
  // ------------------------------------------------------------------

  evaluateLevel(level: Level, rng: Rng): LevelReport {
    const stages = level.segments.flatMap((s) => s.stages);
    const D = level.difficulty;
    const reasons: string[] = [];

    // Optimal route: exact within each segment, chained across segments.
    let opt = newArmy(level.startArmy);
    let optW = newArmy(level.startArmy);
    let minMargin = Infinity;
    let maxCount = level.startArmy;
    for (const seg of level.segments) {
      const b = bestPath(opt, seg.stages, 0.5, 'expected');
      const w = bestPath(optW, seg.stages, 1, 'worst');
      opt = b.state;
      optW = w.state;
      minMargin = Math.min(minMargin, b.res.minRatio);
      maxCount = Math.max(maxCount, opt.n);
    }

    const skills = { random: 0, casual: 0.45, average: 0.7, skilled: 0.93 };
    const deathRate = { random: 0, casual: 0, average: 0, skilled: 0 };
    const medianFinal = { random: 0, casual: 0, average: 0, skilled: 0 };
    for (const [k, sk] of Object.entries(skills) as [keyof typeof skills, number][]) {
      const pop = makePopulation(rng.fork(k), GEN.levelEvalAgentsPerSkill, level.startArmy, [sk]);
      stepPopulation(pop, stages);
      const alive = pop.filter((a) => !a.a.dead).map((a) => a.a.n).sort((a, b) => a - b);
      deathRate[k] = 1 - alive.length / pop.length;
      medianFinal[k] = quantile(alive, 0.5);
      for (const a of pop) maxCount = Math.max(maxCount, a.maxN);
    }

    // Mechanic dominance
    const typeShare: Record<string, number> = {};
    const normalSegs = level.segments.filter((s) => s.type !== 'finale');
    for (const s of normalSegs) typeShare[s.type] = (typeShare[s.type] ?? 0) + 1 / normalSegs.length;
    const gateShare: Record<string, number> = {};
    let gates = 0;
    for (const st of stages) for (const r of st.routes) for (const o of r.ops) if (o.kind === 'gate') {
      gateShare[o.gate.op] = (gateShare[o.gate.op] ?? 0) + 1;
      gates++;
    }
    for (const k in gateShare) gateShare[k] /= Math.max(1, gates);

    if (opt.dead) reasons.push('impossible: best route dies');
    if (optW.dead) reasons.push('impossible with worst obstacle play');
    if (!Number.isFinite(opt.n) || opt.n > GEN.hardCapNormal) reasons.push('mathematically broken: overflow');
    const [lo, hi] = GEN.avgDeathBand(D);
    if (deathRate.average > hi) reasons.push(`excessively punishing: ${(deathRate.average * 100) | 0}% of average players die`);
    if (deathRate.average < lo && deathRate.random < GEN.minRandomDeath(D)) reasons.push('trivially easy');
    if (deathRate.skilled > GEN.maxSkilledDeath(D)) reasons.push(`skilled players die ${(deathRate.skilled * 100) | 0}%`);
    const topType = Math.max(...Object.values(typeShare));
    if (normalSegs.length >= 8 && topType > GEN.maxTypeShare) reasons.push('dominated by one segment type');
    const topGate = Math.max(0, ...Object.entries(gateShare).filter(([k]) => k !== 'add').map(([, v]) => v));
    if (gates >= 10 && topGate > GEN.maxGateOpShare) reasons.push('dominated by one gate mechanic');

    return {
      valid: reasons.length === 0,
      reasons,
      optimalFinal: opt.n,
      optimalWorstFinal: optW.n,
      optimalMinMargin: minMargin,
      deathRate,
      medianFinal,
      optimalDifficulty: Math.max(0, Math.min(1, 1 - (Math.min(minMargin, 4) - 1) / 3)),
      averageDifficulty: deathRate.average,
      typeShare,
      gateShare,
      maxCount,
    };
  }
}

// ------------------------------------------------------------------
// Endless: segments generated on the fly from the live army
// ------------------------------------------------------------------

export class EndlessGenerator {
  private gen: LevelGenerator;
  private rng: Rng;
  private st: SlotState;
  private beats: Beat[] = [];
  readonly seed: number;
  segments: Segment[] = [];
  log: GenDecision[] = [];
  forceType: ForceKind | null = null;

  constructor(gen: LevelGenerator, seed: number, startArmy: number, startS: number) {
    this.gen = gen;
    this.seed = seed;
    this.rng = new Rng(seed);
    this.st = {
      opt: newArmy(startArmy), optWorst: newArmy(startArmy),
      pop: makePopulation(this.rng.fork('pop'), 24, startArmy),
      hist: new VarietyHistory(), s: startS, opId: 1, stageId: 1, rareCount: 0, segIndex: 0,
    };
  }

  get tier(): number {
    return Math.floor(this.st.segIndex / GEN.endlessSegmentsPerTier);
  }

  get nextS(): number {
    return this.st.s;
  }

  /**
   * Generate the next segment. `ratio` = the player's real army / the army the
   * simulation predicted at the player's position. The chained simulation is
   * rescaled by it (record performance → adjust future generation), so upcoming
   * content stays relevant whether the player is over- or under-performing.
   */
  next(ratio: number, skill: number, directorMod: number): Segment {
    if (!this.beats.length) this.beats = this.gen.fun.planBeats(this.rng.fork('beats' + this.st.segIndex), 8);
    const beat = this.beats.shift()!;
    const tier = this.tier;
    const s = this.st;
    const scale = Math.abs(ratio - 1) > 0.15 ? ratio / this.applied : 1;
    if (scale !== 1) {
      this.applied = ratio;
      const sc = (n: number) => Math.max(1, Math.round(n * scale));
      s.opt = { ...s.opt, n: sc(s.opt.n), dead: false };
      s.optWorst = { ...s.optWorst, n: sc(s.optWorst.n), dead: false };
    }
    // Simulated players spread around the best line according to the player's measured skill.
    const skills = Array.from({ length: 24 }, (_, i) => Math.max(0, Math.min(1, skill - 0.25 + (i / 23) * 0.5)));
    s.pop = makePopulation(this.rng.fork('p' + s.segIndex), 24, Math.max(1, s.opt.n), skills);
    const I = GEN.endlessTierIntensity(tier) * directorMod * (beat === 'breather' || beat === 'reward' ? 0.7 : 1);
    const { seg, decision } = this.gen.fillSlot(s, {
      rng: this.rng.fork('slot' + s.segIndex), level: 3 + tier * 2, D: I, I, progress: 0.5, beat,
      growthTarget: Math.max(1, s.opt.n) * Math.max(1.08, 1.45 - 0.045 * tier), mode: 'endless', tier, forced: this.forceType,
      rareChance: GEN.rareChance * 1.5,
    });
    if (s.optWorst.dead) s.optWorst = { ...s.opt };
    decision.reason = `[tier ${tier}] ` + decision.reason;
    seg.reason = decision.reason;
    this.segments.push(seg);
    this.log.push(decision);
    return seg;
  }
  private applied = 1;
}

function now(): number {
  return typeof performance !== 'undefined' ? performance.now() : Date.now();
}
