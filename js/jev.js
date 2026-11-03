/*
 * jev.js
 *
 * Owns the "slow clock" (overview.md §3.8): debounces typed text into
 * occasional /api/decide calls and writes the result into
 * store.mood.content. The fast clock (chars[]/energy, every frame) never
 * waits on this — on failure or timeout the store is just left alone.
 */

import { store, MOOD_CONTENT_DEFAULTS } from './store.js';
import { chars } from './engine/text.js';

const DEBOUNCE_MS = 800;
const SENTENCE_BOUNDARY_CHARS = ['.', '!', '?'];

const $ = (id) => document.getElementById(id);
const textarea = $('textarea');

let debounceTimer = null;
let abortController = null;

// resets the debounce timer on every call; fires immediately instead if the
// just-typed character ends a sentence — index.js calls this alongside
// text.js's onInput() on the same textarea input event
export function onContentInput() {
  const text = textarea.value;
  clearTimeout(debounceTimer);
  if (!text.trim()) {
    console.log('[jev] empty text, skip');
    return;
  }

  const lastChar = chars.length ? chars[chars.length - 1].c : null;
  if (SENTENCE_BOUNDARY_CHARS.includes(lastChar)) {
    console.log('[jev] sentence boundary %o, fire now', lastChar);
    fireDecide(text);
  } else {
    console.log('[jev] timer (re)armed, %dms', DEBOUNCE_MS);
    debounceTimer = setTimeout(() => fireDecide(text), DEBOUNCE_MS);
  }
}

// fetches /api/decide for the given text, cancelling any still-in-flight
// call first so only one request is ever outstanding at a time
async function fireDecide(text) {
  if (abortController) abortController.abort();
  abortController = new AbortController();
  const { signal } = abortController;

  const sentAt = performance.now();
  console.log('[jev] → request', JSON.stringify(text));

  try {
    const response = await fetch('/api/decide', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text }),
      signal,
    });
    const data = await response.json();
    store.mood.requests++;
    console.log('[jev] ← response %dms (wall %dms)', data.latency, Math.round(performance.now() - sentAt), data);

    if (!response.ok || !data.ok) {
      store.mood.failures++;
      console.log('[jev] failure, HTTP %d: %s', response.status, data.error);
      return;
    }

    store.mood.content.emotion = data.emotion.choice;
    store.mood.content.intensity = data.intensity.score;
    store.mood.content.emotionConfidence = data.emotion.confidence;
    store.mood.content.intensityConfidence = data.intensity.confidence;
    store.mood.content.emotionProbs = data.emotion.probabilities;
    store.mood.content.intensityProbs = data.intensity.probabilities;
    store.mood.content.latency = data.latency;
    store.mood.content.tokens = data.tokens;
    store.mood.content.raw = data;
  } catch (e) {
    // this module's own cancellation (a newer call, or resetContent())
    // superseded this one — not a real attempt, don't count it either way
    if (e.name === 'AbortError') {
      console.log('[jev] aborted (superseded)');
      return;
    }
    store.mood.requests++;
    store.mood.failures++;
    console.log('[jev] request threw:', e);
  }
}

// cancels any pending debounce timer and in-flight request, and resets
// mood.content back to neutral — ui.js's clrBtn handler calls this
export function resetContent() {
  console.log('[jev] resetContent');
  clearTimeout(debounceTimer);
  if (abortController) abortController.abort();
  Object.assign(store.mood.content, MOOD_CONTENT_DEFAULTS);
}
