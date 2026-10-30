/*
 * ui.js
 *
 * Wires the settings sliders, toolbar buttons, toast notifications, and
 * start card to their DOM elements. Pure UI chrome — reads/writes shared
 * state via store.js, mic.js, and text.js rather than owning any of it.
 */

import { persist, store } from '../store.js';
import { resetCalibration, startMic, isMicOn } from './mic.js';
import { chars, focusTA } from './text.js';

const TOAST_DURATION_MS = 2800;
const START_CARD_FADE_MS = 400;

const $ = (id) => document.getElementById(id);
const textarea = $('textarea');

let toastTimer = null;

// binds a settings slider (and its value label) to store.settings[settingKey], persisting on change
export function bindSlider(domSuffix, settingKey, formatValue) {
  const slider = $('s' + domSuffix);
  const output = $('v' + domSuffix);
  slider.value = store.settings[settingKey];

  const update = () => {
    store.settings[settingKey] = +slider.value;
    output.textContent = formatValue(store.settings[settingKey]);
    persist.set('moodboard.' + settingKey, store.settings[settingKey]);
  };

  slider.addEventListener('input', update);
  update();
}

// wires the settings-sheet toggle, calibration reset, clear, and mic buttons
export function bindButtons() {
  $('setBtn').onclick = () => {
    const sheet = $('sheet');
    sheet.classList.toggle('show');
    $('setBtn').classList.toggle('on', sheet.classList.contains('show'));
  };

  $('calBtn').onclick = () => {
    resetCalibration();
    toast('Type about ten characters normally — that sets your baseline.');
    focusTA();
  };

  $('clrBtn').onclick = () => {
    textarea.value = '';
    chars.length = 0;
    persist.set('moodboard.text', '');
    store.energy = 0;
    focusTA();
  };

  $('micBtn').onclick = () => {
    if (!isMicOn()) startMic();
    focusTA();
  };

  for (const id of ['setBtn', 'micBtn', 'calBtn', 'clrBtn']) {
    $(id).addEventListener('pointerdown', (e) => {
      if (id !== 'setBtn') e.preventDefault();
    });
  }
}

// shows a message in the toast element, fading it out after a fixed duration
export function toast(message) {
  const toastEl = $('toast');
  toastEl.textContent = message;
  toastEl.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.opacity = 0; }, TOAST_DURATION_MS);
}

// fades out and removes the start card, then refocuses the textarea
export function closeStart() {
  const startEl = $('start');
  startEl.style.opacity = 0;
  setTimeout(() => startEl.remove(), START_CARD_FADE_MS);
  focusTA();
}

// wires the start card's mic-opt-in and decline buttons
export function bindStartCard() {
  $('goMic').onclick = () => { closeStart(); startMic(); };
  $('goNo').onclick = () => {
    closeStart();
    toast('Reads your speed, rhythm, and deletions · Turn on the mic above anytime.');
  };
}
