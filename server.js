const express = require('express');
const TitulkyClient = require('./lib/titulkyClient');
const axios = require('axios');
const iconv = require('iconv-lite');
const { S3Client, GetObjectCommand, PutObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');

const app = express();
const PORT = process.env.PORT || 3000;

// ── R2 Cloud Cache ───────────────────────────────────────────────
const r2Enabled = !!(process.env.R2_ENDPOINT && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && process.env.R2_BUCKET);

let s3 = null;
const r2CachedIds = new Set(); // in-memory index of cached subtitle IDs

if (r2Enabled) {
  s3 = new S3Client({
    region: 'auto',
    endpoint: process.env.R2_ENDPOINT,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
  console.log(`[R2] Cache enabled (bucket: ${process.env.R2_BUCKET})`);

  // Load cache index on startup (async, non-blocking)
  (async () => {
    try {
      let continuationToken = undefined;
      let total = 0;
      do {
        const res = await s3.send(new ListObjectsV2Command({
          Bucket: process.env.R2_BUCKET,
          Prefix: 'subs/',
          ContinuationToken: continuationToken,
        }));
        for (const obj of (res.Contents || [])) {
          const id = obj.Key.replace('subs/', '').replace('.srt', '');
          if (id) r2CachedIds.add(id);
          total++;
        }
        continuationToken = res.IsTruncated ? res.NextContinuationToken : undefined;
      } while (continuationToken);
      console.log(`[R2] Cache index loaded: ${total} subtitle(s)`);
    } catch (e) {
      console.log(`[R2] Cache index load error: ${e.message}`);
    }
  })();
} else {
  console.log('[R2] Cache disabled (missing env variables)');
}

async function r2Get(subId) {
  if (!s3) return null;
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `subs/${subId}.srt`,
    }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    const content = Buffer.concat(chunks).toString('utf-8');
    const filename = res.Metadata?.filename || `${subId}.srt`;
    console.log(`[R2] Cache HIT: ${subId}`);
    return { content, filename };
  } catch (e) {
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return null; // not cached
    }
    console.log(`[R2] Get error: ${e.message}`);
    return null;
  }
}

async function r2Put(subId, content, filename) {
  if (!s3) return;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `subs/${subId}.srt`,
      Body: content,
      ContentType: 'text/plain; charset=utf-8',
      Metadata: { filename },
    }));
    r2CachedIds.add(String(subId));
    console.log(`[R2] Cached: ${subId}`);
  } catch (e) {
    console.log(`[R2] Put error: ${e.message}`);
  }
}

// ── R2 History helpers ───────────────────────────────────────────

async function r2GetHistory(username) {
  if (!s3) return [];
  try {
    const res = await s3.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `history/${username}.json`,
    }));
    const chunks = [];
    for await (const chunk of res.Body) chunks.push(chunk);
    return JSON.parse(Buffer.concat(chunks).toString('utf-8'));
  } catch {
    return [];
  }
}

async function r2SaveHistory(username, history) {
  if (!s3) return;
  try {
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: `history/${username}.json`,
      Body: JSON.stringify(history),
      ContentType: 'application/json',
    }));
  } catch (e) {
    console.log(`[R2] History save error: ${e.message}`);
  }
}

async function r2AddToHistory(username, item) {
  if (!s3) return;
  let history = await r2GetHistory(username);
  // Remove duplicate (by full id including episode)
  history = history.filter(h => h.id !== item.id);
  // Add to front
  history.unshift(item);
  // Keep only 10
  history = history.slice(0, 10);
  await r2SaveHistory(username, history);
}

// ── R2 Custom subtitle helpers ───────────────────────────────────

async function r2GetCustomSubs(imdbId) {
  if (!s3) return [];
  try {
    const res = await s3.send(new ListObjectsV2Command({
      Bucket: process.env.R2_BUCKET,
      Prefix: `custom/${imdbId}/`,
    }));
    if (!res.Contents || res.Contents.length === 0) return [];

    const subs = [];
    for (const obj of res.Contents) {
      if (!/\.(srt|ssa|ass|sub|vtt)$/i.test(obj.Key)) continue;
      try {
        const getRes = await s3.send(new GetObjectCommand({
          Bucket: process.env.R2_BUCKET,
          Key: obj.Key,
        }));
        const chunks = [];
        for await (const chunk of getRes.Body) chunks.push(chunk);
        const filename = obj.Key.split('/').pop();
        const label = getRes.Metadata?.label || filename.replace(/\.(srt|ssa|ass|sub|vtt)$/i, '');
        const lang = getRes.Metadata?.lang || 'cze';
        const uploader = getRes.Metadata?.uploader || 'unknown';
        subs.push({ key: obj.Key, filename, label, lang, uploader });
      } catch { /* skip */ }
    }
    console.log(`[R2] Found ${subs.length} custom sub(s) for ${imdbId}`);
    return subs;
  } catch {
    return [];
  }
}

async function r2PutCustomSub(imdbId, filename, content, label, lang, uploader) {
  if (!s3) return false;
  try {
    const key = `custom/${imdbId}/${filename}`;
    const ext = filename.split('.').pop().toLowerCase();
    const mimeTypes = { srt: 'text/plain', ssa: 'text/plain', ass: 'text/plain', sub: 'text/plain', vtt: 'text/vtt' };
    await s3.send(new PutObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
      Body: content,
      ContentType: (mimeTypes[ext] || 'text/plain') + '; charset=utf-8',
      Metadata: { label, lang, uploader: uploader || 'unknown' },
    }));
    console.log(`[R2] Custom sub saved: ${key} (by ${uploader})`);
    return true;
  } catch (e) {
    console.log(`[R2] Custom sub error: ${e.message}`);
    return false;
  }
}

