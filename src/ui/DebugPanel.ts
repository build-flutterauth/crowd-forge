// Developer panel: seeds, regeneration, difficulty, forced content,
// invincibility, skip, generation visualization and batch validation.
import { ENVIRONMENTS } from '../config/gameConfig';
import { BOSSES, RARE_EVENTS, SEGMENT_TYPES } from '../config/genConfig';
import { SeedManager } from '../core/SeedManager';
import type { BossId, EnvId, Level } from '../core/types';
import type { GameManager } from '../game/GameManager';
import type { ForceKind } from '../gen/LevelGenerator';
import { fmt } from '../sim/rules';
import type { UI } from './UI';
import { laneGateLabel } from '../lanes/LaneSim';

const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' })[c]!);
const pct = (x: number) => `${Math.round(x * 100)}%`;

export class DebugPanel {
  private el: HTMLElement;
  private body: HTMLElement;
  private game: GameManager;
  private ui: UI;
  open = false;

  constructor(root: HTMLElement, game: GameManager, ui: UI) {
    this.game = game;
    this.ui = ui;
    this.el = document.createElement('div');
    this.el.className = 'dbg';
    this.el.innerHTML = `<header><span>🛠 Developer</span><button data-a="close">✕</button></header><div class="body"></div>`;
    this.body = this.el.querySelector('.body')!;
    root.appendChild(this.el);
    const tog = document.createElement('button');
    tog.className = 'dbg-toggle';
    tog.textContent = '🛠';
    tog.title = 'Developer panel (`)';
    tog.addEventListener('click', () => this.toggle());
    root.appendChild(tog);
    this.el.addEventListener('click', (e) => this.onClick(e));
    this.el.addEventListener('change', (e) => this.onChange(e));
    this.el.addEventListener('pointerdown', (e) => e.stopPropagation());
    window.addEventListener('keydown', (e) => {
      if (e.key === '`' || e.key === '~') this.toggle();
    });
  }

  toggle(force?: boolean): void {
    this.open = force ?? !this.open;
    this.el.classList.toggle('open', this.open);
    if (this.open) this.render();
  }

  private levelNumber(): number {
    const v = Number((this.el.querySelector('[name=lvl]') as HTMLInputElement)?.value);
    return Number.isFinite(v) && v > 0 ? Math.floor(v) : this.game.level?.levelNumber ?? this.game.prog.data.level;
  }

