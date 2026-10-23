/*
 * mood.js
 *
 * Turns raw typing behavior (speed, rhythm jitter, backspace ratio, mic
 * strike force) into one eased 0–1 scalar, store.energy, and a named mood
 * label for it. This is the behavior axis only — separate from jev's future
 * content-based emotion/intensity read, which never blends with this.
 */

import { clamp } from './utils.js';
import { keys, getLastKeyT } from './keystrokes.js';
import { isMicOn } from './mic.js';
import { store } from '../store.js';

export const MOODS = [['calm', 0], ['focused', .2], ['stirring', .4], ['heightened', .6], ['explosive', .82]];

const SPEED_WINDOW_MS = 2200;         // how far back we look to measure typing speed
const SPEED_MIN_KPS = 1.8;            // keys/sec at or below this reads as zero speed signal
const SPEED_RANGE_KPS = 6.2;          // keys/sec span mapped onto the 0–1 speed signal

const JITTER_SAMPLE_COUNT = 10;       // how many recent inter-key intervals feed the rhythm-jitter calc
const JITTER_MAX_INTERVAL_MS = 1500;  // intervals longer than this (a real pause) are excluded
const JITTER_MIN_SAMPLES = 4;         // need at least this many intervals before jitter means anything
const JITTER_BASELINE_CV = 0.25;      // coefficient of variation at or below this reads as zero jitter
const JITTER_RANGE_CV = 0.6;          // CV span mapped onto the 0–1 jitter signal

const BACKSPACE_SAMPLE_COUNT = 20;    // how many recent keys feed the backspace-ratio calc
const BACKSPACE_MAX_RATIO = 0.3;      // a 30% backspace rate (or higher) maxes out the signal

const FORCE_DECAY_MS = 1400;          // how fast older keystrokes stop contributing to the force average
const FORCE_MIN_WEIGHT = 0.05;        // below this total weight, there's not enough recent data to trust
const FORCE_WEIGHT_NORMALIZER = 1.2;  // total weight needed to fully trust the force average

const IDLE_GRACE_MS = 300;            // idle decay doesn't start until this long after the last key
const IDLE_DECAY_MS = 1200;           // how fast rhythm/backspace signals fade out once idle

const MIC_WEIGHT_SCALE = 1.4;         // amplifies the mic-force weight in the blend
const SPEED_WEIGHT_SCALE = 1.4;       // amplifies the typing-speed weight in the blend
const NO_MIC_SPEED_BOOST = 0.5;       // extra speed weight when there's no mic force signal to lean on
const JITTER_WEIGHT = 0.3;            // rhythm jitter's fixed share of the blend
const BACKSPACE_WEIGHT = 0.3;         // backspace ratio's fixed share of the blend
const BASE_WEIGHT = 0.6;              // floor added to the blend's denominator so it's never zero/unstable

const TARGET_DEADZONE = 0.1;          // blended signal below this maps to a target of exactly 0
const TARGET_RANGE = 0.58;            // span the remaining signal is stretched across to fill 0–1
const IDLE_TIMEOUT_MS = 4000;         // no keys at all for this long forces the target to 0 outright

const RISE_RATE = 0.02;               // base easing rate when energy is rising toward the target
const DECAY_RATE_BASE = 0.5;          // base easing rate when energy is falling toward the target
const DECAY_RATE_DIVISOR = 2.4;       // settings.decayRate scales the fall rate through this divisor
const MIN_DECAY_RATE = 0.04;          // guaranteed minimum fall speed, independent of the eased rate above

let Fs = 0, Ss = 0; // display-only: last smoothed force/speed, read by the dev meter

// last computed force signal (display-only, for the dev meter)
export function getFs() {
  return Fs;
}

// last computed keys-per-second (display-only, for the dev meter)
export function getSs() {
  return Ss;
}

// how many keys/sec over the trailing window, mapped to 0–1
export function computeSpeedSignal(now, keys) {
  const recentKeys = keys.filter((key) => now - key.time < SPEED_WINDOW_MS);
  const keysPerSecond = recentKeys.length / (SPEED_WINDOW_MS / 1000);
  const speedSignal = clamp((keysPerSecond - SPEED_MIN_KPS) / SPEED_RANGE_KPS, 0, 1);
  return { speedSignal, keysPerSecond };
}

