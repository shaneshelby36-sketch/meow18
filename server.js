'use strict';
const SERVER_START_TIME = Date.now();
const path = require("path");
const fs = require("fs");
require('dotenv').config();
const express = require('express');
const cors = require('cors');

const { CandleSeries, fetchHistoricalRange } = require('./candles');
const { OrderBook } = require('./orderBook');
const { CoinbaseFeed } = require('./coinbaseFeed');
const { buildPredictions } = require('./prediction');
const { PredictionTracker } = require('./tracker');
const { SignalAccumulatorManager } = require('./signalAccumulator');
const { KalshiClient } = require('./kalshiClient');
const { TradingBot, SERIES_BY_SYMBOL } = require('./bot');
const { backtestSymbol } = require('./backtest');

const tracker = new PredictionTracker();

// Half-lives roughly scaled to each window's own horizon: the 0-5 min
// window forgets old signal pressure fastest (little time left for a stale
// reading to matter), the 10-15 min window holds onto it longest.
const signalAccumulatorManager = new SignalAccumulatorManager({
  w5: 2 * 60 * 1000,
  w10: 4 * 60 * 1000,
  w15: 7 * 60 * 1000,
});

// ---------- Kalshi bot setup ----------
// SAFETY: two separate switches must both be set for real orders to ever be
// placed. Missing either one (or misconfigured credentials) means the bot
// runs in paper mode against live Kalshi prices — no real money moves.
const KALSHI_ENABLED = (process.env.KALSHI_ENABLED || 'false').toLowerCase() === 'true';
const LIVE_TRADING_REQUESTED = (process.env.KALSHI_LIVE_TRADING || 'false').toLowerCase() === 'true';
const LIVE_TRADING_CONFIRMED = process.env.KALSHI_LIVE_TRADING_CONFIRM === 'I_UNDERSTAND_THE_RISK';

const kalshiClient = new KalshiClient({
  baseUrl: process.env.KALSHI_BASE_URL,
  keyId: process.env.KALSHI_API_KEY_ID,
  privateKeyPath: process.env.KALSHI_PRIVATE_KEY_PATH,
});

// Lets Kalshi API credentials be entered from the dashboard instead of only
// via env vars/a key file on disk. Stored in plaintext in the data/ folder
// alongside the trading ledger — reasonable for a personal, single-user
// deployment, but worth knowing: anyone with server disk access could read
// it. Never sent back to the client once saved — only whether it's set.
const CREDENTIALS_PATH = path.join(__dirname, 'data', 'kalshi-credentials.json');

function loadSavedCredentials() {
  try {
    if (fs.existsSync(CREDENTIALS_PATH)) {
      const saved = JSON.parse(fs.readFileSync(CREDENTIALS_PATH, 'utf8'));
      kalshiClient.setCredentials(saved);
      console.log('[kalshi] loaded previously-saved API credentials from disk');
    }
  } catch (err) {
    console.error('[kalshi] failed to load saved credentials:', err.message);
  }
}
loadSavedCredentials();

function saveCredentials({ keyId, privateKeyPem }) {
  fs.mkdirSync(path.dirname(CREDENTIALS_PATH), { recursive: true });
  fs.writeFileSync(CREDENTIALS_PATH, JSON.stringify({ keyId, privateKeyPem }, null, 2));
}

const wantsLive = LIVE_TRADING_REQUESTED && LIVE_TRADING_CONFIRMED && kalshiClient.hasCredentials;
if (LIVE_TRADING_REQUESTED && !wantsLive) {
  console.warn(
    '[bot] KALSHI_LIVE_TRADING=true but live trading is NOT active — ' +
      'requires KALSHI_LIVE_TRADING_CONFIRM=I_UNDERSTAND_THE_RISK and valid API credentials. Running in paper mode.'
  );
}

const bot = KALSHI_ENABLED
  ? new TradingBot({
      kalshiClient,
      config: {
        symbol: (process.env.KALSHI_SYMBOL || 'BTC').toUpperCase(),
        edgeThresholdPct: parseFloat(process.env.KALSHI_EDGE_THRESHOLD_PCT || '8'),
        minConfidence: parseFloat(process.env.KALSHI_MIN_CONFIDENCE || '55'),
        stopLossCents: parseInt(process.env.KALSHI_STOP_LOSS_CENTS || '35', 10),
        stakeDollars: parseFloat(process.env.KALSHI_STAKE_DOLLARS || '10'),
        maxOpenPositions: parseInt(process.env.KALSHI_MAX_OPEN_POSITIONS || '1', 10),
        skimMode: process.env.KALSHI_SKIM_MODE || 'fixed',
        skimFixedDollars: parseFloat(process.env.KALSHI_SKIM_FIXED_DOLLARS || '5'),
        skimPercent: parseFloat(process.env.KALSHI_SKIM_PERCENT || '20'),
        mode: wantsLive ? 'live' : 'paper',
        // Fixed ceiling for this process's lifetime, set only from the
        // server-side env vars — never editable from the dashboard. The
        // dashboard can pause/resume between paper and live at runtime,
        // but can never raise this ceiling; if it's false, live mode is
        // completely unreachable no matter what the UI requests.
        liveAuthorized: wantsLive,
      },
    })
  : null;

