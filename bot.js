'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath, ensureDataDir, writeJsonAtomic } = require('./paths');

ensureDataDir();

const LEDGER_PATH = dataPath('bot-ledger.json');
const CONFIG_PATH = dataPath('bot-config.json');
const CALIBRATION_PATH = dataPath('calibration.json');
const MODE_STATE_PATH = dataPath('bot-mode-state.json');
const RUN_STATE_PATH = dataPath('bot-run-state.json');
const ARCHIVE_DIR = dataPath('archive');
const ROTATION_PERIOD_MS = 12 * 60 * 60 * 1000; // 12 hours

// Minimum sample sizes before a bucket's win rate is worth trusting, per the
// standard rule of thumb: a handful of trades tells you almost nothing, a
// few hundred starts to actually mean something.
const CALIBRATION_GUIDANCE = {
  minToStartTrusting: 40,
  better: 100,
  best: 200,
};

function loadCalibration() {
  try {
    if (fs.existsSync(CALIBRATION_PATH)) {
      return JSON.parse(fs.readFileSync(CALIBRATION_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[bot] failed to load calibration data, starting fresh:', err.message);
  }
  return { buckets: {} };
}

function saveCalibration(calibration) {
  try {
    writeJsonAtomic(CALIBRATION_PATH, calibration);
  } catch (err) {
    console.error('[bot] failed to persist calibration data:', err.message);
  }
}

// Kalshi's rolling 15-minute crypto series tickers. Confirmed live as of this
// writing: BTC, ETH, SOL, XRP, DOGE, and BNB. ZEC is deliberately NOT
// included here — Kalshi does not currently have a 15-minute market for it
// (confirmed via Kalshi's own market listings), so the bot can track ZEC's
// price/predictions via Coinbase but cannot place Kalshi trades on it.
// VERIFY the non-BTC tickers against docs.kalshi.com / the live /series list
// before trusting them in production — they follow BTC's confirmed
// KXBTC15M naming pattern, but weren't each individually confirmed against
// Kalshi's own spec character-for-character.
const SERIES_BY_SYMBOL = {
  BTC: 'KXBTC15M',
  ETH: 'KXETH15M',
  SOL: 'KXSOL15M',
  XRP: 'KXXRP15M',
  DOGE: 'KXDOGE15M',
  BNB: 'KXBNB15M',
};

// Settings that can be safely edited at runtime (via the API/dashboard)
// without a restart. Deliberately excludes `mode` — switching paper/live
// stays an env-var + restart decision, so a UI can never silently flip on
// real trading.
const EDITABLE_NUMERIC_FIELDS = [
  'edgeThresholdPct',
  'minConfidence',
  'stopLossCents',
  'takeProfitCents',
  'stakeDollars',
  'maxOpenPositions',
  'skimPercent',
  'skimFixedDollars',
  'guardrailDollars',
  'paperStartingBalanceDollars',
];
const EDITABLE_STRING_FIELDS = {
  symbol: (v) => (v === 'AUTO' || SERIES_BY_SYMBOL[v] ? v : null),
  skimMode: (v) => (['percent', 'fixed', 'off'].includes(v) ? v : null),
  stakingStrategy: (v) => (['fixed', 'halve-after-win'].includes(v) ? v : null),
};

// Runtime pause/resume toggle between paper and live, kept in its own
// small file separate from general settings so it's easy to audit or
// manually reset by just deleting one file. This is deliberately checked
// against `liveAuthorized` every time it's loaded, never trusted blindly —
// see loadModeState below.
function loadModeState() {
  try {
    if (fs.existsSync(MODE_STATE_PATH)) {
      return JSON.parse(fs.readFileSync(MODE_STATE_PATH, 'utf8')).mode;
    }
  } catch {
    // fall through
  }
  return null;
}

function saveModeState(mode) {
  try {
    writeJsonAtomic(MODE_STATE_PATH, { mode });
  } catch (err) {
    console.error('[bot] failed to persist mode state:', err.message);
  }
}

function loadRunState() {
  try {
    if (fs.existsSync(RUN_STATE_PATH)) return JSON.parse(fs.readFileSync(RUN_STATE_PATH, 'utf8'));
  } catch {
    // A missing or corrupt runtime state simply starts the bot enabled.
  }
  return { isRunning: true, runningSince: Date.now() };
}

function saveRunState(state) {
  try {
    writeJsonAtomic(RUN_STATE_PATH, state);
  } catch (err) {
    console.error('[bot] failed to persist run state:', err.message);
  }
}

function loadConfigOverrides() {
  try {
    if (fs.existsSync(CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
    }
  } catch (err) {
    console.error('[bot] failed to load saved config, using defaults/env:', err.message);
  }
  return {};
}

function collectConfigOverrides(config) {
  const overrides = {};
  for (const field of EDITABLE_NUMERIC_FIELDS) overrides[field] = config[field];
  for (const field of Object.keys(EDITABLE_STRING_FIELDS)) overrides[field] = config[field];
  return overrides;
}

function saveConfigOverrides(overrides) {
  try {
    writeJsonAtomic(CONFIG_PATH, overrides);
  } catch (err) {
    console.error('[bot] failed to persist config:', err.message);
  }
}

function loadLedger() {
  try {
    if (fs.existsSync(LEDGER_PATH)) {
      const data = JSON.parse(fs.readFileSync(LEDGER_PATH, 'utf8'));
      if (data.reserveCents == null) data.reserveCents = 0;
      if (data.periodStartTime == null) data.periodStartTime = Date.now();
      return data;
    }
  } catch (err) {
    console.error('[bot] failed to load ledger, starting fresh:', err.message);
  }
  return { trades: [], reserveCents: 0, periodStartTime: Date.now() };
}

function saveLedger(ledger) {
  try {
    writeJsonAtomic(LEDGER_PATH, ledger);
  } catch (err) {
    // Non-fatal — on some hosts (e.g. free-tier Render) disk is ephemeral
    // across deploys anyway, so this is best-effort durability only.
    console.error('[bot] failed to persist ledger:', err.message);
  }
}

/**
 * Watches Kalshi's rolling KXBTC15M market, compares the engine's own
 * probability estimate against Kalshi's live implied odds, and opens a
 * position when there's a meaningful edge — closing it either when the
 * user's stop-loss triggers (odds on the held side fall to the configured
 * cents threshold) or when the market itself settles.
 *
 * Runs in one of two modes, controlled entirely by config the caller passes
 * in — this module never decides on its own to go live:
 *   - paper: everything is simulated against live Kalshi prices, no real
 *     order is ever sent.
 *   - live: real orders are placed via the provided KalshiClient.
 */
class TradingBot {
  constructor({ kalshiClient, config }) {
    this.client = kalshiClient;
    this.config = {
      symbol: 'BTC', // 'BTC' | 'XRP' — which asset the bot is currently trading
      edgeThresholdPct: 8, // minimum probability-point edge vs Kalshi to bother trading
      minConfidence: 55, // engine confidence (0-100) required to act
      stopLossCents: 35, // exit if our held side's price falls to this many cents
      takeProfitCents: 70, // exit if our held side's bid rises to this many cents (see final-5 override)
      stakeDollars: 10, // how much money to risk per trade; contracts are computed from this at entry time
      stakingStrategy: 'fixed', // 'fixed' | 'halve-after-win' — see _computeNextStake for the logic
      maxOpenPositions: 1,
      skimMode: 'fixed', // 'percent' | 'fixed' | 'off' — how much profit gets set aside per win
      skimPercent: 20, // used when skimMode === 'percent'
      skimFixedDollars: 5, // used when skimMode === 'fixed' ($5.00 per win), capped at that trade's own profit
      guardrailDollars: 70, // maximum capital this bot may have at risk at once
      paperStartingBalanceDollars: 100, // simulated bankroll, excluding skimmed reserve
      mode: 'paper', // 'paper' | 'live'
      liveAuthorized: false,
      ...config,
      ...loadConfigOverrides(), // saved runtime edits win over env/defaults, except `mode`/`liveAuthorized`
    };
    // `liveAuthorized` is a fixed ceiling for this process's lifetime — it
    // must only ever come from the server's own startup env-var gate.
    this.config.liveAuthorized = config.liveAuthorized === true;

    // The actual active mode CAN be toggled at runtime (paper<->live) via
    // the dashboard, but only ever within the ceiling above. If a previous
    // pause/resume choice was persisted, respect it — but only when we're
    // currently authorized; a stale "live" file from a differently
    // configured previous boot can never silently take effect.
    const persistedMode = loadModeState();
    if (this.config.liveAuthorized && persistedMode === 'paper') {
      this.config.mode = 'paper'; // an intentional pause was saved — respect it
    } else if (this.config.liveAuthorized) {
      this.config.mode = config.mode; // no saved pause, or saved 'live' — use the boot-time value
    } else {
      this.config.mode = 'paper'; // not authorized at all — always paper, full stop
    }

    this.ledger = loadLedger();
    this.calibration = loadCalibration();
    this.lastError = null;
    this.lastDecision = 'Waiting for a prediction cycle.';
    const runState = loadRunState();
    this.isRunning = runState.isRunning !== false;
    this.runningSince = this.isRunning ? (Number(runState.runningSince) || Date.now()) : null;
    this.liveBalanceCents = null;
    this.livePortfolioValueCents = null;
    this.liveBalanceUpdatedAt = null;
    this._removeInvalidPaperTrades();
    // Always flush the effective settings so a reboot reloads exactly what
    // this process is running (env defaults and/or last dashboard save).
    saveConfigOverrides(collectConfigOverrides(this.config));
    saveRunState({ isRunning: this.isRunning, runningSince: this.runningSince });
  }

  /**
   * Runtime pause/resume between paper and live. Switching TO live is only
   * ever allowed if this.config.liveAuthorized is true (set once at server
   * startup from the KALSHI_LIVE_TRADING + KALSHI_LIVE_TRADING_CONFIRM env
   * vars) — this method can never raise that ceiling, only operate within
   * it. Switching to paper is always allowed, as an immediate safety valve.
   */
  setMode(requestedMode) {
    if (requestedMode !== 'paper' && requestedMode !== 'live') {
      return { ok: false, message: `Invalid mode '${requestedMode}'.` };
    }
    if (requestedMode === 'live' && !this.config.liveAuthorized) {
      return {
        ok: false,
        message:
          'Live trading is not authorized on this server. Set KALSHI_LIVE_TRADING=true and ' +
          'KALSHI_LIVE_TRADING_CONFIRM=I_UNDERSTAND_THE_RISK as environment variables (plus valid ' +
          'Kalshi credentials) and restart — this cannot be enabled from the dashboard alone.',
      };
    }
    this.config.mode = requestedMode;
    saveModeState(requestedMode);
    return { ok: true, mode: this.config.mode };
  }

  setRunning(requestedRunning) {
    if (typeof requestedRunning !== 'boolean') return { ok: false, message: 'running must be true or false.' };
    this.isRunning = requestedRunning;
    this.runningSince = requestedRunning ? Date.now() : null;
    saveRunState({ isRunning: this.isRunning, runningSince: this.runningSince });
    this.lastDecision = requestedRunning ? 'Bot started; it will evaluate new entries on the next server cycle.' : 'Bot stopped; no new positions will be opened.';
    return { ok: true, isRunning: this.isRunning, runningSince: this.runningSince, message: this.lastDecision };
  }

  /**
   * Runtime-editable settings update (e.g. from the dashboard's settings
   * panel). Silently ignores any field not recognized as editable — in
   * particular, `mode` can never be changed this way.
   */
  updateConfig(partial) {
    const applied = {};
    for (const field of EDITABLE_NUMERIC_FIELDS) {
      if (partial[field] == null) continue;
      const num = Number(partial[field]);
      if (Number.isNaN(num)) continue;
      this.config[field] = num;
      applied[field] = num;
    }
    for (const [field, validate] of Object.entries(EDITABLE_STRING_FIELDS)) {
      if (partial[field] == null) continue;
      const value = validate(partial[field]);
      if (value == null) continue;
      this.config[field] = value;
      applied[field] = value;
    }
    saveConfigOverrides(collectConfigOverrides(this.config));
    return { applied, config: this.config };
  }

  resetPaperState() {
    if (this.config.mode !== 'paper') {
      return { ok: false, message: 'Paper history can only be reset while the bot is in paper mode.' };
    }
    this.ledger = { trades: [], reserveCents: 0, periodStartTime: Date.now() };
    this.calibration = { buckets: {} };
    this.lastError = null;
    this.lastDecision = 'Paper trading history and statistics were reset.';
    this._persist();
    saveCalibration(this.calibration);
    return { ok: true, message: 'Paper trading history and statistics were reset.' };
  }

  get openTrades() {
    return this.ledger.trades.filter((t) => t.status === 'open');
  }

  _openExposureCents() {
    return this.openTrades.reduce((sum, trade) => sum + (Number(trade.entryPriceCents) || 0) * (Number(trade.contracts) || 0), 0);
  }

  _capitalStatus() {
    const closedPnlCents = this.ledger.trades
      .filter((trade) => trade.status === 'closed')
      .reduce((sum, trade) => sum + (Number(trade.pnlCents) || 0), 0);
    const openExposureCents = this._openExposureCents();
    const startingCents = Math.round(this.config.paperStartingBalanceDollars * 100);
    const reserveCents = this.ledger.reserveCents || 0;
    const paperTotalCents = startingCents + closedPnlCents;
    return {
      startingCents,
      paperTotalCents,
      reserveCents,
      openExposureCents,
      paperAvailableCents: Math.max(0, paperTotalCents - reserveCents - openExposureCents),
      guardrailCents: Math.round(this.config.guardrailDollars * 100),
      guardrailRemainingCents: Math.max(0, Math.round(this.config.guardrailDollars * 100) - openExposureCents),
    };
  }

  _removeInvalidPaperTrades() {
    const initialCount = this.ledger.trades.length;
    this.ledger.trades = this.ledger.trades.filter((trade) => {
      // A malformed paper entry never represented a real order or money at
      // risk, so removing it is safer and more truthful than showing a fake
      // open position with a `null` entry price.
      if (trade.mode !== 'paper' || trade.status !== 'open') return true;
      return Number.isFinite(trade.entryPriceCents)
        && trade.entryPriceCents >= 1
        && trade.entryPriceCents <= 99
        && (trade.side === 'yes' || trade.side === 'no');
    });
    const removed = initialCount - this.ledger.trades.length;
    if (removed > 0) {
      this.lastError = `Removed ${removed} invalid paper trade${removed === 1 ? '' : 's'} with no valid entry quote.`;
      this._persist();
    }
  }

  _persist() {
    saveLedger(this.ledger);
  }

  /**
   * Every 12 hours, archives all CLOSED trades from this period to
   * data/archive/bot-ledger-<period>.json and clears them from the live
   * ledger, so win/loss stats and streaks reflect a rolling recent window
   * rather than growing forever — while the prior 12 hours of trade
   * history stays available in the archive file.
   *
   * Deliberately never touches: any still-OPEN trade (kept in the live
   * ledger untouched regardless of rotation), or the running reserveCents
   * total (that represents real money you've chosen to set aside — it
   * keeps accumulating across rotations rather than resetting to zero).
   */
  _maybeRotateLedger(now) {
    if (now - this.ledger.periodStartTime < ROTATION_PERIOD_MS) return;

    const closedTrades = this.ledger.trades.filter((t) => t.status === 'closed');
    const stillOpen = this.ledger.trades.filter((t) => t.status === 'open');

    if (closedTrades.length > 0) {
      try {
        fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
        const archive = {
          periodStart: new Date(this.ledger.periodStartTime).toISOString(),
          periodEnd: new Date(now).toISOString(),
          reserveCentsAtRotation: this.ledger.reserveCents,
          trades: closedTrades,
        };
        const fileName = `bot-ledger-${new Date(this.ledger.periodStartTime).toISOString().replace(/[:.]/g, '-')}.json`;
        fs.writeFileSync(path.join(ARCHIVE_DIR, fileName), JSON.stringify(archive, null, 2));
        console.log(`[bot] archived ${closedTrades.length} closed trades from the last 12h to data/archive/${fileName}`);
      } catch (err) {
        console.error('[bot] failed to archive ledger before rotation:', err.message);
      }
    }

    this.ledger.trades = stillOpen; // keep any still-open trade, drop settled history
    this.ledger.periodStartTime = now;
    this._persist();
  }

  // Picks whichever engine window most closely matches the time actually
  // left on Kalshi's current 15-minute contract.
  _pickWindow(windows, minutesRemaining) {
    const candidates = [
      { key: 'w5', minutes: 5 },
      { key: 'w10', minutes: 10 },
      { key: 'w15', minutes: 15 },
    ];
    let best = candidates[0];
    let bestDiff = Infinity;
    for (const c of candidates) {
      const diff = Math.abs(c.minutes - minutesRemaining);
      if (diff < bestDiff) {
        bestDiff = diff;
        best = c;
      }
    }
    return windows[best.key];
  }

  /**
   * Determines how much to stake on the NEXT trade, per the configured
   * strategy:
   *   - 'fixed': always the configured stakeDollars (unchanged behavior).
   *   - 'halve-after-win': half of the most recent CLOSED trade's own
   *     invested amount if that trade was a win; otherwise resets back to
   *     the base configured stakeDollars. Deliberately based on the
   *     trade's own invested amount (trade.stakeDollars) — NOT reduced by
   *     whatever was skimmed from its profit afterward, since skimming
   *     happens on the profit side and never touches the principal that
   *     was actually risked.
   */
  _computeNextStake() {
    if (this.config.stakingStrategy !== 'halve-after-win') {
      return this.config.stakeDollars;
    }
    const lastClosed = this.ledger.trades.find((t) => t.status === 'closed');
    if (!lastClosed) return this.config.stakeDollars; // no history yet — start at the base stake
    if (lastClosed.pnlCents > 0) {
      return Math.max(0.5, lastClosed.stakeDollars / 2); // halve after a win, never quite to zero
    }
    return this.config.stakeDollars; // reset to base after a loss
  }

  _computeSkim(pnlCents) {
    if (pnlCents <= 0 || this.config.skimMode === 'off') return 0;
    if (this.config.skimMode === 'fixed') {
      return Math.min(Math.round(this.config.skimFixedDollars * 100), pnlCents);
    }
    // percent
    return Math.round(pnlCents * (this.config.skimPercent / 100));
  }

  async _closePosition(trade, exitPriceCents, reason) {
    trade.status = 'closed';
    trade.closedAt = Date.now();
    trade.exitPriceCents = exitPriceCents;
    trade.exitReason = reason;
    const entryCost = trade.entryPriceCents * trade.contracts;
    const exitProceeds = exitPriceCents * trade.contracts;
    trade.pnlCents = exitProceeds - entryCost;

    const skimmedCents = this._computeSkim(trade.pnlCents);
    trade.skimmedCents = skimmedCents;
    if (skimmedCents > 0) {
      this.ledger.reserveCents = (this.ledger.reserveCents || 0) + skimmedCents;
    }

    this._recordCalibration(trade);

    if (this.config.mode === 'live' && trade.liveOrderId) {
      try {
        await this.client.createOrder({
          ticker: trade.ticker,
          side: trade.side,
          action: 'sell',
          count: trade.contracts,
          priceCents: exitPriceCents,
        });
      } catch (err) {
        this.lastError = `Failed to place live exit order: ${err.message}`;
        console.error('[bot]', this.lastError);
      }
    }
    this._persist();
    this.lastDecision = `Closed ${trade.symbol} ${String(trade.side).toUpperCase()} via ${reason} at ${exitPriceCents}¢ (P&L $${(trade.pnlCents / 100).toFixed(2)}).`;
  }

  /**
   * Resolve settlement payout for a trade that has reached its window end.
   * Prefer Kalshi's official result; fall back to price-vs-strike for paper
   * when result hasn't landed yet; never leave the trade open into the next session.
   */
  async _settleClosedWindow(trade, predictions, market) {
    const result = market && market.result ? String(market.result).toLowerCase() : '';
    if (result === 'yes' || result === 'no') {
      const settleCents = result === trade.side ? 100 : 0;
      await this._closePosition(trade, settleCents, 'settled');
      return;
    }

    const strike = trade.floorStrike != null ? Number(trade.floorStrike) : Number(market && market.floor_strike);
    const livePrice =
      predictions &&
      predictions[trade.symbol] &&
      Number.isFinite(predictions[trade.symbol].price)
        ? predictions[trade.symbol].price
        : null;

    if (Number.isFinite(strike) && Number.isFinite(livePrice)) {
      const settledUp = livePrice >= strike;
      const won = trade.side === 'yes' ? settledUp : !settledUp;
      await this._closePosition(trade, won ? 100 : 0, 'settled');
      this.lastDecision =
        `Settled ${trade.symbol} ${String(trade.side).toUpperCase()} via price-vs-strike ` +
        `(${livePrice} vs ${strike}) — Kalshi result not yet posted.`;
      return;
    }

    // Absolute last resort: scratch the trade rather than carrying it forever.
    const sideBid = market && (trade.side === 'yes' ? market.yes_bid : market.no_bid);
    const fallback = Number.isFinite(sideBid) ? sideBid : trade.entryPriceCents;
    await this._closePosition(trade, Number.isFinite(fallback) ? fallback : trade.entryPriceCents, 'settled_timeout');
  }

  _tradeCloseDeadline(trade) {
    const stored = Number(trade.windowCloseTime);
    if (Number.isFinite(stored) && stored > 0) return stored;
    const opened = Number(trade.openedAt);
    // Legacy trades without windowCloseTime: assume a standard 15m window.
    if (Number.isFinite(opened) && opened > 0) return opened + 15 * 60 * 1000;
    return NaN;
  }

  async _manageOpenTrade(trade, predictions) {
    const now = Date.now();
    const storedClose = this._tradeCloseDeadline(trade);
    const openedAt = Number(trade.openedAt);
    // Hard ceiling: never keep a 15m crypto contract open more than ~16.5 min.
    const maxAgeMs = 16.5 * 60 * 1000;
    const tooOld = Number.isFinite(openedAt) && now - openedAt >= maxAgeMs;
    let market = null;

    try {
      market = await this.client.getMarket(trade.ticker);
    } catch (err) {
      if ((Number.isFinite(storedClose) && now >= storedClose) || tooOld) {
        console.warn(`[bot] market fetch failed after close for ${trade.ticker}; force-settling: ${err.message}`);
        await this._settleClosedWindow(trade, predictions, null);
        return;
      }
      this.lastError = `Failed to fetch open position's market (${trade.ticker}): ${err.message}`;
      console.error('[bot]', this.lastError);
      return;
    }

    if (!market) {
      if ((Number.isFinite(storedClose) && now >= storedClose) || tooOld) {
        await this._settleClosedWindow(trade, predictions, null);
      }
      return;
    }

    const heldSideBidCents = trade.side === 'yes' ? market.yes_bid : market.no_bid;
    const marketClose = market.close_time ? new Date(market.close_time).getTime() : NaN;
    const status = market.status ? String(market.status).toLowerCase() : '';
    const marketDone = status === 'closed' || status === 'settled' || status === 'determined' || status === 'finalized';
    // Use the earlier of stored open-time close and live close so a stale /
    // missing API close_time can never keep a trade open past its session.
    const candidates = [storedClose, marketClose].filter((t) => Number.isFinite(t) && t > 0);
    const closeTime = candidates.length ? Math.min(...candidates) : NaN;
    const pastClose = (Number.isFinite(closeTime) && now >= closeTime) || marketDone || tooOld;

    if (pastClose) {
      await this._settleClosedWindow(trade, predictions, market);
      return;
    }

    if (!Number.isFinite(closeTime)) {
      // No usable close time and market still looks open — wait one more cycle
      // unless we already have an official result.
      if (market.result) {
        await this._settleClosedWindow(trade, predictions, market);
      }
      return;
    }

    const minutesRemaining = (closeTime - now) / 60000;

    // Early warning exit: if the engine's own 0-5 minute signal has
    // flipped to favor the opposite side of what we're holding — even by
    // a small margin — get out now rather than waiting for Kalshi's own
    // odds to grind all the way down to the stop-loss threshold. Only
    // meaningful once the actual Kalshi window has 5 minutes or less left
    // — that's what the 0-5 min window's prediction is actually about,
    // and checking it any earlier (e.g. with 12 minutes still on the
    // clock) doesn't correspond to what that window is predicting.
    const inFinalFiveMinutes = minutesRemaining <= 5;
    const shortWindow = inFinalFiveMinutes && predictions && predictions[trade.symbol] && predictions[trade.symbol].ready
      ? predictions[trade.symbol].windows.w5
      : null;
    const signalFlipped =
      shortWindow &&
      ((trade.side === 'yes' && shortWindow.probabilityDown > shortWindow.probabilityUp) ||
        (trade.side === 'no' && shortWindow.probabilityUp > shortWindow.probabilityDown));

    // Final-5 confidence in OUR direction: if the 0-5 window still trusts
    // the held side strongly, ride settlement instead of clipping a take-profit.
    const heldFavoredByShortWindow =
      shortWindow &&
      shortWindow.confidence >= this.config.minConfidence &&
      ((trade.side === 'yes' && shortWindow.probabilityUp >= shortWindow.probabilityDown) ||
        (trade.side === 'no' && shortWindow.probabilityDown >= shortWindow.probabilityUp));
    const holdThroughForConfidence = inFinalFiveMinutes && heldFavoredByShortWindow;

    // Stronger early-warning exit: if BOTH of the next two windows (5-10
    // and 10-15 min out) strongly agree the price is heading the opposite
    // way from our held position — not just a marginal >50% flip, but a
    // real majority on both — that's a much more serious reversal signal
    // than a single-window flip, so it's checked at ANY point in the
    // trade's life, not gated to the final 5 minutes.
    const REVERSAL_THRESHOLD_PCT = 65;
    const assetPred = predictions && predictions[trade.symbol] && predictions[trade.symbol].ready
      ? predictions[trade.symbol]
      : null;
    const w10 = assetPred ? assetPred.windows.w10 : null;
    const w15 = assetPred ? assetPred.windows.w15 : null;
    const heldIsYes = trade.side === 'yes';
    const w10AgainstUs = w10 && (heldIsYes ? w10.probabilityDown : w10.probabilityUp) >= REVERSAL_THRESHOLD_PCT;
    const w15AgainstUs = w15 && (heldIsYes ? w15.probabilityDown : w15.probabilityUp) >= REVERSAL_THRESHOLD_PCT;
    const strongReversalSignal = w10AgainstUs && w15AgainstUs;

    const takeProfitHit =
      heldSideBidCents != null &&
      Number.isFinite(this.config.takeProfitCents) &&
      this.config.takeProfitCents > 0 &&
      heldSideBidCents >= this.config.takeProfitCents;

    // Breakeven in the last 5 minutes when confidence is NOT high in our
    // favor: lock even-or-better instead of gambling settlement.
    const canExitEven =
      inFinalFiveMinutes &&
      !holdThroughForConfidence &&
      heldSideBidCents != null &&
      heldSideBidCents >= trade.entryPriceCents;

    if (heldSideBidCents != null && heldSideBidCents <= this.config.stopLossCents) {
      await this._closePosition(trade, heldSideBidCents, 'stop_loss');
    } else if (strongReversalSignal && heldSideBidCents != null) {
      await this._closePosition(trade, heldSideBidCents, 'reversal_signal');
    } else if (signalFlipped && heldSideBidCents != null) {
      await this._closePosition(trade, heldSideBidCents, 'signal_flip');
    } else if (takeProfitHit && !holdThroughForConfidence) {
      await this._closePosition(trade, heldSideBidCents, 'take_profit');
    } else if (canExitEven) {
      await this._closePosition(trade, heldSideBidCents, 'breakeven');
    }
  }

  async _openPosition({ symbol, ticker, side, priceCents, floorStrike, closeTime, engineProbability, engineConfidence }) {
    // A paper trade must obey the same price rules as a live order. Without
    // this guard an empty Kalshi quote could be stored as `null` and then
    // appear in the dashboard as e.g. "BTC @ NO null".
    if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99) {
      this.lastError = `Skipped ${symbol} ${side || 'unknown'} entry: no valid Kalshi quote is available.`;
      return;
    }
    const closeAt = Number(closeTime);
    if (!Number.isFinite(closeAt) || closeAt <= Date.now() + 5000) {
      this.lastError = `Skipped ${symbol} ${side || 'unknown'} entry: market close time is missing or already ending.`;
      return;
    }
    // Each Kalshi contract costs `priceCents` cents and pays out $1 if it
    // wins, so buying (stakeDollars * 100 / priceCents) contracts risks
    // approximately stakeDollars. Always at least 1 contract.
    const stakeDollars = this._computeNextStake();
    const contracts = Math.max(1, Math.floor((stakeDollars * 100) / priceCents));
    const entryCostCents = contracts * priceCents;
    const capital = this._capitalStatus();
    if (entryCostCents > capital.guardrailRemainingCents) {
      this.lastDecision = `Guardrail reached: $${(capital.openExposureCents / 100).toFixed(2)} is already deployed of the $${(capital.guardrailCents / 100).toFixed(2)} limit.`;
      return;
    }
    if (this.config.mode === 'paper' && entryCostCents > capital.paperAvailableCents) {
      this.lastDecision = `Insufficient paper funds: $${(capital.paperAvailableCents / 100).toFixed(2)} is spendable after the reserved skim.`;
      return;
    }
    if (this.config.mode === 'live' && Number.isFinite(this.liveBalanceCents) && entryCostCents > this.liveBalanceCents) {
      this.lastDecision = `Insufficient live balance: $${(this.liveBalanceCents / 100).toFixed(2)} is available on Kalshi.`;
      return;
    }
    const trade = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      mode: this.config.mode,
      symbol,
      ticker,
      side, // 'yes' | 'no'
      contracts,
      stakeDollars: +(entryCostCents / 100).toFixed(2), // actual dollars risked, given rounding to whole contracts
      entryPriceCents: priceCents,
      floorStrike,
      openedAt: Date.now(),
      windowCloseTime: closeAt,
      engineProbability,
      engineConfidence,
      status: 'open',
    };

    if (this.config.mode === 'live') {
      try {
        const order = await this.client.createOrder({
          ticker,
          side,
          action: 'buy',
          count: trade.contracts,
          priceCents,
        });
        trade.liveOrderId = order.order && order.order.order_id;
      } catch (err) {
        this.lastError = `Failed to place live entry order: ${err.message}`;
        console.error('[bot]', this.lastError);
        return; // don't record a trade we couldn't actually place
      }
    }

    this.ledger.trades.unshift(trade);
    if (this.ledger.trades.length > 200) this.ledger.trades.length = 200;
    this._persist();
    this.lastDecision = `Opened ${symbol} ${side.toUpperCase()} paper position at ${priceCents}¢ (confidence ${engineConfidence}%).`;
  }

  /**
   * predictions: the full result object from buildPredictions() — i.e. has
   * both .BTC and .XRP, each with .windows.w5/w10/w15. The bot trades
   * whichever one matches this.config.symbol, but will still manage
   * (monitor/close) any already-open position even if you've since switched
   * symbols, so a switch never orphans an open trade.
   */
  async runCycle(predictions) {
    this._maybeRotateLedger(Date.now());

    if (this.config.mode === 'live' && this.client.hasCredentials && (!this.liveBalanceUpdatedAt || Date.now() - this.liveBalanceUpdatedAt > 15000)) {
      try {
        const balance = await this.client.getBalance();
        this.liveBalanceCents = Number(balance.balance);
        this.livePortfolioValueCents = Number(balance.portfolio_value);
        this.liveBalanceUpdatedAt = Date.now();
      } catch (err) {
        this.lastError = `Unable to refresh live balance: ${err.message}`;
      }
    }

    // --- first, manage every currently open trade by its own ticker,
    // regardless of what symbol is currently selected to trade next ---
    for (const trade of this.openTrades) {
      await this._manageOpenTrade(trade, predictions);
    }

    if (!this.isRunning) {
      this.lastDecision = 'Bot is stopped; it will continue monitoring any already-open positions but will not open new ones.';
      return;
    }
    if (this.openTrades.length >= this.config.maxOpenPositions) return;
    if (!predictions) return;

    const opportunity =
      this.config.symbol === 'AUTO'
        ? await this._findBestOpportunity(predictions)
        : await this._evaluateSymbolForEdge(this.config.symbol, predictions);

    if (!opportunity) return;

    await this._openPosition({
      symbol: opportunity.symbol,
      ticker: opportunity.market.ticker,
      side: opportunity.side,
      priceCents: opportunity.priceCents,
      floorStrike: opportunity.market.floor_strike,
      closeTime: opportunity.closeTime,
      engineProbability: opportunity.side === 'yes' ? opportunity.window.probabilityUp : opportunity.window.probabilityDown,
      engineConfidence: opportunity.window.confidence,
    });
  }

  /**
   * Fetches the current open market for one symbol and checks whether
   * there's a large enough edge (and enough confidence) to be worth
   * trading. Returns an opportunity descriptor, or null if there's nothing
   * worth acting on (or the market/prediction data isn't available).
   */
  async _evaluateSymbolForEdge(symbol, predictions) {
    const assetPrediction = predictions[symbol];
    if (!assetPrediction || !assetPrediction.ready) {
      this.lastDecision = `Waiting: ${symbol} prediction data is still seeding.`;
      return null;
    }

    const seriesTicker = SERIES_BY_SYMBOL[symbol];
    if (!seriesTicker) {
      this.lastDecision = `Waiting: ${symbol} has no supported Kalshi market.`;
      return null;
    }

    let market;
    try {
      const markets = await this.client.getOpenMarkets(seriesTicker, 5);
      const nowMs = Date.now();
      market = (markets || []).find((m) => {
        const closeMs = m.close_time ? new Date(m.close_time).getTime() : NaN;
        return Number.isFinite(closeMs) && closeMs > nowMs + 5000;
      });
    } catch (err) {
      this.lastError = `Failed to fetch Kalshi market for ${seriesTicker}: ${err.message}`;
      console.error('[bot]', this.lastError);
      return null;
    }
    if (!market) {
      this.lastDecision = `Waiting: no open Kalshi market found for ${symbol}.`;
      return null;
    }

    const now = Date.now();
    const closeTime = new Date(market.close_time).getTime();
    if (closeTime <= now) {
      this.lastDecision = `Waiting: the available ${symbol} market is already closed.`;
      return null;
    }

    const minutesRemaining = Math.max(0.1, (closeTime - now) / 60000);
    const window = this._pickWindow(assetPrediction.windows, minutesRemaining);
    if (!window || window.confidence < this.config.minConfidence) {
      const confidence = window && Number.isFinite(window.confidence) ? window.confidence : 'unavailable';
      this.lastDecision = `Waiting: ${symbol} ${window ? window.window : 'current'} confidence is ${confidence}% (minimum ${this.config.minConfidence}%).`;
      return null;
    }

    const yesBid = Number(market.yes_bid);
    const yesAsk = Number(market.yes_ask);
    if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesBid < 1 || yesAsk > 99 || yesBid > yesAsk) {
      this.lastError = `Skipped ${symbol}: Kalshi has no usable two-sided quote yet.`;
      return null;
    }

    const kalshiImpliedYesPct = (yesBid + yesAsk) / 2;
    const edge = window.probabilityUp - kalshiImpliedYesPct;
    if (Math.abs(edge) < this.config.edgeThresholdPct) {
      this.lastDecision = `Waiting: ${symbol} confidence ${window.confidence}% passes, but edge is ${Math.abs(edge).toFixed(1)} points (minimum ${this.config.edgeThresholdPct}).`;
      return null;
    }

    const side = edge > 0 ? 'yes' : 'no';
    const priceCents = side === 'yes' ? yesAsk : 100 - yesBid;
    if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99) {
      this.lastError = `Skipped ${symbol}: selected ${side.toUpperCase()} price is unavailable.`;
      return null;
    }

    return {
      symbol,
      market,
      window,
      side,
      priceCents,
      closeTime,
      edge: Math.abs(edge),
      // Ranking score for AUTO mode: edge weighted by how much the engine
      // trusts the call — a huge edge the engine itself isn't confident in
      // ranks below a smaller edge it's very sure about.
      rankScore: Math.abs(edge) * (window.confidence / 100),
    };
  }

  /**
   * AUTO mode: scores every Kalshi-tradeable symbol the engine is currently
   * predicting, and returns only the single best-ranked opportunity that
   * clears both thresholds — so instead of being locked into trading one
   * asset every 15 minutes whether or not it's a good setup, the bot only
   * acts on whichever market currently has the strongest, most trustworthy
   * edge across everything it's watching.
   */
  async _findBestOpportunity(predictions) {
    const candidates = Object.keys(SERIES_BY_SYMBOL).filter((sym) => predictions[sym]);
    const evaluations = await Promise.all(
      candidates.map((sym) => this._evaluateSymbolForEdge(sym, predictions))
    );
    const valid = evaluations.filter(Boolean);
    if (valid.length === 0) return null;
    valid.sort((a, b) => b.rankScore - a.rankScore);
    return valid[0];
  }

  /**
   * Records a settled trade into its probability-at-entry bucket (50-59%,
   * 60-69%, etc, using the engine's own confidence-in-direction at the
   * moment the trade opened). This is deliberately NEVER rotated/cleared —
   * unlike the 12h ledger, calibration needs a large accumulated sample
   * (100-200+ trades per bucket) to actually mean anything, so it keeps
   * growing indefinitely across every 12h period.
   */
  _recordCalibration(trade) {
    if (trade.engineProbability == null) return;
    const bucketKey = String(Math.min(90, Math.floor(trade.engineProbability / 10) * 10));
    if (!this.calibration.buckets[bucketKey]) {
      this.calibration.buckets[bucketKey] = { trades: 0, wins: 0 };
    }
    this.calibration.buckets[bucketKey].trades += 1;
    if (trade.pnlCents > 0) this.calibration.buckets[bucketKey].wins += 1;
    saveCalibration(this.calibration);
  }

  /**
   * Returns the probability-bucketed calibration table — trades, wins, and
   * win rate for each "probability at entry" range the engine has actually
   * traded, plus sample-size guidance so you're not guessing whether a
   * given probability threshold is meaningful in your own system.
   */
  calibrationReport() {
    const rows = Object.keys(this.calibration.buckets)
      .map(Number)
      .sort((a, b) => a - b)
      .map((bucketStart) => {
        const b = this.calibration.buckets[String(bucketStart)];
        return {
          range: `${bucketStart}-${bucketStart + 9}%`,
          trades: b.trades,
          wins: b.wins,
          winRatePct: b.trades ? +((b.wins / b.trades) * 100).toFixed(1) : null,
          sampleQuality:
            b.trades >= CALIBRATION_GUIDANCE.best
              ? 'best'
              : b.trades >= CALIBRATION_GUIDANCE.better
              ? 'good'
              : b.trades >= CALIBRATION_GUIDANCE.minToStartTrusting
              ? 'minimal'
              : 'too_few',
        };
      });
    return { guidance: CALIBRATION_GUIDANCE, buckets: rows };
  }

  status() {
    const closed = this.ledger.trades.filter((t) => t.status === 'closed');
    const wins = closed.filter((t) => t.pnlCents > 0).length;

    // ledger.trades is newest-first. Current streak: consecutive wins
    // starting from the most recent closed trade. Longest streak: scan the
    // whole history in chronological order (oldest -> newest).
    let currentWinStreak = 0;
    for (const t of closed) {
      if (t.pnlCents > 0) currentWinStreak += 1;
      else break;
    }
    let longestWinStreak = 0;
    let running = 0;
    for (const t of [...closed].reverse()) {
      if (t.pnlCents > 0) {
        running += 1;
        longestWinStreak = Math.max(longestWinStreak, running);
      } else {
        running = 0;
      }
    }

    const capital = this._capitalStatus();
    return {
      mode: this.config.mode,
      isRunning: this.isRunning,
      runningSince: this.runningSince,
      config: this.config,
      lastError: this.lastError,
      lastDecision: this.lastDecision,
      openTrades: this.openTrades,
      recentTrades: this.ledger.trades.slice(0, 20),
      stats: {
        totalAttempts: this.ledger.trades.length, // every trade ever opened, open + closed
        totalTrades: closed.length, // settled/closed trades only
        wins,
        profitableExits: wins,
        losses: closed.length - wins,
        winRatePct: closed.length ? +((wins / closed.length) * 100).toFixed(1) : null,
        currentWinStreak,
        longestWinStreak,
        netPnlCents: closed.reduce((sum, t) => sum + (t.pnlCents || 0), 0),
        reserveCents: this.ledger.reserveCents || 0,
      },
      capital: {
        ...capital,
        liveAvailableCents: Number.isFinite(this.liveBalanceCents) ? this.liveBalanceCents : null,
        livePortfolioValueCents: Number.isFinite(this.livePortfolioValueCents) ? this.livePortfolioValueCents : null,
        liveBalanceUpdatedAt: this.liveBalanceUpdatedAt,
      },
    };
  }
}

module.exports = { TradingBot, SERIES_BY_SYMBOL };
