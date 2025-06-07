const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
// Store user sessions (in production, use Redis or database)
const userSessions = new Map();

// Addon manifest
const manifest = {
    id: 'com.titulky.subtitles',
    version: '1.0.0',
    name: 'Titulky.com Subtitles',
    description: 'Czech and Slovak subtitles from Titulky.com',
    logo: 'https://www.titulky.com/favicon.ico',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: []
};

class TitulkyClient {
    constructor() {
        this.baseUrl = 'https://www.titulky.com';
        this.cookies = {};
        this.lastUsed = Date.now();
    }

    async login(username, password) {
        console.log(`[LOGIN] Attempting login for user: ${username}`);
        try {
            const loginData = new URLSearchParams({
                'Login': username,
                'Password': password,
                'foreverlog': '0',
                'Detail2': ''
            });

            console.log(`[LOGIN] Sending POST request to ${this.baseUrl}/index.php`);
            const response = await axios.post(`${this.baseUrl}/index.php`, loginData, {
                headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                    'Origin': this.baseUrl,
                    'Referer': this.baseUrl,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                timeout: 10000
            });

            console.log(`[LOGIN] Response status: ${response.status}`);
            
            if (response.data.includes('BadLogin')) {
                console.log('[LOGIN] Bad credentials detected');
                return false;
            }

            // Extract cookies from response
            const setCookie = response.headers['set-cookie'];
            if (setCookie) {
                console.log(`[LOGIN] Extracting cookies from ${setCookie.length} set-cookie headers`);
                setCookie.forEach(cookie => {
                    const [name, value] = cookie.split('=');
                    if (name && value) {
                        this.cookies[name] = value.split(';')[0];
                        console.log(`[LOGIN] Cookie set: ${name}=${this.cookies[name].substring(0, 10)}...`);
                    }
                });
            }

            this.lastUsed = Date.now();
            console.log('[LOGIN] Login successful');
            return true;
        } catch (error) {
            console.error('[LOGIN] Login error:', error.message);
            if (error.response) {
                console.error('[LOGIN] Response status:', error.response.status);
                console.error('[LOGIN] Response data:', error.response.data?.substring(0, 200));
            }
            return false;
        }
    }

    async searchSubtitles(query) {
        console.log(`[SEARCH] Starting search for: "${query}"`);
        try {
            const searchUrl = `${this.baseUrl}/index.php?${new URLSearchParams({
                'Fulltext': query,
                'FindUser': ''
            })}`;

            console.log(`[SEARCH] Search URL: ${searchUrl}`);
            console.log(`[SEARCH] Using cookies: ${Object.keys(this.cookies).join(', ')}`);

            const response = await axios.get(searchUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': this.baseUrl
                },
                timeout: 15000
            });

            console.log(`[SEARCH] Response status: ${response.status}`);
            console.log(`[SEARCH] Response length: ${response.data.length} characters`);

            const subtitles = this.parseSearchResults(response.data);
            console.log(`[SEARCH] Found ${subtitles.length} subtitles`);
            
