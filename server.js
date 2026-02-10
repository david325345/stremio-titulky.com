const express = require('express');
const { addonBuilder } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const session = require('express-session');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 7000;

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'titulky-secret',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 }
}));

// Credentials file
const CREDENTIALS_FILE = path.join(__dirname, 'credentials.json');

function loadCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_FILE)) {
      const data = fs.readFileSync(CREDENTIALS_FILE, 'utf8');
      return JSON.parse(data);
    }
  } catch (error) {
    console.error('Error loading credentials:', error.message);
  }
  return {
    titulkyUsername: process.env.TITULKY_USERNAME || null,
    titulkyPassword: process.env.TITULKY_PASSWORD || null,
    omdbApiKey: process.env.OMDB_API_KEY || null
  };
}

function saveCredentials(creds) {
  try {
    fs.writeFileSync(CREDENTIALS_FILE, JSON.stringify(creds, null, 2), 'utf8');
    return true;
  } catch (error) {
    console.error('Error saving credentials:', error.message);
    return false;
  }
}

let globalCredentials = loadCredentials();
let cookies = [];
let isLoggedIn = false;
const imdbCache = new Map();

function getCookieHeader() {
  return cookies.join('; ');
}

function updateCookies(setCookieHeaders) {
  if (!setCookieHeaders) return;
  const cookieArray = Array.isArray(setCookieHeaders) ? setCookieHeaders : [setCookieHeaders];
  for (const cookie of cookieArray) {
    const cookieName = cookie.split('=')[0];
    cookies = cookies.filter(c => !c.startsWith(`${cookieName}=`));
    cookies.push(cookie.split(';')[0]);
  }
}

