// Plans pacing and scores candidate segments so the generator picks content a
// human designer would: varied, well-paced, meaningful choices, big moments.
import { FUN_WEIGHTS, PACING_PHRASES, SEGMENT_TYPES, RARE_EVENTS } from '../config/genConfig';
import type { Rng } from '../core/SeedManager';
import type { Beat, ScoreBreakdown } from '../core/types';
import type { SegmentDraft } from './SegmentGenerator';

export interface CandidateMetrics {
  popDeath: number; // share of alive simulated players who die in this segment
  medianLoss: number; // median agent: units lost / units before (0..1+)
  medianGain: number; // median agent: units gained / units before
  routeSpread: number; // outcome variety across route choices (coefficient of variation)
  decisionGap: number; // relative gap between best and 2nd best choice (-1 = no choice)
  optBefore: number;
  optAfter: number;
  growthTarget: number;
  repetition: number; // from VarietyHistory
}

export function beatTargetPressure(beat: Beat, I: number): number {
  switch (beat) {
    case 'battle': return 0.1 + 0.28 * I;
    case 'majorBattle': return 0.18 + 0.36 * I;
    case 'obstacle': return 0.05 + 0.14 * I;
    case 'decision': return 0.03 + 0.12 * I;
    default: return 0;
  }
}

export class FunDirector {
  /** Build a pacing plan (one beat per slot) from the phrase grammar. */
  planBeats(rng: Rng, n: number): Beat[] {
    const beats: Beat[] = [];
    let last = -1;
    while (beats.length < n) {
      const p = beats.length / Math.max(1, n - 1);
      const ok = PACING_PHRASES.map((ph, i) => ({ ph, i })).filter(
        ({ ph, i }) => p >= ph.minProgress && p <= ph.maxProgress && i !== last,
      );
      const pick = rng.weighted(ok, ({ ph }) => ph.weight * (p > 0.6 && ph.beats.includes('majorBattle') ? 1.6 : 1)) ?? ok[0];
      last = pick.i;
      for (const b of pick.ph.beats) if (beats.length < n) beats.push(b);
    }
    // Always open gently.
    if (beats[0] !== 'decision' && beats[0] !== 'reward') beats[0] = 'decision';
    return beats;
  }

  /** Beat affinity of a segment type or rare event */
  pacingFit(draft: SegmentDraft, beat: Beat): number {
    const beats = draft.rare ? RARE_EVENTS[draft.rare].beats : draft.type === 'finale' ? [] : SEGMENT_TYPES[draft.type].beats;
    if (beats.includes(beat)) return 1;
    const soft: Record<Beat, Beat[]> = {
      decision: ['bigReward'],
      reward: ['breather', 'bigReward'],
      battle: ['majorBattle'],
      breather: ['reward'],
      obstacle: [],
      bigReward: ['reward', 'decision'],
      majorBattle: ['battle'],
    };
    return beats.some((b) => soft[beat].includes(b)) ? 0.6 : 0.2;
  }

  score(draft: SegmentDraft, m: CandidateMetrics, beat: Beat, I: number, level: number): ScoreBreakdown {
    const novelty = 1 - m.repetition;

    const target = beatTargetPressure(beat, I);
    const pressure = m.medianLoss + m.popDeath * 1.5;
    let difficulty = Math.exp(-Math.pow((pressure - target) / 0.14, 2));
    if (beat === 'reward' || beat === 'breather' || beat === 'bigReward') difficulty = Math.min(1, 0.4 + m.medianGain) * (1 - Math.min(1, m.popDeath * 4));

    const risk = Math.min(1, m.routeSpread);

    const growthRatio = m.optBefore > 0 ? m.optAfter / m.optBefore : 1;
    const spectacle = Math.min(1, Math.abs(Math.log10(Math.max(growthRatio, 1e-3))) * 1.6 + draft.spectacle);

    let decision = 0.35;
    if (m.decisionGap >= 0) {
      // Sweet spot: the right answer matters but isn't screamingly obvious.
      const lo = level <= 2 ? 0.15 : 0.06;
      const hi = level <= 2 ? 1.2 : 0.6;
      const g = m.decisionGap;
      decision = g < 0.02 ? 0.1 : g < lo ? 0.5 + (0.5 * g) / lo : g <= hi ? 1 : Math.max(0.35, 1 - (g - hi) * 0.5);
    }

    const pacing = this.pacingFit(draft, beat);
    const growth = Math.exp(-Math.pow(Math.log(Math.max(1, m.optAfter) / Math.max(1, m.growthTarget)), 2) / 0.5);

    const w = FUN_WEIGHTS;
    const total =
      (w.novelty * novelty + w.difficulty * difficulty + w.risk * risk + w.spectacle * spectacle +
        w.decision * decision + w.pacing * pacing + w.growth * growth) /
      (w.novelty + w.difficulty + w.risk + w.spectacle + w.decision + w.pacing + w.growth);

    return { novelty, difficulty, risk, spectacle, decision, pacing, growth, total };
  }

  /** Weighted pick among the top-K valid candidates (keeps variety without picking junk). */
  select<T extends { score: ScoreBreakdown }>(rng: Rng, cands: T[], topK: number): T | undefined {
    if (!cands.length) return undefined;
    const sorted = cands.slice().sort((a, b) => b.score.total - a.score.total);
    const top = sorted.slice(0, topK);
    return rng.weighted(top, (c) => Math.pow(Math.max(0.01, c.score.total), 3)) ?? top[0];
  }

  explain(draft: SegmentDraft, s: ScoreBreakdown, beat: Beat): string {
    const parts: [string, number][] = [
      ['fresh', s.novelty], ['on-curve difficulty', s.difficulty], ['risk/reward', s.risk], ['spectacle', s.spectacle],
      ['good decision', s.decision], [`fits "${beat}" beat`, s.pacing], ['growth on target', s.growth],
    ];
    parts.sort((a, b) => b[1] - a[1]);
    const top = parts.slice(0, 2).map(([k, v]) => `${k} ${(v * 100) | 0}%`).join(', ');
    return `${draft.note} — picked for ${top}`;
  }
}
