const TYPESAFE_URL = 'https://api.typesafe.ai/v1/systemone';
const TIMEOUT_MS = 10000;

const EMOTION_CRITERIA = {
  neutral: 'No strong emotion; calm or matter-of-fact tone',
  happy: 'Joy, excitement, or positive feeling',
  sad: 'Sorrow, disappointment, or low mood',
  angry: 'Frustration, rage, hostility, disgust, or contemptuous dismissiveness',
  fear: 'Anxiety, worry, fright, or sudden shock/surprise',
};

const INTENSITY_CRITERIA = ['none', 'weak', 'clear', 'strong', 'overwhelming'];

module.exports = async (req, res) => {
  // reject non-POST requests
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'Method not allowed' });
    return;
  }

  // reject missing text body
  const { text } = req.body || {};
  if (typeof text !== 'string' || !text.trim()) {
    res.status(400).json({ ok: false, error: 'Missing text' });
    return;
  }

  // reject missing API key
  const apiKey = process.env.JEV_API_KEY;
  if (!apiKey) {
    console.error('JEV_API_KEY is not set');
    res.status(500).json({ ok: false, error: 'Server misconfigured' });
    return;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);
  const started = Date.now();

  try {
    const request = await fetch(TYPESAFE_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'jev-latest',
        state: text,
        questions: {
          emotion: {
            type: 'choice',
            instructions: 'What emotion does this text express?',
            criteria: EMOTION_CRITERIA,
          },
          intensity: {
            type: 'score',
            instructions: 'How intense is the emotion expressed?',
            criteria: INTENSITY_CRITERIA,
          },
        },
      }),
      signal: controller.signal,
    });

    const latency = Date.now() - started;

    // relay upstream error; jev answers, but with an error status    
    if (!request.ok) {
      const body = await request.text().catch(() => '');
      console.error(`jev request error ${request.status}: ${body.slice(0, 500)}`);
      res.status(502).json({ ok: false, error: `jev error ${request.status}`, latency });
      return;
    }

    const response = await request.json();
    const { emotion, intensity } = response.answers || {};

    // return response
    res.status(200).json({
      ok: true,
      emotion,
      intensity,
      latency,
      tokens: response.usage?.input_tokens ?? null,
    });
  } catch (err) {                                           // relay client error; fetch never completed
    const latency = Date.now() - started;
    const timedOut = err.name === 'AbortError';
    console.error('jev request failed:', err);
    res.status(timedOut ? 504 : 502).json({
      ok: false,
      error: timedOut ? 'jev request timed out' : 'jev request failed',
      latency,
    });
  } finally {
    clearTimeout(timeout);
  }
};
