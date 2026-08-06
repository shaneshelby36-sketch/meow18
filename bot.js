'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath, ensureDataDir, writeJsonAtomic, pruneArchiveFiles } = require('./paths');

ensureDataDir();
pruneArchiveFiles();

const LEDGER_PATH = dataPath('bot-ledger.json');
const TRADE_LOG_PATH = dataPath('trade-log.json');
const CONFIG_PATH = dataPath('bot-config.json');
const CALIBRATION_PATH = dataPath('calibration.json');
const MODE_STATE_PATH = dataPath('bot-mode-state.json');
const RUN_STATE_PATH = dataPath('bot-run-state.json');
const ARCHIVE_DIR = dataPath('archive');
const ROTATION_PERIOD_MS = 12 * 60 * 60 * 1000; // 12 hours
const TRADE_LOG_MAX = 5000; // permanent history cap (oldest dropped only past this)
// Bump when shipping intentional default resets so stale bot-config.json
// doesn't keep old absolute stop/TP values after deploy.
const SETTINGS_DEFAULTS_VERSION = 6;

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
  'nearCertainExitCents',
  'minEntryCents',
  'minMinutesToOpen',
  'stopRecoveryCents',
  'stopRecoveryMaxMinutes',
  'stakeDollars',
  'maxOpenPositions',
  'skimPercent',
  'skimFixedDollars',
  'insuranceCapDollars',
  'paperStartingBalanceDollars',
];

/**
 * Cents the held-side bid must bounce above the stop-exit before same-side
 * re-entry. 0 disables the gate. Unset/invalid → ~40% of the stop distance
 * (min 5¢) — a recovery check, not a timer.
 */
function stopRecoveryCentsRequired(config = {}) {
  const configured = Number(config.stopRecoveryCents);
  if (Number.isFinite(configured) && configured <= 0) return 0;
  if (Number.isFinite(configured) && configured > 0) return Math.round(configured);
  return Math.max(5, Math.round((Number(config.stopLossCents) || 10) * 0.4));
}

/** Market session end for a trade (live ledger or backtest). */
function tradeWindowCloseMs(trade) {
  if (!trade) return NaN;
  const raw = trade.windowCloseTime ?? trade.closeTime;
  let stored = Number(raw);
  if ((!Number.isFinite(stored) || stored <= 0) && raw != null && raw !== '') {
    const parsed = Date.parse(String(raw));
    if (Number.isFinite(parsed) && parsed > 0) stored = parsed;
  }
  if (Number.isFinite(stored) && stored > 0) return stored;
  const opened = Number(trade.openedAt);
  if (Number.isFinite(opened) && opened > 0) return opened + 15 * 60 * 1000;
  return NaN;
}

/** True once the stopped trade's 15m window has ended — recovery gate clears. */
function isPostStopRecoverySessionExpired(lastStopTrade, now = Date.now()) {
  const windowEnd = tradeWindowCloseMs(lastStopTrade);
  return Number.isFinite(windowEnd) && Number(now) >= windowEnd;
}

/**
 * After a stop-loss, require the *stopped coin's* bid to bounce before new
 * entries (any coin) — prevents instant cascade / loss strings while price
 * is still running against the stopped side **within the same window**.
 *
 * Thesis favor (engine still likes the stopped side) only gates knife-catch
 * re-entry on that same coin + same side. Peer coins (and opposite-side on
 * the stopped coin) unlock once the bounce clears — otherwise a flipped
 * thesis freezes *all* trading until the stopped coin re-favors a side the
 * market already rejected. Peer cascade (`checkPostStopPeerCascade`) still
 * blocks while a majority of peers are dumping.
 *
 * Primary expiry: once the stopped trade's window closes (`windowCloseTime`),
 * recovery no longer blocks any new entries (next window / other coins).
 * Optional `maxAgeMs` + `closedAt` remains as a backup cap within long windows.
 *
 * `lastClosedForSymbol` should be the stop-loss trade (usually the latest stop).
 */
function checkPostStopRecovery({
  lastClosedForSymbol,
  side,
  priceCents,
  window,
  recoveryCents,
  symbol = '',
  forCandidateSymbol = null,
  forCandidateSide = null,
  maxAgeMs = 0,
  now = Date.now(),
}) {
  if (!recoveryCents || recoveryCents <= 0) return { ok: true };
  const last = lastClosedForSymbol;
  // Gate uses the stopped trade's side (not necessarily the candidate side).
  if (!last || last.exitReason !== 'stop_loss') {
    return { ok: true };
  }

  if (isPostStopRecoverySessionExpired(last, now)) {
    return { ok: true };
  }

  const closedAt = Number(last.closedAt);
  const ageCap = Number(maxAgeMs);
  if (
    Number.isFinite(ageCap) &&
    ageCap > 0 &&
    Number.isFinite(closedAt) &&
    Number(now) - closedAt >= ageCap
  ) {
    return { ok: true };
  }

  const stopSide = last.side;
  // `side` arg is the side we're quoting for recovery — should match stopSide.
  const checkSide = stopSide || side;
  const exit = Number(last.exitPriceCents);
  if (!Number.isFinite(exit)) return { ok: true };

  const needBid = Math.min(99, exit + recoveryCents);
  const price = Number(priceCents);
  const stoppedLabel = symbol || last.symbol || '';
  const candidateSym = forCandidateSymbol || null;
  const otherNote = candidateSym
    ? ` before any new entry on ${candidateSym}`
    : ' before any new entry';

  if (!Number.isFinite(price) || price < needBid) {
    return {
      ok: false,
      reason:
        `Waiting: ${stoppedLabel} ${String(checkSide).toUpperCase()} stopped @ ${exit}¢ — need ${stoppedLabel} bid ≥ ${needBid}¢ ` +
        `(+${recoveryCents}¢ bounce)${otherNote} (same-window cascade protection).`,
    };
  }

  // Bounce cleared. Thesis favor only for same-coin same-side knife-catch —
  // do not hold ETH/BTC/etc hostage waiting for SOL YES to become favored again.
  const stoppedSym = String(stoppedLabel || last.symbol || '').toUpperCase();
  const candSym = candidateSym != null ? String(candidateSym).toUpperCase() : stoppedSym;
  const candSide = forCandidateSide != null ? forCandidateSide : checkSide;
  const isSameCoinSameSide =
    candSym === stoppedSym && String(candSide).toLowerCase() === String(checkSide).toLowerCase();

  if (isSameCoinSameSide && window) {
    const up = Number(window.probabilityUp);
    const down = Number(window.probabilityDown);
    const favored =
      checkSide === 'yes'
        ? Number.isFinite(up) && Number.isFinite(down) && up >= down
        : Number.isFinite(up) && Number.isFinite(down) && down >= up;
    if (!favored) {
      return {
        ok: false,
        reason:
          `Waiting: ${stoppedLabel} bid recovered after stop, but engine no longer favors ` +
          `${String(checkSide).toUpperCase()} — skipping knife-catch on ${stoppedLabel}.`,
      };
    }
  }

  return { ok: true };
}

