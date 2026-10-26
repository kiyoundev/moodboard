/*
 * text.js
 *
 * Owns the typed character array and its diff-based update: turns textarea
 * input into per-character state for rendering, spawns falling "ghost"
 * particles for deleted characters, and exposes the screen-shake amount that
 * keystrokes.js bumps on a hard strike.
 */

import { persist } from '../store.js';
import { getPendingStrike } from './keystrokes.js';

const GHOST_INITIAL_LIFE = 1;
const GHOST_UPWARD_SPEED = 60;     // random initial upward kick when a character is deleted
const GHOST_SIDEWAYS_SPEED = 80;   // random sideways spread range
const NEW_CHAR_FORCE_SCALE = 0.6;  // a brand-new character's guessed force, before onForce corrects it

const $ = (id) => document.getElementById(id);
const textarea = $('textarea');

/**
 * @typedef {Object} CharObject
 * @property {string} c - the raw character itself (e.g. "a")
 * @property {number} kid - id of the keystroke that produced this char, links back to keystrokes.js
 * @property {number} f - that keystroke's force (0-1), drives render size/boldness
 * @property {number} pop - a "pop" scale that starts big and shrinks, the bounce-in effect
 * @property {number} t - timestamp this char was created
 * @property {number|null} x - screen x position, null until draw.js lays it out
 * @property {number|null} y - screen y position, null until draw.js lays it out
 * @property {number} s - scale multiplier; draw.js overwrites this with the rendered pixel size
 * @property {number} [col] - per-render redness (0-1), written by draw.js once this char is drawn
 */

/** @type {CharObject[]} */
export const chars = [];
let ghosts = [], shake = 0;

// diffs the textarea against chars[], spawns a falling ghost for each
// deleted character, and appends newly typed characters seeded with the
// pending keystroke's force (or a guessed force if none is available yet)
export function onInput() {
  const newText = Array.from(textarea.value);
  const oldChars = chars.slice();

  let matchLength = 0;
  while (matchLength < oldChars.length && matchLength < newText.length && oldChars[matchLength].c === newText[matchLength]) {
    matchLength++;
  }

  for (let i = matchLength; i < oldChars.length; i++) {
    const oldChar = oldChars[i];
    if (oldChar.x != null && oldChar.c.trim()) {
      ghosts.push({
        ...oldChar,
        vy: -GHOST_UPWARD_SPEED * Math.random(),
        vx: (Math.random() - 0.5) * GHOST_SIDEWAYS_SPEED,
        life: GHOST_INITIAL_LIFE,
      });
    }
  }

  const pendingStrike = getPendingStrike();
  /** @type {CharObject[]} */
  const addedChars = newText.slice(matchLength).map((rawChar) => ({
    c: rawChar,
    kid: pendingStrike ? pendingStrike.id : 0,
    f: pendingStrike && pendingStrike.force != null ? pendingStrike.force : (pendingStrike ? pendingStrike.forceGuess * NEW_CHAR_FORCE_SCALE : 0),
    pop: 1,
    t: performance.now(),
    x: null,
    y: null,
    s: 1,
  }));

  chars.length = 0;
  chars.push(...oldChars.slice(0, matchLength), ...addedChars);
  persist.set('moodboard.text', textarea.value);
}

// true when target is part of the settings UI (a slider input, or inside
// the settings sheet) — used to avoid stealing focus back to the textarea
export function isUI(target) {
  return target && (target.tagName === 'INPUT' || (target.closest && target.closest('#sheet')));
}

// refocuses the textarea and moves the caret to the end, without scrolling
export function focusTA() {
  textarea.focus({ preventScroll: true });
  const end = textarea.value.length;
  textarea.setSelectionRange(end, end);
}

// raises the screen-shake amount; never lowers it directly — decay is the
// future frame loop's job (#3.6/#3.8), not this module's
export function bumpShake(amount) {
  shake = Math.max(shake, amount);
}

// current screen-shake amount, for draw.js to read each frame
export function getShake() {
  return shake;
}

// live ghosts array, for draw.js to render — read-only for callers
export function getGhosts() {
  return ghosts;
}
