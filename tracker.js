'use strict';

const fs = require('fs');
const path = require('path');
const { dataPath, ensureDataDir, pruneArchiveFiles } = require('./paths');

ensureDataDir();

const MAX_HISTORY = 40;
const CHECKPOINTS = [
  { key: 'w5', minutes: 5 },
  { key: 'w10', minutes: 10 },
  { key: 'w15', minutes: 15 },
];

const ROTATION_PERIOD_MS = 12 * 60 * 60 * 1000; // 12 hours
const PERIOD_STATE_PATH = dataPath('tracker-period-start.json');
const ARCHIVE_DIR = dataPath('archive');
const CALIBRATION_PATH = dataPath('calibration.json');
const HISTORY_PATH = dataPath('tracker-history.json');

function bucketLabel(probabilityOfCalledDirection) {
  if (probabilityOfCalledDirection >= 90) return '90-100%';
  const floor = Math.floor(probabilityOfCalledDirection / 10) * 10;
  return `${floor}-${floor + 9}%`;
}

function loadCalibration() {
  try {
    if (fs.existsSync(CALIBRATION_PATH)) {
      return JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[tracker] failed to load calibration stats, starting fresh:', err.message);
  }
  return {}; // symbol -> window -> bucketLabel -> { trades, wins }
}

function saveCalibration(calibration) {
  try {
    fs.mkdirSync(path.dirname(CALIBRATION_PATH), { recursive: true });
    fs.writeFileSync(CALIBRATION_PATH, JSON.stringify(calibration, null, 2));
  } catch (err) {
    console.error('[tracker] failed to persist calibration stats:', err.message);
  }
}

function loadPeriodStart() {
  try {
    if (fs.existsSync(PERIOD_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(PERIOD_STATE_PATH, 'utf8')).periodStartTime;
    }
  } catch {
    // fall through to a fresh period
  }
  return Date.now();
}

function savePeriodStart(periodStartTime) {
  try {
    fs.mkdirSync(path.dirname(PERIOD_STATE_PATH), { recursive: true });
    fs.writeFileSync(PERIOD_STATE_PATH, JSON.stringify({ periodStartTime }));
  } catch (err) {
    console.error('[tracker] failed to persist period start:', err.message);
  }
}

function loadHistory() {
  try {
    if (fs.existsSync(HISTORY_PATH)) {
      const raw = JSON.parse(fs.readFileSync(HISTORY_PATH, 'utf8'));
      const map = new Map();
      for (const [symbol, windows] of Object.entries(raw)) {
        map.set(symbol, {
          w5: (windows.w5 || []).slice(0, MAX_HISTORY),
          w10: (windows.w10 || []).slice(0, MAX_HISTORY),
          w15: (windows.w15 || []).slice(0, MAX_HISTORY),
        });
      }
      console.log('[tracker] loaded previous settlement history from disk');
      return map;
    }
  } catch (err) {
    console.error('[tracker] failed to load settlement history:', err.message);
  }
  return new Map();
}

function saveHistory(history) {
  try {
    fs.mkdirSync(path.dirname(HISTORY_PATH), { recursive: true });
    fs.writeFileSync(HISTORY_PATH, JSON.stringify(Object.fromEntries(history), null, 2));
  } catch (err) {
    console.error('[tracker] failed to persist settlement history:', err.message);
  }
}

/**
 * Tracks ONE cycle per symbol, tied to Kalshi's actual rolling 15-minute
 * market — not three independent per-window timers. All three checkpoints
 * (0-5 / 5-10 / 10-15 min) are measured from the SAME window-open time and
 * checked against the SAME target/strike price, exactly matching how
 * Kalshi's own contract works: one strike, one 15-minute clock, checked at
 * three points along the way.
 *
 * A new cycle only starts when Kalshi's ticker actually changes (a new
 * 15-minute market has opened) — never mid-window — so the countdown shown
 * for the 10-15 min checkpoint is always identical to the real Kalshi
 * window's own close time.
 *
 * Every 12 hours, the accumulated accuracy HISTORY (not any in-progress
 * cycle) is archived to data/archive/tracker-<period>.json and reset, so
 * the accuracy/track-record numbers reflect a rolling recent period rather
 * than growing indefinitely — while the prior 12 hours stays available in
 * the archive file rather than being lost.
 * Also maintains probability-bucketed calibration stats (e.g. "when we
 * called 70-79% confidence, how often were we actually right?") — this
 * accumulates FOREVER, deliberately never reset or rotated, per the intent
 * of "keep updating the statistics as every new prediction settles" — it's
 * meant to answer a different question than the 12h rolling history: not
 * "how have we done recently" but "how trustworthy is a given probability
 * level in this system, based on everything it's ever seen."
 */
class PredictionTracker {
  constructor() {
    this.cycles = new Map(); // symbol -> current cycle
    this.history = loadHistory(); // symbol -> { w5: [...], w10: [...], w15: [...] }, persisted to disk
    this.periodStartTime = loadPeriodStart();
    this.calibration = loadCalibration(); // symbol -> window -> bucketLabel -> { trades, wins } — never rotated
  }

  _historyFor(symbol) {
    if (!this.history.has(symbol)) {
      this.history.set(symbol, { w5: [], w10: [], w15: [] });
    }
    return this.history.get(symbol);
  }

  _maybeRotate(now) {
    if (now - this.periodStartTime < ROTATION_PERIOD_MS) return;

    try {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const archive = {
        periodStart: new Date(this.periodStartTime).toISOString(),
        periodEnd: new Date(now).toISOString(),
        history: Object.fromEntries(this.history.entries()),
      };
      const fileName = `tracker-${new Date(this.periodStartTime).toISOString().replace(/[:.]/g, '-')}.json`;
      fs.writeFileSync(path.join(ARCHIVE_DIR, fileName), JSON.stringify(archive, null, 2));
      console.log(`[tracker] archived the last 12h of accuracy history to data/archive/${fileName}`);
      pruneArchiveFiles({ now });
    } catch (err) {
      console.error('[tracker] failed to archive history before rotation:', err.message);
    }

    this.history = new Map(); // fresh accuracy stats for the new period
    this.periodStartTime = now;
    savePeriodStart(now);
    saveHistory(this.history);
    // Deliberately NOT touching this.cycles here — an in-progress Kalshi
    // window keeps tracking normally straight through a rotation boundary.
  }

  /**
   * Call once per compute cycle per symbol.
   * ticker: Kalshi's current market ticker for this symbol (identifies the cycle)
   * targetPrice: the one static strike/target price for this cycle
   * closeTime: when this Kalshi market closes (ms epoch) — also the 10-15 min checkpoint
   * currentPrice: live price right now
   * windows: this cycle's fresh { w5, w10, w15 } prediction objects (need .probabilityUp)
   * now: Date.now()
   *
   * Returns { w5: {...}, w10: {...}, w15: {...} } — one tracking/history/accuracy
   * bundle per window, all sharing the same baseline price and window-open time.
   */
  update(symbol, { ticker, targetPrice, closeTime, currentPrice, windows, now }) {
    this._maybeRotate(now);

    let cycle = this.cycles.get(symbol);
    const isNewCycle = !cycle || cycle.ticker !== ticker;

    if (isNewCycle) {
      const windowOpenTime = closeTime - 15 * 60 * 1000;
      cycle = {
        ticker,
        baselinePrice: targetPrice,
        windowOpenTime,
        closeTime,
        predictedDirection: {
          w5: windows.w5.probabilityUp >= 50 ? 'UP' : 'DOWN',
          w10: windows.w10.probabilityUp >= 50 ? 'UP' : 'DOWN',
          w15: windows.w15.probabilityUp >= 50 ? 'UP' : 'DOWN',
        },
        predictedProbability: {
          // Probability OF the called direction (always >=50 by
          // construction) — this is what gets bucketed for calibration.
          w5: Math.max(windows.w5.probabilityUp, windows.w5.probabilityDown),
          w10: Math.max(windows.w10.probabilityUp, windows.w10.probabilityDown),
          w15: Math.max(windows.w15.probabilityUp, windows.w15.probabilityDown),
        },
        resolved: { w5: false, w10: false, w15: false },
      };
      this.cycles.set(symbol, cycle);
    }

    const hist = this._historyFor(symbol);
    const result = {};

    for (const { key, minutes } of CHECKPOINTS) {
      const checkpointTime = cycle.windowOpenTime + minutes * 60 * 1000;

      if (!cycle.resolved[key] && now >= checkpointTime) {
        const actualDirection = currentPrice >= cycle.baselinePrice ? 'UP' : 'DOWN';
        const correct = actualDirection === cycle.predictedDirection[key];
        const changePct = ((currentPrice - cycle.baselinePrice) / cycle.baselinePrice) * 100;

        hist[key].unshift({
          windowOpenTime: cycle.windowOpenTime,
          checkpointTime,
          windowMinutes: minutes,
          baselinePrice: cycle.baselinePrice,
          predictedDirection: cycle.predictedDirection[key],
          actualPrice: currentPrice,
          actualDirection,
          changePct: +changePct.toFixed(4),
          correct,
        });
        if (hist[key].length > MAX_HISTORY) hist[key].length = MAX_HISTORY;
        cycle.resolved[key] = true;
        saveHistory(this.history);

        // Calibration: bucket by the probability we actually called at
        // entry, and update forever (never rotated/reset).
        const bucket = bucketLabel(cycle.predictedProbability[key]);
        this.calibration[symbol] = this.calibration[symbol] || {};
        this.calibration[symbol][key] = this.calibration[symbol][key] || {};
        const cell = (this.calibration[symbol][key][bucket] = this.calibration[symbol][key][bucket] || {
          trades: 0,
          wins: 0,
        });
        cell.trades += 1;
        if (correct) cell.wins += 1;
        saveCalibration(this.calibration);
      }

      const secondsRemaining = Math.max(0, Math.round((checkpointTime - now) / 1000));
      const resolvedCount = hist[key].length;
      const correctCount = hist[key].filter((h) => h.correct).length;

      result[key] = {
        tracking: {
          madeAt: cycle.windowOpenTime,
          targetTime: checkpointTime,
          secondsRemaining,
          baselinePrice: cycle.baselinePrice,
          predictedDirection: cycle.predictedDirection[key],
        },
        lastResult: hist[key][0] || null,
        accuracy: {
          sampleSize: resolvedCount,
          correctCount,
          accuracyPct: resolvedCount ? +((correctCount / resolvedCount) * 100).toFixed(1) : null,
        },
        history: hist[key].slice(0, 10),
      };
    }

    return result;
  }

  /**
   * Returns calibration stats for one symbol, all windows, with a maturity
   * label per bucket so it's clear how much to trust each number:
   *   < 40 trades:  'insufficient' - not enough data to trust yet
   *   40-99:        'developing'   - a reasonable starting signal
   *   100-199:      'good'         - reasonably trustworthy
   *   200+:         'reliable'     - well-supported by data
   */
  getCalibration(symbol) {
    const data = this.calibration[symbol] || {};
    const withMaturity = {};
    for (const windowKey of Object.keys(data)) {
      withMaturity[windowKey] = {};
      for (const [bucket, cell] of Object.entries(data[windowKey])) {
        const winRatePct = cell.trades ? +((cell.wins / cell.trades) * 100).toFixed(1) : null;
        let maturity = 'insufficient';
        if (cell.trades >= 200) maturity = 'reliable';
        else if (cell.trades >= 100) maturity = 'good';
        else if (cell.trades >= 40) maturity = 'developing';
        withMaturity[windowKey][bucket] = { trades: cell.trades, wins: cell.wins, winRatePct, maturity };
      }
    }
    return withMaturity;
  }
}

module.exports = { PredictionTracker };
