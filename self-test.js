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
const { TradingBot, SERIES_BY_SYMBOL, isKalshiTradeEnabled, tradeableKalshiSymbols, settleEntryBand, settleEffectiveEntryBand, isSettleEntryPriceCents, isSettleStrategyMode, isSettleTrade, isSettleTieredExitsEnabled, settleExitPlan, settleRankAskScore, settleMinUpsideCents, liquidityPriority, stopRecoveryCentsRequired, stopRecoveryMaxAgeMs, peerCascadeMaxAgeMs, postStopMaxOneAgeMs, isPostStopMaxOneActive, postStopSameSideCooldownMs, checkPostStopSameSideCooldown, tradeWindowCloseMs, isPostStopRecoverySessionExpired, checkPostStopRecovery, checkPostStopPeerCascade, applyProfitBuckets, normalizeInsuranceThresholds } = require('./bot');
const {
  KalshiClient,
  normalizeMarketPrices,
  priceInCents,
  bookSideFromLegacy,
  buildCreateOrderV2Body,
  normalizeCreateOrderResponse,
} = require('./kalshiClient');

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
    stopRecoveryCents: config.stopRecoveryCents ?? 6,
    stakeDollars: config.stakeDollars ?? 10,
    maxOpenPositions: config.maxOpenPositions ?? 1,
    skimMode: config.skimMode ?? 'off',
    skimPercent: config.skimPercent ?? 20,
    skimFixedDollars: config.skimFixedDollars ?? 5,
    insuranceCapDollars: config.insuranceCapDollars ?? 10,
    insuranceFloorDollars: config.insuranceFloorDollars ?? 6,
    insuranceOverflowDollars: config.insuranceOverflowDollars ?? 15,
    paperStartingBalanceDollars: config.paperStartingBalanceDollars ?? 100,
    stakingStrategy: config.stakingStrategy ?? 'fixed',
    symbol: config.symbol ?? 'ETH',
    // Suite opens multi-slot positions without greening the first hold unless a case opts in.
    secondOpenRequiresGreen: config.secondOpenRequiresGreen ?? 'off',
  });
  normalizeInsuranceThresholds(bot.config);
  bot.ledger = { trades: [], reserveCents: 0, insuranceCents: 0, insuranceReady: false, insuranceDepositedCents: 0, periodStartTime: Date.now() };
  bot.calibration = { buckets: {} };
  bot.isRunning = true;
  bot.lastError = null;
  // Instant sleeps so stop-loss retry loops don't slow the suite.
  bot._sleep = async () => {};
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

  // Create Order V2 mapping (legacy action/side → book bid/ask + dollar price)
  checkEq(bookSideFromLegacy('yes', 'buy'), 'bid', 'buy YES → bid');
  checkEq(bookSideFromLegacy('yes', 'sell'), 'ask', 'sell YES → ask');
  checkEq(bookSideFromLegacy('no', 'buy'), 'ask', 'buy NO → ask');
  checkEq(bookSideFromLegacy('no', 'sell'), 'bid', 'sell NO → bid');
  const v2Body = buildCreateOrderV2Body({
    ticker: 'KXBTC15M-TEST',
    side: 'yes',
    action: 'buy',
    count: 10,
    priceCents: 56,
    clientOrderId: 'cid-test',
  });
  checkEq(v2Body.side, 'bid', 'V2 body book side');
  checkEq(v2Body.count, '10.00', 'V2 body count_fp string');
  checkEq(v2Body.price, '0.5600', 'V2 body dollar price');
  checkEq(v2Body.time_in_force, 'good_till_canceled', 'V2 body TIF');
  checkEq(v2Body.self_trade_prevention_type, 'taker_at_cross', 'V2 body STP');
  checkEq(v2Body.client_order_id, 'cid-test', 'V2 body client_order_id');
  const iocBody = buildCreateOrderV2Body({
    ticker: 'KXBTC15M-TEST',
    side: 'yes',
    action: 'buy',
    count: 5,
    priceCents: 87,
    timeInForce: 'immediate_or_cancel',
  });
  checkEq(iocBody.time_in_force, 'immediate_or_cancel', 'V2 body supports IOC for live entry');
  let badPrice = false;
  try {
    buildCreateOrderV2Body({
      ticker: 'T',
      side: 'yes',
      action: 'buy',
      count: 1,
      priceCents: 0,
    });
  } catch {
    badPrice = true;
  }
  check(badPrice, 'V2 body refuses 0¢ (no silent clamp to 1)');
  const flatNorm = normalizeCreateOrderResponse({ order_id: 'oid-flat', fill_count: '0.00' });
  checkEq(flatNorm.order.order_id, 'oid-flat', 'normalize flat V2 create response');
  const nestedNorm = normalizeCreateOrderResponse({ order: { order_id: 'oid-nested' } });
  checkEq(nestedNorm.order.order_id, 'oid-nested', 'normalize nested legacy create response');

  // fill_count_fp parsing (v1.2.17+) — never invent fills from status alone
  const fillBot = makeBot(mockClient({}));
  checkEq(fillBot._orderFillCount({ fill_count_fp: '3.00' }), 3, 'fill_count_fp string');
  checkEq(fillBot._orderFillCount({ fill_count: 7 }), 7, 'fill_count integer');
  checkEq(fillBot._orderFillCount({ status: 'executed' }), 0, 'status alone is not a fill');
  checkEq(fillBot._orderFillCount({ fill_count_fp: '0.00', status: 'executed' }), 0, 'zero fill_count_fp stays zero');
  // Create Order V2 flat fill_count + average_fill_price
  checkEq(fillBot._orderFillCount({ fill_count: '5.00' }), 5, 'V2 create fill_count string');
  checkEq(
    fillBot._orderFillCount({ initial_count_fp: '10.00', remaining_count_fp: '4.00' }),
    6,
    'fill derived from initial − remaining'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.4200', fill_count: '2.00', side: 'bid' },
      'yes',
      'buy'
    ),
    42,
    'V2 buy YES average_fill_price → cents (raw YES quote)'
  );
  // Without sellLimit, do not blind-complement ask-book averages (TP 57 was
  // wrongly logged as 43 when 0.57 was already YES dollars).
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.5700', fill_count: '5.00', side: 'ask' },
      'yes',
      'sell'
    ),
    57,
    'V2 sell YES average_fill_price without limit stays raw (not blind complement)'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.8200', fill_count: '14.00', side: 'ask' },
      'yes',
      'sell',
      18
    ),
    18,
    'sell YES avg 0.82 with stop limit 18 → complement (closer to limit)'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.5700', fill_count: '5.00', side: 'ask' },
      'yes',
      'sell',
      57
    ),
    57,
    'sell YES avg 0.57 with TP limit 57 → raw (not complement to 43)'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.8200',
        taker_fill_cost_dollars: '2.52',
        fill_count: '14.00',
        side: 'ask',
      },
      'yes',
      'sell',
      18
    ),
    18,
    'average_fill_price preferred; disambiguated to stop limit (not raw 82)'
  );
  // XRP false +$10.32: maker buy ships taker_fill_cost_dollars="0.00" — must
  // not book clamp(0)=1¢ entry (which invents (76−1)×14 ≈ $10.50).
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.6900',
        taker_fill_cost_dollars: '0.00',
        maker_fill_cost_dollars: '9.66',
        fill_count: '14.00',
        side: 'bid',
      },
      'yes',
      'buy',
      69
    ),
    69,
    'maker-only buy: average_fill_price wins over zero/maker cost'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.6900',
        taker_fill_cost_dollars: '0.00',
        maker_fill_cost_dollars: '0.00',
        fill_count: '14.00',
        side: 'bid',
      },
      'yes',
      'buy',
      69
    ),
    69,
    'zero fill costs ignored; average_fill_price used'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.7600',
        taker_fill_cost_dollars: '20.00',
        fill_count: '14.00',
        side: 'ask',
      },
      'yes',
      'sell',
      76
    ),
    76,
    'misleading taker_fill_cost ignored when average_fill_price present'
  );
  // Cost fallback only when average_fill_price is absent.
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        taker_fill_cost_dollars: '1.26',
        maker_fill_cost_dollars: '1.26',
        fill_count: '14.00',
        side: 'ask',
      },
      'yes',
      'sell',
      18
    ),
    18,
    'without avg: taker+maker fill costs summed for cents'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        taker_fill_cost_dollars: '20.00',
        fill_count: '14.00',
        side: 'ask',
      },
      'yes',
      'sell',
      76
    ),
    null,
    'without avg: cost far from sell limit refused (no invented price)'
  );
  // ETH under-count: fill_cost near buy limit must not hide avg price improvement.
  checkEq(
    fillBot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.5200',
        taker_fill_cost_dollars: '9.52', // 17×$0.56 limit — agrees with intended, wrong vs avg
        fill_count: '17.00',
        side: 'bid',
      },
      'yes',
      'buy',
      56
    ),
    52,
    'ETH-style: average_fill_price improvement beats limit-shaped fill_cost'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.5800', fill_count: '5.00', side: 'ask' },
      'no',
      'buy'
    ),
    58,
    'V2 buy NO average_fill_price → raw cents without blind book_side flip'
  );
  checkEq(
    fillBot._orderAvgFillPriceCents(
      { average_fill_price: '0.8200', fill_count: '10.00', side: 'bid' },
      'no',
      'sell',
      18
    ),
    18,
    'sell NO avg 0.82 with sell limit 18 → complement (closer to limit)'
  );
  checkEq(
    fillBot._sanityCheckExitFillCents(30, 70, 50, 'take_profit'),
    70,
    'sanity: TP exit << entry with sellLimit >= entry → use closer-to-limit'
  );
  checkEq(
    fillBot._sanityCheckExitFillCents(82, 18, 42, 'stop_loss'),
    18,
    'sanity: stop exit >> entry with sellLimit <= entry → use closer-to-limit'
  );
  checkEq(
    fillBot._sanityCheckExitFillCents(57, 57, 42, 'take_profit'),
    57,
    'sanity: good TP fill passes through'
  );
  const v2FillNorm = normalizeCreateOrderResponse({
    order_id: 'oid-v2-fill',
    fill_count: '4.00',
    remaining_count: '0.00',
    average_fill_price: '0.5100',
  });
  checkEq(v2FillNorm.order.order_id, 'oid-v2-fill', 'normalize V2 create keeps order_id');
  checkEq(v2FillNorm.order.fill_count, '4.00', 'normalize V2 create keeps fill_count on order');
  checkEq(fillBot._orderFillCount(v2FillNorm.order), 4, 'normalized V2 create fill parses');
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

  // Settle: under tier target with plenty of time — hold (ignore edge TP knobs)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 92,
        no_bid: 8,
      }),
      { stopLossCents: 40, takeProfitCents: 5, settleStopLossCents: 8, nearCertainExitCents: 90 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle holds under tier target early in window');
    checkEq(trade.exitReason, undefined, 'settle early hold has no exit reason');
  }

  // Settle: entry 87¢ → target 96¢ hit → take profit
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 96,
        no_bid: 4,
      }),
      { settleStopLossCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'take_profit', 'settle take_profit when tier target hit');
    checkEq(trade.status, 'closed', 'settle TP closes trade');
    check(trade.exitPriceCents >= 96, 'settle TP fill at/above target');
  }

  // Settle: entry 87¢, green but under 96 with ≤2m left → settle_stale bank
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 90 * 1000).toISOString(),
        yes_bid: 93,
        no_bid: 7,
      }),
      { settleStopLossCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 90 * 1000,
      openedAt: now - 3 * 60 * 1000, // held long enough for stale
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.exitReason, 'settle_stale', 'settle stale banks green before close');
    checkEq(trade.exitPriceCents, 93, 'settle stale sells at live bid');
  }

  // Settle: inside stale clock but held <90s — do not instant-stale (churn guard)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 90 * 1000).toISOString(),
        yes_bid: 93,
        no_bid: 7,
      }),
      { settleStopLossCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 90 * 1000,
      openedAt: now - 15_000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle stale waits for min hold (~90s)');
  }

  // Settle: underwater past stale deadline — do not force sell (stop/settle only)
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 90 * 1000).toISOString(),
        yes_bid: 84,
        no_bid: 16,
      }),
      { settleStopLossCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 87,
      windowCloseTime: now + 90 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle does not force stale sell while red');
  }

  // Settle hold tier (≥90): no TP chase even at 96¢
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 96,
        no_bid: 4,
      }),
      { settleStopLossCents: 8 }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 91,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle ≥90¢ holds toward settlement');
  }

  // Second open only when an existing hold is green
  {
    const now = Date.now();
    const redClient = mockClient({
      status: 'open',
      close_time: new Date(now + 10 * 60 * 1000).toISOString(),
      yes_bid: 84,
      no_bid: 16,
    });
    const redBot = makeBot(redClient, {
      maxOpenPositions: 2,
      secondOpenRequiresGreen: 'on',
    });
    openTrade(redBot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 89,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    const blocked = await redBot._canOpenAdditionalPosition();
    check(!blocked.ok, 'second open blocked while only hold is red');
    check(/green/i.test(blocked.reason || ''), 'block reason mentions green');

    const greenClient = mockClient({
      status: 'open',
      close_time: new Date(now + 10 * 60 * 1000).toISOString(),
      yes_bid: 92,
      no_bid: 8,
    });
    const greenBot = makeBot(greenClient, {
      maxOpenPositions: 2,
      secondOpenRequiresGreen: 'on',
    });
    openTrade(greenBot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 89,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    const allowed = await greenBot._canOpenAdditionalPosition();
    check(allowed.ok, 'second open allowed when hold is green');
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

  // Insurance: 20/40/40; hysteresis arm $10 / floor $6; soft overflow $15
  {
    const insSettings = {
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 6,
      insuranceOverflowDollars: 15,
    };

    const win = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 0,
      insuranceCents: 0,
      insuranceReady: false,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(win.skimmedCents, 400, 'insurance win: 40% wallet');
    checkEq(win.insuranceAddedCents, 200, 'insurance win: 20% to fund');
    checkEq(win.insuranceCents, 200, 'insurance fund balance');
    checkEq(win.insuranceOverflowCents, 0, 'under overflow: no overflow');
    checkEq(win.insuranceReady, false, 'under arm: not ready after small win');

    const keepGoing = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 400,
      insuranceCents: 1000,
      insuranceReady: true,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(keepGoing.insuranceAddedCents, 200, 'keeps taking 20% past arm');
    checkEq(keepGoing.insuranceCents, 1200, 'fund can grow above $10 toward overflow');
    checkEq(keepGoing.insuranceOverflowCents, 0, 'past arm but under overflow: no overflow');
    checkEq(keepGoing.insuranceReady, true, 'stays ready above arm');

    // Fill exactly to $15 overflow ceiling
    const fillToOverflow = applyProfitBuckets({
      pnlCents: 1500,
      reserveCents: 0,
      insuranceCents: 1200,
      insuranceReady: true,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(fillToOverflow.insuranceAddedCents, 300, 'fills remaining room to $15');
    checkEq(fillToOverflow.insuranceCents, 1500, 'fund at overflow cap $15');
    checkEq(fillToOverflow.insuranceOverflowCents, 0, 'exact fill: no overflow skim');
    checkEq(fillToOverflow.skimmedCents, 600, 'wallet still 40% at exact fill');

    // At cap: full 20% → Available
    const atCapOverflow = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 400,
      insuranceCents: 1500,
      insuranceReady: true,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(atCapOverflow.insuranceAddedCents, 0, 'at overflow: no insurance add');
    checkEq(atCapOverflow.insuranceCents, 1500, 'at overflow: fund stays at $15 (no auto-empty)');
    checkEq(atCapOverflow.insuranceOverflowCents, 200, 'at overflow: 20% → available');
    checkEq(atCapOverflow.skimmedCents, 400, 'at overflow: wallet still 40%');

    // Partial overflow: fill up to $15, remainder of 20% → Available
    const partialOverflow = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 0,
      insuranceCents: 1400,
      insuranceReady: true,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(partialOverflow.insuranceAddedCents, 100, 'partial: fills $1 to cap');
    checkEq(partialOverflow.insuranceCents, 1500, 'partial: fund at $15');
    checkEq(partialOverflow.insuranceOverflowCents, 100, 'partial: remainder of 20% → available');
    checkEq(partialOverflow.skimmedCents, 400, 'partial: wallet still 40%');

    // Resume fill after a loss draws fund below $15
    const afterDraw = applyProfitBuckets({
      pnlCents: -300,
      reserveCents: 400,
      insuranceCents: 1500,
      insuranceReady: true,
      settings: insSettings,
    });
    checkEq(afterDraw.insuranceDrawnCents, 300, 'draw from full fund');
    checkEq(afterDraw.insuranceCents, 1200, 'after draw: below overflow');
    checkEq(afterDraw.insuranceReady, true, 'after modest draw: still ready');

    const resumeFill = applyProfitBuckets({
      pnlCents: 1000,
      reserveCents: 400,
      insuranceCents: afterDraw.insuranceCents,
      insuranceReady: afterDraw.insuranceReady,
      settings: insSettings,
      rebuildInsurance: true,
    });
    checkEq(resumeFill.insuranceAddedCents, 200, 'resume: 20% fills again after draw');
    checkEq(resumeFill.insuranceCents, 1400, 'resume: fund rebuilding toward $15');
    checkEq(resumeFill.insuranceOverflowCents, 0, 'resume: under cap, no overflow');

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
    checkEq(rearm.insuranceCents, 1100, 'win brings fund to arm');
    checkEq(rearm.insuranceReady, true, 're-arms at $10');

    const insBot = makeBot(mockClient(market), {
      skimMode: 'insurance',
      insuranceCapDollars: 10,
      insuranceFloorDollars: 6,
      insuranceOverflowDollars: 15,
      stakeDollars: 10,
    });
    const tBoot = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tBoot, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, 200, 'first win takes 20% from the start');
    checkEq(insBot.ledger.reserveCents, 400, 'first win wallets 40%');
    for (let i = 0; i < 6; i += 1) {
      const t = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
      await insBot._closePosition(t, 60, 'take_profit');
    }
    // 7 wins × $2 = $14
    checkEq(insBot.ledger.insuranceCents, 1400, 'bot fills toward overflow ($14)');
    check(insBot.ledger.insuranceCents >= 1000, 'fills arm $10');
    checkEq(insBot.ledger.insuranceReady, true, 'marked ready after arm');
    const tToCap = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tToCap, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, 1500, 'bot fills to overflow cap $15');
    checkEq(tToCap.insuranceAddedCents, 100, 'bot partial: $1 into fund');
    checkEq(tToCap.insuranceOverflowCents, 100, 'bot partial: $1 → available');
    const tOverflow = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tOverflow, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, 1500, 'bot at cap: fund unchanged');
    checkEq(tOverflow.insuranceAddedCents, 0, 'bot at cap: no insurance add');
    checkEq(tOverflow.insuranceOverflowCents, 200, 'bot at cap: full 20% → available');
    check(/Insurance full — \$2\.00 → available/.test(insBot.lastDecision), 'activity notes overflow to available');

    // Resume after draw below $15
    insBot.ledger.insuranceCents = 1200;
    insBot.ledger.insuranceReady = true;
    const tResume = openTrade(insBot, { side: 'yes', entryPriceCents: 50, contracts: 100 });
    await insBot._closePosition(tResume, 60, 'take_profit');
    checkEq(insBot.ledger.insuranceCents, 1400, 'bot resume fill after draw below cap');
    checkEq(tResume.insuranceOverflowCents, 0, 'bot resume: no overflow under cap');

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
      insuranceOverflowDollars: 15,
    });
    check(clamped.config.insuranceFloorDollars < clamped.config.insuranceCapDollars, 'floor clamped below arm');
    checkEq(clamped.config.insuranceFloorDollars, 9, 'floor clamped to arm-1');
    checkEq(clamped.config.insuranceOverflowDollars, 15, 'overflow default preserved');
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
    checkEq(beforeCap.insuranceOverflowCents, 1500, 'capital reports overflow cents');

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

    // Persist + reload so UI status refresh would see the seeded fund.
    seedBot._persist();
    const ledgerPath = dataPath('bot-ledger.json');
    check(fs.existsSync(ledgerPath), 'ledger file written after insurance deposit');
    const reloaded = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
    checkEq(reloaded.insuranceCents, 1250, 'persisted insuranceCents survives reload');
    checkEq(reloaded.insuranceDepositedCents, 1250, 'persisted insuranceDepositedCents survives reload');

    // String dollars (JSON body / form-like) must still credit.
    const fromString = seedBot.depositInsurance('1.00');
    checkEq(fromString.ok, true, 'accepts string dollar amount');
    checkEq(seedBot.ledger.insuranceCents, 1350, 'string deposit credits cents');
  }

  // UI: insurance deposit controls must not duplicate ids across dashboard + overlay
  {
    const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
    check(
      /buildCapitalLedgerHtml\(capital,\s*\{\s*depositControls:\s*true\s*\}\)/.test(appSrc),
      'overlay status uses depositControls: true'
    );
    check(
      /buildCapitalLedgerHtml\(capital,\s*\{\s*depositControls:\s*false\s*\}\)/.test(appSrc),
      'dashboard uses depositControls: false (no duplicate ids)'
    );
    check(
      /function insuranceDepositEls\(/.test(appSrc) && /getElementById\('bot-overlay'\)/.test(appSrc),
      'deposit UI scopes lookups to bot-overlay'
    );
    const depositIdHits = (appSrc.match(/id="bot-insurance-deposit"/g) || []).length;
    checkEq(depositIdHits, 1, 'deposit input id template appears once in app.js');
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
    checkEq(stopRecoveryCentsRequired({ stopRecoveryCents: 6 }), 6, 'recovery uses configured cents');
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

    checkEq(postStopSameSideCooldownMs({}), 2 * 60 * 1000, 'same-side cooldown defaults to 2m');
    checkEq(postStopSameSideCooldownMs({ postStopSameSideCooldownMinutes: 0 }), 0, 'same-side cooldown 0 disables');
    checkEq(
      postStopSameSideCooldownMs({ postStopSameSideCooldownMinutes: 3 }),
      3 * 60 * 1000,
      'same-side cooldown uses configured minutes'
    );

    const knifeCatchSitOut = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: Date.now() - 30 * 1000,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 69,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 6,
      symbol: 'DOGE',
      forCandidateSymbol: 'DOGE',
      forCandidateSide: 'yes',
      sameSideCooldownMs: 2 * 60 * 1000,
    });
    check(!knifeCatchSitOut.ok, 'DOGE YES blocked for 2m sit-out even if bounce+thesis ok');
    check(/same-side sit-out/i.test(knifeCatchSitOut.reason || ''), 'sit-out reason mentions same-side');

    const ethAfterDogeStop = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: Date.now() - 30 * 1000,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 69,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 6,
      symbol: 'DOGE',
      forCandidateSymbol: 'ETH',
      forCandidateSide: 'yes',
      sameSideCooldownMs: 2 * 60 * 1000,
    });
    check(ethAfterDogeStop.ok, 'ETH allowed during DOGE same-side sit-out (bounce met)');

    const dogeNoDuringSitOut = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: Date.now() - 30 * 1000,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 69,
      window: { probabilityUp: 40, probabilityDown: 60 },
      recoveryCents: 6,
      symbol: 'DOGE',
      forCandidateSymbol: 'DOGE',
      forCandidateSide: 'no',
      sameSideCooldownMs: 2 * 60 * 1000,
    });
    check(dogeNoDuringSitOut.ok, 'DOGE NO allowed during YES same-side sit-out');

    const dogeYesAfterSitOut = checkPostStopRecovery({
      lastClosedForSymbol: {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: Date.now() - 3 * 60 * 1000,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      },
      side: 'yes',
      priceCents: 69,
      window: { probabilityUp: 62, probabilityDown: 38 },
      recoveryCents: 6,
      symbol: 'DOGE',
      forCandidateSymbol: 'DOGE',
      forCandidateSide: 'yes',
      sameSideCooldownMs: 2 * 60 * 1000,
    });
    check(dogeYesAfterSitOut.ok, 'DOGE YES allowed after 2m sit-out when bounce+thesis ok');

    const sitOutSurvivesSessionEnd = checkPostStopSameSideCooldown({
      lastStopTrade: {
        exitReason: 'stop_loss',
        side: 'yes',
        symbol: 'DOGE',
        closedAt: Date.now() - 30 * 1000,
        windowCloseTime: Date.now() - 5 * 1000,
      },
      forCandidateSymbol: 'DOGE',
      forCandidateSide: 'yes',
      cooldownMs: 2 * 60 * 1000,
    });
    check(!sitOutSurvivesSessionEnd.ok, 'same-side sit-out still applies after window end until 2m');

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

    // Same-coin same-side sit-out after stop (knife-catch cooldown), even when bounce+thesis ok
    {
      checkEq(
        postStopSameSideCooldownMs({}),
        2 * 60 * 1000,
        'same-side cooldown defaults to 2 minutes'
      );
      checkEq(
        postStopSameSideCooldownMs({ postStopSameSideCooldownMinutes: 0 }),
        0,
        'same-side cooldown 0 disables'
      );
      checkEq(
        postStopSameSideCooldownMs({ postStopSameSideCooldownMinutes: 3 }),
        3 * 60 * 1000,
        'same-side cooldown uses configured minutes'
      );

      const dogeStopAt = Date.now() - 30_000;
      const dogeStop = {
        exitReason: 'stop_loss',
        side: 'yes',
        exitPriceCents: 30,
        entryPriceCents: 55,
        symbol: 'DOGE',
        closedAt: dogeStopAt,
        windowCloseTime: Date.now() + 10 * 60 * 1000,
      };
      const bouncedFavorYes = {
        lastClosedForSymbol: dogeStop,
        side: 'yes',
        priceCents: 69,
        window: { probabilityUp: 70, probabilityDown: 30 },
        recoveryCents: 6,
        symbol: 'DOGE',
        forCandidateSymbol: 'DOGE',
        forCandidateSide: 'yes',
        sameSideCooldownMs: 2 * 60 * 1000,
        now: dogeStopAt + 30_000,
      };
      const dogeYesBlocked = checkPostStopRecovery(bouncedFavorYes);
      check(!dogeYesBlocked.ok, 'DOGE YES blocked for 2m after stop even if bid bounced + thesis favors');
      check(
        /same-side sit-out ~2m/i.test(dogeYesBlocked.reason || ''),
        'same-side block message mentions sit-out ~2m'
      );
      checkEq(
        makeBot(mockClient({}))._protectionGateKey(dogeYesBlocked.reason),
        'same-side-cooldown',
        'protection gate key is same-side-cooldown'
      );

      const dogeNoOk = checkPostStopRecovery({
        ...bouncedFavorYes,
        forCandidateSide: 'no',
        window: { probabilityUp: 30, probabilityDown: 70 },
      });
      check(dogeNoOk.ok, 'DOGE NO allowed after bounce (opposite side, cooldown does not apply)');

      const ethOk = checkPostStopRecovery({
        ...bouncedFavorYes,
        forCandidateSymbol: 'ETH',
        forCandidateSide: 'yes',
      });
      check(ethOk.ok, 'ETH allowed after DOGE bounce (peer coin, cooldown does not apply)');

      const afterCooldown = checkPostStopRecovery({
        ...bouncedFavorYes,
        now: dogeStopAt + 2 * 60 * 1000 + 1,
      });
      check(afterCooldown.ok, 'DOGE YES allowed after 2m same-side sit-out');

      const disabled = checkPostStopRecovery({
        ...bouncedFavorYes,
        sameSideCooldownMs: 0,
      });
      check(disabled.ok, 'same-side cooldown 0 allows knife-catch when bounce+thesis ok');

      // Cooldown from closedAt even after session expiry (prefer keep until 2m)
      const sessionEndedStop = {
        ...dogeStop,
        windowCloseTime: dogeStopAt + 10_000,
      };
      check(
        isPostStopRecoverySessionExpired(sessionEndedStop, dogeStopAt + 30_000),
        'session expired for cooldown-vs-session fixture'
      );
      const stillSitOut = checkPostStopRecovery({
        ...bouncedFavorYes,
        lastClosedForSymbol: sessionEndedStop,
        now: dogeStopAt + 30_000,
      });
      check(!stillSitOut.ok, 'same-side sit-out still blocks after session end until 2m from closedAt');
      check(
        checkPostStopSameSideCooldown({
          lastStopTrade: dogeStop,
          forCandidateSymbol: 'DOGE',
          forCandidateSide: 'yes',
          cooldownMs: 2 * 60 * 1000,
          now: dogeStopAt + 30_000,
        }).ok === false,
        'checkPostStopSameSideCooldown blocks DOGE YES inside window'
      );
    }

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
  checkEq(failTrade.pendingForceExit, 'stop_loss', 'failed stop sets pendingForceExit');
  checkEq(liveOrders, 3, 'failed stop_loss retries sell up to 3 times');
  check(
    /will retry next cycle/i.test(String(failBot.lastDecision || '')),
    'failed stop decision mentions retry next cycle'
  );

  // pendingForceExit: retry forced close even when bid bounced above stop
  {
    let forceOrders = 0;
    const forcePrices = [];
    const forceClient = {
      hasCredentials: true,
      async createOrder({ action, priceCents }) {
        forceOrders += 1;
        forcePrices.push(priceCents);
        checkEq(action, 'sell', 'pendingForceExit issues sell');
        // Fail first manage cycle (3 attempts), succeed on second cycle.
        if (forceOrders <= 3) throw new Error('simulated force-exit miss');
        return { order: { order_id: `force-${forceOrders}`, fill_count_fp: '10.00', yes_price: priceCents } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '10.00',
            yes_price: 55,
          },
        };
      },
      async cancelOrder() {
        return {};
      },
      async getBalance() {
        return { balance: 100000, portfolio_value: 100000 };
      },
      async getMarket() {
        // Bid above stop (entry 60, stopLoss 10 → stop at 50) so normal stop would NOT fire.
        return {
          status: 'active',
          yes_bid: 55,
          yes_ask: 57,
          no_bid: 43,
          no_ask: 45,
          close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          floor_strike: 3000,
        };
      },
      async getOpenMarkets() {
        return [];
      },
    };
    const forceBot = makeBot(forceClient, {
      mode: 'live',
      liveAuthorized: true,
      stopLossCents: 10,
      takeProfitCents: 50,
    });
    forceBot.config.mode = 'live';
    forceBot.config.liveAuthorized = true;
    const forceTrade = openTrade(forceBot, {
      mode: 'live',
      liveOrderId: 'entry-force',
      side: 'yes',
      entryPriceCents: 60,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
      pendingForceExit: 'stop_loss',
    });
    await forceBot._manageOpenTrade(forceTrade, predictions(3100));
    checkEq(forceTrade.status, 'open', 'pendingForceExit still open after failed retry cycle');
    checkEq(forceTrade.pendingForceExit, 'stop_loss', 'pendingForceExit kept after failed retry');
    checkEq(forceOrders, 3, 'pendingForceExit cycle retries 3 sells');
    checkEq(forcePrices[0], 55, 'force exit attempt 1 at current bid');
    checkEq(forcePrices[1], 54, 'force exit attempt 2 one cent more aggressive');
    checkEq(forcePrices[2], 53, 'force exit attempt 3 two cents more aggressive');

    await forceBot._manageOpenTrade(forceTrade, predictions(3100));
    checkEq(forceTrade.status, 'closed', 'successful pendingForceExit closes trade');
    checkEq(forceTrade.exitReason, 'stop_loss', 'pendingForceExit close reason stop_loss');
    checkEq(forceTrade.pendingForceExit, undefined, 'successful close clears pendingForceExit');
    check(forceOrders >= 4, 'second cycle placed the filling sell');
  }

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

  // Live entry: one attempt — miss demotes coin; no same-second chase spam
  {
    let entryOrders = 0;
    const prices = [];
    const retryEntryClient = {
      hasCredentials: true,
      async createOrder({ count, priceCents }) {
        entryOrders += 1;
        prices.push(priceCents);
        return { order: { order_id: `entry-retry-${entryOrders}`, requested: count } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '0.00',
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
        return { yes_ask: 50, yes_bid: 49, no_ask: 51, no_bid: 50, status: 'open' };
      },
    };
    const retryBot = makeBot(retryEntryClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 5,
      minEntryCents: 1,
      skimMode: 'off',
    });
    retryBot.config.mode = 'live';
    retryBot.config.liveAuthorized = true;
    retryBot.setRunning(true);
    const opened = await retryBot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-RETRY',
      side: 'yes',
      priceCents: 50,
      floorStrike: 3000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    checkEq(opened, false, 'unfilled entry returns false');
    checkEq(retryBot.openTrades.length, 0, 'unfilled entry leaves no trade');
    checkEq(entryOrders, 1, 'unfilled entry places one buy (no chase retries)');
    check(retryBot._hasRecentEntryMiss('ETH'), 'fill miss demotes ETH briefly');
    check(/skipping this coin|focusing on other/i.test(retryBot.lastError || ''), 'miss message mentions skip/focus');
    check(/miss #1/i.test(retryBot.lastError || ''), 'first miss labeled #1');
    const m1 = retryBot._noteEntryMiss('ETH');
    check(m1.streak >= 2, 'second miss escalates streak');
    check(m1.cooldownMs >= 300_000, 'second miss cools ≥5m');
  }

  // Live entry: all attempts miss → no trade (single attempt)
  {
    let entryOrders = 0;
    const missClient = {
      hasCredentials: true,
      async createOrder({ count }) {
        entryOrders += 1;
        return { order: { order_id: `entry-miss-${entryOrders}`, requested: count } };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '0.00',
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
        return { yes_ask: 50, yes_bid: 49, status: 'open' };
      },
    };
    const missBot = makeBot(missClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 5,
      minEntryCents: 1,
      skimMode: 'off',
    });
    missBot.config.mode = 'live';
    missBot.config.liveAuthorized = true;
    await missBot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-MISS',
      side: 'yes',
      priceCents: 50,
      floorStrike: 3000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    checkEq(missBot.openTrades.length, 0, 'unfilled entry after miss leaves no trade');
    checkEq(entryOrders, 1, 'unfilled entry attempted 1 buy');
    check(/did not fill/i.test(missBot.lastError || ''), 'unfilled entry error mentions did not fill');
  }

  // Late fill after poll timeout: polls empty → cancel → getOrder then shows fills
  {
    let polls = 0;
    let canceled = false;
    const lateFillClient = {
      hasCredentials: true,
      async createOrder() {
        return { order_id: 'late-fill-oid', fill_count: '0.00', remaining_count: '8.00' };
      },
      async getOrder(orderId) {
        polls += 1;
        if (!canceled) {
          return {
            order: {
              order_id: orderId,
              status: 'resting',
              fill_count_fp: '0.00',
              remaining_count_fp: '8.00',
            },
          };
        }
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '8.00',
            remaining_count_fp: '0.00',
            average_fill_price: '0.5500',
          },
        };
      },
      async cancelOrder() {
        canceled = true;
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
    const lateBot = makeBot(lateFillClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 10,
      minEntryCents: 1,
      skimMode: 'off',
    });
    lateBot.config.mode = 'live';
    lateBot.config.liveAuthorized = true;
    lateBot.setRunning(true);
    await lateBot._openPosition({
      symbol: 'BTC',
      ticker: 'KXBTC15M-LATE',
      side: 'yes',
      priceCents: 55,
      floorStrike: 60000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    check(canceled, 'late-fill path cancels after poll timeout');
    checkEq(lateBot.openTrades.length, 1, 'late fill after timeout still ledgers trade');
    checkEq(lateBot.openTrades[0].contracts, 8, 'late fill uses recovered fill count');
    checkEq(lateBot.openTrades[0].liveOrderId, 'late-fill-oid', 'late fill stores liveOrderId');
    check(polls >= 2, 'late fill polled getOrder more than once');
  }

  // Fill detected only on post-cancel getOrder (cancel race)
  {
    let polls = 0;
    let canceled = false;
    const raceClient = {
      hasCredentials: true,
      async createOrder() {
        return { order: { order_id: 'cancel-race-oid' } };
      },
      async getOrder(orderId) {
        polls += 1;
        if (!canceled) {
          return {
            order: {
              order_id: orderId,
              status: 'resting',
              fill_count_fp: '0.00',
            },
          };
        }
        // After cancel: exchange reports the race fill that landed.
        return {
          order: {
            order_id: orderId,
            status: 'canceled',
            fill_count_fp: '2.00',
            yes_price: 48,
          },
        };
      },
      async cancelOrder() {
        canceled = true;
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
    const raceBot = makeBot(raceClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 5,
      minEntryCents: 1,
      skimMode: 'off',
    });
    raceBot.config.mode = 'live';
    raceBot.config.liveAuthorized = true;
    // Directly exercise await helper with short polls.
    const fill = await raceBot._awaitOrderFill('cancel-race-oid', {
      minFill: 5,
      attempts: 2,
      delayMs: 5,
    });
    check(canceled, 'cancel-race issues cancel');
    checkEq(fill.filled, 2, 'fill detected after cancel');
    check(fill.recovered === true, 'cancel-race marks recovered');
    check(fill.ok === false, 'partial after cancel is not full ok');
  }

  // Seed from Create Order V2 immediate fill skips orphaning when polls would fail
  {
    let getOrderCalls = 0;
    const seedClient = {
      hasCredentials: true,
      async createOrder({ count }) {
        return normalizeCreateOrderResponse({
          order_id: 'seed-immediate',
          fill_count: `${count}.00`,
          remaining_count: '0.00',
          average_fill_price: '0.5000',
        });
      },
      async getOrder() {
        getOrderCalls += 1;
        throw new Error('getOrder should not be required for immediate V2 fill');
      },
      async cancelOrder() {
        throw new Error('cancel should not run for immediate V2 fill');
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
    const seedBot = makeBot(seedClient, {
      mode: 'live',
      liveAuthorized: true,
      stakeDollars: 10,
      minEntryCents: 1,
      skimMode: 'off',
    });
    seedBot.config.mode = 'live';
    seedBot.config.liveAuthorized = true;
    await seedBot._openPosition({
      symbol: 'ETH',
      ticker: 'KXETH15M-SEED',
      side: 'yes',
      priceCents: 50,
      floorStrike: 3000,
      closeTime: Date.now() + 600_000,
      engineProbability: 60,
      engineConfidence: 70,
    });
    checkEq(seedBot.openTrades.length, 1, 'V2 immediate fill records trade from create seed');
    checkEq(seedBot.openTrades[0].contracts, 20, 'V2 immediate fill uses create fill_count');
    checkEq(seedBot.openTrades[0].entryPriceCents, 50, 'V2 immediate fill uses average_fill_price');
    checkEq(getOrderCalls, 0, 'V2 immediate fill does not need getOrder');
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
    checkEq(partialTrade.pendingForceExit, 'stop_loss', 'partial stop sets pendingForceExit');
    check(sellCalls >= 1, 'partial sell placed an order');
  }

  // V2 sell YES stop_loss: ask-book average_fill_price must not book false win/skim
  {
    const stopMisparseClient = {
      hasCredentials: true,
      async createOrder({ action, side, priceCents, count }) {
        checkEq(action, 'sell', 'stop misparse exit sells');
        checkEq(side, 'yes', 'stop misparse exit side yes');
        checkEq(priceCents, 18, 'stop misparse sells at bid limit');
        return normalizeCreateOrderResponse({
          order_id: 'stop-misparse-exit',
          fill_count: `${count}.00`,
          remaining_count: '0.00',
          average_fill_price: '0.8200',
          side: 'ask',
        });
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '14.00',
            average_fill_price: '0.8200',
            side: 'ask',
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
    const stopBot = makeBot(stopMisparseClient, {
      mode: 'live',
      liveAuthorized: true,
      skimMode: 'insurance',
    });
    stopBot.config.mode = 'live';
    stopBot.config.liveAuthorized = true;
    stopBot.ledger.insuranceCents = 2000;
    stopBot.ledger.insuranceReady = true;
    const stopTrade = openTrade(stopBot, {
      mode: 'live',
      liveOrderId: 'entry-stop-misparse',
      side: 'yes',
      entryPriceCents: 42,
      contracts: 14,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const closed = await stopBot._closePosition(stopTrade, 18, 'stop_loss', {
      liveSellPriceCents: 18,
    });
    checkEq(closed, true, 'stop misparse exit closes');
    checkEq(stopTrade.exitPriceCents, 18, 'stop misparse books YES exit not ask complement');
    checkEq(stopTrade.pnlCents, (18 - 42) * 14, 'stop misparse PnL reflects real loss');
    check(stopTrade.pnlCents < 0, 'stop misparse is a loss');
    checkEq(stopTrade.skimmedCents || 0, 0, 'loss on stop misparse gets no wallet skim');
  }

  // V2 sell YES take_profit: average_fill_price already YES — must not complement to fake loss
  {
    const tpMisparseClient = {
      hasCredentials: true,
      async createOrder({ action, side, priceCents, count }) {
        checkEq(action, 'sell', 'TP exit sells');
        checkEq(side, 'yes', 'TP exit side yes');
        checkEq(priceCents, 57, 'TP sells at take-profit limit');
        return normalizeCreateOrderResponse({
          order_id: 'tp-misparse-exit',
          fill_count: `${count}.00`,
          remaining_count: '0.00',
          average_fill_price: '0.5700',
          side: 'ask',
        });
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '10.00',
            average_fill_price: '0.5700',
            side: 'ask',
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
    const tpBot = makeBot(tpMisparseClient, {
      mode: 'live',
      liveAuthorized: true,
      skimMode: 'off',
    });
    tpBot.config.mode = 'live';
    tpBot.config.liveAuthorized = true;
    const tpTrade = openTrade(tpBot, {
      mode: 'live',
      liveOrderId: 'entry-tp-misparse',
      side: 'yes',
      entryPriceCents: 42,
      contracts: 10,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const closed = await tpBot._closePosition(tpTrade, 57, 'take_profit', {
      liveSellPriceCents: 57,
    });
    checkEq(closed, true, 'TP misparse exit closes');
    checkEq(tpTrade.exitPriceCents, 57, 'TP books 57¢ not blind complement 43¢');
    checkEq(tpTrade.pnlCents, (57 - 42) * 10, 'TP PnL is a real gain');
    check(tpTrade.pnlCents > 0, 'TP is a win');
  }

  // XRP false +$10.32: sell fill with misleading taker_fill_cost must book near
  // sell limit; maker entry with taker cost "0.00" must keep real entry (not 1¢).
  // PnL is gross (Kalshi-style); fees are a note only.
  {
    const xrpEntry = bot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.6900',
        taker_fill_cost_dollars: '0.00',
        maker_fill_cost_dollars: '9.66',
        fill_count: '14.00',
        side: 'bid',
      },
      'yes',
      'buy',
      69
    );
    checkEq(xrpEntry, 69, 'XRP-style maker entry books 69¢ not 1¢');
    // Old bug: entry=1 → (76−1)×14 = 1050 (~$10.50). Real gross: (76−69)×14 = 98.
    checkEq(
      bot._netPnlCents(1, 76, 14, 8, 10),
      1050,
      'sanity: 1¢ entry would invent the false ~$10.50 gross'
    );
    checkEq(
      bot._netPnlCents(xrpEntry, 76, 14, 8, 10),
      98,
      'XRP-style PnL is $0.98 gross (fees not subtracted)'
    );

    const xrpClient = {
      hasCredentials: true,
      async createOrder({ action, side, priceCents, count }) {
        checkEq(action, 'sell', 'XRP TP exit sells');
        checkEq(side, 'yes', 'XRP TP exit side yes');
        checkEq(priceCents, 76, 'XRP TP sells at pre_close/bid fill');
        return normalizeCreateOrderResponse({
          order_id: 'xrp-false-pnl-exit',
          fill_count: `${count}.00`,
          remaining_count: '0.00',
          average_fill_price: '0.7600',
          // Misleading: implies ~143¢/contract if trusted blindly (clamped 99).
          taker_fill_cost_dollars: '20.00',
          taker_fees_dollars: '0.10',
          side: 'ask',
        });
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '14.00',
            average_fill_price: '0.7600',
            taker_fill_cost_dollars: '20.00',
            taker_fees_dollars: '0.10',
            side: 'ask',
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
    const xrpBot = makeBot(xrpClient, {
      mode: 'live',
      liveAuthorized: true,
      skimMode: 'insurance',
    });
    xrpBot.config.mode = 'live';
    xrpBot.config.liveAuthorized = true;
    const xrpTrade = openTrade(xrpBot, {
      mode: 'live',
      liveOrderId: 'entry-xrp-false-pnl',
      side: 'yes',
      entryPriceCents: xrpEntry,
      contracts: 14,
      entryFeesCents: 8,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const xrpClosed = await xrpBot._closePosition(xrpTrade, 76, 'take_profit', {
      liveSellPriceCents: 76,
    });
    checkEq(xrpClosed, true, 'XRP-style TP closes');
    checkEq(xrpTrade.exitPriceCents, 76, 'XRP-style TP books avg/sell limit not cost-derived 99¢');
    checkEq(xrpTrade.pnlCents, 98, 'XRP-style TP PnL is $0.98 not false $10.32');
    checkEq(xrpTrade.feesCents, 18, 'XRP-style fees still recorded for the note');
    check(xrpTrade.pnlCents < 200, 'XRP-style TP must not invent huge PnL');
    // 40% wallet of $0.98 = $0.39 — not the logged Wallet +$4.13 from false $10.32
    checkEq(xrpTrade.skimmedCents, 39, 'XRP-style wallet skim matches real $0.98 win');
  }

  // ETH under-count: avg entry improvement + gross PnL ≈ Kalshi (not fee-netted limit prices)
  {
    const ethEntry = bot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.5200',
        taker_fill_cost_dollars: '9.52',
        fill_count: '17.00',
        side: 'bid',
      },
      'yes',
      'buy',
      56
    );
    const ethExit = bot._orderAvgFillPriceCents(
      {
        average_fill_price: '0.7900',
        taker_fill_cost_dollars: '13.43',
        fill_count: '17.00',
        side: 'ask',
      },
      'yes',
      'sell',
      79
    );
    checkEq(ethEntry, 52, 'ETH-style entry uses avg improvement (52) not limit cost (56)');
    checkEq(ethExit, 79, 'ETH-style exit uses average_fill_price');
    // Old dashboard: (79−56)×17 − 49 = 342 ($3.42). Kalshi ≈ (79−52)×17 = 459 ($4.59).
    checkEq(bot._netPnlCents(56, 79, 17, 24, 25), 391, 'limit prices gross without fee net');
    checkEq(
      bot._netPnlCents(ethEntry, ethExit, 17, 24, 25),
      459,
      'ETH-style PnL ~$4.59 matches Kalshi-style trade PnL (not $3.42)'
    );
  }

  // Fees are recorded for the note; PnL stays gross (Kalshi trade PnL)
  {
    checkEq(
      bot._orderFeesCents({
        taker_fees_dollars: '0.12',
        maker_fees_dollars: '0.03',
        fill_count: '10',
      }),
      15,
      'taker+maker fees → cents'
    );
    checkEq(
      bot._orderFeesCents({
        average_fee_paid: '0.0200',
        fill_count: '10.00',
      }),
      20,
      'V2 average_fee_paid × fills → cents'
    );
    checkEq(
      bot._netPnlCents(42, 57, 10, 12, 15),
      (57 - 42) * 10,
      'PnL is gross; fee args do not reduce it'
    );

    const feeClient = {
      hasCredentials: true,
      async getMarket() {
        return {
          status: 'active',
          yes_bid: 57,
          yes_ask: 59,
          close_time: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
          floor_strike: 3000,
        };
      },
      async getOpenMarkets() {
        return [];
      },
      async createOrder() {
        return {
          order: {
            order_id: 'oid-fee-exit',
            fill_count: '10.00',
            average_fill_price: '0.5700',
            taker_fees_dollars: '0.15',
          },
        };
      },
      async getOrder(orderId) {
        return {
          order: {
            order_id: orderId,
            status: 'executed',
            fill_count_fp: '10.00',
            average_fill_price: '0.5700',
            taker_fees_dollars: '0.15',
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
    const feeBot = makeBot(feeClient, { mode: 'live', liveAuthorized: true, skimMode: 'off' });
    feeBot.config.mode = 'live';
    feeBot.config.liveAuthorized = true;
    const feeTrade = openTrade(feeBot, {
      mode: 'live',
      liveOrderId: 'entry-fee',
      side: 'yes',
      entryPriceCents: 42,
      contracts: 10,
      entryFeesCents: 12,
      windowCloseTime: Date.now() + 10 * 60 * 1000,
    });
    const feeClosed = await feeBot._closePosition(feeTrade, 57, 'take_profit', {
      liveSellPriceCents: 57,
    });
    checkEq(feeClosed, true, 'fee-aware TP closes');
    checkEq(feeTrade.exitFeesCents, 15, 'exit fees booked from order');
    checkEq(feeTrade.feesCents, 27, 'total fees = entry + exit');
    checkEq(feeTrade.pnlCents, (57 - 42) * 10, 'PnL is gross; fees only in the note');
    check(
      feeBot.lastDecision.includes('fees $0.27'),
      'decision mentions fees without replacing P&L'
    );
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
  check(Object.keys(SERIES_BY_SYMBOL).includes('DOGE'), 'DOGE series kept for exit management');
  check(!isKalshiTradeEnabled('DOGE'), 'DOGE opted out of new trades');
  check(isKalshiTradeEnabled('BTC'), 'BTC still tradeable');
  check(!tradeableKalshiSymbols().includes('DOGE'), 'AUTO tradeable set excludes DOGE');
  check(tradeableKalshiSymbols().includes('ETH'), 'AUTO tradeable set includes ETH');
  check(tradeableKalshiSymbols().includes('NEAR'), 'AUTO tradeable set includes NEAR');
  check(tradeableKalshiSymbols().includes('HYPE'), 'AUTO tradeable set includes HYPE');
  check(tradeableKalshiSymbols().includes('BNB'), 'AUTO tradeable set includes BNB');
  checkEq(SERIES_BY_SYMBOL.NEAR, 'KXNEAR15M', 'NEAR Kalshi series');
  checkEq(SERIES_BY_SYMBOL.HYPE, 'KXHYPE15M', 'HYPE Kalshi series');

  section('settle strategy helpers');
  checkEq(settleEntryBand({}).min, 85, 'settle band default min 85');
  checkEq(settleEntryBand({}).max, 92, 'settle band default max 92');
  checkEq(settleMinUpsideCents({}), 8, 'settle min upside defaults to 8¢');
  checkEq(
    settleMinUpsideCents({ settleStopLossCents: 20 }),
    8,
    'wide settle stop does not force min upside = 20'
  );
  check(isSettleEntryPriceCents(87), '87¢ inside settle band');
  check(isSettleEntryPriceCents(92), '92¢ at settle band max');
  check(!isSettleEntryPriceCents(93), '93¢ outside tightened settle band');
  check(!isSettleEntryPriceCents(84), '84¢ outside settle band');
  check(!isSettleEntryPriceCents(96), '96¢ outside settle band');
  check(!isSettleEntryPriceCents(95), '95¢ outside tightened settle band');
  check(!isSettleEntryPriceCents(72, {}, 10), '72¢ blocked with 10m left (late not open)');
  check(isSettleEntryPriceCents(72, {}, 3), '72¢ allowed with 3m left (late fallback)');
  checkEq(settleEffectiveEntryBand({}, 3).min, 70, 'late effective band floor 70');
  checkEq(settleEffectiveEntryBand({}, 3).late, true, 'late flag on at 3m');
  checkEq(settleEffectiveEntryBand({}, 5).late, false, 'late flag off at 5m');
  check(isSettleStrategyMode({ strategyMode: 'settle' }), 'settle mode flag');
  check(!isSettleStrategyMode({ strategyMode: 'edge' }), 'edge mode flag');
  check(isSettleTrade({ strategy: 'settle' }), 'settle trade tag');
  {
    const settleBot = new TradingBot({
      kalshiClient: { hasCredentials: false },
      config: {
        mode: 'paper',
        liveAuthorized: false,
        strategyMode: 'settle',
        stopLossCents: 23,
        settleStopLossCents: 8,
      },
    });
    // Saved overrides can win in constructor — pin the value under test.
    settleBot.config.settleStopLossCents = 8;
    checkEq(
      settleBot._stopLevelCents({ strategy: 'settle', entryPriceCents: 87 }),
      79,
      'settle stop uses settleStopLossCents (87−8)'
    );
    settleBot.config.settleStopLossCents = 20;
    checkEq(
      settleBot._stopLevelCents({ strategy: 'settle', entryPriceCents: 87 }),
      67,
      'settle stop 20¢ → level 67'
    );
    checkEq(
      settleBot._stopLevelCents({ strategy: 'edge', entryPriceCents: 55 }),
      32,
      'edge stop still uses stopLossCents'
    );
    checkEq(
      settleBot._sanityCheckEntryFillCents(59, 81),
      81,
      'settle entry fill far below limit uses limit (not 59¢ ghost)'
    );
    settleBot.config.strategyMode = 'settle';
    settleBot.config.settlePostStopSameSideCooldownMinutes = 5;
    const stopAt = Date.now() - 10_000;
    settleBot.ledger.trades = [
      {
        status: 'closed',
        exitReason: 'stop_loss',
        symbol: 'SOL',
        side: 'yes',
        closedAt: stopAt,
        exitPriceCents: 37,
        windowCloseTime: stopAt + 10 * 60 * 1000,
      },
    ];
    const sameSideBlocked = await settleBot._stoppedCoinRecoveryGate('SOL', 'yes', 90, null, {});
    check(!sameSideBlocked.ok, 'settle mode blocks same-side re-entry during sit-out');
    check(/same-side sit-out/i.test(sameSideBlocked.reason || ''), 'settle sit-out reason mentions cooldown');
    const peerOk = await settleBot._stoppedCoinRecoveryGate('BNB', 'yes', 90, null, {});
    // Peer may still hit bounce/cascade; at minimum same-side must not apply to BNB.
    check(
      peerOk.ok || !/same-side sit-out/i.test(peerOk.reason || ''),
      'settle same-side sit-out does not apply to other coins'
    );
  checkEq(
      postStopSameSideCooldownMs({ strategyMode: 'settle' }),
      5 * 60 * 1000,
      'settle default same-side cooldown is 5m'
    );
    check(liquidityPriority('BTC') > liquidityPriority('XRP'), 'BTC ranked more liquid than XRP');
    check(
      settleRankAskScore(90) > settleRankAskScore(95),
      'settle AUTO prefers 90¢ ask over 95¢ (rich demotion)'
    );
    check(
      settleRankAskScore(92) > settleRankAskScore(88),
      'among sub-94 asks, higher still ranks better'
    );
    checkEq(settleExitPlan(91).targetCents, null, 'entry 91¢ holds to settle');
    checkEq(settleExitPlan(91).tier, 'hold', 'entry 91¢ is hold tier');
    checkEq(settleExitPlan(87).targetCents, 96, 'entry 87¢ aims for 96¢');
    checkEq(settleExitPlan(87).staleMinutesLeft, 2, 'entry 87¢ stale @ 2m left');
    checkEq(settleExitPlan(82).targetCents, 94, 'entry 82¢ aims for 94¢');
    checkEq(settleExitPlan(72).targetCents, 93, 'late entry 72¢ aims for 93¢');
    checkEq(settleExitPlan(94).targetCents, null, 'entry 94¢ holds to settle (no TP chase)');
    checkEq(settleExitPlan(90).tier, 'hold', 'entry 90¢ is hold tier');
    check(isSettleTieredExitsEnabled({}), 'tiered exits default on');
    check(isSettleTieredExitsEnabled({ settleTieredExits: 'on' }), 'tiered exits on');
    check(!isSettleTieredExitsEnabled({ settleTieredExits: 'off' }), 'tiered exits off');
  }

  // Settle Kalshi-only: no Coinbase ready still opens when ask is in band
  {
    const now = Date.now();
    const hypeMarket = {
      ticker: 'KXHYPE15M-KONLY',
      status: 'open',
      floor_strike: 40,
      close_time: new Date(now + 8 * 60 * 1000).toISOString(),
      yes_bid: 86,
      yes_ask: 88,
      no_bid: 12,
      no_ask: 14,
    };
    const kalshiOnlyBot = makeBot(mockClient(hypeMarket), {
      symbol: 'HYPE',
      strategyMode: 'settle',
      settleEntryMinCents: 80,
      settleEntryMaxCents: 92,
      settleMinMinutesToOpen: 0.5,
      settleMaxMinutesToOpen: 12,
      settleStopLossCents: 20,
      settleMinUpsideCents: 8,
      minEntryCents: 1,
    });
    kalshiOnlyBot.config.strategyMode = 'settle';
    const noFeedOpp = await kalshiOnlyBot._evaluateSymbolForSettle('HYPE', {
      HYPE: { ready: false, price: null },
    });
    check(noFeedOpp, 'settle allows Kalshi-only when Coinbase not ready');
    checkEq(noFeedOpp && noFeedOpp.side, 'yes', 'Kalshi-only picks YES in band');
    checkEq(noFeedOpp && noFeedOpp.engineReady, false, 'Kalshi-only marks engineReady false');
    checkEq(noFeedOpp && noFeedOpp.priceCents, 88, 'Kalshi-only uses yes ask');

    // Ready + lean against still blocks
    const leanNo = await kalshiOnlyBot._evaluateSymbolForSettle('HYPE', {
      HYPE: {
        ready: true,
        price: 40,
        windows: {
          w5: { probabilityUp: 35, probabilityDown: 65, confidence: 70 },
          w10: { probabilityUp: 35, probabilityDown: 65, confidence: 70 },
          w15: { probabilityUp: 35, probabilityDown: 65, confidence: 70 },
        },
      },
    });
    checkEq(leanNo, null, 'settle still blocks when spot lean disagrees');
    check(/leans NO/i.test(kalshiOnlyBot.lastDecision || ''), 'lean block decision mentions leans NO');

    // Rank scan includes not-ready coins (not stuck on "Not ready")
    const rankBot = makeBot(
      {
        hasCredentials: false,
        async getMarket() {
          return hypeMarket;
        },
        async getOpenMarkets(series) {
          if (series === 'KXHYPE15M') return [hypeMarket];
          return [];
        },
        async createOrder() {
          throw new Error('unused');
        },
        async getBalance() {
          return { balance: 0, portfolio_value: 0 };
        },
      },
      {
        symbol: 'AUTO',
        strategyMode: 'settle',
        settleEntryMinCents: 80,
        settleEntryMaxCents: 92,
        settleMinMinutesToOpen: 0.5,
        settleMaxMinutesToOpen: 12,
        settleStopLossCents: 20,
        settleMinUpsideCents: 8,
        minEntryCents: 1,
      }
    );
    rankBot.config.strategyMode = 'settle';
    rankBot.config.symbol = 'AUTO';
    const ranked = await rankBot._rankSettleOpportunities({
      BTC: { ready: false },
      ETH: { ready: false },
      SOL: { ready: false },
      XRP: { ready: false },
      BNB: { ready: false },
      NEAR: { ready: false },
      HYPE: { ready: false },
    });
    check(ranked.some((o) => o.symbol === 'HYPE'), 'settle rank includes Kalshi-only HYPE');
    check(/Kalshi-only/i.test(rankBot.lastDecision || ''), 'decision notes Kalshi-only coins');
  }

  // Settle toggle off: ignore entry-tiered TP even when target bid prints
  {
    const now = Date.now();
    const bot = makeBot(
      mockClient({
        status: 'open',
        close_time: new Date(now + 10 * 60 * 1000).toISOString(),
        yes_bid: 96,
        no_bid: 4,
      }),
      { settleStopLossCents: 8, settleTieredExits: 'off' }
    );
    const trade = openTrade(bot, {
      strategy: 'settle',
      side: 'yes',
      entryPriceCents: 91,
      windowCloseTime: now + 10 * 60 * 1000,
    });
    await bot._manageOpenTrade(trade, predictions(3000));
    checkEq(trade.status, 'open', 'settle tiered off holds through target bid');
  }
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
