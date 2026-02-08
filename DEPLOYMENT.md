# Nasazení na Render.com

## 1. Příprava

1. Nahrajte kód do GitHub repozitáře
2. Zaregistrujte se na https://render.com

## 2. Vytvoření Web Service

1. Klikněte na "New +" a vyberte "Web Service"
2. Připojte váš GitHub repozitář
3. Nastavte následující:
   - Name: `stremio-titulky-addon` (nebo vlastní název)
   - Runtime: `Node`
   - Build Command: `npm install`
   - Start Command: `npm start`
   - Plan: `Free`

## 3. Proměnné prostředí

V sekci "Environment" nastavte:
- `NODE_ENV` = `production`
- `BASE_URL` = `https://your-app-name.onrender.com` (po vytvoření doplňte skutečnou URL)
- `OMDB_API_KEY` = `46f67a03` (nebo vlastní klíč z https://www.omdbapi.com/)

## 4. Deploy

1. Klikněte na "Create Web Service"
2. Počkejte na dokončení buildu (2-5 minut)
3. Po dokončení získáte URL typu: `https://stremio-titulky-addon.onrender.com`

## 5. Aktualizace BASE_URL

1. Vraťte se do nastavení
2. Upravte `BASE_URL` na skutečnou URL vašeho addonu
3. Uložte změny (automaticky se restartuje)

## 6. Instalace do Stremio

1. Otevřete URL vašeho addonu v prohlížeči
2. Vyplňte přihlašovací údaje k Titulky.com
3. Klikněte na "Instalovat do Stremio"
4. Potvrďte instalaci v Stremio

## Poznámky

- Free tier má limit 750 hodin měsíčně
- Service se automaticky vypne po 15 minutách nečinnosti
- První request po nečinnosti může trvat 30-60 sekund (cold start)
- Pro lepší výkon zvažte placený plán

## Troubleshooting

Pokud addon nefunguje:
1. Zkontrolujte logy v Render dashboard
2. Ověřte, že BASE_URL je správně nastavená
3. Otestujte `/manifest.json` endpoint
4. Zkontrolujte platnost OMDB API klíče
