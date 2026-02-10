const express = require('express');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const axios = require('axios');
const cheerio = require('cheerio');
const session = require('express-session');

const app = express();
const PORT = process.env.PORT || 7000;

// Middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
  secret: process.env.SESSION_SECRET || 'titulky-secret-key-change-me',
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 30 * 24 * 60 * 60 * 1000 } // 30 days
}));

// In-memory storage for credentials (in production, use database)
let globalCredentials = {
  titulkyUsername: process.env.TITULKY_USERNAME || null,
  titulkyPassword: process.env.TITULKY_PASSWORD || null,
  omdbApiKey: process.env.OMDB_API_KEY || null
};

// Session management for titulky.com
let cookies = [];
let isLoggedIn = false;
const imdbCache = new Map();

// Helper functions
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

async function login(username, password) {
  try {
    console.log('🔐 Logging in to premium.titulky.com...');
    const baseUrl = 'https://premium.titulky.com';
    
    const homeResponse = await axios.get(baseUrl, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    updateCookies(homeResponse.headers['set-cookie']);
    
    const formData = new URLSearchParams({
      'LoginName': username,
      'LoginPassword': password,
      'PermanentLog': '148'
    });
    
    const loginResponse = await axios.post(baseUrl + '/', formData.toString(), {
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'Cookie': getCookieHeader(),
        'Referer': `${baseUrl}/`,
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      },
      maxRedirects: 5
    });
    
    updateCookies(loginResponse.headers['set-cookie']);
    
    const verifyResponse = await axios.get(baseUrl + '/', {
      headers: {
        'Cookie': getCookieHeader(),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
      }
    });
    
    const htmlContent = verifyResponse.data;
    const success = htmlContent.includes('Odhlásit') || htmlContent.includes(username);
    
    if (success) {
      console.log('✅ Login successful!');
      isLoggedIn = true;
      return true;
    }
    return false;
  } catch (error) {
    console.error('Login error:', error.message);
    return false;
  }
}

async function getIMDBTitle(imdbId, season = null, episode = null) {
  const cacheKey = `${imdbId}:${season}:${episode}`;
  if (imdbCache.has(cacheKey)) {
    return imdbCache.get(cacheKey);
  }
  
  const omdbApiKey = globalCredentials.omdbApiKey;
  if (!omdbApiKey) {
    console.warn('⚠️  OMDB_API_KEY not set');
    return null;
  }
  
  try {
    const url = `http://www.omdbapi.com/?i=${imdbId}&apikey=${omdbApiKey}`;
    const response = await axios.get(url);
    
    if (response.data.Response === 'False') {
      return null;
    }
    
    let title = response.data.Title;
    const year = response.data.Year ? parseInt(response.data.Year) : null;
    
    if (season && episode) {
      const seasonStr = season.toString().padStart(2, '0');
      const episodeStr = episode.toString().padStart(2, '0');
      title = `${title} S${seasonStr}E${episodeStr}`;
    }
    
    const result = { title, year };
    imdbCache.set(cacheKey, result);
    console.log(`📺 IMDB ${imdbId} → "${title}" (${year})`);
    return result;
  } catch (error) {
    console.error(`Error fetching IMDB title: ${error.message}`);
    return null;
  }
}

