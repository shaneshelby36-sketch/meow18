'use strict';

const { gatherIndicators, directionalScore, buildWindowPrediction, WINDOWS } = require('./prediction');
const { SignalAccumulatorManager } = require('./signalAccumulator');

const LOOKBACK_MIN = 210;
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

// Same half-lives as the live engine, so a backtest run reflects the exact
// same accumulating-signal methodology that's actually trading live —
// not a separate, disconnected snapshot-only simulation.
const HALF_LIFE_MS = { w5: 2 * 60 * 1000, w10: 4 * 60 * 1000, w15: 7 * 60 * 1000 };

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function makeSeries(historySlice) {
  return {
    candles: historySlice,
    closes: () => historySlice.map((c) => c.close),
    volumes: () => historySlice.map((c) => c.volume),
    latestClose: () => historySlice[historySlice.length - 1].close,
    ready: (n) => historySlice.length >= n,
  };
}

function normalizeSettings(raw = {}) {
  const skimMode = ['percent', 'fixed', 'off'].includes(raw.skimMode) ? raw.skimMode : 'fixed';
  return {
    edgeThresholdPct: Number.isFinite(Number(raw.edgeThresholdPct)) ? Number(raw.edgeThresholdPct) : 8,
    minConfidence: Number.isFinite(Number(raw.minConfidence)) ? Number(raw.minConfidence) : 55,
    stopLossCents: Number.isFinite(Number(raw.stopLossCents)) ? Number(raw.stopLossCents) : 35,
    stakeDollars: Number.isFinite(Number(raw.stakeDollars)) ? Number(raw.stakeDollars) : 10,
    stakingStrategy: raw.stakingStrategy === 'halve-after-win' ? 'halve-after-win' : 'fixed',
    maxOpenPositions: Math.max(1, Math.round(Number(raw.maxOpenPositions) || 1)),
    skimMode,
    skimPercent: Number.isFinite(Number(raw.skimPercent)) ? Number(raw.skimPercent) : 20,
    skimFixedDollars: Number.isFinite(Number(raw.skimFixedDollars)) ? Number(raw.skimFixedDollars) : 5,
    guardrailDollars: Number.isFinite(Number(raw.guardrailDollars)) ? Number(raw.guardrailDollars) : 70,
    paperStartingBalanceDollars: Number.isFinite(Number(raw.paperStartingBalanceDollars))
      ? Number(raw.paperStartingBalanceDollars)
      : 100,
    // No historical Kalshi book — assume even-money (50¢) so edge is vs a coin flip.
    assumedEntryCents: Number.isFinite(Number(raw.assumedEntryCents)) ? Number(raw.assumedEntryCents) : 50,
  };
}

function pickWindowKey(minutesRemaining) {
  if (minutesRemaining > 10) return 'w5';
  if (minutesRemaining > 5) return 'w10';
  return 'w15';
}

function computeSkim(pnlCents, settings) {
  if (pnlCents <= 0 || settings.skimMode === 'off') return 0;
  if (settings.skimMode === 'fixed') {
    return Math.min(Math.round(settings.skimFixedDollars * 100), pnlCents);
  }
  return Math.round(pnlCents * (settings.skimPercent / 100));
}

function computeNextStake(settings, lastClosed) {
  if (settings.stakingStrategy !== 'halve-after-win') return settings.stakeDollars;
  if (!lastClosed) return settings.stakeDollars;
  if (lastClosed.pnlCents > 0) return Math.max(0.5, lastClosed.stakeDollars / 2);
  return settings.stakeDollars;
}

/** Crude mark for a binary contract from spot move (no historical Kalshi quotes). */
function estimateMarkCents(side, entrySpot, currentSpot) {
  const pct = (currentSpot - entrySpot) / entrySpot;
  const signed = side === 'yes' ? pct : -pct;
  return clamp(Math.round(50 + (signed / 0.02) * 50), 1, 99);
}

/**
 * Directional accuracy by prediction window (engine quality, not trading P&L).
 */
