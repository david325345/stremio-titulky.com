const axios = require('axios');
const cheerio = require('cheerio');
const iconv = require('iconv-lite');
const { IMDB } = require('node-imdb-api');

class TitulkyClient {
  constructor(config = {}) {
    this.serverUrl = 'https://www.titulky.com';
    this.username = config.username || '';
    this.password = config.password || '';
    this.cookies = {};
    this.imdb = new IMDB({ apiKey: process.env.OMDB_API_KEY || '' });
  }

  async login(username, password) {
    try {
      console.log('[Login] Attempting login...');
      
      const formData = new URLSearchParams({
        'Login': username,
        'Password': password,
        'foreverlog': '0',
        'Detail2': ''
      });

      const response = await axios.post(`${this.serverUrl}/index.php`, formData.toString(), {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'Origin': this.serverUrl
        },
        maxRedirects: 5,
        validateStatus: () => true
      });

      if (response.data.includes('BadLogin')) {
        console.log('[Login] Bad credentials');
        return false;
      }

      const setCookie = response.headers['set-cookie'];
      if (setCookie) {
        setCookie.forEach(cookie => {
          const crcMatch = cookie.match(/CRC=([^;]+)/);
          const loginMatch = cookie.match(/LogonLogin=([^;]+)/);
          const idMatch = cookie.match(/LogonId=([^;]+)/);
          
          if (crcMatch) this.cookies.CRC = crcMatch[1];
          if (loginMatch) this.cookies.LogonLogin = loginMatch[1];
          if (idMatch) this.cookies.LogonId = idMatch[1];
        });
      }

      console.log('[Login] Success');
      return true;
      
    } catch (error) {
      console.error('[Login] Error:', error.message);
      return false;
    }
  }

  async getMetadataFromIMDB(imdbId) {
    try {
      const response = await axios.get(`https://www.omdbapi.com/?i=tt${imdbId}&apikey=${process.env.OMDB_API_KEY || '46f67a03'}`);
      return response.data;
    } catch (error) {
      console.error('[IMDB] Error fetching metadata:', error.message);
      return null;
    }
  }

  async search(searchQuery) {
    try {
      const { type, imdbId } = searchQuery;
      
      // Získáme metadata z IMDB
      const metadata = await this.getMetadataFromIMDB(imdbId);
      if (!metadata || metadata.Response === 'False') {
        console.log('[Search] No metadata found for IMDB:', imdbId);
        return [];
      }

      let searchTitle = metadata.Title;
      
      // Pro seriály přidáme informaci o sérii/epizodě
      if (type === 'series' && metadata.Season && metadata.Episode) {
        searchTitle = `${searchTitle} S${String(metadata.Season).padStart(2, '0')}E${String(metadata.Episode).padStart(2, '0')}`;
      }

      console.log('[Search] Searching for:', searchTitle);

      const searchUrl = `${this.serverUrl}/index.php?${new URLSearchParams({
        'Fulltext': searchTitle,
        'FindUser': ''
      })}`;

      const response = await axios.get(searchUrl, {
        headers: this.getCookieHeader(),
        responseType: 'arraybuffer'
      });

      const html = iconv.decode(Buffer.from(response.data), 'utf-8');
      const $ = cheerio.load(html);

      const subtitles = [];
      
      $('tr.r0, tr.r1').each((index, element) => {
        try {
          const $row = $(element);
          const cells = $row.find('td');

          if (cells.length < 9) return;

          const linkHref = $(cells[0]).find('a').attr('href');
          if (!linkHref) return;

          const linkMatch = linkHref.match(/([\w-]+)-(\d+)\.htm/);
          if (!linkMatch) return;

          const title = $(cells[0]).find('a').text().trim();
          const version = $(cells[0]).find('a').attr('title') || '';
          const seasonEpisode = $(cells[1]).text().trim();
          const year = $(cells[2]).text().trim();
          const downloadCount = parseInt($(cells[3]).text().trim()) || 0;
          
          const langImg = $(cells[4]).find('img');
          let lang = langImg.attr('alt');
          
          if (lang === 'CZ') lang = 'Czech';
          if (lang === 'SK') lang = 'Slovak';
          
          const sizeText = $(cells[6]).text().trim();
          const size = parseFloat(sizeText) || null;
          
          const author = $(cells[7]).find('a').text().trim() || null;

          subtitles.push({
            id: linkMatch[2],
            link_file: linkMatch[1],
            title: title,
            version: version,
            season_and_episode: seasonEpisode !== '&nbsp;' ? seasonEpisode : null,
            year: year !== '&nbsp;' ? year : null,
            down_count: downloadCount,
            lang: lang,
            size: size,
            author: author
          });
          
        } catch (err) {
          console.error('[Parse] Row error:', err.message);
        }
      });

      console.log(`[Search] Found ${subtitles.length} subtitles`);
      return subtitles;

    } catch (error) {
      console.error('[Search] Error:', error.message);
      return [];
    }
  }

  async download(subId, linkFile) {
    try {
      console.log('[Download] Starting download:', subId);

      const timestamp = Math.floor(Date.now() / 1000);
      const downloadUrl = `${this.serverUrl}/idown.php?${new URLSearchParams({
        'R': timestamp.toString(),
        'titulky': subId,
        'histstamp': '',
        'zip': 'z'
      })}`;

      const response = await axios.get(downloadUrl, {
        headers: this.getCookieHeader(),
        maxRedirects: 5,
        responseType: 'arraybuffer'
      });

      const html = iconv.decode(Buffer.from(response.data), 'utf-8');

      // Zkontrolujeme CAPTCHA
      if (html.includes('captcha/captcha.php')) {
        console.log('[Download] CAPTCHA required - not implemented yet');
        throw new Error('CAPTCHA required');
      }

      // Najdeme countdown čas
      const countdownMatch = html.match(/CountDown\((\d+)\)/);
      const waitTime = countdownMatch ? parseInt(countdownMatch[1]) : 0;

      if (waitTime > 0) {
        console.log(`[Download] Waiting ${waitTime} seconds...`);
        await new Promise(resolve => setTimeout(resolve, waitTime * 1000));
      }

      // Najdeme download link
      const linkMatch = html.match(/id="downlink" href="([^"]+)"/);
      if (!linkMatch) {
        throw new Error('Download link not found');
      }

      const finalUrl = this.serverUrl + linkMatch[1];
      console.log('[Download] Downloading from:', finalUrl);

      const fileResponse = await axios.get(finalUrl, {
        headers: {
          ...this.getCookieHeader(),
          'Referer': downloadUrl
        },
        responseType: 'arraybuffer'
      });

      // Rozbalíme ZIP a najdeme SRT soubor
      const AdmZip = require('adm-zip');
      const zip = new AdmZip(Buffer.from(fileResponse.data));
      const zipEntries = zip.getEntries();

      for (const entry of zipEntries) {
        const ext = entry.entryName.toLowerCase().split('.').pop();
        if (['srt', 'sub', 'txt', 'ass', 'ssa', 'smi'].includes(ext)) {
          const content = zip.readAsText(entry);
          console.log('[Download] Success');
          return content;
        }
      }

      throw new Error('No subtitle file found in archive');

    } catch (error) {
      console.error('[Download] Error:', error.message);
      throw error;
    }
  }

  getCookieHeader() {
    const cookieString = Object.entries(this.cookies)
      .map(([key, value]) => `${key}=${value}`)
      .join('; ');

    return cookieString ? { 'Cookie': cookieString } : {};
  }
}

module.exports = TitulkyClient;