// how erratic the gaps between recent keystrokes are (coefficient of
// variation), mapped to 0–1 — steady typing reads as 0, not idle-faded here
export function computeJitterSignal(keys) {
  const intervals = [];
  for (let i = Math.max(1, keys.length - JITTER_SAMPLE_COUNT); i < keys.length; i++) {
    const gap = keys[i].time - keys[i - 1].time;
    if (gap < JITTER_MAX_INTERVAL_MS) intervals.push(gap);
  }
  if (intervals.length < JITTER_MIN_SAMPLES) return 0;

  const mean = intervals.reduce((a, b) => a + b) / intervals.length;
  const variance = intervals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / intervals.length;
  const coefficientOfVariation = Math.sqrt(variance) / mean;
  return clamp((coefficientOfVariation - JITTER_BASELINE_CV) / JITTER_RANGE_CV, 0, 1);
}

// fraction of recent keys that were backspace, mapped to 0–1 — not
// idle-faded here
export function computeBackspaceSignal(keys) {
  const recentBackspace = keys.slice(-BACKSPACE_SAMPLE_COUNT);
  if (!recentBackspace.length) return 0;
  return clamp((recentBackspace.filter((key) => key.backspace).length / recentBackspace.length) / BACKSPACE_MAX_RATIO, 0, 1);
}

// recency-weighted average strike force across recent (non-backspace) keys
export function computeForceSignal(now, keys) {
  let weightSum = 0, weightedForce = 0;
  for (const key of keys) {
    if (key.force == null || key.backspace) continue;
    const weight = Math.exp(-(now - key.time) / FORCE_DECAY_MS);
    weightSum += weight;
    weightedForce += weight * key.force;
  }
  return weightSum > FORCE_MIN_WEIGHT
    ? (weightedForce / weightSum) * clamp(weightSum / FORCE_WEIGHT_NORMALIZER, 0, 1)
    : 0;
}

// blends speed/jitter/backspace/force signals into one target, then eases
// store.energy toward it (fast rise, slower user-tunable fall)
export function readMood(dt) {
  const now = performance.now();
  const lastKeyT = getLastKeyT();
  const micOn = isMicOn();

  const { speedSignal, keysPerSecond } = computeSpeedSignal(now, keys);
  let jitterSignal = computeJitterSignal(keys);
  const backspaceSignal = computeBackspaceSignal(keys);
  const forceSignal = computeForceSignal(now, keys);

  Fs = forceSignal;
  Ss = keysPerSecond;

  const idleFade = Math.exp(-Math.max(0, now - lastKeyT - IDLE_GRACE_MS) / IDLE_DECAY_MS);
  jitterSignal *= idleFade;
  const fadedBackspaceSignal = backspaceSignal * idleFade;

  const micWeight = micOn ? store.settings.micWeight * MIC_WEIGHT_SCALE : 0;
  const speedWeight = store.settings.speedWeight * SPEED_WEIGHT_SCALE + (micOn ? 0 : NO_MIC_SPEED_BOOST);

  const blended = (micWeight * forceSignal + speedWeight * speedSignal + JITTER_WEIGHT * jitterSignal + BACKSPACE_WEIGHT * fadedBackspaceSignal)
    / (micWeight + speedWeight + BASE_WEIGHT || 1);

  const recentlyActive = now - lastKeyT < IDLE_TIMEOUT_MS;
  const target = clamp((blended * store.settings.sensitivity - TARGET_DEADZONE) / TARGET_RANGE, 0, 1) * (recentlyActive ? 1 : 0);

  const rising = target > store.energy;
  const riseOrFallRate = rising ? RISE_RATE : Math.pow(DECAY_RATE_BASE, 1 / (DECAY_RATE_DIVISOR / store.settings.decayRate));
  store.energy += (target - store.energy) * (1 - Math.pow(riseOrFallRate, dt));

  if (!rising) {
    store.energy = Math.max(target, store.energy - dt * MIN_DECAY_RATE * store.settings.decayRate);
  }
}

// maps an energy value to its highest-threshold label in MOODS
export function moodName(i) {
  let name = MOODS[0][0];
  for (const [label, threshold] of MOODS) {
    if (i >= threshold) name = label;
  }
  return name;
}
