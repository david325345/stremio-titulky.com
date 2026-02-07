/*
STREMIO ADDON - TITULKY.COM + REAL-DEBRID
Verze 3.1.0 - S podporou přihlášení na Titulky.com
Multi-user: každý uživatel má vlastní RD klíč + Titulky.com účet
*/

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const cors = require('cors');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors({ origin: '*', methods: ['GET', 'POST', 'OPTIONS'] }));

app.use((req, res, next) => {
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.url}`);
    console.log(`${'='.repeat(80)}\n`);
    next();
});

app.use(express.json());

// Decode base64 config
function decodeConfig(base64String) {
    try {
        const config = JSON.parse(Buffer.from(base64String, 'base64').toString('utf-8'));
        console.log(`[CONFIG] User: ${config.username || 'N/A'}, RD: ${config.realDebridKey ? 'YES' : 'NO'}`);
        return config;
    } catch (error) {
        console.log(`[CONFIG] Decode failed: ${error.message}`);
        return null;
    }
}

// Real-Debrid client
class RealDebridClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
    }

    async getCurrentStream() {
        try {
            const response = await axios.get('https://api.real-debrid.com/rest/1.0/torrents', {
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                timeout: 5000,
                params: { limit: 10 }
            });

            if (response.data && response.data.length > 0) {
                const t = response.data[0];
                if (t.status === 'downloaded' || t.status === 'downloading') {
                    console.log(`[RD] ✅ ${t.filename.substring(0, 50)}...`);
                    return { filename: t.filename, quality: this.extractQuality(t.filename) };
                }
            }
            return null;
        } catch (error) {
            console.error(`[RD] Error: ${error.message}`);
            return null;
        }
    }

    extractQuality(filename) {
        const lower = filename.toLowerCase();
        if (lower.includes('bluray') || lower.includes('bdrip')) return 'bluray';
        if (lower.includes('remux')) return 'remux';
        if (lower.includes('web-dl') || lower.includes('webdl')) return 'web-dl';
        if (lower.includes('webrip')) return 'webrip';
        if (lower.includes('hdtv')) return 'hdtv';
        if (lower.includes('2160p') || lower.includes('4k')) return 'bluray';
        if (lower.includes('1080p')) return 'web-dl';
        return 'unknown';
    }
}

// Subtitle matcher
class SubtitleMatcher {
    extractSource(title) {
        const lower = title.toLowerCase();
        const sources = ['bluray', 'bdrip', 'remux', 'web-dl', 'webdl', 'webrip', 'hdtv', 'dvdrip'];
        for (const s of sources) {
            if (lower.includes(s) || lower.includes(s.replace('-', ''))) return s;
        }
        return 'unknown';
    }

    rankSubtitles(subtitles, videoSource) {
        return subtitles.map(sub => {
            const subSource = this.extractSource(sub.title);
            sub.matchScore = (videoSource === subSource) ? 100 : (videoSource !== 'unknown' && subSource !== 'unknown') ? 40 : 20;
            return sub;
        }).sort((a, b) => b.matchScore - a.matchScore);
    }
}

// Titulky.com client S PŘIHLÁŠENÍM
class TitulkyClient {
    constructor(username = null, password = null) {
        this.baseUrl = 'https://www.titulky.com';
        this.username = username;
        this.password = password;
        this.cookies = {};
        this.loggedIn = false;
    }

    getCookieString() {
        return Object.entries(this.cookies).map(([k, v]) => `${k}=${v}`).join('; ');
    }

    saveCookies(response) {
        const setCookie = response.headers['set-cookie'];
        if (setCookie) {
            setCookie.forEach(c => {
                const [pair] = c.split(';');
                const [key, value] = pair.split('=');
                if (key && value) {
                    this.cookies[key] = value;
                    console.log(`[COOKIE] ${key}`);
                }
            });
        }
    }

    async login() {
        if (!this.username || !this.password) {
            console.log('[LOGIN] ⚠️  No credentials');
            return false;
        }

        try {
            console.log(`[LOGIN] 🔐 Logging in: ${this.username}`);
            
            const formData = `Login=${encodeURIComponent(this.username)}&Password=${encodeURIComponent(this.password)}&prihlasit=Přihlásit`;
            
            const response = await axios.post(
                `${this.baseUrl}/`,
                formData,
                {
                    headers: {
                        'Content-Type': 'application/x-www-form-urlencoded',
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'cs-CZ,cs;q=0.9',
                        'Referer': this.baseUrl,
                        'Origin': this.baseUrl
                    },
                    timeout: 10000,
                    maxRedirects: 10,
                    validateStatus: (status) => status >= 200 && status < 400
                }
            );

            this.saveCookies(response);
            
            console.log(`[LOGIN] Cookies: ${Object.keys(this.cookies).join(', ')}`);
            
            // Simple success check: if we got LogonLogin and LogonId cookies, we're logged in
            if (this.cookies['LogonLogin'] && this.cookies['LogonId']) {
                console.log('[LOGIN] ✅ Success! (cookies received)');
                this.loggedIn = true;
                return true;
            }
            
            // Fallback: check HTML content
            const html = response.data || '';
            if (html.includes(this.username) || html.toLowerCase().includes('odhlásit')) {
                console.log('[LOGIN] ✅ Success! (HTML check)');
                this.loggedIn = true;
                return true;
            }
            
            console.log('[LOGIN] ❌ Failed - no login cookies');
            return false;
            
        } catch (error) {
            console.error(`[LOGIN] ❌ Error: ${error.message}`);
            return false;
        }
    }

    async searchSubtitles(query) {
        console.log(`[TITULKY] 🔍 "${query}"`);
        
        // Login if needed
        if (!this.loggedIn && this.username && this.password) {
            await this.login();
        }
        
        try {
            const searchUrl = `${this.baseUrl}/?Fulltext=${encodeURIComponent(query)}`;
            console.log(`[TITULKY] GET ${searchUrl}`);
            
            const response = await axios.get(searchUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'cs-CZ,cs;q=0.9',
                    'Referer': this.baseUrl
                },
                timeout: 10000,
                maxRedirects: 5
            });

            this.saveCookies(response);

            console.log(`[TITULKY] ${response.status}, ${response.data.length} chars`);
            console.log(`[TITULKY] Logged: ${this.loggedIn}, Has query: ${response.data.toLowerCase().includes(query.toLowerCase())}`);

            return this.parseResults(response.data);
            
        } catch (error) {
            console.error(`[TITULKY] ❌ ${error.message}`);
            return [];
        }
    }

    parseResults(html) {
        const $ = cheerio.load(html);
        const subtitles = [];

        console.log(`[PARSE] ${html.length} chars`);

        // Find all idown links
        $('a[href*="idown"]').each((i, elem) => {
            const $link = $(elem);
            const href = $link.attr('href');
            let title = $link.text().trim();
            
            if (!title || title.length < 3) {
                title = $link.parent().text().trim() || $link.closest('tr, div').text().trim();
            }
            
            if (href && title && title.length > 3) {
                const idMatch = href.match(/id[=\/]([^&\/\s]+)/i);
                if (idMatch) {
                    const url = href.startsWith('http') ? href : `${this.baseUrl}/${href.replace(/^\/+/, '')}`;
                    subtitles.push({
                        id: idMatch[1],
                        title: title.substring(0, 100).trim(),
                        url: url,
                        language: 'cs',
                        matchScore: 0
                    });
                    console.log(`[PARSE] ✅ "${title.substring(0, 50)}"`);
                }
            }
        });

        // Debug: Show some links if nothing found
        if (subtitles.length === 0) {
            console.log(`[PARSE] No idown links, showing first 5 links:`);
            $('a[href]').slice(0, 5).each((i, elem) => {
                console.log(`  ${$(elem).text().trim().substring(0, 30)} -> ${$(elem).attr('href')}`);
            });
        }

        console.log(`[PARSE] Found ${subtitles.length}`);
        return subtitles;
    }
}

const matcher = new SubtitleMatcher();

async function getMovieTitle(imdbId) {
    try {
        const r = await axios.get(`http://www.omdbapi.com/?i=tt${imdbId}&apikey=trilogy`, { timeout: 5000 });
        if (r.data?.Title && r.data.Response === 'True') {
            console.log(`[OMDB] ✅ "${r.data.Title}" (${r.data.Year})`);
            return { title: r.data.Title, year: r.data.Year };
        }
        return null;
    } catch (error) {
        console.error(`[OMDB] ❌ ${error.message}`);
        return null;
    }
}

