const express = require('express');
const TitulkyClient = require('./lib/titulkyClient');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// ── Client cache (keyed by username) ──────────────────────────────
const clientCache = new Map();
const subtitleCache = new Map(); // cache downloaded subs for 1h
const SUBTITLE_CACHE_TTL = 60 * 60 * 1000;

// ── Config helpers ────────────────────────────────────────────────

function encodeConfig(obj) {
  return Buffer.from(JSON.stringify(obj)).toString('base64url');
}

function decodeConfig(str) {
  try {
    return JSON.parse(Buffer.from(str, 'base64url').toString('utf-8'));
  } catch {
    try {
      return JSON.parse(Buffer.from(str, 'base64').toString('utf-8'));
    } catch {
      return null;
    }
  }
}

async function getClient(config) {
  const key = config.username;
  if (clientCache.has(key)) {
    const client = clientCache.get(key);
    if (client.loggedIn) return client;
  }
  const client = new TitulkyClient(config.username, config.password);
  const ok = await client.login();
  if (ok) {
    clientCache.set(key, client);
    return client;
  }
  return null;
}

// ── Cinemeta – resolve IMDB ID → title ────────────────────────────

async function getMeta(type, id) {
  const imdbId = id.split(':')[0];
  try {
    const res = await axios.get(
      `https://v3-cinemeta.strem.io/meta/${type}/${imdbId}.json`,
      { timeout: 8000 }
    );
    return res.data?.meta || null;
  } catch {
    return null;
  }
}

// ── Trust proxy (Render runs behind a reverse proxy) ──────────────
app.set('trust proxy', 1);

// ── Request logging ───────────────────────────────────────────────
app.use((req, res, next) => {
  console.log(`[REQ] ${req.method} ${req.path} (proto: ${req.protocol}, x-forwarded-proto: ${req.get('x-forwarded-proto')})`);
  next();
});

// ── CORS headers for Stremio ──────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// ── Landing / Configure page ──────────────────────────────────────

app.get('/', (req, res) => res.redirect('/configure'));

app.get('/configure', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  res.type('html').send(getConfigurePage(host));
});

// Stremio requests /:config/configure after reading manifest
app.get('/:config/configure', (req, res) => {
  const host = `${req.protocol}://${req.get('host')}`;
  res.type('html').send(getConfigurePage(host));
});

// ── Manifest ──────────────────────────────────────────────────────

function getManifest(config, host) {
  const configStr = encodeConfig(config);
  return {
    id: 'community.titulky.com',
    version: '1.0.0',
    name: 'Titulky.com',
    description: 'České a slovenské titulky z Titulky.com',
    catalogs: [],
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    logo: 'https://www.titulky.com/favicon.ico',
    behaviorHints: {
      configurable: true,
      configurationRequired: true,
    },
  };
}

app.get('/:config/manifest.json', (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ error: 'Invalid config' });
  const host = `${req.protocol}://${req.get('host')}`;
  res.json(getManifest(config, host));
});

// ── Subtitle search ───────────────────────────────────────────────