// ── Client cache (keyed by username) ──────────────────────────────
const clientCache = new Map();
const subtitleCache = new Map(); // cache downloaded subs for 1h
const SUBTITLE_CACHE_TTL = 60 * 60 * 1000;

// ── Release tag matching ──────────────────────────────────────────

const RELEASE_TAGS = [
  'bluray', 'bdrip', 'brrip', 'bd-rip', 'blu-ray', 'bdremux', 'remux',
  'web-dl', 'webdl', 'webrip', 'web-rip', 'web',
  'hdtv', 'hdrip', 'dvdrip', 'dvd', 'dvdscr',
  'hdcam', 'cam', 'ts', 'telesync', 'tc', 'dcp',
  '2160p', '1080p', '720p', '480p',
  'x264', 'x265', 'h264', 'h265', 'hevc', 'avc',
  'hdr', 'hdr10', 'dolby-vision', 'sdr',
  'atmos', 'dts', 'dts-hd', 'truehd', 'aac', 'ac3', 'dd5', 'flac',
  'imax', 'repack', 'proper', 'dual',
];

function extractReleaseTags(filename) {
  if (!filename) return [];
  const lower = filename.toLowerCase().replace(/[._]/g, ' ').replace(/[-]/g, ' ');
  const found = [];
  for (const tag of RELEASE_TAGS) {
    const tagLower = tag.replace(/[-]/g, ' ');
    if (lower.includes(tagLower)) found.push(tag);
  }
  return [...new Set(found)];
}

function scoreSubtitle(subVersion, playingTags) {
  if (!subVersion || playingTags.length === 0) return 0;
  const subTags = extractReleaseTags(subVersion);
  let score = 0;
  // Resolution match (most important)
  const resolutions = ['2160p', '1080p', '720p', '480p'];
  for (const res of resolutions) {
    if (playingTags.includes(res) && subTags.includes(res)) score += 20;
  }
  // Source type match
  const sources = ['bluray', 'bdremux', 'remux', 'web-dl', 'webdl', 'webrip', 'hdtv', 'dvdrip', 'dcp'];
  for (const src of sources) {
    if (playingTags.includes(src) && subTags.includes(src)) score += 15;
  }
  // Codec match
  const codecs = ['x264', 'x265', 'h264', 'h265', 'hevc', 'avc'];
  for (const codec of codecs) {
    if (playingTags.includes(codec) && subTags.includes(codec)) score += 5;
  }
  return score;
}

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

    // Build search queries - try multiple title variants
    const meta = await getMeta(type, id);
    if (!meta) return res.json({ subtitles: [] });

    const searchTitles = [];
    const name = meta.name || meta.title || '';

    if (type === 'series') {
      const parts = id.split(':');
      const season = parts[1] ? parseInt(parts[1], 10) : 1;
      const episode = parts[2] ? parseInt(parts[2], 10) : 1;
      const epStr = `S${String(season).padStart(2, '0')}E${String(episode).padStart(2, '0')}`;
      // Try: "Show Name S01E01", then just "Show Name"
      if (name) searchTitles.push(`${name} ${epStr}`);
      if (meta.aliases) {
        for (const alias of meta.aliases) {
          if (alias && alias !== name) searchTitles.push(`${alias} ${epStr}`);
        }
      }
      if (name) searchTitles.push(name);
    } else {
      // Movie: try name, then aliases, then name without special chars
      if (name) searchTitles.push(name);
      if (meta.aliases) {
        for (const alias of meta.aliases) {
          if (alias && alias !== name) searchTitles.push(alias);
        }
      }
      // Try without trailing dots/punctuation
      const cleaned = name.replace(/[.!?]+$/, '').trim();
      if (cleaned && cleaned !== name) searchTitles.push(cleaned);
      // Try just the first word if title is very short
      if (name.split(' ').length <= 3 && name.length > 2) {
        searchTitles.push(name);
      }
    }

    // Deduplicate
    const uniqueTitles = [...new Set(searchTitles)].filter(t => t && t.length > 1);

    console.log(`[Addon] Search titles: ${JSON.stringify(uniqueTitles)} (${type} ${id})`);
    const results = await client.search(uniqueTitles);

    // Save to watch history (async, don't wait)
    const imdbId = id.split(':')[0];
    r2AddToHistory(config.username, {
      imdbId,
      type,
      id,
      name,
      poster: meta.poster || null,
      time: Date.now(),
    });

    // Extract playing filename from Stremio extra params
    const extraStr = req.params.extra || '';
    const filenameMatch = extraStr.match(/filename=([^&]+)/);
    const playingFilename = filenameMatch ? decodeURIComponent(filenameMatch[1]) : '';
    const playingTags = extractReleaseTags(playingFilename);

    console.log(`[Addon] Playing: "${playingFilename}" | Tags: ${playingTags.join(', ')}`);

    // Filter results by title match
    const movieName = name.toLowerCase().replace(/[.!?]+$/, '').trim();

    let filtered = results.filter(sub => {
      const subTitle = (sub.title || '').toLowerCase().replace(/[._-]/g, ' ').trim();
      const subLink = (sub.linkFile || '').toLowerCase().replace(/[._-]/g, ' ');
      return isExactTitleMatch(movieName, subTitle) || isExactTitleMatch(movieName, subLink);
    });

    console.log(`[Addon] After filter: ${filtered.length}/${results.length}`);

    // Score subtitles
    const hasReleaseTags = playingTags.length > 0;
    const scoredResults = filtered.map(sub => ({
      sub,
      score: hasReleaseTags
        ? scoreSubtitle(sub.version || sub.title, playingTags)
        : qualityScore(sub.version || sub.title),
    }));
    scoredResults.sort((a, b) => b.score - a.score);

    // Build response — max 10
    const configStr = req.params.config;
    const subtitles = scoredResults.slice(0, 10).map(({ sub, score }) => {
      const label = buildLabel(sub, score, hasReleaseTags);
      const cached = r2CachedIds.has(String(sub.id));
      const icon = cached ? '✅' : '⬇️';
      return {
        id: `titulky-${sub.id}`,
        url: `${host}/sub/${configStr}/${sub.id}/${encodeURIComponent(sub.linkFile)}`,
        lang: `${icon} ${label || (sub.lang === 'cze' ? 'Čeština' : sub.lang === 'slk' ? 'Slovenčina' : sub.lang)}`,
        SubEncoding: 'UTF-8',
        SubFormat: 'srt',
      };
    });

    // Add custom subtitles from R2 (user-uploaded)
    const imdbIdClean = id.split(':')[0];
    const customImdbId = type === 'series' ? id.replace(/:/g, '-') : imdbIdClean;
    const customSubs = await r2GetCustomSubs(customImdbId);
    for (const cs of customSubs) {
      const ext = cs.filename.split('.').pop().toLowerCase();
      // ASS/SSA get converted to VTT on serve, others stay as-is
      const subFormat = (ext === 'ass' || ext === 'ssa' || ext === 'vtt') ? 'vtt' : 'srt';
      subtitles.unshift({
        id: `custom-${cs.key}`,
        url: `${host}/custom-sub/${customImdbId}/${encodeURIComponent(cs.filename)}`,
        lang: `📌 ${cs.label}`,
        SubEncoding: 'UTF-8',
        SubFormat: subFormat,
      });
    }

    res.json({ subtitles });
  } catch (e) {
    console.error('[Addon] Search error:', e.message);
    res.json({ subtitles: [] });
  }
});

