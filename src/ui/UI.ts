// DOM user interface: menu, HUD, banners, results, shop, missions,
// achievements and settings. Mobile-first; no framework.
import { feel, sfx } from '../audio/SoundSystem';
import { ENVIRONMENTS } from '../config/gameConfig';
import { ACHIEVEMENTS, CATEGORY_ITEMS, UPGRADES, type ShopCategory } from '../config/metaConfig';
import type { EnvId } from '../core/types';
import type { GameManager, GameUI, HudState, RunResult } from '../game/GameManager';
import type { ProgressionSystem } from '../meta/ProgressionSystem';
import { SaveSystem } from '../meta/SaveSystem';
import { fmt } from '../sim/rules';

const h = (html: string): HTMLElement => {
  const t = document.createElement('template');
  t.innerHTML = html.trim();
  return t.content.firstElementChild as HTMLElement;
};

const SKIN_ICON: Record<string, string> = { classic: '🧍', bot: '🤖', blob: '🟢', wizard: '🧙', knight: '🛡️', ninja: '🥷' };
const TRAIL_ICON: Record<string, string> = { none: '∅', dust: '💨', sparkle: '✨', hearts: '💖', fire: '🔥', rainbow: '🌈' };
const WEAPON_ICON: Record<string, string> = { none: '✋', sword: '🗡️', spear: '🔱', shield: '🛡️', hammer: '🔨', staff: '🪄' };
const BANNER_ICON: Record<string, string> = { none: '∅', flag: '🚩', star: '⭐', skull: '💀', dragon: '🐉', crown: '👑' };
const VICTORY_ICON: Record<string, string> = { cheer: '🙌', jump: '🦘', spin: '🌀', wave: '🌊', fireworks: '🎆' };
const SPECIAL_ICON: Record<string, string> = { knights: '⚔️', archers: '🏹', medics: '✚' };
const ENV_ICON: Record<EnvId, string> = {
  grasslands: '🌳', desert: '🌵', snow: '❄️', volcanic: '🌋', castle: '🏰', futuristic: '🏙️', jungle: '🌴',
  floating: '☁️', candy: '🍭', neon: '🌃', ruins: '🏛️',
};

export class UI implements GameUI {
  private root: HTMLElement;
  private game!: GameManager;
  private prog: ProgressionSystem;
  private hudEl: HTMLElement | null = null;
  private screen: HTMLElement | null = null;
  private modal: HTMLElement | null = null;
  private bannerEl: HTMLElement;
  private hintShown = false;
  onOpenDebug: () => void = () => {};

  constructor(root: HTMLElement, prog: ProgressionSystem) {
    this.root = root;
    this.prog = prog;
    this.bannerEl = h('<div class="banner"></div>');
    root.appendChild(this.bannerEl);
  }

  attach(game: GameManager): void {
    this.game = game;
    game.ui = this;
    this.showMenu();
  }

  private click(): void {
    sfx.unlock();
    sfx.play('click');
  }

  private clearScreen(): void {
    this.removeHud();
    document.body.classList.remove('in-menu');
    this.screen?.remove();
    this.screen = null;
    this.modal?.remove();
    this.modal = null;
  }

  // ------------------------------------------------------------------
  // menu
  // ------------------------------------------------------------------

