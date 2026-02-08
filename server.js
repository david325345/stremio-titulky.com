/*
PACKAGE.JSON DEPENDENCIES:
{
  "name": "stremio-titulky-addon",
  "version": "2.0.0",
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

// Store user sessions (in production, use Redis or database)
const userSessions = new Map();

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

    async getTorrentInfo(hash) {
        try {
            console.log(`[RD] Fetching torrent info for hash: ${hash}`);
            
            const response = await axios.get(`${this.baseUrl}/torrents/info/${hash}`, {
                headers: {
                    'Authorization': `Bearer ${this.apiKey}`
                },
                timeout: 5000
            });

            if (response.data) {
                console.log(`[RD] Torrent info found: ${response.data.filename}`);
                return {
                    filename: response.data.filename,
                    files: response.data.files,
                    size: response.data.bytes
                };
            }

            return null;
        } catch (error) {
            console.error('[RD] Error fetching torrent info:', error.message);
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

        // Try to detect by resolution
        if (filenameLower.includes('2160p') || filenameLower.includes('4k')) {
            return 'bluray'; // Assume 4K is bluray quality
        } else if (filenameLower.includes('1080p')) {
            return 'web-dl'; // Default 1080p to web-dl
        } else if (filenameLower.includes('720p')) {
            return 'webrip'; // Default 720p to webrip
        }

        return 'unknown';
    }
}

// Enhanced subtitle matching system with Real-Debrid integration
class SubtitleMatcher {
    constructor() {
        // Video source priority (higher = better match)
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

        // Special edition patterns (for additional priority boost)
        this.specialEditions = [
            'extended', 'director', 'directors', 'special', 'edition', 'cut',
            'uncut', 'unrated', 'theatrical', 'ultimate', 'remastered',
            'anniversary', 'collectors', 'limited', 'deluxe', 'redux',
            'final', 'complete', 'definitive', 'alternate', 'international'
        ];

        // File size to quality mapping (in GB)
        this.sizeToQuality = {
            50: 'remux',     // > 50GB likely remux
            25: 'bluray',    // 25-50GB likely bluray
            10: 'web-dl',    // 10-25GB likely web-dl
            4: 'webrip',     // 4-10GB likely webrip
            2: 'hdtv',       // 2-4GB likely hdtv
            0: 'dvdrip'      // < 2GB likely dvdrip or lower
        };
    }

    // Estimate quality from file size (if no Real-Debrid info)
    estimateQualityFromSize(sizeInBytes) {
        const sizeInGB = sizeInBytes / (1024 * 1024 * 1024);
        console.log(`[MATCHER] Estimating quality from size: ${sizeInGB.toFixed(2)} GB`);

        for (const [threshold, quality] of Object.entries(this.sizeToQuality).sort((a, b) => b[0] - a[0])) {
            if (sizeInGB >= parseFloat(threshold)) {
                console.log(`[MATCHER] Estimated quality: ${quality} (based on size)`);
                return quality;
            }
        }

        return 'dvdrip'; // Default for very small files
    }

    // Extract video source from title or Real-Debrid info
    extractVideoInfo(streamInfo, fallbackTitle = '') {
        console.log(`[MATCHER] Analyzing stream info:`, streamInfo);
        
        let info = {
            source: 'unknown',
            specialEdition: null,
            originalTitle: streamInfo?.filename || fallbackTitle
        };

        // First priority: Real-Debrid filename
        if (streamInfo?.filename) {
            info.source = this.extractSource(streamInfo.filename);
            info.specialEdition = this.extractSpecialEdition(streamInfo.filename);
            console.log(`[MATCHER] Extracted from RD filename: source=${info.source}, edition=${info.specialEdition}`);
        }
        
        // Second priority: Real-Debrid detected quality
        if (info.source === 'unknown' && streamInfo?.quality && streamInfo.quality !== 'unknown') {
            info.source = streamInfo.quality;
            console.log(`[MATCHER] Using RD detected quality: ${info.source}`);
        }

        // Third priority: Estimate from file size
        if (info.source === 'unknown' && streamInfo?.size) {
            info.source = this.estimateQualityFromSize(streamInfo.size);
            console.log(`[MATCHER] Using size-based estimate: ${info.source}`);
        }

        // Fallback: Extract from title
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

    // Extract special edition info from title
    extractSpecialEdition(title) {
        const titleLower = title.toLowerCase();
        
        for (const edition of this.specialEditions) {
            if (titleLower.includes(edition)) {
                // Look for common combinations
                if (titleLower.includes('extended') && titleLower.includes('cut')) {
                    return 'extended-cut';
                }
                if (titleLower.includes('director') && (titleLower.includes('cut') || titleLower.includes('edition'))) {
                    return 'directors-cut';
                }
                if (titleLower.includes('special') && titleLower.includes('edition')) {
                    return 'special-edition';
                }
                if (titleLower.includes('ultimate') && titleLower.includes('edition')) {
                    return 'ultimate-edition';
                }
                
                return edition;
            }
        }
        return null;
    }

    // Calculate compatibility score between video and subtitle sources
    calculateCompatibilityScore(videoInfo, subtitleInfo, movieTitle = '') {
        console.log(`[MATCHER] Comparing video source "${videoInfo.source}" with subtitle source "${subtitleInfo.source}"`);

        let score = 0;

        // Perfect match
        if (videoInfo.source === subtitleInfo.source) {
            console.log(`[MATCHER] Perfect source match: 100%`);
            score = 100;
        }
        // Compatible sources
        else if (this.areSourcesCompatible(videoInfo.source, subtitleInfo.source)) {
            console.log(`[MATCHER] Compatible sources: 80%`);
            score = 80;
        }
        // Different but known sources
        else if (videoInfo.source !== 'unknown' && subtitleInfo.source !== 'unknown') {
            console.log(`[MATCHER] Different known sources: 40%`);
            score = 40;
        }
        // Unknown source
        else {
            console.log(`[MATCHER] Unknown source: 20%`);
            score = 20;
        }

        return score;
    }

    // Calculate special edition bonus score
    calculateSpecialEditionBonus(videoInfo, subtitleInfo) {
        let bonus = 0;
        
        // If video has special edition info
        if (videoInfo.specialEdition) {
            const videoEdition = videoInfo.specialEdition;
            const subtitleTitle = (subtitleInfo.originalTitle || '').toLowerCase();
            
            // Perfect special edition match
            if (subtitleTitle.includes(videoEdition)) {
                bonus = 20;
                console.log(`[MATCHER] Perfect special edition match "${videoEdition}": +${bonus}%`);
            }
            // Partial match for common editions
            else if (videoEdition === 'extended-cut' && subtitleTitle.includes('extended')) {
                bonus = 15;
                console.log(`[MATCHER] Extended edition match: +${bonus}%`);
            }
            else if (videoEdition === 'directors-cut' && (subtitleTitle.includes('director') || subtitleTitle.includes('directors'))) {
                bonus = 15;
                console.log(`[MATCHER] Directors cut match: +${bonus}%`);
            }
            else if (videoEdition === 'special-edition' && subtitleTitle.includes('special')) {
                bonus = 10;
                console.log(`[MATCHER] Special edition match: +${bonus}%`);
            }
            // General special edition indicators
            else if (this.specialEditions.some(edition => subtitleTitle.includes(edition))) {
                bonus = 5;
                console.log(`[MATCHER] General special edition detected: +${bonus}%`);
            }
        }
        // If subtitle has special edition but video doesn't - small penalty
        else if (subtitleInfo.originalTitle && this.specialEditions.some(edition => 
            subtitleInfo.originalTitle.toLowerCase().includes(edition))) {
            bonus = -5;
            console.log(`[MATCHER] Subtitle has special edition but video doesn't: ${bonus}%`);
        }

        return bonus;
    }

    // Calculate title similarity score
    calculateTitleSimilarity(movieTitle, subtitleTitle) {
        if (!movieTitle || !subtitleTitle) return 50;

        const normalizeTitle = (title) => {
            return title.toLowerCase()
                .replace(/[^\w\s]/g, ' ')     // Replace special chars with spaces
                .replace(/\b(the|a|an)\b/g, '') // Remove articles
                .replace(/\s+/g, ' ')         // Normalize spaces
                .trim();
        };

        const normalizedMovie = normalizeTitle(movieTitle);
        const normalizedSubtitle = normalizeTitle(subtitleTitle);

        console.log(`[MATCHER] Comparing titles: "${normalizedMovie}" vs "${normalizedSubtitle}"`);

        // Exact match
        if (normalizedMovie === normalizedSubtitle) {
            console.log(`[MATCHER] Exact title match: 100%`);
            return 100;
        }

        // Check if subtitle contains sequel/prequel indicators
        const sequelWords = ['reloaded', 'revolutions', 'resurrection', 'begins', 'returns', 'rises', 'awakens', 'forever', 'reborn', 'origins', 'legacy', 'part', 'ii', 'iii', 'iv', 'v'];
        const numberPattern = /\b(2|3|4|5|6|7|8|9|10)\b/;
        
        const subtitleHasSequel = sequelWords.some(word => normalizedSubtitle.includes(word)) || 
                                 numberPattern.test(normalizedSubtitle);

        // If searching for original movie but subtitle is sequel
        if (subtitleHasSequel && !normalizedMovie.includes('2') && !normalizedMovie.includes('3') && 
            !sequelWords.some(word => normalizedMovie.includes(word))) {
            
            // Still check if base title matches
            const movieWords = normalizedMovie.split(' ').filter(w => w.length > 2);
            const subtitleWords = normalizedSubtitle.split(' ').filter(w => w.length > 2);
            const baseWords = subtitleWords.filter(word => !sequelWords.includes(word) && !numberPattern.test(word));
            
            const commonWords = movieWords.filter(word => baseWords.includes(word));
            
            if (commonWords.length === movieWords.length && movieWords.length > 0) {
                console.log(`[MATCHER] Base title matches but subtitle is sequel: 60%`);
                return 60;
            }
        }

        // Check if movie title is at the beginning of subtitle title (most important for exact matches)
        if (normalizedSubtitle.startsWith(normalizedMovie + ' ') && !subtitleHasSequel) {
            console.log(`[MATCHER] Movie title at start of subtitle (no sequel): 100%`);
            return 100;
        }

        // Movie title is contained in subtitle title (but check for sequels)
        if (normalizedSubtitle.includes(normalizedMovie)) {
            if (subtitleHasSequel) {
                console.log(`[MATCHER] Movie title contained but subtitle is sequel: 60%`);
                return 60;
            }
            console.log(`[MATCHER] Movie title contained in subtitle: 90%`);
            return 90;
        }

        // Subtitle title is contained in movie title
        if (normalizedMovie.includes(normalizedSubtitle)) {
            console.log(`[MATCHER] Subtitle title contained in movie: 85%`);
            return 85;
        }

        // Check for common words (basic similarity)
        const movieWords = normalizedMovie.split(' ').filter(w => w.length > 2);
        const subtitleWords = normalizedSubtitle.split(' ').filter(w => w.length > 2);
        const commonWords = movieWords.filter(word => subtitleWords.includes(word));
        
        if (commonWords.length > 0) {
            const similarity = (commonWords.length * 2) / (movieWords.length + subtitleWords.length) * 100;
            console.log(`[MATCHER] Common words similarity: ${similarity.toFixed(1)}%`);
            return Math.min(80, Math.max(30, similarity));
        }

        console.log(`[MATCHER] No title similarity: 10%`);
        return 10;
    }

    areSourcesCompatible(source1, source2) {
        const compatibleGroups = [
            ['bluray', 'bdrip', 'remux'],
            ['web-dl', 'webdl', 'webrip'],
            ['dvdrip', 'dvdscr'],
            ['hdcam', 'cam', 'ts']
        ];

        for (const group of compatibleGroups) {
            if (group.includes(source1) && group.includes(source2)) {
                return true;
            }
        }
        return false;
    }

    // Sort subtitles by source relevance to video
    sortSubtitlesByRelevance(subtitles, videoInfo, movieTitle = '') {
        console.log(`[MATCHER] Sorting ${subtitles.length} subtitles by source relevance and title similarity`);
        console.log(`[MATCHER] Video source: ${videoInfo.source}`);
        console.log(`[MATCHER] Target movie title: "${movieTitle}"`);
        if (videoInfo.specialEdition) {
            console.log(`[MATCHER] Target special edition: "${videoInfo.specialEdition}"`);
        }
        
        const scoredSubtitles = subtitles.map(subtitle => {
            const subtitleInfo = this.extractVideoInfo(null, subtitle.videoVersion || subtitle.title);
            const sourceScore = this.calculateCompatibilityScore(videoInfo, subtitleInfo);
            const titleScore = this.calculateTitleSimilarity(movieTitle, subtitle.title);
            const editionBonus = this.calculateSpecialEditionBonus(videoInfo, subtitleInfo);
            
            // Combined score: 60% source + 25% title + 15% edition bonus
            const baseScore = (sourceScore * 0.6) + (titleScore * 0.25);
            const finalScore = Math.min(100, baseScore + editionBonus);
            
            return {
                ...subtitle,
                compatibilityScore: sourceScore,
                titleSimilarity: titleScore,
                editionBonus: editionBonus,
                finalScore: finalScore,
                subtitleVideoInfo: subtitleInfo
            };
        });

        // Sort by final score (descending), then by downloads (descending)
        scoredSubtitles.sort((a, b) => {
            // Primary sort: final score (higher is better)
            const scoreDiff = b.finalScore - a.finalScore;
            if (Math.abs(scoreDiff) >= 3) { // Reduced threshold for more sensitive sorting
                return scoreDiff;
            }
            
            // Secondary sort: downloads (higher is better)
            const downloadDiff = (b.downloads || 0) - (a.downloads || 0);
            if (downloadDiff !== 0) {
                return downloadDiff;
            }
            
            // Tertiary sort: ID (for consistent ordering)
            return (a.id || '').localeCompare(b.id || '');
        });

        console.log(`[MATCHER] Top 6 matches after sorting:`);
        scoredSubtitles.slice(0, 6).forEach((sub, i) => {
            const editionInfo = sub.editionBonus !== 0 ? ` EditionBonus: ${sub.editionBonus > 0 ? '+' : ''}${sub.editionBonus}%` : '';
            console.log(`[MATCHER] ${i+1}. "${sub.title}" - Source: ${sub.subtitleVideoInfo.source} - SourceScore: ${sub.compatibilityScore}% - TitleScore: ${sub.titleSimilarity.toFixed(1)}%${editionInfo} - FinalScore: ${sub.finalScore.toFixed(1)}% - Downloads: ${sub.downloads || 0}`);
        });

        return scoredSubtitles;
    }

    // Create enhanced subtitle name with source compatibility indicator
    createEnhancedSubtitleName(subtitle, isTopMatch = false, hasRealDebrid = false) {
        let name = subtitle.title;
        
        // Add Real-Debrid indicator if used
        if (hasRealDebrid) {
            name = `[RD] ${name}`;
        }
        
        // Add special edition info if detected
        if (subtitle.subtitleVideoInfo && subtitle.subtitleVideoInfo.specialEdition) {
            const edition = subtitle.subtitleVideoInfo.specialEdition.toUpperCase().replace('-', ' ');
            name += ` [${edition}]`;
        }
        
        // Add source info if available
        if (subtitle.videoVersion && !name.includes(subtitle.videoVersion)) {
            const source = this.extractSource(subtitle.videoVersion);
            if (source !== 'unknown') {
                name += ` [${source.toUpperCase()}]`;
            }
        }

        // Add compatibility indicator based on final score (including edition bonus)
        const finalScore = subtitle.finalScore || subtitle.compatibilityScore;
        
        if (isTopMatch && finalScore >= 95) {
            name = `🏆 ${name}`; // Perfect match with edition bonus
        } else if (finalScore >= 90) {
            name = `🎯 ${name}`; // Excellent match
        } else if (finalScore >= 80) {
            name = `✅ ${name}`; // Good match
        } else if (finalScore >= 60) {
            name = `📝 ${name}`; // Decent match
        } else {
            name = `⚠️ ${name}`; // Poor match
        }

        // Add edition bonus indicator for special editions
        if (subtitle.editionBonus && subtitle.editionBonus > 0) {
            name = name.replace(/^(🏆|🎯|✅|📝|⚠️) /, '$1⭐ '); // Add star for edition bonus
        }

        // Add author if available
        if (subtitle.author && !name.includes(subtitle.author)) {
            name += ` - ${subtitle.author}`;
        }

        return name;
    }
}

// Initialize matcher
const subtitleMatcher = new SubtitleMatcher();

// Keep-alive ping endpoint
app.get('/ping', (req, res) => {
    res.json({ 
        status: 'alive', 
        timestamp: new Date().toISOString(),
        uptime: Math.floor(process.uptime()),
        activeSessions: userSessions.size
    });
});

// Keep-alive function to prevent Render.com sleep
function startKeepAlive() {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || `http://localhost:${PORT}`;
    
    console.log(`[KEEP-ALIVE] Starting self-ping every 13 minutes to: ${baseUrl}/ping`);
    
    setInterval(async () => {
        try {
            const startTime = Date.now();
            const response = await axios.get(`${baseUrl}/ping`, {
                timeout: 30000,
                headers: {
                    'User-Agent': 'Titulky-Addon-KeepAlive/1.0'
                }
            });
            const responseTime = Date.now() - startTime;
            
            console.log(`[KEEP-ALIVE] ✓ Ping successful in ${responseTime}ms - Status: ${response.data.status} - Uptime: ${response.data.uptime}s`);
        } catch (error) {
            console.log(`[KEEP-ALIVE] ✗ Ping failed: ${error.message}`);
            
            // If ping fails, try alternative endpoints
            try {
                await axios.get(`${baseUrl}/health`, { timeout: 15000 });
                console.log(`[KEEP-ALIVE] ✓ Fallback health ping successful`);
            } catch (fallbackError) {
                console.log(`[KEEP-ALIVE] ✗ Fallback ping also failed: ${fallbackError.message}`);
            }
        }
    }, 13 * 60 * 1000); // Ping every 13 minutes (780 seconds)
}

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

// Helper function to create fallback SRT content when captcha is detected
function createFallbackSRT(title, language = 'cs') {
    return `1
00:00:01,000 --> 00:05:00,000
Dosáhli jste maximální počet stažení 25 za den. Reset limitu proběhne zítra.
`;
}

// Addon manifest
const manifest = {
    id: 'com.titulky.subtitles',
    version: '2.0.0',
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
        configurable: false,
        configurationRequired: false
    }
};

class TitulkyClient {
    constructor() {
        this.baseUrl = 'https://www.titulky.com';
        this.cookies = {};
        this.lastUsed = Date.now();
        this.captchaDetected = false; // Track captcha state
    }

    // New method to fetch detailed subtitle information including video version
    async getSubtitleDetails(linkFile, subtitleId) {
        console.log(`[DETAILS] Fetching details for: ${linkFile}-${subtitleId}.htm`);
        
        try {
            const detailUrl = `${this.baseUrl}/${linkFile}-${subtitleId}.htm`;
            
            const response = await axios.get(detailUrl, {
                headers: {
                    'Cookie': this.getCookieString(),
                    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
                    'Referer': this.baseUrl,
                    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
                    'Accept-Language': 'cs,en;q=0.5',
                    'Accept-Encoding': 'gzip, deflate'
                },
                timeout: 10000,
                responseType: 'arraybuffer'
            });

            // Handle compressed response
            let content;
            const contentEncoding = response.headers['content-encoding'];
            
            if (contentEncoding === 'gzip') {
                content = zlib.gunzipSync(response.data).toString('utf-8');
            } else if (contentEncoding === 'deflate') {
                content = zlib.inflateSync(response.data).toString('utf-8');
            } else {
                content = response.data.toString('utf-8');
            }

            return this.parseSubtitleDetails(content);
            
        } catch (error) {
            console.error(`[DETAILS] Error fetching details for ${linkFile}-${subtitleId}:`, error.message);
            return null;
        }
    }

    parseSubtitleDetails(html) {
        console.log('[DETAILS] Parsing subtitle detail page');
        const $ = cheerio.load(html);
        
        const details = {
            videoVersion: '',
            releaseInfo: '',
            author: ''
        };

        try {
            // Look for the main content table with subtitle details
            const infoTable = $('table').filter((i, table) => {
                return $(table).text().includes('VERZE PRO') || $(table).text().includes('DALŠÍ INFO');
            });

            if (infoTable.length > 0) {
                // Parse version info from "VERZE PRO" section
                const versionCell = infoTable.find('td').filter((i, cell) => {
                    return $(cell).text().trim().startsWith('VERZE PRO');
                });

                if (versionCell.length > 0) {
                    const versionText = versionCell.next('td').text().trim();
                    details.videoVersion = this.cleanVersionText(versionText);
                    console.log(`[DETAILS] Found video version: ${details.videoVersion}`);
                }

                // Look for additional release info in table cells
                infoTable.find('tr').each((i, row) => {
                    const cells = $(row).find('td');
                    if (cells.length >= 2) {
                        const label = $(cells[0]).text().trim();
                        const value = $(cells[1]).text().trim();
                        
                        switch (label) {
                            case 'DALŠÍ INFO':
                                details.releaseInfo = value;
                                break;
                            case 'ULOŽIL':
                                details.author = value;
                                break;
                        }
                    }
                });
            }

            // Try alternative parsing - look for version info in different structures
            if (!details.videoVersion) {
                // Look for video file names or version strings in the page
                const versionPatterns = [
                    /([A-Za-z0-9]+\.[A-Za-z0-9]+\.[0-9]+p\.[A-Za-z0-9]+\.[A-Za-z0-9-]+)/g,
                    /([0-9]+p[.-][A-Za-z0-9.-]+)/g,
                    /(BluRay|BDRip|DVDRip|WEBRip|HDTV|WEB-DL)[.-]?[A-Za-z0-9.-]*/gi,
                    /(x264|x265|H\.264|H\.265|HEVC)[.-]?[A-Za-z0-9.-]*/gi
                ];

                const pageText = $.text();
                for (const pattern of versionPatterns) {
                    const matches = pageText.match(pattern);
                    if (matches && matches.length > 0) {
                        details.videoVersion = matches[0];
                        console.log(`[DETAILS] Extracted version from pattern: ${details.videoVersion}`);
                        break;
                    }
                }
            }

        } catch (error) {
            console.error('[DETAILS] Error parsing subtitle details:', error.message);
        }

        return details;
    }

    cleanVersionText(text) {
        // Clean and normalize version text
        return text
            .replace(/\s+/g, ' ')
            .replace(/[^\w\d\.\-\[\]]/g, ' ')
            .trim()
            .substring(0, 100); // Limit length
    }

    // Enhanced search with detailed info
    async searchSubtitlesWithDetails(query, fetchDetails = false) {
        console.log(`[SEARCH+] Starting enhanced search for: "${query}"`);
        
        const basicResults = await this.searchSubtitles(query);
        
        if (!fetchDetails || basicResults.length === 0) {
            return basicResults;
        }

        // Fetch details for top results (limit to avoid too many requests)
        const detailedResults = [];
        const maxDetails = Math.min(5, basicResults.length); // Limit to top 5
        
        for (let i = 0; i < maxDetails; i++) {
            const subtitle = basicResults[i];
            console.log(`[SEARCH+] Fetching details for result ${i+1}/${maxDetails}: ${subtitle.title}`);
            
            try {
                const details = await this.getSubtitleDetails(subtitle.linkFile, subtitle.id);
                
                if (details && details.videoVersion) {
                    subtitle.videoVersion = details.videoVersion;
                    subtitle.releaseInfo = details.releaseInfo;
                    subtitle.detailedAuthor = details.author;
                    
                    console.log(`[SEARCH+] Enhanced subtitle: ${subtitle.title} - Version: ${subtitle.videoVersion}`);
                } else {
                    console.log(`[SEARCH+] No additional details found for: ${subtitle.title}`);
                }
                
                detailedResults.push(subtitle);
                
                // Small delay to avoid overwhelming the server
                await new Promise(resolve => setTimeout(resolve, 500));
                
            } catch (error) {
                console.error(`[SEARCH+] Failed to fetch details for ${subtitle.title}:`, error.message);
                // Add subtitle without details
                detailedResults.push(subtitle);
            }
        }
        
        // Add remaining results without details
        for (let i = maxDetails; i < basicResults.length; i++) {
            detailedResults.push(basicResults[i]);
        }
        
        return detailedResults;
    }