            this.lastUsed = Date.now();
            return subtitles;
        } catch (error) {
            console.error('[SEARCH] Search error:', error.message);
            if (error.response) {
                console.error('[SEARCH] Response status:', error.response.status);
                console.error('[SEARCH] Response headers:', error.response.headers);
            }
            return [];
        }
    }

    parseSearchResults(html) {
        console.log('[PARSE] Starting to parse search results');
        const $ = cheerio.load(html);
        const subtitles = [];

        // Debug: Check if we're logged in
        if (html.includes('Přihlásit')) {
            console.log('[PARSE] WARNING: Appears to be logged out (found login text)');
        }

        const rows = $('tr[class^="r"]');
        console.log(`[PARSE] Found ${rows.length} result rows`);

        rows.each((index, element) => {
            try {
                const $row = $(element);
                const cells = $row.find('td');
                
                console.log(`[PARSE] Row ${index}: ${cells.length} cells`);
                
                if (cells.length < 9) {
                    console.log(`[PARSE] Row ${index}: Insufficient cells (${cells.length}), skipping`);
                    return;
                }

                const linkElement = cells.eq(1).find('a');
                const href = linkElement.attr('href');
                console.log(`[PARSE] Row ${index}: href = ${href}`);
                
                if (!href) {
                    console.log(`[PARSE] Row ${index}: No href found, skipping`);
                    return;
                }

                const linkMatch = href.match(/(.+)-(\d+)\.htm/);
                if (!linkMatch) {
                    console.log(`[PARSE] Row ${index}: href doesn't match pattern, skipping`);
                    return;
                }

                const title = linkElement.text().trim();
                const version = cells.eq(2).find('a').attr('title') || '';
                const year = cells.eq(4).text().trim();
                const downloads = parseInt(cells.eq(5).text().trim()) || 0;
                const langImg = cells.eq(6).find('img');
                const lang = langImg.attr('alt') || '';
                const size = parseFloat(cells.eq(8).text().trim()) || 0;
                const author = cells.eq(9).find('a').text().trim() || '';

                console.log(`[PARSE] Row ${index}: title="${title}", lang="${lang}", downloads=${downloads}`);

                // Convert language codes
                let language = lang;
                if (lang === 'CZ') language = 'Czech';
                if (lang === 'SK') language = 'Slovak';

                subtitles.push({
                    id: linkMatch[2],
                    linkFile: linkMatch[1],
                    title: title,
                    version: version,
                    year: year,
                    downloads: downloads,
                    language: language,
                    size: size,
                    author: author,
                    rating: Math.min(5, Math.floor(downloads / 100)) // Simple rating based on downloads
                });
            } catch (error) {
                console.error(`[PARSE] Parse row ${index} error:`, error.message);
            }
        });

        console.log(`[PARSE] Successfully parsed ${subtitles.length} subtitles`);
        return subtitles;
    }

    async downloadSubtitle(subtitleId, linkFile) {
        try {
            const downloadUrl = `${this.baseUrl}/idown.php?${new URLSearchParams({
                'R': Date.now().toString(),
                'titulky': subtitleId,
                'histstamp': '',
                'zip': 'z'
            })}`;

            const response = await axios.get(downloadUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'Referer': `${this.baseUrl}/${linkFile}.htm`
                }
            });

            // Check if captcha is required
            if (response.data.includes('captcha')) {
                throw new Error('Captcha required - not supported in this version');
            }

            // Extract download link and wait time
            const downloadLinkMatch = response.data.match(/id="downlink" href="([^"]+)"/);
            const waitTimeMatch = response.data.match(/CountDown\((\d+)\)/);

            if (!downloadLinkMatch) {
                throw new Error('Download link not found');
            }

            const finalUrl = `${this.baseUrl}${downloadLinkMatch[1]}`;
            const waitTime = waitTimeMatch ? parseInt(waitTimeMatch[1]) : 0;

            // Wait before downloading
            if (waitTime > 0) {
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
            }

            const fileResponse = await axios.get(finalUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'Referer': `${this.baseUrl}/idown.php`
                },
                responseType: 'arraybuffer'
            });

            return fileResponse.data;
        } catch (error) {
            console.error('Download error:', error.message);
            throw error;
        }
    }

    getCookieString() {
        return Object.entries(this.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
    }
}