function backtestSymbol(candles, { stepMinutes = 1 } = {}) {
  const perWindow = {};

  for (const w of WINDOWS) {
    perWindow[w.key] = {
      label: w.label,
      minutes: w.minutes,
      correct: 0,
      total: 0,
    };
  }

  const accumulatorManager = new SignalAccumulatorManager(HALF_LIFE_MS);
  const maxHorizon = Math.max(...WINDOWS.map((w) => w.minutes));
  const lastUsableIndex = candles.length - maxHorizon - 1;

  for (let i = LOOKBACK_MIN; i <= lastUsableIndex; i += stepMinutes) {
    const historySlice = candles.slice(0, i + 1);
    const series = makeSeries(historySlice);
    const ind = gatherIndicators(series, null);
    if (!ind) continue;

    const currentPrice = candles[i].close;
    const historicalNow = candles[i].time;

    for (const w of WINDOWS) {
      const { weighted } = directionalScore(ind, w.key);
      const accumulator = accumulatorManager.get('backtest', w.key);
      const { netDominance } = accumulator.update(Object.values(weighted), historicalNow);
      const predictedUp = netDominance > 0;

      const futureIndex = i + w.minutes;
      if (futureIndex >= candles.length) continue;

      const actualUp = candles[futureIndex].close >= currentPrice;
      perWindow[w.key].total += 1;
      if (predictedUp === actualUp) perWindow[w.key].correct += 1;
    }
  }

  const summary = {};
  for (const key of Object.keys(perWindow)) {
    const { label, minutes, correct, total } = perWindow[key];
    const accuracyPct = total ? +((correct / total) * 100).toFixed(1) : null;
    const illustrativeReturnPct = accuracyPct != null ? +((2 * accuracyPct - 100).toFixed(1)) : null;
    summary[key] = {
      window: label,
      minutes,
      sampleSize: total,
      correctCount: correct,
      accuracyPct,
      illustrativeReturnPct,
    };
  }

  return summary;
}

/**
 * Paper-trade simulation using the dashboard settings. Assumes even-money
 * Kalshi entry (default 50¢) because historical Kalshi quotes aren't available.
 */