/** Minutes after a stop before recovery gating expires (0 = never by age). */
function stopRecoveryMaxAgeMs(config = {}) {
  const mins = Number(config.stopRecoveryMaxMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  // One Kalshi 15m window — bounce-or-expire, don't freeze across many cycles.
  return 15 * 60 * 1000;
}

/**
 * After a stop-loss, cryptos often cascade / whipsaw. Block ALL new entries
 * (any side, any coin) while a majority of peer short windows are still
 * moving against the side that just stopped — not a timer.
 */
function checkPostStopPeerCascade({
  lastStopTrade,
  candidateSide, // kept for API compat; gates apply regardless of side
  predictions,
  seriesBySymbol,
  minConfidence = 50,
}) {
  if (!lastStopTrade || lastStopTrade.exitReason !== 'stop_loss') return { ok: true };
  if (!predictions || !seriesBySymbol) return { ok: true };
  void candidateSide;

  const stoppedSym = lastStopTrade.symbol;
  const peers = Object.keys(seriesBySymbol).filter(
    (sym) => sym !== stoppedSym && predictions[sym] && predictions[sym].ready
  );
  const peered = [];
  const adverse = [];
  for (const sym of peers) {
    const w5 = predictions[sym].windows && predictions[sym].windows.w5;
    if (!w5) continue;
    if (Number(w5.confidence) < Number(minConfidence)) continue;
    peered.push(sym);
    const against =
      lastStopTrade.side === 'yes'
        ? Number(w5.probabilityDown) > Number(w5.probabilityUp)
        : Number(w5.probabilityUp) > Number(w5.probabilityDown);
    if (against) adverse.push(sym);
  }
  if (peered.length === 0) return { ok: true };

  const need = Math.ceil(peered.length / 2);
  if (adverse.length >= need) {
    return {
      ok: false,
      reason:
        `Waiting: after ${stoppedSym} ${String(lastStopTrade.side).toUpperCase()} stop, peers still cascading ` +
        `(${adverse.slice(0, 4).join(', ')}${adverse.length > 4 ? '…' : ''}) — no new entries until calm (blocks loss strings / side-flips).`,
    };
  }
  return { ok: true };
}

/**
 * Profit split for skimMode === 'insurance':
 *   40% → Personal Wallet (locked paycheck)
 *   10% → Insurance Fund (builds from the start; soft $10 target is not a
 *          hard stop — it may keep growing "just in case")
 *   50% → Active Bankroll (Available Cash)
 * Losses: Insurance only absorbs once it has reached the soft target;
 *         until then the fund just keeps building (wallet untouched either way).
 */
function applyProfitBuckets({
  pnlCents,
  reserveCents = 0,
  insuranceCents = 0,
  settings = {},
  rebuildInsurance = true,
}) {
  const pnl = Number(pnlCents) || 0;
  let nextReserve = Number(reserveCents) || 0;
  let nextInsurance = Number(insuranceCents) || 0;
  const out = {
    reserveCents: nextReserve,
    insuranceCents: nextInsurance,
    skimmedCents: 0,
    insuranceAddedCents: 0,
    insuranceOverflowCents: 0,
    insuranceDrawnCents: 0,
    insuranceReleasedCents: 0,
  };

  const targetCents = Math.max(
    0,
    Math.round((Number.isFinite(Number(settings.insuranceCapDollars))
      ? Number(settings.insuranceCapDollars)
      : 10) * 100)
  );

  if (settings.skimMode !== 'insurance') {
    if (pnl <= 0) return out;
    if (settings.skimMode === 'off') return out;
    let skimmed = 0;
    if (settings.skimMode === 'fixed') {
      skimmed = Math.min(Math.round(Number(settings.skimFixedDollars || 0) * 100), pnl);
    } else {
      skimmed = Math.round(pnl * (Number(settings.skimPercent) || 0) / 100);
    }
    out.skimmedCents = skimmed;
    out.reserveCents = nextReserve + skimmed;
    return out;
  }

  if (pnl < 0) {
    // Hold until the soft target is funded — don't nibble the buffer early.
    if (nextInsurance < targetCents) {
      return out;
    }
    const loss = -pnl;
    const drawn = Math.min(nextInsurance, loss);
    out.insuranceDrawnCents = drawn;
    out.insuranceCents = nextInsurance - drawn;
    return out;
  }
  if (pnl === 0) return out;

  const wallet = Math.round(pnl * 0.4);
  // Always take 10% into insurance when rebuilding (default: every win).
  // Soft $10 target does not clip or stop contributions.
  const insuranceAdd = rebuildInsurance ? Math.round(pnl * 0.1) : 0;
  nextInsurance += insuranceAdd;

  out.skimmedCents = wallet;
  out.insuranceAddedCents = insuranceAdd;
  out.reserveCents = nextReserve + wallet;
  out.insuranceCents = nextInsurance;
  return out;
}

const EDITABLE_STRING_FIELDS = {
  symbol: (v) => (v === 'AUTO' || SERIES_BY_SYMBOL[v] ? v : null),
  skimMode: (v) => (['insurance', 'percent', 'fixed', 'off'].includes(v) ? v : null),
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
      const data = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
      // Stale saved settings from before a defaults bump — ignore knobs so
      // the new code defaults apply once, then the next boot/save rewrites.
      if (data.settingsVersion !== SETTINGS_DEFAULTS_VERSION) {
        console.log(
          `[bot] settings defaults v${SETTINGS_DEFAULTS_VERSION} — ignoring stale saved knobs (was v${data.settingsVersion ?? 'none'})`
        );
        return { settingsVersion: SETTINGS_DEFAULTS_VERSION };
      }
      return data;
    }
  } catch (err) {
    console.error('[bot] failed to load saved config, using defaults/env:', err.message);
  }
  return { settingsVersion: SETTINGS_DEFAULTS_VERSION };
}

function collectConfigOverrides(config) {
  const overrides = { settingsVersion: SETTINGS_DEFAULTS_VERSION };
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
      if (data.insuranceCents == null) data.insuranceCents = 0;
      if (data.insuranceReady == null) data.insuranceReady = false;
      if (data.periodStartTime == null) data.periodStartTime = Date.now();
      if (!Array.isArray(data.activityLog)) data.activityLog = [];
      return data;
    }
  } catch (err) {
    console.error('[bot] failed to load ledger, starting fresh:', err.message);
  }
  return {
    trades: [],
    reserveCents: 0,
    insuranceCents: 0,
    insuranceReady: false,
    periodStartTime: Date.now(),
    activityLog: [],
  };
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
 * Permanent trade history — survives the 12h live-ledger rotation.
 * Newest first. Never cleared by rotation (only by explicit paper reset).
 */
function loadTradeLog() {
  try {
    if (fs.existsSync(TRADE_LOG_PATH)) {
      const data = JSON.parse(fs.readFileSync(TRADE_LOG_PATH, 'utf8'));
      if (Array.isArray(data)) return data;
      if (Array.isArray(data.trades)) return data.trades;
    }
  } catch (err) {
    console.error('[bot] failed to load trade log:', err.message);
  }
  return [];
}

function saveTradeLog(trades) {
  try {
    writeJsonAtomic(TRADE_LOG_PATH, {
      updatedAt: new Date().toISOString(),
      count: trades.length,
      trades,
    });
  } catch (err) {
    console.error('[bot] failed to persist trade log:', err.message);
  }
}

function upsertTradeLog(entry) {
  if (!entry || !entry.id) return;
  const trades = loadTradeLog();
  const idx = trades.findIndex((t) => t.id === entry.id);
  if (idx >= 0) {
    trades[idx] = { ...trades[idx], ...entry, updatedAt: Date.now() };
  } else {
    trades.unshift({ ...entry, updatedAt: Date.now() });
  }
  if (trades.length > TRADE_LOG_MAX) trades.length = TRADE_LOG_MAX;
  saveTradeLog(trades);
}