app.get('/:config/subtitles/:type/:id/:extra?.json', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).json({ subtitles: [] });

  const { type, id } = req.params;
  const host = `${req.protocol}://${req.get('host')}`;

  try {
    const client = await getClient(config);
    if (!client) return res.json({ subtitles: [] });

    // Build search query
    const meta = await getMeta(type, id);
    if (!meta) return res.json({ subtitles: [] });

    let searchTitle;
    if (type === 'series') {
      const parts = id.split(':');
      const season = parts[1] ? parseInt(parts[1], 10) : 1;
      const episode = parts[2] ? parseInt(parts[2], 10) : 1;
      const showName = meta.name || meta.title || '';
      searchTitle = `${showName} S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
    } else {
      searchTitle = meta.name || meta.title || '';
    }

    if (!searchTitle) return res.json({ subtitles: [] });

    console.log(`[Addon] Search: "${searchTitle}" (${type} ${id})`);
    const results = await client.search(searchTitle);

    const configStr = req.params.config;
    const subtitles = results.map((sub) => {
      const label = buildLabel(sub);
      return {
        id: `titulky-${sub.id}`,
        url: `${host}/sub/${configStr}/${sub.id}/${encodeURIComponent(sub.linkFile)}`,
        lang: sub.lang,
        SubEncoding: 'UTF-8',
        SubFormat: 'srt',
      };
    });

    res.json({ subtitles });
  } catch (e) {
    console.error('[Addon] Search error:', e.message);
    res.json({ subtitles: [] });
  }
});

function buildLabel(sub) {
  let label = sub.version || sub.title || '';
  if (sub.author) label += ` by ${sub.author}`;
  return label;
}

// ── Subtitle download proxy ───────────────────────────────────────

app.get('/sub/:config/:subId/:linkFile', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).send('Invalid config');

  const { subId, linkFile } = req.params;
  const cacheKey = `${subId}-${linkFile}`;

  // Check cache
  if (subtitleCache.has(cacheKey)) {
    const cached = subtitleCache.get(cacheKey);
    if (Date.now() - cached.time < SUBTITLE_CACHE_TTL) {
      console.log(`[Addon] Serving cached subtitle ${subId}`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${cached.filename}"`);
      return res.send(cached.content);
    }
    subtitleCache.delete(cacheKey);
  }

  try {
    const client = await getClient(config);
    if (!client) return res.status(500).send('Login failed');

    const decoded = decodeURIComponent(linkFile);
    const files = await client.downloadSubtitle(subId, decoded);

    if (!files || files.length === 0) {
      return res.status(404).send('Subtitle not found or captcha required');
    }

    const file = files[0];
    subtitleCache.set(cacheKey, {
      content: file.content,
      filename: file.filename,
      time: Date.now(),
    });

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(file.content);
  } catch (e) {
    console.error('[Addon] Download error:', e.message);
    res.status(500).send('Download failed');
  }
});

// ── Login test endpoint ───────────────────────────────────────────

app.post('/verify', express.json(), async (req, res) => {
  console.log('[Verify] Request body:', JSON.stringify(req.body));
  const { username, password } = req.body || {};
  if (!username || !password) {
    console.log('[Verify] Missing credentials');
    return res.json({ success: false, error: 'missing_credentials' });
  }

  try {
    const client = new TitulkyClient(username, password);
    const ok = await client.login();
    console.log('[Verify] Login result:', ok);
    if (ok) clientCache.set(username, client);
    res.json({ success: ok });
  } catch (e) {
    console.error('[Verify] Error:', e.message);
    res.json({ success: false, error: e.message });
  }
});

// ── Configure page HTML ───────────────────────────────────────────

