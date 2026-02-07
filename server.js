/*
STREMIO ADDON - TITULKY.COM + REAL-DEBRID
Verze 3.0.0 - Nová implementace pro aktuální Titulky.com (2025)
Multi-user RD integrace pomocí base64 config
Hledá JEN název filmu (bez roku)
*/

const express = require('express');
const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
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

app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    console.log(`${'='.repeat(80)}\n`);
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Decode base64 config
function decodeConfig(base64String) {
    try {
        const decoded = Buffer.from(base64String, 'base64').toString('utf-8');
        const config = JSON.parse(decoded);
        console.log(`[CONFIG] ✅ User: ${config.username || 'N/A'}`);
        console.log(`[CONFIG] ✅ RD Key: ${config.realDebridKey ? 'YES' : 'NO'}`);
        return config;
    } catch (error) {
        console.log(`[CONFIG] ⚠️  Failed: ${error.message}`);
        return null;
    }
}

// Real-Debrid client
class RealDebridClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.real-debrid.com/rest/1.0';
    }

    async getCurrentStream() {
        try {
            const response = await axios.get(`${this.baseUrl}/torrents`, {
                headers: { 'Authorization': `Bearer ${this.apiKey}` },
                timeout: 5000,
                params: { limit: 10, offset: 0 }
            });

            if (response.data && response.data.length > 0) {
                const t = response.data[0];
                if (t.status === 'downloaded' || t.status === 'downloading') {
                    console.log(`[RD] ✅ ${t.filename}`);
                    return {
                        filename: t.filename,
                        size: t.bytes,
                        quality: this.extractQuality(t.filename)
                    };
                }
            }
            return null;
        } catch (error) {
            console.error(`[RD] ❌ ${error.message}`);
            return null;
        }
    }

    extractQuality(filename) {
        const patterns = {
            'bluray': ['bluray', 'blu-ray', 'bdrip'],
            'remux': ['remux'],
            'web-dl': ['web-dl', 'webdl'],
            'webrip': ['webrip'],
            'hdtv': ['hdtv'],
            'dvdrip': ['dvdrip']
        };

        const lower = filename.toLowerCase();
        for (const [quality, terms] of Object.entries(patterns)) {
            if (terms.some(t => lower.includes(t))) return quality;
        }

        if (lower.includes('2160p') || lower.includes('4k')) return 'bluray';
        if (lower.includes('1080p')) return 'web-dl';
        if (lower.includes('720p')) return 'webrip';
        return 'unknown';
    }
}

// Subtitle matcher
class SubtitleMatcher {
    extractVideoInfo(streamInfo, fallbackTitle = '') {
        let info = {
            source: 'unknown',
            originalTitle: streamInfo?.filename || fallbackTitle
        };

        if (streamInfo?.filename) {
            info.source = this.extractSource(streamInfo.filename);
        }
        
        if (info.source === 'unknown' && streamInfo?.quality) {
            info.source = streamInfo.quality;
        }

        if (info.source === 'unknown' && fallbackTitle) {
            info.source = this.extractSource(fallbackTitle);
        }

        return info;
    }

    extractSource(title) {
        const sources = ['bluray', 'bdrip', 'remux', 'web-dl', 'webdl', 'webrip', 'hdtv', 'dvdrip'];
        const lower = title.toLowerCase();
        
        for (const source of sources) {
            if (lower.includes(source) || lower.includes(source.replace('-', ''))) {
                return source;
            }
        }
        return 'unknown';
    }

    rankSubtitles(subtitles, videoInfo) {
        const ranked = subtitles.map(subtitle => {
            const subSource = this.extractSource(subtitle.title || '');
            
            let score = 20; // default
            if (videoInfo.source === subSource) {
                score = 100; // perfect match
            } else if (videoInfo.source !== 'unknown' && subSource !== 'unknown') {
                score = 40; // both known, different
            }
            
            subtitle.matchScore = score;
            return subtitle;
        });

        ranked.sort((a, b) => b.matchScore - a.matchScore);
        return ranked;
    }
}

// Titulky.com client
class TitulkyClient {
    constructor() {
        this.baseUrl = 'https://www.titulky.com';
    }

