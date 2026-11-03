const SETTINGS_DEFAULTS = {
  textSize: 1,
  sensitivity: 1,
  micWeight: 0.7,
  speedWeight: 0.5,
  decayRate: 1,
};

// jev.js's resetContent() restores this same shape, so it and the store's
// initial value share one source of truth instead of two copies
export const MOOD_CONTENT_DEFAULTS = {
  emotion: 'neutral',
  intensity: 0,
  emotionConfidence: null,
  intensityConfidence: null,
  emotionProbs: null,
  intensityProbs: null,
  latency: null,
  tokens: null,
  raw: null,
};

// localStorage helper
export const persist = {
  get(k) { 
    try { 
      return localStorage.getItem(k); 
    } catch (e) { 
      return null; 
    } 
  },
  set(k, v) { 
    try { 
      localStorage.setItem(k, v); 
    } catch (e) {} 
  },
};


// store for all application state
export const store = {
  settings: {
    textSize: +(persist.get('moodboard.textSize') || SETTINGS_DEFAULTS.textSize),
    sensitivity: +(persist.get('moodboard.sensitivity') || SETTINGS_DEFAULTS.sensitivity),
    micWeight: +(persist.get('moodboard.micWeight') || SETTINGS_DEFAULTS.micWeight),
    speedWeight: +(persist.get('moodboard.speedWeight') || SETTINGS_DEFAULTS.speedWeight),
    decayRate: +(persist.get('moodboard.decayRate') || SETTINGS_DEFAULTS.decayRate),
  },
  energy: 0,
  mood: {
    content: { ...MOOD_CONTENT_DEFAULTS },
    requests: 0,
    failures: 0,
  },
};
