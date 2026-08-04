# Crypto Prediction Engine

Server-side Coinbase prediction feed + optional Kalshi trading bot, with a dashboard UI.

## Important: always-on behavior

The **Node server** (`server.js`) owns:

- Coinbase websocket + candle seeding
- Prediction recompute loop
- Kalshi bot cycles (when `KALSHI_ENABLED=true`)

Closing the browser does **not** stop trading or predictions. Keep `node server.js` running (Render Web Service, VPS systemd, etc.).

```bash
npm install
cp .env.example .env   # edit as needed
npm start
```

## Render Web Service (recommended for always-on)

Yes — use a **Web Service**, not a static site. The bot only runs while `node server.js` is alive.

### Why settings reset after restart

Dashboard settings / paper ledger / credentials are saved as files under `DATA_DIR`.

Render’s default disk is **ephemeral**: every deploy or restart wipes local files, so the bot boots with defaults again. That is expected without a Persistent Disk.

### Fix: attach a Persistent Disk

1. In the Render service → **Disks** → add a disk (e.g. 1 GB).
2. Mount path: `/var/data`
3. Environment → add:
   - `DATA_DIR=/var/data`
   - `KALSHI_ENABLED=true` (if you want the bot on)
   - plus any Kalshi live-trading vars you need
4. Redeploy.

After that, **Save settings** in the dashboard writes to `/var/data/bot-config.json` and survives restarts.

Check `/api/health` — you want `"dataDirFromEnv": true` and after saving settings `"configFileExists": true`.

### Optional: bake defaults into env

You can also set starting defaults via env (the dashboard can still override them once `DATA_DIR` persists):

- `KALSHI_SYMBOL`, `KALSHI_EDGE_THRESHOLD_PCT`, `KALSHI_MIN_CONFIDENCE`, etc. (see `bot.js` / server boot)

## Dashboard windows

At most **3** browser windows: best crypto, second-best, bot. Use **Open other windows**.

## Backtests

Bot settings: **1 / 2 / 3 day** runs, plus **Auto** and **Hunt best**.