const manifest = {
    id: 'com.titulky.subtitles',
    version: '3.1.0',
    name: 'Titulky.com + RD (Login)',
    description: 'Czech subtitles with login + Real-Debrid',
    logo: 'https://www.titulky.com/favicon.ico',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: { adult: false, p2p: false, configurable: true }
};

// Routes
app.get('/', (req, res) => res.json({ name: manifest.name, version: manifest.version }));
app.get('/manifest.json', (req, res) => res.json(manifest));
app.get('/:config/manifest.json', (req, res) => {
    const cfg = decodeConfig(req.params.config);
    res.json({ ...manifest, name: cfg?.username ? `${manifest.name} (${cfg.username})` : manifest.name });
});
app.get('/health', (req, res) => res.json({ status: 'ok', version: manifest.version }));

// Main endpoint
app.get('/:config?/subtitles/:type/:id.json', async (req, res) => {
    console.log('█'.repeat(80));
    console.log('█ SUBTITLE REQUEST');
    console.log('█'.repeat(80));
    
    try {
        const { config, type, id } = req.params;
        const { filename } = req.query;
        
        console.log(`[REQ] ${type} / ${id}`);
        
        // Decode config
        let userConfig = null;
        if (config && config !== 'subtitles') {
            userConfig = decodeConfig(config);
        }
        
        const imdbId = id.replace(/^tt/, '');
        
        // Get movie info
        const movie = await getMovieTitle(imdbId);
        if (!movie) {
            return res.json({ subtitles: [] });
        }

        // RD integration
        let videoSource = 'unknown';
        const rdKey = userConfig?.realDebridKey;
        
        if (rdKey && rdKey.length > 10) {
            const rdClient = new RealDebridClient(rdKey);
            const stream = await rdClient.getCurrentStream();
            
            if (stream) {
                videoSource = stream.quality;
            } else if (filename) {
                console.log(`[RD] Fallback: ${filename.substring(0, 50)}`);
                videoSource = rdClient.extractQuality(filename);
            }
        } else if (filename) {
            videoSource = new RealDebridClient('x').extractQuality(filename);
        }

        console.log(`[VIDEO] ${videoSource}`);

        // Search with Titulky.com credentials
        const titulky = new TitulkyClient(userConfig?.username, userConfig?.password);
        let subtitles = await titulky.searchSubtitles(movie.title);

        if (subtitles.length === 0) {
            console.log(`[RESULT] No subtitles\n`);
            return res.json({ subtitles: [] });
        }

        // Rank by quality match
        subtitles = matcher.rankSubtitles(subtitles, videoSource);

        const response = {
            subtitles: subtitles.slice(0, 10).map(s => ({
                id: s.id,
                url: s.url,
                lang: s.language,
                title: `${s.title} [${s.matchScore}%]`
            }))
        };

        console.log(`[RESULT] ✅ ${response.subtitles.length} subtitles`);
        console.log('█'.repeat(80) + '\n');
        
        res.json(response);
        
    } catch (error) {
        console.error(`[ERROR] ${error.message}`);
        res.status(500).json({ subtitles: [], error: error.message });
    }
});

app.listen(PORT, () => {
    console.log('\n🚀 Titulky.com Addon v' + manifest.version);
    console.log('📡 Port: ' + PORT);
    console.log('⚠️  REQUIRES: username + password in config');
    console.log('🔗 http://localhost:' + PORT + '/manifest.json\n');
});
