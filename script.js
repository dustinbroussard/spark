
const $ = (id) => document.getElementById(id);
// Map friendly option values to OpenRouter model IDs
const MODEL_MAP = {
  'qwen2.5:7b-instruct': 'qwen/qwen-2.5-7b-instruct',
  'llama-3.1-8b-instruct': 'meta-llama/llama-3.1-8b-instruct',
  'mistral-nemo': 'mistralai/mistral-nemo',
  'gemma2:9b-instruct': 'google/gemma-2-9b-it',
};
const state = {
  seeds: {},
  lastResult: '',
  lastJSON: null,
  deferredPrompt: null,
};

// Load persisted settings
(function initPersist() {
  const savedKey = localStorage.getItem('sparksmith:apiKey');
  if (savedKey) $('apiKey').value = savedKey;
  const savedModel = localStorage.getItem('sparksmith:model');
  if (savedModel) $('model').value = savedModel;
  $('temperature').addEventListener('input', () => {
    $('tempVal').textContent = $('temperature').value;
  });
  // Initialize temperature label on load
  $('tempVal').textContent = $('temperature').value;
  // Theme preference
  const theme = localStorage.getItem('sparksmith:theme');
  if (theme === 'dark' || (!theme && window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches)) {
    document.documentElement.classList.add('dark');
  }
  // Service worker registration
  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('./sw.js').catch(console.error);
    });
  }
  // Install prompt setup
  setupInstallPrompt();
})();

$('saveKey').addEventListener('click', () => {
  localStorage.setItem('sparksmith:apiKey', $('apiKey').value.trim());
  alert('API key saved to localStorage.');
});
$('model').addEventListener('change', () => {
  localStorage.setItem('sparksmith:model', $('model').value);
});

// Theme toggle
const themeBtn = $('themeToggle');
if (themeBtn) {
  themeBtn.addEventListener('click', () => {
    const root = document.documentElement;
    const next = root.classList.toggle('dark') ? 'dark' : 'light';
    localStorage.setItem('sparksmith:theme', next);
  });
}

// Random words pool
const RAND_NOUNS = [
  'neon', 'asphalt', 'riverbed', 'bottlecap', 'bus stop', 'rust', 'hoarfrost', 'halflight', 'jukebox', 'freight line', 'magnolia', 'diesel', 'gumbo', 'exit ramp', 'switchblade rain', 'gravel gospel', 'cicadas', 'offramp motel'
];
const RAND_TEXTURES = ['smoky', 'honey-sour', 'salt-bitten', 'tar-sweet', 'ragged', 'starlit', 'blue-shifted', 'paper-thin', 'iron-warm'];

async function gatherSeeds() {
  const includeWeather = $('useWeather').checked;
  const includeNews = $('useNews').checked;
  const includeClock = $('useClock').checked;
  const includeRandom = $('useRandom').checked;

  const seeds = {
    clock: includeClock ? new Date().toString() : null,
    styleTags: $('styleTags').value || null,
    manual: $('manualSeeds').value || null,
    random: includeRandom ? pickRandom() : null,
    weather: null,
    headlines: null,
  };

  if (includeWeather) {
    try {
      const coords = await getCoords();
      const url = `https://api.open-meteo.com/v1/forecast?latitude=${coords.lat}&longitude=${coords.lon}&current=temperature_2m,relative_humidity_2m,apparent_temperature,is_day,precipitation,weather_code,wind_speed_10m&timezone=auto`;
      const res = await fetch(url);
      const data = await res.json();
      seeds.weather = simplifyWeather(data);
    } catch (e) {
      seeds.weather = { error: 'Weather unavailable (' + e.message + ')' };
    }
  }

  if (includeNews) {
    try {
      const res = await fetch('https://hn.algolia.com/api/v1/search?tags=front_page');
      const data = await res.json();
      seeds.headlines = (data.hits || []).slice(0, 5).map(h => ({ title: h.title, url: h.url || h.story_url || '', points: h.points }));
    } catch (e) {
      seeds.headlines = [{ error: 'Headlines unavailable (' + e.message + ')' }];
    }
  }

  state.seeds = seeds;
  $('seedPreview').textContent = JSON.stringify(seeds, null, 2);
  return seeds;
}

function pickRandom() {
  const n1 = sample(RAND_NOUNS), n2 = sample(RAND_NOUNS.filter(x => x!==n1));
  const t1 = sample(RAND_TEXTURES), t2 = sample(RAND_TEXTURES.filter(x => x!==t1));
  return { nouns: [n1, n2], textures: [t1, t2] };
}
const sample = (arr) => arr[Math.floor(Math.random()*arr.length)];

