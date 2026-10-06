# Crowd Forge

A mobile-first 3D crowd-runner / number-gate arcade game with a **constrained procedural level generator**. Every level is built from a seed, simulated offline, validated, scored and only then played — so levels feel designed rather than random, and you can play indefinitely without seeing the same level twice.

Built with TypeScript + Three.js + Vite. Placeholder low-poly art and synthesized sound; no asset files.

```bash
npm install
npm run dev        # play at http://localhost:5173 (also reachable from a phone on your LAN)
npm test           # unit tests (rules, determinism, solvability, variety, endless)
npm run validate   # batch-generate levels across seeds/levels and print statistics
npm run build      # production build in dist/
```

**Controls:** drag anywhere to steer (touch or mouse), or A/D / arrow keys. Press `` ` `` or the 🛠 button for the developer panel.

## How generation works

```
GENERATE CANDIDATES → SIMULATE → REJECT BAD → SCORE VALID → SELECT → PLAY → RECORD PERFORMANCE → ADJUST
```

1. **Pacing plan.** The Fun Director strings together beat phrases (`decision → battle`, `obstacle → breather`, `bigReward → majorBattle`, …) into a plan for the level.
2. **Per slot, ~14 candidates** are generated. Segment generators receive the *simulated army sizes* at that point, so numbers are meaningful. For example, `+N` vs `×k` is sized so the better pick depends on your army, and "pressure" battles size the enemy between the outcomes of the preceding gates.
3. **Simulation.** Each candidate is run through:
   - the **best route** (exhaustive within the segment, average obstacle play),
   - the **worst-case best route** (worst luck and worst obstacle play), which must survive,
   - a **population of 64 simulated players** of varying skill.
4. **Rejection.** Candidates are thrown out when:
   - the best route dies,
   - the battle margin is under ×1.12,
   - too many simulated players die for the current intensity,
   - growth overshoots the difficulty curve,
   - the math overflows,
   - or the same type would repeat a third time.
5. **Scoring.** The Fun Director scores novelty, fit to the difficulty curve, risk/reward, spectacle, decision quality, pacing fit and growth. It then picks a weighted winner among the top 3.
6. **Whole-level validation.** The finished level is re-simulated with random, casual, average and skilled players. It is rejected if it is impossible, trivially easy, excessively punishing, mathematically broken, or dominated by one mechanic. When that happens, it is regenerated deterministically from `seed + attempt`.
7. **Difficulty Director.** Between runs it records:
   - win/loss and streaks,
   - progress, units lost and gained, enemies defeated,
   - gate-choice quality (the chosen outcome compared with the best available),
   - reaction time.
   
   From these it adjusts the next level's difficulty. In Endless it also compares your real army with the predicted one and rescales upcoming content.

The same `seed + difficulty + start army` always produces the same level. The seed code is shown in the pause menu, results screen and developer panel.

**Rules are shared.** `src/sim/rules.ts` is used by both the offline simulator and live gameplay, so what the generator predicts is what happens. For example, gameplay obstacle kills are hard-capped at the loss fraction the generator assumed for worst-case play.

## Arena — the main mode

The big **▶ LEVEL** button on the menu. It plays like Mob Control / Top Lords:

- A cannon at the bottom slides freely across the arena and fires soldiers continuously. Drag or use A/D to aim. A reticle, firing chevrons and a highlight on the bay you're aiming into show where shots go.
- The lower arena is split into **bays** by short fences:
  - open ×N gates
  - stacks of gates
  - **hedge-sealed jackpots** (e.g. ×99 ×99 ×99 behind a hedge you must chew through first)
  - gates followed by a hedge
  - trap bays with ÷ gates
- A ×N gate turns every soldier group into N times as many soldiers.
- Past the gates, the army spreads across a V-shaped hedge funnel. The enemy horde pours down that funnel from the fortress and meets it there.
- Enemies that break through hunt your cannon and eat your fresh, unmultiplied shots. Hedges block and absorb them too.
- Destroy the fortress before the horde reaches you or time runs out.

Levels are procedural (`src/arena/`):
1. Generate a bay layout.
2. Simulate each aiming plan, including "break the hedge first, defend from an open bay when the horde leaks".
3. Size the fortress so the best plan wins near the target time.
4. Size the horde to the throughput of that plan, and tune it until casual players win at a difficulty-appropriate rate.
5. Reject any layout where aim doesn't matter.

### Canyon Siege — every 5th Arena level

Levels 5, 10, 15 and so on are **Canyon Siege** levels (marked 🏜️ in level select):

- The cannon sits on a plaza at the foot of a winding cliff-top canyon. A huge horde pours down the canyon in a red river.
- At the canyon mouth, a barricade holds a big ×N gate (×50…×250) with a turret pad on each side.
- **Aim at the gate** to send a multiplied army up the canyon. Soldiers that reach the top cut into the horde's reserve directly.
- **Aim at a turret pad** to spend soldiers building it. The number on the pad is how many it still needs. Keep feeding it to upgrade it (Lv2, Lv3).
  - The small **Gatling** is cheap.
  - The **Mega Gatling** costs more but shreds far more of the horde.
  - Built turrets fire on their own at whatever is nearest the barricade.
- Wipe out the entire horde before it reaches the cannon or time runs out. Enemies that break through are not divided by the gate.

Levels are procedural (`src/arena/Canyon*.ts`):
1. Roll the gate, turret costs and power, and canyon shape.
2. Simulate build orders, from gate-only up to fully upgraded turrets.
3. Size the horde so the best order wins near the target time.
4. Tune the horde's release rate until casual players win at a difficulty-appropriate rate.
5. Reject layouts where turrets don't matter, i.e. gate-only wins as fast.

The developer panel's **🏜 Canyon Siege** button plays any seed or level and lists every simulated build order. Tuning lives in `src/config/canyonConfig.ts`, and `npx vite-node tools/validateCanyon.ts` sweeps levels.

In testing, real play reproduces the simulated best time within about ±2 s. The developer panel's **▶ Arena** button shows every simulated plan. Tuning lives in `src/config/arenaConfig.ts`, and `npx vite-node tools/validateArena.ts` sweeps levels. The original runner, Endless and Lane Battle remain as secondary modes on the menu.

## Lane Battle mode

Open it from the **⚔ LANES** button on the main menu. It's a separate progression from the runner levels.

A cannon at the bottom fires soldiers up parallel walled lanes. Drag or use A/D to move the cannon between lanes. Each lane is a different strategy:
- **Gate Stack:** many `+1`/`+2` gates. Steady, safe output.
- **Big Multiplier:** a `×8`…`×150` gate. A `×N` gate splits a group into up to 6 groups.
- **Jackpot Tower:** a stone pillar with HP. Shots are absorbed until it breaks, then it becomes a golden `×250`…`×8888` gate.
- **Mixed:** gate chains like `×2 → +10 → ×3`, sometimes with a `÷2` trap.

Enemy hordes march down the lanes. Soldiers and enemies cancel 1:1, and enemies that reach the red line damage your base. Destroy the enemy castle before your base falls or time runs out.

Levels are procedural (`src/lanes/`), built the same way as the runner:
1. Generate the lanes.
2. Simulate strategies: smart play focusing each lane, casual play, and "only ever shoot one lane".
3. Size the castle so the best strategy wins near the target time.
4. Size enemy waves to what the defending lane can output, and tune them until casual players win at a difficulty-appropriate rate.
5. Reject any level where lanes don't matter.

The results screen shows the simulated best strategy. The developer panel's **⚔ Lane Battle** button plays a specific seed or level and shows every simulated strategy. Tuning lives in `src/config/lanesConfig.ts`, and `npx vite-node tools/validateLanes.ts` sweeps levels.

## Project layout

| Module | File |
|---|---|
| SeedManager | `src/core/SeedManager.ts` |
| LevelGenerator (+ EndlessGenerator) | `src/gen/LevelGenerator.ts` |
| SegmentGenerator (10 types + 9 rare events) | `src/gen/SegmentGenerator.ts` |
| DifficultyDirector | `src/gen/DifficultyDirector.ts` |
| FunDirector | `src/gen/FunDirector.ts` |
| Variety history | `src/gen/VarietyHistory.ts` |
| Offline simulator / validation | `src/sim/Simulator.ts`, `src/sim/rules.ts` |
| GameManager | `src/game/GameManager.ts` |
| ArmyManager | `src/game/ArmyManager.ts` |
| GateSystem (gates + recruits) | `src/game/GateSystem.ts` |
| CombatSystem | `src/game/CombatSystem.ts` |
| EnemyManager | `src/game/EnemyManager.ts` |
| ObstacleSystem (12 obstacles) | `src/game/ObstacleSystem.ts` |
| BossManager (6 bosses) | `src/game/BossManager.ts` |
| RewardSystem (bonus runway, coins) | `src/game/RewardSystem.ts` |
| ProgressionSystem / SaveSystem | `src/meta/*` |
| Rendering (environments, instanced crowds, effects) | `src/render/*` |
| UI + developer panel | `src/ui/*` |

**Tuning lives in data files:**
- `src/config/genConfig.ts`: segment weights, obstacle loss models, rare events, pacing grammar, difficulty curve, validation bands, bosses, runway
- `src/config/gameConfig.ts`: feel, camera, the 11 environments
- `src/config/metaConfig.ts`: shop, upgrades, missions, achievements

## Developer panel

The panel lets you:
- enter or regenerate a seed, set the level number, start army and difficulty (or leave difficulty on auto)
- force a segment type or rare event, an environment, or a boss
- skip to the next segment, or click a segment row to jump to it
- toggle invincibility
- show generation decisions in the world and predicted army ranges on the HUD
- see the full validation report and each segment's score breakdown and rejection reasons
- run batch validation over 25 or 100 seeds
- inspect the Difficulty Director's state

For console access, `window.crowd` exposes `{ game, ui, prog, debug }`.

## Tools

- `npm run validate -- 25 40`: sweep with 25 seeds per level, levels up to 40
- `npx vite-node tools/deaths.ts 8 0.45`: attribute simulated deaths at level 8 (skill 0.45) to segment types