function isExactTitleMatch(movieName, subText) {
  if (!movieName || !subText) return false;

  // Normalize both strings
  const movie = movieName.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();
  const sub = subText.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim();

  // Direct match
  if (sub === movie) return true;

  // Sub starts with movie name, followed by year/space/end/release info
  if (sub.startsWith(movie)) {
    const after = sub.slice(movie.length).trim();
    if (!after || /^\d{4}/.test(after) || /^(s\d|season|720|1080|2160|bluray|brrip|web|dvd|hdtv|x26)/i.test(after)) {
      return true;
    }
  }

  return false;
}

function buildLabel(sub, score, hasReleaseTags) {
  let label = sub.version || sub.title || '';
  if (hasReleaseTags && score > 0) label = `⭐ ${label}`;
  return label;
}

// Quality ranking when no release tags from playing file
const QUALITY_ORDER = [
  { tag: '2160p', score: 100 },
  { tag: 'remux', score: 95 },
  { tag: 'bdremux', score: 95 },
  { tag: 'bluray', score: 90 },
  { tag: 'blu-ray', score: 90 },
  { tag: '1080p', score: 80 },
  { tag: 'web-dl', score: 70 },
  { tag: 'webdl', score: 70 },
  { tag: 'webrip', score: 65 },
  { tag: '720p', score: 60 },
  { tag: 'hdtv', score: 50 },
  { tag: 'hdrip', score: 45 },
  { tag: 'brrip', score: 40 },
  { tag: 'bdrip', score: 40 },
  { tag: 'dvdrip', score: 30 },
  { tag: 'dvd', score: 25 },
  { tag: '480p', score: 20 },
  { tag: 'hdcam', score: 10 },
  { tag: 'cam', score: 5 },
  { tag: 'ts', score: 5 },
  { tag: 'telesync', score: 5 },
];

function qualityScore(text) {
  if (!text) return 0;
  const lower = text.toLowerCase().replace(/[._]/g, ' ').replace(/[-]/g, ' ');
  let best = 0;
  for (const q of QUALITY_ORDER) {
    const tagLower = q.tag.replace(/[-]/g, ' ');
    if (lower.includes(tagLower) && q.score > best) best = q.score;
  }
  return best;
}

// ── Encoding detection & conversion ──────────────────────────────

function ensureUtf8(buffer) {
  if (!Buffer.isBuffer(buffer)) buffer = Buffer.from(buffer);

  // Check for UTF-8 BOM
  if (buffer[0] === 0xEF && buffer[1] === 0xBB && buffer[2] === 0xBF) {
    return buffer.toString('utf-8');
  }

  // Check for UTF-16 LE BOM
  if (buffer[0] === 0xFF && buffer[1] === 0xFE) {
    return iconv.decode(buffer, 'utf-16le');
  }

  // Try to decode as UTF-8 and check if it's valid
  const utf8Str = buffer.toString('utf-8');
  if (isValidUtf8(utf8Str)) {
    return utf8Str;
  }

  // Not valid UTF-8 → assume Windows-1250 (Czech/Slovak standard)
  console.log('[Addon] Converting subtitle from CP1250 to UTF-8');
  return iconv.decode(buffer, 'win1250');
}

