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

const { DATA_DIR, ensureDataDir, dataPath, writeJsonAtomic, pruneArchiveFiles } = require('./paths');
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
const { TradingBot, SERIES_BY_SYMBOL, stopRecoveryCentsRequired, stopRecoveryMaxAgeMs, peerCascadeMaxAgeMs, postStopMaxOneAgeMs, isPostStopMaxOneActive, tradeWindowCloseMs, isPostStopRecoverySessionExpired, checkPostStopRecovery, checkPostStopPeerCascade, applyProfitBuckets, normalizeInsuranceThresholds } = require('./bot');
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
      stopLossCents: 23,
      takeProfitCents: 15,
      minEntryCents: 40,
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
    stopLossCents: config.stopLossCents ?? 23,
    takeProfitCents: config.takeProfitCents ?? 15,
    minEntryCents: config.minEntryCents ?? 40,
    minMinutesToOpen: config.minMinutesToOpen ?? 3,
    stopRecoveryCents: config.stopRecoveryCents ?? 8,
    stakeDollars: config.stakeDollars ?? 10,
    maxOpenPositions: config.maxOpenPositions ?? 1,
    skimMode: config.skimMode ?? 'off',
    skimPercent: config.skimPercent ?? 20,
    skimFixedDollars: config.skimFixedDollars ?? 5,
    insuranceCapDollars: config.insuranceCapDollars ?? 10,
    insuranceFloorDollars: config.insuranceFloorDollars ?? 6,
    paperStartingBalanceDollars: config.paperStartingBalanceDollars ?? 100,
    stakingStrategy: config.stakingStrategy ?? 'fixed',
    symbol: config.symbol ?? 'ETH',
  });
  normalizeInsuranceThresholds(bot.config);
  bot.ledger = { trades: [], reserveCents: 0, insuranceCents: 0, insuranceReady: false, insuranceDepositedCents: 0, periodStartTime: Date.now() };
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

  const archiveDir = dataPath('archive');
  const oldFile = path.join(archiveDir, 'bot-ledger-old.json');
  const newFile = path.join(archiveDir, 'bot-ledger-new.json');
  fs.writeFileSync(oldFile, '{"trades":[]}');
  fs.writeFileSync(newFile, '{"trades":[]}');
  const twentyDaysAgo = Date.now() - 20 * 24 * 60 * 60 * 1000;
  fs.utimesSync(oldFile, new Date(twentyDaysAgo / 1000), new Date(twentyDaysAgo / 1000));
  const pruned = pruneArchiveFiles({ now: Date.now() });
  check(!fs.existsSync(oldFile), 'prune deletes archive older than retention');
  check(fs.existsSync(newFile), 'prune keeps recent archive');
  check(pruned.deleted >= 1, 'prune reports deleted count');
  try {
    fs.unlinkSync(newFile);
  } catch {
    // ignore
  }
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
  check(trading.longevity && Number.isFinite(trading.longevity.simulatedHours), 'longevity simulatedHours');
  check(typeof trading.longevity.survivedFullPeriod === 'boolean', 'longevity survivedFullPeriod');
  check(Array.isArray(trading.longevity.dailyEquity), 'longevity dailyEquity array');

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

  // Saved close in the past must settle even if Kalshi still says active + future close
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'active',
        close_time: new Date(now + 14 * 60 * 1000).toISOString(),
        result: '',
        floor_strike: 3000,
        yes_bid: 40,
        no_bid: 55,
      })
    );
    const trade = openTrade(bot, {
      side: 'no',
      floorStrike: 3000,
      windowCloseTime: now - 5000,
    });
    await bot._manageOpenTrade(trade, predictions(2950));
    checkEq(trade.status, 'closed', 'past saved close settles despite active+future API close');
  }

  // ISO string windowCloseTime still parses
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'active',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        result: 'no',
      })
    );
    const trade = openTrade(bot, {
      side: 'no',
      windowCloseTime: new Date(now - 2000).toISOString(),
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'closed', 'ISO windowCloseTime settles');
  }

  // Stop loss — relative to entry (entry 50, stop −10 → level 40)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 80,
        no_bid: 20,
      }),
      { stopLossCents: 10, takeProfitCents: 40 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'stop_loss', 'stop_loss');
    checkEq(trade.exitPriceCents, 40, 'paper stop fills at entry−drop (50−10)');
  }

  // Take profit — relative to entry (entry 50, TP +15 → level 65)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 20,
        no_bid: 75,
      }),
      { stopLossCents: 40, takeProfitCents: 15 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'take_profit', 'take_profit');
    checkEq(trade.exitPriceCents, 65, 'paper TP fills at entry+rise (50+15)');
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
      { minConfidence: 80, stopLossCents: 40, takeProfitCents: 40 }
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
      { minConfidence: 55, stopLossCents: 40, takeProfitCents: 40 }
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
      { stopLossCents: 40, takeProfitCents: 40 }
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
      { stopLossCents: 40, takeProfitCents: 15, minConfidence: 55 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 2 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000, { w5: win(30, 80) })); // DOWN favored strongly for NO
    checkEq(trade.status, 'open', 'hold through TP when confident');
  }

  // Last ~1 minute: bank green bid even if confidence would have held for settle
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 50 * 1000).toISOString(),
        yes_bid: 20,
        no_bid: 70,
      }),
      { stopLossCents: 40, takeProfitCents: 40, minConfidence: 55 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 50 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000, { w5: win(30, 80) }));
    checkEq(trade.exitReason, 'pre_close_bank', 'pre_close_bank in last minute when green');
  }

  // Near-certain ~97¢: bank even mid-window / during confidence hold
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 8 * 60 * 1000).toISOString(),
        yes_bid: 2,
        no_bid: 97,
      }),
      { stopLossCents: 40, takeProfitCents: 40, minConfidence: 55, nearCertainExitCents: 97 }
    );
    const trade = openTrade(bot, {
      side: 'no',
      entryPriceCents: 50,
      windowCloseTime: now + 8 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'near_certain', 'near_certain at 97¢');
  }

  // Watchdog: forceSettleOverdue closes past-deadline opens without waiting on full manage
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'active',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        result: '',
        floor_strike: 3000,
        yes_bid: 40,
        no_bid: 55,
      })
    );
    // Hang getMarket to prove settle still happens via timeout + scratch/strike
    bot.client.getMarket = () => new Promise(() => {});
    const trade = openTrade(bot, {
      side: 'no',
      floorStrike: 3000,
      windowCloseTime: now - 2000,
    });
    const n = await bot.forceSettleOverdue(predictions(2950));
    check(n >= 1, 'forceSettleOverdue settled at least one');
    checkEq(trade.status, 'closed', 'overdue trade closed by watchdog path');
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

  // Post-stop max-1: time-limited (default 1.5m), then maxOpenPositions again
  {
    const nowMs = Date.now();
    checkEq(postStopMaxOneAgeMs({}), Math.round(1.5 * 60 * 1000), 'post-stop max-1 defaults to 1.5 minutes');
    checkEq(postStopMaxOneAgeMs({ postStopMaxOneMinutes: 0 }), 0, 'post-stop max-1 0 disables cap');
    checkEq(postStopMaxOneAgeMs({ postStopMaxOneMinutes: 2 }), 2 * 60 * 1000, 'post-stop max-1 uses configured minutes');
    check(
      isPostStopMaxOneActive(
        { exitReason: 'stop_loss', closedAt: nowMs - 30_000 },
        { postStopMaxOneMinutes: 1.5 },
        nowMs
      ),
      'max-1 active within 1.5m of stop closedAt'
    );
    check(
      !isPostStopMaxOneActive(
        { exitReason: 'stop_loss', closedAt: nowMs - 100_000 },
        { postStopMaxOneMinutes: 1.5 },
        nowMs
      ),
      'max-1 inactive after 1.5m from stop closedAt'
    );
    check(
      !isPostStopMaxOneActive(
        { exitReason: 'stop_loss', closedAt: nowMs - 10_000 },
        { postStopMaxOneMinutes: 0 },
        nowMs
      ),
      'max-1 disabled when postStopMaxOneMinutes is 0'
    );

    const maxOneClient = {
      hasCredentials: false,
      async getOpenMarkets(series) {
        const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
        if (series.includes('ETH')) {
          return [{ ticker: 'ETH-M1', close_time: close, floor_strike: 3000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
        }
        if (series.includes('BTC')) {
          return [{ ticker: 'BTC-M1', close_time: close, floor_strike: 60000, yes_bid: 40, yes_ask: 42, no_bid: 58, no_ask: 60 }];
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
    const calmPreds = {
      ETH: { ready: true, price: 3010, windows: { w5: win(85, 90), w10: win(80, 85), w15: win(75, 80) } },
      BTC: { ready: true, price: 60100, windows: { w5: win(80, 85), w10: win(75, 80), w15: win(70, 75) } },
    };

    const youngStopBot = makeBot(maxOneClient, {
      symbol: 'AUTO',
      maxOpenPositions: 2,
      edgeThresholdPct: 5,
      minConfidence: 50,
      stakeDollars: 10,
      skimMode: 'off',
      stopRecoveryCents: 0,
      postStopMaxOneMinutes: 1.5,
    });
    youngStopBot.ledger.trades = [
      {
        id: 'open-btc',
        status: 'open',
        symbol: 'BTC',
        ticker: 'BTC-OPEN',
        side: 'yes',
        contracts: 10,
        stakeDollars: 10,
        entryPriceCents: 42,
        floorStrike: 60000,
        openedAt: nowMs - 60_000,
        windowCloseTime: nowMs + 10 * 60_000,
        engineProbability: 70,
        engineConfidence: 80,
      },
      {
        // Stopped a coin we are not about to re-rank first — max-1 still applies
        // from "latest closed is stop", independent of which symbol stopped.
        id: 'stop-xrp',
        status: 'closed',
        exitReason: 'stop_loss',
        symbol: 'XRP',
        side: 'yes',
        pnlCents: -200,
        entryPriceCents: 55,
        exitPriceCents: 42,
        closedAt: nowMs - 30_000,
        windowCloseTime: nowMs + 8 * 60_000,
      },
    ];
    await youngStopBot.runCycle(calmPreds);
    checkEq(youngStopBot.openTrades.length, 1, 'max-1 blocks 2nd open within 1.5m after stop');
    check(/max 1 open until post-stop/i.test(youngStopBot.lastDecision || ''), 'max-1 Waiting cites post-stop calm');
    checkEq(youngStopBot._lastProtectionGateKey, 'post-stop-max1', 'max-1 notes protection gate');

    const agedStopBot = makeBot(maxOneClient, {
      symbol: 'AUTO',
      maxOpenPositions: 2,
      edgeThresholdPct: 5,
      minConfidence: 50,
      stakeDollars: 10,
      skimMode: 'off',
      stopRecoveryCents: 0,
      postStopMaxOneMinutes: 1.5,
    });
    agedStopBot.ledger.trades = [
      {
        id: 'open-btc-aged',
        status: 'open',
        symbol: 'BTC',
        ticker: 'BTC-OPEN2',
        side: 'yes',
        contracts: 10,
        stakeDollars: 10,
        entryPriceCents: 42,
        floorStrike: 60000,
        openedAt: nowMs - 3 * 60_000,
        windowCloseTime: nowMs + 10 * 60_000,
        engineProbability: 70,
        engineConfidence: 80,
      },
      {
        id: 'stop-xrp-aged',
        status: 'closed',
        exitReason: 'stop_loss',
        symbol: 'XRP',
        side: 'yes',
        pnlCents: -200,
        entryPriceCents: 55,
        exitPriceCents: 42,
        closedAt: nowMs - 100_000, // > 1.5m
        windowCloseTime: nowMs + 8 * 60_000,
      },
    ];
    agedStopBot._lastProtectionGateKey = 'post-stop-max1';
    await agedStopBot.runCycle(calmPreds);
    checkEq(agedStopBot.openTrades.length, 2, 'after 1.5m post-stop, 2nd open allowed (maxOpenPositions)');
    check(
      agedStopBot.openTrades.some((t) => t.symbol === 'ETH'),
      'aged max-1 allows ETH as second slot'
    );
    check(agedStopBot._lastProtectionGateKey == null, 'max-1 protection clears after window ages out');
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

  // Insurance: 10/40/50; hysteresis arm $10 / floor $6
  {
    const insSettings = { skimMode: 'insurance', insuranceCapDollars: 10, insuranceFloorDollars: 6 };

    const win = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 0,
      insuranceCents: 0,
      insuranceReady: false,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(win.skimmedCents, 400, 'insurance win: 40% wallet');
    checkEq(win.insuranceAddedCents, 100, 'insurance win: 10% to fund');
    checkEq(win.insuranceCents, 100, 'insurance fund balance');
    checkEq(win.insuranceReady, false, 'under arm: not ready after small win');

    const keepGoing = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 400,
      insuranceCents: 1000,
      insuranceReady: true,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(keepGoing.insuranceAddedCents, 100, 'keeps taking 10% past arm');
    checkEq(keepGoing.insuranceCents, 1100, 'fund can grow above $10');
    checkEq(keepGoing.insuranceReady, true, 'stays ready above arm');

    const absorbEarly = applyProfitBuckets({
      pnlCents: -800,
      reserveCents: 400,
      insuranceCents: 500,
      insuranceReady: false,
      settings: insSettings,
    });
    checkEq(absorbEarly.insuranceDrawnCents, 0, 'not ready: hold fund, do not absorb yet');
    checkEq(absorbEarly.insuranceCents, 500, 'not ready: insurance unchanged on loss');
    checkEq(absorbEarly.insuranceReady, false, 'not ready stays not ready under arm');

    const absorbAtArm = applyProfitBuckets({
      pnlCents: -800,
      reserveCents: 400,
      insuranceCents: 1000,
      insuranceReady: false,
      settings: insSettings,
    });
    checkEq(absorbAtArm.insuranceDrawnCents, 800, 'at arm: sync arms then absorbs loss');
    checkEq(absorbAtArm.insuranceCents, 200, 'at arm: insurance reduced');
    checkEq(absorbAtArm.insuranceReady, false, 'drawn below floor → not ready');
    checkEq(absorbAtArm.reserveCents, 400, 'wallet untouched by loss');

    // Absorb at $8 while ready (hysteresis band)
    const absorbMid = applyProfitBuckets({
      pnlCents: -200,
      reserveCents: 400,
      insuranceCents: 800,
      insuranceReady: true,
      settings: insSettings,
    });
    checkEq(absorbMid.insuranceDrawnCents, 200, 'ready at $8: still absorbs');
    checkEq(absorbMid.insuranceCents, 600, 'ready at $8: balance after draw');
    checkEq(absorbMid.insuranceReady, true, 'exactly at floor: still ready');

    // Drop below $6 → stop absorbing / disarm
    const absorbBelow = applyProfitBuckets({
      pnlCents: -200,
      reserveCents: 400,
      insuranceCents: 600,
      insuranceReady: true,
      settings: insSettings,
    });
    checkEq(absorbBelow.insuranceDrawnCents, 200, 'at floor: still absorbs once');
    checkEq(absorbBelow.insuranceCents, 400, 'below floor after draw');
    checkEq(absorbBelow.insuranceReady, false, 'below $6: not ready');

    const noAbsorbDisarmed = applyProfitBuckets({
      pnlCents: -100,
      reserveCents: 400,
      insuranceCents: 800,
      insuranceReady: false,
      settings: insSettings,
    });
    checkEq(noAbsorbDisarmed.insuranceDrawnCents, 0, 'disarmed at $8: Available takes loss');
    checkEq(noAbsorbDisarmed.insuranceCents, 800, 'disarmed: insurance unchanged');
    checkEq(noAbsorbDisarmed.insuranceReady, false, 're-arm only at $10, not at $8');

    // Re-arm only when balance ≥ $10
    const rearm = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 400,
      insuranceCents: 900,
      insuranceReady: false,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(rearm.insuranceCents, 1000, 'win brings fund to arm');
    checkEq(rearm.insuranceReady, true, 're-arms at $10');

    const insBot = makeBot(mockClient(market), {
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 6,
      stakeDollars: 10,
    });
    const tBoot = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tBoot, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, 100, 'first win takes 10% from the start');
    checkEq(insBot.ledger.reserveCents, 400, 'first win wallets 40%');
    for (let i = 0; i < 9; i += 1) {
      const t = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
      await insBot._closePosition(t, 60, 'take_profit');
    }
    check(insBot.ledger.insuranceCents >= 1000, 'fills arm $10');
    checkEq(insBot.ledger.insuranceReady, true, 'marked ready after arm');
    const before = insBot.ledger.insuranceCents;
    const tMore = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tMore, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, before + 100, 'keeps building past arm');

    // Bot path: absorb while ready in the $6–$10 band, then disarm below floor
    // Loss of $2: 20 contracts × 10¢ drop (50→40)
    insBot.ledger.insuranceCents = 800;
    insBot.ledger.insuranceReady = true;
    const tLossMid = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 20 });
    await insBot._closePosition(tLossMid, 40, 'stop_loss');
    checkEq(insBot.ledger.insuranceCents, 600, 'bot: absorb at $8 while ready → $6');
    checkEq(insBot.ledger.insuranceReady, true, 'bot: still ready at floor');
    const tLossFloor = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 20 });
    await insBot._closePosition(tLossFloor, 40, 'stop_loss');
    checkEq(insBot.ledger.insuranceCents, 400, 'bot: draw below floor');
    checkEq(insBot.ledger.insuranceReady, false, 'bot: disarmed below $6');

    // Floor clamp when floor >= arm
    const clamped = makeBot(mockClient(market), {
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 15,
    });
    check(clamped.config.insuranceFloorDollars < clamped.config.insuranceCapDollars, 'floor clamped below arm');
    checkEq(clamped.config.insuranceFloorDollars, 9, 'floor clamped to arm-1');
  }

  // Manual external insurance seed / top-up
  {
    const seedBot = makeBot(mockClient(market), {
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 6,
      paperStartingBalanceDollars: 100,
    });
    seedBot.config.insuranceCapDollars = 10;
    seedBot.config.insuranceFloorDollars = 6;
    const beforeCap = seedBot._capitalStatus();
    checkEq(beforeCap.insuranceCents, 0, 'starts with empty insurance');
    checkEq(beforeCap.paperAvailableCents, 10000, 'starts with full Available');
    checkEq(beforeCap.insuranceCapCents, 1000, 'capital reports arm cents');
    checkEq(beforeCap.insuranceFloorCents, 600, 'capital reports floor cents');

    const badZero = seedBot.depositInsurance(0);
    checkEq(badZero.ok, false, 'rejects zero deposit');
    const badNeg = seedBot.depositInsurance(-5);
    checkEq(badNeg.ok, false, 'rejects negative deposit');
    const badHuge = seedBot.depositInsurance(501);
    checkEq(badHuge.ok, false, 'rejects over $500 per call');

    const underArm = seedBot.depositInsurance(8);
    checkEq(underArm.ok, true, 'accepts $8 seed');
    checkEq(seedBot.ledger.insuranceCents, 800, 'under-arm seed credits insurance');
    checkEq(seedBot.ledger.insuranceReady, false, 'under arm: deposit does not arm');

    const seeded = seedBot.depositInsurance(2);
    checkEq(seeded.ok, true, 'accepts top-up to arm');
    checkEq(seedBot.ledger.insuranceCents, 1000, 'seed credits insurance to $10');
    checkEq(seedBot.ledger.insuranceDepositedCents, 1000, 'tracks external deposit');
    checkEq(seedBot.ledger.insuranceReady, true, 'ready flips at arm via deposit');
    const afterSeed = seedBot._capitalStatus();
    checkEq(afterSeed.paperAvailableCents, beforeCap.paperAvailableCents, 'Available unchanged by external seed');
    checkEq(afterSeed.insuranceCents, 1000, 'capital shows seeded insurance');
    checkEq(afterSeed.paperTotalCents, beforeCap.paperTotalCents + 1000, 'total capital rises by deposit');
    check(
      (seedBot.ledger.activityLog || []).some((e) => /Insurance seeded \+\$2\.00/.test(e.message)),
      'activity log records manual seed'
    );

    const topUp = seedBot.depositInsurance(2.5);
    checkEq(topUp.ok, true, 'accepts top-up');
    checkEq(seedBot.ledger.insuranceCents, 1250, 'top-up adds to insurance');
    checkEq(seedBot.ledger.insuranceDepositedCents, 1250, 'top-up tracked in deposits');
    const afterTop = seedBot._capitalStatus();
    checkEq(afterTop.paperAvailableCents, beforeCap.paperAvailableCents, 'Available still unchanged after top-up');
  }

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

  // Relative stops allow cheap entries (no absolute floor); stop is entry−drop
  {
    const stopBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-CHEAP',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
        yes_bid: 90,
        yes_ask: 96,
        no_bid: 4,
        no_ask: 10,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        stopLossCents: 10,
        takeProfitCents: 15,
        minEntryCents: 1,
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
    check(cheapOpp && cheapOpp.side === 'no', 'relative stop still allows cheap NO fade entry');
    checkEq(stopBot._stopLevelCents({ entryPriceCents: 10 }), 1, 'cheap entry stop clamps to 1¢');
    checkEq(stopBot._takeProfitLevelCents({ entryPriceCents: 10 }), 25, 'cheap entry TP is entry+rise');
  }

  // Min entry ban blocks longshots even with high confidence
  {
    const banBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-CHEAP2',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
        yes_bid: 90,
        yes_ask: 96,
        no_bid: 4,
        no_ask: 10,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        minEntryCents: 25,
        stakeDollars: 10,
      }
    );
    const fadePreds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: { w5: win(70, 80), w10: win(68, 75), w15: win(65, 70) },
      },
    };
    const banned = await banBot._evaluateSymbolForEdge('ETH', fadePreds);
    checkEq(banned, null, 'min entry ban skips ~10¢ NO');
    check(/min entry|longshot/i.test(banBot.lastDecision || ''), 'decision mentions min entry');
  }

  // Post-stop recovery: same-side blocked until bid bounces (not a timer)
  {
    checkEq(stopRecoveryCentsRequired({ stopRecoveryCents: 0 }), 0, 'recovery 0 disables gate');
    checkEq(stopRecoveryCentsRequired({ stopRecoveryCents: 8 }), 8, 'recovery uses configured cents');
    check(stopRecoveryCentsRequired({ stopLossCents: 23 }) >= 5, 'auto recovery floors at 5¢');

    const blocked = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
      },
      side: 'yes',
      priceCents: 42,
      window: { probabilityUp: 60, probabilityDown: 40 },
      recoveryCents: 8,
      symbol: 'ETH',
    });
    check(!blocked.ok, 'blocks same-side when bid has not bounced enough');
    check(/bounce|recovery|stopped/i.test(blocked.reason || ''), 'block reason mentions recovery');

    const flipped = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'ETH',
      },
      side: 'yes',
      priceCents: 42,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'ETH',
      forCandidateSymbol: 'BTC',
    });
    check(!flipped.ok, 'blocks opposite-coin entry until stopped coin recovers (no instant side-flip)');

    const recovered = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'ETH',
      },
      side: 'yes',
      priceCents: 49,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 8,
      symbol: 'ETH',
    });
    check(recovered.ok, 'allows entry after bounce + engine favor');

    const crossBlocked = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'ETH',
      },
      side: 'yes',
      priceCents: 42,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 8,
      symbol: 'ETH',
      forCandidateSymbol: 'BTC',
    });
    check(!crossBlocked.ok, 'same recovery blocks other-coin entry until stopped coin bounces');
    check(/BTC/i.test(crossBlocked.reason || ''), 'cross-coin block mentions the candidate');

    const noFavor = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'ETH',
      },
      side: 'yes',
      priceCents: 55,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'ETH',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
    });
    check(!noFavor.ok, 'blocks when bid bounced but engine flipped against stopped side');
    check(/knife-catch|no longer favors/i.test(noFavor.reason || ''), 'same-coin thesis block mentions knife-catch');

    // Screenshot bug: SOL bounce cleared but thesis flipped — must NOT freeze ETH/peers.
    const peerAfterBounce = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'SOL',
        closedAt: Date.now() - 5 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 55,
      window: { probabilityUp: 35, probabilityDown: 65 },
      recoveryCents: 8,
      symbol: 'SOL',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
    });
    check(peerAfterBounce.ok, 'peer coin unlocks after stopped-coin bounce even if thesis flipped');

    const oppositeSameCoin = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'SOL',
      },
      side: 'yes',
      priceCents: 55,
      window: { probabilityUp: 35, probabilityDown: 65 },
      recoveryCents: 8,
      symbol: 'SOL',
      forCandidateSymbol: 'SOL',
      forCandidateSide: 'no',
    });
    check(oppositeSameCoin.ok, 'opposite side on stopped coin unlocks after bounce (no thesis hostage)');

    checkEq(stopRecoveryMaxAgeMs({ stopRecoveryMaxMinutes: 0 }), 0, 'max age 0 disables expiry');
    checkEq(stopRecoveryMaxAgeMs({ stopRecoveryMaxMinutes: 15 }), 15 * 60 * 1000, 'max age uses configured minutes');
    checkEq(stopRecoveryMaxAgeMs({}), 15 * 60 * 1000, 'max age defaults to 15 minutes');

    const agedOut = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'SOL',
        closedAt: Date.now() - 20 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 41,
      window: { probabilityUp: 30, probabilityDown: 70 },
      recoveryCents: 8,
      symbol: 'SOL',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
    });
    check(agedOut.ok, 'recovery gate expires after max age even without bounce');

    const stillYoung = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 40,
        entryPriceCents: 55,
        symbol: 'SOL',
        closedAt: Date.now() - 2 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 41,
      window: { probabilityUp: 30, probabilityDown: 70 },
      recoveryCents: 8,
      symbol: 'SOL',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
    });
    check(!stillYoung.ok, 'recovery gate still blocks peers before bounce within max age');

    // Prior session stop must not block next window (even before max-age expires).
    const priorWindowEnd = Date.now() - 2 * 60 * 1000;
    const priorSessionStop = {
      exitReason: 'stop_loss',
      side: 'no',
      exitPriceCents: 50,
      entryPriceCents: 65,
      symbol: 'BTC',
      closedAt: Date.now() - 5 * 60 * 1000,
      windowCloseTime: priorWindowEnd,
    };
    check(isPostStopRecoverySessionExpired(priorSessionStop), 'session expired once stop window closed');
    const nextSessionAllowed = checkPostStopRecovery({
      lastClosedForSymbol: priorSessionStop,
      side: 'no',
      priceCents: 42,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'BTC',
      forCandidateSymbol: 'XRP',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
    });
    check(nextSessionAllowed.ok, 'next-session candidate allowed without bounce after stop window closed');

    const sameSessionStillBlocks = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'no',
        exitPriceCents: 50,
        entryPriceCents: 65,
        symbol: 'BTC',
        closedAt: Date.now() - 2 * 60 * 1000,
        windowCloseTime: Date.now() + 8 * 60 * 1000,
      },
      side: 'no',
      priceCents: 52,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'BTC',
      forCandidateSymbol: 'XRP',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
    });
    check(!sameSessionStillBlocks.ok, 'same-session stop still blocks peers until bounce');
    check(/same-window cascade/i.test(sameSessionStillBlocks.reason || ''), 'block reason says same-window not forever');

    checkEq(tradeWindowCloseMs({ closeTime: 12345 }), 12345, 'tradeWindowCloseMs reads backtest closeTime');

    const recBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-REC',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(Date.now() + 12 * 60 * 1000).toISOString(),
        yes_bid: 48,
        yes_ask: 50,
        no_bid: 50,
        no_ask: 52,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        minEntryCents: 20,
        stopRecoveryCents: 8,
        stopLossCents: 15,
      }
    );
    recBot.ledger.trades = [
      {
        id: 't1',
        status: 'closed',
        symbol: 'ETH',
        side: 'yes',
        exitReason: 'stop_loss',
        exitPriceCents: 45,
        entryPriceCents: 60,
        pnlCents: -150,
      },
    ];
    const recPreds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: { w5: win(70, 80), w10: win(68, 75), w15: win(65, 70) },
      },
    };
    const blockedOpp = await recBot._evaluateSymbolForEdge('ETH', recPreds);
    checkEq(blockedOpp, null, 'evaluate blocks YES re-entry before recovery bounce');
    check(/stopped|bounce|recovery/i.test(recBot.lastDecision || ''), 'decision explains post-stop wait');
  }

  // No new entries in the final 3 minutes of a window
  {
    const now = Date.now();
    const lateBot = makeBot(
      mockClient({
        ticker: 'KXETH15M-LATE',
        status: 'open',
        floor_strike: 3000,
        close_time: new Date(now + 2 * 60 * 1000).toISOString(),
        yes_bid: 40,
        yes_ask: 42,
        no_bid: 58,
        no_ask: 60,
      }),
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        minEntryCents: 20,
        minMinutesToOpen: 3,
      }
    );
    const latePreds = {
      ETH: {
        ready: true,
        price: 3010,
        windows: { w5: win(80, 80), w10: win(75, 75), w15: win(70, 70) },
      },
    };
    const lateOpp = await lateBot._evaluateSymbolForEdge('ETH', latePreds);
    checkEq(lateOpp, null, 'blocks open with only ~2 min left');
    check(/min left|to open/i.test(lateBot.lastDecision || ''), 'decision mentions min time to open');
  }

  // Relative TP: flat at entry does not take profit; need entry+rise
  {
    const flatBot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        yes_bid: 90,
        no_bid: 10,
      }),
      { stopLossCents: 40, takeProfitCents: 15 }
    );
    const flatTrade = openTrade(flatBot, {
      side: 'yes',
      entryPriceCents: 90,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    await flatBot._manageOpenTrade(flatTrade, predictions(3010));
    checkEq(flatTrade.status, 'open', 'does not take_profit at flat 90→90 (needs +15 → 99)');
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

  // After stop on ETH, prefer another crypto even if ETH still ranks highest
  autoBot.config.stopRecoveryCents = 0;
  autoBot.ledger.trades = [
    {
      status: 'closed',
      symbol: 'ETH',
      side: 'yes',
      exitReason: 'stop_loss',
      exitPriceCents: 30,
      entryPriceCents: 50,
      pnlCents: -200,
    },
  ];
  checkEq(autoBot._lastStopLossSymbol(), 'ETH', 'last stop symbol is ETH');
  const afterStop = await autoBot._findBestOpportunity(multi, { preferOtherThan: 'ETH' });
  check(afterStop && afterStop.symbol === 'BTC', 'after ETH stop, prefers other crypto (BTC) first');

  // Cross-coin: same recovery must pass on the *stopped* coin before entering another
  {
    const crossClient = {
      hasCredentials: false,
      async getOpenMarkets(series) {
        const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
        if (series.includes('ETH')) {
          return [{ ticker: 'ETH', close_time: close, floor_strike: 3000, yes_bid: 44, yes_ask: 46, no_bid: 54, no_ask: 56 }];
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
    const crossBot = makeBot(crossClient, {
      symbol: 'AUTO',
      minConfidence: 50,
      edgeThresholdPct: 5,
      stopRecoveryCents: 8,
      minEntryCents: 20,
    });
    crossBot.ledger.trades = [
      {
        status: 'closed',
        symbol: 'ETH',
        side: 'yes',
        exitReason: 'stop_loss',
        exitPriceCents: 45,
        entryPriceCents: 60,
        pnlCents: -150,
      },
    ];
    const crossPreds = {
      ETH: { ready: true, price: 3000, windows: { w5: win(70, 80), w10: win(68, 75), w15: win(65, 70) } },
      BTC: { ready: true, price: 60000, windows: { w5: win(70, 80), w10: win(68, 75), w15: win(65, 70) } },
    };
    // ETH ask 46 < 45+8=53 → BTC same-side must wait on ETH recovery
    const blockedOther = await crossBot._evaluateSymbolForEdge('BTC', crossPreds);
    checkEq(blockedOther, null, 'blocks other-coin same-side until stopped coin recovers');
    check(/ETH|bounce|recovery|stopped/i.test(crossBot.lastDecision || ''), 'decision cites stopped-coin recovery');
  }

  // Peer cascade: after ANY stop, block all new entries while peers dump;
  // session expiry + short max age clear (do not freeze into the next window).
  {
    const now = Date.now();
    const xrpStop = {
      exitReason: 'stop_loss',
      symbol: 'XRP',
      side: 'yes',
      exitPriceCents: 42,
      entryPriceCents: 55,
      closedAt: now - 2 * 60 * 1000,
      windowCloseTime: now + 10 * 60 * 1000,
    };
    const dumpingPeers = {
      XRP: { ready: true, windows: { w5: { probabilityUp: 40, probabilityDown: 60, confidence: 70 } } },
      ETH: { ready: true, windows: { w5: { probabilityUp: 35, probabilityDown: 65, confidence: 70 } } },
      SOL: { ready: true, windows: { w5: { probabilityUp: 38, probabilityDown: 62, confidence: 70 } } },
      BTC: { ready: true, windows: { w5: { probabilityUp: 36, probabilityDown: 64, confidence: 70 } } },
    };
    const seriesAll = { XRP: 1, ETH: 1, SOL: 1, BTC: 1 };

    checkEq(peerCascadeMaxAgeMs({ peerCascadeMaxMinutes: 5 }), 5 * 60 * 1000, 'peer cascade uses dedicated minutes');
    checkEq(peerCascadeMaxAgeMs({ peerCascadeMaxMinutes: 8 }), 5 * 60 * 1000, 'peer cascade hard-caps dedicated at 5m');
    checkEq(peerCascadeMaxAgeMs({ stopRecoveryMaxMinutes: 15 }), 3 * 60 * 1000, 'peer cascade defaults to 3m vs recovery 15');
    checkEq(peerCascadeMaxAgeMs({ stopRecoveryMaxMinutes: 0 }), 3 * 60 * 1000, 'peer cascade still ages when recovery max disabled');
    checkEq(peerCascadeMaxAgeMs({}), 3 * 60 * 1000, 'peer cascade defaults to 3 minutes');

    const cascade = checkPostStopPeerCascade({
      lastStopTrade: xrpStop,
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(!cascade.ok, 'after stop, peers cascading blocks ETH/etc');
    check(
      /after XRP YES stop.*peers still cascading.*same window.*until calm/i.test(cascade.reason || ''),
      'cascade Waiting message cites same-window calm / max'
    );

    const fade = checkPostStopPeerCascade({
      lastStopTrade: { exitReason: 'stop_loss', symbol: 'BTC', side: 'yes', closedAt: now - 60_000, windowCloseTime: now + 8 * 60_000 },
      candidateSide: 'no',
      predictions: {
        BTC: { ready: true, windows: { w5: { probabilityUp: 40, probabilityDown: 60, confidence: 70 } } },
        ETH: { ready: true, windows: { w5: { probabilityUp: 35, probabilityDown: 65, confidence: 70 } } },
      },
      seriesBySymbol: { BTC: 1, ETH: 1 },
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(!fade.ok, 'peer cascade blocks opposite-side flip while peers still dump');

    const calm = checkPostStopPeerCascade({
      lastStopTrade: xrpStop,
      candidateSide: 'yes',
      predictions: {
        XRP: { ready: true, windows: { w5: { probabilityUp: 55, probabilityDown: 45, confidence: 70 } } },
        ETH: { ready: true, windows: { w5: { probabilityUp: 58, probabilityDown: 42, confidence: 70 } } },
        SOL: { ready: true, windows: { w5: { probabilityUp: 56, probabilityDown: 44, confidence: 70 } } },
      },
      seriesBySymbol: { XRP: 1, ETH: 1, SOL: 1 },
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(calm.ok, 'peer cascade clears when peers are no longer dumping');

    // Peers calm + bounce met → peer entry allowed (recovery unit + cascade unit).
    const bounceOk = checkPostStopRecovery({
      lastClosedForSymbol: xrpStop,
      side: 'yes',
      priceCents: 55,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 8,
      symbol: 'XRP',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
      maxAgeMs: 15 * 60 * 1000,
      now,
    });
    check(bounceOk.ok && calm.ok, 'peers calm + bounce met → allow peer entry');

    const sessionExpiredStop = {
      ...xrpStop,
      windowCloseTime: now - 60_000,
      closedAt: now - 5 * 60_000,
    };
    const afterSession = checkPostStopPeerCascade({
      lastStopTrade: sessionExpiredStop,
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(afterSession.ok, 'session expired → allow even if peers still look cascading');

    const agedOutCascade = checkPostStopPeerCascade({
      lastStopTrade: {
        ...xrpStop,
        closedAt: now - (3 * 60 * 1000 + 1000),
        windowCloseTime: now + 6 * 60 * 1000,
      },
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(agedOutCascade.ok, 'peer cascade clears after short max age even if peers still dump');

    const afterHardClamp = checkPostStopPeerCascade({
      lastStopTrade: {
        ...xrpStop,
        closedAt: now - (5 * 60 * 1000 + 1000),
        windowCloseTime: now + 6 * 60 * 1000,
      },
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: 15 * 60 * 1000,
      now,
    });
    check(afterHardClamp.ok, 'hard max 5m clears even if caller passed 15m maxAgeMs');

    const stillYoungCascade = checkPostStopPeerCascade({
      lastStopTrade: xrpStop,
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(!stillYoungCascade.ok, 'peer cascade still blocks shortly after stop while peers dump');

    const noTimestamps = checkPostStopPeerCascade({
      lastStopTrade: { exitReason: 'stop_loss', symbol: 'XRP', side: 'yes' },
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(noTimestamps.ok, 'peer cascade fails open when stop has no closedAt/openedAt');

    const openedOnlyAged = checkPostStopPeerCascade({
      lastStopTrade: {
        exitReason: 'stop_loss',
        symbol: 'XRP',
        side: 'yes',
        openedAt: now - (3 * 60 * 1000 + 1000),
        windowCloseTime: now + 5 * 60 * 1000,
      },
      candidateSide: 'yes',
      predictions: dumpingPeers,
      seriesBySymbol: seriesAll,
      minConfidence: 50,
      maxAgeMs: peerCascadeMaxAgeMs({}),
      now,
    });
    check(openedOnlyAged.ok, 'peer cascade ages out using openedAt when closedAt missing');

    // Live evaluate path: XRP stop + dumping peers → ETH blocked with cascade message
    // (before bounce messaging — peers gate runs first).
    const cascadeBot = makeBot(
      {
        hasCredentials: false,
        async getOpenMarkets(series) {
          const close = new Date(Date.now() + 12 * 60 * 1000).toISOString();
          if (String(series).includes('ETH')) {
            return [{
              ticker: 'KXETH15M-CASC',
              status: 'open',
              floor_strike: 3000,
              close_time: close,
              yes_bid: 48,
              yes_ask: 50,
              no_bid: 50,
              no_ask: 52,
            }];
          }
          // XRP quote would be used for bounce — but peer cascade should block first.
          return [{
            ticker: 'KXXRP15M-CASC',
            status: 'open',
            floor_strike: 0.5,
            close_time: close,
            yes_bid: 30,
            yes_ask: 32,
            no_bid: 68,
            no_ask: 70,
          }];
        },
        async getMarket() { return null; },
        async createOrder() { throw new Error('no orders in test'); },
        async getOrder() { return null; },
      },
      {
        symbol: 'ETH',
        edgeThresholdPct: 1,
        minConfidence: 50,
        minEntryCents: 20,
        stopRecoveryCents: 8,
        stopLossCents: 15,
        peerCascadeMaxMinutes: 3,
      }
    );
    cascadeBot.ledger.trades = [
      {
        id: 'xrp-stop',
        status: 'closed',
        symbol: 'XRP',
        side: 'yes',
        exitReason: 'stop_loss',
        exitPriceCents: 42,
        entryPriceCents: 55,
        pnlCents: -130,
        closedAt: now - 2 * 60 * 1000,
        windowCloseTime: now + 10 * 60 * 1000,
      },
    ];
    const cascadePreds = {
      XRP: { ready: true, price: 0.5, windows: { w5: win(40, 70), w10: win(42, 68), w15: win(45, 65) } },
      ETH: { ready: true, price: 3000, windows: { w5: win(35, 70), w10: win(38, 68), w15: win(40, 65) } },
      SOL: { ready: true, price: 140, windows: { w5: win(36, 70), w10: win(38, 68), w15: win(40, 65) } },
      BTC: { ready: true, price: 60000, windows: { w5: win(34, 70), w10: win(36, 68), w15: win(38, 65) } },
    };
    const ethBlocked = await cascadeBot._evaluateSymbolForEdge('ETH', cascadePreds);
    checkEq(ethBlocked, null, 'evaluate blocks ETH while peers cascade after XRP stop');
    check(
      /after XRP YES stop.*peers still cascading.*until calm/i.test(cascadeBot.lastDecision || ''),
      'evaluate decision uses post-stop peer-cascade Waiting text'
    );
    check(
      (cascadeBot.ledger.activityLog || []).some((e) =>
        /Protection used \(peer-cascade\)/i.test(e.message || '')
      ),
      'activity log records peer-cascade protection used'
    );
    const beforeRepeat = (cascadeBot.ledger.activityLog || []).filter((e) =>
      /Protection used \(peer-cascade\)/i.test(e.message || '')
    ).length;
    await cascadeBot._evaluateSymbolForEdge('ETH', cascadePreds);
    const afterRepeat = (cascadeBot.ledger.activityLog || []).filter((e) =>
      /Protection used \(peer-cascade\)/i.test(e.message || '')
    ).length;
    checkEq(afterRepeat, beforeRepeat, 'peer-cascade activity log does not spam every poll');

    // After max age, evaluate must not stay stuck on cascade (bounce may still apply).
    cascadeBot.ledger.trades[0].closedAt = now - 4 * 60 * 1000;
    cascadeBot.config.peerCascadeMaxMinutes = 3;
    const ethAfterAge = await cascadeBot._evaluateSymbolForEdge('ETH', {
      ...cascadePreds,
      // XRP bounced enough that recovery gate can clear for peer entry.
      XRP: { ready: true, price: 0.5, windows: { w5: win(60, 70), w10: win(58, 68), w15: win(55, 65) } },
    });
    // Peer cascade aged out; ETH may still be blocked by XRP bounce if quote is low —
    // ensure decision is NOT the sticky cascade message.
    check(
      !/peers still cascading/i.test(cascadeBot.lastDecision || ''),
      'after peer-cascade max age, decision is not sticky cascade wait'
    );
    void ethAfterAge;
  }

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

  // Live: official Kalshi result books 0/100 with NO sell order
  let liveOrders = 0;
  let getOrderCalls = 0;
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
      return { order: { order_id: `oid-${liveOrders}` } };
    },
    async getOrder(orderId) {
      getOrderCalls += 1;
      return {
        order: {
          order_id: orderId,
          status: 'executed',
          // Match openTrade default contracts (10) — never invent fills from status alone.
          fill_count_fp: '10.00',
          yes_price: 42,
        },
      };
    },
    async cancelOrder() {
      return {};
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
  checkEq(liveTrade.status, 'closed', 'live trade settles on official result');
  checkEq(liveTrade.exitReason, 'settled', 'live official settle reason');
  checkEq(liveOrders, 0, 'official settle places no live sell');

  // Live stop: sell + fill confirm before ledger close
  liveOrders = 0;
  getOrderCalls = 0;
  const stopBot = makeBot(liveClient, {
    mode: 'live',
    liveAuthorized: true,
    stopLossCents: 10,
    takeProfitCents: 50,
  });
  stopBot.config.mode = 'live';
  stopBot.config.liveAuthorized = true;
  const stopTrade = openTrade(stopBot, {
    mode: 'live',
    liveOrderId: 'entry-stop',
    side: 'yes',
    entryPriceCents: 60,
    windowCloseTime: Date.now() + 10 * 60 * 1000,
  });
  liveClient.getMarket = async () => ({
    status: 'active',
    yes_bid: 45,
    yes_ask: 47,
    no_bid: 53,
    no_ask: 55,
    close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
    floor_strike: 3000,
  });
  await stopBot._manageOpenTrade(stopTrade, predictions(3100));
  checkEq(stopTrade.status, 'closed', 'live stop closes after fill');
  checkEq(stopTrade.exitReason, 'stop_loss', 'live stop reason');
  check(liveOrders >= 1, 'live stop places sell order');
  check(getOrderCalls >= 1, 'live stop polls fill');

  // Failed live sell leaves position open
  liveOrders = 0;
  const failClient = {
    ...liveClient,
    async createOrder() {
      liveOrders += 1;
      throw new Error('simulated sell failure');
    },
    async getMarket() {
      return {
        status: 'active',
        yes_bid: 45,
        yes_ask: 47,
        close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        floor_strike: 3000,
      };
    },
  };
  const failBot = makeBot(failClient, {
    mode: 'live',
    liveAuthorized: true,
    stopLossCents: 10,
  });
  failBot.config.mode = 'live';
  failBot.config.liveAuthorized = true;
  const failTrade = openTrade(failBot, {
    mode: 'live',
    liveOrderId: 'entry-fail',
    side: 'yes',
    entryPriceCents: 60,
    windowCloseTime: Date.now() + 10 * 60 * 1000,
  });
  await failBot._manageOpenTrade(failTrade, predictions(3100));
  checkEq(failTrade.status, 'open', 'failed live sell leaves position open');
  check(liveOrders >= 1, 'failed live sell still attempted order');

  // Live entry: partial fill still records inventory (does not orphan Kalshi fills)
  {
    let entryOrders = 0;
    const partialEntryClient = {
      hasCredentials: true,
      async createOrder({ count }) {
        entryOrders += 1;
        return { order: { order_id: `entry-partial-${entryOrders}`, requested: count } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '3.00',
            yes_price: 50,
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
      async getOpenMarkets() {
        return [];
      },
      async getMarket() {
        return null;
      },
    };
    const entryBot = makeBot(partialEntryClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 10,
      minEntryCents: 1,
      skimMode: 'off',
    });
    entryBot.config.mode = 'live';
    entryBot.config.liveAuthorized = true;
    entryBot.setRunning(true);
    await entryBot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-PARTIAL',
      side: 'yes',
      priceCents: 50,
      floorStrike: 3000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    checkEq(entryBot.openTrades.length, 1, 'partial live entry records a trade');
    checkEq(entryBot.openTrades[0].contracts, 3, 'partial live entry keeps filled size');
    checkEq(entryOrders, 1, 'partial live entry placed one buy');
  }

  // Live exit: partial sell books sold slice + shrinks open remainder (no inventory desync)
  {
    let sellCalls = 0;
    const partialExitClient = {
      hasCredentials: true,
      async createOrder({ action, count }) {
        sellCalls += 1;
        checkEq(action, 'sell', 'partial exit issues sell');
        checkEq(count, 10, 'partial exit attempts full size first');
        return { order: { order_id: `sell-partial-${sellCalls}` } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '4.00',
            yes_price: 40,
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
    };
    const exitBot = makeBot(partialExitClient, {
      mode: 'live',
      liveAuthorized: true,
      skimMode: 'off',
    });
    exitBot.config.mode = 'live';
    exitBot.config.liveAuthorized = true;
    const partialTrade = openTrade(exitBot, {
      mode: 'live',
      liveOrderId: 'entry-partial-exit',
      side: 'yes',
      entryPriceCents: 50,
      contracts: 10,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const closed = await exitBot._closePosition(partialTrade, 40, 'stop_loss', {
      liveSellPriceCents: 40,
    });
    checkEq(closed, false, 'partial live sell does not fully close');
    checkEq(partialTrade.status, 'open', 'remainder stays open after partial sell');
    checkEq(partialTrade.contracts, 6, 'open size shrunk by filled sell count');
    const closedSlices = exitBot.ledger.trades.filter(
      (t) => t.status === 'closed' && t.partialExitOf === partialTrade.id
    );
    checkEq(closedSlices.length, 1, 'partial sell books a closed slice');
    checkEq(closedSlices[0].contracts, 4, 'closed slice matches fill count');
    checkEq(closedSlices[0].exitPriceCents, 40, 'closed slice uses sell fill price');
    check(sellCalls >= 1, 'partial sell placed an order');
  }

  // Live exit refuses 0/100 sell prices
  {
    const refuseBot = makeBot(
      {
        hasCredentials: true,
        async createOrder() {
          throw new Error('createOrder must not run for invalid sell price');
        },
      },
      { mode: 'live', liveAuthorized: true }
    );
    refuseBot.config.mode = 'live';
    const t = openTrade(refuseBot, {
      mode: 'live',
      liveOrderId: 'entry-refuse',
      side: 'yes',
      contracts: 2,
    });
    const ok = await refuseBot._closePosition(t, 0, 'settled_timeout', { liveSellPriceCents: 0 });
    checkEq(ok, false, 'refuse sell at 0¢');
    checkEq(t.status, 'open', 'invalid sell price leaves position open');
  }

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
