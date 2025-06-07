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

// Simplified subtitle matching system - focus only on video source
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
    }

    // Extract video source from title
    extractVideoInfo(streamTitle) {
        console.log(`[MATCHER] Analyzing stream: "${streamTitle}"`);
        
        const info = {
            source: this.extractSource(streamTitle),
            originalTitle: streamTitle
        };

        console.log(`[MATCHER] Extracted video source: ${info.source}`);
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

    // Calculate compatibility score between video and subtitle sources
    calculateCompatibilityScore(videoInfo, subtitleInfo) {
        console.log(`[MATCHER] Comparing video source "${videoInfo.source}" with subtitle source "${subtitleInfo.source}"`);

        // Perfect match
        if (videoInfo.source === subtitleInfo.source) {
            console.log(`[MATCHER] Perfect source match: 100%`);
            return 100;
        }

        // Compatible sources
        if (this.areSourcesCompatible(videoInfo.source, subtitleInfo.source)) {
            console.log(`[MATCHER] Compatible sources: 80%`);
            return 80;
        }

        // Different but known sources
        if (videoInfo.source !== 'unknown' && subtitleInfo.source !== 'unknown') {
            console.log(`[MATCHER] Different known sources: 40%`);
            return 40;
        }

        // Unknown source
        console.log(`[MATCHER] Unknown source: 20%`);
        return 20;
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
    sortSubtitlesByRelevance(subtitles, videoInfo) {
        console.log(`[MATCHER] Sorting ${subtitles.length} subtitles by source relevance`);
        
        const scoredSubtitles = subtitles.map(subtitle => {
            const subtitleInfo = this.extractVideoInfo(subtitle.videoVersion || subtitle.title);
            const score = this.calculateCompatibilityScore(videoInfo, subtitleInfo);
            
            return {
                ...subtitle,
                compatibilityScore: score,
                subtitleVideoInfo: subtitleInfo
            };
        });

        // Sort by compatibility score (descending), then by downloads (descending)
        scoredSubtitles.sort((a, b) => {
            if (Math.abs(a.compatibilityScore - b.compatibilityScore) < 10) {
                // If scores are close (within 10%), prefer more downloaded
                return (b.downloads || 0) - (a.downloads || 0);
            }
            return b.compatibilityScore - a.compatibilityScore;
        });

        console.log(`[MATCHER] Top 3 source matches:`);
        scoredSubtitles.slice(0, 3).forEach((sub, i) => {
            console.log(`[MATCHER] ${i+1}. "${sub.title}" - Source: ${sub.subtitleVideoInfo.source} - Score: ${sub.compatibilityScore}%`);
        });

        return scoredSubtitles;
    }

    // Create enhanced subtitle name with source compatibility indicator
    createEnhancedSubtitleName(subtitle, isTopMatch = false) {
        let name = subtitle.title;
        
        // Add source info if available
        if (subtitle.videoVersion && !name.includes(subtitle.videoVersion)) {
            const source = this.extractSource(subtitle.videoVersion);
            if (source !== 'unknown') {
                name += ` [${source.toUpperCase()}]`;
            }
        }

        // Add compatibility indicator based on source matching
        if (isTopMatch && subtitle.compatibilityScore === 100) {
            name = `🎯 ${name}`; // Perfect source match
        } else if (subtitle.compatibilityScore >= 80) {
            name = `✅ ${name}`; // Compatible source
        } else if (subtitle.compatibilityScore <= 40) {
            name = `⚠️ ${name}`; // Different/unknown source
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
            this.captchaDetected = false; // Reset captcha state on successful login
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
        
        // If captcha was detected in previous requests, return empty results
        if (this.captchaDetected) {
            console.log('[SEARCH] Captcha detected in previous request, skipping search');
            return [];
        }
        
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

            // Check for captcha in search results
            if (content.includes('captcha') || content.includes('CAPTCHA')) {
                console.log('[SEARCH] CAPTCHA detected in search results');
                this.captchaDetected = true;
                return [];
            }

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
            if (content.includes('captcha') || content.includes('CAPTCHA')) {
                console.log('[DOWNLOAD] Captcha detected - setting captcha flag');
                this.captchaDetected = true;
                throw new Error('CAPTCHA_DETECTED');
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

        .warning {
            background: rgba(255, 193, 7, 0.1);
            border: 2px solid #ffc107;
            border-radius: 12px;
            padding: 15px;
            margin-top: 20px;
            color: #856404;
        }

        .keep-alive-status {
            background: rgba(76, 175, 80, 0.1);
            border: 2px solid #4caf50;
            border-radius: 12px;
            padding: 15px;
            margin-top: 20px;
            color: #2e7d32;
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
        
        <div class="keep-alive-status">
            <strong>🟢 Keep-Alive aktivní:</strong><br>
            Addon se automaticky udržuje při životě ping každých 13 minut pro Render.com hosting.
        </div>
        
        <div class="warning">
            <strong>⚠️ Limit stažení:</strong><br>
            Titulky.com má limit 25 stažení za den. Po překročení limitu se zobrazí speciální SRT soubor s upozorněním.
        </div>
        
        <div class="info">
            <h3>📋 Instrukce:</h3>
            <ul>
                <li>Zadejte své přihlašovací údaje k účtu na Titulky.com</li>
                <li>Klikněte na "Vytvořit konfiguraci"</li>
                <li>Po úspěšném ověření klikněte na "Nainstalovat do Stremio"</li>
                <li>Addon bude dostupný v sekci Addons ve Stremio</li>
                <li>Titulky se automaticky zobrazí při přehrávání filmů a seriálů</li>
                <li><strong>Keep-Alive:</strong> Addon se automaticky udržuje aktivní na Render.com</li>
                <li><strong>Limit stažení:</strong> Po dosažení 25 stažení za den se zobrazí upozornění na 5 minut</li>
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
                    testLink.textContent = 'Test manifest';
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
    res.set({
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type'
    });
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
            id: `com.titulky.subtitles.${decodedConfig.username}`,
            name: `${manifest.name} (${decodedConfig.username})`,
            description: `${manifest.description} - User: ${decodedConfig.username}`
        };
        
        res.set({
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type'
        });
        
        res.json(configuredManifest);
    } catch (error) {
        console.error('[MANIFEST] Invalid configuration:', error.message);
        res.status(400).json({ error: 'Invalid configuration' });
    }
});

app.get('/:config/subtitles/:type/:id*', async (req, res) => {
    const { config, type } = req.params;
    let fullPath = req.params.id + (req.params[0] || ''); // Capture everything after :id
    
    console.log(`[SUBTITLES] Raw path: "${fullPath}"`);
    
    // Decode URL-encoded path
    fullPath = decodeURIComponent(fullPath);
    console.log(`[SUBTITLES] Decoded path: "${fullPath}"`);
    
    // Extract just the ID part (before any /)
    let id = fullPath.split('/')[0];
    
    // Remove query parameters from ID (after &)
    id = id.split('&')[0];
    
    // Remove .json extension if present
    id = id.replace('.json', '');
    
    console.log(`[SUBTITLES] Request: type=${type}, id=${id}, config=${config.substring(0, 20)}...`);
    console.log(`[SUBTITLES] Cleaned ID: "${id}"`);
    console.log(`[SUBTITLES] ID parts: [${id.split(':')}]`);
    
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

        // Extract IMDB ID and get movie/series title from OMDB API
        let baseImdbId, season, episode;
        
        // Parse different ID formats from Stremio
        if (id.includes(':')) {
            // Format: tt1234567:1:1 (series:season:episode)
            const parts = id.split(':');
            baseImdbId = parts[0].replace('tt', '');
            season = parts[1];
            episode = parts[2];
            console.log(`[SUBTITLES] Series format: IMDB=${baseImdbId}, S${season}E${episode}`);
        } else {
            // Simple movie format: tt1234567
            baseImdbId = id.replace('tt', '');
            console.log(`[SUBTITLES] Movie format: IMDB=${baseImdbId}`);
        }

        console.log(`[SUBTITLES] IMDB ID: ${baseImdbId}`);
        
        // Get movie/series title from OMDB API
        const movieInfo = await getMovieTitle(baseImdbId);
        if (!movieInfo) {
            console.log(`[SUBTITLES] Could not get title for IMDB ${baseImdbId}`);
            return res.json({ subtitles: [] });
        }
        
        // Check if captcha was detected in previous requests
        if (client.captchaDetected) {
            console.log('[SUBTITLES] CAPTCHA detected - providing fallback subtitle');
            
            const fallbackTitle = season && episode ? 
                `${movieInfo.title} S${season}E${episode}` : 
                movieInfo.title;
            
            const fallbackSubtitle = {
                id: 'captcha_fallback',
                url: `${req.protocol}://${req.get('host')}/${config}/fallback-subtitle/limit-reached.srt`,
                lang: 'cs',
                name: '⚠️ Dosáhli jste max. 25 stažení za den',
                rating: 1
            };
            
            return res.json({ subtitles: [fallbackSubtitle] });
        }
        
        // Create search queries based on the real title
        let searchQueries = [];
        
        if (type === 'movie') {
            // For movies, search by title and title+year
            searchQueries = [
                movieInfo.title,
                `${movieInfo.title} ${movieInfo.year}`,
                movieInfo.title.replace(/[^\w\s]/g, ''), // Remove special characters
            ];
        } else if (type === 'series') {
            // For series, we need episode info from the ID
            if (season && episode) {
                console.log(`[SUBTITLES] Series: ${movieInfo.title} S${season}E${episode}`);
                
                searchQueries = [
                    `${movieInfo.title} S${season.padStart(2, '0')}E${episode.padStart(2, '0')}`,
                    `${movieInfo.title} ${season}x${episode.padStart(2, '0')}`,
                    `${movieInfo.title} ${season}x${episode}`,
                    `${movieInfo.title} S${season}E${episode}`,
                    movieInfo.title // Fallback to just series name
                ];
            } else {
                // No episode info, just series name
                searchQueries = [movieInfo.title];
            }
        }

        console.log(`[SUBTITLES] Search queries: ${searchQueries.join(', ')}`);

        let allSubtitles = [];
        
        // Try each search query until we find results
        for (let i = 0; i < searchQueries.length; i++) {
            const query = searchQueries[i];
            console.log(`[SUBTITLES] Trying search query ${i+1}/${searchQueries.length}: "${query}"`);
            
            try {
                // Use enhanced search for first query to get version info
                const fetchDetails = (i === 0); // Only fetch details for first/best query
                const subtitles = await client.searchSubtitlesWithDetails(query, fetchDetails);
                
                // Check if captcha was detected during search
                if (client.captchaDetected) {
                    console.log('[SUBTITLES] CAPTCHA detected during search - providing fallback subtitle');
                    
                    const fallbackTitle = season && episode ? 
                        `${movieInfo.title} S${season}E${episode}` : 
                        movieInfo.title;
                    
                    const fallbackSubtitle = {
                        id: 'captcha_fallback',
                        url: `${req.protocol}://${req.get('host')}/${config}/fallback-subtitle/limit-reached.srt`,
                        lang: 'cs',
                        name: '⚠️ Dosáhli jste max. 25 stažení za den',
                        rating: 1
                    };
                    
                    return res.json({ subtitles: [fallbackSubtitle] });
                }
                
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
        
        // Extract video source for matching
        let videoInfo = { source: 'unknown' };
        
        try {
            // Try to get video source from request headers or create default
            const userAgent = req.get('User-Agent') || '';
            const referrer = req.get('Referer') || '';
            
            // Create basic video info for source matching
            let searchTitle = '';
            if (type === 'movie') {
                searchTitle = `${movieInfo.title} ${movieInfo.year}`;
            } else {
                searchTitle = `${movieInfo.title} S${season}E${episode}`;
            }
            
            videoInfo = subtitleMatcher.extractVideoInfo(searchTitle);
            
            console.log(`[SUBTITLES] Using video source for matching: ${videoInfo.source}`);
        } catch (error) {
            console.log(`[SUBTITLES] Could not extract video source, using defaults`);
        }

        // Sort subtitles by source relevance to video
        const sortedSubtitles = subtitleMatcher.sortSubtitlesByRelevance(allSubtitles, videoInfo);
        
        // Limit to top 6 results
        const topSubtitles = sortedSubtitles.slice(0, 6);
        
        const stremioSubtitles = topSubtitles.map((sub, index) => {
            const isTopMatch = index === 0;
            const enhancedName = subtitleMatcher.createEnhancedSubtitleName(sub, isTopMatch);

            const subtitle = {
                id: `${sub.id}:${sub.linkFile}`,
                url: `${req.protocol}://${req.get('host')}/${config}/subtitle/${sub.id}/${encodeURIComponent(sub.linkFile)}.srt`,
                lang: sub.language.toLowerCase() === 'czech' ? 'cs' : 
                      sub.language.toLowerCase() === 'slovak' ? 'sk' : 'cs',
                name: enhancedName,
                rating: Math.min(5, Math.max(1, Math.round(sub.compatibilityScore / 20))) // Convert to 1-5 rating
            };
            
            console.log(`[SUBTITLES] ${index + 1}. ${subtitle.name} (Source Score: ${sub.compatibilityScore}%, Rating: ${subtitle.rating})`);
            return subtitle;
        });

        console.log(`[SUBTITLES] Returning ${stremioSubtitles.length} source-matched subtitles to Stremio`);
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

// New route for fallback subtitles when captcha is detected
app.get('/:config/fallback-subtitle/:filename', (req, res) => {
    const { filename } = req.params;
    
    console.log(`[FALLBACK] Generating fallback subtitle: ${filename}`);
    
    try {
        // Use same fallback content for all cases
        const fallbackContent = createFallbackSRT('', 'cs');
        
        res.set({
            'Content-Type': 'text/plain; charset=utf-8',
            'Content-Disposition': `attachment; filename="limit_reached.srt"`,
            'Content-Length': Buffer.byteLength(fallbackContent, 'utf-8')
        });
        
        res.send(fallbackContent);
        
    } catch (error) {
        console.error('[FALLBACK] Error generating fallback subtitle:', error.message);
        res.status(500).json({ error: 'Failed to generate fallback subtitle' });
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
        
        try {
            const subtitleData = await client.downloadSubtitle(id, decodedLinkFile);
            
            // Check if we got SRT content (string) or ZIP data (buffer)
            if (typeof subtitleData === 'string') {
                console.log(`[DOWNLOAD] Returning SRT content (${subtitleData.length} characters)`);
                
                res.set({
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Disposition': `attachment; filename="subtitle_${id}.srt"`,
                    'Content-Length': Buffer.byteLength(subtitleData, 'utf-8')
                });
                res.send(subtitleData);
            } else {
                console.log(`[DOWNLOAD] Returning ZIP data (${subtitleData.length} bytes)`);
                
                res.set({
                    'Content-Type': 'application/zip',
                    'Content-Disposition': `attachment; filename="subtitle_${id}.zip"`,
                    'Content-Length': subtitleData.length
                });
                res.send(subtitleData);
            }
        } catch (downloadError) {
            // Check if error is due to captcha
            if (downloadError.message === 'CAPTCHA_DETECTED') {
                console.log(`[DOWNLOAD] CAPTCHA detected - generating fallback SRT for subtitle ${id}`);
                
                // Use same fallback content for all cases
                const fallbackContent = createFallbackSRT('', 'cs');
                
                res.set({
                    'Content-Type': 'text/plain; charset=utf-8',
                    'Content-Disposition': `attachment; filename="limit_reached_${id}.srt"`,
                    'Content-Length': Buffer.byteLength(fallbackContent, 'utf-8')
                });
                
                res.send(fallbackContent);
                return;
            }
            
            // For other errors, rethrow
            throw downloadError;
        }
        
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

// Optional: Add endpoint to test source matching
app.get('/test-matching/:config/:videoTitle', async (req, res) => {
    const { config, videoTitle } = req.params;
    
    try {
        const decodedConfig = JSON.parse(Buffer.from(config, 'base64').toString());
        const { username } = decodedConfig;

        const client = userSessions.get(username);
        if (!client) {
            return res.status(401).json({ error: 'Session expired' });
        }

        const videoInfo = subtitleMatcher.extractVideoInfo(decodeURIComponent(videoTitle));
        const subtitles = await client.searchSubtitlesWithDetails(decodeURIComponent(videoTitle), true);
        const sortedSubtitles = subtitleMatcher.sortSubtitlesByRelevance(subtitles, videoInfo);
        
        res.json({
            success: true,
            videoSource: videoInfo.source,
            totalFound: subtitles.length,
            top6Results: sortedSubtitles.slice(0, 6).map(sub => ({
                title: sub.title,
                videoVersion: sub.videoVersion,
                detectedSource: sub.subtitleVideoInfo?.source || 'unknown',
                compatibilityScore: sub.compatibilityScore,
                enhancedName: subtitleMatcher.createEnhancedSubtitleName(sub)
            }))
        });
    } catch (error) {
        console.error('[TEST-MATCHING] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});
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
            subtitles: subtitles.slice(0, 5), // First 5 results
            captchaDetected: client.captchaDetected
        });
    } catch (error) {
        console.error('[TEST] Error:', error.message);
        res.status(500).json({ error: error.message });
    }
});

// Health check with detailed info including keep-alive status
app.get('/health', (req, res) => {
    const sessionCount = userSessions.size;
    const uptime = process.uptime();
    
    // Count sessions with captcha detected
    const captchaSessions = Array.from(userSessions.values()).filter(session => session.captchaDetected).length;
    
    res.json({ 
        status: 'OK', 
        timestamp: new Date().toISOString(),
        uptime: Math.floor(uptime),
        activeSessions: sessionCount,
        captchaSessions: captchaSessions,
        keepAlive: {
            enabled: true,
            interval: '13 minutes',
            purpose: 'Prevent Render.com sleep'
        },
        version: '1.0.2'
    });
});

// Catch-all error handler
app.use((error, req, res, next) => {
    console.error('[ERROR] Unhandled error:', error.message);
    console.error('[ERROR] Stack:', error.stack);
    console.error('[ERROR] Request URL:', req.url);
    console.error('[ERROR] Request headers:', req.headers);
    
    res.status(500).json({
        error: 'Internal server error',
        message: error.message,
        url: req.url
    });
});

// 404 handler with logging
app.use((req, res) => {
    console.log(`[404] Not found: ${req.method} ${req.url}`);
    console.log(`[404] Headers:`, req.headers);
    res.status(404).json({ 
        error: 'Not found',
        path: req.url,
        method: req.method
    });
});

// Clean up expired sessions every hour and reset captcha flags
setInterval(() => {
    const oneHour = 60 * 60 * 1000;
    const now = Date.now();
    
    console.log(`[CLEANUP] Checking ${userSessions.size} sessions for cleanup`);
    
    for (const [username, session] of userSessions.entries()) {
        if (now - session.lastUsed > oneHour) {
            console.log(`[CLEANUP] Removing expired session for ${username}`);
            userSessions.delete(username);
        } else if (session.captchaDetected && now - session.lastUsed > 10 * 60 * 1000) {
            // Reset captcha flag after 10 minutes of inactivity
            console.log(`[CLEANUP] Resetting captcha flag for ${username}`);
            session.captchaDetected = false;
        }
    }
    
    console.log(`[CLEANUP] ${userSessions.size} sessions remaining after cleanup`);
}, 60 * 60 * 1000);

app.listen(PORT, () => {
    console.log(`Titulky.com Stremio Addon running on port ${PORT}`);
    console.log(`Manifest URL: http://localhost:${PORT}/manifest.json`);
    console.log(`Health check: http://localhost:${PORT}/health`);
    console.log(`Ping endpoint: http://localhost:${PORT}/ping`);
    console.log('Debug logging enabled');
    console.log('CAPTCHA fallback functionality active');
    
    // Start keep-alive mechanism for production (Render.com)
    if (process.env.NODE_ENV === 'production' || process.env.RENDER_EXTERNAL_URL) {
        console.log('🟢 Starting keep-alive mechanism for Render.com...');
        console.log('⏰ Self-ping will occur every 13 minutes to prevent sleep');
        
        // Start keep-alive after 30 seconds to ensure server is fully ready
        setTimeout(() => {
            startKeepAlive();
            console.log('✅ Keep-alive mechanism started successfully');
        }, 30000);
    } else {
        console.log('🟡 Keep-alive mechanism disabled (local development)');
    }
});