function backtestWithSettings(candles, rawSettings = {}, { stepMinutes = 1 } = {}) {
  const settings = normalizeSettings(rawSettings);
  const accumulatorManager = new SignalAccumulatorManager(HALF_LIFE_MS);

  const startingCents = Math.round(settings.paperStartingBalanceDollars * 100);
  const guardrailCents = Math.round(settings.guardrailDollars * 100);
  const entryCents = clamp(Math.round(settings.assumedEntryCents), 1, 99);

  let reserveCents = 0;
  let closedPnlCents = 0;
  const openTrades = [];
  const closedTrades = [];
  const skipCounts = {
    lowConfidence: 0,
    lowEdge: 0,
    maxPositions: 0,
    guardrail: 0,
    insufficientCash: 0,
  };

  const openExposure = () =>
    openTrades.reduce((sum, t) => sum + t.entryPriceCents * t.contracts, 0);

  const availableCash = () =>
    Math.max(0, startingCents + closedPnlCents - reserveCents - openExposure());

  for (let i = LOOKBACK_MIN; i < candles.length; i += stepMinutes) {
    const candle = candles[i];
    const now = candle.time;
    const spot = candle.close;

    // --- manage open trades ---
    for (let t = openTrades.length - 1; t >= 0; t -= 1) {
      const trade = openTrades[t];
      const mark = estimateMarkCents(trade.side, trade.entrySpot, spot);
      let exitPrice = null;
      let reason = null;

      if (mark <= settings.stopLossCents) {
        exitPrice = settings.stopLossCents;
        reason = 'stop_loss';
      } else if (now >= trade.closeTime || i >= trade.settleIndex) {
        const settledUp = candles[Math.min(trade.settleIndex, candles.length - 1)].close >= trade.entrySpot;
        const won = trade.side === 'yes' ? settledUp : !settledUp;
        exitPrice = won ? 100 : 0;
        reason = 'settled';
      }

      if (exitPrice == null) continue;

      const pnlCents = exitPrice * trade.contracts - trade.entryPriceCents * trade.contracts;
      const skimmedCents = computeSkim(pnlCents, settings);
      reserveCents += skimmedCents;
      closedPnlCents += pnlCents;
      closedTrades.push({
        ...trade,
        exitPriceCents: exitPrice,
        exitReason: reason,
        pnlCents,
        skimmedCents,
        closedAt: now,
      });
      openTrades.splice(t, 1);
    }

    if (i > candles.length - 16) continue; // need room for a 15m settle

    const historySlice = candles.slice(0, i + 1);
    const series = makeSeries(historySlice);
    const ind = gatherIndicators(series, null);
    if (!ind) continue;

    const bucketStart = Math.floor(now / FIFTEEN_MIN_MS) * FIFTEEN_MIN_MS;
    const closeTime = bucketStart + FIFTEEN_MIN_MS;
    const minutesRemaining = Math.max(0.1, (closeTime - now) / 60000);
    const minutesIntoBucket = (now - bucketStart) / 60000;

    // One decision per Kalshi-style 15-minute market (first minute of the bucket).
    if (minutesIntoBucket > 1.01) continue;

    const windowKey = pickWindowKey(minutesRemaining);
    const windowDef = WINDOWS.find((w) => w.key === windowKey);

    const alreadyInBucket = openTrades.some((t) => t.bucketStart === bucketStart)
      || closedTrades.some((t) => t.bucketStart === bucketStart);
    if (alreadyInBucket) continue;

    if (openTrades.length >= settings.maxOpenPositions) {
      skipCounts.maxPositions += 1;
      continue;
    }

    const accumulator = accumulatorManager.get('backtest-trade', windowKey);
    const prediction = buildWindowPrediction(
      windowDef,
      ind,
      null,
      null,
      spot, // no historical Kalshi strike — same neutral fallback as live
      'backtest',
      accumulator,
      now
    );

    if (prediction.confidence < settings.minConfidence) {
      skipCounts.lowConfidence += 1;
      continue;
    }

    const kalshiImpliedYesPct = entryCents; // even-money assumption
    const edge = prediction.probabilityUp - kalshiImpliedYesPct;
    if (Math.abs(edge) < settings.edgeThresholdPct) {
      skipCounts.lowEdge += 1;
      continue;
    }

    const side = edge > 0 ? 'yes' : 'no';
    const lastClosed = closedTrades.length ? closedTrades[closedTrades.length - 1] : null;
    const stakeDollars = computeNextStake(settings, lastClosed);
    const contracts = Math.max(1, Math.floor((stakeDollars * 100) / entryCents));
    const entryCostCents = entryCents * contracts;

    if (entryCostCents > guardrailCents - openExposure()) {
      skipCounts.guardrail += 1;
      continue;
    }
    if (entryCostCents > availableCash()) {
      skipCounts.insufficientCash += 1;
      continue;
    }

    const settleIndex = Math.min(
      candles.length - 1,
      i + Math.max(1, Math.ceil(minutesRemaining))
    );

    openTrades.push({
      side,
      entryPriceCents: entryCents,
      contracts,
      stakeDollars,
      entrySpot: spot,
      bucketStart,
      closeTime,
      settleIndex,
      engineProbability: side === 'yes' ? prediction.probabilityUp : prediction.probabilityDown,
      engineConfidence: prediction.confidence,
      edge: Math.abs(edge),
      window: prediction.window,
      openedAt: now,
    });
  }

  // Force-settle anything still open at end of series.
  for (const trade of openTrades.splice(0)) {
    const endSpot = candles[candles.length - 1].close;
    const settledUp = endSpot >= trade.entrySpot;
    const won = trade.side === 'yes' ? settledUp : !settledUp;
    const exitPrice = won ? 100 : 0;
    const pnlCents = exitPrice * trade.contracts - trade.entryPriceCents * trade.contracts;
    const skimmedCents = computeSkim(pnlCents, settings);
    reserveCents += skimmedCents;
    closedPnlCents += pnlCents;
    closedTrades.push({
      ...trade,
      exitPriceCents: exitPrice,
      exitReason: 'end_of_data',
      pnlCents,
      skimmedCents,
      closedAt: candles[candles.length - 1].time,
    });
  }

  const wins = closedTrades.filter((t) => t.pnlCents > 0).length;
  const losses = closedTrades.filter((t) => t.pnlCents <= 0).length;
  const available = availableCash();
  const openPos = openExposure();
  const totalEquity = available + openPos + reserveCents;
  const netPnl = totalEquity - startingCents;
  const stopLossExits = closedTrades.filter((t) => t.exitReason === 'stop_loss').length;

  return {
    settings,
    trades: closedTrades.length,
    wins,
    losses,
    winRatePct: closedTrades.length ? +((wins / closedTrades.length) * 100).toFixed(1) : null,
    stopLossExits,
    startingBankrollCents: startingCents,
    availableCashCents: available,
    openPositionsValueCents: openPos,
    reservedProfitCents: reserveCents,
    totalEquityCents: totalEquity,
    netPnlCents: netPnl,
    grossClosedPnlCents: closedPnlCents,
    skipCounts,
    recentTrades: closedTrades.slice(-15).reverse().map((t) => ({
      side: t.side,
      window: t.window,
      stakeDollars: t.stakeDollars,
      confidence: t.engineConfidence,
      edge: +t.edge.toFixed(1),
      pnlDollars: +(t.pnlCents / 100).toFixed(2),
      exitReason: t.exitReason,
    })),
    note:
      'Simulated with your bot settings against historical Coinbase prices. Kalshi quotes are assumed even-money (50¢ entry) because historical Kalshi order books are not available — real fill prices and edges will differ. Order-book signals are also excluded.',
  };
}

module.exports = {
  backtestSymbol,
  backtestWithSettings,
  normalizeSettings,
  LOOKBACK_MIN,
};
