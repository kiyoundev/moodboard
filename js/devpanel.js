/*
 * devpanel.js
 *
 * Diagnostics overlay for both clocks (overview.md §3.7/§3.8): jev's raw
 * slow-clock output (emotion/intensity distributions, confidence, latency,
 * tokens, request/failure counts) alongside the fast-clock behavior signal
 * (store.energy). Read-only against store — writes nothing back.
 */

import { store } from './store.js';
import { moodName } from './engine/mood.js';

const $ = (id) => document.getElementById(id);

const statsBtn = $('statsBtn');

const dpEmotionLabel = $('dpEmotionLabel');
const dpIntensityVal = $('dpIntensityVal');
const dpIntensityBar = $('dpIntensityBar');
const dpScoreVal = $('dpScoreVal');

const dpEnergyState = $('dpEnergyState');
const dpEnergyVal = $('dpEnergyVal');
const dpEnergyBar = $('dpEnergyBar');

const dpConfEmotion = $('dpConfEmotion');
const dpConfIntensity = $('dpConfIntensity');
const dpLatency = $('dpLatency');
const dpTokens = $('dpTokens');
const dpRequests = $('dpRequests');
const dpFailures = $('dpFailures');
const dpRawJson = $('dpRawJson');

const EMOTION_KEYS = ['neutral', 'happy', 'sad', 'angry', 'fear']; // matches api/decide.js's EMOTION_CRITERIA order
const emotionRows = {
  neutral: { bar: $('dpEpNeutralBar'), val: $('dpEpNeutralVal'), row: $('dpEpNeutralRow') },
  happy:   { bar: $('dpEpHappyBar'),   val: $('dpEpHappyVal'),   row: $('dpEpHappyRow') },
  sad:     { bar: $('dpEpSadBar'),     val: $('dpEpSadVal'),     row: $('dpEpSadRow') },
  angry:   { bar: $('dpEpAngryBar'),   val: $('dpEpAngryVal'),   row: $('dpEpAngryRow') },
  fear:    { bar: $('dpEpFearBar'),    val: $('dpEpFearVal'),    row: $('dpEpFearRow') },
};

const INTENSITY_LABELS = ['none', 'weak', 'clear', 'strong', 'overwhelming']; // matches api/decide.js's INTENSITY_CRITERIA order
const intensityRows = INTENSITY_LABELS.map((_, i) => ({
  bar: $(`dpIpBar${i}`), val: $(`dpIpVal${i}`), row: $(`dpIpRow${i}`),
}));

// flips the panel's open/closed state via a class on <body> (not #devpanel
// itself — #scene/#meter need to react too, and they appear earlier in the
// DOM, out of reach of a CSS sibling selector). Deliberately doesn't wire
// its own click listener — index.js's statsBtn handler calls this and
// layout() together so the canvas resize and panel slide animate in sync
export function toggleDevPanel() {
  const open = document.body.classList.toggle('stats-open');
  statsBtn.classList.toggle('on', open);
}

// writes store.mood/store.energy into the panel's DOM — no-ops while hidden
export function updateDevPanel() {
  if (!document.body.classList.contains('stats-open')) return;

  dpEnergyState.textContent = moodName(store.energy);
  dpEnergyVal.textContent = store.energy.toFixed(2);
  dpEnergyBar.style.width = (store.energy * 100) + '%';

  dpRequests.textContent = store.mood.requests;
  dpFailures.textContent = store.mood.failures;

  const content = store.mood.content;
  if (content.raw === null) {
    dpEmotionLabel.textContent = '—';
    dpIntensityVal.textContent = '—';
    dpIntensityBar.style.width = '0%';
    dpScoreVal.textContent = '—';
    dpConfEmotion.textContent = '—';
    dpConfIntensity.textContent = '—';
    dpLatency.textContent = '—';
    dpTokens.textContent = '—';
    dpRawJson.textContent = '—';
    for (const key of EMOTION_KEYS) {
      emotionRows[key].bar.style.width = '0%';
      emotionRows[key].val.textContent = '—';
      emotionRows[key].row.classList.remove('winner');
    }
    for (const row of intensityRows) {
      row.bar.style.width = '0%';
      row.val.textContent = '—';
      row.row.classList.remove('winner');
    }
    return;
  }

  dpEmotionLabel.textContent = content.emotion;
  dpIntensityVal.textContent = (content.intensity / 4).toFixed(3);
  dpIntensityBar.style.width = (content.intensity / 4 * 100) + '%';
  dpScoreVal.textContent = `${content.intensity.toFixed(3)} → ${INTENSITY_LABELS[Math.round(content.intensity)]}`;
  dpConfEmotion.textContent = `emotion=${content.emotionConfidence.toFixed(2)}`;
  dpConfIntensity.textContent = `intensity=${content.intensityConfidence.toFixed(2)}`;
  dpLatency.textContent = `${content.latency} ms`;
  dpTokens.textContent = content.tokens ?? '—';
  dpRawJson.textContent = JSON.stringify(content.raw, null, 2);

  let emotionWinner = null, emotionMax = -1;
  for (const key of EMOTION_KEYS) {
    const prob = content.emotionProbs[key] ?? 0;
    emotionRows[key].bar.style.width = (prob * 100) + '%';
    emotionRows[key].val.textContent = prob.toFixed(3);
    if (prob > emotionMax) { emotionMax = prob; emotionWinner = key; }
  }
  for (const key of EMOTION_KEYS) emotionRows[key].row.classList.toggle('winner', key === emotionWinner);

  let intensityWinnerIdx = -1, intensityMax = -1;
  intensityRows.forEach((row, i) => {
    const prob = content.intensityProbs[i] ?? 0;
    row.bar.style.width = (prob * 100) + '%';
    row.val.textContent = prob.toFixed(3);
    if (prob > intensityMax) { intensityMax = prob; intensityWinnerIdx = i; }
  });
  intensityRows.forEach((row, i) => row.row.classList.toggle('winner', i === intensityWinnerIdx));
}