// Routes
app.get('/', (req, res) => {
    const html = `
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Titulky.com Stremio Addon</title>
    <style>
        * {
            margin: 0;
            padding: 0;
            box-sizing: border-box;
        }

        body {
            font-family: 'Segoe UI', Tahoma, Geneva, Verdana, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            color: #333;
        }

        .container {
            background: rgba(255, 255, 255, 0.95);
            backdrop-filter: blur(10px);
            border-radius: 20px;
            padding: 40px;
            box-shadow: 0 20px 40px rgba(0, 0, 0, 0.1);
            max-width: 500px;
            width: 90%;
            text-align: center;
        }

        .logo {
            width: 80px;
            height: 80px;
            background: linear-gradient(45deg, #ff6b6b, #ee5a24);
            border-radius: 50%;
            margin: 0 auto 30px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 2rem;
            color: white;
            font-weight: bold;
        }

        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 2.5rem;
            font-weight: 700;
        }

        .subtitle {
            color: #666;
            margin-bottom: 40px;
            font-size: 1.1rem;
        }

        .form-group {
            margin-bottom: 25px;
            text-align: left;
        }

        label {
            display: block;
            margin-bottom: 8px;
            font-weight: 600;
            color: #555;
        }

        input {
            width: 100%;
            padding: 15px;
            border: 2px solid #e0e0e0;
            border-radius: 12px;
            font-size: 1rem;
            transition: all 0.3s ease;
            background: rgba(255, 255, 255, 0.9);
        }

        input:focus {
            outline: none;
            border-color: #667eea;
            box-shadow: 0 0 0 3px rgba(102, 126, 234, 0.1);
        }

        .btn {
            background: linear-gradient(45deg, #667eea, #764ba2);
            color: white;
            border: none;
            padding: 15px 30px;
            border-radius: 12px;
            font-size: 1.1rem;
            font-weight: 600;
            cursor: pointer;
            transition: all 0.3s ease;
            width: 100%;
            text-transform: uppercase;
            letter-spacing: 1px;
        }

        .btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.3);
        }

        .btn:disabled {
            opacity: 0.6;
            cursor: not-allowed;
            transform: none;
        }

        .result {
            margin-top: 30px;
            padding: 20px;
            border-radius: 12px;
            display: none;
        }

        .result.success {
            background: rgba(76, 175, 80, 0.1);
            border: 2px solid #4caf50;
            color: #2e7d32;
        }

        .result.error {
            background: rgba(244, 67, 54, 0.1);
            border: 2px solid #f44336;
            color: #c62828;
        }

        .install-btn {
            background: linear-gradient(45deg, #4caf50, #8bc34a);
            margin-top: 15px;
            text-decoration: none;
            display: inline-block;
            padding: 12px 25px;
            border-radius: 8px;
            color: white;
            font-weight: 600;
            transition: all 0.3s ease;
        }

        .install-btn:hover {
            transform: translateY(-2px);
            box-shadow: 0 8px 16px rgba(76, 175, 80, 0.3);
        }

        .info {
            background: rgba(33, 150, 243, 0.1);
            border: 2px solid #2196f3;
            border-radius: 12px;
            padding: 20px;
            margin-top: 30px;
            text-align: left;
        }

        .info h3 {
            color: #1976d2;
            margin-bottom: 10px;
        }

        .info ul {
            color: #333;
            line-height: 1.6;
            padding-left: 20px;
        }

        .loading {
            display: none;
            align-items: center;
            justify-content: center;
            color: #667eea;
            font-weight: 600;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">T</div>
        <h1>Titulky.com</h1>
        <p class="subtitle">Stremio Addon pro české a slovenské titulky</p>
        
        <form id="configForm">
            <div class="form-group">
                <label for="username">Uživatelské jméno:</label>
                <input type="text" id="username" name="username" required placeholder="Vaše uživatelské jméno na Titulky.com">
            </div>
            
            <div class="form-group">
                <label for="password">Heslo:</label>
                <input type="password" id="password" name="password" required placeholder="Vaše heslo">
            </div>
            
            <button type="submit" class="btn" id="submitBtn">
                Vytvořit konfiguraci
            </button>
            
            <div class="loading" id="loading">
                Ověřuji přihlašovací údaje...
            </div>
        </form>
        
        <div id="result" class="result">
            <div id="resultMessage"></div>
            <a id="installLink" class="install-btn" style="display: none;">
                Nainstalovat do Stremio
            </a>
        </div>
        
        <div class="info">
            <h3>📋 Instrukce:</h3>
            <ul>
                <li>Zadejte své přihlašovací údaje k účtu na Titulky.com</li>
                <li>Klikněte na "Vytvořit konfiguraci"</li>
                <li>Po úspěšném ověření klikněte na "Nainstalovat do Stremio"</li>
                <li>Addon bude dostupný v sekci Addons ve Stremio</li>
                <li>Titulky se automaticky zobrazí při přehrávání filmů a seriálů</li>
            </ul>
        </div>
    </div>

    <script>
        document.getElementById('configForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const submitBtn = document.getElementById('submitBtn');
            const loading = document.getElementById('loading');
            const result = document.getElementById('result');
            const resultMessage = document.getElementById('resultMessage');
            const installLink = document.getElementById('installLink');
            
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            
            // Show loading state
            submitBtn.style.display = 'none';
            loading.style.display = 'flex';
            result.style.display = 'none';
            
            try {
                const response = await fetch('/configure', {
                    method: 'POST',
                    headers: {
                        'Content-Type': 'application/json',
                    },
                    body: JSON.stringify({ username, password })
                });
                
                const data = await response.json();
                
                if (response.ok && data.success) {
                    result.className = 'result success';
                    resultMessage.innerHTML = \`
                        <strong>✅ Konfigurace úspěšně vytvořena!</strong><br>
                        <small>Config: \${data.config.substring(0, 30)}...</small><br>
                        Nyní můžete nainstalovat addon do Stremio.
                    \`;
                    installLink.href = data.installUrl;
                    installLink.style.display = 'inline-block';
                    
                    // Add test link for debugging
                    const testLink = document.createElement('a');
                    testLink.href = data.testUrl;
                    testLink.target = '_blank';
                    testLink.textContent = 'Test manifest (debug)';
                    testLink.className = 'install-btn';
                    testLink.style.backgroundColor = '#ff9800';
                    testLink.style.marginLeft = '10px';
                    resultMessage.appendChild(document.createElement('br'));
                    resultMessage.appendChild(testLink);
                } else {
                    result.className = 'result error';
                    resultMessage.innerHTML = \`
                        <strong>❌ Chyba:</strong><br>
                        \${data.error || 'Neočekávaná chyba při vytváření konfigurace'}
                    \`;
                    installLink.style.display = 'none';
                }
            } catch (error) {
                result.className = 'result error';
                resultMessage.innerHTML = \`
                    <strong>❌ Chyba spojení:</strong><br>
                    Nepodařilo se spojit se serverem. Zkuste to později.
                \`;
                installLink.style.display = 'none';
            }
            
            // Hide loading state
            submitBtn.style.display = 'block';
            loading.style.display = 'none';
            result.style.display = 'block';
        });

        document.getElementById('installLink').addEventListener('click', (e) => {
            setTimeout(() => {
                alert('Addon byl úspěšně nainstalován! Můžete jej najít v sekci "Addons" ve Stremio.');
            }, 1000);
        });
    </script>
</body>
</html>`;
    res.send(html);
});

