# Crypto Prediction Engine

Server-side Coinbase prediction feed + optional Kalshi trading bot, with a dashboard UI.

## Important: VPS / always-on behavior

The **Node server** (`server.js`) owns:

- Coinbase websocket + candle seeding
- Prediction recompute loop
- Kalshi bot cycles (when `KALSHI_ENABLED=true`)

Closing the browser does **not** stop trading or predictions. Keep `node server.js` (or the systemd unit) running on the VPS.

```bash
cd crypto-prediction-engine
cp .env.example .env   # edit as needed
npm install
npm start
```

Systemd example: `deploy/crypto-prediction-engine.service`

## Dashboard windows

At most **3** browser windows:

1. Best crypto
2. Second-best crypto
3. Bot

Use **Open other windows** to spawn the companion views (capped at 3 total).

## Backtests

In bot settings: **1 day / 2 days / 3 days** (24h / 48h / 72h).
