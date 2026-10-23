const SETTINGS_DEFAULTS = {
  textSize: 1,
  sensitivity: 1,
  micWeight: 0.7,
  speedWeight: 0.5,
  decayRate: 1,
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
    content: {
      emotion: 'neutral',
      intensity: 0,
      probs: null,
      confidence: null,
      latency: null,
      tokens: null,
    },
    requests: 0,
    failures: 0,
  },
};