function getConfigurePage(host) {
  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Titulky.com – Stremio Addon</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0c0e14;
    --surface: #151821;
    --surface-2: #1c2030;
    --border: #2a2e40;
    --accent: #4f8cff;
    --accent-hover: #6ba0ff;
    --accent-glow: rgba(79, 140, 255, 0.15);
    --text: #e4e7f0;
    --text-dim: #8891a8;
    --danger: #ff5c5c;
    --success: #4fdb8a;
    --radius: 12px;
  }

  * { margin: 0; padding: 0; box-sizing: border-box; }

  body {
    font-family: 'DM Sans', sans-serif;
    background: var(--bg);
    color: var(--text);
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    position: relative;
    overflow: hidden;
  }

  body::before {
    content: '';
    position: fixed;
    top: -40%; left: -20%;
    width: 80vw; height: 80vw;
    background: radial-gradient(circle, rgba(79,140,255,0.06) 0%, transparent 65%);
    pointer-events: none;
  }

  body::after {
    content: '';
    position: fixed;
    bottom: -30%; right: -10%;
    width: 60vw; height: 60vw;
    background: radial-gradient(circle, rgba(79,140,255,0.04) 0%, transparent 60%);
    pointer-events: none;
  }

  .card {
    background: var(--surface);
    border: 1px solid var(--border);
    border-radius: 20px;
    padding: 48px 40px;
    max-width: 440px;
    width: 100%;
    position: relative;
    z-index: 1;
    box-shadow: 0 24px 80px rgba(0,0,0,0.4);
  }

  .logo-row {
    display: flex;
    align-items: center;
    gap: 14px;
    margin-bottom: 8px;
  }

  .logo-icon {
    width: 44px; height: 44px;
    background: var(--accent-glow);
    border-radius: 12px;
    display: flex; align-items: center; justify-content: center;
    font-size: 22px;
    border: 1px solid rgba(79,140,255,0.2);
  }

  h1 {
    font-size: 22px;
    font-weight: 700;
    letter-spacing: -0.3px;
  }

  .subtitle {
    color: var(--text-dim);
    font-size: 14px;
    margin-bottom: 32px;
    line-height: 1.5;
  }

  label {
    display: block;
    font-size: 13px;
    font-weight: 600;
    color: var(--text-dim);
    margin-bottom: 6px;
    text-transform: uppercase;
    letter-spacing: 0.6px;
  }

  input[type="text"], input[type="password"] {
    width: 100%;
    padding: 12px 16px;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    color: var(--text);
    font-family: 'JetBrains Mono', monospace;
    font-size: 14px;
    outline: none;
    transition: border-color 0.2s, box-shadow 0.2s;
    margin-bottom: 20px;
  }

  input:focus {
    border-color: var(--accent);
    box-shadow: 0 0 0 3px var(--accent-glow);
  }

  .btn {
    width: 100%;
    padding: 14px;
    border: none;
    border-radius: var(--radius);
    font-family: 'DM Sans', sans-serif;
    font-size: 15px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 8px;
  }

  .btn-primary {
    background: var(--accent);
    color: #fff;
  }
  .btn-primary:hover { background: var(--accent-hover); transform: translateY(-1px); }
  .btn-primary:active { transform: translateY(0); }
  .btn-primary:disabled { opacity: 0.5; cursor: not-allowed; transform: none; }

  .btn-install {
    background: var(--success);
    color: #0c0e14;
    margin-top: 12px;
    text-decoration: none;
  }
  .btn-install:hover { filter: brightness(1.1); transform: translateY(-1px); }

  .btn-copy {
    background: var(--surface-2);
    border: 1px solid var(--border);
    color: var(--text);
    margin-top: 8px;
  }
  .btn-copy:hover { border-color: var(--accent); }

  .status {
    text-align: center;
    font-size: 14px;
    margin-top: 16px;
    min-height: 20px;
  }
  .status.error { color: var(--danger); }
  .status.ok { color: var(--success); }

  .result { display: none; margin-top: 24px; }
  .result.show { display: block; }

  .divider {
    border: none;
    border-top: 1px solid var(--border);
    margin: 24px 0;
  }

  .url-box {
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 12px 16px;
    font-family: 'JetBrains Mono', monospace;
    font-size: 12px;
    color: var(--text-dim);
    word-break: break-all;
    line-height: 1.6;
  }

  .spinner {
    width: 18px; height: 18px;
    border: 2px solid rgba(255,255,255,0.3);
    border-top-color: #fff;
    border-radius: 50%;
    animation: spin 0.6s linear infinite;
    display: none;
  }
  @keyframes spin { to { transform: rotate(360deg); } }

  @media (max-width: 500px) {
    .card { padding: 32px 24px; }
  }