function isValidUtf8(str) {
  // If decoding as UTF-8 produces replacement characters (�) for common
  // Czech/Slovak byte sequences, it's likely CP1250
  // Check for typical CP1250 patterns that become garbled in UTF-8
  const replacements = (str.match(/\uFFFD/g) || []).length;
  if (replacements > 0) return false;

  // Check for suspicious sequences: CP1250 Czech chars (0xE8=č, 0xF8=ř, 0xE9=é, 0xED=í, etc.)
  // decoded as UTF-8 produce sequences like Ã¨, Ã¸, Ã©, Ã­
  // These are multi-byte UTF-8 sequences that don't make sense for Czech text
  const suspicious = (str.match(/[\xC0-\xC3][\x80-\xBF]/g) || []).length;
  const totalChars = str.length;

  // If more than 5% of chars are suspicious multi-byte sequences, likely CP1250
  if (totalChars > 50 && suspicious / totalChars > 0.02) return false;

  return true;
}

// ── Subtitle download proxy ───────────────────────────────────────

app.get('/sub/:config/:subId/:linkFile', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config) return res.status(400).send('Invalid config');

  const { subId, linkFile } = req.params;
  const cacheKey = `${subId}-${linkFile}`;

  // 1. Check in-memory cache
  if (subtitleCache.has(cacheKey)) {
    const cached = subtitleCache.get(cacheKey);
    if (Date.now() - cached.time < SUBTITLE_CACHE_TTL) {
      console.log(`[Addon] Serving memory-cached subtitle ${subId}`);
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="${cached.filename}"`);
      return res.send(cached.content);
    }
    subtitleCache.delete(cacheKey);
  }

  // 2. Check R2 cloud cache
  const r2Cached = await r2Get(subId);
  if (r2Cached) {
    // Store in memory cache too
    subtitleCache.set(cacheKey, { ...r2Cached, time: Date.now() });
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${r2Cached.filename}"`);
    return res.send(r2Cached.content);
  }

  // 3. Download from titulky.com
  try {
    const client = await getClient(config);
    if (!client) return res.status(500).send('Login failed');

    const decoded = decodeURIComponent(linkFile);
    const files = await client.downloadSubtitle(subId, decoded);

    if (!files || files.length === 0) {
      console.log(`[Addon] Download failed for ${subId} - captcha or limit reached`);
      const limitSrt = `1
00:00:01,000 --> 00:00:30,000
Překročili jste denní limit stažení titulků z Titulky.com. Stáhněte titulky které jsou v cachi (označené ✅) nebo počkejte na reset limitu do dalšího dne.
`;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      return res.send(limitSrt);
    }

    const file = files[0];

    // Convert encoding to UTF-8 if needed
    const utf8Content = ensureUtf8(file.content);

    // Save to memory cache
    subtitleCache.set(cacheKey, {
      content: utf8Content,
      filename: file.filename,
      time: Date.now(),
    });

    // Save to R2 cloud cache (async, don't wait)
    r2Put(subId, utf8Content, file.filename);

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${file.filename}"`);
    res.send(utf8Content);
  } catch (e) {
    console.error('[Addon] Download error:', e.message);
    res.status(500).send('Download failed');
  }
});

// ── ASS/SSA to SRT converter ─────────────────────────────────────