    async searchSubtitles(query) {
        console.log(`[TITULKY] 🔍 "${query}"`);
        
        try {
            // Titulky.com má formulář s POST nebo GET na /
            // Zkusíme obě varianty
            
            // Varianta 1: GET request s parametrem
            let searchUrl = `${this.baseUrl}/?Fulltext=${encodeURIComponent(query)}`;
            console.log(`[TITULKY] Try 1: ${searchUrl}`);
            
            let response = await axios.get(searchUrl, {
                headers: {
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'cs-CZ,cs;q=0.9',
                    'Referer': this.baseUrl,
                    'Connection': 'keep-alive'
                },
                timeout: 10000,
                maxRedirects: 5,
                validateStatus: (status) => status >= 200 && status < 400
            });

            console.log(`[TITULKY] Response: ${response.status}, ${response.data.length} chars`);
            
            let results = this.parseResults(response.data);
            
            // Pokud nenašlo, zkus jinou variantu
            if (results.length === 0) {
                console.log(`[TITULKY] Try 2: Different parameter format`);
                searchUrl = `${this.baseUrl}/?action=search&Fulltext=${encodeURIComponent(query)}`;
                
                response = await axios.get(searchUrl, {
                    headers: {
                        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                        'Accept-Language': 'cs-CZ,cs;q=0.9',
                        'Referer': this.baseUrl
                    },
                    timeout: 10000,
                    maxRedirects: 5
                });
                
                results = this.parseResults(response.data);
            }

            // Debug output
            console.log(`[TITULKY] HTML Preview (first 500 chars):`);
            console.log(response.data.substring(0, 500));
            console.log(`[TITULKY] HTML Preview (contains "Longlegs"): ${response.data.includes('Longlegs')}`);
            console.log(`[TITULKY] HTML Preview (contains "idown"): ${response.data.includes('idown')}`);

            return results;
            
        } catch (error) {
            console.error(`[TITULKY] ❌ ${error.message}`);
            if (error.response) {
                console.error(`[TITULKY] Status: ${error.response.status}`);
            }
            return [];
        }
    }

    parseResults(html) {
        const $ = cheerio.load(html);
        const subtitles = [];

        console.log(`[PARSE] HTML length: ${html.length} chars`);
        
        // Debug: Co všechno máme v HTML
        const linkCount = $('a').length;
        const tableCount = $('table').length;
        const divCount = $('div').length;
        
        console.log(`[PARSE] Elements: ${linkCount} links, ${tableCount} tables, ${divCount} divs`);

        // Strategie 1: Hledej všechny linky s "idown" v href
        console.log(`[PARSE] Strategy 1: Looking for idown links...`);
        $('a[href*="idown"]').each((i, elem) => {
            const $link = $(elem);
            const href = $link.attr('href');
            let title = $link.text().trim();
            
            console.log(`[PARSE] idown link found: href="${href}", text="${title}"`);
            
            // Pokud text je prázdný, podívej se na parent
            if (!title || title.length < 3) {
                title = $link.parent().text().trim();
                console.log(`[PARSE] Using parent text: "${title}"`);
            }
            
            if (href && title && title.length > 3) {
                const idMatch = href.match(/id[=\/]([^&\/\s]+)/i) || href.match(/idown\.php\?([^&\s]+)/);
                if (idMatch) {
                    const url = href.startsWith('http') ? href : `${this.baseUrl}/${href.replace(/^\/+/, '')}`;
                    subtitles.push({
                        id: idMatch[1],
                        title: title.substring(0, 100), // Limit title length
                        url: url,
                        language: 'cs',
                        matchScore: 0
                    });
                    console.log(`[PARSE] ✅ Added: "${title.substring(0, 50)}..."`);
                }
            }
        });

        // Strategie 2: Hledej tabulkové řádky s odkazy
        if (subtitles.length === 0) {
            console.log(`[PARSE] Strategy 2: Looking in table rows...`);
            $('table tr').each((i, row) => {
                const $row = $(row);
                const $link = $row.find('a').first();
                
                if ($link.length > 0) {
                    const href = $link.attr('href');
                    const title = $row.text().trim();
                    
                    if (href && href.includes('idown') && title) {
                        console.log(`[PARSE] Table row: "${title.substring(0, 50)}" -> ${href}`);
                        
                        const idMatch = href.match(/id[=\/]([^&\/\s]+)/i);
                        if (idMatch) {
                            const url = href.startsWith('http') ? href : `${this.baseUrl}/${href.replace(/^\/+/, '')}`;
                            subtitles.push({
                                id: idMatch[1],
                                title: title.substring(0, 100),
                                url: url,
                                language: 'cs',
                                matchScore: 0
                            });
                        }
                    }
                }
            });
        }

        // Strategie 3: Dump všech href pro debugging
        if (subtitles.length === 0) {
            console.log(`[PARSE] Strategy 3: Debug - showing all hrefs...`);
            let count = 0;
            $('a[href]').each((i, elem) => {
                if (count < 10) { // Jen prvních 10
                    const href = $(elem).attr('href');
                    const text = $(elem).text().trim();
                    console.log(`[PARSE DEBUG] Link ${i}: "${text.substring(0, 30)}" -> ${href}`);
                    count++;
                }
            });
        }

        console.log(`[TITULKY] Found: ${subtitles.length} subtitles`);
        return subtitles;
    }
}