  render(): void {
    const g = this.game;
    const dbg = g.debug;
    const lv = g.level;
    const ds = g.director.summary();
    const types = Object.keys(SEGMENT_TYPES);
    const rares = Object.keys(RARE_EVENTS).map((r) => 'rare:' + r);
    const opt = (v: string, cur: string | null, label = v) => `<option value="${v}" ${cur === v ? 'selected' : ''}>${label}</option>`;
    const D = dbg.difficulty ?? g.director.levelDifficulty(lv?.levelNumber ?? g.prog.data.level);

    let html = `
      <fieldset><legend>Level</legend>
        <label>Seed <input type="text" name="seed" value="${lv ? lv.code : dbg.seed !== null ? SeedManager.toCode(dbg.seed) : ''}" placeholder="random/code/text"></label>
        <label>Level # <input type="number" name="lvl" min="1" value="${lv?.levelNumber ?? g.prog.data.level}"></label>
        <label>Start army <input type="number" name="start" min="1" placeholder="auto (${g.prog.startArmy()})" value="${dbg.startArmy ?? ''}"></label>
        <label>Difficulty <input type="range" name="diff" min="0.2" max="2" step="0.05" value="${D}"><b>${D.toFixed(2)}</b></label>
        <label>Auto difficulty <input type="checkbox" name="autodiff" ${dbg.difficulty === null ? 'checked' : ''}></label>
        <label>Force segment <select name="force">${opt('', dbg.forceType ?? '', '— none —')}${types.map((t) => opt(t, dbg.forceType)).join('')}${rares.map((t) => opt(t, dbg.forceType)).join('')}</select></label>
        <label>Force environment <select name="env">${opt('', dbg.forceEnv ?? '', '— auto —')}${Object.keys(ENVIRONMENTS).map((e) => opt(e, dbg.forceEnv)).join('')}</select></label>
        <label>Force boss finale <select name="boss">${opt('', dbg.forceBoss ?? '', '— auto —')}${Object.keys(BOSSES).map((b) => opt(b, dbg.forceBoss)).join('')}</select></label>
        <div class="brow">
          <button data-a="play">▶ Play seed</button>
          <button data-a="regen">🎲 New random seed</button>
          <button data-a="endless">∞ Endless (seed)</button>
          <button data-a="arena">▶ Arena (seed/level)</button>
          <button data-a="lanes">⚔ Lane Battle (seed/level)</button>
          <button data-a="skip">⏭ Skip segment</button>
          <button data-a="inv" class="${dbg.invincible ? 'on' : ''}">🛡 Invincible</button>
          <button data-a="gen" class="${dbg.showGen ? 'on' : ''}">👁 Show generation</button>
          <button data-a="coins">+1000 coins</button>
        </div>
      </fieldset>
      <fieldset><legend>Batch validation</legend>
        <div class="dim">Generates N levels at this level/difficulty and runs the offline simulator on each.</div>
        <div class="brow"><button data-a="batch" data-n="25">Validate 25 seeds</button><button data-a="batch" data-n="100">Validate 100</button></div>
        <pre class="batch-out"></pre>
      </fieldset>
      <fieldset><legend>Difficulty Director</legend>
        <pre>modifier ${ds.modifier.toFixed(2)} · skill ${ds.skill.toFixed(2)} · streak ${ds.streak}
win rate ${pct(ds.recentWinRate)} · recent deaths ${ds.recentDeaths}
choice quality ${pct(ds.avgChoiceQuality)} · reaction ${ds.avgReaction.toFixed(2)}s
units lost ${fmt(ds.totalLost)} · enemies defeated ${fmt(ds.totalDefeated)}</pre>
      </fieldset>`;

    if (g.arena) html += this.arenaReport();
    else if (g.lanes) html += this.lanesReport();
    else if (lv) html += this.levelReport(lv);
    else if (g.endless) html += this.endlessReport();
    this.body.innerHTML = html;
  }