function getCoords() {
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('Geolocation not supported'));
    const t = setTimeout(() => reject(new Error('Geolocation timeout')), 8000);
    navigator.geolocation.getCurrentPosition(
      pos => { clearTimeout(t); resolve({ lat: pos.coords.latitude.toFixed(4), lon: pos.coords.longitude.toFixed(4) }); },
      err => { clearTimeout(t); reject(new Error(err.message || 'Denied')); },
      { enableHighAccuracy: false, timeout: 7000, maximumAge: 60000 }
    );
  });
}

function simplifyWeather(data) {
  try {
    const c = data.current || {};
    return {
      timezone: data.timezone,
      temperature_c: c.temperature_2m,
      apparent_c: c.apparent_temperature,
      humidity: c.relative_humidity_2m,
      wind_speed: c.wind_speed_10m,
      precipitation_mm: c.precipitation,
      is_day: c.is_day === 1,
      code: c.weather_code,
    };
  } catch(_) { return { error: 'Bad weather payload' }; }
}

$('gatherBtn').addEventListener('click', gatherSeeds);

$('offlineBtn').addEventListener('click', async () => {
  if (!state.seeds.clock) await gatherSeeds();
  const prompt = buildWriterPrompt(state.seeds, $('promptMode').value);
  state.lastResult = prompt.text;
  state.lastJSON = prompt.json || null;
  renderResult(prompt);
});

$('generateBtn').addEventListener('click', async () => {
  const apiKey = localStorage.getItem('sparksmith:apiKey') || $('apiKey').value.trim();
  if (!apiKey) return alert('Add your OpenRouter API key first.');
  if (!state.seeds.clock) await gatherSeeds();
  const sys = makeSystemPrompt($('promptMode').value);
  const user = makeUserPrompt(state.seeds, $('promptMode').value);
  try {
    toggleBusy(true);
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        // Helpful for browser calls to OpenRouter
        'HTTP-Referer': location.origin,
        'X-Title': 'SparkSmith',
      },
      body: JSON.stringify({
        model: MODEL_MAP[$('model').value] || $('model').value,
        temperature: parseFloat($('temperature').value),
        messages: [
          { role: 'system', content: sys },
          { role: 'user', content: user }
        ]
      })
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    const text = data.choices?.[0]?.message?.content?.trim() || '';
    state.lastResult = text;
    // Try to sniff JSON if present
    const jsonMatch = text.match(/\{[\s\S]*\}$/);
    state.lastJSON = null;
    if (jsonMatch) {
      try { state.lastJSON = JSON.parse(jsonMatch[0]); } catch(_) {}
    }
    $('result').textContent = text;
  } catch (e) {
    $('result').textContent = 'Error: ' + e.message + '\nTip: Verify your API key & model, and check console.';
    console.error(e);
  } finally {
    toggleBusy(false);
  }
});

function toggleBusy(b) {
  $('generateBtn').disabled = b; $('offlineBtn').disabled = b; $('gatherBtn').disabled = b;
  $('generateBtn').textContent = b ? 'Generating…' : 'Generate with OpenRouter';
}

function renderResult({ text, json }) {
  state.lastResult = text || '';
  state.lastJSON = json || tryParseJSON(text) || null;
  $('result').textContent = state.lastResult;
}

function makeSystemPrompt(mode) {
  const common = `You are SparkSmith, a seasoned songwriter-producer. Create *actionable* prompts that a human can use to write lyrics. Avoid purple prose in instructions. Use concrete imagery, clear constraints, and music-relevant specs (tempo, time signature, rhyme targets).`;
  if (mode === 'lyric-brief') {
    return common + `\nOutput STRICT JSON (no extra commentary) matching this schema:\n{\n  "title": string,\n  "logline": string,\n  "perspective": "1st"|"2nd"|"3rd"|"omniscient",\n  "setting": string,\n  "imagery": string[],\n  "theme": string[],\n  "structure": {"sections": ["verse","chorus","bridge","pre-chorus","break"], "rhyme_scheme": string},\n  "music_specs": {"tempo_bpm": number, "time_signature": string, "feel": string, "key_or_mode": string},\n  "lyric_constraints": string[],\n  "seed_integration": string,\n  "example_opening": string\n}`;
  }
  if (mode === 'title-pack') {
    return common + `\nReturn a concise text block:\n1) A numbered list of 10 killer song titles.\n2) Then 3 mini-briefs (5-7 lines each) in bullet points. No JSON.`;
  }
  // direct-writer
  return common + `\nReturn a single, dense prompt paragraph addressed to a lyricist. No JSON.`;
}