app.get('/manifest.json', (req, res) => {
    console.log('[MANIFEST] Basic manifest requested');
    res.json(manifest);
});

app.get('/:config/manifest.json', (req, res) => {
    const config = req.params.config;
    console.log(`[MANIFEST] Configured manifest requested, config length: ${config.length}`);
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        console.log(`[MANIFEST] Config decoded for user: ${decodedConfig.username}`);
        const configuredManifest = {
            ...manifest,
            name: `${manifest.name} (${decodedConfig.username})`
        };
        res.json(configuredManifest);
    } catch (error) {
        console.error('[MANIFEST] Invalid configuration:', error.message);
        res.status(400).json({ error: 'Invalid configuration' });
    }
});

app.get('/:config/subtitles/:type/:id.json', async (req, res) => {
    const { config, type, id } = req.params;
    
    console.log(`[SUBTITLES] Request: type=${type}, id=${id}, config=${config.substring(0, 20)}...`);
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username, password } = decodedConfig;

        console.log(`[SUBTITLES] Decoded config for user: ${username}`);

        if (!username || !password) {
            console.log('[SUBTITLES] Missing credentials in config');
            return res.status(400).json({ error: 'Missing credentials' });
        }

        // Get or create client session
        let client = userSessions.get(username);
        if (!client) {
            console.log(`[SUBTITLES] No session found for ${username}, creating new session`);
            client = new TitulkyClient();
            const loginSuccess = await client.login(username, password);
            if (!loginSuccess) {
                console.log(`[SUBTITLES] Login failed for ${username}`);
                return res.status(401).json({ error: 'Login failed' });
            }
            userSessions.set(username, client);
            console.log(`[SUBTITLES] Session created for ${username}`);
        } else {
            console.log(`[SUBTITLES] Using existing session for ${username}`);
            client.lastUsed = Date.now();
        }

        // Extract IMDB ID and create search query
        const imdbId = id.replace('tt', '');
        console.log(`[SUBTITLES] IMDB ID: ${imdbId}`);
        
        // Try different search strategies
        let searchQueries = [];
        
        if (type === 'movie') {
            // For movies, search by IMDB ID first, then try generic terms
            searchQueries = [
                imdbId,
                `imdb ${imdbId}`,
                `tt${imdbId}`
            ];
        } else if (type === 'series') {
            // For series, we need episode info from the ID
            // Stremio sometimes passes series:id:season:episode format
            const idParts = id.split(':');
            if (idParts.length >= 4) {
                const [, , season, episode] = idParts;
                searchQueries = [
                    `${imdbId} S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`,
                    `imdb ${imdbId} ${season}x${episode}`,
                    imdbId
                ];
            } else {
                searchQueries = [imdbId, `imdb ${imdbId}`];
            }
        }

        console.log(`[SUBTITLES] Search queries: ${searchQueries.join(', ')}`);

        let allSubtitles = [];
        
        // Try each search query until we find results
        for (let i = 0; i < searchQueries.length; i++) {
            const query = searchQueries[i];
            console.log(`[SUBTITLES] Trying search query ${i+1}/${searchQueries.length}: "${query}"`);
            
            try {
                const subtitles = await client.searchSubtitles(query);
                
                if (subtitles.length > 0) {
                    console.log(`[SUBTITLES] SUCCESS: Found ${subtitles.length} results for query: "${query}"`);
                    allSubtitles = subtitles;
                    break;
                } else {
                    console.log(`[SUBTITLES] No results for query: "${query}"`);
                }
            } catch (searchError) {
                console.error(`[SUBTITLES] Search failed for query "${query}":`, searchError.message);
                // Continue with next query
            }
        }

        console.log(`[SUBTITLES] Total subtitles found: ${allSubtitles.length}`);
        
        const stremioSubtitles = allSubtitles.map(sub => {
            const subtitle = {
                id: `${sub.id}:${sub.linkFile}`,
                url: `${req.protocol}://${req.get('host')}/${config}/subtitle/${sub.id}/${encodeURIComponent(sub.linkFile)}.srt`,
                lang: sub.language.toLowerCase() === 'czech' ? 'cs' : 
                      sub.language.toLowerCase() === 'slovak' ? 'sk' : 'cs',
                name: `${sub.title}${sub.version ? ` (${sub.version})` : ''}${sub.author ? ` - ${sub.author}` : ''}`,
                rating: sub.rating
            };
            console.log(`[SUBTITLES] Mapped subtitle: ${subtitle.name} (${subtitle.lang})`);
            return subtitle;
        });

        console.log(`[SUBTITLES] Returning ${stremioSubtitles.length} subtitles to Stremio`);
        res.json({ subtitles: stremioSubtitles });
        
    } catch (error) {
        console.error('[SUBTITLES] Error:', error.message);
        console.error('[SUBTITLES] Stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to fetch subtitles',
            details: error.message 
        });
    }
});

