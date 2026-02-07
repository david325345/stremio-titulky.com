/*
STREMIO ADDON - TITULKY.COM + REAL-DEBRID
Verze 2.3.0 - Správná podpora Stremio konfigurace (base64)

URL format: /{base64Config}/subtitles/{type}/{id}.json
Base64 obsahuje: {"username":"...","password":"...","realDebridKey":"..."}
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

// ENHANCED LOGGING MIDDLEWARE
app.use((req, res, next) => {
    const timestamp = new Date().toISOString();
    console.log(`\n${'='.repeat(80)}`);
    console.log(`[${timestamp}] ${req.method} ${req.url}`);
    console.log(`[FULL URL] ${req.protocol}://${req.get('host')}${req.originalUrl}`);
    console.log(`[PATH] ${req.path}`);
    console.log(`${'='.repeat(80)}\n`);
    next();
});

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Helper to decode base64 config
function decodeConfig(base64String) {
    try {
        const decoded = Buffer.from(base64String, 'base64').toString('utf-8');
        const config = JSON.parse(decoded);
        console.log(`[CONFIG] ✅ Decoded successfully`);
        console.log(`[CONFIG] Username: ${config.username || 'N/A'}`);
        console.log(`[CONFIG] Has RD Key: ${config.realDebridKey ? 'YES (' + config.realDebridKey.substring(0, 12) + '...)' : 'NO'}`);
        return config;
    } catch (error) {
        console.log(`[CONFIG] ⚠️  Failed to decode: ${error.message}`);
        return null;
    }
}

// Real-Debrid API class
class RealDebridClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.real-debrid.com/rest/1.0';
        console.log(`[RD CLIENT] Created with key: ${apiKey ? apiKey.substring(0, 12) + '...' : 'NONE'}`);
    }

    async getCurrentStream() {
        try {
            console.log('[RD] 📡 Fetching current streaming info...');
            console.log(`[RD] 🔑 Using API key: ${this.apiKey.substring(0, 12)}...`);
            
            // Real-Debrid doesn't have a "currently streaming" endpoint
            // We'll try to get active torrents instead
            const response = await axios.get(`${this.baseUrl}/torrents`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                },
                timeout: 5000,
                params: {
                    limit: 10,
                    offset: 0
                }
            });

            console.log(`[RD] ✅ API Response status: ${response.status}`);
            console.log(`[RD] 📊 Total torrents: ${response.data?.length || 0}`);

            if (response.data && response.data.length > 0) {
                // Find most recent torrent (sorted by date by default)
                const recentTorrent = response.data[0];
                
                console.log(`[RD] 🎬 Most recent torrent: ${recentTorrent.filename}`);
                console.log(`[RD] 📊 Status: ${recentTorrent.status}`);
                console.log(`[RD] 📦 Size: ${(recentTorrent.bytes / 1024 / 1024 / 1024).toFixed(2)} GB`);
                
                // Only use if it's downloaded or downloading
                if (recentTorrent.status === 'downloaded' || recentTorrent.status === 'downloading') {
                    return {
                        filename: recentTorrent.filename,
                        link: recentTorrent.links?.[0] || null,
                        size: recentTorrent.bytes,
                        quality: this.extractQualityFromFilename(recentTorrent.filename)
                    };
                } else {
                    console.log(`[RD] ⚠️  Torrent status is "${recentTorrent.status}", not using for matching`);
                }
            }

            console.log('[RD] ℹ️  No suitable torrents found for matching');
            return null;
        } catch (error) {
            console.error('[RD] ❌ Error fetching torrent info:', error.message);
            if (error.response) {
                console.error(`[RD] ❌ Response status: ${error.response.status}`);
                console.error(`[RD] ❌ Response data:`, error.response.data);
            }
            return null;
        }
    }

    extractQualityFromFilename(filename) {
        const qualityPatterns = {
            'bluray': ['bluray', 'blu-ray', 'bdrip', 'bd-rip', 'brrip', 'br-rip'],
            'remux': ['remux'],
            'web-dl': ['web-dl', 'webdl', 'web.dl'],
            'webrip': ['webrip', 'web-rip', 'web.rip'],
            'hdtv': ['hdtv', 'hdtvrip'],
            'dvdrip': ['dvdrip', 'dvd-rip'],
            'cam': ['cam', 'hdcam', 'hd-cam', 'camrip'],
            'ts': ['ts', 'hdts', 'hd-ts', 'telesync']
        };

        const filenameLower = filename.toLowerCase();
        
        for (const [quality, patterns] of Object.entries(qualityPatterns)) {
            if (patterns.some(pattern => filenameLower.includes(pattern))) {
                console.log(`[RD] 🎯 Detected quality from filename: ${quality}`);
                return quality;
            }
        }

        if (filenameLower.includes('2160p') || filenameLower.includes('4k')) {
            return 'bluray';
        } else if (filenameLower.includes('1080p')) {
            return 'web-dl';
        } else if (filenameLower.includes('720p')) {
            return 'webrip';
        }

        return 'unknown';
    }
}

// Enhanced subtitle matching system
class SubtitleMatcher {
    constructor() {
        this.sourcePriority = {
            'bluray': 100,
            'bdrip': 95,
            'remux': 90,
            'web-dl': 85,
            'webdl': 85,
            'webrip': 80,
            'hdtv': 75,
            'dvdrip': 70,
            'dvdscr': 65,
            'hdcam': 30,
            'cam': 25,
            'ts': 20
        };

        this.specialEditions = [
            'extended', 'director', 'directors', 'special', 'edition', 'cut',
            'uncut', 'unrated', 'theatrical', 'ultimate', 'remastered'
        ];
    }

    estimateQualityFromSize(sizeInBytes) {
        const sizeInGB = sizeInBytes / (1024 * 1024 * 1024);
        console.log(`[MATCHER] 📏 Estimating quality from size: ${sizeInGB.toFixed(2)} GB`);

        if (sizeInGB >= 50) return 'remux';
        if (sizeInGB >= 25) return 'bluray';
        if (sizeInGB >= 10) return 'web-dl';
        if (sizeInGB >= 4) return 'webrip';
        if (sizeInGB >= 2) return 'hdtv';
        return 'dvdrip';
    }

    extractVideoInfo(streamInfo, fallbackTitle = '') {
        console.log(`[MATCHER] 🔍 Analyzing stream info...`);
        
        let info = {
            source: 'unknown',
            specialEdition: null,
            originalTitle: streamInfo?.filename || fallbackTitle
        };

        if (streamInfo?.filename) {
            info.source = this.extractSource(streamInfo.filename);
            info.specialEdition = this.extractSpecialEdition(streamInfo.filename);
            console.log(`[MATCHER] ✅ Extracted from RD filename: source=${info.source}, edition=${info.specialEdition}`);
        }
        
        if (info.source === 'unknown' && streamInfo?.quality && streamInfo.quality !== 'unknown') {
            info.source = streamInfo.quality;
            console.log(`[MATCHER] ✅ Using RD detected quality: ${info.source}`);
        }

        if (info.source === 'unknown' && streamInfo?.size) {
            info.source = this.estimateQualityFromSize(streamInfo.size);
            console.log(`[MATCHER] ✅ Using size-based estimate: ${info.source}`);
        }

        if (info.source === 'unknown' && fallbackTitle) {
            info.source = this.extractSource(fallbackTitle);
            info.specialEdition = this.extractSpecialEdition(fallbackTitle);
            console.log(`[MATCHER] ⚠️  Fallback extraction from title: source=${info.source}`);
        }

        return info;
    }

    extractSource(title) {
        const sources = ['bluray', 'bdrip', 'remux', 'web-dl', 'webdl', 'webrip', 'hdtv', 'dvdrip', 'dvdscr', 'hdcam', 'cam', 'ts'];
        const titleLower = title.toLowerCase();
        
        for (const source of sources) {
            if (titleLower.includes(source) || titleLower.includes(source.replace('-', ''))) {
                return source;
            }
        }
        return 'unknown';
    }

    extractSpecialEdition(title) {
        const titleLower = title.toLowerCase();
        
        for (const edition of this.specialEditions) {
            if (titleLower.includes(edition)) {
                if (titleLower.includes('extended') && titleLower.includes('cut')) {
                    return 'extended-cut';
                }
                if (titleLower.includes('director') && (titleLower.includes('cut') || titleLower.includes('edition'))) {
                    return 'directors-cut';
                }
                return edition;
            }
        }
        return null;
    }

    calculateCompatibilityScore(videoInfo, subtitleInfo) {
        let score = 0;

        if (videoInfo.source === subtitleInfo.source) {
            score = 100;
        } else if (this.areSourcesCompatible(videoInfo.source, subtitleInfo.source)) {
            score = 80;
        } else if (videoInfo.source !== 'unknown' && subtitleInfo.source !== 'unknown') {
            score = 40;
        } else {
            score = 20;
        }

        return score;
    }

    areSourcesCompatible(source1, source2) {
        const compatible = {
            'bluray': ['bdrip', 'remux'],
            'bdrip': ['bluray', 'remux'],
            'remux': ['bluray', 'bdrip'],
            'web-dl': ['webdl', 'webrip'],
            'webdl': ['web-dl', 'webrip'],
            'webrip': ['web-dl', 'webdl']
        };

        return compatible[source1]?.includes(source2) || false;
    }

    rankSubtitles(subtitles, videoInfo, movieTitle = '') {
        console.log(`[MATCHER] 🏆 Ranking ${subtitles.length} subtitles for video: ${videoInfo.source}`);

        const ranked = subtitles.map(subtitle => {
            const subtitleInfo = {
                source: this.extractSource(subtitle.title || subtitle.videoVersion || ''),
                originalTitle: subtitle.title
            };

            let score = this.calculateCompatibilityScore(videoInfo, subtitleInfo);
            
            subtitle.matchScore = score;
            subtitle.matchReason = `Source match: ${score}%`;

            return subtitle;
        });

        ranked.sort((a, b) => b.matchScore - a.matchScore);

        console.log(`[MATCHER] 📋 Top 3 ranked subtitles:`);
        ranked.slice(0, 3).forEach((sub, idx) => {
            console.log(`  ${idx + 1}. ${sub.title} - Score: ${sub.matchScore}%`);
        });

        return ranked;
    }
}

// Titulky.com client
class TitulkyClient {
    constructor() {
        this.baseUrl = 'https://www.titulky.com';
        this.cookies = {};
        this.lastUsed = Date.now();
        this.captchaDetected = false;
    }

    getCookieString() {
        return Object.entries(this.cookies)
            .map(([key, value]) => `${key}=${value}`)
            .join('; ');
    }

    async searchSubtitles(query) {
        console.log(`[TITULKY] 🔍 Searching for: "${query}"`);
        
        try {
            const searchUrl = `${this.baseUrl}/hledej.php?action=search&searchstring=${encodeURIComponent(query)}`;
            
            const response = await axios.get(searchUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': this.baseUrl,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.5'
                },
                timeout: 10000,
                responseType: 'arraybuffer'
            });

            let content;
            const contentEncoding = response.headers['content-encoding'];
            
            if (contentEncoding === 'gzip') {
                content = zlib.gunzipSync(response.data).toString('utf-8');
            } else if (contentEncoding === 'deflate') {
                content = zlib.inflateSync(response.data).toString('utf-8');
            } else {
                content = response.data.toString('utf-8');
            }

            if (content.toLowerCase().includes('captcha') || content.toLowerCase().includes('recaptcha')) {
                console.log('[TITULKY] ⚠️  CAPTCHA detected!');
                this.captchaDetected = true;
                return [];
            }

            return this.parseSearchResults(content);
            
        } catch (error) {
            console.error(`[TITULKY] ❌ Search error:`, error.message);
            return [];
        }
    }

    parseSearchResults(html) {
        const $ = cheerio.load(html);
        const subtitles = [];

        $('table tr').each((index, element) => {
            const $row = $(element);
            const $link = $row.find('a[href*="idown.php"]');
            
            if ($link.length > 0) {
                const href = $link.attr('href');
                const title = $link.text().trim();
                
                const match = href.match(/id=([^&]+)/);
                if (match) {
                    const downloadId = match[1];
                    
                    subtitles.push({
                        id: downloadId,
                        title: title,
                        url: `${this.baseUrl}/${href}`,
                        language: 'cs',
                        matchScore: 0
                    });
                }
            }
        });

        console.log(`[TITULKY] ✅ Found ${subtitles.length} subtitles`);
        return subtitles;
    }
}

// Initialize matcher
const subtitleMatcher = new SubtitleMatcher();

// Helper function to get movie title from IMDB ID
async function getMovieTitle(imdbId) {
    try {
        const omdbUrl = `http://www.omdbapi.com/?i=tt${imdbId}&apikey=trilogy`;
        console.log(`[OMDB] 📡 Fetching title for IMDB tt${imdbId}`);
        
        const response = await axios.get(omdbUrl, { timeout: 5000 });
        
        if (response.data && response.data.Title && response.data.Response === 'True') {
            console.log(`[OMDB] ✅ Found: "${response.data.Title}" (${response.data.Year})`);
            return {
                title: response.data.Title,
                year: response.data.Year,
                type: response.data.Type
            };
        }
        
        console.log(`[OMDB] ❌ No title found`);
        return null;
    } catch (error) {
        console.error(`[OMDB] ❌ Error:`, error.message);
        return null;
    }
}

// Addon manifest (base - without config)
const baseManifest = {
    id: 'com.titulky.subtitles',
    version: '2.3.0',
    name: 'Titulky.com + RD',
    description: 'Czech subtitles with Real-Debrid integration',
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
    res.json({
        name: baseManifest.name,
        version: baseManifest.version,
        description: baseManifest.description,
        status: 'OK',
        endpoints: {
            manifest_basic: '/manifest.json',
            manifest_configured: '/{base64config}/manifest.json',
            subtitles: '/{base64config}/subtitles/{type}/{id}.json'
        },
        config_format: {
            username: 'optional',
            password: 'optional',
            realDebridKey: 'your_rd_api_key_here'
        }
    });
});

// Manifest without config
app.get('/manifest.json', (req, res) => {
    console.log('[MANIFEST] Serving basic manifest.json');
    res.json(baseManifest);
});

// Manifest with config
app.get('/:config/manifest.json', (req, res) => {
    console.log('[MANIFEST] Serving configured manifest.json');
    const config = decodeConfig(req.params.config);
    
    const manifest = {
        ...baseManifest,
        name: config?.username ? `${baseManifest.name} (${config.username})` : baseManifest.name
    };
    
    res.json(manifest);
});

app.get('/health', (req, res) => {
    res.json({ 
        status: 'ok', 
        timestamp: new Date().toISOString(),
        version: baseManifest.version
    });
});

// MAIN SUBTITLE ENDPOINT - Supports both with and without config
app.get('/:config?/subtitles/:type/:id.json', async (req, res) => {
    console.log('\n' + '█'.repeat(80));
    console.log('█ SUBTITLE REQUEST STARTED');
    console.log('█'.repeat(80));
    
    try {
        const { config, type, id } = req.params;
        const { filename } = req.query;
        
        console.log(`[PARAMS] Config: ${config ? 'PROVIDED' : 'NOT PROVIDED'}`);
        console.log(`[PARAMS] Type: ${type}`);
        console.log(`[PARAMS] ID: ${id}`);
        console.log(`[QUERY] Filename: ${filename || 'N/A'}`);
        
        // Decode config if provided
        let userConfig = null;
        if (config && config !== 'subtitles') {
            userConfig = decodeConfig(config);
        }
        
        // Remove 'tt' prefix if present
        const imdbId = id.replace(/^tt/, '');
        console.log(`[IMDB] Clean ID: tt${imdbId}`);
        
        // Get movie title
        const movieInfo = await getMovieTitle(imdbId);
        if (!movieInfo) {
            console.log(`[ERROR] ❌ Could not fetch movie info for tt${imdbId}`);
            return res.json({ subtitles: [] });
        }

        console.log(`[MOVIE] 🎬 "${movieInfo.title}" (${movieInfo.year})`);

        // Initialize titulky client
        const titulkyClient = new TitulkyClient();
        
        // Get current stream info from Real-Debrid
        let streamInfo = null;
        const rdApiKey = userConfig?.realDebridKey;
        
        if (rdApiKey && rdApiKey.length > 10) {
            console.log(`\n[RD INTEGRATION] 🔐 Attempting to use Real-Debrid...`);
            console.log(`[RD] User: ${userConfig?.username || 'anonymous'}`);
            const rdClient = new RealDebridClient(rdApiKey);
            streamInfo = await rdClient.getCurrentStream();
            
            if (streamInfo) {
                console.log(`[RD] ✅ SUCCESS! Stream detected`);
                console.log(`[RD] 🎬 File: ${streamInfo.filename}`);
                console.log(`[RD] 🎯 Quality: ${streamInfo.quality}`);
                console.log(`[RD] 📦 Size: ${(streamInfo.size / 1024 / 1024 / 1024).toFixed(2)} GB`);
            } else {
                console.log(`[RD] ℹ️  No active stream (user not currently watching)`);
            }
        } else {
            console.log(`\n[RD INTEGRATION] ⚠️  SKIPPED - No valid API key in config`);
        }

        // Extract video info for matching
        const videoInfo = subtitleMatcher.extractVideoInfo(streamInfo, movieInfo.title);
        console.log(`\n[VIDEO INFO] Source: ${videoInfo.source}`);
        console.log(`[VIDEO INFO] Special Edition: ${videoInfo.specialEdition || 'none'}`);

        // Search for subtitles
        const searchQuery = `${movieInfo.title} ${movieInfo.year}`;
        console.log(`\n[SEARCH] Query: "${searchQuery}"`);
        
        let subtitles = await titulkyClient.searchSubtitles(searchQuery);

        if (subtitles.length === 0) {
            console.log(`[SEARCH] ⚠️  No subtitles found`);
            console.log('█'.repeat(80) + '\n');
            return res.json({ subtitles: [] });
        }

        // Rank subtitles based on video info
        subtitles = subtitleMatcher.rankSubtitles(subtitles, videoInfo, movieInfo.title);

        // Format response for Stremio
        const response = {
            subtitles: subtitles.slice(0, 10).map((sub, index) => ({
                id: sub.id,
                url: sub.url,
                lang: sub.language,
                title: `${sub.title} [${sub.matchScore}%]`
            }))
        };

        console.log(`\n[RESPONSE] ✅ Returning ${response.subtitles.length} subtitles`);
        console.log('█'.repeat(80));
        console.log('█ REQUEST COMPLETED SUCCESSFULLY');
        console.log('█'.repeat(80) + '\n');
        
        res.json(response);
        
    } catch (error) {
        console.error(`\n[ERROR] ❌❌❌ ${error.message}`);
        console.error(error.stack);
        console.log('█'.repeat(80) + '\n');
        res.status(500).json({ 
            subtitles: [],
            error: error.message 
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log('\n' + '🚀'.repeat(40));
    console.log(`🚀 Titulky.com Addon Server v${baseManifest.version}`);
    console.log('🚀'.repeat(40));
    console.log(`📡 Port: ${PORT}`);
    console.log(`🔗 Manifest: http://localhost:${PORT}/manifest.json`);
    console.log(`\n📖 USAGE WITH STREMIO CONFIG:`);
    console.log(`   1. User installs addon with their RD API key`);
    console.log(`   2. Stremio sends config as base64 in URL`);
    console.log(`   3. Format: /{base64}/subtitles/movie/tt1234567.json`);
    console.log(`   4. Each user has their own config = their own RD key!`);
    console.log('🚀'.repeat(40) + '\n');
});