function makeUserPrompt(seeds, mode) {
  const lines = [];
  lines.push(`# Inputs`);
  if (seeds.clock) lines.push(`TimeNow: ${seeds.clock}`);
  if (seeds.styleTags) lines.push(`StyleTags: ${seeds.styleTags}`);
  if (seeds.manual) lines.push(`ManualSeeds: ${seeds.manual}`);
  if (seeds.random) lines.push(`Random: nouns=${seeds.random.nouns.join(', ')} • textures=${seeds.random.textures.join(', ')}`);
  if (seeds.weather) lines.push(`Weather: ${JSON.stringify(seeds.weather)}`);
  if (seeds.headlines) lines.push(`Headlines: ${(seeds.headlines||[]).map(h => h.title || h.error).join(' | ')}`);

  lines.push('\n# Task');
  if (mode === 'lyric-brief') {
    lines.push('Using these seeds, produce a JSON lyric brief per schema. Keep imagery concrete; tie at least 2 items directly to the seeds. Avoid cliches.');
  } else if (mode === 'title-pack') {
    lines.push('Craft 10 titles and 3 mini-briefs reflecting the seeds. Mix grit and heart.');
  } else {
    lines.push('Write a direct writer-prompt (one paragraph, 120–180 words) that tells a lyricist what to write. Include mood, perspective, and 2-3 scene images.');
  }
  return lines.join('\n');
}

function buildWriterPrompt(seeds, mode) {
  const seedText = makeUserPrompt(seeds, mode);
  if (mode === 'lyric-brief') {
    const textures = (seeds.random?.textures || []).slice(0,2);
    const nouns = (seeds.random?.nouns || []).slice(0,2);
    const weatherBit = seeds.weather && !seeds.weather.error
      ? `${Math.round(seeds.weather.temperature_c)}°C, ${seeds.weather.is_day ? 'day' : 'night'}, wind ${Math.round(seeds.weather.wind_speed)} km/h`
      : null;
    const exampleObj = nouns.length ? nouns[0] : 'neon sign';
    const json = {
      title: (seeds.manual?.split(/[\n,]/)[0] || 'Velvet Blackout at Exit 12').trim(),
      logline: 'Post-midnight lovers outrun a storm and their past under flickering road signs.',
      perspective: '1st',
      setting: 'Rain-slick highway, small-town motel, humming soda machine',
      imagery: ['wet asphalt glow', 'neon motel buzz', 'windshield wipers in 12/8', ...nouns.map(n => String(n))].slice(0,5),
      theme: ['forgiveness', 'escape vs. arrival'],
      structure: { sections: ['verse','pre-chorus','chorus','verse','bridge','chorus'], rhyme_scheme: 'ABAB / AABB (chorus tag repeat)' },
      music_specs: { tempo_bpm: 86, time_signature: '12/8', feel: (seeds.styleTags || 'swung, late-night groove'), key_or_mode: 'E minor (Dorian hints)' },
      lyric_constraints: ['No mention of phones/social media', 'Use one weather detail from seeds', 'One specific roadside object', ...textures.map(t => `Use the adjective “${t}” once`)].slice(0,5),
      seed_integration: 'Integrate 1–2 manual seeds, 1 random texture adjective, and 1 observed detail from weather/headlines.',
      example_opening: `${exampleObj ? exampleObj[0].toUpperCase() + exampleObj.slice(1) : 'Neon'} hums; wipers count time—taste the ${textures[0] || 'ragged'} rain and call it night…`,
      seeds_summary: seedText,
      weather_hint: weatherBit || undefined,
    };
    return { text: JSON.stringify(json, null, 2), json };
  }
  if (mode === 'title-pack') {
    const noun = seeds.random?.nouns?.[0] || 'Neon';
    const noun2 = seeds.random?.nouns?.[1] || 'Asphalt';
    const tex = seeds.random?.textures?.[0] || 'Ragged';
    const titles = [
      `${noun} Motel Choir`,
      `Freight Line Halo`,
      `Velvet Blackout, Exit 12`,
      `Switchblade Rain`,
      `Gravel Gospel`,
      `${tex}-Lip Valentine`,
      `${noun2} Lullaby`,
      `Starlit Shoulder`,
      `Honey-Sour Prayer`,
      `Jukebox of the Riverbed`,
    ];
    const text = `Titles\n${titles.map((t,i)=>`${i+1}) ${t}`).join('\n')}\n\nMini-briefs\n• Velvet Blackout, Exit 12 — First-person, lovers outrun a storm; neon and wet asphalt; chorus returns to the exit sign as fate. 86 bpm, 12/8.\n• Gravel Gospel — Narrator confesses in an empty carwash bay; cicadas drone; redemption rides in on a beat-up pickup. 78 bpm, 4/4 straight.\n• Switchblade Rain — Urban midnight; flicker subway light; knife-glint drizzle doubles as memory shards. 96 bpm, halftime swing.`;
    return { text };
  }
  // direct writer prompt
  const nouns = (seeds.random?.nouns || ['neon', 'asphalt']).slice(0,2);
  const textures = (seeds.random?.textures || ['ragged','starlit']).slice(0,2);
  const headline = (seeds.headlines && seeds.headlines[0] && (seeds.headlines[0].title || 'a front-page headline')) || 'a front-page headline';
  const weather = seeds.weather && !seeds.weather.error ? `${Math.round(seeds.weather.temperature_c)}°C and ${seeds.weather.is_day ? 'daylight' : 'after dark'}` : 'storm-suggesting clouds';
  const text = `Write a first-person lyric set after midnight on a rain-slick highway pulling into a flickering ${nouns[0]} motel. Keep imagery concrete: ${nouns[1]} glow, a humming soda machine, wipers counting time in 12/8. Mood is gritty-hopeful; voice is tender but unsentimental. Work in two seed details (weather: ${weather}; headline echo: “${headline}”) and two adjectives from: ${textures.join(', ')}. Structure: verse / pre / chorus / verse / bridge / chorus (tag). Avoid phones/social media. Tempo ~86 bpm; hints of E Dorian. End each chorus with the tag: "Velvet blackout, child."`;
  return { text };
}

