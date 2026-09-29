// Batch validation for Lane Battle levels.  npx vite-node tools/validateLanes.ts [seedsPerLevel]
import { GEN } from '../src/config/genConfig';
import { SeedManager } from '../src/core/SeedManager';
import { LanesGenerator } from '../src/lanes/LanesGenerator';
import { laneGateLabel } from '../src/lanes/LaneSim';

const N = Number(process.argv[2] ?? 10);
const gen = new LanesGenerator();
console.log('lvl  D     valid  attempts  bestTime/target  casualWin  ms   sample reasons');
for (const L of [1, 2, 3, 5, 8, 12, 16, 20, 30]) {
  const D = Math.round(GEN.baseDifficulty(L) * 20) / 20;
  let valid = 0, att = 0, ms = 0, tr = 0, cw = 0;
  const reasons: string[] = [];
  for (let i = 0; i < N; i++) {
    const lv = gen.generate({ seed: SeedManager.levelSeed(4242 + i, L), level: L, D, fireRate: 6, env: 'grasslands' });
    if (lv.report.valid) valid++; else reasons.push(lv.report.reasons.join('/'));
    att += lv.attempt + 1; ms += lv.genMs; tr += lv.report.best.time / lv.targetTime; cw += lv.report.casualWinRate;
  }
  console.log(`${String(L).padStart(3)}  ${D.toFixed(2)}  ${valid}/${N}  ${(att / N).toFixed(1).padStart(6)}  ${(tr / N).toFixed(2).padStart(10)}  ${(cw / N * 100).toFixed(0).padStart(8)}%  ${(ms / N).toFixed(0).padStart(4)}  ${reasons.slice(0, 2).join(' | ')}`);
}
const a = gen.generate({ seed: 77, level: 10, D: 0.8, fireRate: 6, env: 'grasslands' });
const b = gen.generate({ seed: 77, level: 10, D: 0.8, fireRate: 6, env: 'grasslands' });
console.log('\ndeterministic:', JSON.stringify(a.lanes) === JSON.stringify(b.lanes) && JSON.stringify(a.waves) === JSON.stringify(b.waves));
console.log(`sample L10 ${a.code}:`, a.lanes.map((l) => `${l.kind}[${l.events.map((e) => e.kind === 'tower' ? `TOWER hp${e.hp} x${e.mult}` : laneGateLabel(e)).join(',')}]`).join('  '));
console.log(a.report.notes.join('\n'));
for (const s of a.report.strategies) console.log(`  ${s.won ? 'WIN ' : 'LOSE'} ${s.time.toFixed(0).padStart(4)}s base ${Math.round(s.baseLeft)}  ${s.name}`);