if (KALSHI_ENABLED) {
  console.log(`[bot] Kalshi bot enabled in ${wantsLive ? 'LIVE' : 'paper'} mode, trading ${(process.env.KALSHI_SYMBOL || 'BTC').toUpperCase()}`);
}

const PORT = parseInt(process.env.PORT || '4000', 10);
const PRODUCTS = (process.env.PRODUCTS || 'BTC-USD,XRP-USD,ETH-USD,SOL-USD,DOGE-USD,BNB-USD,ZEC-USD').split(',').map((s) => s.trim());
const COMPUTE_INTERVAL_MS = parseInt(process.env.COMPUTE_INTERVAL_MS || '5000', 10);
const CORS_ORIGIN = process.env.CORS_ORIGIN || '*';

const SYMBOL_OF = {
  'BTC-USD': 'BTC',
  'XRP-USD': 'XRP',
  'ETH-USD': 'ETH',
  'SOL-USD': 'SOL',
  'DOGE-USD': 'DOGE',
  'BNB-USD': 'BNB',
  'ZEC-USD': 'ZEC',
};

const state = {}; // e.g. state.BTC = { productId, series, book, lastTradeAt }
for (const productId of PRODUCTS) {
  const symbol = SYMBOL_OF[productId] || productId;
  state[symbol] = {
    productId,
    series: new CandleSeries(productId),
    book: new OrderBook(productId),
    lastTradeAt: null,
    feedStatus: 'connecting',
  };
}

let latestPrediction = { ready: false, message: 'Seeding historical data, please wait…' };
let lastComputeError = null;

async function seedAll() {
  await Promise.all(Object.values(state).map((s) => s.series.seed()));
}

function wireFeed() {
  const feed = new CoinbaseFeed(PRODUCTS);

  feed.on('connected', () => {
    console.log('[feed] connected to Coinbase WebSocket');
    for (const s of Object.values(state)) s.feedStatus = 'live';
  });

  feed.on('disconnected', () => {
    console.warn('[feed] disconnected — will retry with backoff');
    for (const s of Object.values(state)) s.feedStatus = 'reconnecting';
  });

  feed.on('error', (err) => {
    console.error('[feed] error:', err.message);
  });

  feed.on('trade', (trade) => {
    const symbol = SYMBOL_OF[trade.productId] || trade.productId;
    const s = state[symbol];
    if (!s) return;
    s.series.addTrade(trade.price, trade.size, trade.time);
    s.lastTradeAt = trade.time;
  });

  feed.on('l2snapshot', (snap) => {
    const symbol = SYMBOL_OF[snap.productId] || snap.productId;
    const s = state[symbol];
    if (!s) return;
    s.book.loadSnapshot(snap.bids, snap.asks);
  });

  feed.on('l2update', (upd) => {
    const symbol = SYMBOL_OF[upd.productId] || upd.productId;
    const s = state[symbol];
    if (!s) return;
    for (const [side, price, size] of upd.changes) {
      s.book.applyChange(side, price, size);
    }
  });

  feed.connect();
  return feed;
}

// Fetches the real, live Kalshi strike price + close time for each symbol's
// current rolling 15-minute market. This is public market data (no API
// credentials needed) so it runs regardless of whether the trading bot
// itself is enabled — it's purely for showing the one real target price
// the dashboard displays, and for computing probabilities relative to it.
// Fetches the real, live Kalshi strike price + close time for each symbol's
// current rolling 15-minute market. Falls back gracefully if the bot module
// didn't export SERIES_BY_SYMBOL or if Kalshi is unavailable.
async function fetchKalshiTargets() {
  const targets = {};

  const series =
    SERIES_BY_SYMBOL && typeof SERIES_BY_SYMBOL === "object"
      ? SERIES_BY_SYMBOL
      : {
          BTC: "KXBTC15M",
          XRP: "KXXRP15M",
        };

  await Promise.all(
    Object.entries(series).map(async ([symbol, ticker]) => {
      try {
        const markets = await kalshiClient.getOpenMarkets(ticker, 1);

        if (Array.isArray(markets) && markets.length > 0) {
          const m = markets[0];

          targets[symbol] = {
            price: m.floor_strike,
            closeTime: new Date(m.close_time).getTime(),
            ticker: m.ticker,
          };
        }
      } catch (err) {
        console.warn(
          `[kalshi-target] ${symbol}: ${err.message} (using fallback timer)`
        );
      }
    })
  );

  return targets;
}