async function searchSubtitles(query, page = 1) {
  if (!isLoggedIn) {
    throw new Error('Not logged in to titulky.com');
  }
  
  try {
    console.log(`🔍 Searching for: ${query}`);
    const baseUrl = 'https://premium.titulky.com';
    const params = { action: 'search', Fulltext: query };
    if (page > 1) params.Strana = page.toString();
    
    const response = await axios.get(baseUrl + '/', {
      params,
      headers: {
        'Cookie': getCookieHeader(),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
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
      if (href.startsWith('./')) {
        downloadUrl = `${baseUrl}/${href.substring(2)}`;
      } else if (href.startsWith('/')) {
        downloadUrl = `${baseUrl}${href}`;
      } else if (!href.startsWith('http')) {
        downloadUrl = `${baseUrl}/${href}`;
      }
      
      subtitles.push({ id, title, language: 'cs', format: 'srt', downloadUrl });
    });
    
    console.log(`✅ Found ${subtitles.length} subtitles`);
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
    console.log(`📺 Subtitle request: type=${type}, id=${id}`);
    
    if (!isLoggedIn) {
      console.error('Not logged in to titulky.com');
      return { subtitles: [] };
    }
    
    const parts = id.split(':');
    const imdbId = parts[0];
    const season = parts[1] ? parseInt(parts[1]) : null;
    const episode = parts[2] ? parseInt(parts[2]) : null;
    
    if (!imdbId.startsWith('tt')) {
      return { subtitles: [] };
    }
    
    const mediaInfo = await getIMDBTitle(imdbId, season, episode);
    if (!mediaInfo) {
      console.error('Could not get title from IMDB ID');
      return { subtitles: [] };
    }
    
    const subtitles = await searchSubtitles(mediaInfo.title);
    
    const stremioSubtitles = subtitles.map(sub => ({
      id: `titulky:${sub.id}`,
      url: sub.downloadUrl,
      lang: sub.language
    }));
    
    console.log(`✅ Returning ${stremioSubtitles.length} subtitles`);
    return { subtitles: stremioSubtitles };
  } catch (error) {
    console.error('Subtitles handler error:', error.message);
    return { subtitles: [] };
  }
});

const addonInterface = builder.getInterface();

// Web Routes
app.get('/', (req, res) => {
  const configured = globalCredentials.titulkyUsername && 
                    globalCredentials.titulkyPassword && 
                    globalCredentials.omdbApiKey;
  
  res.send(`
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Titulky.com Stremio Addon</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Oxygen, Ubuntu, Cantarell, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            justify-content: center;
            align-items: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 40px;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .status {
            padding: 15px;
            border-radius: 10px;
            margin-bottom: 20px;
            font-size: 14px;
        }
        .status.success {
            background: #d4edda;
            color: #155724;
            border: 1px solid #c3e6cb;
        }
        .status.warning {
            background: #fff3cd;
            color: #856404;
            border: 1px solid #ffeaa7;
        }
        .status.error {
            background: #f8d7da;
            color: #721c24;
            border: 1px solid #f5c6cb;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            color: #333;
            font-weight: 500;
            font-size: 14px;
        }
        input {
            width: 100%;
            padding: 12px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 14px;
            transition: border-color 0.3s;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
        }
        .help-text {
            font-size: 12px;
            color: #666;
            margin-top: 5px;
        }
        .help-text a {
            color: #667eea;
            text-decoration: none;
        }
        .help-text a:hover {
            text-decoration: underline;
        }
        button {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 5px 15px rgba(102, 126, 234, 0.4);
        }
        button:active {
            transform: translateY(0);
        }
        .addon-url {
            background: #f8f9fa;
            padding: 15px;
            border-radius: 8px;
            margin-top: 20px;
            font-family: 'Courier New', monospace;
            font-size: 13px;
            word-break: break-all;
            border: 2px solid #e0e0e0;
        }
        .addon-url strong {
            display: block;
            margin-bottom: 8px;
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            color: #333;
        }
        .copy-btn {
            margin-top: 10px;
            background: #28a745;
            padding: 10px;
            font-size: 14px;
        }
        .copy-btn:hover {
            background: #218838;
        }
        .footer {
            text-align: center;
            margin-top: 20px;
            color: #666;
            font-size: 12px;
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>🎬 Titulky.com Addon</h1>
        <p class="subtitle">Stremio addon pro české titulky</p>
        
        ${configured ? `
            <div class="status success">
                ✅ Addon je nakonfigurován a připraven!
                ${isLoggedIn ? '<br>🔐 Přihlášen k titulky.com' : '<br>⏳ Probíhá přihlášení...'}
            </div>
            
            <div class="addon-url">
                <strong>Addon URL pro Stremio:</strong>
                <code id="addonUrl">${req.protocol}://${req.get('host')}/manifest.json</code>
                <button class="copy-btn" onclick="copyUrl()">📋 Kopírovat URL</button>
            </div>
            
            <div class="status warning" style="margin-top: 20px; font-size: 13px;">
                💡 <strong>Jak přidat do Stremio:</strong><br>
                1. Otevřete Stremio<br>
                2. Jděte do Addons → Community Addons<br>
                3. Klikněte na "Add-on Repository URL"<br>
                4. Vložte URL výše a klikněte Install
            </div>
            
            <form method="POST" action="/configure" style="margin-top: 20px;">
                <button type="submit">⚙️ Změnit nastavení</button>
            </form>
        ` : `
            <div class="status warning">
                ⚠️ Addon ještě není nakonfigurován
            </div>
            
            <form method="POST" action="/save-config">
                <div class="form-group">
                    <label>Titulky.com email/username:</label>
                    <input type="text" name="titulkyUsername" required placeholder="vas.email@example.com">
                </div>
                
                <div class="form-group">
                    <label>Titulky.com heslo:</label>
                    <input type="password" name="titulkyPassword" required placeholder="••••••••">
                </div>
                
                <div class="form-group">
                    <label>OMDb API klíč:</label>
                    <input type="text" name="omdbApiKey" required placeholder="abcd1234">
                    <div class="help-text">
                        Zdarma na <a href="https://www.omdbapi.com/apikey.aspx" target="_blank">omdbapi.com/apikey.aspx</a> (FREE tier)
                    </div>
                </div>
                
                <button type="submit">💾 Uložit a aktivovat</button>
            </form>
        `}
        
        <div class="footer">
            Made with ❤️ for Stremio | <a href="https://premium.titulky.com" target="_blank" style="color: #667eea; text-decoration: none;">Titulky.com</a>
        </div>
    </div>
    
    <script>
        function copyUrl() {
            const url = document.getElementById('addonUrl').textContent;
            navigator.clipboard.writeText(url).then(() => {
                const btn = event.target;
                const originalText = btn.textContent;
                btn.textContent = '✅ Zkopírováno!';
                setTimeout(() => {
                    btn.textContent = originalText;
                }, 2000);
            });
        }
    </script>
</body>
</html>
  `);
});