function assToVtt(assContent) {
  const text = typeof assContent === 'string' ? assContent : assContent.toString('utf-8');
  const lines = text.split(/\r?\n/);

  // Parse [V4+ Styles] for color/style info
  const styles = {};
  let inStyles = false;
  let styleFormat = [];

  // Find [Events] section and parse Format line
  let inEvents = false;
  let formatFields = [];
  const dialogues = [];

  for (const line of lines) {
    const trimmed = line.trim();

    // Styles section
    if (/^\[V4\+?\s*Styles?\]/i.test(trimmed)) { inStyles = true; inEvents = false; continue; }
    if (inStyles && /^Format:/i.test(trimmed)) {
      styleFormat = trimmed.replace(/^Format:\s*/i, '').split(',').map(f => f.trim().toLowerCase());
      continue;
    }
    if (inStyles && /^Style:/i.test(trimmed)) {
      const parts = trimmed.replace(/^Style:\s*/i, '').split(',');
      const nameIdx = styleFormat.indexOf('name');
      const colorIdx = styleFormat.indexOf('primarycolour');
      const boldIdx = styleFormat.indexOf('bold');
      const italicIdx = styleFormat.indexOf('italic');
      if (nameIdx >= 0 && parts[nameIdx]) {
        styles[parts[nameIdx].trim()] = {
          color: colorIdx >= 0 ? assColorToVtt(parts[colorIdx]?.trim()) : null,
          bold: boldIdx >= 0 ? parts[boldIdx]?.trim() === '-1' || parts[boldIdx]?.trim() === '1' : false,
          italic: italicIdx >= 0 ? parts[italicIdx]?.trim() === '-1' || parts[italicIdx]?.trim() === '1' : false,
        };
      }
      continue;
    }

    // Events section
    if (/^\[Events\]/i.test(trimmed)) { inEvents = true; inStyles = false; continue; }
    if (/^\[/.test(trimmed) && inEvents) break;

    if (inEvents && /^Format:/i.test(trimmed)) {
      formatFields = trimmed.replace(/^Format:\s*/i, '').split(',').map(f => f.trim().toLowerCase());
      continue;
    }

    if (inEvents && /^Dialogue:/i.test(trimmed)) {
      const parts = trimmed.replace(/^Dialogue:\s*/i, '').split(',');
      if (parts.length >= formatFields.length) {
        const startIdx = formatFields.indexOf('start');
        const endIdx = formatFields.indexOf('end');
        const textIdx = formatFields.indexOf('text');
        const styleIdx = formatFields.indexOf('style');

        if (startIdx >= 0 && endIdx >= 0 && textIdx >= 0) {
          const textParts = parts.slice(textIdx).join(',');
          const styleName = styleIdx >= 0 ? parts[styleIdx]?.trim() : null;
          dialogues.push({
            start: assTimeToVtt(parts[startIdx].trim()),
            end: assTimeToVtt(parts[endIdx].trim()),
            text: assTextToVtt(textParts.trim(), styles[styleName] || null),
          });
        }
      }
    }
  }

  // Build VTT
  let vtt = 'WEBVTT\n\n';
  vtt += dialogues.map((d, i) =>
    `${d.start} --> ${d.end}\n${d.text}\n`
  ).join('\n');
  return vtt;
}

function assTimeToVtt(assTime) {
  // ASS: H:MM:SS.CC → VTT: HH:MM:SS.mmm
  const m = assTime.match(/(\d+):(\d+):(\d+)\.(\d+)/);
  if (!m) return '00:00:00.000';
  const h = m[1].padStart(2, '0');
  const min = m[2].padStart(2, '0');
  const sec = m[3].padStart(2, '0');
  const cs = m[4].padEnd(3, '0').substring(0, 3);
  return `${h}:${min}:${sec}.${cs}`;
}

function assColorToVtt(assColor) {
  if (!assColor) return null;
  // ASS color: &HAABBGGRR or &HBBGGRR
  const m = assColor.replace(/^&H/i, '').replace(/&$/, '');
  if (m.length >= 6) {
    const b = m.slice(-6, -4);
    const g = m.slice(-4, -2);
    const r = m.slice(-2);
    return `#${r}${g}${b}`;
  }
  return null;
}

function assTextToVtt(text, style) {
  let result = text;

  // Convert inline ASS tags to VTT/HTML
  // Bold
  result = result.replace(/\{\\b1\}/g, '<b>').replace(/\{\\b0\}/g, '</b>');
  // Italic
  result = result.replace(/\{\\i1\}/g, '<i>').replace(/\{\\i0\}/g, '</i>');
  // Underline
  result = result.replace(/\{\\u1\}/g, '<u>').replace(/\{\\u0\}/g, '</u>');
  // Color tags: {\c&HBBGGRR&} or {\1c&HBBGGRR&}
  result = result.replace(/\{\\(?:1)?c&H([0-9A-Fa-f]{6})&?\}/g, (_, hex) => {
    const color = assColorToVtt('&H' + hex);
    return color ? `<c.color${color}>` : '';
  });
  // Remove remaining ASS tags
  result = result.replace(/\{[^}]*\}/g, '');
  // Newlines
  result = result.replace(/\\N/g, '\n').replace(/\\n/g, '\n').replace(/\\h/g, ' ');

  // Apply style-level formatting
  if (style) {
    if (style.bold) result = `<b>${result}</b>`;
    if (style.italic) result = `<i>${result}</i>`;
    if (style.color) result = `<c.color${style.color}>${result}</c>`;
  }

  return result.trim();
}

// ── Serve custom subtitle from R2 ─────────────────────────────────

app.get('/custom-sub/:imdbId/:filename', async (req, res) => {
  if (!s3) return res.status(404).send('R2 not configured');
  try {
    const { imdbId, filename } = req.params;
    const key = `custom/${imdbId}/${filename}`;
    console.log(`[Custom] Serving: ${key}`);
    const getRes = await s3.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }));
    const chunks = [];
    for await (const chunk of getRes.Body) chunks.push(chunk);
    const buf = Buffer.concat(chunks);

    // Convert ASS/SSA to VTT for Stremio compatibility (preserves more styling than SRT)
    const ext = filename.split('.').pop().toLowerCase();
    let content;
    if (ext === 'ass' || ext === 'ssa') {
      console.log(`[Custom] Converting ${ext.toUpperCase()} to VTT`);
      content = assToVtt(buf);
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    } else if (ext === 'vtt') {
      content = buf;
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
    } else {
      content = buf;
      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    }

    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(content);
  } catch (e) {
    console.error('[Custom] Serve error:', e.message);
    res.status(404).send('Not found');
  }
});

// ── Dashboard page ───────────────────────────────────────────────

app.get('/:config/dashboard', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !config.username) return res.status(401).send('Not logged in');
  const host = `${req.protocol}://${req.get('host')}`;
  const history = await r2GetHistory(config.username);
  res.type('html').send(getDashboardPage(host, config, history, req.params.config));
});

// ── Upload custom subtitle ───────────────────────────────────────

app.post('/:config/upload', express.json({ limit: '2mb' }), async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !config.username) return res.status(401).json({ error: 'Not logged in' });

  const { imdbId, content, filename, label, lang } = req.body;
  if (!imdbId || !content || !filename) {
    return res.status(400).json({ error: 'Missing fields' });
  }

  // Convert base64 content - only convert encoding for SRT, leave ASS/SSA as-is
  let subContent;
  try {
    const buf = Buffer.from(content, 'base64');
    const ext = filename.split('.').pop().toLowerCase();
    if (ext === 'srt' || ext === 'sub') {
      subContent = ensureUtf8(buf);
    } else {
      // ASS/SSA/VTT — keep as-is (they usually have encoding declaration inside)
      subContent = buf;
    }
  } catch {
    return res.status(400).json({ error: 'Invalid file content' });
  }

  const ok = await r2PutCustomSub(
    imdbId,
    filename.replace(/[^a-zA-Z0-9._-]/g, '_'),
    subContent,
    label || filename.replace(/\.(srt|ssa|ass|sub|vtt)$/i, ''),
    lang || 'cze',
    config.username
  );

  res.json({ success: ok });
});

