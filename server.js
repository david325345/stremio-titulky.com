/*
PACKAGE.JSON DEPENDENCIES:
{
  "name": "stremio-titulky-addon",
  "version": "2.1.0",
  "main": "index.js",
  "dependencies": {
    "express": "^4.18.2",
    "axios": "^1.4.0",
    "cheerio": "^1.0.0-rc.12",
    "cors": "^2.8.5",
    "adm-zip": "^0.5.10",
    "iconv-lite": "^0.6.3"
  }
}

OPRAVA: API klíč se nyní správně extrahuje z URL parametru pro každého uživatele
Format URL: /subtitles/:type/:id/:rdApiKey.json
Příklad: /subtitles/movie/tt1234567/YOUR_RD_API_KEY.json
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

// Real-Debrid API class
class RealDebridClient {
    constructor(apiKey) {
        this.apiKey = apiKey;
        this.baseUrl = 'https://api.real-debrid.com/rest/1.0';
    }

    async getCurrentStream() {
        try {
            console.log('[RD] Fetching current streaming info');
            
            const response = await axios.get(`${this.baseUrl}/streaming/active`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                },
                timeout: 5000
            });

            if (response.data && response.data.length > 0) {
                const activeStream = response.data[0];
                console.log(`[RD] Active stream found: ${activeStream.filename}`);
                return {
                    filename: activeStream.filename,
                    link: activeStream.link,
                    size: activeStream.filesize,
                    quality: this.extractQualityFromFilename(activeStream.filename)
                };
            }

            console.log('[RD] No active streams found');
            return null;
        } catch (error) {
            console.error('[RD] Error fetching stream info:', error.message);
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
                console.log(`[RD] Detected quality from filename: ${quality}`);
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
        console.log(`[MATCHER] Estimating quality from size: ${sizeInGB.toFixed(2)} GB`);

        if (sizeInGB >= 50) return 'remux';
        if (sizeInGB >= 25) return 'bluray';
        if (sizeInGB >= 10) return 'web-dl';
        if (sizeInGB >= 4) return 'webrip';
        if (sizeInGB >= 2) return 'hdtv';
        return 'dvdrip';
    }

    extractVideoInfo(streamInfo, fallbackTitle = '') {
        console.log(`[MATCHER] Analyzing stream info:`, streamInfo);
        
        let info = {
            source: 'unknown',
            specialEdition: null,
            originalTitle: streamInfo?.filename || fallbackTitle
        };

        if (streamInfo?.filename) {
            info.source = this.extractSource(streamInfo.filename);
            info.specialEdition = this.extractSpecialEdition(streamInfo.filename);
            console.log(`[MATCHER] Extracted from RD filename: source=${info.source}, edition=${info.specialEdition}`);
        }
        
        if (info.source === 'unknown' && streamInfo?.quality && streamInfo.quality !== 'unknown') {
            info.source = streamInfo.quality;
            console.log(`[MATCHER] Using RD detected quality: ${info.source}`);
        }

        if (info.source === 'unknown' && streamInfo?.size) {
            info.source = this.estimateQualityFromSize(streamInfo.size);
            console.log(`[MATCHER] Using size-based estimate: ${info.source}`);
        }

        if (info.source === 'unknown' && fallbackTitle) {
            info.source = this.extractSource(fallbackTitle);
            info.specialEdition = this.extractSpecialEdition(fallbackTitle);
            console.log(`[MATCHER] Fallback extraction from title: source=${info.source}`);
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
        console.log(`[MATCHER] Comparing video source "${videoInfo.source}" with subtitle source "${subtitleInfo.source}"`);

        let score = 0;

        if (videoInfo.source === subtitleInfo.source) {
            console.log(`[MATCHER] Perfect source match: 100%`);
            score = 100;
        } else if (this.areSourcesCompatible(videoInfo.source, subtitleInfo.source)) {
            console.log(`[MATCHER] Compatible sources: 80%`);
            score = 80;
        } else if (videoInfo.source !== 'unknown' && subtitleInfo.source !== 'unknown') {
            console.log(`[MATCHER] Different known sources: 40%`);
            score = 40;
        } else {
            console.log(`[MATCHER] Unknown source: 20%`);
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
        console.log(`[MATCHER] Ranking ${subtitles.length} subtitles for video: ${videoInfo.source}`);

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

        console.log(`[MATCHER] Top 3 ranked subtitles:`);
        ranked.slice(0, 3).forEach((sub, idx) => {
            console.log(`  ${idx + 1}. ${sub.title} - Score: ${sub.matchScore}% (${sub.matchReason})`);
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
        console.log(`[TITULKY] Searching for: "${query}"`);
        
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
                console.log('[TITULKY] CAPTCHA detected!');
                this.captchaDetected = true;
                return [];
            }

            return this.parseSearchResults(content);
            
        } catch (error) {
            console.error(`[TITULKY] Search error:`, error.message);
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

        console.log(`[TITULKY] Found ${subtitles.length} subtitles`);
        return subtitles;
    }

    async downloadSubtitle(url) {
        console.log(`[TITULKY] Downloading subtitle from: ${url}`);
        
        try {
            const response = await axios.get(url, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': this.baseUrl
                },
                responseType: 'arraybuffer',
                timeout: 15000
            });

            return this.extractSrtFromArchive(response.data);
            
        } catch (error) {
            console.error(`[TITULKY] Download error:`, error.message);
            return null;
        }
    }

    extractSrtFromArchive(buffer) {
        try {
            const zip = new AdmZip(buffer);
            const zipEntries = zip.getEntries();

            for (const entry of zipEntries) {
                if (entry.entryName.toLowerCase().endsWith('.srt')) {
                    console.log(`[TITULKY] Found SRT file: ${entry.entryName}`);
                    const content = entry.getData();
                    
                    // Try UTF-8 first
                    let text = content.toString('utf-8');
                    
                    // If contains weird characters, try windows-1250
                    if (text.includes('�') || text.includes('\ufffd')) {
                        text = iconv.decode(content, 'windows-1250');
                    }
                    
                    return text;
                }
            }

            console.log('[TITULKY] No SRT file found in archive');
            return null;
            
        } catch (error) {
            console.error(`[TITULKY] Error extracting SRT:`, error.message);
            return null;
        }
    }
}

// Initialize matcher
const subtitleMatcher = new SubtitleMatcher();

// Helper function to get movie title from IMDB ID
async function getMovieTitle(imdbId) {
    try {
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
        }
        
        return null;
    } catch (error) {
        console.error(`[OMDB] Error:`, error.message);
        return null;
    }
}

// Addon manifest
const manifest = {
    id: 'com.titulky.subtitles',
    version: '2.1.0',
    name: 'Titulky.com Subtitles + RD',
    description: 'Czech and Slovak subtitles from Titulky.com with Real-Debrid integration',
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
        name: manifest.name,
        version: manifest.version,
        description: manifest.description,
        endpoints: {
            manifest: '/manifest.json',
            subtitles: '/subtitles/:type/:id.json (without RD)',
            subtitlesWithRD: '/subtitles/:type/:id/:rdApiKey.json (with RD integration)'
        }
    });
});

app.get('/manifest.json', (req, res) => {
    res.json(manifest);
});

app.get('/health', (req, res) => {
    res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// OPRAVENÝ ENDPOINT - správně extrahuje API klíč z URL
app.get('/subtitles/:type/:id/:rdApiKey?.json', async (req, res) => {
    try {
        const { type, id, rdApiKey } = req.params;
        
        // Remove 'tt' prefix if present
        const imdbId = id.replace(/^tt/, '');
        
        console.log(`\n========== NEW SUBTITLE REQUEST ==========`);
        console.log(`[REQUEST] Type: ${type}, IMDB: tt${imdbId}`);
        console.log(`[REQUEST] RD API Key provided: ${rdApiKey ? 'YES (' + rdApiKey.substring(0, 8) + '...)' : 'NO'}`);
        
        // Get movie title
        const movieInfo = await getMovieTitle(imdbId);
        if (!movieInfo) {
            console.log(`[ERROR] Could not fetch movie info for tt${imdbId}`);
            return res.json({ subtitles: [] });
        }

        console.log(`[INFO] Movie: "${movieInfo.title}" (${movieInfo.year})`);

        // Initialize titulky client
        const titulkyClient = new TitulkyClient();
        
        // Get current stream info from Real-Debrid (if API key provided)
        let streamInfo = null;
        if (rdApiKey && rdApiKey.length > 10) {
            console.log(`[RD] Creating client with API key: ${rdApiKey.substring(0, 8)}...`);
            const rdClient = new RealDebridClient(rdApiKey);
            streamInfo = await rdClient.getCurrentStream();
            
            if (streamInfo) {
                console.log(`[RD] Stream detected: ${streamInfo.filename}`);
                console.log(`[RD] Quality: ${streamInfo.quality}, Size: ${(streamInfo.size / 1024 / 1024 / 1024).toFixed(2)} GB`);
            } else {
                console.log(`[RD] No active stream found`);
            }
        } else {
            console.log(`[RD] No API key provided, skipping RD integration`);
        }

        // Extract video info for matching
        const videoInfo = subtitleMatcher.extractVideoInfo(streamInfo, movieInfo.title);
        console.log(`[VIDEO] Source: ${videoInfo.source}, Special: ${videoInfo.specialEdition || 'none'}`);

        // Search for subtitles
        const searchQuery = `${movieInfo.title} ${movieInfo.year}`;
        let subtitles = await titulkyClient.searchSubtitles(searchQuery);

        if (subtitles.length === 0) {
            console.log(`[WARN] No subtitles found for "${searchQuery}"`);
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
                // Add ranking info to title
                title: `${sub.title} [${sub.matchScore}% match]`,
                // For direct playback
                download_url: sub.url
            }))
        };

        console.log(`[SUCCESS] Returning ${response.subtitles.length} subtitles`);
        console.log(`==========================================\n`);
        
        res.json(response);
        
    } catch (error) {
        console.error(`[ERROR] ${error.message}`);
        console.error(error.stack);
        res.status(500).json({ 
            subtitles: [],
            error: error.message 
        });
    }
});

// Start server
app.listen(PORT, () => {
    console.log(`\n🚀 Titulky.com Addon Server Started`);
    console.log(`📡 Port: ${PORT}`);
    console.log(`🔗 Manifest: http://localhost:${PORT}/manifest.json`);
    console.log(`\n📖 Usage:`);
    console.log(`   Without RD: /subtitles/movie/tt1234567.json`);
    console.log(`   With RD:    /subtitles/movie/tt1234567/YOUR_API_KEY.json`);
    console.log(`\n⚠️  Each user must use their own RD API key in the URL!`);
    console.log(`=====================================\n`);
});
