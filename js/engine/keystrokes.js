

/*
 * keystrokes.js
 * 
 * Handles keystroke detection and force calculation
 */

import { clamp } from './utils.js';
import { strikeForce, refLevel, recordStrike, sampleCount, isMicOn } from './mic.js';
import { chars, bumpShake } from './text.js';
import { store } from '../store.js';

const KEYS_HISTORY_LIMIT = 40;
const MIC_CORRECTION_DELAY_MS = 115;      // how long strikeForce()/onForce() wait for the real mic reading
const FGUESS_MAX_INTERVAL_MS = 380;       // inter-key gaps at or above this guess zero force
const FGUESS_INTERVAL_RANGE_MS = 290;     // controls how steeply the guess fades as the gap grows
const FGUESS_SCALE = 0.75;                // guessed force is capped below what a real mic reading could hit
const FORCE_LOG_BASE = 0.35;              // force score when a strike exactly matches your reference level
const FORCE_LOG_SCALE = 0.55;             // how much louder/quieter than reference shifts the score
const MIN_REF_LEVEL = 1e-4;               // avoids a divide-by-zero/log(0) before any real calibration exists
const CALIBRATION_MIN_SAMPLES = 6;        // fewer strikes than this means still calibrating
const CALIBRATION_FORCE_CAP = 0.5;        // cap force readings while still calibrating
const ENERGY_BUMP_RATE = 0.07;            // how much one keystroke's force adds to store.energy
const POP_BASE = 0.4;                     // minimum "pop" size bump applied to a struck character
const SHAKE_FORCE_THRESHOLD = 0.55;       // only a forceful (non-backspace) key triggers screen shake
const HIT_FLASH_DURATION_MS = 180;        // how long the #hit force-meter flash stays visible


export const keys = [];
let lastKeyT = -1e9, keyId = 0, pendingStrike = null, lastF = null;
const NOTKEY = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Fn', 'Hyper', 'Super', 'OS']);

const $ = (id) => document.getElementById(id);

export function getLastKeyT() {
  return lastKeyT;
}

export function getPendingStrike() {
  return pendingStrike;
}

export function getLastF() {
  return lastF;
}

// schedules a mic-corrected force reading ~115ms out, falling
// back to inter-keystroke timing (fGuess) when the mic is off
export function onKey(e) {
  if (NOTKEY.has(e.key)) return;
  if (e.repeat && e.key !== 'Backspace') return;

  const now = performance.now();
  const key = { time: now, backspace: e.key === 'Backspace', force: null, id: ++keyId };

  const dt = now - lastKeyT;
  key.forceGuess = clamp((FGUESS_MAX_INTERVAL_MS - dt) / FGUESS_INTERVAL_RANGE_MS, 0, 1) * FGUESS_SCALE;

  keys.push(key);
  while (keys.length > KEYS_HISTORY_LIMIT) keys.shift();
  lastKeyT = now;

  if (isMicOn()) {
    setTimeout(() => {
      const raw = strikeForce(now);
      if (raw > 0) {
        recordStrike(raw);
      }
      const ref = refLevel() || raw || MIN_REF_LEVEL;
      key.force = raw <= 0 ? 0 : clamp(FORCE_LOG_BASE + FORCE_LOG_SCALE * Math.log2(raw / ref), 0, 1);
      if (sampleCount() < CALIBRATION_MIN_SAMPLES) key.force = Math.min(key.force, CALIBRATION_FORCE_CAP);
      onForce(key);
    }, MIC_CORRECTION_DELAY_MS);
  } else {
    key.force = key.forceGuess;
    onForce(key);
  }

  pendingStrike = key;
}

// applies a resolved force reading: bumps store.energy, the
// matching on-screen character's size, and the #hit flash
export function onForce(key) {
  lastF = key.force;
  store.energy = clamp(store.energy + key.force * ENERGY_BUMP_RATE * store.settings.sensitivity, 0, 1);

  for (const char of chars) {
    if (char.kid === key.id) {
      char.f = Math.max(char.f, key.force);
      char.pop = Math.max(char.pop, POP_BASE + key.force);
    }
  }

  if (!key.backspace && key.force > SHAKE_FORCE_THRESHOLD) bumpShake(key.force);

  const hit = $('hit');
  hit.style.left = `${clamp(key.force, 0, 1) * 100}%`;
  hit.style.opacity = 1;
  clearTimeout(hit._flashTimer);
  hit._flashTimer = setTimeout(() => { hit.style.opacity = 0; }, HIT_FLASH_DURATION_MS);
}