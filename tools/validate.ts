// Offline batch validation: generate many levels across seeds/levels and
// report acceptance, difficulty and variety statistics.
//   npm run validate            (default sweep)
//   npm run validate -- 25 40   (25 seeds per level, levels 1..40)
import { GEN } from '../src/config/genConfig';
import { SeedManager } from '../src/core/SeedManager';
import { LevelGenerator } from '../src/gen/LevelGenerator';

const seedsPer = Number(process.argv[2] ?? 12);
const maxLevel = Number(process.argv[3] ?? 30);
const gen = new LevelGenerator();
const levels = [1, 2, 3, 5, 8, 12, 16, 20, 25, 30, 40, 60].filter((l) => l <= maxLevel);

const pct = (x: number) => (x * 100).toFixed(0).padStart(3) + '%';
console.log('lvl  D    valid attempts  segs  opt(final)  med(avg)  death: rand casual avg  skilled  fallback  rare  ms');
const failing: string[] = [];
for (const L of levels) {
  let valid = 0, attempts = 0, segs = 0, fallback = 0, rare = 0, ms = 0;
  const opt: number[] = [], med: number[] = [];
  const dr = { random: 0, casual: 0, average: 0, skilled: 0 };
  const D = Math.round(GEN.baseDifficulty(L) * 20) / 20;
  for (let i = 0; i < seedsPer; i++) {
    const seed = SeedManager.levelSeed(12345 + i * 7919, L);
    const lv = gen.generate({ seed, levelNumber: L, difficulty: D, startArmy: 5 });
    if (lv.report.valid) valid++;
    else failing.push(`L${L} seed ${lv.code}: ${lv.report.reasons.join('; ')}`);
    attempts += lv.attempt + 1;
    segs += lv.segments.length;
    ms += lv.genMs;
    fallback += lv.segments.filter((s) => s.reason.startsWith('Fallback')).length;
    rare += lv.segments.filter((s) => s.rare).length;
    opt.push(lv.report.optimalFinal);
    med.push(lv.report.medianFinal.average);
    for (const k of Object.keys(dr) as (keyof typeof dr)[]) dr[k] += lv.report.deathRate[k] / seedsPer;
  }
  opt.sort((a, b) => a - b);
  med.sort((a, b) => a - b);
  console.log(
    `${String(L).padStart(3)}  ${D.toFixed(2)}  ${pct(valid / seedsPer)}  ${(attempts / seedsPer).toFixed(1).padStart(5)}  ${(segs / seedsPer).toFixed(1).padStart(5)}  ` +
    `${String(opt[opt.length >> 1]).padStart(9)}  ${String(med[med.length >> 1]).padStart(8)}  ` +
    `${pct(dr.random)} ${pct(dr.casual)} ${pct(dr.average)}   ${pct(dr.skilled)}  ${(fallback / seedsPer).toFixed(2).padStart(6)}  ${(rare / seedsPer).toFixed(1)}  ${(ms / seedsPer).toFixed(0).padStart(4)}`,
  );
}
if (failing.length) {
  console.log('\nInvalid (best effort) levels:');
  for (const f of failing.slice(0, 25)) console.log('  ' + f);
}

// Determinism check
const a = gen.generate({ seed: 987654, levelNumber: 7, difficulty: 0.8, startArmy: 5 });
const b = gen.generate({ seed: 987654, levelNumber: 7, difficulty: 0.8, startArmy: 5 });
const same = JSON.stringify(a.segments) === JSON.stringify(b.segments);
console.log('\nDeterminism (same seed → same level):', same ? 'OK' : 'FAILED');

// Sample level dump
console.log(`\nSample level ${a.code} (L7, D0.8) env=${a.env} attempt=${a.attempt}:`);
for (const s of a.segments) {
  console.log(`  #${String(s.index).padStart(2)} ${(s.rare ? '★' + s.rare : s.type).padEnd(16)} beat=${s.beat.padEnd(11)} opt ${s.before?.opt}→${s.after?.opt}  med ${s.before?.med}→${s.after?.med}  alive ${pct(s.after?.alive ?? 0)} | ${s.reason}`);
}
