// Tracks how the player is doing and turns that into a difficulty value the
// generator uses for the next level (and live intensity in Endless).
import { GEN } from '../config/genConfig';

export interface RunRecord {
  mode: 'level' | 'endless' | 'lanes';
  level: number;
  won: boolean;
  progress: number; // 0..1 of the level reached
  startArmy: number;
  finalArmy: number;
  maxArmy: number;
  unitsLost: number;
  unitsGained: number;
  enemiesDefeated: number;
  gatesChosen: number;
  choiceQuality: number; // 0..1: chosen gate outcome vs best available
  avgReaction: number; // seconds between gate reveal and final lane commit
}

export interface DirectorState {
  history: RunRecord[];
  modifier: number;
  skill: number;
  streak: number; // + wins, - losses
}

export function sampleCurve(curve: [number, number][], p: number): number {
  const x = Math.max(0, Math.min(1, p));
  for (let i = 1; i < curve.length; i++) {
    if (x <= curve[i][0]) {
      const [x0, y0] = curve[i - 1];
      const [x1, y1] = curve[i];
      return y0 + ((y1 - y0) * (x - x0)) / (x1 - x0 || 1);
    }
  }
  return curve[curve.length - 1][1];
}

export class DifficultyDirector {
  state: DirectorState = { history: [], modifier: 1, skill: 0.5, streak: 0 };
  /** Debug override (null = automatic) */
  override: number | null = null;

  load(s: DirectorState | undefined): void {
    if (s) this.state = { ...this.state, ...s, history: s.history ?? [] };
  }

  recordRun(r: RunRecord): void {
    const s = this.state;
    s.history.push(r);
    if (s.history.length > 12) s.history.shift();

    const lossRatio = r.unitsLost / Math.max(1, r.unitsLost + r.finalArmy);
    let perf = r.won
      ? 0.55 + 0.25 * r.choiceQuality + 0.2 * (1 - lossRatio)
      : 0.3 * r.progress + 0.2 * r.choiceQuality;
    if (r.avgReaction > 0) perf += r.avgReaction < 0.7 ? 0.05 : r.avgReaction > 1.5 ? -0.05 : 0;
    s.skill = s.skill * 0.7 + Math.max(0, Math.min(1, perf)) * 0.3;

    if (r.mode === 'level') {
      if (r.won) s.streak = s.streak > 0 ? s.streak + 1 : 1;
      else s.streak = s.streak < 0 ? s.streak - 1 : -1;
    }

    const recent = s.history.slice(-5);
    const recentDeaths = recent.filter((h) => !h.won && h.mode === 'level').length;
    const streakAdj = s.streak > 0 ? Math.min(0.15, 0.03 * s.streak) : Math.max(-0.3, 0.08 * s.streak);
    const target = 1 + (s.skill - 0.55) * 0.5 + streakAdj - Math.max(0, recentDeaths - 1) * 0.05;
    s.modifier = Math.max(0.65, Math.min(1.4, s.modifier * 0.5 + target * 0.5));
  }

  /** Difficulty for a level, quantized so seed + difficulty codes stay short and reproducible. */
  levelDifficulty(level: number): number {
    if (this.override !== null) return this.override;
    const d = GEN.baseDifficulty(level) * this.state.modifier;
    return Math.round(d * 20) / 20;
  }

  intensity(D: number, progress: number): number {
    return D * sampleCurve(GEN.curve, progress);
  }

  summary() {
    const s = this.state;
    const h = s.history;
    const wins = h.filter((r) => r.won).length;
    return {
      modifier: s.modifier,
      skill: s.skill,
      streak: s.streak,
      recentWinRate: h.length ? wins / h.length : 0,
      recentDeaths: h.slice(-5).filter((r) => !r.won).length,
      avgChoiceQuality: h.length ? h.reduce((a, r) => a + r.choiceQuality, 0) / h.length : 0,
      avgReaction: h.length ? h.reduce((a, r) => a + r.avgReaction, 0) / h.length : 0,
      totalLost: h.reduce((a, r) => a + r.unitsLost, 0),
      totalDefeated: h.reduce((a, r) => a + r.enemiesDefeated, 0),
    };
  }
}