let recomputeInFlight = false;

async function recompute() {
  if (recomputeInFlight) return; // guard against overlapping runs if a cycle takes longer than the interval
  recomputeInFlight = true;
  try {
    const input = {};
    for (const [symbol, s] of Object.entries(state)) {
      input[symbol] = { series: s.series, book: s.book };
    }

    const kalshiTargets = await fetchKalshiTargets();
    const result = buildPredictions(input, kalshiTargets, signalAccumulatorManager);
    result.feedStatus = Object.fromEntries(
      Object.entries(state).map(([sym, s]) => [sym, s.feedStatus])
    );

    // Feed each ready symbol through the tracker once — all three windows
    // (0-5/5-10/10-15 min) share the same target price and the same real
    // Kalshi clock, rather than each running its own independent timer.
    const now = Date.now();
    const FIFTEEN_MIN_MS = 15 * 60 * 1000;
    for (const [symbol, assetResult] of Object.entries(result)) {
      if (!assetResult || !assetResult.ready || !assetResult.windows) continue;

      // Graceful fallback when no live Kalshi market was found: synthesize a
      // ticker/close time that still rotates every real 15 minutes (aligned
      // to the wall clock), so tracking still works, just without being
      // phase-matched to Kalshi's actual window boundaries.
      let ticker = assetResult.kalshiTicker;
      let closeTime = assetResult.targetCloseTime;
      if (!ticker || !closeTime) {
        const bucketStart = Math.floor(now / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
        ticker = `FALLBACK-${symbol}-${bucketStart}`;
        closeTime = bucketStart + FIFTEEN_MIN_MS;
        // Keep the asset-level close time in sync with whichever clock is
        // actually driving the windows, so the big top-level countdown never
        // shows blank while the per-window countdowns underneath are ticking.
        assetResult.targetCloseTime = closeTime;
      }

      const trackerOutput = tracker.update(symbol, {
        ticker,
        targetPrice: assetResult.targetPrice,
        closeTime,
        currentPrice: assetResult.price,
        windows: assetResult.windows,
        now,
      });

      for (const windowKey of Object.keys(assetResult.windows)) {
        const w = assetResult.windows[windowKey];
        const t = trackerOutput[windowKey];
        w.tracking = t.tracking;
        w.lastResult = t.lastResult;
        w.accuracy = t.accuracy;
        w.history = t.history;
      }
    }

    latestPrediction = result;
    lastComputeError = null;

    if (bot) {
      await bot.runCycle(result).catch((err) => {
        console.error('[bot] cycle error:', err.message);
      });
    }
  } catch (err) {
    lastComputeError = err.message;
    console.error('[predict] compute failed:', err);
  } finally {
    recomputeInFlight = false;
  }
}

async function main() {
  console.log('[startup] seeding historical candles from Coinbase REST API…');
  await seedAll();
  for (const [symbol, s] of Object.entries(state)) {
    console.log(`[startup] ${symbol}: seeded ${s.series.candles.length} candles`);
  }

  wireFeed();

  // First compute as soon as we have enough seeded history; then on an interval.
  await recompute();
  setInterval(recompute, COMPUTE_INTERVAL_MS);

  const app = express();
  app.use(cors({ origin: CORS_ORIGIN === '*' ? true : CORS_ORIGIN.split(',') }));
  app.use(express.json());
  app.use(express.static(__dirname));

app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "index.html"));
});
  app.get('/api/latest', (req, res) => {
    res.json(latestPrediction);
  });

  app.get('/api/health', (req, res) => {
    res.json({
      ok: true,
      lastComputeError,
      feedStatus: Object.fromEntries(Object.entries(state).map(([sym, s]) => [sym, s.feedStatus])),
      candleCounts: Object.fromEntries(Object.entries(state).map(([sym, s]) => [sym, s.series.candles.length])),
      computeIntervalMs: COMPUTE_INTERVAL_MS,
      botEnabled: !!bot,
      botRunning: bot ? bot.isRunning : false,
      // Predictions + bot cycles run inside this Node process on a timer.
      // Closing the browser/dashboard does not pause them.
      dashboardIndependent: true,
      uptimeMs: Date.now() - SERVER_START_TIME,
      time: new Date().toISOString(),
    });
  });

  app.get('/api/bot/status', (req, res) => {
    if (!bot) {
      res.json({
        enabled: false,
        message: 'Set KALSHI_ENABLED=true to turn on the trading bot (paper mode by default). The engine keeps running on the server either way — the dashboard is only a viewer/control panel.',
      });
      return;
    }
    res.json({
      enabled: true,
      dashboardIndependent: true,
      ...bot.status(),
    });
  });

  app.get('/api/bot/calibration', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    res.json(bot.calibrationReport());
  });

  // Engine-level calibration: every prediction the engine has ever made for
  // this symbol, whether or not the bot actually traded it — a broader,
  // complementary view to /api/bot/calibration (which only covers actual
  // trades). Answers "how trustworthy is a given confidence level in this
  // system overall" rather than "how have my actual bets performed."
  app.get('/api/calibration', (req, res) => {
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    res.json({ symbol, windows: tracker.getCalibration(symbol) });
  });

  app.get('/api/kalshi/credentials-status', (req, res) => {
    res.json({
      configured: kalshiClient.hasCredentials,
      keyIdPreview: kalshiClient.keyId ? `${kalshiClient.keyId.slice(0, 6)}…` : null,
    });
  });

  app.post('/api/kalshi/credentials', (req, res) => {
    const { keyId, privateKeyPem } = req.body || {};
    if (!keyId && !privateKeyPem) {
      res.status(400).json({ error: 'Provide at least a keyId or privateKeyPem.' });
      return;
    }
    try {
      kalshiClient.setCredentials({ keyId, privateKeyPem });
      saveCredentials({ keyId: keyId || kalshiClient.keyId, privateKeyPem: privateKeyPem || kalshiClient.privateKey });
      res.json({ ok: true, configured: kalshiClient.hasCredentials });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/bot/config', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    res.json({ config: bot.config });
  });

  app.post('/api/bot/config', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const result = bot.updateConfig(req.body || {});
    res.json(result);
  });

  app.post('/api/bot/reset-paper', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const result = bot.resetPaperState();
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/bot/running', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const result = bot.setRunning((req.body || {}).running);
    res.status(result.ok ? 200 : 400).json(result);
  });

  app.post('/api/bot/mode', (req, res) => {
    if (!bot) {
      res.status(404).json({ enabled: false, message: 'Bot is not enabled (set KALSHI_ENABLED=true).' });
      return;
    }
    const result = bot.setMode((req.body || {}).mode);
    res.status(result.ok ? 200 : 400).json(result);
  });

  const SYMBOL_TO_PRODUCT = { BTC: 'BTC-USD', XRP: 'XRP-USD', ETH: 'ETH-USD', SOL: 'SOL-USD', DOGE: 'DOGE-USD', BNB: 'BNB-USD', ZEC: 'ZEC-USD' };
  const MAX_BACKTEST_HOURS = 72;

  app.get('/api/backtest', async (req, res) => {
    const symbol = (req.query.symbol || 'BTC').toUpperCase();
    let hours = parseFloat(req.query.hours || '24');
    if (!SYMBOL_TO_PRODUCT[symbol]) {
      res.status(400).json({ error: `Unknown symbol '${symbol}'. Use BTC or XRP.` });
      return;
    }
    if (!hours || hours <= 0) hours = 24;
    if (hours > MAX_BACKTEST_HOURS) hours = MAX_BACKTEST_HOURS;

    try {
      console.log(`[backtest] fetching ${hours}h of ${symbol} history…`);
      const candles = await fetchHistoricalRange(SYMBOL_TO_PRODUCT[symbol], hours);
      console.log(`[backtest] running walk-forward backtest over ${candles.length} candles…`);
      const results = backtestSymbol(candles, { stepMinutes: 1 });
      res.json({
        symbol,
        hoursRequested: hours,
        candleCount: candles.length,
        note: 'Order book imbalance/spread/liquidity signals are not included — no historical order-book data exists to replay them. illustrativeReturnPct assumes every trade could be placed at even-money (50¢) odds, which real Kalshi prices almost never are — it shows whether the directional call beats a coin flip, not a real profit projection.',
        windows: results,
      });
    } catch (err) {
      console.error('[backtest] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.listen(PORT, () => {
    console.log(`[startup] prediction engine API listening on http://0.0.0.0:${PORT}`);
    console.log(`[startup] compute loop every ${COMPUTE_INTERVAL_MS / 1000}s — continues whether or not any dashboard is open`);
    if (bot) {
      console.log(`[startup] trading bot is ${bot.isRunning ? 'RUNNING' : 'STOPPED'} on the server (dashboard is optional)`);
    }
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