// ── List custom subtitles for an IMDB ID ─────────────────────────

app.get('/:config/custom-list/:imdbId', async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !config.username) return res.status(401).json({ error: 'Not logged in' });

  const subs = await r2GetCustomSubs(req.params.imdbId);
  res.json({ subs });
});

// ── Admin users ──────────────────────────────────────────────────
const ADMIN_USERS = new Set((process.env.ADMIN_USERS || 'David32').toLowerCase().split(',').map(u => u.trim()));

function isAdmin(username) {
  return ADMIN_USERS.has((username || '').toLowerCase());
}

// ── Delete custom subtitle ───────────────────────────────────────

app.post('/:config/custom-delete', express.json(), async (req, res) => {
  const config = decodeConfig(req.params.config);
  if (!config || !config.username) return res.status(401).json({ error: 'Not logged in' });

  const { key } = req.body;
  if (!key || !key.startsWith('custom/')) {
    return res.status(400).json({ error: 'Invalid key' });
  }

  if (!s3) return res.status(500).json({ error: 'R2 not configured' });

  // Check permission: get uploader metadata
  try {
    const getRes = await s3.send(new GetObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }));
    // Consume body to avoid leak
    for await (const _ of getRes.Body) {}
    const uploader = getRes.Metadata?.uploader || 'unknown';

    if (!isAdmin(config.username) && uploader.toLowerCase() !== config.username.toLowerCase()) {
      console.log(`[R2] Delete denied: ${config.username} tried to delete sub by ${uploader}`);
      return res.status(403).json({ error: 'Nemáte oprávnění smazat tyto titulky' });
    }
  } catch (e) {
    // If file doesn't exist, just return success
    if (e.name === 'NoSuchKey' || e.$metadata?.httpStatusCode === 404) {
      return res.json({ success: true });
    }
  }

  try {
    await s3.send(new DeleteObjectCommand({
      Bucket: process.env.R2_BUCKET,
      Key: key,
    }));
    console.log(`[R2] Deleted custom sub: ${key} (by ${config.username})`);
    res.json({ success: true });
  } catch (e) {
    console.log(`[R2] Delete error: ${e.message}`);
    res.json({ success: false, error: e.message });
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
    <a class="btn btn-install" id="dashboardLink" href="#" style="background: var(--surface-2); border: 1px solid var(--border); color: var(--accent); margin-top: 8px;">
      📺 Dashboard – nahrát vlastní titulky
    </a>
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
      document.getElementById('dashboardLink').href = '/' + config + '/dashboard';
      document.getElementById('addonUrl').textContent = manifestUrl;
      result.classList.add('show');

      // Save config to localStorage for auto-login
      try { localStorage.setItem('titulky_config', config); } catch {}
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

// Auto-login: if config saved in localStorage, restore session
(function autoLogin() {
  try {
    const saved = localStorage.getItem('titulky_config');
    if (!saved) return;
    const parsed = JSON.parse(atob(saved.replace(/-/g, '+').replace(/_/g, '/')));
    if (parsed.username && parsed.password) {
      document.getElementById('username').value = parsed.username;
      document.getElementById('password').value = parsed.password;
      verify();
    }
  } catch {}
})();
</script>
</body>
</html>`;
}

// ── Start ─────────────────────────────────────────────────────────

function getDashboardPage(host, config, history, configStr) {
  const historyHtml = history.length === 0
    ? '<p class="subtitle">Zatím jsi nic nepřehrával. Pusť si film nebo seriál ve Stremiu a vrať se sem.</p>'
    : history.map(h => `
      <div class="history-item" data-imdb="${h.imdbId}" data-id="${h.id}" data-type="${h.type}" data-name="${h.name.replace(/"/g, '&quot;')}">
        <img class="poster" src="${h.poster || 'https://via.placeholder.com/80x120/1c2030/8891a8?text=?'}" alt="${h.name}">
        <div class="history-info">
          <div class="history-title">${h.name}${h.type === 'series' && h.id.includes(':') ? (() => { const p = h.id.split(':'); return ' S' + String(p[1]||1).padStart(2,'0') + 'E' + String(p[2]||1).padStart(2,'0'); })() : ''}</div>
          <div class="history-meta">${h.type === 'series' ? 'Seriál' : 'Film'} · ${h.imdbId}</div>
          <button class="btn btn-upload" onclick="showUpload('${h.id.replace(/:/g, '-')}', '${h.name.replace(/'/g, "\\'")}${h.type === 'series' && h.id.includes(':') ? (() => { const p = h.id.split(':'); return ' S' + String(p[1]||1).padStart(2,'0') + 'E' + String(p[2]||1).padStart(2,'0'); })() : ''}', '${h.type}')">
            📤 Nahrát titulky
          </button>
        </div>
      </div>
    `).join('');

  return `<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Dashboard – Titulky.com Addon</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=JetBrains+Mono:wght@400;500&display=swap" rel="stylesheet">
