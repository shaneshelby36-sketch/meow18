'use strict';

/**
 * Full offline suite — every module, every critical path we can hit without
 * risking real money. Optional live public-API checks with ONLINE=1.
 *
 *   npm test
 *   ONLINE=1 npm test
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cpe-fulltest-'));
process.env.DATA_DIR = tmpDir;
// Keep bot from thinking it's on Render during tests.
delete process.env.RENDER;
delete process.env.RENDER_SERVICE_ID;

const { DATA_DIR, ensureDataDir, dataPath, writeJsonAtomic } = require('./paths');
const indicators = require('./indicators');
const { CandleSeries } = require('./candles');
const { OrderBook } = require('./orderBook');
const { SignalAccumulator, SignalAccumulatorManager } = require('./signalAccumulator');
const { PredictionTracker } = require('./tracker');
const {
  buildPredictions,
  gatherIndicators,
  directionalScore,
  buildWindowPrediction,
  logistic,
  WINDOWS,
} = require('./prediction');
const {
  backtestSymbol,
  backtestWithSettings,
  huntBestSettings,
  normalizeSettings,
  LOOKBACK_MIN,
} = require('./backtest');
const { TradingBot, SERIES_BY_SYMBOL } = require('./bot');
const { KalshiClient, normalizeMarketPrices, priceInCents } = require('./kalshiClient');

const ONLINE = process.env.ONLINE === '1' || process.env.ONLINE === 'true';

let passed = 0;
let failed = 0;
const failures = [];

function check(cond, label) {
  try {
    assert.ok(cond, label);
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    failures.push(label);
    console.error(`  ✗ ${label}${err.message && err.message !== label ? ` — ${err.message}` : ''}`);
  }
}

function checkEq(actual, expected, label) {
  try {
    assert.strictEqual(actual, expected, `${label} (got ${actual}, expected ${expected})`);
    passed += 1;
    console.log(`  ✓ ${label}`);
  } catch (err) {
    failed += 1;
    failures.push(label);
    console.error(`  ✗ ${err.message}`);
  }
}

function section(title) {
  console.log(`\n══ ${title} ══`);
}

function makeCandles(n, { start = 100, drift = 0.08, wobble = 0.4, startTime = Date.now() - n * 60_000 } = {}) {
  const candles = [];
  let price = start;
  for (let i = 0; i < n; i += 1) {
    const open = price;
    const change = drift + Math.sin(i / 9) * wobble;
    const close = Math.max(1, open + change);
    candles.push({
      time: startTime + i * 60_000,
      open,
      high: Math.max(open, close) + 0.3,
      low: Math.min(open, close) - 0.3,
      close,
      volume: 8 + (i % 6) * 3,
    });
    price = close;
  }
  return candles;
}

function seriesFromCandles(candles) {
  const s = new CandleSeries('TEST-USD');
  s.candles = candles.slice();
  return s;
}

function mockClient(market, { failGet = false, openMarkets } = {}) {
  return {
    hasCredentials: false,
    async getMarket() {
      if (failGet) throw new Error('mock network failure');
      return market;
    },
    async getOpenMarkets() {
      if (openMarkets) return openMarkets;
      return market ? [market] : [];
    },
    async createOrder() {
      throw new Error('createOrder must not be called in paper self-test');
    },
    async getBalance() {
      return { balance: 0, portfolio_value: 0 };
    },
  };
}

function makeBot(client, config = {}) {
  // Wipe persisted overrides so earlier updateConfig calls cannot leak into
  // later cases (same DATA_DIR for the whole suite).
  for (const name of ['bot-config.json', 'bot-mode-state.json', 'bot-run-state.json']) {
    try {
      fs.unlinkSync(dataPath(name));
    } catch {
      // ignore
    }
  }
  const bot = new TradingBot({
    kalshiClient: client,
    config: {
      mode: 'paper',
      liveAuthorized: false,
      edgeThresholdPct: 8,
      minConfidence: 55,
      stopLossCents: 35,
      takeProfitCents: 70,
      stakeDollars: 10,
      maxOpenPositions: 1,
      skimMode: 'off',
      skimPercent: 20,
      skimFixedDollars: 5,
      paperStartingBalanceDollars: 100,
      stakingStrategy: 'fixed',
      symbol: 'ETH',
      ...config,
    },
  });
  // Re-apply explicit test config after constructor merge so defaults win.
  Object.assign(bot.config, {
    mode: config.mode || 'paper',
    liveAuthorized: config.liveAuthorized === true,
    edgeThresholdPct: config.edgeThresholdPct ?? 8,
    minConfidence: config.minConfidence ?? 55,
    stopLossCents: config.stopLossCents ?? 35,
    takeProfitCents: config.takeProfitCents ?? 70,
    stakeDollars: config.stakeDollars ?? 10,
    maxOpenPositions: config.maxOpenPositions ?? 1,
    skimMode: config.skimMode ?? 'off',
    skimPercent: config.skimPercent ?? 20,
    skimFixedDollars: config.skimFixedDollars ?? 5,
    paperStartingBalanceDollars: config.paperStartingBalanceDollars ?? 100,
    stakingStrategy: config.stakingStrategy ?? 'fixed',
    symbol: config.symbol ?? 'ETH',
  });
  bot.ledger = { trades: [], reserveCents: 0, periodStartTime: Date.now() };
  bot.calibration = { buckets: {} };
  bot.isRunning = true;
  bot.lastError = null;
  return bot;
}

function openTrade(bot, overrides = {}) {
  const now = Date.now();
  const trade = {
    id: `test-${Math.random().toString(16).slice(2)}`,
    mode: 'paper',
    symbol: 'ETH',
    ticker: 'KXETH15M-TEST',
    side: 'no',
    contracts: 10,
    stakeDollars: 5,
    entryPriceCents: 50,
    floorStrike: 3000,
    openedAt: now - 10 * 60 * 1000,
    windowCloseTime: now + 5 * 60 * 1000,
    engineProbability: 60,
    engineConfidence: 70,
    status: 'open',
    ...overrides,
  };
  bot.ledger.trades.unshift(trade);
  return trade;
}

function win(up, conf) {
  return { probabilityUp: up, probabilityDown: 100 - up, confidence: conf, window: '0-5 min' };
}

function predictions(price, windows = {}) {
  return {
    ETH: {
      ready: true,
      price,
      windows: {
        w5: windows.w5 || win(55, 60),
        w10: windows.w10 || win(55, 60),
        w15: windows.w15 || win(55, 60),
      },
    },
    BTC: {
      ready: true,
      price: price * 20,
      windows: {
        w5: win(55, 60),
        w10: win(55, 60),
        w15: win(55, 60),
      },
    },
  };
}

// ───────────────────────────── paths ─────────────────────────────

function testPaths() {
  section('paths.js');
  ensureDataDir();
  check(DATA_DIR === tmpDir || path.resolve(DATA_DIR) === path.resolve(tmpDir), 'DATA_DIR uses test temp dir');
  const file = dataPath('atomic-check.json');
  writeJsonAtomic(file, { ok: true, n: 42 });
  const read = JSON.parse(fs.readFileSync(file, 'utf8'));
  checkEq(read.ok, true, 'atomic write readable');
  checkEq(read.n, 42, 'atomic write payload intact');
  check(fs.existsSync(dataPath('archive')), 'archive dir created');
}

// ───────────────────────────── indicators ─────────────────────────────

function testIndicators() {
  section('indicators.js');
  const closes = Array.from({ length: 80 }, (_, i) => 100 + i * 0.4 + Math.sin(i / 5));
  const vols = closes.map((_, i) => 10 + (i % 4));
  const candles = closes.map((c, i) => ({
    open: c - 0.1,
    high: c + 0.5,
    low: c - 0.5,
    close: c,
    volume: vols[i],
  }));

  check(Number.isFinite(indicators.sma(closes, 10)), 'sma');
  check(Number.isFinite(indicators.ema(closes, 12)), 'ema');
  check(indicators.emaSeries(closes, 12).length === closes.length, 'emaSeries length');
  const rsi = indicators.rsi(closes, 14);
  check(rsi != null && rsi >= 0 && rsi <= 100, 'rsi in 0..100');
  const macd = indicators.macd(closes);
  check(macd && Number.isFinite(macd.histogram), 'macd histogram');
  check(Number.isFinite(indicators.atr(candles, 14)), 'atr');
  check(Number.isFinite(indicators.momentum(closes, 10)), 'momentum');
  check(Number.isFinite(indicators.volatility(closes, 20)), 'volatility');
  const corr = indicators.correlation(closes, closes.map((c) => c * 1.01), 30);
  check(corr != null && corr > 0.9, 'correlation near 1 on nearly-identical series');
  const trend = indicators.trendStrength(closes);
  check(trend && Number.isFinite(trend.alignment), 'trendStrength');
  check(indicators.volumeSpike(vols, 20) != null, 'volumeSpike');
  check(indicators.candlePattern(candles) && typeof indicators.candlePattern(candles).lean === 'number', 'candlePattern');
  check(indicators.sma([1, 2], 5) == null || !Number.isFinite(indicators.sma([1, 2], 5)), 'sma short series safe');
}

// ───────────────────────────── candles / order book ─────────────────────────────

function testCandlesAndBook() {
  section('candles.js + orderBook.js');
  const series = new CandleSeries('BTC-USD');
  const t0 = Math.floor(Date.now() / 60_000) * 60_000;
  series.addTrade(100, 1, t0 + 1000);
  series.addTrade(101, 2, t0 + 2000);
  checkEq(series.candles.length, 1, 'same-minute trades fold into one candle');
  checkEq(series.latestClose(), 101, 'latestClose updates');
  checkEq(series.candles[0].volume, 3, 'volume accumulates');
  series.addTrade(102, 1, t0 + 60_000 + 500);
  checkEq(series.candles.length, 2, 'new minute opens new candle');
  check(!series.ready(210), 'not ready with few candles');
  series.candles = makeCandles(220);
  check(series.ready(210), 'ready with 220 candles');
  check(series.closes().length === 220, 'closes length');

  const book = new OrderBook('BTC-USD');
  book.loadSnapshot(
    [
      ['100', '2'],
      ['99', '3'],
    ],
    [
      ['101', '1.5'],
      ['102', '4'],
    ]
  );
  check(book.ready, 'order book ready after snapshot');
  checkEq(book.bestBid(), 100, 'bestBid');
  checkEq(book.bestAsk(), 101, 'bestAsk');
  checkEq(book.midPrice(), 100.5, 'midPrice');
  check(book.spread().absolute > 0, 'spread absolute');
  const imb = book.imbalance(5);
  check(imb && Number.isFinite(imb.ratio), 'imbalance ratio');
  check(book.liquidity(5) > 0, 'liquidity > 0');
  book.applyChange('buy', '100', '0');
  check(!book.bids.has(100), 'size 0 removes level');
}

// ───────────────────────────── signal accumulator ─────────────────────────────

function testSignalAccumulator() {
  section('signalAccumulator.js');
  const acc = new SignalAccumulator(60_000);
  const a = acc.update([1, 0.5, -0.2], 1_000_000);
  check(a.upScore > 0 && a.downScore > 0, 'scores accumulate');
  const b = acc.update([0, 0, 0], 1_000_000 + 60_000);
  check(b.upScore < a.upScore, 'half-life decays prior influence');
  const mgr = new SignalAccumulatorManager({ w5: 1000, w10: 2000 });
  check(mgr.get('BTC', 'w5') === mgr.get('BTC', 'w5'), 'manager reuses accumulator');
  check(mgr.get('BTC', 'w5') !== mgr.get('ETH', 'w5'), 'manager isolates symbols');
}

// ───────────────────────────── tracker ─────────────────────────────

function testTracker() {
  section('tracker.js');
  const tracker = new PredictionTracker();
  tracker.cycles = new Map();
  tracker.history = new Map();
  const now = Date.now();
  const closeTime = now + 15 * 60 * 1000;
  const windows = {
    w5: { probabilityUp: 70, probabilityDown: 30 },
    w10: { probabilityUp: 60, probabilityDown: 40 },
    w15: { probabilityUp: 55, probabilityDown: 45 },
  };
  const first = tracker.update('BTC', {
    ticker: 'T1',
    targetPrice: 100,
    closeTime,
    currentPrice: 100,
    windows,
    now,
  });
  check(first.w5.tracking.secondsRemaining > 0, 'tracker countdown positive mid-window');
  checkEq(first.w5.tracking.predictedDirection, 'UP', 'w5 predicted UP');

  // Jump past 5-minute checkpoint with price above strike
  const after5 = tracker.update('BTC', {
    ticker: 'T1',
    targetPrice: 100,
    closeTime,
    currentPrice: 101,
    windows,
    now: now + 5 * 60 * 1000 + 1000,
  });
  check(after5.w5.lastResult != null, 'w5 checkpoint resolved');
  checkEq(after5.w5.lastResult.correct, true, 'w5 correct when price up');

  // New ticker = new cycle
  const next = tracker.update('BTC', {
    ticker: 'T2',
    targetPrice: 105,
    closeTime: closeTime + 15 * 60 * 1000,
    currentPrice: 105,
    windows,
    now: closeTime + 1000,
  });
  checkEq(next.w5.tracking.baselinePrice, 105, 'new cycle baseline');
}

// ───────────────────────────── prediction ─────────────────────────────

function testPrediction() {
  section('prediction.js');
  check(logistic(0) > 0.49 && logistic(0) < 0.51, 'logistic(0) ≈ 0.5');
  check(logistic(5) > 0.9, 'logistic(+large) high');
  check(logistic(-5) < 0.1, 'logistic(-large) low');
  checkEq(WINDOWS.length, 3, 'three prediction windows');

  const candles = makeCandles(240, { start: 50000, drift: 15, wobble: 40 });
  const series = seriesFromCandles(candles);
  const book = new OrderBook('BTC-USD');
  book.loadSnapshot(
    [
      [String(series.latestClose() - 10), '1'],
      [String(series.latestClose() - 20), '2'],
    ],
    [
      [String(series.latestClose() + 10), '1'],
      [String(series.latestClose() + 20), '2'],
    ]
  );
  const ind = gatherIndicators(series, book);
  check(ind != null, 'gatherIndicators with 240 candles');
  check(Number.isFinite(ind.price), 'indicator price');
  const scored = directionalScore(ind, 'w5');
  check(Number.isFinite(scored.score), 'directionalScore');
  const wPred = buildWindowPrediction(WINDOWS[0], ind, null, null, ind.price, 'BTC', null, Date.now());
  check(wPred.probabilityUp >= 0 && wPred.probabilityUp <= 100, 'window probabilityUp 0..100');
  check(wPred.confidence >= 0 && wPred.confidence <= 100, 'window confidence 0..100');

  const ethCandles = makeCandles(240, { start: 3000, drift: 1, wobble: 3 });
  const result = buildPredictions(
    {
      BTC: { series, book },
      ETH: { series: seriesFromCandles(ethCandles), book: null },
    },
    {
      BTC: { price: series.latestClose(), closeTime: Date.now() + 600_000, ticker: 'KXBTC15M-X' },
      ETH: { price: ethCandles[ethCandles.length - 1].close, closeTime: Date.now() + 600_000, ticker: 'KXETH15M-X' },
    },
    new SignalAccumulatorManager({ w5: 120000, w10: 240000, w15: 420000 })
  );
  check(result.BTC && result.BTC.ready, 'BTC prediction ready');
  check(result.ETH && result.ETH.ready, 'ETH prediction ready');
  check(result.BTC.windows.w5 && result.BTC.windows.w15, 'all windows present');
  check(result.BTC.targetCloseTime > Date.now(), 'targetCloseTime in future');
}

// ───────────────────────────── kalshi client helpers ─────────────────────────────

function testKalshiClient() {
  section('kalshiClient.js');
  checkEq(priceInCents(56, null), 56, 'legacy cents');
  checkEq(priceInCents(null, '0.5600'), 56, 'dollar string → cents');
  checkEq(priceInCents(undefined, '0.5600'), 56, 'undefined legacy falls through to dollars');
  checkEq(priceInCents('', '0.5600'), 56, 'empty legacy falls through to dollars');
  checkEq(priceInCents(undefined, 'bad'), null, 'invalid dollars → null');
  // Regression: null must NOT become 0¢ and mask a real dollar quote.
  checkEq(priceInCents(null, '0.41'), 41, 'null legacy does not become 0¢');
  const norm = normalizeMarketPrices({
    yes_bid_dollars: '0.41',
    yes_ask_dollars: '0.43',
    no_bid_dollars: '0.57',
    no_ask_dollars: '0.59',
    last_price_dollars: '0.42',
  });
  checkEq(norm.yes_bid, 41, 'normalize yes_bid');
  checkEq(norm.yes_ask, 43, 'normalize yes_ask');
  checkEq(norm.no_bid, 57, 'normalize no_bid');
  const client = new KalshiClient({});
  checkEq(client.hasCredentials, false, 'no credentials by default');
  client.setCredentials({ keyId: 'abc', privateKeyPem: 'not-a-real-key' });
  checkEq(client.hasCredentials, true, 'credentials flag after set');
}

// ───────────────────────────── backtest ─────────────────────────────

function testBacktest() {
  section('backtest.js');
  const settings = normalizeSettings({
    edgeThresholdPct: 5,
    minConfidence: 40,
    stopLossCents: 30,
    takeProfitCents: 80,
    stakeDollars: 10,
    skimMode: 'off',
    paperStartingBalanceDollars: 200,
    assumedEntryCents: 50,
  });
  checkEq(settings.minConfidence, 40, 'normalizeSettings minConfidence');
  check(LOOKBACK_MIN >= 200, 'LOOKBACK_MIN sufficient for indicators');

  const btc = makeCandles(280, { start: 60000, drift: 8, wobble: 25 });
  const eth = makeCandles(280, { start: 3000, drift: 0.8, wobble: 4 });
  const summary = backtestSymbol(btc, { symbol: 'BTC' });
  check(summary && typeof summary === 'object', 'backtestSymbol returns summary');

  const trading = backtestWithSettings(
    { BTC: btc, ETH: eth },
    settings,
    { stepMinutes: 2, mode: 'AUTO', continuousSearch: true }
  );
  check(trading && Number.isFinite(trading.netPnlCents), 'backtestWithSettings netPnlCents');
  check(typeof trading.trades === 'number', 'backtest trades count');
  check(trading.skipCounts && typeof trading.skipCounts === 'object', 'skipCounts present');

  const hunt = huntBestSettings({ BTC: btc, ETH: eth }, settings, { stepMinutes: 3 });
  check(hunt && hunt.best, 'huntBestSettings returns best');
  check(hunt.best.settings && Number.isFinite(hunt.best.settings.edgeThresholdPct), 'best settings numeric');
}

// ───────────────────────────── bot: config / mode / capital ─────────────────────────────

function testBotControls() {
  section('bot.js controls');
  const bot = makeBot(mockClient({}));
  const liveReject = bot.setMode('live');
  checkEq(liveReject.ok, false, 'cannot go live without liveAuthorized');
  const paperOk = bot.setMode('paper');
  checkEq(paperOk.ok, true, 'paper mode always allowed');

  const liveBot = makeBot(mockClient({}), { liveAuthorized: true, mode: 'live' });
  liveBot.config.liveAuthorized = true;
  const pause = liveBot.setMode('paper');
  checkEq(pause.ok, true, 'authorized bot can pause to paper');
  const resume = liveBot.setMode('live');
  checkEq(resume.ok, true, 'authorized bot can resume live');

  const stopped = bot.setRunning(false);
  checkEq(stopped.isRunning, false, 'setRunning false');
  const started = bot.setRunning(true);
  checkEq(started.isRunning, true, 'setRunning true');

  const updated = bot.updateConfig({
    edgeThresholdPct: 12,
    minConfidence: 61,
    stopLossCents: 28,
    takeProfitCents: 75,
    stakeDollars: 7,
    maxOpenPositions: 2,
    symbol: 'AUTO',
    skimMode: 'fixed',
    skimFixedDollars: 3,
    paperStartingBalanceDollars: 150,
  });
  checkEq(updated.applied.edgeThresholdPct, 12, 'updateConfig edge');
  checkEq(bot.config.symbol, 'AUTO', 'updateConfig symbol AUTO');
  check(fs.existsSync(dataPath('bot-config.json')), 'config persisted to disk');
  const saved = JSON.parse(fs.readFileSync(dataPath('bot-config.json'), 'utf8'));
  checkEq(saved.minConfidence, 61, 'persisted minConfidence');

  // Ignore mode via updateConfig
  bot.updateConfig({ mode: 'live' });
  check(bot.config.mode !== 'live' || !bot.config.liveAuthorized, 'updateConfig cannot force unauthorized live');

  const reset = bot.resetPaperState();
  checkEq(reset.ok, true, 'reset paper in paper mode');
  checkEq(bot.ledger.trades.length, 0, 'ledger cleared');
}

// ───────────────────────────── bot: exits / settlement ─────────────────────────────

async function testBotExits() {
  section('bot.js exits + settlement');

  // Official result
  {
    const now = Date.now();
    const client = mockClient({
      ticker: 'KXETH15M-TEST',
      status: 'closed',
      result: 'no',
      floor_strike: 3000,
      close_time: new Date(now - 1000).toISOString(),
      yes_bid: 5,
      no_bid: 95,
    });
    const bot = makeBot(client);
    const trade = openTrade(bot, { windowCloseTime: now - 1000, side: 'no' });
    await bot._manageOpenTrade(trade, predictions(2990));
    checkEq(trade.status, 'closed', 'result settle closes');
    checkEq(trade.exitReason, 'settled', 'result settle reason');
    checkEq(trade.exitPriceCents, 100, 'NO win = 100¢');
  }

  // YES result loss
  {
    const now = Date.now();
    const client = mockClient({
      ticker: 'KXETH15M-TEST',
      status: 'settled',
      result: 'YES',
      floor_strike: 3000,
      close_time: new Date(now - 1000).toISOString(),
    });
    const bot = makeBot(client);
    const trade = openTrade(bot, { windowCloseTime: now - 1000, side: 'no' });
    await bot._manageOpenTrade(trade, predictions(3100));
    checkEq(trade.exitPriceCents, 0, 'NO loss when result YES');
  }

  // Price vs strike
  {
    const now = Date.now();
    const client = mockClient({
      ticker: 'KXETH15M-TEST',
      status: 'closed',
      result: '',
      floor_strike: 3000,
      close_time: new Date(now - 1000).toISOString(),
    });
    const bot = makeBot(client);
    const trade = openTrade(bot, { windowCloseTime: now - 1000, side: 'no', floorStrike: 3000 });
    await bot._manageOpenTrade(trade, predictions(2950));
    checkEq(trade.exitReason, 'settled', 'strike settle');
    checkEq(trade.exitPriceCents, 100, 'below strike NO wins');
  }

  // Fetch fail after close
  {
    const now = Date.now();
    const bot = makeBot(mockClient(null, { failGet: true }));
    const trade = openTrade(bot, { windowCloseTime: now - 60_000, side: 'yes', floorStrike: 3000 });
    await bot._manageOpenTrade(trade, predictions(3100));
    checkEq(trade.status, 'closed', 'fetch-fail force settle');
  }

  // Max age without windowCloseTime
  {
    const now = Date.now();
    const bot = makeBot(mockClient(null, { failGet: true }));
    const trade = openTrade(bot, { openedAt: now - 17 * 60 * 1000, floorStrike: 3000, side: 'no' });
    delete trade.windowCloseTime;
    await bot._manageOpenTrade(trade, predictions(2900));
    checkEq(trade.status, 'closed', 'max-age force settle');
  }

  // Stop loss
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 80,
        no_bid: 20,
      }),
      { stopLossCents: 35 }
    );
    const trade = openTrade(bot, { side: 'no', windowCloseTime: now + 10 * 60 * 1000 });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'stop_loss', 'stop_loss');
  }

  // Take profit
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 20,
        no_bid: 75,
      }),
      { takeProfitCents: 70 }
    );
    const trade = openTrade(bot, { side: 'no', windowCloseTime: now + 10 * 60 * 1000 });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'take_profit', 'take_profit');
  }

  // Breakeven in final 5 without confidence hold
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 3 * 60 * 1000).toISOString(),
        yes_bid: 40,
        no_bid: 55,
      }),
      { minConfidence: 80, takeProfitCents: 90 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 3 * 60 * 1000,
    });
    await bot._manageOpenTrade(
      trade,
      predictions(3000, { w5: win(40, 40) }) // low confidence in our favor
    );
    checkEq(trade.exitReason, 'breakeven', 'breakeven in final 5');
  }

  // Signal flip in final 5
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 2 * 60 * 1000).toISOString(),
        yes_bid: 45,
        no_bid: 50,
      }),
      { minConfidence: 55, stopLossCents: 10, takeProfitCents: 99 }
    );
    const trade = openTrade(bot, { side: 'no', windowCloseTime: now + 2 * 60 * 1000, entryPriceCents: 50 });
    await bot._manageOpenTrade(trade, predictions(3000, { w5: win(70, 60) })); // UP favored → against NO
    checkEq(trade.exitReason, 'signal_flip', 'signal_flip');
  }

  // Strong reversal (w10+w15)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 12 * 60 * 1000).toISOString(),
        yes_bid: 40,
        no_bid: 55,
      }),
      { stopLossCents: 10, takeProfitCents: 99 }
    );
    const trade = openTrade(bot, { side: 'no', windowCloseTime: now + 12 * 60 * 1000 });
    await bot._manageOpenTrade(
      trade,
      predictions(3000, {
        w5: win(50, 50),
        w10: win(70, 70), // UP against NO
        w15: win(68, 70),
      })
    );
    checkEq(trade.exitReason, 'reversal_signal', 'reversal_signal');
  }

  // Settled timeout scratch
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'closed',
        result: '',
        close_time: new Date(now - 1000).toISOString(),
        yes_bid: null,
        no_bid: null,
        floor_strike: null,
      })
    );
    const trade = openTrade(bot, {
      windowCloseTime: now - 1000,
      floorStrike: null,
      entryPriceCents: 44,
    });
    await bot._manageOpenTrade(trade, { ETH: { ready: true, price: null, windows: { w5: win(50, 50), w10: win(50, 50), w15: win(50, 50) } } });
    checkEq(trade.exitReason, 'settled_timeout', 'settled_timeout scratch');
    checkEq(trade.exitPriceCents, 44, 'scratch at entry');
  }

  // Hold through TP when final-5 confidence high
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 2 * 60 * 1000).toISOString(),
        yes_bid: 20,
        no_bid: 80,
      }),
      { takeProfitCents: 70, minConfidence: 55 }
    );
    const trade = openTrade(bot, { side: 'no', windowCloseTime: now + 2 * 60 * 1000 });
    await bot._manageOpenTrade(trade, predictions(3000, { w5: win(30, 80) })); // DOWN favored strongly for NO
    checkEq(trade.status, 'open', 'hold through TP when confident');
  }
}

// ───────────────────────────── bot: open / runCycle / skim / stake ─────────────────────────────

async function testBotTradingFlow() {
  section('bot.js open + runCycle + skim + stake');

  const now = Date.now();
  const market = {
    ticker: 'KXETH15M-LIVE',
    status: 'open',
    floor_strike: 3000,
    close_time: new Date(now + 12 * 60 * 1000).toISOString(),
    yes_bid: 40,
    yes_ask: 42,
    no_bid: 58,
    no_ask: 60,
  };
  const client = mockClient(market);
  const bot = makeBot(client, {
    symbol: 'ETH',
    edgeThresholdPct: 5,
    minConfidence: 50,
    stakeDollars: 10,
    skimMode: 'fixed',
    skimFixedDollars: 2,
  });

  // Strong YES edge: engine UP >> kalshi mid (~41)
  const preds = {
    ETH: {
      ready: true,
      price: 3010,
      windows: {
        w5: win(80, 80),
        w10: win(75, 75),
        w15: win(70, 70),
      },
    },
  };
  await bot.runCycle(preds);
  check(bot.openTrades.length === 1, 'runCycle opened a paper trade');
  check(bot.openTrades[0].side === 'yes', 'opened YES on positive edge');
  check(Number.isFinite(bot.openTrades[0].windowCloseTime), 'windowCloseTime stored');

  // Guardrail / max positions block second
  await bot.runCycle(preds);
  checkEq(bot.openTrades.length, 1, 'maxOpenPositions blocks second open');

  // One open per coin: max 2 slots must not stack both on ETH
  {
    const diversifyClient = {
      hasCredentials: false,
      async getOpenMarkets(series) {
        const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
        if (series.includes('ETH')) {
          return [{ ticker: 'ETH-A', close_time: close, floor_strike: 3000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
        }
        if (series.includes('BTC')) {
          return [{ ticker: 'BTC-A', close_time: close, floor_strike: 60000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
        }
        return [];
      },
      async getMarket() {
        return null;
      },
      async createOrder() {
        throw new Error('no');
      },
      async getBalance() {
        return { balance: 0, portfolio_value: 0 };
      },
    };
    const diversifyBot = makeBot(diversifyClient, {
      symbol: 'AUTO',
      maxOpenPositions: 2,
      edgeThresholdPct: 5,
      minConfidence: 50,
      stakeDollars: 10,
      skimMode: 'off',
    });
    const multiStrong = {
      ETH: { ready: true, price: 3010, windows: { w5: win(85, 90), w10: win(80, 85), w15: win(75, 80) } },
      BTC: { ready: true, price: 60100, windows: { w5: win(80, 85), w10: win(75, 80), w15: win(70, 75) } },
    };
    await diversifyBot.runCycle(multiStrong);
    checkEq(diversifyBot.openTrades.length, 1, 'first AUTO open fills one slot');
    const firstSym = diversifyBot.openTrades[0].symbol;
    await diversifyBot.runCycle(multiStrong);
    checkEq(diversifyBot.openTrades.length, 2, 'second slot opens on a different coin');
    const symbols = diversifyBot.openTrades.map((t) => t.symbol).sort();
    checkEq(symbols.join(','), 'BTC,ETH', 'max 2 diversifies across BTC+ETH, not same coin twice');
    check(!diversifyBot.openTrades.every((t) => t.symbol === firstSym), 'second open is not the same coin as first');

    // Explicit same-symbol stack still blocked even if forced
    await diversifyBot._openPosition({
      symbol: firstSym,
      ticker: `${firstSym}-DUP`,
      side: 'yes',
      priceCents: 42,
      floorStrike: 1,
      closeTime: Date.now() + 600_000,
      engineProbability: 70,
      engineConfidence: 70,
    });
    checkEq(diversifyBot.openTrades.length, 2, 'hard guard blocks third open on an occupied coin');
  }

  // Settle and skim (stop entries so a replacement trade isn't opened same cycle)
  const trade = bot.openTrades[0];
  const tradeId = trade.id;
  trade.windowCloseTime = now - 1000;
  client.getMarket = async () => ({
    ...market,
    status: 'closed',
    result: 'yes',
    close_time: new Date(now - 1000).toISOString(),
  });
  bot.setRunning(false);
  await bot.runCycle(preds);
  checkEq(bot.openTrades.length, 0, 'settled trade no longer open');
  const closed = bot.ledger.trades.find((t) => t.id === tradeId);
  check(closed && closed.status === 'closed', 'original trade marked closed');
  check(closed && closed.pnlCents > 0, 'winning settle has positive PnL');
  check(closed.skimmedCents === 200 || bot.ledger.reserveCents >= 200, 'fixed skim applied');

  // Reject bad entry prices
  const badBot = makeBot(client);
  await badBot._openPosition({
    symbol: 'ETH',
    ticker: 'X',
    side: 'yes',
    priceCents: null,
    floorStrike: 1,
    closeTime: now + 600_000,
    engineProbability: 60,
    engineConfidence: 60,
  });
  checkEq(badBot.openTrades.length, 0, 'rejects null entry price');

  await badBot._openPosition({
    symbol: 'ETH',
    ticker: 'X',
    side: 'yes',
    priceCents: 50,
    floorStrike: 1,
    closeTime: now - 1000,
    engineProbability: 60,
    engineConfidence: 60,
  });
  checkEq(badBot.openTrades.length, 0, 'rejects already-ending close time');

  // Block entries at/under absolute stop (cheap fade death trap)
  {
    const stopBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-CHEAP',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
        // YES mid ~93 → engine UP 70 gives negative edge → would buy NO ~10¢
        yes_bid: 90,
        yes_ask: 96,
        no_bid: 4,
        no_ask: 10,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        stopLossCents: 35,
        stakeDollars: 10,
      }
    );
    const fadePreds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: win(70, 80),
          w10: win(68, 75),
          w15: win(65, 70),
        },
      },
    };
    const cheapOpp = await stopBot._evaluateSymbolForEdge('ETH', fadePreds);
    checkEq(cheapOpp, null, 'skips NO @ ~10¢ when stop is 35¢');
    check(/stop/i.test(stopBot.lastDecision || ''), 'decision mentions stop floor');
    await stopBot.runCycle(fadePreds);
    checkEq(stopBot.openTrades.length, 0, 'runCycle does not open under-stop fade');

    await stopBot._openPosition({
      symbol: 'ETH',
      ticker: 'FORCE-CHEAP',
      side: 'no',
      priceCents: 7,
      floorStrike: 3000,
      closeTime: Date.now() + 600_000,
      engineProbability: 30,
      engineConfidence: 70,
    });
    checkEq(stopBot.openTrades.length, 0, 'hard guard blocks open at/under stop');
  }

  // Block entries at/above absolute take-profit (flat "TP" death trap)
  {
    const tpBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-RICH',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
        // YES mid ~91 → engine UP 98 → buy YES @ 92 ask, above TP 83
        yes_bid: 90,
        yes_ask: 92,
        no_bid: 8,
        no_ask: 10,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        stopLossCents: 35,
        takeProfitCents: 83,
        stakeDollars: 10,
      }
    );
    const richPreds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: {
          w5: win(98, 90),
          w10: win(95, 85),
          w15: win(92, 80),
        },
      },
    };
    const richOpp = await tpBot._evaluateSymbolForEdge('ETH', richPreds);
    checkEq(richOpp, null, 'skips YES @ 92¢ when take-profit is 83¢');
    check(/take-profit|take profit/i.test(tpBot.lastDecision || ''), 'decision mentions take-profit ceiling');

    // Already-open rich entry: bid at/above TP but not above entry → no flat TP
    const flatBot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        yes_bid: 90,
        no_bid: 10,
      }),
      { takeProfitCents: 83 }
    );
    const flatTrade = openTrade(flatBot, {
      side: 'yes',
      entryPriceCents: 90,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    await flatBot._manageOpenTrade(flatTrade, predictions(3010));
    checkEq(flatTrade.status, 'open', 'does not take_profit at flat 90→90');
  }

  // Expired markets skipped
  const expiredClient = mockClient(null, {
    openMarkets: [
      {
        ticker: 'OLD',
        close_time: new Date(now - 1000).toISOString(),
        floor_strike: 3000,
        yes_bid: 40,
        yes_ask: 42,
        no_bid: 58,
        no_ask: 60,
      },
    ],
  });
  const skipBot = makeBot(expiredClient, { symbol: 'ETH', minConfidence: 1, edgeThresholdPct: 1 });
  const opp = await skipBot._evaluateSymbolForEdge('ETH', preds);
  checkEq(opp, null, 'expired market not tradeable');

  // AUTO picks best ranked
  const autoClient = {
    hasCredentials: false,
    async getOpenMarkets(series) {
      const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
      if (series.includes('ETH')) {
        return [{ ticker: 'ETH', close_time: close, floor_strike: 3000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
      }
      if (series.includes('BTC')) {
        return [{ ticker: 'BTC', close_time: close, floor_strike: 60000, yes_bid: 48, yes_ask: 50, no_bid: 50, no_ask: 52 }];
      }
      return [];
    },
    async getMarket() {
      return null;
    },
    async createOrder() {
      throw new Error('no');
    },
  };
  const autoBot = makeBot(autoClient, { symbol: 'AUTO', minConfidence: 50, edgeThresholdPct: 5 });
  const multi = {
    ETH: { ready: true, price: 3000, windows: { w5: win(85, 90), w10: win(80, 85), w15: win(75, 80) } },
    BTC: { ready: true, price: 60000, windows: { w5: win(56, 60), w10: win(55, 58), w15: win(54, 56) } },
  };
  const best = await autoBot._findBestOpportunity(multi);
  check(best && best.symbol === 'ETH', 'AUTO ranks stronger ETH edge first');

  // Staking halve-after-win
  const stakeBot = makeBot(mockClient({}), { stakeDollars: 10, stakingStrategy: 'halve-after-win' });
  stakeBot.ledger.trades = [
    { status: 'closed', pnlCents: 500, stakeDollars: 10, closedAt: Date.now() },
  ];
  checkEq(stakeBot._computeNextStake(), 5, 'halve-after-win halves next stake');
  stakeBot.ledger.trades = [
    { status: 'closed', pnlCents: -200, stakeDollars: 10, closedAt: Date.now() },
  ];
  checkEq(stakeBot._computeNextStake(), 10, 'halve-after-win resets after loss');

  // Live order attempt on close
  let liveOrders = 0;
  const liveClient = {
    hasCredentials: true,
    async getMarket() {
      return {
        status: 'closed',
        result: 'yes',
        close_time: new Date(Date.now() - 1000).toISOString(),
        floor_strike: 3000,
      };
    },
    async getOpenMarkets() {
      return [];
    },
    async createOrder() {
      liveOrders += 1;
      return { order: { order_id: 'oid' } };
    },
    async getBalance() {
      return { balance: 10000, portfolio_value: 10000 };
    },
  };
  const liveBot = makeBot(liveClient, { mode: 'live', liveAuthorized: true });
  liveBot.config.mode = 'live';
  liveBot.config.liveAuthorized = true;
  const liveTrade = openTrade(liveBot, {
    mode: 'live',
    liveOrderId: 'entry-1',
    side: 'yes',
    windowCloseTime: Date.now() - 1000,
  });
  await liveBot._manageOpenTrade(liveTrade, predictions(3100));
  checkEq(liveTrade.status, 'closed', 'live trade settles');
  checkEq(liveOrders, 1, 'live exit order attempted');

  // Status payload shape
  const status = bot.status();
  check(status.config && status.stats && status.capital, 'status() shape');
  check(Array.isArray(status.openTrades), 'status openTrades array');
  check(Object.keys(SERIES_BY_SYMBOL).includes('ETH'), 'ETH series mapped');
  check(Object.keys(SERIES_BY_SYMBOL).includes('BTC'), 'BTC series mapped');
}

// ───────────────────────────── UI countdown logic (mirrored) ─────────────────────────────

function testCountdownLogic() {
  section('countdown / window-gap logic');
  const labelFor = (target, now) => {
    if (!target) return '—';
    const remainingMs = target - now;
    if (remainingMs <= 0) return 'Next window…';
    const totalSeconds = Math.round(remainingMs / 1000);
    const mm = Math.floor(totalSeconds / 60);
    const ss = totalSeconds % 60;
    return `${mm}:${String(ss).padStart(2, '0')}`;
  };
  checkEq(labelFor(0, Date.now()), '—', 'missing target → dash');
  checkEq(labelFor(Date.now() - 5000, Date.now()), 'Next window…', 'past close → Next window');
  check(/^\d+:\d{2}$/.test(labelFor(Date.now() + 125_000, Date.now())), 'future close → mm:ss');

  // Server-side expired-market filter (same rule as fetchKalshiTargets)
  const now = Date.now();
  const markets = [
    { close_time: new Date(now - 1000).toISOString(), ticker: 'OLD' },
    { close_time: new Date(now + 600_000).toISOString(), ticker: 'NEW' },
  ];
  const picked = markets.find((m) => new Date(m.close_time).getTime() > now + 1500);
  checkEq(picked.ticker, 'NEW', 'expired open markets filtered');
}

// ───────────────────────────── optional online public APIs ─────────────────────────────

async function testOnlinePublicApis() {
  section('online public APIs (Coinbase + Kalshi read-only)');
  const fetch = globalThis.fetch;
  check(typeof fetch === 'function', 'global fetch available');
  if (typeof fetch !== 'function') return;

  try {
    const candleRes = await fetch(
      'https://api.exchange.coinbase.com/products/BTC-USD/candles?granularity=60',
      { headers: { 'User-Agent': 'crypto-prediction-engine-selftest' } }
    );
    check(candleRes.ok, `Coinbase candles HTTP ${candleRes.status}`);
    if (candleRes.ok) {
      const rows = await candleRes.json();
      check(Array.isArray(rows) && rows.length > 10, 'Coinbase returned candle rows');
    }
  } catch (err) {
    check(false, `Coinbase reachable (${err.cause?.code || err.message})`);
  }

  const kalshi = new KalshiClient({});
  try {
    const markets = await kalshi.getOpenMarkets('KXBTC15M', 3);
    check(Array.isArray(markets), 'Kalshi open markets array');
    if (markets[0]) {
      check(markets[0].ticker && markets[0].close_time, 'Kalshi market has ticker+close_time');
      const detail = await kalshi.getMarket(markets[0].ticker);
      check(detail && detail.ticker === markets[0].ticker, 'Kalshi getMarket matches');
      check(detail.yes_bid == null || Number.isFinite(detail.yes_bid), 'yes_bid normalized finite or null');
    } else {
      check(true, 'no open KXBTC15M market right now (gap ok)');
    }
  } catch (err) {
    check(false, `Kalshi public API reachable (${err.cause?.code || err.message})`);
  }
}

// ───────────────────────────── run ─────────────────────────────

async function run() {
  console.log(`Full self-test`);
  console.log(`DATA_DIR=${tmpDir}`);
  console.log(`ONLINE=${ONLINE ? 'yes' : 'no (set ONLINE=1 for live public API checks)'}`);

  testPaths();
  testIndicators();
  testCandlesAndBook();
  testSignalAccumulator();
  testTracker();
  testPrediction();
  testKalshiClient();
  testBacktest();
  testBotControls();
  await testBotExits();
  await testBotTradingFlow();
  testCountdownLogic();
  if (ONLINE) await testOnlinePublicApis();

  console.log(`\n════════════════════════════`);
  console.log(`${passed} passed, ${failed} failed`);
  if (failures.length) {
    console.log('Failed:');
    for (const f of failures) console.log(`  - ${f}`);
  }

  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    // ignore
  }
  process.exit(failed ? 1 : 0);
}

run().catch((err) => {
  console.error('\nFatal self-test error:', err);
  process.exit(1);
});
