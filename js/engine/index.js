/*
 * index.js
 *
 * Engine orchestrator — the module entry point index.html loads. Wires the
 * mic/keystrokes/mood/text/draw/ui modules together: the per-frame
 * animation loop, input/pointer event listeners, the window.__kb debug
 * global, and startup (slider bindings, button wiring, saved-text restore).
 */

import { persist, store } from '../store.js';
import { sampleMic, isMicOn } from './mic.js';
import { keys, onKey, getLastKeyT, getLastF } from './keystrokes.js';
import { readMood, moodName, getFs, getSs } from './mood.js';
import { onInput, isUI, focusTA, chars, getGhosts, decayShake } from './text.js';
import { tick, drawPanel, getFitDebug } from './draw.js';
import { bindSlider, bindButtons, bindStartCard } from './ui.js';
import { onContentInput } from '../jev.js';
import { toggleDevPanel, updateDevPanel } from '../devpanel.js';

const CHAR_POP_DECAY_RATE = 0.02;
const GHOST_FADE_RATE = 1.8;       // life lost per second
const GHOST_GRAVITY = 900;         // px/s² downward acceleration
const UI_TEXT_UPDATE_INTERVAL_S = 0.08; // throttle for the plain DOM state/meter text, no need to touch it every frame
const HOT_ENERGY_THRESHOLD = 0.6;  // above this, the state label/meter switch to the red color

const $ = (id) => document.getElementById(id);
const textarea = $('textarea');
const scene = $('scene');
const panel = $('panel');
const pctx = panel.getContext('2d');

const ARROW_AND_HOME_END_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

textarea.addEventListener('input', onInput);
textarea.addEventListener('input', onContentInput); // runs after onInput so chars[] reflects the just-typed char
textarea.addEventListener('keydown', (e) => {
  if (ARROW_AND_HOME_END_KEYS.includes(e.key)) e.preventDefault();
  onKey(e);
});
addEventListener('keydown', (e) => {
  if (document.activeElement !== textarea && !e.metaKey && !e.ctrlKey && !isUI(e.target)) focusTA();
});
scene.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  focusTA();
});

const SIDE_MARGIN_PX = 24;
const TOP_MARGIN_PX = 72;    // clears #bar
const BOTTOM_MARGIN_PX = 74;
const METER_GAP_PX = 16;
const METER_MAX_WIDTH_PX = 340;
const STATS_BREAKPOINT_PX = 700;  // below this, the dev stats panel is a floating overlay and doesn't reflow the canvas — matches index.html's media query
const STATS_CANVAS_SHARE = 0.618; // golden-ratio split when the dev stats panel is open on a wide viewport

// sizes/positions #scene to fit the panel's fixed aspect ratio into the
// viewport (flat canvas — no perspective warp), and lines up #meter below it.
// When the dev stats panel is open on a wide viewport, the canvas only gets
// the left 61.8% (matches index.html's `left:30.9%` — the midpoint of that
// zone) instead of the full width, so it's genuinely resized, not just
// repositioned by CSS.
function layout() {
  const safeTop = parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--safe-t')) || 0;
  const top = safeTop + TOP_MARGIN_PX;
  const statsOpen = document.body.classList.contains('stats-open') && innerWidth >= STATS_BREAKPOINT_PX;
  const usableWidth = statsOpen ? innerWidth * STATS_CANVAS_SHARE : innerWidth;
  const availW = usableWidth - SIDE_MARGIN_PX, availH = innerHeight - top - BOTTOM_MARGIN_PX;
  const scale = Math.min(availW / panel.width, availH / panel.height);
  const displayW = panel.width * scale, displayH = panel.height * scale;
  const sceneTop = top + (innerHeight - top - BOTTOM_MARGIN_PX - displayH) / 2;

  scene.style.width = displayW + 'px';
  scene.style.height = displayH + 'px';
  scene.style.top = sceneTop + 'px';

  const meterEl = $('meter');
  meterEl.style.top = (sceneTop + displayH + METER_GAP_PX) + 'px';
  meterEl.style.width = Math.min(displayW, METER_MAX_WIDTH_PX) + 'px';
}

// bundled so the canvas resize and the panel's slide-in/out animate together,
// not a frame behind waiting on the debounced resize handler below
$('statsBtn').addEventListener('click', () => {
  toggleDevPanel();
  layout();
});

let resizeTimer = null;
addEventListener('resize', () => {
  clearTimeout(resizeTimer);
  resizeTimer = setTimeout(layout, 80);
});

let last = performance.now(), uiT = 0;

// per-frame tick: samples mic/keystroke signals into mood, advances the
// draw module's fit/shake/char/ghost physics, repaints, then throttles the
// plain-text meter DOM update
function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;

  sampleMic(getLastKeyT());
  readMood(dt);
  tick(dt);
  decayShake(dt);

  for (const c of chars) c.pop *= Math.pow(CHAR_POP_DECAY_RATE, dt);

  const ghosts = getGhosts();
  for (const g of ghosts) {
    g.life -= dt * GHOST_FADE_RATE;
    g.vy += GHOST_GRAVITY * dt;
    g.y += g.vy * dt;
    g.x += g.vx * dt;
  }
  for (let i = ghosts.length - 1; i >= 0; i--) {
    if (ghosts[i].life <= 0) ghosts.splice(i, 1);
  }

  drawPanel(pctx, false);

  uiT += dt;
  if (uiT > UI_TEXT_UPDATE_INTERVAL_S) {
    uiT = 0;
    const stateEl = $('state');
    stateEl.textContent = moodName(store.energy);
    stateEl.style.color = store.energy > HOT_ENERGY_THRESHOLD ? 'var(--red)' : 'var(--ink)';
    $('mF').textContent = isMicOn() && getLastF() != null ? String(Math.round(getFs() * 100)).padStart(2, '0') : '—';
    $('mS').textContent = getSs().toFixed(1);
    const fillEl = $('fill');
    fillEl.style.width = (store.energy * 100) + '%';
    fillEl.style.background = store.energy > HOT_ENERGY_THRESHOLD ? 'var(--red)' : 'var(--ink)';
    updateDevPanel();
  }

  requestAnimationFrame(frame);
}

window.__kb = {
  get fit() { return getFitDebug(); },
  get energy() { return store.energy; },
  set energy(v) { store.energy = v; },
  get chars() { return chars; },
  keys,
  settings: store.settings,
  get micOn() { return isMicOn(); },
  moodName,
  drawPanel,
};

bindSlider('Z', 'textSize', (v) => '×' + v.toFixed(2).replace(/0$/, ''));
bindSlider('M', 'sensitivity', (v) => '×' + v.toFixed(1));
bindSlider('F', 'micWeight', (v) => Math.round(v * 100) + '%');
bindSlider('S', 'speedWeight', (v) => Math.round(v * 100) + '%');
bindSlider('D', 'decayRate', (v) => (v < 0.7 ? 'slow' : v > 1.6 ? 'fast' : 'normal'));

bindButtons();
bindStartCard();

const savedText = persist.get('moodboard.text');
if (savedText) {
  textarea.value = savedText;
  onInput();
  for (const c of chars) c.pop = 0;
}

layout();
requestAnimationFrame(frame);