const subtitleMatcher = new SubtitleMatcher();

async function getMovieTitle(imdbId) {
    try {
        const response = await axios.get(`http://www.omdbapi.com/?i=tt${imdbId}&apikey=trilogy`, { timeout: 5000 });
        
        if (response.data?.Title && response.data.Response === 'True') {
            console.log(`[OMDB] ✅ "${response.data.Title}" (${response.data.Year})`);
            return {
                title: response.data.Title,
                year: response.data.Year,
                type: response.data.Type
            };
        }
        return null;
    } catch (error) {
        console.error(`[OMDB] ❌ ${error.message}`);
        return null;
    }
}

const baseManifest = {
    id: 'com.titulky.subtitles',
    version: '3.0.0',
    name: 'Titulky.com + RD',
    description: 'Czech subtitles with Real-Debrid',
    logo: 'https://www.titulky.com/favicon.ico',
    resources: ['subtitles'],
    types: ['movie', 'series'],
    idPrefixes: ['tt'],
    catalogs: [],
    behaviorHints: {
        adult: false,
        p2p: false,
        configurable: true,
        configurationRequired: false
    }
};

// Routes
app.get('/', (req, res) => {
    res.json({ name: baseManifest.name, version: baseManifest.version, status: 'OK' });
});

app.get('/manifest.json', (req, res) => {
    res.json(baseManifest);
});

app.get('/:config/manifest.json', (req, res) => {
    const config = decodeConfig(req.params.config);
    res.json({
        ...baseManifest,
        name: config?.username ? `${baseManifest.name} (${config.username})` : baseManifest.name
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', version: baseManifest.version });
});

// Main endpoint
app.get('/:config?/subtitles/:type/:id.json', async (req, res) => {
    console.log('█'.repeat(80));
    console.log('█ SUBTITLE REQUEST');
    console.log('█'.repeat(80));
    
    try {
        const { config, type, id } = req.params;
        const { filename } = req.query;
        
        console.log(`[INFO] ${type} / tt${id.replace(/^tt/, '')}`);
        console.log(`[INFO] Filename: ${filename || 'N/A'}`);
        
        // Decode config
        let userConfig = null;
        if (config && config !== 'subtitles') {
            userConfig = decodeConfig(config);
        }
        
        const imdbId = id.replace(/^tt/, '');
        
        // Get movie info
        const movieInfo = await getMovieTitle(imdbId);
        if (!movieInfo) {
            return res.json({ subtitles: [] });
        }

        // RD integration
        let streamInfo = null;
        const rdApiKey = userConfig?.realDebridKey;
        
        if (rdApiKey && rdApiKey.length > 10) {
            console.log(`[RD] Checking...`);
            const rdClient = new RealDebridClient(rdApiKey);
            streamInfo = await rdClient.getCurrentStream();
            
            if (!streamInfo && filename) {
                console.log(`[RD] Fallback to filename`);
                streamInfo = {
                    filename: filename,
                    size: 0,
                    quality: rdClient.extractQuality(filename)
                };
            }
        } else if (filename) {
            const rdClient = new RealDebridClient('dummy');
            streamInfo = {
                filename: filename,
                size: 0,
                quality: rdClient.extractQuality(filename)
            };
        }

        // Video info
        const videoInfo = subtitleMatcher.extractVideoInfo(streamInfo, movieInfo.title);
        console.log(`[VIDEO] ${videoInfo.source}`);

        // Search - JEN NÁZEV
        const titulkyClient = new TitulkyClient();
        let subtitles = await titulkyClient.searchSubtitles(movieInfo.title);

        if (subtitles.length === 0) {
            console.log(`[RESULT] No subtitles\n`);
            return res.json({ subtitles: [] });
        }

        // Rank
        subtitles = subtitleMatcher.rankSubtitles(subtitles, videoInfo);

        // Response
        const response = {
            subtitles: subtitles.slice(0, 10).map(sub => ({
                id: sub.id,
                url: sub.url,
                lang: sub.language,
                title: `${sub.title} [${sub.matchScore}%]`
            }))
        };

        console.log(`[RESULT] ${response.subtitles.length} subtitles`);
        console.log('█'.repeat(80) + '\n');
        
        res.json(response);
        
    } catch (error) {
        console.error(`[ERROR] ${error.message}`);
        res.status(500).json({ subtitles: [], error: error.message });
    }
});

app.listen(PORT, () => {
    console.log('\n🚀 Titulky.com Addon v' + baseManifest.version);
    console.log('📡 Port: ' + PORT);
    console.log('🔗 http://localhost:' + PORT + '/manifest.json\n');
});