  showMenu(): void {
    this.clearScreen();
    this.removeHud();
    const d = this.prog.data;
    const missions = d.missions
      .slice(0, 3)
      .map((m) => `<div><b>${this.prog.missionText(m)}</b><span><i class="ci"></i>${this.prog.missionReward(m)}</span></div>`)
      .join('');
    const el = h(`
      <div class="screen menu">
        <div class="topbar"><span class="coins">${fmt(d.coins)}</span><button class="btn small" data-a="settings">⚙️</button></div>
        <div class="logo"><h1>CROWD<br><span>FORGE</span></h1><p>Grow your army. Choose wisely.</p></div>
        <div class="menu-bottom">
          <div class="mission-peek">${missions}</div>
          <button class="btn primary" data-a="arena">▶ LEVEL ${d.arenaLevel}</button>
          <div class="row3">
            <button class="btn blue" data-a="play">🏃 RUNNER ${d.level}</button>
            <button class="btn purple" data-a="endless">∞ ENDLESS</button>
            <button class="btn blue" data-a="lanes">⚔ LANES ${d.lanesLevel}</button>
          </div>
          <div class="grid4">
            <button class="btn" data-a="levels"><b>🗂️</b>Levels</button>
            <button class="btn gold" data-a="shop"><b>🛒</b>Shop</button>
            <button class="btn" data-a="missions"><b>🎯</b>Missions</button>
            <button class="btn" data-a="trophies"><b>🏆</b>Trophies</button>
          </div>
          <div class="muted" style="text-align:center">Best endless: ${fmt(d.endlessBest.score)} pts · ${fmt(d.endlessBest.distance)}m</div>
        </div>
      </div>`);
    el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('[data-a]')?.getAttribute('data-a');
      if (!a) return;
      this.click();
      if (a === 'arena') this.startArena();
      else if (a === 'levels') this.showLevels('arena');
      else if (a === 'play') this.startLevel();
      else if (a === 'endless') this.startEndless();
      else if (a === 'lanes') this.startLanes();
      else if (a === 'shop') this.showShop('upgrades');
      else if (a === 'worlds') this.showShop('envs');
      else if (a === 'missions') this.showMissions();
      else if (a === 'trophies') this.showAchievements();
      else if (a === 'settings') this.showSettings();
      else if (a === 'debug') this.onOpenDebug();
    });
    this.root.appendChild(el);
    this.screen = el;
    document.body.classList.add('in-menu');
  }

  startLevel(levelNumber?: number, seed?: number): void {
    this.clearScreen();
    this.showHud();
    this.game.startLevel({ levelNumber, seed });
  }

  startArena(level?: number, seed?: number, canyon?: boolean): void {
    this.clearScreen();
    this.showHud();
    this.game.startArena({ level, seed, canyon });
  }

  startLanes(level?: number, seed?: number): void {
    this.clearScreen();
    this.showHud();
    this.game.startLanes({ level, seed });
  }

  startEndless(): void {
    this.clearScreen();
    this.showHud();
    this.game.startEndless();
  }

  // ------------------------------------------------------------------
  // HUD
  // ------------------------------------------------------------------

  private showHud(): void {
    this.removeHud();
    const el = h(`
      <div>
        <div class="hud">
          <button class="icon-btn" data-a="pause">⏸</button>
          <button class="icon-btn speed-btn" data-a="speed">${this.game.gameSpeed}×</button>
          <div class="center"><div class="title"></div><div class="prog"><i></i></div><div class="sub"></div></div>
          <span class="coins"></span>
        </div>
        <div class="boost-tag">⚡ CHARGE</div>
        <div class="debug-line"></div>
      </div>`);
    el.querySelector('[data-a=pause]')!.addEventListener('click', () => {
      this.click();
      this.pause();
    });
    const sp = el.querySelector('[data-a=speed]') as HTMLElement;
    sp.classList.toggle('fast', this.game.gameSpeed > 1);
    sp.addEventListener('click', () => {
      this.click();
      const v = this.game.cycleSpeed();
      sp.textContent = v + '×';
      sp.classList.toggle('fast', v > 1);
    });
    this.root.appendChild(el);
    this.hudEl = el;
    if (this.prog.data.settings.showHints && !this.hintShown) {
      this.hintShown = true;
      const hint = h('<div class="hint">Drag to steer</div>');
      this.root.appendChild(hint);
      const kill = () => {
        hint.remove();
        window.removeEventListener('pointerdown', kill);
        window.removeEventListener('keydown', kill);
      };
      window.addEventListener('pointerdown', kill);
      window.addEventListener('keydown', kill);
      setTimeout(kill, 5000);
    }
  }

  private removeHud(): void {
    this.hudEl?.remove();
    this.hudEl = null;
  }

  hud(s: HudState): void {
    const el = this.hudEl;
    if (!el) return;
    const title = el.querySelector('.title') as HTMLElement;
    const prog = el.querySelector('.prog') as HTMLElement;
    const sub = el.querySelector('.sub') as HTMLElement;
    sub.textContent = s.sub ?? '';
    sub.style.display = s.sub ? '' : 'none';
    if (s.mode === 'lanes' || s.mode === 'arena') {
      title.textContent = s.mode === 'arena' ? `LEVEL ${s.level}` : `LANE BATTLE ${s.level}`;
      prog.style.display = '';
      (prog.firstElementChild as HTMLElement).style.width = (s.progress * 100).toFixed(1) + '%';
    } else if (s.mode === 'level') {
      title.textContent = `LEVEL ${s.level}`;
      prog.style.display = '';
      (prog.firstElementChild as HTMLElement).style.width = (s.progress * 100).toFixed(1) + '%';
    } else {
      title.textContent = `${fmt(Math.round(s.distance))}m · TIER ${s.tier + 1}`;
      prog.style.display = 'none';
    }
    (el.querySelector('.coins') as HTMLElement).textContent = fmt(this.prog.data.coins);
    (el.querySelector('.boost-tag') as HTMLElement).style.display = s.boost ? 'block' : 'none';
    const dl = el.querySelector('.debug-line') as HTMLElement;
    dl.style.display = s.debugLine ? 'block' : 'none';
    if (s.debugLine) dl.textContent = s.debugLine;
  }

  banner(text: string, cls = '', dur = 1.4): void {
    const b = this.bannerEl;
    b.className = 'banner';
    void b.offsetWidth;
    b.textContent = text;
    b.style.setProperty('--dur', dur + 's');
    b.className = 'banner show ' + cls;
  }

  toast(text: string): void {
    const t = h(`<div class="toast"></div>`);
    t.textContent = text;
    this.root.appendChild(t);
    setTimeout(() => t.remove(), 2700);
  }

  // ------------------------------------------------------------------
  // pause & results
  // ------------------------------------------------------------------

  private showModal(inner: string, onClick: (a: string) => void): void {
    this.modal?.remove();
    const el = h(`<div class="modal-bg"><div class="modal">${inner}</div></div>`);
    el.addEventListener('click', (e) => {
      const a = (e.target as HTMLElement).closest('[data-a]')?.getAttribute('data-a');
      if (a) {
        this.click();
        onClick(a);
      }
    });
    this.root.appendChild(el);
    this.modal = el;
  }

  pause(): void {
    if (this.game.phase === 'over') return;
    this.game.paused = true;
    const lv = this.game.level;
    const lanes = this.game.lanes?.lv;
    const arena = this.game.arena?.lv ?? this.game.canyon?.lv;
    this.showModal(
      `<h2>PAUSED</h2><div class="sub">${arena ? `Level ${arena.level} · seed ${arena.code} · D${arena.D.toFixed(2)}` : lanes ? `Lane Battle ${lanes.level} · seed ${lanes.code} · D${lanes.D.toFixed(2)}` : lv ? `Level ${lv.levelNumber} · seed ${lv.code} · D${lv.difficulty.toFixed(2)} · ${this.game.envName()}` : 'Endless'}</div>
       <div class="btns">
         <button class="btn primary" data-a="resume">▶ RESUME</button>
         <button class="btn blue" data-a="restart">↻ RESTART</button>
         <button class="btn" data-a="quit">🏠 MENU</button>
       </div>`,
      (a) => {
        this.modal?.remove();
        this.modal = null;
        this.game.paused = false;
        if (a === 'restart') {
          if (arena) this.game.startArena({ level: arena.level, seed: arena.seed, canyon: !!this.game.canyon });
          else if (lanes) this.game.startLanes({ level: lanes.level, seed: lanes.seed });
          else if (this.game.endless) this.game.startEndless(this.game.endless.seed);
          else if (lv) this.game.startLevel({ level: lv });
        } else if (a === 'quit') {
          this.game.quitToMenu();
          this.showMenu();
        }
      },
    );
  }

  runEnded(r: RunResult): void {
    setTimeout(() => this.showResults(r), r.won ? 1200 : 300);
  }

  private showResults(r: RunResult): void {
    this.removeHud();
    const rewards = [
      ...r.rewards.missions.map((m) => `<div><span>🎯 ${m.text}</span><b>+${m.reward}</b></div>`),
      ...r.rewards.achievements.map((a) => `<div class="ach"><span>🏆 ${a.name} ${'★'.repeat(a.tier)}<br><small class="muted">${a.desc}</small></span><b>+${100 * a.tier}</b></div>`),
    ].join('');
    let body: string;
    let buttons: string;
    if (r.mode === 'arena' && r.lanes) {
      const ln = r.lanes;
      body = `<h2 class="${r.won ? 'win' : 'lose'}">${r.won ? 'VICTORY!' : 'DEFEATED'}</h2>
        <div class="sub">Level ${r.level} · seed ${r.code} · D${r.difficulty.toFixed(2)}<br>${ln.reason}</div>
        <div class="stats">
          <div class="stat"><span>Time</span><b>${Math.floor(ln.time / 60)}:${String(Math.floor(ln.time % 60)).padStart(2, '0')}</b></div>
          <div class="stat"><span>${ln.canyon ? 'Horde destroyed' : 'Fortress destroyed'}</span><b>${Math.round(ln.castlePct * 100)}%</b></div>
          <div class="stat"><span>Enemies defeated</span><b>${fmt(r.enemies)}</b></div>
          <div class="stat"><span>Peak army</span><b>${fmt(r.maxArmy)}</b></div>
        </div>
        <div class="muted" style="text-align:center">${ln.canyon
          ? `💡 Best plan found by the generator: <b>${ln.bestNote}</b>${ln.towers ? ` · you built ${ln.towers} turret level${ln.towers > 1 ? 's' : ''}` : ''}`
          : `💡 Best plan found by the generator: aim at <b>${ln.bestNote}</b>${ln.towers ? ` · you cleared ${ln.towers} hedge${ln.towers > 1 ? 's' : ''}` : ''}`}</div>`;
      buttons = r.won
        ? `<button class="btn primary" data-a="arenaNext">NEXT LEVEL ▶<small>a brand-new generated level</small></button><button class="btn" data-a="menu">🏠 MENU</button>`
        : `<button class="btn primary" data-a="arenaRetry">↻ TRY AGAIN</button><button class="btn" data-a="menu">🏠 MENU</button>`;
    } else if (r.mode === 'lanes' && r.lanes) {
      const ln = r.lanes;
      body = `<h2 class="${r.won ? 'win' : 'lose'}">${r.won ? 'VICTORY!' : 'DEFEATED'}</h2>
        <div class="sub">Lane Battle ${r.level} · seed ${r.code} · D${r.difficulty.toFixed(2)}<br>${ln.reason}</div>
        <div class="stats">
          <div class="stat"><span>Time</span><b>${Math.floor(ln.time / 60)}:${String(Math.floor(ln.time % 60)).padStart(2, '0')}</b></div>
          <div class="stat"><span>Castle destroyed</span><b>${Math.round(ln.castlePct * 100)}%</b></div>
          <div class="stat"><span>Enemies defeated</span><b>${fmt(r.enemies)}</b></div>
          <div class="stat"><span>Peak army on field</span><b>${fmt(r.maxArmy)}</b></div>
        </div>
        <div class="muted" style="text-align:center">💡 Simulated best strategy: focus <b>${ln.bestNote}</b>, defend lanes as waves arrive${ln.towers ? '' : ''}</div>`;
      buttons = r.won
        ? `<button class="btn primary" data-a="lanesNext">NEXT BATTLE ▶<small>a brand-new generated battle</small></button><button class="btn" data-a="menu">🏠 MENU</button>`
        : `<button class="btn primary" data-a="lanesRetry">↻ TRY AGAIN</button><button class="btn" data-a="menu">🏠 MENU</button>`;
    } else if (r.mode === 'endless') {
      body = `<h2 class="${r.newBest ? 'win' : 'lose'}">${r.newBest ? 'NEW BEST!' : 'RUN OVER'}</h2>
        <div class="sub">Endless · seed ${r.code}</div>
        <div class="stats">
          <div class="stat"><span>Score</span><b>${fmt(r.score)}</b></div>
          <div class="stat"><span>Distance</span><b>${fmt(r.distance)}m</b></div>
          <div class="stat"><span>Max army</span><b>${fmt(r.maxArmy)}</b></div>
          <div class="stat"><span>Enemies defeated</span><b>${fmt(r.enemies)}</b></div>
          <div class="stat"><span>Highest multiplier</span><b>×${r.highestMult || 1}</b></div>
          <div class="stat"><span>Best score</span><b>${fmt(this.prog.data.endlessBest.score)}</b></div>
        </div>`;
      buttons = `<button class="btn primary" data-a="endless">∞ PLAY AGAIN</button><button class="btn" data-a="menu">🏠 MENU</button>`;
    } else {
      body = `<h2 class="${r.won ? 'win' : 'lose'}">${r.won ? 'VICTORY!' : 'DEFEATED'}</h2>
        <div class="sub">Level ${r.level} · seed ${r.code} · D${r.difficulty.toFixed(2)}${r.won ? '' : ` · reached ${(r.progress * 100) | 0}%`}</div>
        ${r.won ? `<div style="text-align:center">Bonus run reached <span class="multbadge">×${r.mult}</span></div>` : ''}
        <div class="stats">
          <div class="stat"><span>Army at finish</span><b>${fmt(r.finishArmy)}</b></div>
          <div class="stat"><span>Peak army</span><b>${fmt(r.maxArmy)}</b></div>
          <div class="stat"><span>Enemies defeated</span><b>${fmt(r.enemies)}</b></div>
          <div class="stat"><span>Units lost</span><b>${r.won ? r.lossPct + '%' : '—'}</b></div>
        </div>`;
      buttons = r.won
        ? `<button class="btn primary" data-a="next">NEXT LEVEL ▶<small>a brand-new generated level</small></button><button class="btn" data-a="menu">🏠 MENU</button>`
        : `<button class="btn primary" data-a="retry">↻ TRY AGAIN</button><button class="btn" data-a="menu">🏠 MENU</button>`;
    }
    const coins = `<div class="coinline"><span class="cnt">0</span></div>${r.coinsBonus ? `<div class="muted" style="text-align:center">${fmt(r.coinsBase)} + bonus ${fmt(r.coinsBonus)} ${r.mode === 'lanes' || r.mode === 'arena' ? '(speed bonus)' : `(×${r.mult})`}</div>` : ''}`;
    this.showModal(`${body}${coins}<div class="rewards-list">${rewards}</div><div class="btns">${buttons}</div>`, (a) => {
      this.modal?.remove();
      this.modal = null;
      if (a === 'next') this.startLevel();
      else if (a === 'retry') this.startLevel(r.level, this.game.level?.seed);
      else if (a === 'endless') this.startEndless();
      else if (a === 'arenaNext') this.startArena();
      else if (a === 'arenaRetry') this.startArena(r.level, r.lanes?.seed);
      else if (a === 'lanesNext') this.startLanes();
      else if (a === 'lanesRetry') this.startLanes(r.level, r.lanes?.seed);
      else {
        this.game.quitToMenu();
        this.showMenu();
      }
    });
    // coin count-up
    const cnt = this.modal!.querySelector('.cnt') as HTMLElement;
    const total = r.coinsTotal;
    const t0 = performance.now();
    const tick = () => {
      const k = Math.min(1, (performance.now() - t0) / 900);
      cnt.textContent = '+' + fmt(Math.round(total * (1 - Math.pow(1 - k, 3))));
      if (Math.random() < 0.5 && k < 1) sfx.play('coin', 1 + k * 0.5);
      if (k < 1 && cnt.isConnected) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  }

  // ------------------------------------------------------------------
  // shop
  // ------------------------------------------------------------------

  showShop(tab: ShopCategory): void {
    this.clearScreen();
    const d = this.prog.data;
    const tabs: [ShopCategory, string][] = [
      ['upgrades', '⬆ Upgrades'], ['special', '⚔ Units'], ['skins', '🧍 Skins'], ['colors', '🎨 Colors'], ['trails', '✨ Trails'],
      ['weapons', '🗡 Weapons'], ['banners', '🚩 Banners'], ['victory', '🙌 Victory'], ['envs', '🗺 Worlds'],
    ];
    let cards = '';
    if (tab === 'upgrades') {
      for (const [id, u] of Object.entries(UPGRADES)) {
        const lvl = d.upgrades[id as keyof typeof d.upgrades];
        const maxed = lvl >= u.max;
        const cost = u.cost(lvl);
        const desc = id === 'startUnits' ? `Start each run with ${5 + lvl} → ${5 + lvl + 1} units` : `+${lvl * 10}% → +${(lvl + 1) * 10}% coins`;
        cards += `<div class="card"><div class="swatch">${id === 'startUnits' ? '👥' : '🧲'}</div><div class="name">${u.name} <span class="muted">Lv ${lvl}/${u.max}</span></div><div class="desc">${desc}</div>
          <button class="btn ${maxed ? '' : 'gold'}" data-buy="${id}" ${maxed || d.coins < cost ? 'disabled' : ''}>${maxed ? 'MAX' : '<i class="ci"></i>' + fmt(cost)}</button></div>`;
      }
    } else if (tab === 'envs') {
      cards += `<div class="card ${d.envPreferred === 'random' ? 'equipped' : ''}"><div class="swatch">🎲</div><div class="name">Random</div><div class="desc">Rotate through unlocked worlds</div><button class="btn blue" data-eq="random">${d.envPreferred === 'random' ? 'SELECTED' : 'SELECT'}</button></div>`;
      for (const [id, e] of Object.entries(ENVIRONMENTS) as [EnvId, (typeof ENVIRONMENTS)[EnvId]][]) {
        const owned = d.envUnlocked.includes(id);
        const eq = d.envPreferred === id;
        cards += `<div class="card ${eq ? 'equipped' : ''}"><div class="swatch" style="background:linear-gradient(${e.sky[0]},${e.ground})">${ENV_ICON[id]}</div><div class="name">${e.name}</div>
          ${owned ? `<button class="btn blue" data-eq="${id}">${eq ? 'SELECTED' : 'SELECT'}</button>` : `<button class="btn gold" data-buy="${id}" ${d.coins < e.unlockCost ? 'disabled' : ''}><i class="ci"></i>${fmt(e.unlockCost)}</button>`}</div>`;
      }
    } else {
      const items = CATEGORY_ITEMS[tab];
      const eqKey: Record<string, keyof typeof d.equipped> = { skins: 'skin', colors: 'color', trails: 'trail', weapons: 'weapon', banners: 'banner', victory: 'victory' };
      for (const it of items) {
        const owned = this.prog.isOwned(tab, it.id);
        const eq = tab !== 'special' && d.equipped[eqKey[tab]] === it.id;
        const icon =
          tab === 'colors' ? '' : tab === 'skins' ? SKIN_ICON[it.id] : tab === 'trails' ? TRAIL_ICON[it.id] : tab === 'weapons' ? WEAPON_ICON[it.id]
            : tab === 'banners' ? BANNER_ICON[it.id] : tab === 'victory' ? VICTORY_ICON[it.id] : SPECIAL_ICON[it.id];
        const sw = tab === 'colors' ? `style="background:${it.hex}"` : '';
        const action = owned
          ? tab === 'special'
            ? `<button class="btn" disabled>ACTIVE</button>`
            : `<button class="btn blue" data-eq="${it.id}">${eq ? 'EQUIPPED' : 'EQUIP'}</button>`
          : `<button class="btn gold" data-buy="${it.id}" ${d.coins < it.cost ? 'disabled' : ''}><i class="ci"></i>${fmt(it.cost)}</button>`;
        cards += `<div class="card ${eq ? 'equipped' : ''}"><div class="swatch" ${sw}>${icon ?? ''}</div><div class="name">${it.name}</div>${it.desc ? `<div class="desc">${it.desc}</div>` : ''}${action}</div>`;
      }
    }
    const el = h(`
      <div class="screen panel-screen">
        <div class="panel-head"><button class="btn small" data-back>←</button><h2>Shop</h2><span class="coins">${fmt(d.coins)}</span></div>
        <div class="tabs">${tabs.map(([t, l]) => `<button class="tab ${t === tab ? 'on' : ''}" data-tab="${t}">${l}</button>`).join('')}</div>
        <div class="scroll"><div class="cards">${cards}</div></div>
      </div>`);
    el.addEventListener('click', (e) => {
      const t = e.target as HTMLElement;
      const tabBtn = t.closest('[data-tab]');
      if (tabBtn) {
        this.click();
        return this.showShop(tabBtn.getAttribute('data-tab') as ShopCategory);
      }
      if (t.closest('[data-back]')) {
        this.click();
        return this.showMenu();
      }
      const buy = t.closest('[data-buy]')?.getAttribute('data-buy');
      if (buy) {
        if (this.prog.buy(tab, buy)) {
          sfx.play('coin');
          this.game.showAttract();
        }
        return this.showShop(tab);
      }
      const eq = t.closest('[data-eq]')?.getAttribute('data-eq');
      if (eq) {
        this.click();
        this.prog.equip(tab, eq);
        this.game.showAttract();
        return this.showShop(tab);
      }
    });
    this.root.appendChild(el);
    this.screen = el;
  }

  // ------------------------------------------------------------------
  // missions / achievements / settings
  // ------------------------------------------------------------------

  private panel(title: string, inner: string, bind?: (el: HTMLElement) => void): void {
    this.clearScreen();
    const el = h(`<div class="screen panel-screen"><div class="panel-head"><button class="btn small" data-back>←</button><h2>${title}</h2><span class="coins">${fmt(this.prog.data.coins)}</span></div><div class="scroll">${inner}</div></div>`);
    el.querySelector('[data-back]')!.addEventListener('click', () => {
      this.click();
      this.showMenu();
    });
    bind?.(el);
    this.root.appendChild(el);
    this.screen = el;
  }

  showLevels(mode: 'arena' | 'runner' | 'lanes'): void {
    const d = this.prog.data;
    const unlocked = mode === 'arena' ? d.arenaLevel : mode === 'runner' ? d.level : d.lanesLevel;
    const shown = Math.max(unlocked + 5, 20);
    let tiles = '';
    for (let n = 1; n <= shown; n++) {
      const open = n <= unlocked;
      const boss = mode === 'runner' && n % 5 === 0;
      const canyon = mode === 'arena' && this.game.isCanyonLevel(n);
      tiles += `<button class="lvl ${open ? '' : 'locked'} ${n === unlocked ? 'current' : ''}" data-lvl="${n}" ${open ? '' : 'disabled'}>
        ${open ? n : '🔒'}${n === unlocked ? '<small>NEXT</small>' : n < unlocked ? '<small>✓</small>' : ''}${boss && open ? '<i>👑</i>' : ''}${canyon ? '<i>🏜️</i>' : ''}</button>`;
    }
    const tab = (m: string, label: string) => `<button class="tab ${m === mode ? 'on' : ''}" data-mode="${m}">${label}</button>`;
    this.panel(
      'Select Level',
      `<div class="tabs">${tab('arena', '▶ Arena')}${tab('runner', '🏃 Runner')}${tab('lanes', '⚔ Lanes')}</div>
       <p class="muted">Every level number is a fixed generated layout for your save — replay any level you've unlocked. Beat level ${unlocked} to unlock the next.</p>
       <div class="lvl-grid">${tiles}</div>`,
      (el) => {
        el.addEventListener('click', (e) => {
          const t = e.target as HTMLElement;
          const m = t.closest('[data-mode]')?.getAttribute('data-mode');
          if (m) {
            this.click();
            return this.showLevels(m as 'arena' | 'runner' | 'lanes');
          }
          const n = Number(t.closest('[data-lvl]:not([disabled])')?.getAttribute('data-lvl'));
          if (!n) return;
          this.click();
          if (mode === 'arena') this.startArena(n);
          else if (mode === 'runner') this.startLevel(n);
          else this.startLanes(n);
        });
      },
    );
  }

  showMissions(): void {
    const d = this.prog.data;
    const items = d.missions
      .map((m) => {
        const t = this.prog.missionText(m);
        const lower = m.id === 'flawless';
        const pct = lower ? (m.progress <= m.target ? 100 : Math.max(0, 100 - (m.progress - m.target))) : Math.min(100, (m.progress / m.target) * 100);
        const prog = lower ? `best ${m.progress >= 100 ? '—' : m.progress + '%'}` : `${fmt(m.progress)} / ${fmt(m.target)}`;
        return `<div class="list-item"><div class="top"><span>${t}</span><small><i class="ci"></i>${this.prog.missionReward(m)}</small></div><div class="pbar"><i style="width:${pct}%"></i></div><div class="muted" style="margin-top:4px">${prog} · tier ${m.tier + 1}</div></div>`;
      })
      .join('');
    this.panel('Missions', `<p class="muted">Complete missions to earn coins. Each completion unlocks a harder version.</p>${items || '<p>All missions complete!</p>'}`);
  }

  showAchievements(): void {
    const d = this.prog.data;
    const items = ACHIEVEMENTS.map((a) => {
      const tier = d.achievements[a.id] ?? 0;
      const next = a.tiers[tier];
      const val = d.stats[a.stat];
      return `<div class="list-item"><div class="top"><span>🏆 ${a.name}</span><small>${tier}/${a.tiers.length}</small></div>
        <div class="muted">${next !== undefined ? a.desc(next) : 'Maxed!'} · you: ${a.lowerIsHarder ? (val >= 100 ? '—' : val + '%') : fmt(val)}</div>
        <div class="tiers">${a.tiers.map((_, i) => `<i class="${i < tier ? 'on' : ''}"></i>`).join('')}</div></div>`;
    }).join('');
    const s = d.stats;
    this.panel('Trophies', `<div class="stats">
      <div class="stat"><span>Levels won</span><b>${fmt(s.levelsWon)}</b></div><div class="stat"><span>Runs</span><b>${fmt(s.runs)}</b></div>
      <div class="stat"><span>Enemies defeated</span><b>${fmt(s.enemiesDefeated)}</b></div><div class="stat"><span>Largest army</span><b>${fmt(s.maxArmy)}</b></div>
      <div class="stat"><span>Bosses</span><b>${fmt(s.bossesDefeated)}</b></div><div class="stat"><span>Total coins</span><b>${fmt(d.totalCoins)}</b></div></div>${items}`);
  }

  showSettings(): void {
    const s = this.prog.data.settings;
    const row = (k: string, label: string, on: boolean) => `<div class="setting"><span>${label}</span><button class="toggle ${on ? 'on' : ''}" data-k="${k}"></button></div>`;
    this.panel(
      'Settings',
      `${row('sound', '🔊 Sound', s.sound)}${row('haptics', '📳 Vibration', s.haptics)}${row('quality', '✨ High quality', s.quality === 'high')}${row('showHints', '💡 Hints', s.showHints)}
       <div class="list-item"><div class="top"><span>Save seed</span><small>${this.prog.data.masterSeed.toString(36).toUpperCase()}</small></div><div class="muted">Every level number maps to a fixed generated level for this save.</div></div>
       <button class="btn" data-dev style="width:100%;margin-top:8px">🛠 Developer panel</button>
       <button class="btn red" data-reset style="width:100%;margin-top:8px">Reset progress</button>`,
      (el) => {
        el.addEventListener('click', (e) => {
          const t = e.target as HTMLElement;
          const k = t.closest('[data-k]')?.getAttribute('data-k');
          if (k) {
            this.click();
            if (k === 'quality') s.quality = s.quality === 'high' ? 'low' : 'high';
            else (s as Record<string, unknown>)[k] = !(s as Record<string, unknown>)[k];
            sfx.enabled = s.sound;
            feel.haptics = s.haptics;
            this.game.setQuality(s.quality);
            this.prog.persist();
            this.showSettings();
          }
          if (t.closest('[data-dev]')) this.onOpenDebug();
          if (t.closest('[data-reset]') && confirm('Reset all progress? This cannot be undone.')) {
            this.prog.data = SaveSystem.reset();
            this.prog.ensureMissions();
            this.prog.persist();
            this.game.showAttract();
            this.showMenu();
          }
        });
      },
    );
  }

  refresh(): void {
    if (this.screen?.classList.contains('menu')) this.showMenu();
  }
}
