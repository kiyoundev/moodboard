import { store, persist } from './store.js';

// Flat writing panel size (not the photo) — height/width ratio 1.32, text
// wraps and sizes within this regardless of how the panel is later displayed.
const PW = 1000;
const PH = 1320;
const M = 56; // panel margin

const HP_FILTER_OPTIONS = {
  type: 'highpass',
  frequency: 1000,
  Q: 0.7,
};

const ANALYSER_OPTIONS = {
  fftSize: 2048,
  smoothingTimeConstant: 0,
};

const INITIAL_FLOOR = 0.002;      // starting noise-floor guess, before any real calibration
const PEAK_RETENTION_MS = 1500;   // how long peaks[] entries stick around before being forgotten
const FLOOR_ADAPT_IDLE_MS = 400;  // only adapt the noise floor after this much silence from the keyboard
const FLOOR_FALL_RATE = 0.2;      // blend rate when the room gets quieter (fast)
const FLOOR_RISE_RATE = 0.01;     // blend rate when it gets louder (slow, so keystrokes can't drag the floor up)
const STRIKE_WINDOW_BEFORE_MS = 30;  // strikeForce search window starts slightly before the keydown
const STRIKE_WINDOW_AFTER_MS = 110;  // ...and extends after it, since the sound lags the event
const FLOOR_MARGIN = 1.3;            // how far above the floor a reading has to be to count as a real strike, not noise


const clamp = (value, min, max) => (value < min ? min : value > max ? max : value);
const lerp = (a, b, t) => a + (b - a) * t;
const smoothstep = (edge0, edge1, x) => {
  const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
};

const $ = (id) => document.getElementById(id);
const ta = $('ta');
const panel = $('panel');
const pctx = panel.getContext('2d');
const scene = $('scene');

// ── Mic capture ──────────────────────────────────────────────
let audioContext = null, analyser = null, waveform = null, micOn = false;
const peaks = [];
let floorP = INITIAL_FLOOR;
const strikesRaw = [];

async function startMic() {
  // TODO: build the audio graph (getUserMedia → highpass filter → analyser),
  // set micOn + call setMicUI() on success or failure

  try {
    // web audio api; process audio data
    const AudioContextClass = window.AudioContext || window.webkitAudioContext;                 
    audioContext = audioContext || new AudioContextClass();
    if (audioContext.state !== 'running') await audioContext.resume();

    // media capture/stream; request microphone access
    const stream = await navigator.mediaDevices.getUserMedia({ 
      audio: {
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false
      }
    });

    const micSource = audioContext.createMediaStreamSource(stream);
    const hpFilter = new BiquadFilterNode(audioContext, HP_FILTER_OPTIONS);
    analyser = new AnalyserNode(audioContext, ANALYSER_OPTIONS);
    waveform = new Float32Array(analyser.fftSize);

    micSource.connect(hpFilter).connect(analyser);
    micOn = true;
    setMicUI();
  } catch (e) {
    console.error('Microphone access denied or error:', e);
    micOn = false;
    setMicUI();
  }
}

function setMicUI() {
  $('micBtn').classList.toggle('on', micOn);
  $('micTxt').textContent = micOn ? '듣는 중' : '마이크';
  $('dot').classList.toggle('live', micOn);
}

// called every frame
// keep a short rolling memory of loudness, and recalibrate what counts as quiet
function sampleMic() {
  if (!micOn || !analyser) return;
  analyser.getFloatTimeDomainData(waveform);

  let peak = 0;
  for (let i = 0; i < waveform.length; i++) {
    const v = Math.abs(waveform[i]);
    if (v > peak) peak = v;
  }

  const now = performance.now();
  peaks.push({ t: now, p: peak });
  while (peaks.length && now - peaks[0].t > PEAK_RETENTION_MS) peaks.shift();

  if (now - lastKeyT > FLOOR_ADAPT_IDLE_MS) {
    floorP += (peak - floorP) * (peak < floorP ? FLOOR_FALL_RATE : FLOOR_RISE_RATE);
  }
}