  private levelReport(lv: Level): string {
    const r = lv.report;
    const share = Object.entries(r.typeShare).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${pct(v)}`).join(', ');
    const rows = lv.segments
      .map((s) => {
        const b = s.before;
        const a = s.after;
        const rej = s.rejections ? Object.entries(s.rejections).map(([k, v]) => `${v}× ${k}`).join('; ') : '';
        return `<tr class="seg" data-s="${s.s0}"><td>${s.index}</td><td><b>${s.rare ? '★' + s.rare : s.type}</b><br><span class="dim">${s.beat}</span></td>
          <td>${b ? `${fmt(b.med)} <span class="dim">[${fmt(b.p25)}–${fmt(b.p75)}]</span><br>opt ${fmt(b.opt)}` : ''}</td>
          <td>${a ? `${fmt(a.med)} <span class="dim">alive ${pct(a.alive)}</span><br>opt ${fmt(a.opt)} / worst ${fmt(a.optWorst)}` : ''}</td>
          <td>${s.scores ? ((s.scores.total * 100) | 0) : '—'}</td></tr>
          <tr><td></td><td colspan="4" class="reason">${esc(s.reason)}${s.scores ? `<br><span class="dim">novelty ${pct(s.scores.novelty)} · difficulty-fit ${pct(s.scores.difficulty)} · risk ${pct(s.scores.risk)} · spectacle ${pct(s.scores.spectacle)} · decision ${pct(s.scores.decision)} · pacing ${pct(s.scores.pacing)} · growth ${pct(s.scores.growth)}</span>` : ''}${s.candidatesTried ? `<br><span class="dim">${s.candidatesTried} candidates${rej ? ' · rejected: ' + esc(rej) : ''}</span>` : ''}</td></tr>`;
      })
      .join('');
    return `
      <fieldset><legend>Generated level ${lv.code} (attempt ${lv.attempt + 1})</legend>
        <pre>L${lv.levelNumber} · D${lv.difficulty.toFixed(2)} · start ${lv.startArmy} · ${ENVIRONMENTS[lv.env].name} · ${lv.segments.length} segments · ${lv.genMs.toFixed(0)}ms
validation: <span class="${r.valid ? 'ok' : 'no'}">${r.valid ? 'VALID' : 'BEST EFFORT — ' + esc(r.reasons.join('; '))}</span>
optimal route final ${fmt(r.optimalFinal)} (worst-play ${fmt(r.optimalWorstFinal)}) · min battle margin ×${r.optimalMinMargin.toFixed(2)}
optimal-route difficulty ${pct(r.optimalDifficulty)} · average-route difficulty ${pct(r.averageDifficulty)}
death rate: random ${pct(r.deathRate.random)} · casual ${pct(r.deathRate.casual)} · average ${pct(r.deathRate.average)} · skilled ${pct(r.deathRate.skilled)}
median final: random ${fmt(r.medianFinal.random)} · casual ${fmt(r.medianFinal.casual)} · average ${fmt(r.medianFinal.average)} · skilled ${fmt(r.medianFinal.skilled)}
peak simulated army ${fmt(r.maxCount)} · bonus walls from expected finish ${fmt(lv.expectedFinish)}
mix: ${share}</pre>
      </fieldset>
      <fieldset><legend>Segments (click to jump) — predicted army entering → leaving</legend>
        <table><tr><th>#</th><th>type</th><th>entry</th><th>exit</th><th>score</th></tr>${rows}</table>
      </fieldset>`;
  }

  private arenaReport(): string {
    const lv = this.game.arena!.lv;
    const r = lv.report;
    const bays = lv.bays.map((b, i) => `bay ${i + 1}: ${b.kind.padEnd(10)} ${b.hedge ? `[HEDGE ${fmt(b.hedge.hp)}] ` : ''}${b.gates.map((g) => (g.op === 'add' ? '+' : g.op === 'mul' ? '×' : g.op === 'sub' ? '−' : '÷') + g.v).join(' ')}`).join('\n');
    const strat = r.strategies.map((s) => `<span class="${s.won ? 'ok' : 'no'}">${s.won ? 'WIN ' : 'LOSE'}</span> ${s.time.toFixed(0).padStart(4)}s  base ${fmt(Math.max(0, Math.round(s.baseLeft)))}  ${esc(s.name)}`).join('\n');
    const waves = lv.waves.map((w) => `${w.t.toFixed(0)}s ${fmt(w.count)}${w.final ? ' FINAL' : ''}`).join(' · ');
    return `<fieldset><legend>Arena level ${lv.code} (attempt ${lv.attempt + 1})</legend>
      <pre>L${lv.level} · D${lv.D.toFixed(2)} · fire ${lv.fireRate.toFixed(2)}/s · ${lv.genMs.toFixed(0)}ms
validation: <span class="${r.valid ? 'ok' : 'no'}">${r.valid ? 'VALID' : 'BEST EFFORT — ' + esc(r.reasons.join('; '))}</span>
${r.notes.map(esc).join('\n')}
casual win rate ${pct(r.casualWinRate)} · wave ratio ${r.waveRatio.toFixed(2)} · time limit ${lv.maxTime.toFixed(0)}s

${bays}

Simulated strategies:
${strat}

Horde waves: ${waves}</pre></fieldset>`;
  }

  private lanesReport(): string {
    const lv = this.game.lanes!.lv;
    const r = lv.report;
    const lanes = lv.lanes.map((l, i) => `lane ${i + 1}: ${l.kind.padEnd(10)} ${l.events.map((e) => (e.kind === 'tower' ? `[TOWER hp ${fmt(e.hp!)} → ×${e.mult}]` : laneGateLabel(e))).join(' ')}`).join('\n');
    const strat = r.strategies.map((s) => `<span class="${s.won ? 'ok' : 'no'}">${s.won ? 'WIN ' : 'LOSE'}</span> ${s.time.toFixed(0).padStart(4)}s  base ${fmt(Math.max(0, Math.round(s.baseLeft)))}  ${esc(s.name)}`).join('\n');
    const waves = lv.waves.map((w) => `${w.t.toFixed(0)}s L${w.lane + 1} ${fmt(w.count)}${w.final ? ' FINAL' : ''}`).join(' · ');
    return `<fieldset><legend>Lane Battle ${lv.code} (attempt ${lv.attempt + 1})</legend>
      <pre>L${lv.level} · D${lv.D.toFixed(2)} · fire ${lv.fireRate.toFixed(2)}/s · ${lv.genMs.toFixed(0)}ms
validation: <span class="${r.valid ? 'ok' : 'no'}">${r.valid ? 'VALID' : 'BEST EFFORT — ' + esc(r.reasons.join('; '))}</span>
${r.notes.map(esc).join('\n')}
casual win rate ${pct(r.casualWinRate)} · wave ratio ${r.waveRatio.toFixed(2)} · time limit ${lv.maxTime.toFixed(0)}s

${lanes}

Simulated strategies:
${strat}

Waves: ${waves}</pre></fieldset>`;
  }

  private endlessReport(): string {
    const e = this.game.endless!;
    const rows = e.segments.slice(-14).reverse()
      .map((s) => `<tr class="seg" data-s="${s.s0}"><td>${s.index}</td><td><b>${s.rare ? '★' + s.rare : s.type}</b> <span class="dim">${s.beat}</span><div class="reason">${esc(s.reason)}</div></td><td>${s.before ? 'opt ' + fmt(s.before.opt) : ''}</td></tr>`)
      .join('');
    return `<fieldset><legend>Endless seed ${SeedManager.toCode(e.seed)} · tier ${e.tier + 1}</legend><table>${rows}</table></fieldset>`;
  }

  private parseSeed(): number | null {
    const v = (this.el.querySelector('[name=seed]') as HTMLInputElement).value.trim();
    return v ? SeedManager.fromCode(v) : null;
  }

  private onChange(e: Event): void {
    const t = e.target as HTMLInputElement;
    const dbg = this.game.debug;
    switch (t.name) {
      case 'diff':
        dbg.difficulty = Number(t.value);
        (this.el.querySelector('[name=autodiff]') as HTMLInputElement).checked = false;
        t.nextElementSibling!.textContent = Number(t.value).toFixed(2);
        break;
      case 'autodiff':
        dbg.difficulty = t.checked ? null : Number((this.el.querySelector('[name=diff]') as HTMLInputElement).value);
        break;
      case 'start':
        dbg.startArmy = t.value ? Math.max(1, Math.floor(Number(t.value))) : null;
        break;
      case 'force':
        dbg.forceType = (t.value || null) as ForceKind | null;
        break;
      case 'env':
        dbg.forceEnv = (t.value || null) as EnvId | null;
        break;
      case 'boss':
        dbg.forceBoss = (t.value || null) as BossId | null;
        break;
    }
  }

  private onClick(e: Event): void {
    const t = e.target as HTMLElement;
    const a = t.closest('[data-a]')?.getAttribute('data-a');
    const g = this.game;
    const row = t.closest('tr.seg');
    if (row) {
      const s = Number(row.getAttribute('data-s'));
      if (g.phase === 'run' && s > g.army.s) {
        g.army.s = s - 6;
        for (const u of g.army.crowd.units) u.z = g.army.z;
      }
      return;
    }
    if (!a) return;
    switch (a) {
      case 'close': this.toggle(false); break;
      case 'play': {
        const seed = this.parseSeed();
        g.debug.seed = seed;
        this.ui.startLevel(this.levelNumber());
        g.debug.seed = null;
        this.render();
        break;
      }
      case 'regen': {
        g.debug.seed = SeedManager.randomSeed();
        this.ui.startLevel(this.levelNumber());
        g.debug.seed = null;
        this.render();
        break;
      }
      case 'endless': {
        const seed = this.parseSeed();
        g.debug.seed = seed;
        this.ui.startEndless();
        g.debug.seed = null;
        this.render();
        break;
      }
      case 'arena': {
        const seed = this.parseSeed();
        this.ui.startArena(this.levelNumber(), seed ?? undefined);
        this.render();
        break;
      }
      case 'lanes': {
        const seed = this.parseSeed();
        this.ui.startLanes(this.levelNumber(), seed ?? undefined);
        this.render();
        break;
      }
      case 'skip': g.skipForward(); break;
      case 'inv':
        g.debug.invincible = !g.debug.invincible;
        g.army.invincible = g.debug.invincible;
        t.classList.toggle('on', g.debug.invincible);
        break;
      case 'gen':
        g.setShowGen(!g.debug.showGen);
        t.classList.toggle('on', g.debug.showGen);
        break;
      case 'coins':
        g.prog.addCoins(1000);
        g.prog.persist();
        this.ui.refresh();
        break;
      case 'batch': this.batch(Number(t.getAttribute('data-n'))); break;
    }
  }

  private batch(n: number): void {
    const out = this.el.querySelector('.batch-out') as HTMLElement;
    const g = this.game;
    const L = this.levelNumber();
    const D = g.debug.difficulty ?? g.director.levelDifficulty(L);
    const start = g.startingArmy();
    out.textContent = 'running…';
    setTimeout(() => {
      const t0 = performance.now();
      let valid = 0, attempts = 0, rare = 0, fallback = 0;
      const dr = { random: 0, casual: 0, average: 0, skilled: 0 };
      const finals: number[] = [];
      const bad: string[] = [];
      for (let i = 0; i < n; i++) {
        const seed = SeedManager.randomSeed();
        const lv = g.generator.generate({ seed, levelNumber: L, difficulty: D, startArmy: start, env: 'grasslands' });
        if (lv.report.valid) valid++;
        else bad.push(`${lv.code}: ${lv.report.reasons.join('; ')}`);
        attempts += lv.attempt + 1;
        rare += lv.segments.filter((s) => s.rare).length;
        fallback += lv.segments.filter((s) => s.reason.startsWith('Fallback')).length;
        finals.push(lv.report.optimalFinal);
        for (const k of Object.keys(dr) as (keyof typeof dr)[]) dr[k] += lv.report.deathRate[k] / n;
      }
      finals.sort((a, b) => a - b);
      out.textContent =
        `L${L} D${D.toFixed(2)} start ${start} · ${n} levels in ${(performance.now() - t0).toFixed(0)}ms\n` +
        `valid ${valid}/${n} · avg attempts ${(attempts / n).toFixed(2)} · rare/level ${(rare / n).toFixed(2)} · fallbacks/level ${(fallback / n).toFixed(2)}\n` +
        `death rates: random ${pct(dr.random)} casual ${pct(dr.casual)} average ${pct(dr.average)} skilled ${pct(dr.skilled)}\n` +
        `optimal final: p10 ${fmt(finals[Math.floor(n * 0.1)])} · median ${fmt(finals[n >> 1])} · p90 ${fmt(finals[Math.floor(n * 0.9)])}` +
        (bad.length ? `\nbest-effort seeds (reproduce with Play seed):\n  ${bad.slice(0, 8).join('\n  ')}` : '');
    }, 30);
  }
}