function clearTradeLog({ archive = true } = {}) {
  const existing = loadTradeLog();
  if (archive && existing.length) {
    try {
      fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
      const fileName = `trade-log-reset-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
      writeJsonAtomic(path.join(ARCHIVE_DIR, fileName), {
        archivedAt: new Date().toISOString(),
        trades: existing,
      });
    } catch (err) {
      console.error('[bot] failed to archive trade log before clear:', err.message);
    }
  }
  saveTradeLog([]);
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
      edgeThresholdPct: 1, // minimum probability-point edge vs Kalshi to bother trading
      minConfidence: 55, // engine confidence (0-100) required to act
      stopLossCents: 23, // exit if held bid falls this many cents below entry
      takeProfitCents: 15, // exit if held bid rises this many cents above entry (see final-5 override)
      nearCertainExitCents: 97, // if held bid reaches this, bank it — don't wait on settlement for the last few ¢
      minEntryCents: 40, // never buy a side cheaper than this — blocks longshot lottery tickets
      minMinutesToOpen: 5, // don't open when fewer than this many minutes remain in the window
      // After stop-loss: require this many ¢ of bid bounce before re-entry (0 = off).
      // Null/unset uses stopRecoveryCentsRequired() (~40% of stop, min 5¢).
      stopRecoveryCents: 8,
      // Clear the whole post-stop recovery gate this many minutes after the stop
      // (even if the bid never bounced). 0 = never expire by age. Default 15.
      stopRecoveryMaxMinutes: 15,
      stakeDollars: 10, // how much money to risk per trade; contracts are computed from this at entry time
      stakingStrategy: 'fixed', // 'fixed' | 'halve-after-win' — see _computeNextStake for the logic
      maxOpenPositions: 2,
      skimMode: 'insurance', // 'insurance' | 'percent' | 'fixed' | 'off'
      skimPercent: 50, // used when skimMode === 'percent'
      skimFixedDollars: 5, // used when skimMode === 'fixed'
      // Insurance fund (skimMode === 'insurance'): 10% fund / 40% wallet / 50% bankroll
      insuranceCapDollars: 10, // fund builds to this, then 10% overflows into Active Bankroll
      paperStartingBalanceDollars: 100, // trading bankroll (also the capital backing paper trades)
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
    // Serialize manage/settle so watchdog + cycle can't double-sell the same leg.
    this._tradeLock = Promise.resolve();
    this._removeInvalidPaperTrades();
    this._seedTradeLogFromLedger();
    // Always flush the effective settings so a reboot reloads exactly what
    // this process is running (env defaults and/or last dashboard save).
    saveConfigOverrides(collectConfigOverrides(this.config));
    saveRunState({ isRunning: this.isRunning, runningSince: this.runningSince });
  }

  /** One-time backfill so existing ledger trades appear in the permanent log. */
  _seedTradeLogFromLedger() {
    const log = loadTradeLog();
    if (log.length > 0) return;
    const fromLedger = (this.ledger.trades || []).filter((t) => t && t.id);
    if (!fromLedger.length) return;
    saveTradeLog(fromLedger.map((t) => ({ ...t, updatedAt: Date.now() })));
    console.log(`[bot] seeded permanent trade log with ${fromLedger.length} existing ledger trade(s)`);
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
    this._logActivity(`Switched to ${requestedMode} mode.`, { kind: 'mode' });
    this._persist();
    return { ok: true, mode: this.config.mode };
  }

  setRunning(requestedRunning) {
    if (typeof requestedRunning !== 'boolean') return { ok: false, message: 'running must be true or false.' };
    this.isRunning = requestedRunning;
    this.runningSince = requestedRunning ? Date.now() : null;
    saveRunState({ isRunning: this.isRunning, runningSince: this.runningSince });
    this.lastDecision = requestedRunning ? 'Bot started; it will evaluate new entries on the next server cycle.' : 'Bot stopped; no new positions will be opened.';
    this._logActivity(this.lastDecision, { kind: requestedRunning ? 'start' : 'stop' });
    this._persist();
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
    this.ledger = {
      trades: [],
      reserveCents: 0,
      insuranceCents: 0,
      insuranceReady: false,
      periodStartTime: Date.now(),
      activityLog: [],
    };
    this.calibration = { buckets: {} };
    this.lastError = null;
    this.lastDecision = 'Paper trading history and statistics were reset.';
    clearTradeLog({ archive: true });
    this._logActivity(this.lastDecision, { kind: 'reset' });
    this._persist();
    saveCalibration(this.calibration);
    return { ok: true, message: 'Paper trading history and statistics were reset.' };
  }

  _logActivity(message, meta = {}) {
    if (!this.ledger.activityLog) this.ledger.activityLog = [];
    this.ledger.activityLog.unshift({
      at: Date.now(),
      message: String(message || ''),
      kind: meta.kind || 'info',
      symbol: meta.symbol || null,
      side: meta.side || null,
      pnlCents: meta.pnlCents != null ? meta.pnlCents : null,
      tradeId: meta.tradeId || null,
    });
    if (this.ledger.activityLog.length > 100) this.ledger.activityLog.length = 100;
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
    const insuranceCents = this.ledger.insuranceCents || 0;
    const paperTotalCents = startingCents + closedPnlCents;
    return {
      startingCents,
      paperTotalCents,
      reserveCents,
      insuranceCents,
      insuranceCapCents: Math.max(0, Math.round((Number(this.config.insuranceCapDollars) || 10) * 100)),
      openExposureCents,
      paperAvailableCents: Math.max(0, paperTotalCents - reserveCents - insuranceCents - openExposureCents),
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
        pruneArchiveFiles({ now });
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
    if (this.config.skimMode === 'insurance') {
      return Math.round(pnlCents * 0.4); // wallet share only (display helper)
    }
    if (this.config.skimMode === 'fixed') {
      return Math.min(Math.round(this.config.skimFixedDollars * 100), pnlCents);
    }
    // percent
    return Math.round(pnlCents * (this.config.skimPercent / 100));
  }

  /**
   * Wins (insurance mode): 40% Wallet + 10% Insurance + 50% bankroll on every
   * win from the start. Soft $10 target arms absorb (fund may keep growing).
   * Until armed, losses hit Available; once armed, Insurance absorbs first.
   */
  _applyReserveFlow(trade) {
    const pnlCents = Number(trade.pnlCents) || 0;
    const targetCents = Math.max(
      0,
      Math.round((Number(this.config.insuranceCapDollars) || 10) * 100)
    );

    const flow = applyProfitBuckets({
      pnlCents,
      reserveCents: this.ledger.reserveCents || 0,
      insuranceCents: this.ledger.insuranceCents || 0,
      settings: this.config,
      rebuildInsurance: true, // always keep building — soft target is not a stop
    });
    this.ledger.reserveCents = flow.reserveCents;
    this.ledger.insuranceCents = flow.insuranceCents;
    if ((this.ledger.insuranceCents || 0) >= targetCents) {
      this.ledger.insuranceReady = true;
    }
    trade.skimmedCents = flow.skimmedCents;
    trade.insuranceAddedCents = flow.insuranceAddedCents;
    trade.insuranceOverflowCents = flow.insuranceOverflowCents;
    trade.insuranceDrawnCents = flow.insuranceDrawnCents;
    trade.insuranceReleasedCents = flow.insuranceReleasedCents;
    trade.reserveDrawnCents = flow.insuranceDrawnCents;
  }

  _withTradeLock(fn) {
    const run = this._tradeLock.then(() => fn(), () => fn());
    this._tradeLock = run.then(
      () => undefined,
      (err) => {
        console.error('[bot] trade-lock task failed:', err && err.message ? err.message : err);
      }
    );
    return run;
  }

  _isLiveTrade(trade) {
    return Boolean(trade && (trade.mode === 'live' || trade.liveOrderId));
  }

  _sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  _orderFillCount(order) {
    if (!order || typeof order !== 'object') return 0;
    const raw =
      order.fill_count ??
      order.fillCount ??
      order.filled_count ??
      order.filledCount ??
      order.fill_count_fp ??
      order.fillCountFp;
    const n = Number.parseFloat(raw);
    return Number.isFinite(n) ? Math.floor(n) : 0;
  }

  _orderAvgFillPriceCents(order, side) {
    if (!order) return null;
    // Prefer dollar cost fields when present.
    const costDollars = Number.parseFloat(
      order.taker_fill_cost_dollars ?? order.maker_fill_cost_dollars ?? NaN
    );
    const filled = this._orderFillCount(order);
    if (Number.isFinite(costDollars) && filled > 0) {
      return Math.max(1, Math.min(99, Math.round((costDollars * 100) / filled)));
    }
    const yes = Number(order.yes_price ?? order.yesPrice);
    const no = Number(order.no_price ?? order.noPrice);
    if (side === 'yes' && Number.isFinite(yes)) return Math.round(yes);
    if (side === 'no' && Number.isFinite(no)) return Math.round(no);
    return null;
  }

  /**
   * Poll Kalshi until the order is filled enough, or give up and cancel.
   * Returns { ok, filled, avgPriceCents, order }.
   */
  async _awaitOrderFill(orderId, { minFill = 1, attempts = 6, delayMs = 350 } = {}) {
    let lastOrder = null;
    for (let i = 0; i < attempts; i += 1) {
      try {
        const data = await this.client.getOrder(orderId);
        lastOrder = data.order || data;
        const status = String(lastOrder.status || '').toLowerCase();
        const filled = this._orderFillCount(lastOrder);
        if (
          filled >= minFill ||
          status === 'executed' ||
          status === 'filled' ||
          status === 'complete' ||
          status === 'completed'
        ) {
          return {
            ok: filled >= minFill || status === 'executed' || status === 'filled',
            filled: Math.max(filled, status === 'executed' || status === 'filled' ? minFill : filled),
            avgPriceCents: null,
            order: lastOrder,
          };
        }
        if (status === 'canceled' || status === 'cancelled') {
          return { ok: false, filled, avgPriceCents: null, order: lastOrder };
        }
      } catch (err) {
        console.warn(`[bot] getOrder ${orderId} poll failed:`, err.message);
      }
      await this._sleep(delayMs);
    }
    try {
      await this.client.cancelOrder(orderId);
    } catch (err) {
      console.warn(`[bot] cancelOrder ${orderId} failed:`, err.message);
    }
    try {
      const data = await this.client.getOrder(orderId);
      lastOrder = data.order || data;
    } catch {
      // ignore
    }
    const filled = this._orderFillCount(lastOrder);
    return { ok: filled >= minFill, filled, avgPriceCents: null, order: lastOrder };
  }

  /**
   * Close a position in the ledger. For live early exits, places a sell and
   * confirms fill BEFORE marking closed. Official Kalshi settlement (reason
   * `settled`) never sends a sell — the exchange pays 0/100 itself.
   * Returns true if the trade was closed, false if left open (e.g. sell failed).
   */
  async _closePosition(trade, exitPriceCents, reason, opts = {}) {
    if (!trade || trade.status !== 'open') return false;
    if (trade._closing) return false;
    trade._closing = true;

    let bookedExit = Number(exitPriceCents);
    try {
      const isLive = this._isLiveTrade(trade);
      // Official Kalshi settlement pays 0/100 — never send a live sell at those prices.
      const skipLiveSell = opts.skipLiveSell === true || reason === 'settled';

      if (isLive && !skipLiveSell) {
        const sellPrice = Math.round(Number(opts.liveSellPriceCents != null ? opts.liveSellPriceCents : bookedExit));
        if (!Number.isFinite(sellPrice) || sellPrice < 1 || sellPrice > 99) {
          this.lastError =
            `Live exit blocked for ${trade.symbol}: refusing sell at ${sellPrice}¢ (must be 1–99). Position left open.`;
          console.error('[bot]', this.lastError);
          return false;
        }
        try {
          const order = await this.client.createOrder({
            ticker: trade.ticker,
            side: trade.side,
            action: 'sell',
            count: trade.contracts,
            priceCents: sellPrice,
          });
          const orderId = order && order.order && order.order.order_id;
          if (!orderId) throw new Error('sell response missing order_id');
          const fill = await this._awaitOrderFill(orderId, {
            minFill: trade.contracts,
            attempts: 6,
            delayMs: 350,
          });
          if (!fill.ok || fill.filled < trade.contracts) {
            throw new Error(
              `sell not fully filled (got ${fill.filled || 0}/${trade.contracts}, status ${
                fill.order && fill.order.status
              })`
            );
          }
          const avg = this._orderAvgFillPriceCents(fill.order, trade.side);
          if (Number.isFinite(avg)) bookedExit = avg;
          else bookedExit = sellPrice;
          trade.liveExitOrderId = orderId;
        } catch (err) {
          this.lastError = `Failed live exit (${reason}) on ${trade.ticker}: ${err.message}. Position left OPEN.`;
          console.error('[bot]', this.lastError);
          return false;
        }
      }

      trade.status = 'closed';
      trade.closedAt = Date.now();
      trade.exitPriceCents = bookedExit;
      trade.exitReason = reason;
      const entryCost = trade.entryPriceCents * trade.contracts;
      const exitProceeds = bookedExit * trade.contracts;
      trade.pnlCents = exitProceeds - entryCost;

      this._applyReserveFlow(trade);
      this._recordCalibration(trade);

      let decision = `Closed ${trade.symbol} ${String(trade.side).toUpperCase()} via ${reason} at ${bookedExit}¢ (P&L $${(trade.pnlCents / 100).toFixed(2)}).`;
      if (trade.insuranceDrawnCents > 0) {
        decision += ` Insurance absorbed $${(trade.insuranceDrawnCents / 100).toFixed(2)}.`;
      }
      if (trade.skimmedCents > 0) {
        decision += ` Wallet +$${(trade.skimmedCents / 100).toFixed(2)}.`;
      }
      if (trade.insuranceAddedCents > 0) {
        decision += ` Insurance +$${(trade.insuranceAddedCents / 100).toFixed(2)}.`;
      }
      if (trade.insuranceOverflowCents > 0) {
        decision += ` Insurance full — $${(trade.insuranceOverflowCents / 100).toFixed(2)} → bankroll.`;
      }
      if (trade.insuranceReleasedCents > 0) {
        decision += ` Insurance released $${(trade.insuranceReleasedCents / 100).toFixed(2)} → bankroll.`;
      }
      this.lastDecision = decision;
      this._logActivity(this.lastDecision, {
        kind: 'close',
        symbol: trade.symbol,
        side: trade.side,
        pnlCents: trade.pnlCents,
        tradeId: trade.id,
      });
      upsertTradeLog({
        id: trade.id,
        mode: trade.mode,
        symbol: trade.symbol,
        ticker: trade.ticker,
        side: trade.side,
        contracts: trade.contracts,
        stakeDollars: trade.stakeDollars,
        entryPriceCents: trade.entryPriceCents,
        exitPriceCents: trade.exitPriceCents,
        floorStrike: trade.floorStrike,
        openedAt: trade.openedAt,
        closedAt: trade.closedAt,
        windowCloseTime: trade.windowCloseTime,
        engineProbability: trade.engineProbability,
        engineConfidence: trade.engineConfidence,
        status: 'closed',
        exitReason: trade.exitReason,
        pnlCents: trade.pnlCents,
        skimmedCents: trade.skimmedCents || 0,
        insuranceAddedCents: trade.insuranceAddedCents || 0,
        insuranceDrawnCents: trade.insuranceDrawnCents || 0,
        insuranceOverflowCents: trade.insuranceOverflowCents || 0,
        insuranceReleasedCents: trade.insuranceReleasedCents || 0,
      });
      this._persist();
      return true;
    } finally {
      if (trade.status === 'open') trade._closing = false;
      else delete trade._closing;
    }
  }

  /**
   * Resolve settlement payout for a trade that has reached its window end.
   * Prefer Kalshi's official result (no live sell — exchange settles).
   * Live without a result yet: sell at the bid if still tradable, else wait.
   * Paper may use price-vs-strike when result hasn't landed.
   */
  async _settleClosedWindow(trade, predictions, market) {
    const result = market && market.result ? String(market.result).toLowerCase() : '';
    if (result === 'yes' || result === 'no') {
      const settleCents = result === trade.side ? 100 : 0;
      // Official settlement — never place a 0¢/100¢ sell order.
      await this._closePosition(trade, settleCents, 'settled', { skipLiveSell: true });
      return;
    }

    const isLive = this._isLiveTrade(trade);
    const marketDone = this._isMarketSettledStatus(market);
    const sideBid = this._heldSideBidCents(trade, market);

    // Live without an official result: sell at a real bid if still tradable, else wait.
    // Never invent a 0/100 payout or scratch the ledger while inventory may still exist.
    if (isLive) {
      if (!marketDone && Number.isFinite(sideBid) && sideBid >= 1 && sideBid <= 99) {
        await this._closePosition(trade, sideBid, 'settled_timeout', {
          liveSellPriceCents: sideBid,
        });
        return;
      }
      this.lastDecision =
        `Waiting: ${trade.symbol} past close but Kalshi result/quote not ready for a safe live exit.`;
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
      await this._closePosition(trade, won ? 100 : 0, 'settled', { skipLiveSell: true });
      this.lastDecision =
        `Settled ${trade.symbol} ${String(trade.side).toUpperCase()} via price-vs-strike ` +
        `(${livePrice} vs ${strike}) — Kalshi result not yet posted.`;
      return;
    }

    const fallback = Number.isFinite(sideBid) ? sideBid : trade.entryPriceCents;
    await this._closePosition(trade, Number.isFinite(fallback) ? fallback : trade.entryPriceCents, 'settled_timeout', {
      skipLiveSell: true,
    });
  }

  _tradeCloseDeadline(trade) {
    return tradeWindowCloseMs(trade);
  }

  _marketCloseMs(market) {
    if (!market || !market.close_time) return NaN;
    const ms = new Date(market.close_time).getTime();
    return Number.isFinite(ms) && ms > 0 ? ms : NaN;
  }

  _isMarketSettledStatus(market) {
    const status = market && market.status ? String(market.status).toLowerCase() : '';
    // Kalshi lifecycle: closed → determined → finalized (legacy docs also said settled).
    return status === 'closed' || status === 'settled' || status === 'determined' || status === 'finalized';
  }

  /**
   * True when this trade's own session is over. Uses OR of every signal —
   * never wait on a still-"active" Kalshi payload if our saved close already passed.
   */
  _isTradePastDeadline(trade, market, now = Date.now()) {
    const storedClose = this._tradeCloseDeadline(trade);
    const marketClose = this._marketCloseMs(market);
    const openedAt = Number(trade.openedAt);
    const maxAgeMs = 16.5 * 60 * 1000;
    const tooOld = Number.isFinite(openedAt) && now - openedAt >= maxAgeMs;
    const pastStored = Number.isFinite(storedClose) && now >= storedClose;
    const pastMarket = Number.isFinite(marketClose) && now >= marketClose;
    return pastStored || pastMarket || this._isMarketSettledStatus(market) || tooOld;
  }

  _heldSideBidCents(trade, market) {
    if (!market) return null;
    if (trade.side === 'yes') {
      if (Number.isFinite(market.yes_bid)) return market.yes_bid;
      // Infer YES bid from NO ask when Kalshi omits one side.
      if (Number.isFinite(market.no_ask)) return Math.max(1, Math.min(99, 100 - market.no_ask));
      return null;
    }
    if (Number.isFinite(market.no_bid)) return market.no_bid;
    if (Number.isFinite(market.yes_ask)) return Math.max(1, Math.min(99, 100 - market.yes_ask));
    return null;
  }

  async _getMarketBounded(ticker, timeoutMs = 4000) {
    let timer = null;
    try {
      return await Promise.race([
        this.client.getMarket(ticker),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error(`getMarket timeout after ${timeoutMs}ms`)), timeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  /**
   * Close any trade whose own window is already over. Safe to call on a
   * tight timer independent of prediction compute — this is what stops
   * open positions from "freezing" into the next 15m dashboard session.
   */
  async forceSettleOverdue(predictions) {
    return this._withTradeLock(() => this._forceSettleOverdueUnlocked(predictions));
  }

  async _forceSettleOverdueUnlocked(predictions) {
    const now = Date.now();
    let settled = 0;
    for (const trade of [...this.openTrades]) {
      if (trade.status !== 'open') continue;
      const deadline = this._tradeCloseDeadline(trade);
      const openedAt = Number(trade.openedAt);
      const due =
        (Number.isFinite(deadline) && now >= deadline) ||
        (Number.isFinite(openedAt) && now - openedAt >= 16.5 * 60 * 1000);
      if (!due) continue;

      console.warn(
        `[bot] force-settle overdue ${trade.symbol} ${String(trade.side).toUpperCase()} ` +
          `${trade.ticker} (saved close ${Number.isFinite(deadline) ? new Date(deadline).toISOString() : 'n/a'})`
      );
      let market = null;
      try {
        market = await this._getMarketBounded(trade.ticker, 1000);
      } catch (err) {
        console.warn(`[bot] overdue settle fetch ${trade.ticker}: ${err.message}`);
      }
      try {
        const before = trade.status;
        await this._settleClosedWindow(trade, predictions, market);
        if (before === 'open' && trade.status === 'closed') settled += 1;
      } catch (err) {
        console.error(`[bot] overdue settle failed ${trade.ticker}:`, err.message);
        if (trade.status === 'open' && !this._isLiveTrade(trade)) {
          try {
            await this._closePosition(
              trade,
              Number.isFinite(trade.entryPriceCents) ? trade.entryPriceCents : 50,
              'settled_timeout',
              { skipLiveSell: true }
            );
            settled += 1;
          } catch (closeErr) {
            console.error(`[bot] emergency scratch failed ${trade.ticker}:`, closeErr.message);
          }
        }
      }
    }
    return settled;
  }

  async _manageOpenTrade(trade, predictions) {
    const now = Date.now();
    const storedClose = this._tradeCloseDeadline(trade);
    const pastSavedClose = Number.isFinite(storedClose) && now >= storedClose;
    const tooOld =
      Number.isFinite(Number(trade.openedAt)) && now - Number(trade.openedAt) >= 16.5 * 60 * 1000;

    // Once THIS trade's window is over, settle this cycle. Never sit through
    // the next dashboard session waiting on a hung Kalshi fetch.
    if (pastSavedClose || tooOld) {
      let market = null;
      try {
        market = await this._getMarketBounded(trade.ticker, 1000);
      } catch (err) {
        console.warn(`[bot] market fetch for settle ${trade.ticker}: ${err.message}`);
      }
      await this._settleClosedWindow(trade, predictions, market);
      return;
    }

    let market = null;
    try {
      market = await this._getMarketBounded(trade.ticker, 4000);
    } catch (err) {
      this.lastError = `Failed to fetch open position's market (${trade.ticker}): ${err.message}`;
      console.error('[bot]', this.lastError);
      return;
    }

    if (!market) return;

    if (this._isTradePastDeadline(trade, market, now)) {
      await this._settleClosedWindow(trade, predictions, market);
      return;
    }

    const heldSideBidCents = this._heldSideBidCents(trade, market);
    // For stop/TP timing use the earliest known close so we don't hold into the next session.
    const closeCandidates = [storedClose, this._marketCloseMs(market)].filter((t) => Number.isFinite(t) && t > 0);
    const closeTime = closeCandidates.length ? Math.min(...closeCandidates) : NaN;

    if (!Number.isFinite(closeTime)) {
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
    // Last 30s–60s: stop holding for settlement — you're just waiting on Kalshi.
    const inPreCloseTakeProfitWindow = minutesRemaining <= 1;
    const shortWindow = inFinalFiveMinutes && predictions && predictions[trade.symbol] && predictions[trade.symbol].ready
      ? predictions[trade.symbol].windows.w5
      : null;
    const signalFlipped =
      shortWindow &&
      ((trade.side === 'yes' && shortWindow.probabilityDown > shortWindow.probabilityUp) ||
        (trade.side === 'no' && shortWindow.probabilityUp > shortWindow.probabilityDown));

    // Final-5 confidence hold: ride settlement only before the last minute.
    // Inside the last ~60s (and at near-certain bids), take the money instead.
    const heldFavoredByShortWindow =
      shortWindow &&
      shortWindow.confidence >= this.config.minConfidence &&
      ((trade.side === 'yes' && shortWindow.probabilityUp >= shortWindow.probabilityDown) ||
        (trade.side === 'no' && shortWindow.probabilityDown >= shortWindow.probabilityUp));
    const holdThroughForConfidence =
      inFinalFiveMinutes && !inPreCloseTakeProfitWindow && heldFavoredByShortWindow;

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

    const stopLevel = this._stopLevelCents(trade);
    const takeProfitLevel = this._takeProfitLevelCents(trade);
    // ~97¢ = market basically sure — don't sit for settlement lag over 3¢.
    const nearCertainExitCents = Number.isFinite(Number(this.config.nearCertainExitCents))
      ? Number(this.config.nearCertainExitCents)
      : 97;
    const nearCertainHit =
      heldSideBidCents != null &&
      Number.isFinite(nearCertainExitCents) &&
      nearCertainExitCents > 0 &&
      heldSideBidCents >= nearCertainExitCents &&
      Number.isFinite(trade.entryPriceCents) &&
      heldSideBidCents > trade.entryPriceCents;

    const takeProfitHit =
      heldSideBidCents != null &&
      takeProfitLevel != null &&
      heldSideBidCents >= takeProfitLevel &&
      Number.isFinite(trade.entryPriceCents) &&
      heldSideBidCents > trade.entryPriceCents;

    // Breakeven in the last 5 minutes when confidence is NOT high in our
    // favor: lock even-or-better instead of gambling settlement.
    const canExitEven =
      inFinalFiveMinutes &&
      !holdThroughForConfidence &&
      heldSideBidCents != null &&
      heldSideBidCents >= trade.entryPriceCents;

    if (heldSideBidCents != null && stopLevel != null && heldSideBidCents <= stopLevel) {
      // Trigger on the live bid. Paper books the stop level (entry − drop).
      // Live sells at the real bid — markets don't owe you the stop price.
      const stopFill = this.config.mode === 'paper' ? stopLevel : heldSideBidCents;
      await this._closePosition(trade, stopFill, 'stop_loss', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (nearCertainHit) {
      const fill =
        this.config.mode === 'paper'
          ? Math.min(99, Math.max(nearCertainExitCents, heldSideBidCents))
          : heldSideBidCents;
      await this._closePosition(trade, fill, 'near_certain', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (strongReversalSignal && heldSideBidCents != null) {
      await this._closePosition(trade, heldSideBidCents, 'reversal_signal', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (signalFlipped && heldSideBidCents != null) {
      await this._closePosition(trade, heldSideBidCents, 'signal_flip', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (takeProfitHit && !holdThroughForConfidence) {
      const tpFill = this.config.mode === 'paper' ? takeProfitLevel : heldSideBidCents;
      await this._closePosition(trade, tpFill, 'take_profit', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (
      inPreCloseTakeProfitWindow &&
      heldSideBidCents != null &&
      Number.isFinite(trade.entryPriceCents) &&
      heldSideBidCents > trade.entryPriceCents
    ) {
      // ~30s–60s left and already green: bank it rather than await settle.
      await this._closePosition(trade, heldSideBidCents, 'pre_close_bank', {
        liveSellPriceCents: heldSideBidCents,
      });
    } else if (canExitEven) {
      await this._closePosition(trade, heldSideBidCents, 'breakeven', {
        liveSellPriceCents: heldSideBidCents,
      });
    }
  }

  /**
   * Manage open trades only (no new entries). Safe to call when prediction
   * compute failed — settlement must not depend on a healthy Coinbase cycle.
   */
  async manageOpenPositions(predictions) {
    return this._withTradeLock(() => this._manageOpenPositionsUnlocked(predictions));
  }

  async _manageOpenPositionsUnlocked(predictions) {
    this._maybeRotateLedger(Date.now());
    for (const trade of [...this.openTrades]) {
      try {
        await this._manageOpenTrade(trade, predictions);
      } catch (err) {
        console.error(`[bot] manage open ${trade.symbol} ${trade.ticker} failed:`, err.message);
        const now = Date.now();
        if (this._isTradePastDeadline(trade, null, now) && trade.status === 'open') {
          try {
            // Paper can scratch; live inventory must not be ledger-closed without a fill/result.
            if (this._isLiveTrade(trade)) {
              console.warn(`[bot] live ${trade.ticker} past deadline but manage failed — leaving open`);
            } else {
              await this._closePosition(
                trade,
                Number.isFinite(trade.entryPriceCents) ? trade.entryPriceCents : 50,
                'settled_timeout',
                { skipLiveSell: true }
              );
            }
          } catch (closeErr) {
            console.error(`[bot] emergency close failed for ${trade.ticker}:`, closeErr.message);
          }
        }
      }
    }
  }

  /**
   * Stop / take-profit are relative to this trade's entry:
   *   stop level = max(1, entry − stopLossCents)
   *   TP level   = min(99, entry + takeProfitCents)
   */
  _stopLevelCents(trade) {
    const entry = Number(trade.entryPriceCents);
    const drop = Number(this.config.stopLossCents);
    if (!Number.isFinite(entry) || entry < 1 || !Number.isFinite(drop) || drop <= 0) return null;
    return Math.max(1, Math.round(entry - drop));
  }

  _takeProfitLevelCents(trade) {
    const entry = Number(trade.entryPriceCents);
    const rise = Number(this.config.takeProfitCents);
    if (!Number.isFinite(entry) || entry < 1 || !Number.isFinite(rise) || rise <= 0) return null;
    return Math.min(99, Math.round(entry + rise));
  }

  _hasOpenOnSymbol(symbol) {
    return this.openTrades.some((t) => t.symbol === symbol);
  }

  _hasOpenOnTicker(ticker) {
    return Boolean(ticker) && this.openTrades.some((t) => t.ticker === ticker);
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
    const minutesLeft = (closeAt - Date.now()) / 60000;
    const minMinutesToOpen = Number.isFinite(Number(this.config.minMinutesToOpen))
      ? Number(this.config.minMinutesToOpen)
      : 5;
    if (minMinutesToOpen > 0 && minutesLeft < minMinutesToOpen) {
      this.lastDecision =
        `Skipped ${symbol}: only ${minutesLeft.toFixed(1)} min left (min ${minMinutesToOpen} to open).`;
      return;
    }
    // Max positions is a concurrency cap across coins — stacking two opens
    // on the same symbol (or ticker) just doubles correlated exposure.
    if (this._hasOpenOnSymbol(symbol) || this._hasOpenOnTicker(ticker)) {
      this.lastDecision = `Skipped ${symbol}: already have an open position on this coin/market.`;
      return;
    }
    const minEntry = Number(this.config.minEntryCents);
    if (Number.isFinite(minEntry) && minEntry > 0 && priceCents < minEntry) {
      this.lastDecision =
        `Skipped ${symbol} ${String(side || '').toUpperCase()} @ ${priceCents}¢: below min entry ${minEntry}¢ (longshot ban).`;
      return;
    }
    // Each Kalshi contract costs `priceCents` cents and pays out $1 if it
    // wins, so buying (stakeDollars * 100 / priceCents) contracts risks
    // approximately stakeDollars. Always at least 1 contract.
    const stakeDollars = this._computeNextStake();
    const contracts = Math.max(1, Math.floor((stakeDollars * 100) / priceCents));
    const entryCostCents = contracts * priceCents;
    const capital = this._capitalStatus();
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
        const orderId = order && order.order && order.order.order_id;
        if (!orderId) {
          this.lastError = `Live entry on ${symbol} returned no order_id — not recording trade.`;
          console.error('[bot]', this.lastError);
          return;
        }
        const fill = await this._awaitOrderFill(orderId, {
          minFill: trade.contracts,
          attempts: 6,
          delayMs: 350,
        });
        if (!fill.ok || fill.filled < 1) {
          this.lastError =
            `Live entry on ${symbol} did not fill (filled ${fill.filled || 0}/${trade.contracts}) — not recording trade.`;
          console.error('[bot]', this.lastError);
          return;
        }
        if (fill.filled < trade.contracts) {
          trade.contracts = fill.filled;
          trade.stakeDollars = +((trade.contracts * priceCents) / 100).toFixed(2);
        }
        const avg = this._orderAvgFillPriceCents(fill.order, side);
        if (Number.isFinite(avg)) {
          trade.entryPriceCents = avg;
          trade.stakeDollars = +((trade.contracts * avg) / 100).toFixed(2);
        }
        trade.liveOrderId = orderId;
      } catch (err) {
        this.lastError = `Failed to place live entry order: ${err.message}`;
        console.error('[bot]', this.lastError);
        return; // don't record a trade we couldn't actually place
      }
    }

    this.ledger.trades.unshift(trade);
    if (this.ledger.trades.length > 200) this.ledger.trades.length = 200;
    this.lastDecision = `Opened ${symbol} ${side.toUpperCase()} ${this.config.mode} position at ${priceCents}¢ (confidence ${engineConfidence}%).`;
    this._logActivity(this.lastDecision, {
      kind: 'open',
      symbol,
      side,
      tradeId: trade.id,
    });
    upsertTradeLog({
      id: trade.id,
      mode: trade.mode,
      symbol: trade.symbol,
      ticker: trade.ticker,
      side: trade.side,
      contracts: trade.contracts,
      stakeDollars: trade.stakeDollars,
      entryPriceCents: trade.entryPriceCents,
      floorStrike: trade.floorStrike,
      openedAt: trade.openedAt,
      windowCloseTime: trade.windowCloseTime,
      engineProbability: trade.engineProbability,
      engineConfidence: trade.engineConfidence,
      status: 'open',
    });
    this._persist();
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
    await this.manageOpenPositions(predictions);

    if (!this.isRunning) {
      this.lastDecision = 'Bot is stopped; it will continue monitoring any already-open positions but will not open new ones.';
      return;
    }
    if (this.openTrades.length >= this.config.maxOpenPositions) return;
    if (!predictions) return;

    // After a stop, don't stack a second leg while the wound is still fresh —
    // the loss-string pattern was stop → instantly fill both slots again.
    const preferOtherThan = this._lastStopLossSymbol();
    if (preferOtherThan && this.openTrades.length >= 1) {
      this.lastDecision =
        `Waiting: after ${preferOtherThan} stop — max 1 open until post-stop calm (avoids loss strings).`;
      return;
    }

    // After a stop-loss, scan other coins first instead of immediately
    // rebuying the same one that just stopped (even if it still ranks highest).
    const scanAllAfterStop =
      preferOtherThan != null &&
      (this.config.symbol === 'AUTO' || preferOtherThan === this.config.symbol);

    const opportunity =
      this.config.symbol === 'AUTO' || scanAllAfterStop
        ? await this._findBestOpportunity(predictions, { preferOtherThan })
        : await this._evaluateSymbolForEdge(this.config.symbol, predictions);

    if (!opportunity) return;

    if (preferOtherThan && opportunity.symbol !== preferOtherThan) {
      this.lastDecision =
        `Post-stop: chose ${opportunity.symbol} over recently stopped ${preferOtherThan} ` +
        `(checking other cryptos first).`;
    }

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

  /** Most recent closed trade if it was a stop-loss; else null. */
  _lastStopLossTrade() {
    const last = this.ledger.trades.find((t) => t.status === 'closed');
    if (last && last.exitReason === 'stop_loss') return last;
    return null;
  }

  /** Most recent closed trade's symbol if it was a stop-loss; else null. */
  _lastStopLossSymbol() {
    const last = this._lastStopLossTrade();
    return last && last.symbol ? last.symbol : null;
  }

  /**
   * After a stop, require the stopped coin's bid bounce before new entries.
   * Thesis favor only blocks same-coin same-side knife-catch; peers unlock
   * after the bounce (peer-cascade gate still applies while dumps continue).
   */
  async _stoppedCoinRecoveryGate(candidateSymbol, candidateSide, candidatePriceCents, candidateWindow, predictions) {
    const lastStop = this._lastStopLossTrade();
    const recoveryCents = stopRecoveryCentsRequired(this.config);
    if (!lastStop || recoveryCents <= 0) {
      return { ok: true };
    }

    const maxAgeMs = stopRecoveryMaxAgeMs(this.config);
    const closedAt = Number(lastStop.closedAt);
    if (
      maxAgeMs > 0 &&
      Number.isFinite(closedAt) &&
      Date.now() - closedAt >= maxAgeMs
    ) {
      return { ok: true };
    }

    if (isPostStopRecoverySessionExpired(lastStop)) {
      return { ok: true };
    }

    let priceCents = candidatePriceCents;
    let window = candidateWindow;

    // Always quote the *stopped* side on the *stopped* coin for the bounce check.
    if (candidateSymbol !== lastStop.symbol || candidateSide !== lastStop.side) {
      const seriesTicker = SERIES_BY_SYMBOL[lastStop.symbol];
      const stoppedPred = predictions && predictions[lastStop.symbol];
      if (!seriesTicker) return { ok: true };
      if (!stoppedPred || !stoppedPred.ready) {
        return {
          ok: false,
          reason:
            `Waiting: after ${lastStop.symbol} stop — need ${lastStop.symbol} prediction ready ` +
            `before any new entry on ${candidateSymbol}.`,
        };
      }
      try {
        const markets = await this.client.getOpenMarkets(seriesTicker, 5);
        const nowMs = Date.now();
        const market = (markets || []).find((m) => {
          const closeMs = m.close_time ? new Date(m.close_time).getTime() : NaN;
          return Number.isFinite(closeMs) && closeMs > nowMs + 5000;
        });
        if (!market) {
          return {
            ok: false,
            reason:
              `Waiting: after ${lastStop.symbol} stop — no live ${lastStop.symbol} quote for recovery ` +
              `check before entering ${candidateSymbol}.`,
          };
        }
        const yesBid = Number(market.yes_bid);
        const yesAsk = Number(market.yes_ask);
        priceCents = lastStop.side === 'yes' ? yesAsk : 100 - yesBid;
        if (!Number.isFinite(priceCents)) {
          return {
            ok: false,
            reason:
              `Waiting: after ${lastStop.symbol} stop — ${lastStop.symbol} ${String(lastStop.side).toUpperCase()} ` +
              `quote unavailable for recovery check.`,
          };
        }
        const closeTime = new Date(market.close_time).getTime();
        const minutesRemaining = Math.max(0.1, (closeTime - nowMs) / 60000);
        window = this._pickWindow(stoppedPred.windows, minutesRemaining) || stoppedPred.windows.w5;
      } catch (err) {
        return {
          ok: false,
          reason:
            `Waiting: after ${lastStop.symbol} stop — recovery quote failed (${err.message}) ` +
            `before entering ${candidateSymbol}.`,
        };
      }
    }

    return checkPostStopRecovery({
      lastClosedForSymbol: lastStop,
      side: lastStop.side,
      priceCents,
      window,
      recoveryCents,
      symbol: lastStop.symbol,
      forCandidateSymbol: candidateSymbol,
      forCandidateSide: candidateSide,
      maxAgeMs,
    });
  }

  /**
   * Fetches the current open market for one symbol and checks whether
   * there's a large enough edge (and enough confidence) to be worth
   * trading. Returns an opportunity descriptor, or null if there's nothing
   * worth acting on (or the market/prediction data isn't available).
   */
  async _evaluateSymbolForEdge(symbol, predictions) {
    if (this._hasOpenOnSymbol(symbol)) {
      this.lastDecision = `Waiting: already holding an open ${symbol} position (one open per coin).`;
      return null;
    }

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
    if (this._hasOpenOnTicker(market.ticker)) {
      this.lastDecision = `Waiting: already holding an open position on ${market.ticker}.`;
      return null;
    }

    const now = Date.now();
    const closeTime = new Date(market.close_time).getTime();
    if (closeTime <= now) {
      this.lastDecision = `Waiting: the available ${symbol} market is already closed.`;
      return null;
    }

    const minutesRemaining = Math.max(0.1, (closeTime - now) / 60000);
    const minMinutesToOpen = Number.isFinite(Number(this.config.minMinutesToOpen))
      ? Number(this.config.minMinutesToOpen)
      : 5;
    if (minMinutesToOpen > 0 && minutesRemaining < minMinutesToOpen) {
      this.lastDecision =
        `Waiting: ${symbol} window has only ${minutesRemaining.toFixed(1)} min left (need ≥ ${minMinutesToOpen} to open — avoids freeze-into-settle).`;
      return null;
    }
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
    const minEntry = Number(this.config.minEntryCents);
    if (Number.isFinite(minEntry) && minEntry > 0 && priceCents < minEntry) {
      this.lastDecision =
        `Waiting: ${symbol} ${side.toUpperCase()} is ${priceCents}¢ — below min entry ${minEntry}¢ (skipping longshots even if confidence is high).`;
      return null;
    }

    // Stopped coin must bounce before any new entry; thesis favor only for
    // same-coin same-side knife-catch (peers unlock after bounce).
    const recoveryCheck = await this._stoppedCoinRecoveryGate(
      symbol,
      side,
      priceCents,
      window,
      predictions
    );
    if (!recoveryCheck.ok) {
      this.lastDecision = recoveryCheck.reason;
      return null;
    }

    const peerCheck = checkPostStopPeerCascade({
      lastStopTrade: this._lastStopLossTrade(),
      candidateSide: side,
      predictions,
      seriesBySymbol: SERIES_BY_SYMBOL,
      minConfidence: this.config.minConfidence,
    });
    if (!peerCheck.ok) {
      this.lastDecision = peerCheck.reason;
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
   * edge across everything it's watching. Symbols that already have an open
   * position are skipped so a second slot diversifies instead of doubling up.
   *
   * After a stop-loss, `preferOtherThan` demotes that coin so other cryptos
   * are tried first; the stopped coin is only chosen if nothing else clears.
   */
  async _findBestOpportunity(predictions, { preferOtherThan = null } = {}) {
    const candidates = Object.keys(SERIES_BY_SYMBOL).filter(
      (sym) => predictions[sym] && !this._hasOpenOnSymbol(sym)
    );
    const evaluations = await Promise.all(
      candidates.map((sym) => this._evaluateSymbolForEdge(sym, predictions))
    );
    const valid = evaluations.filter(Boolean);
    if (valid.length === 0) return null;
    valid.sort((a, b) => {
      if (preferOtherThan) {
        const aPen = a.symbol === preferOtherThan ? 1 : 0;
        const bPen = b.symbol === preferOtherThan ? 1 : 0;
        if (aPen !== bPen) return aPen - bPen;
      }
      return b.rankScore - a.rankScore;
    });
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

  getTradeLog({ limit = 100, offset = 0 } = {}) {
    const all = loadTradeLog();
    const start = Math.max(0, Number(offset) || 0);
    const take = Math.min(500, Math.max(1, Number(limit) || 100));
    return {
      total: all.length,
      trades: all.slice(start, start + take),
      path: TRADE_LOG_PATH,
    };
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
    const permanentLog = loadTradeLog();
    const now = Date.now();
    const overdueOpen = this.openTrades.filter((t) => {
      const d = this._tradeCloseDeadline(t);
      return Number.isFinite(d) && now >= d;
    });
    return {
      mode: this.config.mode,
      isRunning: this.isRunning,
      runningSince: this.runningSince,
      config: this.config,
      lastError: this.lastError,
      lastDecision: this.lastDecision,
      openTrades: this.openTrades,
      overdueOpenCount: overdueOpen.length,
      recentTrades: this.ledger.trades.slice(0, 20),
      activityLog: (this.ledger.activityLog || []).slice(0, 40),
      // Permanent history (survives 12h ledger rotation). Newest first.
      tradeLog: permanentLog.slice(0, 50),
      tradeLogTotal: permanentLog.length,
      stats: {
        totalAttempts: this.ledger.trades.length, // current period open + closed
        totalTrades: closed.length, // settled/closed trades only (current period)
        wins,
        profitableExits: wins,
        losses: closed.length - wins,
        winRatePct: closed.length ? +((wins / closed.length) * 100).toFixed(1) : null,
        currentWinStreak,
        longestWinStreak,
        netPnlCents: closed.reduce((sum, t) => sum + (t.pnlCents || 0), 0),
        reserveCents: this.ledger.reserveCents || 0,
        insuranceCents: this.ledger.insuranceCents || 0,
        lifetimeTrades: permanentLog.length,
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

module.exports = {
  TradingBot,
  SERIES_BY_SYMBOL,
  stopRecoveryCentsRequired,
  stopRecoveryMaxAgeMs,
  tradeWindowCloseMs,
  isPostStopRecoverySessionExpired,
  checkPostStopRecovery,
  checkPostStopPeerCascade,
  applyProfitBuckets,
};