// SIMPLE LOGIN - exactly matching Dart code
async function login(username, password) {
  try {
    console.log('');
    console.log('========================================');
    console.log('LOGIN ATTEMPT');
    console.log('========================================');
    console.log(`Username: ${username}`);
    console.log(`Password: ${password.substring(0, 2)}***`);
    
    const baseUrl = 'https://premium.titulky.com';
    cookies = [];
    
    // Step 1: Get homepage
    console.log('\n[STEP 1] Getting homepage for cookies...');
    const homeResponse = await axios.get(baseUrl + '/', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: 20000
    });
    
    updateCookies(homeResponse.headers['set-cookie']);
    console.log(`Cookies received: ${cookies.length}`);
    cookies.forEach((c, i) => console.log(`  [${i+1}] ${c}`));
    
    // INSPECT THE LOGIN FORM IN HTML
    const homeHtml = homeResponse.data.toString();
    console.log('\n[INSPECTING] Looking for login form fields...');
    
    // Extract form fields using regex
    const inputMatches = homeHtml.matchAll(/<input[^>]*name=["']([^"']+)["'][^>]*>/gi);
    const formFields = [];
    for (const match of inputMatches) {
      const fullInput = match[0];
      const fieldName = match[1];
      const typeMatch = fullInput.match(/type=["']([^"']+)["']/i);
      const valueMatch = fullInput.match(/value=["']([^"']+)["']/i);
      const type = typeMatch ? typeMatch[1] : 'text';
      const value = valueMatch ? valueMatch[1] : '';
      
      // Only show relevant fields
      if (fieldName.toLowerCase().includes('login') || 
          fieldName.toLowerCase().includes('password') || 
          fieldName.toLowerCase().includes('user') ||
          fieldName.toLowerCase().includes('name') ||
          type === 'hidden') {
        formFields.push({ name: fieldName, type, value });
      }
    }
    
    console.log('Found login-related form fields:');
    formFields.forEach((field, i) => {
      console.log(`  [${i+1}] name="${field.name}" type="${field.type}" value="${field.value || '(empty)'}"`);
    });
    
    // Also look for form action
    const formActionMatch = homeHtml.match(/<form[^>]*action=["']([^"']+)["']/i);
    const formAction = formActionMatch ? formActionMatch[1] : 'NOT FOUND';
    console.log(`Form action: ${formAction}`);
    console.log('');
    
    // Step 2: POST login
    console.log('\n[STEP 2] Posting login form...');
    const formData = new URLSearchParams();
    formData.append('LoginName', username);
    formData.append('LoginPassword', password);
    formData.append('PermanentLog', '148');
    
    console.log('Form data:');
    console.log(`  LoginName: ${username}`);
    console.log(`  LoginPassword: ***`);
    console.log(`  PermanentLog: 148`);
    
    const loginResponse = await axios.post(baseUrl + '/', formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': getCookieHeader(),
        'Referer': baseUrl + '/',
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      maxRedirects: 5,
      timeout: 20000
    });
    
    console.log(`Response status: ${loginResponse.status}`);
    updateCookies(loginResponse.headers['set-cookie']);
    console.log(`Total cookies: ${cookies.length}`);
    cookies.forEach((c, i) => console.log(`  [${i+1}] ${c}`));
    
    // Check login response HTML
    const loginHtml = loginResponse.data.toString();
    console.log(`\nResponse HTML length: ${loginHtml.length} chars`);
    console.log('\n--- RESPONSE HTML (first 1500 chars) ---');
    console.log(loginHtml.substring(0, 1500));
    console.log('--- END RESPONSE HTML ---\n');
    
    // Step 3: Verify
    console.log('[STEP 3] Verifying login...');
    const verifyResponse = await axios.get(baseUrl + '/', {
      headers: {
        'Cookie': getCookieHeader(),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      },
      timeout: 20000
    });
    
    const verifyHtml = verifyResponse.data.toString();
    
    // Check for success indicators
    const hasOdhlasit = verifyHtml.includes('Odhlásit') || verifyHtml.includes('odhlásit');
    const hasUsername = verifyHtml.includes(username);
    
    console.log(`Page contains "Odhlásit": ${hasOdhlasit}`);
    console.log(`Page contains username "${username}": ${hasUsername}`);
    
    if (hasOdhlasit || hasUsername) {
      console.log('\n✅ LOGIN SUCCESSFUL!');
      console.log('========================================\n');
      isLoggedIn = true;
      return true;
    } else {
      console.log('\n❌ LOGIN FAILED');
      console.log('Page still shows login form');
      console.log('========================================\n');
      return false;
    }
    
  } catch (error) {
    console.error('\n❌ LOGIN ERROR:', error.message);
    console.log('========================================\n');
    return false;
  }
}

async function getIMDBTitle(imdbId, season = null, episode = null) {
  const cacheKey = `${imdbId}:${season}:${episode}`;
  if (imdbCache.has(cacheKey)) return imdbCache.get(cacheKey);
  
  const omdbApiKey = globalCredentials.omdbApiKey;
  if (!omdbApiKey) return null;
  
  try {
    const response = await axios.get(`http://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}`);
    if (response.data.Response === 'False') return null;
    
    let title = response.data.Title;
    if (season && episode) {
      title = `${title} S${season.toString().padStart(2, '0')}E${episode.toString().padStart(2, '0')}`;
    }
    
    const result = { title, year: response.data.Year ? parseInt(response.data.Year) : null };
    imdbCache.set(cacheKey, result);
    return result;
  } catch (error) {
    return null;
  }
}

async function searchSubtitles(query) {
  if (!isLoggedIn) throw new Error('Not logged in');
  
  try {
    const baseUrl = 'https://premium.titulky.com';
    const response = await axios.get(baseUrl + '/', {
      params: { action: 'search', Fulltext: query },
      headers: {
        'Cookie': getCookieHeader(),
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36'
      }
    });
    
    const $ = cheerio.load(response.data);
    const subtitles = [];
    const seenIds = new Set();
    
    $('a[href*="action=detail"]').each((i, elem) => {
      const href = $(elem).attr('href') || '';
      const idMatch = href.match(/id=(\d+)/);
      const id = idMatch ? idMatch[1] : '';
      if (!id || seenIds.has(id)) return;
      
      const title = $(elem).text().trim();
      if (!title) return;
      
      seenIds.add(id);
      
      let downloadUrl = href;
      if (href.startsWith('./')) downloadUrl = `${baseUrl}/${href.substring(2)}`;
      else if (href.startsWith('/')) downloadUrl = `${baseUrl}${href}`;
      else if (!href.startsWith('http')) downloadUrl = `${baseUrl}/${href}`;
      
      subtitles.push({ id, title, language: 'cs', format: 'srt', downloadUrl });
    });
    
    return subtitles;
  } catch (error) {
    console.error('Search error:', error.message);
    return [];
  }
}