app.get('/:config/subtitle/:id/:linkFile', async (req, res) => {
    const { config, id, linkFile } = req.params;
    
    console.log(`[DOWNLOAD] Request: id=${id}, linkFile=${linkFile}`);
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username } = decodedConfig;

        console.log(`[DOWNLOAD] Download request for user: ${username}`);

        const client = userSessions.get(username);
        if (!client) {
            console.log(`[DOWNLOAD] No session found for ${username}`);
            return res.status(401).json({ error: 'Session expired' });
        }

        const decodedLinkFile = decodeURIComponent(linkFile.replace('.srt', ''));
        console.log(`[DOWNLOAD] Decoded link file: ${decodedLinkFile}`);
        
        const subtitleData = await client.downloadSubtitle(id, decodedLinkFile);
        
        console.log(`[DOWNLOAD] Downloaded ${subtitleData.length} bytes`);
        
        res.set({
            'Content-Type': 'application/zip',
            'Content-Disposition': `attachment; filename="subtitle_${id}.zip"`,
            'Content-Length': subtitleData.length
        });
        res.send(subtitleData);
    } catch (error) {
        console.error('[DOWNLOAD] Error:', error.message);
        console.error('[DOWNLOAD] Stack:', error.stack);
        res.status(500).json({ 
            error: 'Failed to download subtitle',
            details: error.message 
        });
    }
});

