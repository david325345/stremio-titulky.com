const axios = require('axios');
const AdmZip = require('adm-zip');
const he = require('he');
const { URL, URLSearchParams } = require('url');

class TitulkyClient {
  constructor(username, password) {
    this.serverUrl = 'https://www.titulky.com';
    this.username = username;
    this.password = password;
    this.cookies = {};
    this.loggedIn = false;
    this.loginPromise = null;
    this.lastLoginTime = 0;
  }

  // ── Cookie helpers ──────────────────────────────────────────────

  _parseCookiesFromHeaders(headers) {
    const setCookie = headers['set-cookie'];
    if (!setCookie) return;
    const cookieArray = Array.isArray(setCookie) ? setCookie : [setCookie];
    for (const c of cookieArray) {
      const match = c.match(/^([^=]+)=([^;]*)/);
      if (match) {
        this.cookies[match[1].trim()] = match[2].trim();
      }
    }
  }

  _cookieString() {
    return Object.entries(this.cookies)
      .map(([k, v]) => `${k}=${v}`)
      .join('; ');
  }

  // ── HTTP helpers ────────────────────────────────────────────────

  async _request(url, opts = {}) {
    const config = {
      url,
      method: opts.method || 'GET',
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'cs,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate',
        Cookie: this._cookieString(),
        ...opts.headers,
      },
      maxRedirects: 5,
      responseType: opts.responseType || 'text',
      decompress: true,
      validateStatus: () => true,
      timeout: 30000,
    };
    if (opts.data) config.data = opts.data;
    if (opts.referer) config.headers['Referer'] = opts.referer;

