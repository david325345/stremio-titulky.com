const express = require('express');
const { addonBuilder, serveHTTP } = require('stremio-addon-sdk');
const TitulkyClient = require('./lib/TitulkyClient');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static('public'));

const createManifest = (config = {}) => ({
  id: 'community.titulky.com',
  version: '1.0.0',
  name: 'Titulky.com',
  description: 'Czech and Slovak subtitles from Titulky.com',
  resources: ['subtitles'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
  behaviorHints: {
    configurable: true,
    configurationRequired: false
  }
});

const createAddon = (config) => {
  const manifest = createManifest(config);
  const builder = new addonBuilder(manifest);

  builder.defineSubtitlesHandler(async (args) => {
    try {
      const { type, id } = args;
      const imdbId = id.replace('tt', '');
      
      console.log(`[Subtitles] Type: ${type}, IMDB: ${imdbId}`);
      
      const client = new TitulkyClient(config);
      
      if (config.username && config.password) {
        const loginSuccess = await client.login(config.username, config.password);
        if (!loginSuccess) {
          console.error('[Login] Failed');
          return { subtitles: [] };
        }
      }
      
      const subtitles = await client.search({ type, imdbId });
      
      console.log(`[Search] Found ${subtitles.length} subtitles`);
      
      const baseUrl = process.env.BASE_URL || `http://localhost:${process.env.PORT || 3000}`;
      const configEncoded = Buffer.from(JSON.stringify(config)).toString('base64');
      
      const stremioSubtitles = subtitles.map(sub => {
        const filename = sub.version || sub.title || 'subtitle';
        return {
          id: `${configEncoded}:${sub.id}:${sub.link_file}`,
          url: `${baseUrl}/subtitle/${configEncoded}/${sub.id}/${encodeURIComponent(sub.link_file)}.srt`,
          lang: sub.lang === 'Czech' ? 'ces' : sub.lang === 'Slovak' ? 'slk' : 'ces',
        };
      });
      
      return { subtitles: stremioSubtitles };
      
    } catch (error) {
      console.error('[Error]', error);
      return { subtitles: [] };
    }
  });

  return builder.getInterface();
};

app.get('/', (req, res) => {
  res.send(`
<!DOCTYPE html>
<html lang="cs">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Titulky.com - Stremio Addon</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        body {
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            display: flex;
            align-items: center;
            justify-content: center;
            padding: 20px;
        }
        .container {
            background: white;
            border-radius: 20px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.3);
            max-width: 500px;
            width: 100%;
            padding: 40px;
        }
        h1 {
            color: #333;
            margin-bottom: 10px;
            font-size: 28px;
        }
        .subtitle {
            color: #666;
            margin-bottom: 30px;
            font-size: 14px;
        }
        .form-group {
            margin-bottom: 20px;
        }
        label {
            display: block;
            margin-bottom: 8px;
            color: #333;
            font-weight: 500;
            font-size: 14px;
        }
        input {
            width: 100%;
            padding: 12px 16px;
            border: 2px solid #e0e0e0;
            border-radius: 8px;
            font-size: 15px;
            transition: border-color 0.3s;
        }
        input:focus {
            outline: none;
            border-color: #667eea;
        }
        button {
            width: 100%;
            padding: 14px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            border: none;
            border-radius: 8px;
            font-size: 16px;
            font-weight: 600;
            cursor: pointer;
            transition: transform 0.2s, box-shadow 0.2s;
        }
        button:hover {
            transform: translateY(-2px);
            box-shadow: 0 10px 20px rgba(102, 126, 234, 0.4);
        }
        button:active {
            transform: translateY(0);
        }
        .info {
            margin-top: 30px;
            padding: 16px;
            background: #f5f5f5;
            border-radius: 8px;
            font-size: 13px;
            color: #666;
            line-height: 1.6;
        }
        .info strong {
            color: #333;
        }
        .logo {
            width: 60px;
            height: 60px;
            margin: 0 auto 20px;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            border-radius: 15px;
            display: flex;
            align-items: center;
            justify-content: center;
            font-size: 30px;
        }
        .no-account {
            margin-top: 20px;
            padding: 16px;
            background: #fff3cd;
            border: 1px solid #ffc107;
            border-radius: 8px;
            font-size: 13px;
            color: #856404;
        }
        .no-account button {
            margin-top: 10px;
            background: #6c757d;
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="logo">📝</div>
        <h1>Titulky.com Addon</h1>
        <p class="subtitle">České a slovenské titulky pro Stremio</p>
        
        <form id="configForm">
            <div class="form-group">
                <label for="username">Uživatelské jméno (Titulky.com)</label>
                <input type="text" id="username" name="username" required placeholder="Vaše přihlašovací jméno">
            </div>
            
            <div class="form-group">
                <label for="password">Heslo</label>
                <input type="password" id="password" name="password" required placeholder="Vaše heslo">
            </div>
            
            <button type="submit">Instalovat do Stremio</button>
        </form>
        
        <div class="no-account">
            <strong>Funguje i bez přihlášení!</strong><br>
            Můžete vyhledávat titulky bez účtu, ale stahování vyžaduje Premium účet.
            <button onclick="installWithoutLogin()">Instalovat bez přihlášení</button>
        </div>
        
        <div class="info">
            <strong>ℹ️ Informace:</strong><br>
            • Vyžaduje <strong>Premium účet</strong> na Titulky.com pro stahování<br>
            • Podporuje české a slovenské titulky<br>
            • Automatické vyhledávání podle IMDB<br>
            • Vaše údaje jsou uloženy pouze v URL addonu
        </div>
    </div>

    <script>
        document.getElementById('configForm').addEventListener('submit', function(e) {
            e.preventDefault();
            
            const username = document.getElementById('username').value;
            const password = document.getElementById('password').value;
            
            const config = btoa(JSON.stringify({ username, password }));
            const manifestUrl = window.location.origin + '/' + config + '/manifest.json';
            const installUrl = 'stremio://' + manifestUrl;
            
            window.location.href = installUrl;
        });
        
        function installWithoutLogin() {
            const config = btoa(JSON.stringify({ username: '', password: '' }));
            const manifestUrl = window.location.origin + '/' + config + '/manifest.json';
            const installUrl = 'stremio://' + manifestUrl;
            window.location.href = installUrl;
        }
    </script>
</body>
</html>
  `);
});

app.get('/subtitle/:config/:id/:linkFile.srt', async (req, res) => {
  try {
    const { config, id, linkFile } = req.params;
    
    const configData = JSON.parse(Buffer.from(config, 'base64').toString());
    
    console.log(`[Download] ID: ${id}, Link: ${linkFile}`);
    
    const client = new TitulkyClient(configData);
    
    if (configData.username && configData.password) {
      await client.login(configData.username, configData.password);
    }
    
    const srtContent = await client.download(id, decodeURIComponent(linkFile));
    
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Disposition', 'inline; filename="subtitle.srt"');
    res.send(srtContent);
    
  } catch (error) {
    console.error('[Download Error]', error);
    res.status(500).send('Error downloading subtitle');
  }
});

app.get('/:config/manifest.json', (req, res) => {
  try {
    const configStr = req.params.config;
    const config = JSON.parse(Buffer.from(configStr, 'base64').toString());
    const manifest = createManifest(config);
    res.json(manifest);
  } catch (error) {
    res.json(createManifest());
  }
});

app.get('/:config/subtitles/:type/:id.json', async (req, res) => {
  try {
    const configStr = req.params.config;
    const config = JSON.parse(Buffer.from(configStr, 'base64').toString());
    const addon = createAddon(config);
    
    const result = await addon.subtitles.get({
      type: req.params.type,
      id: req.params.id,
      extra: req.query
    });
    
    res.json(result);
  } catch (error) {
    console.error(error);
    res.json({ subtitles: [] });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Titulky.com Stremio Addon running on port ${PORT}`);
});
