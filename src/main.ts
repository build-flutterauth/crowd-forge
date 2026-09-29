import { feel, sfx } from './audio/SoundSystem';
import { GameManager } from './game/GameManager';
import { ProgressionSystem } from './meta/ProgressionSystem';
import { SaveSystem } from './meta/SaveSystem';
import { DebugPanel } from './ui/DebugPanel';
import { UI } from './ui/UI';

const save = SaveSystem.load();
const prog = new ProgressionSystem(save);
sfx.enabled = save.settings.sound;
feel.haptics = save.settings.haptics;

const canvas = document.getElementById('game') as HTMLCanvasElement;
const overlay = document.getElementById('overlay') as HTMLDivElement;
const uiRoot = document.getElementById('ui') as HTMLDivElement;

const game = new GameManager(canvas, overlay, prog);
const ui = new UI(uiRoot, prog);
ui.attach(game);
const debug = new DebugPanel(uiRoot, game, ui);
ui.onOpenDebug = () => debug.toggle(true);

// Expose for console debugging / automated tests.
(window as unknown as Record<string, unknown>).crowd = { game, ui, prog, debug };

let last = performance.now();
function frame(now: number) {
  const dt = (now - last) / 1000;
  last = now;
  game.update(dt);
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);

document.addEventListener('visibilitychange', () => {
  if (document.hidden && game.phase === "run" && !game.paused) ui.pause();
});
