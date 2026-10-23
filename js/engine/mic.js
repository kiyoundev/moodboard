const HP_FILTER_OPTIONS = {
  type: 'highpass',
  frequency: 1100,
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
const STRIKE_HISTORY_LIMIT = 24;    // keep the last N strike samples for referenceLevel()

let audioContext = null, analyser = null, waveform = null, micOn = false;
let floorP = INITIAL_FLOOR;
const peaks = [];
const strikesRaw = [];

const $ = (id) => document.getElementById(id);

export async function startMic() {
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

export function setMicUI() {
  $('micBtn').classList.toggle('on', micOn);
  $('micTxt').textContent = micOn ? '듣는 중' : '마이크';
  $('dot').classList.toggle('live', micOn);
}

export function isMicOn() {
  return micOn;
}

// called every frame
// keep a short rolling memory of loudness, and recalibrate what counts as quiet
// lastKeyT is the timestamp (performance.now()) of the most recent keydown
export function sampleMic(lastKeyT) {
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
export function strikeForce(t0) {
  let loudest = 0;
  for (const entry of peaks) {
    const inWindow = entry.t >= t0 - STRIKE_WINDOW_BEFORE_MS && entry.t <= t0 + STRIKE_WINDOW_AFTER_MS;
    if (inWindow && entry.p > loudest) loudest = entry.p;
  }
  return Math.max(0, loudest - floorP * FLOOR_MARGIN);
}

export function refLevel() {
  if (!strikesRaw.length) return 0;
  const sorted = [...strikesRaw].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted[middle];
}

export function sampleCount() {
  return strikesRaw.length;
}

export function resetCalibration() {
  strikesRaw.length = 0;
}

export function recordStrike(raw) {
  strikesRaw.push(raw);
  // trims old entries; only last ~120 strikes count as recent typing
  while (strikesRaw.length > STRIKE_HISTORY_LIMIT) {
    strikesRaw.shift();
  }
}