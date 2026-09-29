// Attribute simulated player deaths to segment types/variants (tuning aid).
import { Rng, SeedManager } from '../src/core/SeedManager';
import { LevelGenerator } from '../src/gen/LevelGenerator';
import { makePopulation, stepAgent } from '../src/sim/Simulator';
import { GEN } from '../src/config/genConfig';
const L = Number(process.argv[2] ?? 2);
const skill = Number(process.argv[3] ?? 0.45);
const gen = new LevelGenerator();
const causes: Record<string, number> = {};
let total = 0, dead = 0;
for (let i = 0; i < 40; i++) {
  const lv = gen.generate({ seed: SeedManager.levelSeed(999 + i, L), levelNumber: L, difficulty: Math.round(GEN.baseDifficulty(L) * 20) / 20, startArmy: 5 });
  const pop = makePopulation(new Rng(i), 100, 5, [skill]);
  total += pop.length;
  for (const seg of lv.segments) {
    for (const st of seg.stages) for (const a of pop) {
      const was = a.a.dead;
      stepAgent(a, st);
      if (!was && a.a.dead) {
        const k = (seg.rare ?? seg.type) + ':' + (seg.reason.split(' — ')[0].slice(0, 50));
        causes[k] = (causes[k] ?? 0) + 1;
        dead++;
      }
    }
  }
}
console.log(`L${L} skill ${skill}: death ${(dead / total * 100).toFixed(1)}%`);
Object.entries(causes).sort((a, b) => b[1] - a[1]).slice(0, 14).forEach(([k, v]) => console.log(String(v).padStart(5), k));