app.post('/configure', async (req, res) => {
    const { username, password } = req.body;
    
    if (!username || !password) {
        return res.status(400).json({ error: 'Username and password required' });
    }

    // Test login before creating config
    try {
        const testClient = new TitulkyClient();
        const loginSuccess = await testClient.login(username, password);
        
        if (!loginSuccess) {
            return res.status(401).json({ error: 'Neplatné přihlašovací údaje' });
        }
        
        // Store successful session
        userSessions.set(username, testClient);
        console.log(`[CONFIGURE] Stored session for ${username}`);
        
    } catch (error) {
        console.error('Login test error:', error.message);
        return res.status(500).json({ error: 'Chyba při ověřování přihlašovacích údajů' });
    }

    const config = Buffer.from(JSON.stringify({ username, password })).toString('base64');
    
    // Create both stremio:// and https:// URLs for testing
    const baseUrl = req.get('host');
    const installUrl = `stremio://${baseUrl}/${config}/manifest.json`;
    const testUrl = `${req.protocol}://${baseUrl}/${config}/manifest.json`;
    
    console.log(`[CONFIGURE] Created config for ${username}, config: ${config.substring(0, 20)}...`);
    
    res.json({ 
        success: true, 
        installUrl,
        testUrl,
        config: config,
        message: 'Configuration created successfully'
    });
});

// Test endpoint pro ruční testování
app.get('/test/:config/:query', async (req, res) => {
    const { config, query } = req.params;
    
    console.log(`[TEST] Manual test request: query="${query}"`);
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username, password } = decodedConfig;

        let client = userSessions.get(username);
        if (!client) {
            console.log(`[TEST] Creating new session for ${username}`);
            client = new TitulkyClient();
            const loginSuccess = await client.login(username, password);
            if (!loginSuccess) {
                return res.status(401).json({ error: 'Login failed' });
            }
            userSessions.set(username, client);
        }

        const subtitles = await client.searchSubtitles(decodeURIComponent(query));
        
        res.json({
            success: true,
            query: decodeURIComponent(query),
            found: subtitles.length,
            subtitles: subtitles.slice(0, 5) // First 5 results
        });
    } catch (error) {
        console.error('[TEST] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});
app.get('/debug/:config', async (req, res) => {
    const { config } = req.params;
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username } = decodedConfig;
        
        const client = userSessions.get(username);
        const sessionExists = !!client;
        const sessionAge = client ? Date.now() - client.lastUsed : null;
        
        res.json({
            configValid: true,
            username: username,
            sessionExists: sessionExists,
            sessionAge: sessionAge,
            cookiesCount: client ? Object.keys(client.cookies).length : 0,
            totalSessions: userSessions.size
        });
    } catch (error) {
        res.json({
            configValid: false,
            error: error.message
        });
    }
});
app.get('/health', (req, res) => {
    const sessionCount = userSessions.size;
    const uptime = process.uptime();
    
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: Math.floor(uptime),
        activeSessions: sessionCount,
        version: '1.0.0'
    });
});

// Clean up expired sessions every hour
setInterval(() => {
    const oneHour = 60 * 60 * 1000;
    const now = Date.now();
    
    console.log(`[CLEANUP] Checking ${userSessions.size} sessions for cleanup`);
    
    for (const [username, session] of userSessions.entries()) {
        if (now - session.lastUsed > oneHour) {
            console.log(`[CLEANUP] Removing expired session for ${username}`);
            userSessions.delete(username);
        }
    }
    
    console.log(`[CLEANUP] ${userSessions.size} sessions remaining after cleanup`);
}, 60 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Titulky.com Stremio Addon running on port ${PORT}`);
    console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log('Debug logging enabled');
});