    const res = await axios(config);
    this._parseCookiesFromHeaders(res.headers);
    return res;
  }

  // ── Login ───────────────────────────────────────────────────────

  async login() {
    if (this.loggedIn && Date.now() - this.lastLoginTime < 30 * 60 * 1000) {
      return true;
    }
    // Deduplicate concurrent login attempts
    if (this.loginPromise) return this.loginPromise;

    this.loginPromise = this._doLogin();
    try {
      return await this.loginPromise;
    } finally {
      this.loginPromise = null;
    }
  }

  async _doLogin() {
    if (!this.username) return false;
    console.log('[Titulky] Logging in…');

    const params = new URLSearchParams({
      Login: this.username,
      Password: this.password,
      foreverlog: '0',
      Detail2: '',
    });

    const res = await this._request(`${this.serverUrl}/index.php`, {
      method: 'POST',
      data: params.toString(),
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: this.serverUrl,
      },
    });

    const content = typeof res.data === 'string' ? res.data : '';

    if (content.includes('BadLogin')) {
      console.log('[Titulky] Login failed – bad credentials');
      this.loggedIn = false;
      return false;
    }

    this.loggedIn = true;
    this.lastLoginTime = Date.now();
    console.log('[Titulky] Login successful');
    return true;
  }

  // ── Search ──────────────────────────────────────────────────────

  async search(title) {
    await this.login();

    const params = new URLSearchParams({ Fulltext: title, FindUser: '' });
    const url = `${this.serverUrl}/index.php?${params}`;
    console.log(`[Titulky] Searching: ${url}`);

    const res = await this._request(url);
    const content = typeof res.data === 'string' ? res.data : '';

    return this._parseSearchResults(content);
  }

  _parseSearchResults(content) {
    const subtitles = [];
    const rowRe = /<tr class="r(.*?)<\/tr>/gis;
    let rowMatch;

    while ((rowMatch = rowRe.exec(content)) !== null) {
      const row = rowMatch[1];
      try {
        const sub = this._parseRow(row);
        if (sub) subtitles.push(sub);
      } catch (e) {
        // skip unparseable rows
      }
    }

    console.log(`[Titulky] Found ${subtitles.length} subtitles`);
    return subtitles;
  }

  _parseRow(row) {
    // link_file & id
    const linkMatch = row.match(/<td[^<]*<a\s+href="([^"]+?)\.htm"/i);
    if (!linkMatch) return null;
    const linkFile = linkMatch[1];

    const idMatch = linkFile.match(/-([\d]+)$/);
    if (!idMatch) return null;
    const id = idMatch[1];

    // title
    const titleMatch = row.match(/<td[^<]*<a[^>]+>(?:<div[^>]+>)?([^<]+)/i);
    const title = titleMatch ? titleMatch[1].trim() : '';

    // version (release info in title attribute)
    let version = null;
    const versionMatch = row.match(/title="([^"]+)"/i);
    if (versionMatch) version = versionMatch[1];

    // Extract table cells for positional data
    const cells = [];
    const cellRe = /<td[^>]*>(.*?)<\/td>/gis;
    let cellMatch;
    while ((cellMatch = cellRe.exec('<td' + row)) !== null) {
      cells.push(cellMatch[1]);
    }

    // download count (usually 5th cell)
    let downCount = 0;
    if (cells.length > 4) {
      const dcMatch = cells[4].match(/(\d+)/);
      if (dcMatch) downCount = parseInt(dcMatch[1], 10);
    }

    // language (from img alt in 6th cell)
    let lang = null;
    if (cells.length > 5) {
      const langMatch = cells[5].match(/<img\s+alt="(\w{2})"/i);
      if (langMatch) {
        const code = langMatch[1].toUpperCase();
        if (code === 'CZ') lang = 'cze';
        else if (code === 'SK') lang = 'slk';
        else lang = code.toLowerCase();
      }
    }
    if (!lang) return null;

    // size (8th cell)
    let size = null;
    if (cells.length > 7) {
      const sizeMatch = cells[7].match(/([\d.]+)/);
      if (sizeMatch) size = parseFloat(sizeMatch[1]);
    }

    // author (9th cell)
    let author = null;
    if (cells.length > 8) {
      const authorMatch = cells[8].match(/<a[^>]+>([^<]+)/i);
      if (authorMatch) author = authorMatch[1].trim();
    }

    return {
      id,
      linkFile,
      title: he.decode(title),
      version: version ? he.decode(version) : null,
      lang,
      downCount,
      size,
      author,
    };
  }

  // ── Download subtitle ───────────────────────────────────────────

  async downloadSubtitle(subId, linkFile) {
    await this.login();

    console.log(`[Titulky] Starting download for sub ${subId}`);

    // Step 1: Open the download page
    const ts = Math.floor(Date.now() / 1000);
    const params = new URLSearchParams({
      R: String(ts),
      titulky: subId,
      histstamp: '',
      zip: 'z',
    });
    const downloadPageUrl = `${this.serverUrl}/idown.php?${params}`;
    const referer = `https://www.titulky.com/${linkFile}.htm`;

    let res = await this._request(downloadPageUrl, { referer });
    let content = typeof res.data === 'string' ? res.data : '';

    // Step 2: Check for captcha
    const captchaMatch = content.match(/\.\/(captcha\/captcha\.php)/i);
    if (captchaMatch) {
      console.log('[Titulky] Captcha required – cannot solve automatically');
      return null;
    }

    // Step 3: Get wait time
    let waitTime = 0;
    const waitMatch = content.match(/CountDown\((\d+)\)/i);
    if (waitMatch) waitTime = parseInt(waitMatch[1], 10);

    // Step 4: Get download link
    const linkMatch = content.match(/<a[^>]+id="downlink"\s+href="([^"]+)"/i);
    if (!linkMatch) {
      console.log('[Titulky] Download link not found');
      return null;
    }
    const downloadLink = this.serverUrl + linkMatch[1];

    // Step 5: Wait required time
    if (waitTime > 0) {
      console.log(`[Titulky] Waiting ${waitTime}s before download…`);
      await new Promise((r) => setTimeout(r, waitTime * 1000));
    }

    // Step 6: Download the zip
    console.log(`[Titulky] Downloading from ${downloadLink}`);
    const zipRes = await this._request(downloadLink, {
      referer: `${this.serverUrl}/idown.php`,
      responseType: 'arraybuffer',
    });

    if (!zipRes.data || zipRes.data.length < 50) {
      console.log('[Titulky] Downloaded file too small or empty');
      return null;
    }

    // Step 7: Extract subtitles from zip
    return this._extractSubtitles(Buffer.from(zipRes.data));
  }

  _extractSubtitles(zipBuffer) {
    const exts = ['.srt', '.sub', '.txt', '.smi', '.ssa', '.ass'];
    try {
      const zip = new AdmZip(zipBuffer);
      const entries = zip.getEntries();
      const results = [];

      for (const entry of entries) {
        const ext = '.' + entry.entryName.split('.').pop().toLowerCase();
        if (exts.includes(ext) && !entry.isDirectory) {
          results.push({
            filename: entry.entryName,
            content: entry.getData(),
          });
        }
      }

      // Prefer .srt files
      results.sort((a, b) => {
        const aIsSrt = a.filename.toLowerCase().endsWith('.srt') ? 0 : 1;
        const bIsSrt = b.filename.toLowerCase().endsWith('.srt') ? 0 : 1;
        return aIsSrt - bIsSrt;
      });

      console.log(`[Titulky] Extracted ${results.length} subtitle file(s)`);
      return results;
    } catch (e) {
      console.error('[Titulky] Error extracting zip:', e.message);
      return null;
    }
  }
}

module.exports = TitulkyClient;