</style>
</head>
<body>
<div class="card">
  <div class="logo-row">
    <div class="logo-icon">🎬</div>
    <h1>Titulky.com</h1>
  </div>
  <p class="subtitle">Přihlaste se svým účtem z Titulky.com pro vyhledávání českých a slovenských titulků přímo ve Stremiu.</p>

  <label for="username">Uživatelské jméno</label>
  <input type="text" id="username" placeholder="Váš login" autocomplete="username">

  <label for="password">Heslo</label>
  <input type="password" id="password" placeholder="Vaše heslo" autocomplete="current-password">

  <button class="btn btn-primary" id="verifyBtn" onclick="verify()">
    <span class="spinner" id="spinner"></span>
    <span id="btnText">Ověřit a nainstalovat</span>
  </button>

  <div class="status" id="status"></div>

  <div class="result" id="result">
    <hr class="divider">
    <a class="btn btn-install" id="installLink" href="#">
      📦 Nainstalovat do Stremio (desktop app)
    </a>
    <a class="btn btn-install" id="webInstallLink" href="#" target="_blank" style="background: var(--accent); margin-top: 8px;">
      🌐 Nainstalovat přes Stremio Web
    </a>
    <button class="btn btn-copy" onclick="copyUrl()">
      📋 Kopírovat URL addonu
    </button>
    <div style="margin-top: 16px;">
      <label>URL addonu</label>
      <div class="url-box" id="addonUrl"></div>
    </div>
  </div>
</div>

<script>
const HOST = '${host}';

async function verify() {
  const username = document.getElementById('username').value.trim();
  const password = document.getElementById('password').value.trim();
  const status = document.getElementById('status');
  const result = document.getElementById('result');
  const btn = document.getElementById('verifyBtn');
  const spinner = document.getElementById('spinner');
  const btnText = document.getElementById('btnText');

  if (!username || !password) {
    status.className = 'status error';
    status.textContent = 'Vyplňte oba údaje';
    return;
  }

  btn.disabled = true;
  spinner.style.display = 'block';
  btnText.textContent = 'Ověřuji…';
  status.className = 'status';
  status.textContent = '';
  result.classList.remove('show');

  try {
    const res = await fetch('/verify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    const data = await res.json();

    if (data.success) {
      status.className = 'status ok';
      status.textContent = '✓ Přihlášení úspěšné';

      const config = btoa(JSON.stringify({ username, password }))
        .replace(/[+]/g, '-').replace(/[/]/g, '_').replace(/=+$/, '');
      const manifestUrl = window.location.origin + '/' + config + '/manifest.json';
      const stremioUrl = 'stremio://' + manifestUrl.replace(/^https?:[/][/]/, '');
      const webInstallUrl = 'https://web.stremio.com/#/addons?addon=' + encodeURIComponent(manifestUrl);

      document.getElementById('installLink').href = stremioUrl;
      document.getElementById('webInstallLink').href = webInstallUrl;
      document.getElementById('addonUrl').textContent = manifestUrl;
      result.classList.add('show');
    } else {
      status.className = 'status error';
      status.textContent = '✗ Nesprávné přihlašovací údaje';
    }
  } catch (e) {
    status.className = 'status error';
    status.textContent = 'Chyba připojení: ' + e.message;
  }

  btn.disabled = false;
  spinner.style.display = 'none';
  btnText.textContent = 'Ověřit a nainstalovat';
}

function copyUrl() {
  const url = document.getElementById('addonUrl').textContent;
  navigator.clipboard.writeText(url).then(() => {
    const btn = document.querySelector('.btn-copy');
    btn.textContent = '✓ Zkopírováno';
    setTimeout(() => btn.textContent = '📋 Kopírovat URL addonu', 2000);
  });
}

document.getElementById('password').addEventListener('keydown', e => {
  if (e.key === 'Enter') verify();
});
</script>
</body>
</html>`;
}

// ── Start ─────────────────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`Titulky.com Stremio addon running on port ${PORT}`);
  console.log(`Configure at: http://localhost:${PORT}/configure`);
});