<style>
  :root {
    --bg: #0c0e14; --surface: #151821; --surface-2: #1c2030;
    --border: #2a2e40; --accent: #4f8cff; --accent-hover: #6ba0ff;
    --text: #e4e7f0; --text-dim: #8891a8; --danger: #ff5c5c;
    --success: #4fdb8a; --radius: 12px;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: 'DM Sans', sans-serif; background: var(--bg);
    color: var(--text); min-height: 100vh; padding: 24px;
  }
  .container { max-width: 640px; margin: 0 auto; }
  h1 { font-size: 24px; margin-bottom: 8px; }
  .subtitle { color: var(--text-dim); font-size: 14px; margin-bottom: 24px; }

  .history-item {
    display: flex; gap: 16px; padding: 16px;
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); margin-bottom: 12px;
  }
  .poster {
    width: 70px; height: 100px; object-fit: cover;
    border-radius: 8px; flex-shrink: 0; background: var(--surface-2);
  }
  .history-info { flex: 1; display: flex; flex-direction: column; justify-content: center; }
  .history-title { font-weight: 600; font-size: 16px; margin-bottom: 4px; }
  .history-meta { color: var(--text-dim); font-size: 13px; margin-bottom: 12px; }

  .btn {
    display: inline-flex; align-items: center; gap: 8px;
    padding: 10px 18px; border: none; border-radius: var(--radius);
    font-family: inherit; font-size: 14px; font-weight: 500;
    cursor: pointer; transition: all 0.2s;
  }
  .btn-upload { background: var(--surface-2); color: var(--accent); border: 1px solid var(--border); }
  .btn-upload:hover { background: var(--border); }
  .btn-primary { background: var(--accent); color: #fff; width: 100%; justify-content: center; }
  .btn-primary:hover { background: var(--accent-hover); }
  .btn-back { background: transparent; color: var(--text-dim); border: 1px solid var(--border); margin-bottom: 24px; }

  .upload-modal {
    display: none; position: fixed; inset: 0; background: rgba(0,0,0,0.7);
    z-index: 100; align-items: center; justify-content: center; padding: 24px;
  }
  .upload-modal.show { display: flex; }
  .upload-card {
    background: var(--surface); border: 1px solid var(--border);
    border-radius: var(--radius); padding: 32px; max-width: 480px; width: 100%;
  }
  .upload-card h2 { font-size: 18px; margin-bottom: 16px; }

  label { display: block; font-size: 13px; color: var(--text-dim); margin-bottom: 6px; margin-top: 16px; }
  input, select {
    width: 100%; padding: 12px 14px; border: 1px solid var(--border);
    border-radius: var(--radius); background: var(--surface-2);
    color: var(--text); font-family: inherit; font-size: 14px;
  }
  input:focus, select:focus { outline: none; border-color: var(--accent); }
  input[type="file"] { padding: 10px; }
  input[type="file"]::file-selector-button {
    padding: 6px 14px; border: 1px solid var(--border); border-radius: 8px;
    background: var(--surface-2); color: var(--text); cursor: pointer;
    font-family: inherit; margin-right: 12px;
  }

  .status { margin-top: 16px; font-size: 14px; text-align: center; min-height: 20px; }
  .status.ok { color: var(--success); }
  .status.error { color: var(--danger); }
  .close-btn {
    float: right; background: none; border: none; color: var(--text-dim);
    font-size: 20px; cursor: pointer; padding: 0 4px;
  }
  .close-btn:hover { color: var(--text); }
  .loading-text { color: var(--text-dim); font-size: 14px; }
  .existing-sub {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 12px; background: var(--surface-2); border: 1px solid var(--border);
    border-radius: 8px; margin-bottom: 8px;
  }
  .existing-sub-info { flex: 1; min-width: 0; }
  .existing-sub-name { display: block; font-size: 14px; font-weight: 500; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .existing-sub-meta { display: block; font-size: 12px; color: var(--text-dim); margin-top: 2px; }
  .btn-delete {
    background: none; border: 1px solid var(--border); border-radius: 8px;
    color: var(--danger); cursor: pointer; padding: 6px 10px; font-size: 14px;
    flex-shrink: 0; margin-left: 10px; transition: all 0.2s;
  }
  .btn-delete:hover { background: rgba(255,92,92,0.1); border-color: var(--danger); }
</style>
</head>
<body>
<div class="container">
  <a href="/${configStr}/configure" class="btn btn-back">← Zpět na konfiguraci</a>
  <h1>📺 Poslední přehrávané</h1>
  <p class="subtitle">Nahraj vlastní titulky k filmům a seriálům, které jsi přehrával.</p>

  ${historyHtml}
</div>

<div class="upload-modal" id="uploadModal">
  <div class="upload-card">
    <button class="close-btn" onclick="hideUpload()">✕</button>
    <h2 id="uploadTitle">Titulky</h2>

    <div id="existingSubs">
      <p class="loading-text">Načítám…</p>
    </div>

    <hr style="border: none; border-top: 1px solid var(--border); margin: 20px 0;">
    <h3 style="font-size: 15px; margin-bottom: 12px;">Nahrát nové titulky</h3>

    <label for="subFile">Soubor titulků (.srt, .ssa, .ass, .sub, .vtt)</label>
    <input type="file" id="subFile" accept=".srt,.ssa,.ass,.sub,.vtt">

    <label for="subLabel">Popis (volitelné)</label>
    <input type="text" id="subLabel" placeholder="např. CZ, fansub, 1080p BluRay">

    <label for="subLang">Jazyk</label>
    <select id="subLang">
      <option value="cze">Čeština</option>
      <option value="slk">Slovenčina</option>
      <option value="eng">Angličtina</option>
    </select>

    <button class="btn btn-primary" style="margin-top: 20px;" onclick="doUpload()">📤 Nahrát</button>
    <div class="status" id="uploadStatus"></div>
  </div>
</div>

<script>
const CONFIG_STR = '${configStr}';
const CURRENT_USER = '${config.username.replace(/'/g, "\\'")}';
const IS_ADMIN = ${isAdmin(config.username)};
let currentImdbId = '';