// Stremio Addon
const manifest = {
  id: 'cz.titulky.subtitles',
  version: '1.0.0',
  name: 'Titulky.com',
  description: 'České titulky z premium.titulky.com',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt']
};

const builder = new addonBuilder(manifest);

builder.defineSubtitlesHandler(async ({ type, id }) => {
  try {
    if (!isLoggedIn) return { subtitles: [] };
    
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;
    
    if (!imdbId.startsWith('tt')) return { subtitles: [] };
    
    const mediaInfo = await getIMDBTitle(imdbId, season, episode);
    if (!mediaInfo) return { subtitles: [] };
    
    const subtitles = await searchSubtitles(mediaInfo.title);
    const stremioSubtitles = subtitles.map(sub => ({
      id: `titulky:${sub.id}`,
      url: sub.downloadUrl,
      lang: sub.language
    }));
    
    return { subtitles: stremioSubtitles };
  } catch (error) {
    return { subtitles: [] };
  }
});

const addonInterface = builder.getInterface();

// Web interface (shortened)
app.get('/', (req, res) => {
  const configured = !!(globalCredentials.titulkyUsername && globalCredentials.titulkyPassword && globalCredentials.omdbApiKey);
  
  res.send(`
<!DOCTYPE html>
<html lang="cs">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Titulky.com Addon</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); min-height: 100vh; display: flex; justify-content: center; align-items: center; padding: 20px; }
.container { background: white; border-radius: 20px; box-shadow: 0 20px 60px rgba(0,0,0,0.3); max-width: 500px; width: 100%; padding: 40px; }
h1 { color: #333; margin-bottom: 10px; font-size: 28px; }
.subtitle { color: #666; margin-bottom: 30px; font-size: 14px; }
.status { padding: 15px; border-radius: 10px; margin-bottom: 20px; font-size: 14px; }
.status.success { background: #d4edda; color: #155724; border: 1px solid #c3e6cb; }
.status.warning { background: #fff3cd; color: #856404; border: 1px solid #ffeaa7; }
.form-group { margin-bottom: 20px; }
label { display: block; margin-bottom: 8px; color: #333; font-weight: 500; font-size: 14px; }
input { width: 100%; padding: 12px; border: 2px solid #e0e0e0; border-radius: 8px; font-size: 14px; }
input:focus { outline: none; border-color: #667eea; }
.help-text { font-size: 12px; color: #666; margin-top: 5px; }
.help-text a { color: #667eea; text-decoration: none; }
button { width: 100%; padding: 14px; background: linear-gradient(135deg, #667eea 0%, #764ba2 100%); color: white; border: none; border-radius: 8px; font-size: 16px; font-weight: 600; cursor: pointer; }
button:hover { transform: translateY(-2px); box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4); }
.addon-url { background: #f8f9fa; padding: 15px; border-radius: 8px; margin-top: 20px; font-family: monospace; font-size: 13px; word-break: break-all; border: 2px solid #e0e0e0; }
.addon-url strong { display: block; margin-bottom: 8px; font-family: sans-serif; color: #333; }
.copy-btn { margin-top: 10px; background: #28a745; padding: 10px; font-size: 14px; }
</style>
</head>
<body>
<div class="container">
<h1>🎬 Titulky.com Addon</h1>
<p class="subtitle">Premium Titulky - Stremio</p>
${configured ? `
<div class="status success">✅ Nakonfigurováno! ${isLoggedIn ? '<br>🔐 Přihlášen' : '<br>⏳ Přihlašování...'}</div>
<div class="addon-url">
<strong>Addon URL:</strong>
<code id="url">${req.protocol}://${req.get('host')}/manifest.json</code>
<button class="copy-btn" onclick="navigator.clipboard.writeText(document.getElementById('url').textContent).then(() => {event.target.textContent='✅ Zkopírováno!'; setTimeout(() => event.target.textContent='📋 Kopírovat', 2000)})">📋 Kopírovat</button>
</div>
<form method="POST" action="/configure" style="margin-top:20px;"><button>⚙️ Změnit nastavení</button></form>
` : `
<div class="status warning">⚠️ Není nakonfigurováno</div>
<form method="POST" action="/save-config">
<div class="form-group">
<label>Premium.titulky.com username:</label>
<input type="text" name="titulkyUsername" required placeholder="username (NE email!)">
<div class="help-text">⚠️ Použijte USERNAME, ne email! (např. "david325345")</div>
</div>
<div class="form-group">
<label>Heslo:</label>
<input type="password" name="titulkyPassword" required>
</div>
<div class="form-group">
<label>OMDb API klíč:</label>
<input type="text" name="omdbApiKey" required>
<div class="help-text">Zdarma na <a href="https://www.omdbapi.com/apikey.aspx" target="_blank">omdbapi.com</a></div>
</div>
<button type="submit">💾 Uložit</button>
</form>
`}
</div>
</body>
</html>
  `);
});