// searches `peaks[]` for the loudest entry within the strike window, then subtracts the noise floor
function strikeForce(t0) {
  let loudest = 0;
  for (const entry of peaks) {
    const inWindow = entry.t >= t0 - STRIKE_WINDOW_BEFORE_MS && entry.t <= t0 + STRIKE_WINDOW_AFTER_MS;
    if (inWindow && entry.p > loudest) loudest = entry.p;
  }
  return Math.max(0, loudest - floorP * FLOOR_MARGIN);
}

function refLevel() {
  if (!strikesRaw.length) return 0;
  const sorted = [...strikesRaw].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle];
}

// ── Keystroke handling ───────────────────────────────────────
const KEYS_HISTORY_LIMIT = 40;
const STRIKE_HISTORY_LIMIT = 24;
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

const keys = [];
let lastKeyT = -1e9, keyId = 0, pendingStrike = null, lastF = null;
const NOTKEY = new Set(['Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Tab', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Fn', 'Hyper', 'Super', 'OS']);

function onKey(e) {
  if (NOTKEY.has(e.key)) return;
  if (e.repeat && e.key !== 'Backspace') return;

  const now = performance.now();
  const k = { t: now, bs: e.key === 'Backspace', f: null, id: ++keyId };

  const dt = now - lastKeyT;
  k.fGuess = clamp((FGUESS_MAX_INTERVAL_MS - dt) / FGUESS_INTERVAL_RANGE_MS, 0, 1) * FGUESS_SCALE;

  keys.push(k);
  while (keys.length > KEYS_HISTORY_LIMIT) keys.shift();
  lastKeyT = now;

  if (micOn) {
    setTimeout(() => {
      const raw = strikeForce(now);
      if (raw > 0) {
        strikesRaw.push(raw);
        while (strikesRaw.length > STRIKE_HISTORY_LIMIT) strikesRaw.shift();
      }
      const ref = refLevel() || raw || MIN_REF_LEVEL;
      k.f = raw <= 0 ? 0 : clamp(FORCE_LOG_BASE + FORCE_LOG_SCALE * Math.log2(raw / ref), 0, 1);
      if (strikesRaw.length < CALIBRATION_MIN_SAMPLES) k.f = Math.min(k.f, CALIBRATION_FORCE_CAP);
      onForce(k);
    }, MIC_CORRECTION_DELAY_MS);
  } else {
    k.f = k.fGuess;
    onForce(k);
  }

  pendingStrike = k;
}

function onForce(k) {
  lastF = k.f;
  store.energy = clamp(store.energy + k.f * ENERGY_BUMP_RATE * store.settings.sensitivity, 0, 1);

  for (const c of chars) {
    if (c.kid === k.id) {
      c.f = Math.max(c.f, k.f);
      c.pop = Math.max(c.pop, POP_BASE + k.f);
    }
  }

  if (!k.bs && k.f > SHAKE_FORCE_THRESHOLD) shake = Math.max(shake, k.f);

  const hit = $('hit');
  hit.style.left = `${clamp(k.f, 0, 1) * 100}%`;
  hit.style.opacity = 1;
  clearTimeout(hit._flashTimer);
  hit._flashTimer = setTimeout(() => { hit.style.opacity = 0; }, HIT_FLASH_DURATION_MS);
}

// ── Mood model ───────────────────────────────────────────────
const MOODS = [['차분', 0], ['집중', .2], ['들썩', .4], ['격앙', .6], ['폭발', .82]];

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

let Fs = 0, Ss = 0; // display-only: last smoothed force / speed, read by the dev meter

function readMood(dt) {
  const now = performance.now();
  const recentKeys = keys.filter((k) => now - k.t < SPEED_WINDOW_MS);
  const keysPerSecond = recentKeys.length / (SPEED_WINDOW_MS / 1000);
  const speedSignal = clamp((keysPerSecond - SPEED_MIN_KPS) / SPEED_RANGE_KPS, 0, 1);

  let jitterSignal = 0;
  {
    const intervals = [];
    for (let i = Math.max(1, keys.length - JITTER_SAMPLE_COUNT); i < keys.length; i++) {
      const gap = keys[i].t - keys[i - 1].t;
      if (gap < JITTER_MAX_INTERVAL_MS) intervals.push(gap);
    }
    if (intervals.length >= JITTER_MIN_SAMPLES) {
      const mean = intervals.reduce((a, b) => a + b) / intervals.length;
      const variance = intervals.reduce((a, b) => a + (b - mean) * (b - mean), 0) / intervals.length;
      const coefficientOfVariation = Math.sqrt(variance) / mean;
      jitterSignal = clamp((coefficientOfVariation - JITTER_BASELINE_CV) / JITTER_RANGE_CV, 0, 1);
    }
  }

  const recentBackspace = keys.slice(-BACKSPACE_SAMPLE_COUNT);
  const backspaceSignal = recentBackspace.length
    ? clamp((recentBackspace.filter((k) => k.bs).length / recentBackspace.length) / BACKSPACE_MAX_RATIO, 0, 1)
    : 0;

  let weightSum = 0, weightedForce = 0;
  for (const k of keys) {
    if (k.f == null || k.bs) continue;
    const weight = Math.exp(-(now - k.t) / FORCE_DECAY_MS);
    weightSum += weight;
    weightedForce += weight * k.f;
  }
  const forceSignal = weightSum > FORCE_MIN_WEIGHT
    ? (weightedForce / weightSum) * clamp(weightSum / FORCE_WEIGHT_NORMALIZER, 0, 1)
    : 0;

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

function moodName(i) {
  let name = MOODS[0][0];
  for (const [label, threshold] of MOODS) {
    if (i >= threshold) name = label;
  }
  return name;
}

// ── Text / char handling ─────────────────────────────────────
const GHOST_INITIAL_LIFE = 1;
const GHOST_UPWARD_SPEED = 60;     // random initial upward kick when a character is deleted
const GHOST_SIDEWAYS_SPEED = 80;   // random sideways spread range
const NEW_CHAR_FORCE_SCALE = 0.6;  // a brand-new character's guessed force, before onForce corrects it

let chars = [], ghosts = [], shake = 0;

function onInput() {
  const newText = Array.from(ta.value);
  const oldChars = chars;

  let matchLength = 0;
  while (matchLength < oldChars.length && matchLength < newText.length && oldChars[matchLength].c === newText[matchLength]) {
    matchLength++;
  }

  for (let i = matchLength; i < oldChars.length; i++) {
    const c = oldChars[i];
    if (c.x != null && c.c.trim()) {
      ghosts.push({
        ...c,
        vy: -GHOST_UPWARD_SPEED * Math.random(),
        vx: (Math.random() - 0.5) * GHOST_SIDEWAYS_SPEED,
        life: GHOST_INITIAL_LIFE,
      });
    }
  }

  const k = pendingStrike;
  const addedChars = newText.slice(matchLength).map((c) => ({
    c,
    kid: k ? k.id : 0,
    f: k && k.f != null ? k.f : (k ? k.fGuess * NEW_CHAR_FORCE_SCALE : 0),
    pop: 1,
    t: performance.now(),
    x: null,
    y: null,
    s: 1,
  }));

  chars = oldChars.slice(0, matchLength).concat(addedChars);
  persist.set('moodboard.text', ta.value);
}

function isUI(target) {
  return target && (target.tagName === 'INPUT' || (target.closest && target.closest('#sheet')));
}

function focusTA() {
  ta.focus({ preventScroll: true });
  const end = ta.value.length;
  ta.setSelectionRange(end, end);
}

const ARROW_AND_HOME_END_KEYS = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Home', 'End'];

ta.addEventListener('input', onInput);
ta.addEventListener('keydown', (e) => {
  if (ARROW_AND_HOME_END_KEYS.includes(e.key)) e.preventDefault();
  onKey(e);
});
addEventListener('keydown', (e) => {
  if (document.activeElement !== ta && !e.metaKey && !e.ctrlKey && !isUI(e.target)) focusTA();
});
scene.addEventListener('pointerdown', (e) => {
  e.preventDefault();
  focusTA();
  $('sheet').classList.remove('show');
  $('setBtn').classList.remove('on');
});

// ── Draw helpers ─────────────────────────────────────────────
const FONT_FAMILY = '"Helvetica Neue",Helvetica,Arial,"Apple SD Gothic Neo","Noto Sans KR",sans-serif';
const CHAR_WIDTH_MEASURE_PX = 100; // measure at a fixed large size, then scale proportionally — more stable than measuring at every actual size

const WCACHE = new Map();

function cw(ch) {
  let width = WCACHE.get(ch);
  if (width == null) {
    pctx.font = `800 ${CHAR_WIDTH_MEASURE_PX}px ${FONT_FAMILY}`;
    width = pctx.measureText(ch).width / CHAR_WIDTH_MEASURE_PX;
    WCACHE.set(ch, width);
  }
  return width;
}

const HANGUL_PATTERN = /[ᄀ-ᇿ㄰-㆏가-힣]/;
const isHan = (ch) => HANGUL_PATTERN.test(ch);

const INK_COLOR = [21, 21, 21];
const RED_COLOR = [226, 35, 26];
const GHOST_COLOR = [190, 189, 185];

const mix = (colorA, colorB, t) =>
  `rgb(${colorA.map((v, i) => Math.round(v + (colorB[i] - v) * t)).join(',')})`;

// 3-sine pseudo-noise: cheap, deterministic, good enough for jitter/wobble — not real randomness
function nz(i, t) {
  return Math.sin(i * 12.9898 + t * 7.1) * 0.5
    + Math.sin(i * 4.13 + t * 11.3) * 0.3
    + Math.sin(i * 1.7 + t * 17.9) * 0.2;
}

// ── Draw loop ────────────────────────────────────────────────
let T = 0;
let FIT = 150, FITt = 150, fitAcc = 1;

const PLACEHOLDER_BG_COLOR = '#dcdcda';          // flat fallback background (no photo compositing yet)
const REDNESS_LOW = 0.32, REDNESS_HIGH = 0.78;   // store.energy range mapped onto the ink→red color shift
const PLACEHOLDER_LINES = ['지금 기분을', '쳐 보세요.'];
const PLACEHOLDER_FONT_SIZE = 112;
const PLACEHOLDER_LINE_TOP = 104, PLACEHOLDER_LINE_GAP = 118;
const PLACEHOLDER_CARET_BLINK_HZ = 1.6;
const PLACEHOLDER_CARET_WIDTH = 12, PLACEHOLDER_CARET_HEIGHT = 96;
const TEXT_CARET_BLINK_HZ = 1.7;
const MIN_LAST_LINE_HEIGHT = 30; // keep porting into frame budget for the last visible line

function drawPanel(ctx, forSave) {
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.fillStyle = PLACEHOLDER_BG_COLOR;
  ctx.fillRect(0, 0, PW, PH);

  const energy = store.energy;
  const textSize = store.settings.textSize;
  const redness = smoothstep(REDNESS_LOW, REDNESS_HIGH, energy);
  const fontSize = FIT * textSize * (1 + 0.85 * Math.pow(energy, 1.2)); // grows past the calm "fit" size as energy rises
  const tracking = lerp(-0.02, -0.055, energy); // letter-spacing tightens as energy rises

  // Screen-wide wobble: a slow energy-driven sway, plus a sharp kick from `shake` right after a hard keystroke
  const jitterX = nz(1, T) * Math.pow(energy, 3) * 7 + nz(7, T * 1.7) * shake * 9;
  const jitterY = nz(3, T) * Math.pow(energy, 3) * 5 + nz(9, T * 1.9) * shake * 7;
  ctx.save();
  ctx.translate(jitterX, jitterY);

  if (!chars.length) {
    ctx.fillStyle = 'rgba(30,30,30,.16)';
    ctx.font = `800 ${PLACEHOLDER_FONT_SIZE * textSize}px ${FONT_FAMILY}`;
    ctx.textBaseline = 'alphabetic';
    PLACEHOLDER_LINES.forEach((line, i) => {
      ctx.fillText(line, M, M + (PLACEHOLDER_LINE_TOP + i * PLACEHOLDER_LINE_GAP) * textSize);
    });
    if (Math.floor(T * PLACEHOLDER_CARET_BLINK_HZ) % 2 === 0) {
      ctx.fillStyle = mix(INK_COLOR, RED_COLOR, redness);
      ctx.fillRect(M, M + (PLACEHOLDER_LINE_TOP + PLACEHOLDER_LINE_GAP + PLACEHOLDER_LINE_GAP) * textSize, PLACEHOLDER_CARET_WIDTH * textSize, PLACEHOLDER_CARET_HEIGHT * textSize);
    }
    ctx.restore();
    return;
  }

  // A character's own size grows with its own strike force (scaled up further as energy rises) and its "pop" bounce
  const sizeOf = (c) => fontSize * (1 + 0.48 * c.f * (0.25 + 0.75 * energy) + c.pop * 0.22);

  const maxWidth = PW - 2 * M;
  const lines = [];
  let line = [], lineWidth = 0, word = [], wordWidth = 0;

  const flushWord = () => {
    if (!word.length) return;
    if (lineWidth + wordWidth > maxWidth && line.length) {
      lines.push(line);
      line = [];
      lineWidth = 0;
      while (line.length && line[0].c === ' ') line.shift();
    }
    if (wordWidth > maxWidth) {
      for (const g of word) {
        if (lineWidth + g.w > maxWidth && line.length) { lines.push(line); line = []; lineWidth = 0; }
        line.push(g);
        lineWidth += g.w;
      }
    } else {
      for (const g of word) line.push(g);
      lineWidth += wordWidth;
    }
    word = [];
    wordWidth = 0;
  };

  for (const c of chars) {
    if (c.c === '\n') { flushWord(); lines.push(line); line = []; lineWidth = 0; continue; }
    const s = sizeOf(c);
    const w = (c.c === ' ' ? cw(' ') * fontSize : cw(c.c) * s) + tracking * s;
    const g = { c, s, w };
    if (c.c === ' ') {
      flushWord();
      if (line.length) { line.push(g); lineWidth += g.w; }
    } else {
      word.push(g);
      wordWidth += g.w;
    }
  }
  flushWord();
  lines.push(line);

  const lineHeights = lines.map((l) => {
    let maxCharHeight = fontSize * 0.82;
    let hasHangul = false;
    for (const g of l) {
      if (g.c.c !== ' ') maxCharHeight = Math.max(maxCharHeight, g.s);
      if (isHan(g.c.c)) hasHangul = true;
    }
    return maxCharHeight * (hasHangul ? 1.02 : 0.9); // Hangul glyphs read as needing slightly more line height
  });

  // Only render as many trailing lines as fit — the newest line must always stay visible
  let firstVisible = lines.length - 1;
  let visibleHeight = lineHeights[firstVisible];
  while (firstVisible > 0 && visibleHeight + lineHeights[firstVisible - 1] <= PH - 2 * M - MIN_LAST_LINE_HEIGHT) {
    firstVisible--;
    visibleHeight += lineHeights[firstVisible];
  }

  let y = M;
  ctx.textBaseline = 'alphabetic';
  for (const c of chars) c.x = null;

  let caretX = M, caretY = M + fontSize * 0.78, caretSize = fontSize;

  for (let li = firstVisible; li < lines.length; li++) {
    const l = lines[li];
    const baseline = y + lineHeights[li] * 0.8;
    let x = M;
    for (const g of l) {
      const c = g.c;
      if (c.c !== ' ') {
        const charIndex = chars.indexOf(c);
        // Per-character rotation and wobble, both driven by energy and this character's own strike force
        const rotationAmount = Math.pow(energy, 2) * 0.06 + c.f * energy * 0.05;
        const wobbleX = nz(charIndex, T * 1.3) * (Math.pow(energy, 2.2) * 5 + c.f * energy * 4);
        const wobbleY = nz(charIndex + 50, T * 1.1) * (Math.pow(energy, 2.2) * 5 + c.f * energy * 4);
        const charRedness = clamp(redness + c.f * 0.42 * smoothstep(0.12, 0.5, energy) - (1 - c.f) * 0.08 * redness, 0, 1);

        ctx.save();
        ctx.translate(x + wobbleX, baseline + wobbleY);
        ctx.rotate(nz(charIndex + 90, T * 0.9) * rotationAmount);
        ctx.font = `800 ${g.s}px ${FONT_FAMILY}`;
        ctx.fillStyle = mix(INK_COLOR, RED_COLOR, charRedness);
        ctx.fillText(c.c, 0, 0);
        ctx.restore();

        c.x = x; c.y = baseline; c.s = g.s; c.col = charRedness;
      }
      x += g.w;
    }
    if (li === lines.length - 1) {
      caretX = x;
      caretY = baseline;
      caretSize = Math.max(fontSize, l.length ? l[l.length - 1].s : fontSize);
    }
    y += lineHeights[li];
  }

  const caretVisible = !forSave && (document.activeElement === ta ? Math.floor(T * TEXT_CARET_BLINK_HZ) % 2 === 0 : true);
  if (caretVisible) {
    ctx.fillStyle = mix(INK_COLOR, RED_COLOR, redness);
    ctx.fillRect(caretX + caretSize * 0.04, caretY - caretSize * 0.74, Math.max(9, caretSize * 0.085), caretSize * 0.84);
  }

  for (const g of ghosts) {
    ctx.save();
    ctx.globalAlpha = clamp(g.life, 0, 1) * 0.8;
    ctx.font = `800 ${g.s}px ${FONT_FAMILY}`;
    ctx.fillStyle = mix(GHOST_COLOR, RED_COLOR, g.col * 0.6);
    ctx.translate(g.x, g.y);
    ctx.rotate((1 - g.life) * g.vx * 0.004);
    ctx.fillText(g.c, 0, 0);
    ctx.restore();
  }

  ctx.restore();
}

const FIT_SIZE_MAX = 270, FIT_SIZE_MIN = 92, FIT_SIZE_STEP = 6; // search range/step for the "fits without overflow" size
const FIT_MARGIN_RIGHT = 8, FIT_MARGIN_BOTTOM = 40;

function fitSize() {
  if (!chars.length) return FIT;
  const maxWidth = PW - 2 * M - FIT_MARGIN_RIGHT;
  const maxHeight = PH - 2 * M - FIT_MARGIN_BOTTOM;

  for (let fontSize = FIT_SIZE_MAX; fontSize >= FIT_SIZE_MIN; fontSize -= FIT_SIZE_STEP) {
    let lineWidth = 0, wordWidth = 0, hasHangul = false, height = 0;
    const lineHeight = () => fontSize * 1.12 * (hasHangul ? 1.02 : 0.9);

    for (const c of chars) {
      if (isHan(c.c)) hasHangul = true;
      if (c.c === '\n') {
        if (lineWidth + wordWidth > maxWidth && lineWidth > 0) { height += lineHeight(); lineWidth = wordWidth; }
        else lineWidth += wordWidth;
        wordWidth = 0;
        height += lineHeight();
        lineWidth = 0;
        continue;
      }
      const forceBoost = 1 + 0.12 * c.f; // a forcefully-typed character counts as slightly wider even before rendering
      const charWidth = (c.c === ' ' ? cw(' ') * fontSize : cw(c.c) * fontSize * forceBoost) - 0.02 * fontSize * forceBoost;
      if (c.c === ' ') {
        if (lineWidth + wordWidth > maxWidth && lineWidth > 0) { height += lineHeight(); lineWidth = wordWidth; }
        else lineWidth += wordWidth;
        wordWidth = 0;
        lineWidth += charWidth;
      } else {
        wordWidth += charWidth;
      }
    }
    if (lineWidth + wordWidth > maxWidth && lineWidth > 0) height += lineHeight();
    height += lineHeight();

    if (height <= maxHeight) return fontSize;
  }
  return FIT_SIZE_MIN;
}

const ANNOT_FONT_SIZE = 17;
const ANNOT_ROW_GAP = 21, ANNOT_LABEL_VALUE_GAP = 64;
const ANNOT_MIN_FREE_WIDTH = 210;
const ANNOT_FALLBACK_X_OFFSET = 190, ANNOT_FALLBACK_TOP = 30, ANNOT_FALLBACK_ROW_GAP = 260;
const ANNOT_HEAT_REDNESS_LOW = 0.6, ANNOT_HEAT_REDNESS_HIGH = 0.8;
const ANNOT_HOT_THRESHOLD = 0.6;

function annot(ctx, lineLayouts) {
  const rows = [
    [['상태', '세기'], [moodName(store.energy), micOn && lastF != null ? String(Math.round(Fs * 100)).padStart(2, '0') : '—']],
    [['속도', '열기'], [Ss.toFixed(1) + '타/s', Math.round(store.energy * 100) + '°']],
  ];

  const spots = [];
  let y = M;
  for (const row of lineLayouts) {
    let width = 0;
    for (const g of row.l) width += g.w;
    const freeWidth = PW - M - (M + width);
    if (freeWidth > ANNOT_MIN_FREE_WIDTH && spots.length < 2) spots.push([M + width + 34, y + row.h * 0.42]);
    y += row.h;
  }
  if (!spots.length) spots.push([PW - M - ANNOT_FALLBACK_X_OFFSET, M + ANNOT_FALLBACK_TOP]);
  if (spots.length < 2) spots.push([PW - M - ANNOT_FALLBACK_X_OFFSET, Math.min(PH - M - 40, spots[0][1] + ANNOT_FALLBACK_ROW_GAP)]);

  ctx.font = `500 ${ANNOT_FONT_SIZE}px ${FONT_FAMILY}`;
  ctx.textBaseline = 'top';
  rows.forEach((row, i) => {
    const [x, y0] = spots[i];
    ctx.fillStyle = 'rgba(20,20,20,.62)';
    row[0].forEach((label, k) => ctx.fillText(label, x, y0 + k * ANNOT_ROW_GAP));
    ctx.fillStyle = i === 0 && store.energy > ANNOT_HOT_THRESHOLD
      ? mix(INK_COLOR, RED_COLOR, smoothstep(ANNOT_HEAT_REDNESS_LOW, ANNOT_HEAT_REDNESS_HIGH, store.energy))
      : 'rgba(20,20,20,.86)';
    row[1].forEach((value, k) => ctx.fillText(value, x + ANNOT_LABEL_VALUE_GAP, y0 + k * ANNOT_ROW_GAP));
  });
}

const FIT_RECOMPUTE_INTERVAL_S = 0.12;   // how often fitSize() (an O(n) scan) gets recomputed, not every frame
const SHAKE_DECAY_RATE = 0.004;
const CHAR_POP_DECAY_RATE = 0.02;
const GHOST_FADE_RATE = 1.8;             // life lost per second
const GHOST_GRAVITY = 900;               // px/s² downward acceleration
const UI_TEXT_UPDATE_INTERVAL_S = 0.08;  // throttle for the plain DOM state/meter text, no need to touch it every frame
const HOT_ENERGY_THRESHOLD = 0.6;        // above this, the state label/meter switch to the red color

let last = performance.now(), uiT = 0;

function frame(now) {
  const dt = Math.min(0.05, (now - last) / 1000);
  last = now;
  T += dt;

  sampleMic();
  readMood(dt);

  fitAcc += dt;
  if (fitAcc > FIT_RECOMPUTE_INTERVAL_S) { fitAcc = 0; FITt = fitSize(); }
  FIT += (FITt - FIT) * (1 - Math.pow(0.02, dt));

  shake *= Math.pow(SHAKE_DECAY_RATE, dt);
  for (const c of chars) c.pop *= Math.pow(CHAR_POP_DECAY_RATE, dt);

  for (const g of ghosts) {
    g.life -= dt * GHOST_FADE_RATE;
    g.vy += GHOST_GRAVITY * dt;
    g.y += g.vy * dt;
    g.x += g.vx * dt;
  }
  ghosts = ghosts.filter((g) => g.life > 0);

  drawPanel(pctx, false);

  uiT += dt;
  if (uiT > UI_TEXT_UPDATE_INTERVAL_S) {
    uiT = 0;
    const stateEl = $('state');
    stateEl.textContent = moodName(store.energy);
    stateEl.style.color = store.energy > HOT_ENERGY_THRESHOLD ? 'var(--red)' : 'var(--ink)';
    $('mF').textContent = micOn && lastF != null ? String(Math.round(Fs * 100)).padStart(2, '0') : '—';
    $('mS').textContent = Ss.toFixed(1);
    const fillEl = $('fill');
    fillEl.style.width = (store.energy * 100) + '%';
    fillEl.style.background = store.energy > HOT_ENERGY_THRESHOLD ? 'var(--red)' : 'var(--ink)';
  }

  requestAnimationFrame(frame);
}

// ── Settings UI ──────────────────────────────────────────────
function bindSlider(domSuffix, settingKey, formatValue) {
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

// ── Buttons / start card / toast ─────────────────────────────
const TOAST_DURATION_MS = 2800;
const START_CARD_FADE_MS = 400;

function bindButtons() {
  $('setBtn').onclick = () => {
    const sheet = $('sheet');
    sheet.classList.toggle('show');
    $('setBtn').classList.toggle('on', sheet.classList.contains('show'));
  };

  $('calBtn').onclick = () => {
    strikesRaw.length = 0;
    toast('평소처럼 열 글자쯤 쳐 주세요 · 그게 기준이 돼요');
    focusTA();
  };

  $('clrBtn').onclick = () => {
    ta.value = '';
    chars = [];
    persist.set('moodboard.text', '');
    store.energy = 0;
    focusTA();
  };

  $('micBtn').onclick = () => {
    if (!micOn) startMic();
    focusTA();
  };

  for (const id of ['setBtn', 'micBtn', 'calBtn', 'clrBtn']) {
    $(id).addEventListener('pointerdown', (e) => {
      if (id !== 'setBtn') e.preventDefault();
    });
  }
}

let toastTimer = null;
function toast(message) {
  const toastEl = $('toast');
  toastEl.textContent = message;
  toastEl.style.opacity = 1;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { toastEl.style.opacity = 0; }, TOAST_DURATION_MS);
}

function closeStart() {
  const startEl = $('start');
  startEl.style.opacity = 0;
  setTimeout(() => startEl.remove(), START_CARD_FADE_MS);
  focusTA();
}

function bindStartCard() {
  $('goMic').onclick = () => { closeStart(); startMic(); };
  $('goNo').onclick = () => {
    closeStart();
    toast('빠르기·리듬·지우기로 읽어요 · 위 마이크 버튼으로 언제든 켤 수 있어요');
  };
}

// ── Debug global ─────────────────────────────────────────────
window.__kb = {
  get fit() { return [FIT, FITt, fitSize()]; },
  get energy() { return store.energy; },
  set energy(v) { store.energy = v; },
  get chars() { return chars; },
  keys,
  settings: store.settings,
  get micOn() { return micOn; },
  moodName,
  drawPanel,
};

// ── Bootstrap ─────────────────────────────────────────────────
bindSlider('Z', 'textSize', (v) => '×' + v.toFixed(2).replace(/0$/, ''));
bindSlider('M', 'sensitivity', (v) => '×' + v.toFixed(1));
bindSlider('F', 'micWeight', (v) => Math.round(v * 100) + '%');
bindSlider('S', 'speedWeight', (v) => Math.round(v * 100) + '%');
bindSlider('D', 'decayRate', (v) => (v < 0.7 ? '느리게' : v > 1.6 ? '빠르게' : '보통'));

bindButtons();
bindStartCard();

const savedText = persist.get('moodboard.text');
if (savedText) {
  ta.value = savedText;
  onInput();
  for (const c of chars) c.pop = 0;
}

requestAnimationFrame(frame);