async function showUpload(id, name, type) {
  currentImdbId = id;
  document.getElementById('uploadTitle').textContent = name;
  document.getElementById('uploadStatus').textContent = '';
  document.getElementById('subFile').value = '';
  document.getElementById('subLabel').value = '';
  document.getElementById('existingSubs').innerHTML = '<p class="loading-text">Načítám…</p>';
  document.getElementById('uploadModal').classList.add('show');

  // Load existing custom subs
  try {
    const res = await fetch('/' + CONFIG_STR + '/custom-list/' + id);
    const data = await res.json();
    renderExistingSubs(data.subs || []);
  } catch {
    document.getElementById('existingSubs').innerHTML = '<p class="subtitle">Nepodařilo se načíst titulky</p>';
  }
}

function renderExistingSubs(subs) {
  const el = document.getElementById('existingSubs');
  if (subs.length === 0) {
    el.innerHTML = '<p class="subtitle">Žádné nahrané titulky</p>';
    return;
  }
  el.innerHTML = '<p style="font-size:13px; color:var(--text-dim); margin-bottom:8px;">Nahrané titulky:</p>' +
    subs.map(s => {
      const canDelete = IS_ADMIN || (s.uploader && s.uploader.toLowerCase() === CURRENT_USER.toLowerCase());
      const uploaderText = s.uploader && s.uploader !== 'unknown' ? ' · nahrál ' + s.uploader : '';
      return \`
      <div class="existing-sub" id="sub-\${btoa(s.key).replace(/[^a-zA-Z0-9]/g,'')}">
        <div class="existing-sub-info">
          <span class="existing-sub-name">\${s.label}</span>
          <span class="existing-sub-meta">\${s.filename} · \${s.lang === 'cze' ? 'CZ' : s.lang === 'slk' ? 'SK' : s.lang.toUpperCase()}\${uploaderText}</span>
        </div>
        \${canDelete ? '<button class="btn-delete" onclick="deleteSub(\\'' + s.key.replace(/'/g, "\\\\\\\\'") + '\\', this)" title="Smazat">🗑</button>' : ''}
      </div>
    \`;}).join('');
}

async function deleteSub(key, btnEl) {
  if (!confirm('Opravdu smazat tyto titulky?')) return;
  btnEl.disabled = true;
  btnEl.textContent = '…';

  try {
    const res = await fetch('/' + CONFIG_STR + '/custom-delete', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ key }),
    });
    const data = await res.json();
    if (data.success) {
      btnEl.closest('.existing-sub').remove();
      // Check if any left
      const container = document.getElementById('existingSubs');
      if (!container.querySelector('.existing-sub')) {
        container.innerHTML = '<p class="subtitle">Žádné nahrané titulky</p>';
      }
    } else {
      alert('Chyba: ' + (data.error || 'neznámá'));
      btnEl.disabled = false;
      btnEl.textContent = '🗑';
    }
  } catch (e) {
    alert('Chyba: ' + e.message);
    btnEl.disabled = false;
    btnEl.textContent = '🗑';
  }
}

function hideUpload() {
  document.getElementById('uploadModal').classList.remove('show');
}

document.getElementById('uploadModal').addEventListener('click', function(e) {
  if (e.target === this) hideUpload();
});

async function doUpload() {
  const fileInput = document.getElementById('subFile');
  const label = document.getElementById('subLabel').value.trim();
  const lang = document.getElementById('subLang').value;
  const status = document.getElementById('uploadStatus');

  if (!fileInput.files.length) {
    status.className = 'status error';
    status.textContent = 'Vyber soubor';
    return;
  }

  const file = fileInput.files[0];
  if (!/\\.(srt|ssa|ass|sub|vtt)$/i.test(file.name)) {
    status.className = 'status error';
    status.textContent = 'Podporované formáty: .srt, .ssa, .ass, .sub, .vtt';
    return;
  }

  status.className = 'status';
  status.textContent = 'Nahrávám…';

  try {
    const buf = await file.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
    }
    const base64 = btoa(binary);

    const res = await fetch('/' + CONFIG_STR + '/upload', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        imdbId: currentImdbId,
        content: base64,
        filename: file.name,
        label: label || file.name.replace(/\\.(srt|ssa|ass|sub|vtt)$/i, ''),
        lang: lang,
      }),
    });
    const data = await res.json();

    if (data.success) {
      status.className = 'status ok';
      status.textContent = '✓ Titulky nahrány!';
      fileInput.value = '';
      document.getElementById('subLabel').value = '';
      // Reload the list
      const listRes = await fetch('/' + CONFIG_STR + '/custom-list/' + currentImdbId);
      const listData = await listRes.json();
      renderExistingSubs(listData.subs || []);
    } else {
      status.className = 'status error';
      status.textContent = 'Chyba: ' + (data.error || 'neznámá');
    }
  } catch (e) {
    status.className = 'status error';
    status.textContent = 'Chyba: ' + e.message;
  }
}
</script>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`Titulky.com Stremio addon running on port ${PORT}`);
  console.log(`Configure at: http://localhost:${PORT}/configure`);
});