app.post('/save-config', async (req, res) => {
  const { titulkyUsername, titulkyPassword, omdbApiKey } = req.body;
  if (!titulkyUsername || !titulkyPassword || !omdbApiKey) {
    return res.send('<h1>❌ Všechna pole jsou povinná!</h1><a href="/">Zpět</a>');
  }
  
  globalCredentials = { titulkyUsername, titulkyPassword, omdbApiKey };
  saveCredentials(globalCredentials);
  
  const loginSuccess = await login(titulkyUsername, titulkyPassword);
  
  if (loginSuccess) {
    res.redirect('/');
  } else {
    res.send('<h1>❌ Přihlášení selhalo</h1><p>Zkontrolujte logy na Render.com</p><a href="/">Zkusit znovu</a>');
  }
});

app.post('/configure', (req, res) => {
  globalCredentials = { titulkyUsername: null, titulkyPassword: null, omdbApiKey: null };
  isLoggedIn = false;
  cookies = [];
  try { if (fs.existsSync(CREDENTIALS_FILE)) fs.unlinkSync(CREDENTIALS_FILE); } catch (e) {}
  res.redirect('/');
});

app.get('/manifest.json', (req, res) => res.json(addonInterface.manifest));
app.get('/subtitles/:type/:id.json', async (req, res) => {
  const result = await addonInterface.get('subtitles', req.params.type, req.params.id);
  res.json(result);
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    configured: !!(globalCredentials.titulkyUsername && globalCredentials.titulkyPassword && globalCredentials.omdbApiKey),
    loggedIn: isLoggedIn,
    timestamp: new Date().toISOString()
  });
});

if (globalCredentials.titulkyUsername && globalCredentials.titulkyPassword) {
  console.log('Auto-login...');
  login(globalCredentials.titulkyUsername, globalCredentials.titulkyPassword);
}

setInterval(() => {
  if (globalCredentials.titulkyUsername && globalCredentials.titulkyPassword) {
    login(globalCredentials.titulkyUsername, globalCredentials.titulkyPassword);
  }
}, 6 * 60 * 60 * 1000);

app.listen(PORT, () => {
  console.log(`
🚀 Titulky.com Addon
📍 http://localhost:${PORT}
${globalCredentials.titulkyUsername ? '✅ Configured' : '⚠️  Not configured'}
  `);
});