app.post('/save-config', async (req, res) => {
  const { titulkyUsername, titulkyPassword, omdbApiKey } = req.body;
  
  if (!titulkyUsername || !titulkyPassword || !omdbApiKey) {
    return res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Chyba</title></head>
      <body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1>❌ Chyba</h1>
        <p>Všechna pole jsou povinná!</p>
        <a href="/" style="color: #667eea;">← Zpět</a>
      </body></html>
    `);
  }
  
  globalCredentials = { titulkyUsername, titulkyPassword, omdbApiKey };
  
  // Try to login
  const loginSuccess = await login(titulkyUsername, titulkyPassword);
  
  if (loginSuccess) {
    res.redirect('/?success=1');
  } else {
    res.send(`
      <!DOCTYPE html>
      <html><head><meta charset="UTF-8"><title>Chyba přihlášení</title></head>
      <body style="font-family: sans-serif; padding: 40px; text-align: center;">
        <h1>❌ Chyba přihlášení</h1>
        <p>Nepodařilo se přihlásit k titulky.com. Zkontrolujte username a heslo.</p>
        <a href="/" style="color: #667eea;">← Zkusit znovu</a>
      </body></html>
    `);
  }
});

app.post('/configure', (req, res) => {
  globalCredentials = { titulkyUsername: null, titulkyPassword: null, omdbApiKey: null };
  isLoggedIn = false;
  cookies = [];
  res.redirect('/');
});

// Stremio addon endpoints
app.get('/manifest.json', (req, res) => {
  res.json(addonInterface.manifest);
});

app.get('/subtitles/:type/:id.json', async (req, res) => {
  const result = await addonInterface.get('subtitles', req.params.type, req.params.id);
  res.json(result);
});

// Auto-login on startup if credentials exist
if (globalCredentials.titulkyUsername && globalCredentials.titulkyPassword) {
  login(globalCredentials.titulkyUsername, globalCredentials.titulkyPassword).catch(err => {
    console.error('Auto-login failed:', err.message);
  });
}

app.listen(PORT, () => {
  console.log(`
🚀 Titulky.com Stremio Addon běží!

📍 Web interface: http://localhost:${PORT}
📍 Addon manifest: http://localhost:${PORT}/manifest.json

${globalCredentials.titulkyUsername ? '✅ Nakonfigurováno' : '⚠️  Otevřete web interface pro konfiguraci'}
  `);
});