$('copyText').addEventListener('click', async () => {
  const text = $('result').textContent.trim();
  if (!text) return alert('Nothing to copy.');
  await navigator.clipboard.writeText(text);
  pulseCopyButton('copyText');
});
$('copyJSON').addEventListener('click', async () => {
  const j = state.lastJSON || tryParseJSON($('result').textContent);
  if (!j) return alert('No JSON detected. Use Lyric Brief mode or copy text.');
  await navigator.clipboard.writeText(JSON.stringify(j, null, 2));
  pulseCopyButton('copyJSON');
});

function tryParseJSON(s) { try { return JSON.parse(s); } catch(_) { return null; } }

function pulseCopyButton(id) {
  const el = $(id);
  if (!el) return;
  const prev = el.textContent;
  el.textContent = 'Copied!';
  el.disabled = true;
  setTimeout(() => { el.textContent = prev; el.disabled = false; }, 900);
}

// PWA install banner & prompt
function setupInstallPrompt() {
  const banner = $('installBanner');
  const accept = $('installAccept');
  const dismiss = $('installDismiss');
  const PROMPT_INTERVAL_MS = 0; // set to 24*60*60*1000 for daily, 7*24*60*60*1000 for weekly

  const isStandalone = () => (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) || (window.navigator.standalone === true);

  const maybeShowBanner = () => {
    const sessionDenied = sessionStorage.getItem('sparksmith:installDenied') === '1';
    const last = parseInt(localStorage.getItem('sparksmith:lastInstallPrompt') || '0', 10);
    const due = Date.now() - last >= PROMPT_INTERVAL_MS;
    if (!isStandalone() && !sessionDenied && due && state.deferredPrompt) {
      banner && banner.classList.remove('hidden');
    }
  };

  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    state.deferredPrompt = e;
    maybeShowBanner();
  });

  if (window.matchMedia && window.matchMedia('(display-mode: standalone)').addEventListener) {
    window.matchMedia('(display-mode: standalone)').addEventListener('change', (e) => {
      if (e.matches) banner && banner.classList.add('hidden');
    });
  }

  accept && accept.addEventListener('click', async () => {
    banner && banner.classList.add('hidden');
    localStorage.setItem('sparksmith:lastInstallPrompt', String(Date.now()));
    const dp = state.deferredPrompt;
    if (!dp) return;
    dp.prompt();
    const { outcome } = await dp.userChoice;
    state.deferredPrompt = null;
    if (outcome === 'dismissed') sessionStorage.setItem('sparksmith:installDenied', '1');
  });

  dismiss && dismiss.addEventListener('click', () => {
    banner && banner.classList.add('hidden');
    localStorage.setItem('sparksmith:lastInstallPrompt', String(Date.now()));
    sessionStorage.setItem('sparksmith:installDenied', '1');
  });

  // If the event fired before our listeners, attempt to show shortly after load
  setTimeout(maybeShowBanner, 700);
}
