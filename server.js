/*
PACKAGE.JSON DEPENDENCIES:
{
  "name": "stremio-titulky-addon",
  "version": "1.0.0",
  "main": "index.js",
  "dependencies": {
    "express": "^4.18.2",
    "axios": "^1.4.0",
    "cheerio": "^1.0.0-rc.12",
    "cors": "^2.8.5",
    "adm-zip": "^0.5.10"
  }
}
*/

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');
const zlib = require('zlib');
const AdmZip = require('adm-zip');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({
    origin: '*',
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    credentials: false
}));

// Middleware pro logování všech požadavků
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    console.log(`[REQUEST] Headers:`, JSON.stringify(req.headers, null, 2));
    if (req.body && Object.keys(req.body).length > 0) {
        console.log(`[REQUEST] Body:`, req.body);
    }
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Store user sessions (in production, use Redis or database)
const userSessions = new Map();

// Helper function to get movie/series title from IMDB ID
async function getMovieTitle(imdbId) {
    try {
        // Use OMDB API to get movie title (free API)
        const omdbUrl = `http://www.omdbapi.com/?i=tt${imdbId}&apikey=trilogy`;
        console.log(`[OMDB] Fetching title for IMDB ${imdbId}`);
        
        const response = await axios.get(omdbUrl, { timeout: 5000 });
        
        if (response.data && response.data.Title && response.data.Response === 'True') {
            console.log(`[OMDB] Found title: "${response.data.Title}" (${response.data.Year})`);
            return {
                title: response.data.Title,
                year: response.data.Year,
                type: response.data.Type
            };
        } else {
            console.log(`[OMDB] No title found for IMDB ${imdbId}`);
            return null;
        }
    } catch (error) {
        console.error(`[OMDB] Error fetching title for IMDB ${imdbId}:`, error.message);
        return null;
    }
}

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
    catalogs: [],
    behaviorHints: {
        adult: false,
        p2p: false,
        configurable: false,
        configurationRequired: false
    }
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
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate'
                },
                timeout: 10000,
                responseType: 'arraybuffer'
            });

            console.log(`[LOGIN] Response status: ${response.status}`);
            
            // Handle compressed response
            let content;
            const contentEncoding = response.headers['content-encoding'];
            
            if (contentEncoding === 'gzip') {
                console.log('[LOGIN] Decompressing gzip content');
                content = zlib.gunzipSync(response.data).toString('utf-8');
            } else if (contentEncoding === 'deflate') {
                console.log('[LOGIN] Decompressing deflate content');
                content = zlib.inflateSync(response.data).toString('utf-8');
            } else {
                console.log('[LOGIN] No compression detected');
                content = response.data.toString('utf-8');
            }
            
            if (content.includes('BadLogin')) {
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
                console.error('[LOGIN] Response data type:', typeof error.response.data);
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
                    'Referer': this.baseUrl,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate'
                },
                timeout: 15000,
                responseType: 'arraybuffer'
            });

            console.log(`[SEARCH] Response status: ${response.status}`);
            console.log(`[SEARCH] Response headers:`, response.headers);
            
            // Handle compressed response
            let content;
            const contentEncoding = response.headers['content-encoding'];
            
            if (contentEncoding === 'gzip') {
                console.log('[SEARCH] Decompressing gzip content');
                content = zlib.gunzipSync(response.data).toString('utf-8');
            } else if (contentEncoding === 'deflate') {
                console.log('[SEARCH] Decompressing deflate content');
                content = zlib.inflateSync(response.data).toString('utf-8');
            } else {
                console.log('[SEARCH] No compression detected');
                content = response.data.toString('utf-8');
            }

            console.log(`[SEARCH] Content length: ${content.length} characters`);
            console.log(`[SEARCH] Content start: ${content.substring(0, 200)}`);

            const subtitles = this.parseSearchResults(content);
            console.log(`[SEARCH] Found ${subtitles.length} subtitles`);
            
            this.lastUsed = Date.now();
            return subtitles;
        } catch (error) {
            console.error('[SEARCH] Search error:', error.message);
            if (error.response) {
                console.error('[SEARCH] Response status:', error.response.status);
                console.error('[SEARCH] Response headers:', error.response.headers);
                console.error('[SEARCH] Response data type:', typeof error.response.data);
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
                
                // Debug: print all links in the row for first few rows
                if (index < 3) {
                    cells.each((cellIndex, cell) => {
                        const cellText = $(cell).text().trim();
                        const links = $(cell).find('a');
                        if (links.length > 0) {
                            links.each((linkIndex, link) => {
                                const href = $(link).attr('href');
                                const linkText = $(link).text().trim();
                                console.log(`[PARSE] Row ${index}, Cell ${cellIndex}, Link ${linkIndex}: href="${href}", text="${linkText}"`);
                            });
                        }
                        console.log(`[PARSE] Row ${index}, Cell ${cellIndex}: "${cellText}"`);
                    });
                }
                
                // Adjust for different table structure (8 cells instead of 9)
                if (cells.length < 8) {
                    console.log(`[PARSE] Row ${index}: Insufficient cells (${cells.length}), skipping`);
                    return;
                }

                // Find the link in any cell - search all cells for the main link
                let linkElement = null;
                let href = null;
                
                for (let i = 0; i < cells.length; i++) {
                    const cellLinks = cells.eq(i).find('a');
                    cellLinks.each((j, link) => {
                        const linkHref = $(link).attr('href');
                        if (linkHref && linkHref.includes('-') && linkHref.includes('.htm')) {
                            linkElement = $(link);
                            href = linkHref;
                            console.log(`[PARSE] Row ${index}: Found main link in cell ${i}: ${href}`);
                            return false; // Break out of each loop
                        }
                    });
                    if (href) break; // Break out of for loop
                }
                
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
                
                // Try to find other data in the cells
                let version = '';
                let year = '';
                let downloads = 0;
                let lang = '';
                let size = 0;
                let author = '';
                
                // Look for year (4 digits)
                cells.each((i, cell) => {
                    const cellText = $(cell).text().trim();
                    if (/^\d{4}$/.test(cellText)) {
                        year = cellText;
                    }
                    // Look for downloads (numbers)
                    if (/^\d{1,6}$/.test(cellText) && parseInt(cellText) > 0) {
                        downloads = Math.max(downloads, parseInt(cellText));
                    }
                    // Look for language flags
                    const langImg = $(cell).find('img');
                    if (langImg.length > 0) {
                        lang = langImg.attr('alt') || '';
                    }
                });

                console.log(`[PARSE] Row ${index}: title="${title}", lang="${lang}", downloads=${downloads}, year="${year}"`);

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
        console.log(`[DOWNLOAD] Starting download: id=${subtitleId}, linkFile=${linkFile}`);
        try {
            const downloadUrl = `${this.baseUrl}/idown.php?${new URLSearchParams({
                'R': Date.now().toString(),
                'titulky': subtitleId,
                'histstamp': '',
                'zip': 'z'
            })}`;

            console.log(`[DOWNLOAD] Download page URL: ${downloadUrl}`);

            const response = await axios.get(downloadUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'Referer': `${this.baseUrl}/${linkFile}.htm`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate'
                },
                responseType: 'arraybuffer'
            });

            // Handle compressed response
            let content;
            const contentEncoding = response.headers['content-encoding'];
            
            if (contentEncoding === 'gzip') {
                console.log('[DOWNLOAD] Decompressing gzip content');
                content = zlib.gunzipSync(response.data).toString('utf-8');
            } else if (contentEncoding === 'deflate') {
                console.log('[DOWNLOAD] Decompressing deflate content');
                content = zlib.inflateSync(response.data).toString('utf-8');
            } else {
                console.log('[DOWNLOAD] No compression detected');
                content = response.data.toString('utf-8');
            }

            console.log(`[DOWNLOAD] Content length: ${content.length}`);

            // Check if captcha is required
            if (content.includes('captcha')) {
                console.log('[DOWNLOAD] Captcha detected - daily download limit reached');
                
                // Return informational SRT instead of error
                const limitSrtContent = `1
00:00:01,000 --> 00:00:05,000
Překročili jste denní limit stažení titulků (25/den)

2
00:00:06,000 --> 00:00:10,000
Limit se resetuje následující den ve 00:00

3
00:00:11,000 --> 00:00:15,000
Zkuste to prosím zítra`;

                console.log('[DOWNLOAD] Returning limit notification SRT');
                return limitSrtContent;
            }

            // Extract download link and wait time
            const downloadLinkMatch = content.match(/id="downlink" href="([^"]+)"/);
            const waitTimeMatch = content.match(/CountDown\((\d+)\)/);

            if (!downloadLinkMatch) {
                console.log('[DOWNLOAD] Download link not found in content');
                console.log('[DOWNLOAD] Content preview:', content.substring(0, 500));
                throw new Error('Download link not found');
            }

            const finalUrl = `${this.baseUrl}${downloadLinkMatch[1]}`;
            const waitTime = waitTimeMatch ? parseInt(waitTimeMatch[1]) : 0;

            console.log(`[DOWNLOAD] Final URL: ${finalUrl}`);
            console.log(`[DOWNLOAD] Wait time: ${waitTime} seconds`);

            // Wait before downloading
            if (waitTime > 0) {
                console.log(`[DOWNLOAD] Waiting ${waitTime} seconds...`);
                await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
            }

            const fileResponse = await axios.get(finalUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'Referer': `${this.baseUrl}/idown.php`,
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
                },
                responseType: 'arraybuffer'
            });

            console.log(`[DOWNLOAD] Downloaded ${fileResponse.data.length} bytes`);
            
            // Extract SRT from ZIP archive
            try {
                console.log('[DOWNLOAD] Extracting SRT from ZIP archive');
                const zip = new AdmZip(fileResponse.data);
                const zipEntries = zip.getEntries();
                
                console.log(`[DOWNLOAD] ZIP contains ${zipEntries.length} files`);
                
                // Look for SRT file in the archive
                let srtContent = null;
                for (const entry of zipEntries) {
                    console.log(`[DOWNLOAD] Found file in ZIP: ${entry.entryName}`);
                    
                    if (entry.entryName.toLowerCase().endsWith('.srt')) {
                        console.log(`[DOWNLOAD] Extracting SRT file: ${entry.entryName}`);
                        srtContent = entry.getData().toString('utf-8');
                        break;
                    }
                }
                
                if (!srtContent) {
                    // If no SRT found, try to extract any text file
                    for (const entry of zipEntries) {
                        if (!entry.isDirectory && entry.entryName.includes('.')) {
                            console.log(`[DOWNLOAD] Extracting text file: ${entry.entryName}`);
                            srtContent = entry.getData().toString('utf-8');
                            break;
                        }
                    }
                }
                
                if (srtContent) {
                    console.log(`[DOWNLOAD] Successfully extracted SRT content (${srtContent.length} characters)`);
                    return srtContent;
                } else {
                    console.log('[DOWNLOAD] No SRT file found in ZIP archive');
                    throw new Error('No SRT file found in archive');
                }
                
            } catch (zipError) {
                console.error('[DOWNLOAD] ZIP extraction error:', zipError.message);
                console.log('[DOWNLOAD] Falling back to raw ZIP data');
                return fileResponse.data;
            }
            
        } catch (error) {
            console.error('[DOWNLOAD] Download error:', error.message);
            throw error;
        }
    }

    getCookieString() {
        return Object.entries(this.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
    }
}

// OPTIONS handler pro CORS
app.options('*', (req, res) => {
    res.set({
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
        'Access-Control-Max-Age': '86400'
    });
    res.status(200).end();
});

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
                        <br>
                        <strong>📋 Kroky pro instalaci:</strong><br>
                        1. Zkopírujte URL níže<br>
                        2. Otevřete Stremio → Settings → Addons<br>
                        3. Klikněte "Community addons"<br>
                        4. Klikněte "Add addon URL"<br>
                        5. Vložte URL (bez stremio:// prefixu)<br>
                        <br>
                        <input type="text" value="\${data.testUrl}" readonly style="width: 100%; margin: 10px 0; padding: 5px; font-size: 12px; border: 1px solid #ddd; border-radius: 4px;" onclick="this.select()">
                    \`;
                    installLink.href = data.installUrl;
                    installLink.style.display = 'inline-block';
                    installLink.textContent = 'Zkusit automatickou instalaci';
                    
                    // Add test link for debugging
                    const testLink = document.createElement('a');
                    testLink.href = data.testUrl;
                    testLink.target = '_blank';