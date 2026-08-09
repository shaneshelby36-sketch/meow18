'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { dataPath, ensureDataDir, writeJsonAtomic, pruneArchiveFiles } = require('./paths');
const { bookSideFromLegacy } = require('./kalshiClient');

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
const SETTINGS_DEFAULTS_VERSION = 12;

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
// writing: BTC, ETH, SOL, XRP, DOGE, BNB, NEAR, HYPE. ZEC is deliberately NOT
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
  NEAR: 'KXNEAR15M',
  HYPE: 'KXHYPE15M',
};

// Opted out of new entries (AUTO + single-symbol). Series stay mapped so any
// leftover open position can still be managed/exited. Dashboard still tracks price.
const DISABLED_TRADE_SYMBOLS = new Set(['DOGE']);

function isKalshiTradeEnabled(symbol) {
  return Boolean(SERIES_BY_SYMBOL[symbol]) && !DISABLED_TRADE_SYMBOLS.has(symbol);
}

function tradeableKalshiSymbols() {
  return Object.keys(SERIES_BY_SYMBOL).filter((s) => isKalshiTradeEnabled(s));
}

// Rough Kalshi 15m crypto liquidity preference (higher = usually tighter books).
// Used to break ties / prefer fillable markets over thin XRP-style books.
const LIQUIDITY_PRIORITY_BY_SYMBOL = {
  BTC: 50,
  ETH: 40,
  SOL: 30,
  BNB: 20,
  NEAR: 15,
  HYPE: 12,
  XRP: 10,
  DOGE: 5,
};

function liquidityPriority(symbol) {
  return LIQUIDITY_PRIORITY_BY_SYMBOL[String(symbol || '').toUpperCase()] || 0;
}

/**
 * Settle AUTO: asks at/above this are demoted so mid-band names (e.g. 85–93¢)
 * get tried before nearly-certain 94¢+ tickets on the usual majors.
 */
function settleRichAskFloorCents(config = {}) {
  const n = Number(config.settleRichAskFloorCents);
  if (Number.isFinite(n) && n >= 50 && n <= 99) return Math.round(n);
  return 94;
}

/** Ask component of settle rankScore (higher = better). Rich asks get −200. */
function settleRankAskScore(priceCents, { richFloorCents = 94, usedLateBand = false } = {}) {
  const p = Math.round(Number(priceCents));
  if (!Number.isFinite(p)) return -999;
  const bandBonus = usedLateBand ? 0 : 100;
  const askPart = p >= richFloorCents ? p - 200 : p;
  return askPart + bandBonus;
}

/**
 * Minimum cents of upside to settlement (100 − ask) required to open a settle
 * trade. Default 8¢ (independent of stop — a wide 20¢ noise stop must not
 * force asks ≤80¢). 0 = off. Still blocks 94–95¢ dead R:R tickets via rich floor.
 */
function settleMinUpsideCents(config = {}) {
  const explicit = Number(config.settleMinUpsideCents);
  if (Number.isFinite(explicit) && explicit <= 0) return 0;
  if (Number.isFinite(explicit) && explicit > 0) return Math.min(50, Math.round(explicit));
  return 8;
}

/** Settle-mode entry band (default 85–92¢). Clamped to 1–99; swaps if inverted. */
function settleEntryBand(config = {}) {
  let min = Number(config.settleEntryMinCents);
  let max = Number(config.settleEntryMaxCents);
  if (!Number.isFinite(min)) min = 85;
  // Default 92: with an 8¢ stop you need ≥8¢ upside to 100 (ask ≤92).
  if (!Number.isFinite(max)) max = 92;
  min = Math.max(1, Math.min(99, Math.round(min)));
  max = Math.max(1, Math.min(99, Math.round(max)));
  if (max < min) {
    const tmp = min;
    min = max;
    max = tmp;
  }
  return { min, max };
}

/** Minutes left at/under which settle may dip below the primary min (0 = off). Default 3.5. */
function settleLateEntryMinutes(config = {}) {
  const m = Number(config.settleLateEntryMinutes);
  if (Number.isFinite(m) && m <= 0) return 0;
  if (Number.isFinite(m) && m > 0) return m;
  return 3.5;
}

/** Floor ask when late fallback is active (default 70¢). Never above primary min. */
function settleLateEntryMinCents(config = {}) {
  const band = settleEntryBand(config);
  let n = Number(config.settleLateEntryMinCents);
  if (!Number.isFinite(n)) n = 70;
  n = Math.max(1, Math.min(99, Math.round(n)));
  return Math.min(n, band.min);
}

/**
 * Effective settle band for this moment. Late fallback expands the floor only when
 * minutesRemaining ≤ settleLateEntryMinutes and no primary-band print is required
 * by the caller — here we just report the expanded range when the clock qualifies.
 */
function settleEffectiveEntryBand(config = {}, minutesRemaining = Infinity) {
  const band = settleEntryBand(config);
  const lateMins = settleLateEntryMinutes(config);
  const lateFloor = settleLateEntryMinCents(config);
  const mins = Number(minutesRemaining);
  const late =
    lateMins > 0 &&
    Number.isFinite(mins) &&
    mins <= lateMins &&
    lateFloor < band.min;
  return {
    min: late ? lateFloor : band.min,
    max: band.max,
    primaryMin: band.min,
    late,
  };
}

function isSettleEntryPriceCents(priceCents, config = {}, minutesRemaining = null) {
  const band =
    minutesRemaining == null
      ? settleEntryBand(config)
      : settleEffectiveEntryBand(config, minutesRemaining);
  const p = Number(priceCents);
  return Number.isFinite(p) && p >= band.min && p <= band.max;
}

function isSettleStrategyMode(config = {}) {
  return String(config.strategyMode || '').toLowerCase() === 'settle';
}

function isSettleTrade(trade) {
  return trade && String(trade.strategy || '').toLowerCase() === 'settle';
}

/** Entry-tiered settle TP/stale exits (default on). Off → stop + hold to settlement only. */
function isSettleTieredExitsEnabled(config = {}) {
  const v = config.settleTieredExits;
  if (v === false || v === 0 || v === '0') return false;
  const s = String(v == null ? 'on' : v).toLowerCase();
  return !(s === 'off' || s === 'false' || s === 'no');
}

/**
 * Single source of truth for settle entry → TP / stale-green table.
 * Dashboard reads this via /api/bot/config; settleExitPlan uses the same rows.
 * Edit here when changing tiers — UI updates automatically on next config load.
 */
const SETTLE_EXIT_TIERS = [
  {
    minEntry: 90,
    maxEntry: 99,
    targetCents: null,
    staleMinutesLeft: null,
    tier: 'hold',
    entryLabel: '≥90¢',
    aimLabel: 'hold to settle',
    staleLabel: '—',
  },
  {
    minEntry: 85,
    maxEntry: 89,
    targetCents: 96,
    staleMinutesLeft: 2,
    tier: 'high',
    entryLabel: '85–89¢',
    aimLabel: '96¢',
    staleLabel: '≤2m left',
  },
  {
    minEntry: 80,
    maxEntry: 84,
    targetCents: 94,
    staleMinutesLeft: 2.5,
    tier: 'mid',
    entryLabel: '80–84¢',
    aimLabel: '94¢',
    staleLabel: '≤2.5m left',
  },
  {
    minEntry: 75,
    maxEntry: 79,
    targetCents: 93,
    staleMinutesLeft: 3,
    tier: 'low',
    entryLabel: '75–79¢',
    aimLabel: '93¢',
    staleLabel: '≤3m left',
  },
  {
    minEntry: 1,
    maxEntry: 74,
    targetCents: 92,
    staleMinutesLeft: 3.5,
    tier: 'late',
    entryLabel: '<75¢ (late)',
    aimLabel: '92¢',
    staleLabel: '≤3.5m left',
  },
];

function settleExitTiersForDashboard() {
  return SETTLE_EXIT_TIERS.map((t) => ({
    entryLabel: t.entryLabel,
    aimLabel: t.aimLabel,
    staleLabel: t.staleLabel,
    tier: t.tier,
    targetCents: t.targetCents,
    staleMinutesLeft: t.staleMinutesLeft,
  }));
}

/**
 * Entry-tiered settle exits: target bid depends on fill price; if that target
 * is not reached by `staleMinutesLeft` remaining, bank a green bid instead of
 * sitting for settlement. Tiers live in SETTLE_EXIT_TIERS (keep dashboard in sync).
 */
function settleExitPlan(entryPriceCents) {
  const entry = Math.round(Number(entryPriceCents));
  if (!Number.isFinite(entry) || entry < 1) {
    return { targetCents: null, staleMinutesLeft: null, tier: 'invalid' };
  }
  for (const t of SETTLE_EXIT_TIERS) {
    if (entry >= t.minEntry && entry <= t.maxEntry) {
      return {
        targetCents: t.targetCents,
        staleMinutesLeft: t.staleMinutesLeft,
        tier: t.tier,
        entry,
      };
    }
  }
  const late = SETTLE_EXIT_TIERS[SETTLE_EXIT_TIERS.length - 1];
  return {
    targetCents: late.targetCents,
    staleMinutesLeft: late.staleMinutesLeft,
    tier: late.tier,
    entry,
  };
}

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
  'peerCascadeMaxMinutes',
  'postStopMaxOneMinutes',
  'postStopSameSideCooldownMinutes',
  'settlePostStopSameSideCooldownMinutes',
  'settlePostStaleSameSideCooldownMinutes',
  'settleEntryMinCents',
  'settleEntryMaxCents',
  'settleStopLossCents',
  'settleMinMinutesToOpen',
  'settleMaxMinutesToOpen',
  'settleLateEntryMinutes',
  'settleLateEntryMinCents',
  'settleRichAskFloorCents',
  'settleMinUpsideCents',
  'settleStuckHoldMinutes',
  'stakeDollars',
  'maxOpenPositions',
  'skimPercent',
  'skimFixedDollars',
  'insuranceCapDollars',
  'insuranceFloorDollars',
  'insuranceOverflowDollars',
  'paperStartingBalanceDollars',
];

/** Default arm ($10) / floor ($6) for insurance hysteresis; soft fill ceiling ($15). */
const INSURANCE_ARM_DEFAULT = 10;
const INSURANCE_FLOOR_DEFAULT = 6;
const INSURANCE_OVERFLOW_DEFAULT = 15;

/**
 * Resolve arm/floor cents. Floor must be strictly below arm — clamp if not.
 */
function insuranceArmFloorCents(settings = {}) {
  const armDollars = Number.isFinite(Number(settings.insuranceCapDollars))
    ? Number(settings.insuranceCapDollars)
    : INSURANCE_ARM_DEFAULT;
  let floorDollars = Number.isFinite(Number(settings.insuranceFloorDollars))
    ? Number(settings.insuranceFloorDollars)
    : INSURANCE_FLOOR_DEFAULT;
  const armCents = Math.max(0, Math.round(armDollars * 100));
  let floorCents = Math.max(0, Math.round(floorDollars * 100));
  if (floorCents >= armCents) {
    floorCents = armCents >= 100 ? armCents - 100 : Math.max(0, armCents - 1);
  }
  return { armCents, floorCents };
}

/** Soft ceiling for the 20% win skim (cents). Fund may sit above via manual seed. */
function insuranceOverflowCents(settings = {}) {
  const dollars = Number.isFinite(Number(settings.insuranceOverflowDollars))
    ? Number(settings.insuranceOverflowDollars)
    : INSURANCE_OVERFLOW_DEFAULT;
  return Math.max(0, Math.round(dollars * 100));
}

/** Sticky ready: arm on ≥ arm, disarm below floor, else keep prior flag. */
function syncInsuranceReady(balanceCents, ready, armCents, floorCents) {
  const bal = Number(balanceCents) || 0;
  if (bal >= armCents) return true;
  if (bal < floorCents) return false;
  return !!ready;
}

/** Clamp config knobs so floor stays strictly below arm; normalize overflow. */
function normalizeInsuranceThresholds(config) {
  if (!config || typeof config !== 'object') return config;
  let arm = Number(config.insuranceCapDollars);
  let floor = Number(config.insuranceFloorDollars);
  let overflow = Number(config.insuranceOverflowDollars);
  if (!Number.isFinite(arm) || arm < 0) arm = INSURANCE_ARM_DEFAULT;
  if (!Number.isFinite(floor) || floor < 0) floor = INSURANCE_FLOOR_DEFAULT;
  if (!Number.isFinite(overflow) || overflow < 0) overflow = INSURANCE_OVERFLOW_DEFAULT;
  if (floor >= arm) {
    floor = arm >= 1 ? arm - 1 : 0;
  }
  // Overflow is a soft fill ceiling — keep it at least at arm so hysteresis still makes sense.
  if (overflow < arm) overflow = arm;
  config.insuranceCapDollars = arm;
  config.insuranceFloorDollars = floor;
  config.insuranceOverflowDollars = overflow;
  return config;
}

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
 * market already rejected. Call `checkPostStopPeerCascade` *before* this
 * bounce check so cascading peers block everyone first.
 *
 * Same-coin same-side also gets a short sit-out after stop (`sameSideCooldownMs`,
 * default 2m from `closedAt`) even when bounce + thesis would allow — stops the
 * stop→instant re-entry→stop loop. Cooldown is from closedAt only (not cleared
 * by session/max-age); peers / opposite side are unaffected.
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
  sameSideCooldownMs,
  now = Date.now(),
}) {
  const last = lastClosedForSymbol;
  // Gate uses the stopped trade's side (not necessarily the candidate side).
  if (!last || last.exitReason !== 'stop_loss') {
    return { ok: true };
  }

  // Same-side sit-out from closedAt — before session/max-age clear bounce gating.
  const cooldownMs =
    sameSideCooldownMs === undefined
      ? Math.round(POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES * 60 * 1000)
      : Number(sameSideCooldownMs);
  const sameSideCooldown = checkPostStopSameSideCooldown({
    lastStopTrade: last,
    forCandidateSymbol: forCandidateSymbol != null ? forCandidateSymbol : symbol || last.symbol,
    forCandidateSide: forCandidateSide != null ? forCandidateSide : side || last.side,
    cooldownMs,
    now,
  });
  if (!sameSideCooldown.ok) return sameSideCooldown;

  if (!recoveryCents || recoveryCents <= 0) return { ok: true };

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

/** Default / hard-max minutes for the peer-cascade calm gate (not full session). */
const PEER_CASCADE_DEFAULT_MINUTES = 3;
const PEER_CASCADE_HARD_MAX_MINUTES = 5;

/** Default minutes for post-stop max-1 concurrent open cap (then maxOpenPositions). */
const POST_STOP_MAX_ONE_DEFAULT_MINUTES = 1.5;

/** Default minutes for same-coin same-side sit-out after a stop (knife-catch delay). */
const POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES = 2;
/** Settle default is longer — late-bank knife-catch strings are especially toxic. */
const SETTLE_POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES = 5;

/**
 * How long after a stop the bot caps concurrent opens at 1 (even if
 * maxOpenPositions is higher). `postStopMaxOneMinutes: 0` disables the cap.
 * Unset/invalid → 1.5 minutes from the stop's closedAt (openedAt fallback).
 */
function postStopMaxOneAgeMs(config = {}) {
  const mins = Number(config.postStopMaxOneMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  return Math.round(POST_STOP_MAX_ONE_DEFAULT_MINUTES * 60 * 1000);
}

/**
 * Same-coin same-side sit-out after stop_loss (from closedAt). Blocks knife-catch
 * re-entry even when bounce + thesis would allow. `0` disables.
 * Settle mode: settlePostStopSameSideCooldownMinutes (default 5m) so a dump
 * cannot reopen the same side every few seconds. Edge: postStopSameSideCooldownMinutes (default 2m).
 */
function postStopSameSideCooldownMs(config = {}) {
  if (isSettleStrategyMode(config)) {
    const settleMins = Number(config.settlePostStopSameSideCooldownMinutes);
    if (Number.isFinite(settleMins) && settleMins <= 0) return 0;
    if (Number.isFinite(settleMins) && settleMins > 0) return Math.round(settleMins * 60 * 1000);
    return Math.round(SETTLE_POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES * 60 * 1000);
  }
  const mins = Number(config.postStopSameSideCooldownMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  return Math.round(POST_STOP_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES * 60 * 1000);
}

/**
 * Block same-symbol + same-side re-entry for `cooldownMs` after stop closedAt.
 * Peers and opposite side are unaffected. Missing closedAt fails open.
 */
function checkPostStopSameSideCooldown({
  lastStopTrade,
  forCandidateSymbol = null,
  forCandidateSide = null,
  cooldownMs = 0,
  now = Date.now(),
}) {
  return checkSameSideExitCooldown({
    lastTrade: lastStopTrade,
    exitReasons: ['stop_loss'],
    forCandidateSymbol,
    forCandidateSide,
    cooldownMs,
    now,
    reasonVerb: 'stopped',
  });
}

/**
 * Same-coin same-side sit-out after listed exit reasons (stop, settle_stale, …).
 * Blocks reopen churn (e.g. stale → reopen → stale in the same final minutes).
 */
function checkSameSideExitCooldown({
  lastTrade,
  exitReasons = ['stop_loss'],
  forCandidateSymbol = null,
  forCandidateSide = null,
  cooldownMs = 0,
  now = Date.now(),
  reasonVerb = 'exited',
}) {
  const maxMs = Number(cooldownMs);
  if (!Number.isFinite(maxMs) || maxMs <= 0) return { ok: true };
  if (!lastTrade || !exitReasons.includes(lastTrade.exitReason)) return { ok: true };

  const closedAt = Number(lastTrade.closedAt);
  if (!Number.isFinite(closedAt)) return { ok: true };

  const prevSym = String(lastTrade.symbol || '').toUpperCase();
  const candSym = String(forCandidateSymbol || '').toUpperCase();
  const prevSide = String(lastTrade.side || '').toLowerCase();
  const candSide = String(forCandidateSide || '').toLowerCase();
  if (!prevSym || !candSym || candSym !== prevSym || candSide !== prevSide) {
    return { ok: true };
  }

  if (Number(now) - closedAt >= maxMs) return { ok: true };

  const mins = maxMs / 60000;
  const minsLabel = Number.isInteger(mins) ? String(mins) : String(Math.round(mins * 10) / 10);
  const sideLabel = String(lastTrade.side || '').toUpperCase();
  const why = lastTrade.exitReason === 'stop_loss' ? 'stopped' : reasonVerb;
  return {
    ok: false,
    reason:
      `Waiting: ${lastTrade.symbol} ${sideLabel} ${why} (${lastTrade.exitReason}) — same-side sit-out ~${minsLabel}m ` +
      `before re-entry.`,
  };
}

/** Default minutes to sit out same side after settle_stale / settle take_profit. */
const SETTLE_POST_STALE_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES = 3;

/** Min time in trade before settle_stale may fire (avoids instant churn in final minutes). */
const SETTLE_STALE_MIN_HOLD_MS = 90_000;

/** Default: after this long parked near entry / small-green, bank or scratch (0 = off). */
const SETTLE_STUCK_HOLD_DEFAULT_MINUTES = 3;

function settleStuckHoldMs(config = {}) {
  const mins = Number(config.settleStuckHoldMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) {
    return Math.min(12, Math.max(1, mins)) * 60 * 1000;
  }
  return SETTLE_STUCK_HOLD_DEFAULT_MINUTES * 60 * 1000;
}

function settlePostStaleSameSideCooldownMs(config = {}) {
  const mins = Number(config.settlePostStaleSameSideCooldownMinutes);
  if (Number.isFinite(mins) && mins <= 0) return 0;
  if (Number.isFinite(mins) && mins > 0) return Math.round(mins * 60 * 1000);
  return Math.round(SETTLE_POST_STALE_SAME_SIDE_COOLDOWN_DEFAULT_MINUTES * 60 * 1000);
}

/**
 * True while the latest closed trade is a stop_loss and we are still inside
 * the post-stop max-1 window. Missing timestamps fail open (no sticky cap).
 */
function isPostStopMaxOneActive(lastStopTrade, config = {}, now = Date.now()) {
  if (!lastStopTrade || lastStopTrade.exitReason !== 'stop_loss') return false;
  const maxAgeMs = postStopMaxOneAgeMs(config);
  if (maxAgeMs <= 0) return false;
  const ref = stopTradeReferenceMs(lastStopTrade);
  if (!Number.isFinite(ref)) return false;
  return now - ref < maxAgeMs;
}

/**
 * Peer-cascade calm gate must always age out quickly (shorter than bounce recovery).
 * Optional `peerCascadeMaxMinutes`; else min(stopRecoveryMaxMinutes, 3), default 3.
 * Always clamped to a hard max of 5 minutes — never a sticky full-window freeze.
 * Unlike bounce recovery, 0 / unset recovery max does NOT disable this cap.
 */
function peerCascadeMaxAgeMs(config = {}) {
  const dedicated = Number(config.peerCascadeMaxMinutes);
  let mins;
  if (Number.isFinite(dedicated) && dedicated > 0) {
    mins = dedicated;
  } else {
    const recoveryMins = Number(config.stopRecoveryMaxMinutes);
    if (Number.isFinite(recoveryMins) && recoveryMins > 0) {
      mins = Math.min(recoveryMins, PEER_CASCADE_DEFAULT_MINUTES);
    } else {
      mins = PEER_CASCADE_DEFAULT_MINUTES;
    }
  }
  mins = Math.min(Math.max(mins, 0.1), PEER_CASCADE_HARD_MAX_MINUTES);
  return Math.round(mins * 60 * 1000);
}

/** Stop timestamp for age gates — prefer closedAt, fall back to openedAt. */
function stopTradeReferenceMs(trade) {
  if (!trade) return NaN;
  const closed = Number(trade.closedAt);
  if (Number.isFinite(closed) && closed > 0) return closed;
  const opened = Number(trade.openedAt);
  if (Number.isFinite(opened) && opened > 0) return opened;
  return NaN;
}

/**
 * After a stop-loss, cryptos often cascade / whipsaw. Block ALL new entries
 * (any side, any coin) briefly while a majority of peer short windows are
 * still moving against the side that just stopped — same-window protection.
 *
 * Clears when: peers calm, stopped trade's session ends, or max age elapses
 * (default 3m, hard max 5m). Missing timestamps fail open so this cannot
 * freeze forever. Call before bounce recovery so cascading peers block
 * everyone even when the stopped coin has not bounced yet.
 */
function checkPostStopPeerCascade({
  lastStopTrade,
  candidateSide, // kept for API compat; gates apply regardless of side
  predictions,
  seriesBySymbol,
  minConfidence = 50,
  maxAgeMs = peerCascadeMaxAgeMs(),
  now = Date.now(),
}) {
  if (!lastStopTrade || lastStopTrade.exitReason !== 'stop_loss') return { ok: true };
  void candidateSide;

  if (isPostStopRecoverySessionExpired(lastStopTrade, now)) {
    return { ok: true };
  }

  const ageCap = Number(maxAgeMs);
  const requestedAgeCap =
    Number.isFinite(ageCap) && ageCap > 0 ? ageCap : peerCascadeMaxAgeMs();
  // Never let callers stretch cascade beyond the hard max (sticky freezes).
  const effectiveAgeCap = Math.min(
    requestedAgeCap,
    PEER_CASCADE_HARD_MAX_MINUTES * 60 * 1000
  );
  const stoppedAt = stopTradeReferenceMs(lastStopTrade);
  if (!Number.isFinite(stoppedAt)) {
    // No closedAt/openedAt — cannot bound the wait; fail open.
    return { ok: true };
  }
  const ageMs = Number(now) - stoppedAt;
  if (ageMs >= effectiveAgeCap) {
    return { ok: true };
  }

  if (!predictions || !seriesBySymbol) return { ok: true };

  const stoppedSym = lastStopTrade.symbol;
  const stopSide = String(lastStopTrade.side || '').toUpperCase();
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
    const remainMin = Math.max(1, Math.ceil((effectiveAgeCap - ageMs) / 60000));
    return {
      ok: false,
      reason:
        `Waiting: after ${stoppedSym} ${stopSide} stop — peers still cascading (same window); ` +
        `no new entries until calm, session end, or ~${remainMin}m max.`,
    };
  }
  return { ok: true };
}

/**
 * Profit split for skimMode === 'insurance':
 *   40% → Personal Wallet (locked paycheck)
 *   20% → Insurance Fund (builds until insuranceOverflowDollars soft ceiling)
 *   40% → Active Bankroll (Available Cash)
 * Soft overflow: while fund ≥ overflow, the 20% skim stays in Available instead
 * (wallet still 40%). Partial fills up to the ceiling; remainder → Available.
 * Fund does not auto-empty at the ceiling — it stays as cushion.
 * Losses: sticky hysteresis — arm at insuranceCapDollars ($10), stay usable
 *         down to insuranceFloorDollars ($6). Absorb only while insuranceReady;
 *         below floor, disarm until balance ≥ arm again.
 */
function applyProfitBuckets({
  pnlCents,
  reserveCents = 0,
  insuranceCents = 0,
  insuranceReady = false,
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
    insuranceReady: !!insuranceReady,
  };

  const { armCents, floorCents } = insuranceArmFloorCents(settings);
  const overflowCapCents = insuranceOverflowCents(settings);

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

  let ready = syncInsuranceReady(nextInsurance, !!insuranceReady, armCents, floorCents);

  if (pnl < 0) {
    // Absorb uses sticky ready (not balance >= arm), so $7–$9.99 still pays.
    if (ready && nextInsurance > 0) {
      const loss = -pnl;
      const drawn = Math.min(nextInsurance, loss);
      nextInsurance -= drawn;
      out.insuranceDrawnCents = drawn;
      out.insuranceCents = nextInsurance;
    }
    out.insuranceReady = syncInsuranceReady(nextInsurance, ready, armCents, floorCents);
    return out;
  }
  if (pnl === 0) {
    out.insuranceReady = ready;
    return out;
  }

  const wallet = Math.round(pnl * 0.4);
  // Take up to 20% into insurance when rebuilding, stopping at the soft overflow
  // ceiling. Arm threshold does not clip contributions; overflow does.
  // Remainder of the 20% stays in Available (not wallet).
  const desiredAdd = rebuildInsurance ? Math.round(pnl * 0.2) : 0;
  const room = Math.max(0, overflowCapCents - nextInsurance);
  const insuranceAdd = Math.min(desiredAdd, room);
  const overflowAdd = desiredAdd - insuranceAdd;
  nextInsurance += insuranceAdd;

  out.skimmedCents = wallet;
  out.insuranceAddedCents = insuranceAdd;
  out.insuranceOverflowCents = overflowAdd;
  out.reserveCents = nextReserve + wallet;
  out.insuranceCents = nextInsurance;
  out.insuranceReady = syncInsuranceReady(nextInsurance, ready, armCents, floorCents);
  return out;
}

const EDITABLE_STRING_FIELDS = {
  symbol: (v) => (v === 'AUTO' || isKalshiTradeEnabled(v) ? v : null),
  strategyMode: (v) => (['edge', 'settle'].includes(String(v || '').toLowerCase()) ? String(v).toLowerCase() : null),
  settleTieredExits: (v) => {
    if (v === true || v === 1) return 'on';
    if (v === false || v === 0) return 'off';
    const s = String(v || '').toLowerCase();
    if (s === 'on' || s === 'true' || s === 'yes') return 'on';
    if (s === 'off' || s === 'false' || s === 'no') return 'off';
    return null;
  },
  halfStakeNear: (v) => {
    if (v === true || v === 1) return 'on';
    if (v === false || v === 0) return 'off';
    const s = String(v || '').toLowerCase();
    if (s === 'on' || s === 'true' || s === 'yes') return 'on';
    if (s === 'off' || s === 'false' || s === 'no') return 'off';
    return null;
  },
  secondOpenRequiresGreen: (v) => {
    if (v === true || v === 1) return 'on';
    if (v === false || v === 0) return 'off';
    const s = String(v || '').toLowerCase();
    if (s === 'on' || s === 'true' || s === 'yes') return 'on';
    if (s === 'off' || s === 'false' || s === 'no') return 'off';
    return null;
  },
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
      if (data.insuranceDepositedCents == null) data.insuranceDepositedCents = 0;
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
    insuranceDepositedCents: 0,
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
      // 'edge' = prediction edge vs Kalshi; 'settle' = buy 85–90¢ and hold to settlement.
      strategyMode: 'edge',
      edgeThresholdPct: 1, // minimum probability-point edge vs Kalshi to bother trading
      minConfidence: 55, // engine confidence (0-100) required to act
      stopLossCents: 23, // exit if held bid falls this many cents below entry
      takeProfitCents: 15, // exit if held bid rises this many cents above entry (see final-5 override)
      nearCertainExitCents: 97, // if held bid reaches this, bank it — don't wait on settlement for the last few ¢
      minEntryCents: 40, // never buy a side cheaper than this — blocks longshot lottery tickets
      minMinutesToOpen: 3, // don't open when fewer than this many minutes remain in the window
      // After stop-loss: require this many ¢ of bid bounce before re-entry (0 = off).
      // Null/unset uses stopRecoveryCentsRequired() (~40% of stop, min 5¢).
      stopRecoveryCents: 6,
      // Clear the whole post-stop recovery gate this many minutes after the stop
      // (even if the bid never bounced). 0 = never expire by age. Default 15.
      stopRecoveryMaxMinutes: 15,
      // Peer-cascade calm gate max wait (minutes). Short post-stop protection;
      // default 3, hard-clamped to 5 — never a sticky full-session freeze.
      peerCascadeMaxMinutes: 3,
      // After a stop, cap concurrent opens at 1 for this many minutes (from
      // closedAt), then normal maxOpenPositions applies. 0 = disable max-1.
      postStopMaxOneMinutes: 1.5,
      // Same-coin same-side sit-out after stop_loss (from closedAt), even when
      // bounce + thesis would allow knife-catch. 0 = off. Default 2 minutes.
      postStopSameSideCooldownMinutes: 2,
      // Settle strategy: buy ask in [min,max]¢; tiered target/stale exit by entry
      // (see settleExitPlan), else hold to official settlement.
      settleEntryMinCents: 85,
      settleEntryMaxCents: 92, // keep mid-band; min upside filter is separate (8¢)
      // Wide vs 8¢: Kalshi mid-band often wicks 10–15¢ without thesis death.
      settleStopLossCents: 20,
      // Reject asks with less upside to 100 than this. Independent of stop. 0 = off.
      settleMinUpsideCents: 8,
      settleMinMinutesToOpen: 0.5, // still need a little time; 0 = allow until last seconds
      settleMaxMinutesToOpen: 12, // late-ish windows (was 8 — early 85¢ quotes looked stuck)
      // Settle same-side sit-out after stop (longer than Edge — prevents SOL-style loops).
      settlePostStopSameSideCooldownMinutes: 5,
      // After settle_stale / settle TP: don't reopen same coin+side for a few minutes.
      settlePostStaleSameSideCooldownMinutes: 3,
      // Late fallback: if nothing in primary band and ≤ this many min left, allow down to late min.
      settleLateEntryMinutes: 3.5,
      settleLateEntryMinCents: 70,
      // Entry-tiered TP/stale (settleExitPlan). 'off' = stop + hold to settlement only.
      settleTieredExits: 'on',
      // After this many minutes parked flat (±1¢) or small-green (+2..+5¢ under target), exit.
      // 0 = off. Does not apply to ≥90¢ hold-to-settle tier.
      settleStuckHoldMinutes: 3,
      // AUTO settle: prefer asks below this before 94¢+ “almost certain” tickets.
      settleRichAskFloorCents: 94,
      stakeDollars: 10, // how much money to risk per trade; contracts are computed from this at entry time
      // Settle NEAR only: risk half stake (thinner book / choppier). Other coins full size.
      halfStakeNear: 'on',
      stakingStrategy: 'fixed', // 'fixed' | 'halve-after-win' — see _computeNextStake for the logic
      maxOpenPositions: 2,
      // With ≥1 open: only allow another if an existing hold is green (bid ≥ entry).
      secondOpenRequiresGreen: 'on',
      skimMode: 'insurance', // 'insurance' | 'percent' | 'fixed' | 'off'
      skimPercent: 50, // used when skimMode === 'percent'
      skimFixedDollars: 5, // used when skimMode === 'fixed'
      // Insurance fund (skimMode === 'insurance'): 20% fund / 40% wallet / 40% bankroll
      // Hysteresis: arm at insuranceCapDollars, stay usable down to insuranceFloorDollars.
      // Soft fill ceiling: insuranceOverflowDollars — excess 20% skim → Available.
      insuranceCapDollars: INSURANCE_ARM_DEFAULT,
      insuranceFloorDollars: INSURANCE_FLOOR_DEFAULT,
      insuranceOverflowDollars: INSURANCE_OVERFLOW_DEFAULT,
      paperStartingBalanceDollars: 100, // trading bankroll (also the capital backing paper trades)
      mode: 'paper', // 'paper' | 'live'
      liveAuthorized: false,
      ...config,
      ...loadConfigOverrides(), // saved runtime edits win over env/defaults, except `mode`/`liveAuthorized`
    };
    normalizeInsuranceThresholds(this.config);
    if (this.config.symbol !== 'AUTO' && !isKalshiTradeEnabled(this.config.symbol)) {
      console.warn(
        `[bot] ${this.config.symbol} is opted out of trading — switching symbol to AUTO`
      );
      this.config.symbol = 'AUTO';
    }
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
    // Symbol → timestamp until which we demote after a live entry fill miss
    // (try other cryptos first, then allow retry).
    this._entryMissUntil = Object.create(null);
    const runState = loadRunState();
    this.isRunning = runState.isRunning !== false;
    this.runningSince = this.isRunning ? (Number(runState.runningSince) || Date.now()) : null;
    this.liveBalanceCents = null;
    this.livePortfolioValueCents = null;
    this.liveBalanceUpdatedAt = null;
    // Last post-stop protection gate logged to activity (dedupe poll spam).
    this._lastProtectionGateKey = null;
    this._lastProtectionGateSymbol = null;
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
    normalizeInsuranceThresholds(this.config);
    if (applied.insuranceCapDollars != null) applied.insuranceCapDollars = this.config.insuranceCapDollars;
    if (applied.insuranceFloorDollars != null) applied.insuranceFloorDollars = this.config.insuranceFloorDollars;
    if (applied.insuranceOverflowDollars != null) {
      applied.insuranceOverflowDollars = this.config.insuranceOverflowDollars;
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
      insuranceDepositedCents: 0,
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

  /**
   * External seed / top-up into the Insurance Fund (user's own money).
   * Does not pull from Available or Wallet — credits insurance + deposited capital
   * so Available and Net P&L stay honest while Total Equity rises by the deposit.
   */
  depositInsurance(dollars) {
    const amount = Number(dollars);
    if (!Number.isFinite(amount) || amount <= 0) {
      return { ok: false, message: 'Deposit amount must be a positive number of dollars.' };
    }
    if (amount > 500) {
      return { ok: false, message: 'Max $500 per deposit. Split larger seeds into multiple adds.' };
    }
    const cents = Math.round(amount * 100);
    if (cents < 1) {
      return { ok: false, message: 'Amount rounds to less than 1¢.' };
    }

    this.ledger.insuranceCents = (Number(this.ledger.insuranceCents) || 0) + cents;
    this.ledger.insuranceDepositedCents = (Number(this.ledger.insuranceDepositedCents) || 0) + cents;

    const { armCents, floorCents } = insuranceArmFloorCents(this.config);
    this.ledger.insuranceReady = syncInsuranceReady(
      this.ledger.insuranceCents,
      !!this.ledger.insuranceReady,
      armCents,
      floorCents
    );

    const msg = `Insurance seeded +$${(cents / 100).toFixed(2)} (manual).`;
    this.lastDecision = msg;
    this._logActivity(msg, { kind: 'insurance', pnlCents: cents });
    this._persist();

    return {
      ok: true,
      message: msg,
      insuranceCents: this.ledger.insuranceCents,
      insuranceDepositedCents: this.ledger.insuranceDepositedCents,
      insuranceReady: !!this.ledger.insuranceReady,
      capital: this._capitalStatus(),
    };
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

  /** True when lastDecision is a post-stop protection wait (cascade / bounce / etc.). */
  _isProtectionGateReason(message) {
    const s = String(message || '');
    if (!/^Waiting:/i.test(s)) return false;
    return /peers still cascading|bounce|knife-catch|same-side sit-out|max 1 open until post-stop|same-window cascade protection|after \S+ .+ stop/i.test(
      s
    );
  }

  _protectionGateKey(message) {
    const s = String(message || '');
    if (/peers still cascading/i.test(s)) return 'peer-cascade';
    if (/same-side sit-out/i.test(s)) return 'same-side-cooldown';
    if (/knife-catch/i.test(s)) return 'knife-catch';
    if (/max 1 open until post-stop/i.test(s)) return 'post-stop-max1';
    if (/bounce|need .+ bid\s*≥|need .+ bid >=/i.test(s)) return 'stop-recovery';
    if (/after \S+ .+ stop/i.test(s)) return 'post-stop-gate';
    return 'post-stop-gate';
  }

  _protectionGateLabel(key) {
    switch (key) {
      case 'peer-cascade':
        return 'peer-cascade';
      case 'stop-recovery':
        return 'stop-recovery';
      case 'knife-catch':
        return 'knife-catch';
      case 'same-side-cooldown':
        return 'same-side-cooldown';
      case 'post-stop-max1':
        return 'post-stop max-1';
      default:
        return 'post-stop protection';
    }
  }

  /** Gates that only block one coin/side — other coins must not "clear" them. */
  _isSymbolScopedProtectionGate(key) {
    return (
      key === 'same-side-cooldown' ||
      key === 'stop-recovery' ||
      key === 'knife-catch'
    );
  }

  /**
   * Log protection gate use/clear once per transition (not every cycle).
   * Pass the Waiting reason when blocked; null to clear+announce; false to clear silently.
   * For symbol-scoped gates, pass `{ fromSymbol }` so another coin's pass doesn't
   * spam "cleared" every 5s while e.g. HYPE is still in same-side sit-out.
   */
  _noteProtectionGate(reasonOrNull, { fromSymbol = null } = {}) {
    if (reasonOrNull === false) {
      this._lastProtectionGateKey = null;
      this._lastProtectionGateSymbol = null;
      return;
    }
    const sym = fromSymbol ? String(fromSymbol).toUpperCase() : null;
    const reason = reasonOrNull == null ? '' : String(reasonOrNull);
    if (this._isProtectionGateReason(reason)) {
      const key = this._protectionGateKey(reason);
      if (
        key === this._lastProtectionGateKey &&
        (!this._isSymbolScopedProtectionGate(key) ||
          sym == null ||
          sym === this._lastProtectionGateSymbol)
      ) {
        return;
      }
      this._lastProtectionGateKey = key;
      this._lastProtectionGateSymbol = this._isSymbolScopedProtectionGate(key) ? sym : null;
      const label = this._protectionGateLabel(key);
      this._logActivity(`Protection used (${label}): ${reason}`, { kind: 'gate' });
      this._persist();
      return;
    }
    if (!this._lastProtectionGateKey) return;
    // Symbol-scoped: only the blocked coin clearing (or a silent open) may announce clear.
    if (
      this._isSymbolScopedProtectionGate(this._lastProtectionGateKey) &&
      this._lastProtectionGateSymbol &&
      sym &&
      sym !== this._lastProtectionGateSymbol
    ) {
      return;
    }
    const label = this._protectionGateLabel(this._lastProtectionGateKey);
    this._lastProtectionGateKey = null;
    this._lastProtectionGateSymbol = null;
    this._logActivity(`Protection cleared (${label}) — entries allowed again.`, { kind: 'gate' });
    this._persist();
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
    const insuranceDepositedCents = this.ledger.insuranceDepositedCents || 0;
    // External insurance seeds expand total capital so Available is not diluted.
    const paperTotalCents = startingCents + closedPnlCents + insuranceDepositedCents;
    return {
      startingCents,
      paperTotalCents,
      reserveCents,
      insuranceCents,
      insuranceDepositedCents,
      insuranceCapCents: insuranceArmFloorCents(this.config).armCents,
      insuranceFloorCents: insuranceArmFloorCents(this.config).floorCents,
      insuranceOverflowCents: insuranceOverflowCents(this.config),
      insuranceReady: !!this.ledger.insuranceReady,
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

  /**
   * Stake for this settle entry. NEAR uses ½ stake when halfStakeNear is on
   * (thinner / choppier). All other coins use full stake. Edge mode: always full.
   */
  _stakeDollarsForEntry(priceCents, { settle = false, symbol = null } = {}) {
    const base = Number(this._computeNextStake());
    const safeBase = Number.isFinite(base) && base > 0 ? base : Number(this.config.stakeDollars) || 10;
    if (!settle) return safeBase;
    const nearHalf = String(this.config.halfStakeNear == null ? 'on' : this.config.halfStakeNear).toLowerCase();
    const nearHalfOn = !(nearHalf === 'off' || nearHalf === 'false' || nearHalf === '0' || nearHalf === 'no');
    if (nearHalfOn && String(symbol || '').toUpperCase() === 'NEAR') {
      return Math.max(0.5, +(safeBase / 2).toFixed(2));
    }
    return safeBase;
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
   * Wins (insurance mode): 40% Wallet + 20% Insurance + 40% bankroll on every
   * win from the start, until the soft overflow ceiling ($15). Excess 20% →
   * Available. Arm at $10 (sticky ready); stay usable down to $6 floor.
   * Until armed, losses hit Available; while ready, Insurance absorbs first.
   */
  _applyReserveFlow(trade) {
    const pnlCents = Number(trade.pnlCents) || 0;

    const flow = applyProfitBuckets({
      pnlCents,
      reserveCents: this.ledger.reserveCents || 0,
      insuranceCents: this.ledger.insuranceCents || 0,
      insuranceReady: !!this.ledger.insuranceReady,
      settings: this.config,
      rebuildInsurance: true, // keep building until soft overflow ceiling
    });
    this.ledger.reserveCents = flow.reserveCents;
    this.ledger.insuranceCents = flow.insuranceCents;
    this.ledger.insuranceReady = !!flow.insuranceReady;
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

  _parseFpCount(raw) {
    if (raw == null || raw === '') return null;
    const n = Number.parseFloat(raw);
    if (!Number.isFinite(n) || n < 0) return null;
    return Math.floor(n);
  }

  _orderFillCount(order) {
    if (!order || typeof order !== 'object') return 0;
    // Prefer Kalshi's canonical fixed-point fields, then legacy integer / alias names.
    // Create Order V2 uses `fill_count`; Get Order uses `fill_count_fp`.
    // Do not treat 0 as "missing" — only skip null/undefined/''.
    const candidates = [
      order.fill_count_fp,
      order.fillCountFp,
      order.fills_count_fp,
      order.fillsCountFp,
      order.fill_count,
      order.fillCount,
      order.fills_count,
      order.fillsCount,
      order.filled_count,
      order.filledCount,
      order.quantity_filled,
      order.quantityFilled,
    ];
    for (const raw of candidates) {
      const n = this._parseFpCount(raw);
      if (n != null) return n;
    }
    // Fallback: initial − remaining when fill_* was omitted entirely.
    const initial = this._parseFpCount(
      order.initial_count_fp ??
        order.initialCountFp ??
        order.initial_count ??
        order.initialCount
    );
    const remaining = this._parseFpCount(
      order.remaining_count_fp ??
        order.remainingCountFp ??
        order.remaining_count ??
        order.remainingCount
    );
    if (initial != null && remaining != null && initial >= remaining) {
      return initial - remaining;
    }
    return 0;
  }

  _unwrapOrderPayload(data) {
    if (!data || typeof data !== 'object') return null;
    if (data.order && typeof data.order === 'object') return data.order;
    if (Array.isArray(data.orders) && data.orders[0] && typeof data.orders[0] === 'object') {
      return data.orders[0];
    }
    return data;
  }

  _extractOrderId(payload) {
    const order = this._unwrapOrderPayload(payload) || payload;
    if (!order || typeof order !== 'object') return null;
    return (
      order.order_id ||
      order.orderId ||
      (payload && payload.order_id) ||
      (payload && payload.orderId) ||
      null
    );
  }

  _inferOrderBookSide(order, heldSide, action) {
    const raw = String(order?.side ?? order?.book_side ?? order?.bookSide ?? '').toLowerCase();
    if (raw === 'bid' || raw === 'ask') return raw;
    if (heldSide && action) {
      try {
        return bookSideFromLegacy(heldSide, action);
      } catch {
        /* fall through */
      }
    }
    return null;
  }

  /**
   * Pick raw vs 100-raw for held-outcome cents when Kalshi's average_fill_price
   * is ambiguous (sometimes YES dollars, sometimes the complement). Prefer the
   * candidate closer to a known intended limit (sell/buy price).
   */
  _disambiguateFillCents(rawCents, intendedPriceCents) {
    const clampCents = (c) => Math.max(1, Math.min(99, Math.round(c)));
    const raw = clampCents(rawCents);
    const intended = Math.round(Number(intendedPriceCents));
    if (!Number.isFinite(intended) || intended < 1 || intended > 99) return raw;
    const complement = clampCents(100 - raw);
    const rawDist = Math.abs(raw - intended);
    const compDist = Math.abs(complement - intended);
    return compDist < rawDist ? complement : raw;
  }

  /**
   * Kalshi fees on an order, in cents (taker + maker, or V2 average_fee_paid × fills).
   */
  _orderFeesCents(order) {
    if (!order || typeof order !== 'object') return 0;
    const taker = Number.parseFloat(
      order.taker_fees_dollars ?? order.takerFeesDollars ?? NaN
    );
    const maker = Number.parseFloat(
      order.maker_fees_dollars ?? order.makerFeesDollars ?? NaN
    );
    let fees = 0;
    if (Number.isFinite(taker) && taker > 0) fees += taker;
    if (Number.isFinite(maker) && maker > 0) fees += maker;
    if (fees > 0) return Math.max(0, Math.round(fees * 100));

    const avgFee = Number.parseFloat(
      order.average_fee_paid ?? order.averageFeePaid ?? NaN
    );
    const filled = this._orderFillCount(order);
    if (Number.isFinite(avgFee) && avgFee > 0 && filled > 0) {
      return Math.max(0, Math.round(avgFee * filled * 100));
    }
    return 0;
  }

  /**
   * Trade PnL in cents: (exit − entry) × contracts.
   * Matches Kalshi's trade PnL (price improvement included). Fees are tracked
   * separately for the activity note — do not subtract here (v1.2.29 fee-aware
   * netting under-reported real wins vs Kalshi, e.g. ETH $3.42 vs $4.57).
   * entryFeesCents / exitFeesCents kept for call-site compat; ignored.
   */
  _netPnlCents(entryCents, exitCents, contracts, _entryFeesCents = 0, _exitFeesCents = 0) {
    const n = Math.max(0, Math.floor(Number(contracts) || 0));
    const entry = Number(entryCents) || 0;
    const exit = Number(exitCents) || 0;
    return (exit - entry) * n;
  }

  /**
   * Average fill price for the held outcome (YES/NO cents).
   * Prefer average_fill_price (limit-disambiguated). Fill-cost dollars are a
   * fallback only when avg is missing — and only when the implied cents agree
   * with the intended limit (~10¢). Preferring cost first caused:
   *   - XRP false +$10: taker_fill_cost_dollars="0.00" on maker buys → 1¢ entry
   *   - ETH under-count: cost near the limit hid average_fill_price improvement
   */
  _orderAvgFillPriceCents(order, heldSide, action, intendedPriceCents = null) {
    if (!order) return null;
    const filled = this._orderFillCount(order);
    const clampCents = (c) => Math.max(1, Math.min(99, Math.round(c)));

    const avgDollars = Number.parseFloat(
      order.average_fill_price ?? order.averageFillPrice ?? NaN
    );
    if (Number.isFinite(avgDollars) && avgDollars > 0) {
      return this._disambiguateFillCents(avgDollars * 100, intendedPriceCents);
    }

    // Fallback: sum taker+maker fill cost (skip zero — maker fills often send
    // taker_fill_cost_dollars="0.00", which must not become 1¢).
    let costDollars = 0;
    let hasPositiveCost = false;
    for (const raw of [
      order.taker_fill_cost_dollars ?? order.takerFillCostDollars,
      order.maker_fill_cost_dollars ?? order.makerFillCostDollars,
    ]) {
      const n = Number.parseFloat(raw ?? NaN);
      if (Number.isFinite(n) && n > 0) {
        costDollars += n;
        hasPositiveCost = true;
      }
    }
    if (hasPositiveCost && filled > 0) {
      const costCents = clampCents((costDollars * 100) / filled);
      const intended = Math.round(Number(intendedPriceCents));
      if (Number.isFinite(intended) && intended >= 1 && intended <= 99) {
        if (Math.abs(costCents - intended) > 10) {
          // Misleading cost with no average_fill_price — refuse rather than
          // invent a far-from-limit price (XRP-style blowups).
          return null;
        }
      }
      return costCents;
    }

    const yesDollars = Number.parseFloat(order.yes_price_dollars ?? order.yesPriceDollars ?? NaN);
    const noDollars = Number.parseFloat(order.no_price_dollars ?? order.noPriceDollars ?? NaN);
    if (heldSide === 'yes' && Number.isFinite(yesDollars)) {
      return clampCents(yesDollars * 100);
    }
    if (heldSide === 'no' && Number.isFinite(noDollars)) {
      return clampCents(noDollars * 100);
    }
    const yes = Number(order.yes_price ?? order.yesPrice);
    const no = Number(order.no_price ?? order.noPrice);
    if (heldSide === 'yes' && Number.isFinite(yes) && yes > 0) return clampCents(yes);
    if (heldSide === 'no' && Number.isFinite(no) && no > 0) return clampCents(no);
    return null;
  }

  /**
   * Guard buy fill cents vs the limit we sent. A far-below-limit avg (e.g. 59¢
   * after buying at 81¢+) is almost always a parse/complement glitch — keep the limit.
   */
  _sanityCheckEntryFillCents(fillCents, limitCents) {
    const fill = Math.round(Number(fillCents));
    const limit = Math.round(Number(limitCents));
    if (!Number.isFinite(fill) || !Number.isFinite(limit) || limit < 1 || limit > 99) {
      return fillCents;
    }
    if (fill >= 1 && fill <= 99 && Math.abs(fill - limit) <= 12) return fill;
    const complement = Math.max(1, Math.min(99, 100 - fill));
    if (Math.abs(complement - limit) < Math.abs(fill - limit)) {
      console.warn(
        `[bot] entry fill ${fill}¢ looks like complement mis-parse (limit ${limit}¢) — using ${complement}¢`
      );
      return complement;
    }
    if (Math.abs(fill - limit) > 12) {
      console.warn(
        `[bot] entry fill ${fill}¢ far from buy limit ${limit}¢ — using limit`
      );
      return limit;
    }
    return fill;
  }

  /**
   * Guard against average_fill_price complement mis-parse on exits.
   * Stop: exit >> entry while sellLimit <= entry → closer-to-limit interpretation.
   * TP / bank / near-certain: exit << entry while sellLimit >= entry → reject bad parse.
   */
  _sanityCheckExitFillCents(exitPx, sellPriceCents, entryPriceCents, reason) {
    const exit = Math.round(Number(exitPx));
    const sellLimit = Math.round(Number(sellPriceCents));
    const entry = Math.round(Number(entryPriceCents));
    if (!Number.isFinite(exit) || !Number.isFinite(sellLimit) || !Number.isFinite(entry)) {
      return exitPx;
    }

    const closerToLimit = () => {
      const complement = Math.max(1, Math.min(99, 100 - exit));
      const exitDist = Math.abs(exit - sellLimit);
      const compDist = Math.abs(complement - sellLimit);
      const chosen = compDist < exitDist ? complement : sellLimit;
      return chosen;
    };

    const profitReasons = new Set(['take_profit', 'pre_close_bank', 'near_certain', 'settle_stale', 'settle_stuck']);
    if (profitReasons.has(reason)) {
      const impliedLoss = entry - exit;
      if (impliedLoss > 15 && sellLimit >= entry) {
        const fixed = closerToLimit();
        console.warn(
          `[bot] exit fill ${exit}¢ looks like fill-price mis-parse on ${reason} ` +
            `(entry ${entry}¢, sell limit ${sellLimit}¢) — using ${fixed}¢`
        );
        return fixed;
      }
      return exit;
    }

    if (reason === 'stop_loss') {
      const impliedGain = exit - entry;
      if (impliedGain > 15 && sellLimit <= entry) {
        const fixed = closerToLimit();
        console.warn(
          `[bot] exit fill ${exit}¢ looks like fill-price mis-parse on stop_loss ` +
            `(entry ${entry}¢, sell limit ${sellLimit}¢) — using ${fixed}¢`
        );
        return fixed;
      }
    }
    return exit;
  }

  async _fetchOrderSnapshot(orderId) {
    const data = await this.client.getOrder(orderId);
    return this._unwrapOrderPayload(data);
  }

  /**
   * After cancel/timeout, keep re-fetching briefly so a late-matching fill
   * (or a cancel that raced an execution) still lands in the ledger.
   */
  async _recoverOrderFillsAfterCancel(orderId, { priorOrder = null, attempts = 3, delayMs = 400 } = {}) {
    let bestOrder = priorOrder;
    let bestFilled = this._orderFillCount(priorOrder);
    for (let i = 0; i < attempts; i += 1) {
      try {
        const snap = await this._fetchOrderSnapshot(orderId);
        if (snap) {
          const filled = this._orderFillCount(snap);
          if (filled > bestFilled || !bestOrder) {
            bestOrder = snap;
            bestFilled = filled;
          }
          const status = String(snap.status || '').toLowerCase();
          if (
            filled > 0 ||
            status === 'canceled' ||
            status === 'cancelled' ||
            status === 'executed' ||
            status === 'filled' ||
            status === 'complete' ||
            status === 'completed'
          ) {
            // Still take one more peek when empty+canceled so a post-cancel
            // fill_count update can land; otherwise stop early when filled.
            if (filled > 0 || i === attempts - 1) break;
          }
        }
      } catch (err) {
        console.warn(`[bot] getOrder ${orderId} post-cancel recovery failed:`, err.message);
      }
      if (i < attempts - 1) await this._sleep(delayMs);
    }
    if (bestFilled > 0 && this._orderFillCount(priorOrder) < bestFilled) {
      console.warn(
        `[bot] fill recovery: order ${orderId} shows ${bestFilled} filled after cancel/timeout ` +
          `(was ${this._orderFillCount(priorOrder)}) — will ledger the fill`
      );
    } else if (bestFilled > 0 && !priorOrder) {
      console.warn(
        `[bot] fill recovery: order ${orderId} shows ${bestFilled} filled after cancel/timeout — will ledger the fill`
      );
    }
    return { filled: bestFilled, order: bestOrder };
  }

  /**
   * Poll Kalshi until the order is filled enough, or give up and cancel.
   * Always re-checks fills after cancel so a race cannot orphan Kalshi inventory.
   * Returns { ok, filled, avgPriceCents, order, recovered }.
   */
  async _awaitOrderFill(
    orderId,
    { minFill = 1, attempts = 6, delayMs = 350, seedOrder = null, heldSide = null, action = null } = {}
  ) {
    let lastOrder = seedOrder ? this._unwrapOrderPayload(seedOrder) || seedOrder : null;
    let bestFilled = this._orderFillCount(lastOrder);
    if (bestFilled >= minFill && lastOrder) {
      return {
        ok: true,
        filled: bestFilled,
        avgPriceCents: this._orderAvgFillPriceCents(lastOrder, heldSide, action),
        order: lastOrder,
        recovered: false,
      };
    }

    for (let i = 0; i < attempts; i += 1) {
      try {
        const snap = await this._fetchOrderSnapshot(orderId);
        if (snap) {
          lastOrder = snap;
          const status = String(lastOrder.status || '').toLowerCase();
          const filled = this._orderFillCount(lastOrder);
          if (filled > bestFilled) bestFilled = filled;
          // Never invent a fill count from status alone — that desyncs the ledger
          // from Kalshi inventory when fill_* fields are missing or misnamed.
          if (filled >= minFill) {
            return {
              ok: true,
              filled,
              avgPriceCents: this._orderAvgFillPriceCents(lastOrder, heldSide, action),
              order: lastOrder,
              recovered: false,
            };
          }
          if (status === 'canceled' || status === 'cancelled') {
            // Terminal cancel (not necessarily ours): still treat any partial
            // fills as inventory we own. Not a "recovery" unless we timed out.
            return {
              ok: filled >= minFill,
              filled,
              avgPriceCents: this._orderAvgFillPriceCents(lastOrder, heldSide, action),
              order: lastOrder,
              recovered: false,
            };
          }
          if (
            (status === 'executed' ||
              status === 'filled' ||
              status === 'complete' ||
              status === 'completed') &&
            filled > 0
          ) {
            return {
              ok: filled >= minFill,
              filled,
              avgPriceCents: this._orderAvgFillPriceCents(lastOrder, heldSide, action),
              order: lastOrder,
              recovered: false,
            };
          }
        }
      } catch (err) {
        console.warn(`[bot] getOrder ${orderId} poll failed:`, err.message);
      }
      await this._sleep(delayMs);
    }

    let canceled = false;
    try {
      await this.client.cancelOrder(orderId);
      canceled = true;
    } catch (err) {
      // Cancel often fails when the order already fully filled — that is OK;
      // recovery getOrder below must still pick up the fill.
      console.warn(`[bot] cancelOrder ${orderId} failed:`, err.message);
    }

    // Give the matching engine a beat, then re-fetch (possibly multiple times).
    await this._sleep(delayMs);
    const recovered = await this._recoverOrderFillsAfterCancel(orderId, {
      priorOrder: lastOrder,
      attempts: 3,
      delayMs,
    });
    const filled = Math.max(bestFilled, recovered.filled);
    const order = recovered.order || lastOrder;
    const wasRecovery =
      canceled &&
      filled > 0 &&
      (bestFilled < filled || bestFilled < minFill);
    if (wasRecovery) {
      console.warn(
        `[bot] fill recovery: order ${orderId} filled ${filled} after poll timeout` +
          (canceled ? '/cancel' : '') +
          ' — recording inventory'
      );
    }
    return {
      ok: filled >= minFill,
      filled,
      avgPriceCents: this._orderAvgFillPriceCents(order, heldSide, action),
      order,
      recovered: wasRecovery || (filled > 0 && bestFilled < minFill),
    };
  }

  /**
   * After a live sell partially fills, book the sold contracts as a closed
   * ledger row and shrink the still-open trade so inventory matches Kalshi.
   */
  _bookPartialLiveExit(trade, soldContracts, exitPriceCents, reason, orderId, exitFeesCents = 0) {
    const sold = Math.max(0, Math.min(Math.floor(Number(soldContracts) || 0), trade.contracts));
    if (sold < 1) return;
    const remaining = trade.contracts - sold;
    const entry = Number(trade.entryPriceCents) || 0;
    const exitPx = Math.max(1, Math.min(99, Math.round(Number(exitPriceCents))));
    const entryFeesTotal = Math.max(0, Math.round(Number(trade.entryFeesCents) || 0));
    // Pro-rate entry fees across the sold slice when shrinking the open trade.
    const entryFeesSlice =
      trade.contracts > 0 ? Math.round((entryFeesTotal * sold) / (sold + remaining || sold)) : 0;
    const exitFees = Math.max(0, Math.round(Number(exitFeesCents) || 0));
    const feesCents = entryFeesSlice + exitFees;
    const closedSlice = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-partial-${sold}`,
      mode: trade.mode,
      symbol: trade.symbol,
      ticker: trade.ticker,
      side: trade.side,
      contracts: sold,
      stakeDollars: +((sold * entry) / 100).toFixed(2),
      entryPriceCents: entry,
      floorStrike: trade.floorStrike,
      openedAt: trade.openedAt,
      windowCloseTime: trade.windowCloseTime,
      engineProbability: trade.engineProbability,
      engineConfidence: trade.engineConfidence,
      status: 'closed',
      closedAt: Date.now(),
      exitPriceCents: exitPx,
      exitReason: reason,
      entryFeesCents: entryFeesSlice,
      exitFeesCents: exitFees,
      feesCents,
      pnlCents: this._netPnlCents(entry, exitPx, sold, entryFeesSlice, exitFees),
      liveOrderId: trade.liveOrderId || null,
      liveExitOrderId: orderId || null,
      partialExitOf: trade.id,
    };
    this._applyReserveFlow(closedSlice);
    this.ledger.trades.unshift(closedSlice);
    if (this.ledger.trades.length > 200) this.ledger.trades.length = 200;

    trade.contracts = remaining;
    trade.stakeDollars = +((remaining * entry) / 100).toFixed(2);
    trade.entryFeesCents = Math.max(0, entryFeesTotal - entryFeesSlice);

    const feeNote =
      feesCents > 0 ? ` · fees $${(feesCents / 100).toFixed(2)}` : '';
    this.lastDecision =
      `Partial exit ${trade.symbol} ${String(trade.side).toUpperCase()}: sold ${sold} @ ${exitPx}¢ ` +
      `(P&L $${(closedSlice.pnlCents / 100).toFixed(2)}${feeNote}); ${remaining} still open.`;
    this._logActivity(this.lastDecision, {
      kind: 'close',
      symbol: trade.symbol,
      side: trade.side,
      pnlCents: closedSlice.pnlCents,
      tradeId: closedSlice.id,
    });
    upsertTradeLog({
      id: closedSlice.id,
      mode: closedSlice.mode,
      symbol: closedSlice.symbol,
      ticker: closedSlice.ticker,
      side: closedSlice.side,
      contracts: closedSlice.contracts,
      stakeDollars: closedSlice.stakeDollars,
      entryPriceCents: closedSlice.entryPriceCents,
      exitPriceCents: closedSlice.exitPriceCents,
      floorStrike: closedSlice.floorStrike,
      openedAt: closedSlice.openedAt,
      closedAt: closedSlice.closedAt,
      windowCloseTime: closedSlice.windowCloseTime,
      engineProbability: closedSlice.engineProbability,
      engineConfidence: closedSlice.engineConfidence,
      status: 'closed',
      exitReason: closedSlice.exitReason,
      pnlCents: closedSlice.pnlCents,
      feesCents: closedSlice.feesCents || 0,
      entryFeesCents: closedSlice.entryFeesCents || 0,
      exitFeesCents: closedSlice.exitFeesCents || 0,
      skimmedCents: closedSlice.skimmedCents || 0,
      insuranceAddedCents: closedSlice.insuranceAddedCents || 0,
      insuranceDrawnCents: closedSlice.insuranceDrawnCents || 0,
      partialExitOf: trade.id,
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
      entryFeesCents: trade.entryFeesCents || 0,
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
        const baseSellPrice = Math.round(
          Number(opts.liveSellPriceCents != null ? opts.liveSellPriceCents : bookedExit)
        );
        if (!Number.isFinite(baseSellPrice) || baseSellPrice < 1 || baseSellPrice > 99) {
          this.lastError =
            `Live exit blocked for ${trade.symbol}: refusing sell at ${baseSellPrice}¢ (must be 1–99). Position left open.`;
          console.error('[bot]', this.lastError);
          if (reason === 'stop_loss') {
            trade.pendingForceExit = 'stop_loss';
            this.lastDecision = 'Stop-loss sell failed — will retry next cycle.';
            this._logActivity(this.lastDecision, {
              kind: 'close',
              symbol: trade.symbol,
              side: trade.side,
              tradeId: trade.id,
            });
            this._persist();
          }
          return false;
        }

        // Protective stop_loss: up to 3 increasingly aggressive sell attempts
        // in one call so a transient miss does not leave inventory naked.
        const maxAttempts = reason === 'stop_loss' ? 3 : 1;
        let lastErr = null;
        let soldOk = false;

        for (let attempt = 0; attempt < maxAttempts; attempt++) {
          const sellPrice = Math.max(1, Math.min(99, baseSellPrice - attempt));
          bookedExit = sellPrice;
          if (attempt > 0) {
            console.warn(
              `[bot] stop-loss sell retry ${attempt + 1}/${maxAttempts} at ${sellPrice}¢ ` +
                `on ${trade.ticker} (${trade.contracts} contracts)`
            );
            await this._sleep(400);
          }
          try {
            const order = await this.client.createOrder({
          ticker: trade.ticker,
          side: trade.side,
          action: 'sell',
          count: trade.contracts,
              priceCents: sellPrice,
            });
            const orderId = this._extractOrderId(order);
            if (!orderId) throw new Error('sell response missing order_id');
            const fill = await this._awaitOrderFill(orderId, {
              minFill: trade.contracts,
              attempts: 6,
              delayMs: 350,
              seedOrder: order,
              heldSide: trade.side,
              action: 'sell',
            });
            const filled = Math.max(0, Number(fill.filled) || 0);
            if (fill.recovered) {
              console.warn(
                `[bot] exit fill recovery on ${trade.ticker}: sell order ${orderId} filled ${filled} after timeout/cancel`
              );
            }
            if (filled > 0 && filled < trade.contracts) {
              // Partial fill then cancel/timeout: ledger must shrink with exchange
              // inventory. Book the sold slice; leave the remainder OPEN.
              const avgPartial = this._orderAvgFillPriceCents(
                fill.order,
                trade.side,
                'sell',
                sellPrice
              );
              let exitPx = Number.isFinite(avgPartial) ? avgPartial : sellPrice;
              exitPx = this._sanityCheckExitFillCents(
                exitPx,
                sellPrice,
                trade.entryPriceCents,
                reason
              );
              this._bookPartialLiveExit(
                trade,
                filled,
                exitPx,
                reason,
                orderId,
                this._orderFeesCents(fill.order)
              );
              lastErr = new Error(
                `sell partially filled (got ${filled}/${filled + trade.contracts}, status ${
                  fill.order && fill.order.status
                }) — remainder left open`
              );
              // Remainder needs another protective exit — do not burn more
              // same-call retries on a shrunk book; next cycle / pendingForceExit.
              break;
            }
            if (!fill.ok || filled < trade.contracts) {
              throw new Error(
                `sell not fully filled (got ${filled}/${trade.contracts}, status ${
                  fill.order && fill.order.status
                })`
              );
            }
            let avg = this._orderAvgFillPriceCents(fill.order, trade.side, 'sell', sellPrice);
            if (Number.isFinite(avg)) {
              avg = this._sanityCheckExitFillCents(
                avg,
                sellPrice,
                trade.entryPriceCents,
                reason
              );
              bookedExit = avg;
            } else bookedExit = sellPrice;
            trade.liveExitOrderId = orderId;
            trade.exitFeesCents = this._orderFeesCents(fill.order);
            soldOk = true;
            break;
      } catch (err) {
            lastErr = err;
            console.error(
              `[bot] live exit attempt ${attempt + 1}/${maxAttempts} (${reason}) on ${trade.ticker}: ${err.message}`
            );
          }
        }

        if (!soldOk) {
          const msg = (lastErr && lastErr.message) || 'sell failed';
          this.lastError = `Failed live exit (${reason}) on ${trade.ticker}: ${msg}. Position left OPEN.`;
        console.error('[bot]', this.lastError);
          if (reason === 'stop_loss') {
            trade.pendingForceExit = 'stop_loss';
            this.lastDecision = 'Stop-loss sell failed — will retry next cycle.';
            this._logActivity(this.lastDecision, {
              kind: 'close',
              symbol: trade.symbol,
              side: trade.side,
              tradeId: trade.id,
            });
            this._persist();
          }
          return false;
        }
      }

      delete trade.pendingForceExit;
      trade.status = 'closed';
      trade.closedAt = Date.now();
      trade.exitPriceCents = bookedExit;
      trade.exitReason = reason;
      const entryFees = Math.max(0, Math.round(Number(trade.entryFeesCents) || 0));
      const exitFees = Math.max(0, Math.round(Number(trade.exitFeesCents) || 0));
      trade.feesCents = entryFees + exitFees;
      trade.pnlCents = this._netPnlCents(
        trade.entryPriceCents,
        bookedExit,
        trade.contracts,
        entryFees,
        exitFees
      );

      this._applyReserveFlow(trade);
      this._recordCalibration(trade);

      const feeNote =
        trade.feesCents > 0 ? ` · fees $${(trade.feesCents / 100).toFixed(2)}` : '';
      let decision = `Closed ${trade.symbol} ${String(trade.side).toUpperCase()} via ${reason} at ${bookedExit}¢ (P&L $${(trade.pnlCents / 100).toFixed(2)}${feeNote}).`;
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
        decision += ` Insurance full — $${(trade.insuranceOverflowCents / 100).toFixed(2)} → available.`;
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
        feesCents: trade.feesCents || 0,
        entryFeesCents: trade.entryFeesCents || 0,
        exitFeesCents: trade.exitFeesCents || 0,
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

  /** True when an open hold’s live bid is ≥ entry (flat/green). */
  async _isOpenHoldingGreen(trade) {
    if (!trade || trade.status !== 'open') return false;
    const entry = Number(trade.entryPriceCents);
    if (!Number.isFinite(entry)) return false;
    try {
      const market = await this._getMarketBounded(trade.ticker, 2000);
      const bid = this._heldSideBidCents(trade, market);
      return bid != null && Number.isFinite(bid) && bid >= entry;
    } catch {
      return false;
    }
  }

  /**
   * Second (and further) opens only when at least one existing open is green.
   * First open always allowed. Off via secondOpenRequiresGreen: 'off'.
   */
  async _canOpenAdditionalPosition() {
    if (this.openTrades.length === 0) return { ok: true };
    const flag = String(this.config.secondOpenRequiresGreen ?? 'on').toLowerCase();
    if (flag === 'off' || flag === 'false' || flag === 'no' || flag === '0') {
      return { ok: true };
    }
    for (const t of this.openTrades) {
      if (await this._isOpenHoldingGreen(t)) {
        return { ok: true, greenSymbol: t.symbol };
      }
    }
    const held = this.openTrades.map((t) => t.symbol).join(', ');
    return {
      ok: false,
      reason:
        `Waiting: already holding ${held} — only open another when an existing position is green (bid ≥ entry).`,
    };
  }

  /**
   * Live entry ask for a side — used to re-quote before IOC.
   * Returns null when the book can't be read so callers don't +1¢ a stale plan price.
   */
  async _refreshLiveEntryAskCents(ticker, side) {
    try {
      const market = await this._getMarketBounded(ticker, 2000);
      if (!market) return null;
      if (side === 'yes') {
        const ask = Number(market.yes_ask);
        return Number.isFinite(ask) && ask >= 1 && ask <= 99 ? ask : null;
      }
      if (Number.isFinite(market.no_ask) && market.no_ask >= 1 && market.no_ask <= 99) {
        return market.no_ask;
      }
      const yesBid = Number(market.yes_bid);
      if (Number.isFinite(yesBid)) {
        const noAsk = 100 - yesBid;
        if (noAsk >= 1 && noAsk <= 99) return noAsk;
      }
    } catch (err) {
      console.warn(`[bot] entry re-quote ${ticker} failed:`, err.message);
    }
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

    // Failed protective exit: keep forcing sells every cycle until flat,
    // even if the bid has bounced back above the stop level.
    if (trade.pendingForceExit) {
      const forceReason = String(trade.pendingForceExit);
      if (
        heldSideBidCents != null &&
        Number.isFinite(heldSideBidCents) &&
        heldSideBidCents >= 1 &&
        heldSideBidCents <= 99
      ) {
        await this._closePosition(trade, heldSideBidCents, forceReason, {
          liveSellPriceCents: heldSideBidCents,
        });
      } else {
        this.lastDecision =
          `Pending ${forceReason} exit on ${trade.symbol}: waiting for a tradable bid (1–99¢).`;
      }
      return;
    }

    if (heldSideBidCents != null && stopLevel != null && heldSideBidCents <= stopLevel) {
      // Trigger on the live bid. Paper books the stop level (entry − drop).
      // Live sells at the real bid — markets don't owe you the stop price.
      const stopFill = this.config.mode === 'paper' ? stopLevel : heldSideBidCents;
      await this._closePosition(trade, stopFill, 'stop_loss', {
        liveSellPriceCents: heldSideBidCents,
      });
      return;
    }

    // Settle strategy: stop (above); optional entry-tiered TP/stale/stuck; else hold
    // for official settlement — no edge signal-flip exits.
    if (isSettleTrade(trade)) {
      if (!isSettleTieredExitsEnabled(this.config)) return;
      const plan = settleExitPlan(trade.entryPriceCents);
      const entry = Number(trade.entryPriceCents);
      const bidOk =
        heldSideBidCents != null &&
        Number.isFinite(heldSideBidCents) &&
        heldSideBidCents >= 1 &&
        heldSideBidCents <= 99;
      if (
        bidOk &&
        plan.targetCents != null &&
        heldSideBidCents >= plan.targetCents &&
        heldSideBidCents > entry
      ) {
        const fill =
          this.config.mode === 'paper'
            ? Math.min(99, Math.max(plan.targetCents, heldSideBidCents))
            : heldSideBidCents;
        await this._closePosition(trade, fill, 'take_profit', {
          liveSellPriceCents: heldSideBidCents,
        });
        return;
      }

      // Track "parked at/under entry" for stuck exits (hold tier skips these).
      // NOTE: Number(null)===0 is finite — never treat null/0 as a valid "since" stamp
      // or nearMs becomes ~epoch and breakeven fires on the next tick (BNB 30s BE).
      const stuckMs = settleStuckHoldMs(this.config);
      if (bidOk && stuckMs > 0 && plan.tier !== 'hold' && Number.isFinite(entry)) {
        const nearSinceRaw = Number(trade._settleNearEntrySince);
        const nearSinceOk = Number.isFinite(nearSinceRaw) && nearSinceRaw > 1e12;
        // Flat = at entry or 1¢ under — not green (+1 was falsely "flat" before).
        const nearFlat = heldSideBidCents >= entry - 1 && heldSideBidCents <= entry;
        if (nearFlat) {
          if (!nearSinceOk) trade._settleNearEntrySince = now;
        } else {
          trade._settleNearEntrySince = undefined;
        }
        const openedAt = Number(trade.openedAt);
        const heldMs = Number.isFinite(openedAt) ? now - openedAt : 0;
        const nearSince = Number(trade._settleNearEntrySince);
        const nearMs =
          nearFlat && Number.isFinite(nearSince) && nearSince > 1e12 ? now - nearSince : 0;

        // Small green (+1..+5¢) parked under target for stuckMs → bank it.
        const underTarget =
          plan.targetCents == null || heldSideBidCents < plan.targetCents;
        const smallGreen =
          heldSideBidCents >= entry + 1 && heldSideBidCents <= entry + 5;
        if (heldMs >= stuckMs && underTarget && smallGreen) {
          await this._closePosition(trade, heldSideBidCents, 'settle_stuck', {
            liveSellPriceCents: heldSideBidCents,
          });
          return;
        }
        // Truly flat (≤ entry) for stuckMs continuous + held long enough → scratch.
        if (heldMs >= stuckMs && nearMs >= stuckMs && heldSideBidCents <= entry) {
          await this._closePosition(trade, heldSideBidCents, 'breakeven', {
            liveSellPriceCents: heldSideBidCents,
          });
          return;
        }
      }

      const openedAt = Number(trade.openedAt);
      const heldLongEnough =
        !Number.isFinite(openedAt) || now - openedAt >= SETTLE_STALE_MIN_HOLD_MS;
      if (
        bidOk &&
        heldLongEnough &&
        plan.staleMinutesLeft != null &&
        minutesRemaining <= plan.staleMinutesLeft &&
        heldSideBidCents >= entry &&
        (plan.targetCents == null || heldSideBidCents < plan.targetCents)
      ) {
        // Target not reached in time — bank green rather than wait on settle lag.
        // Min hold blocks open→stale→reopen churn in the final minutes.
        await this._closePosition(trade, heldSideBidCents, 'settle_stale', {
          liveSellPriceCents: heldSideBidCents,
        });
        return;
      }
      return;
    }

    if (nearCertainHit) {
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
    const drop = isSettleTrade(trade)
      ? Number(this.config.settleStopLossCents)
      : Number(this.config.stopLossCents);
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

  async _openPosition({
    symbol,
    ticker,
    side,
    priceCents,
    floorStrike,
    closeTime,
    engineProbability,
    engineConfidence,
    strategy = 'edge',
  }) {
    // A paper trade must obey the same price rules as a live order. Without
    // this guard an empty Kalshi quote could be stored as `null` and then
    // appear in the dashboard as e.g. "BTC @ NO null".
    if (!Number.isFinite(priceCents) || priceCents < 1 || priceCents > 99) {
      this.lastError = `Skipped ${symbol} ${side || 'unknown'} entry: no valid Kalshi quote is available.`;
      return false;
    }
    const closeAt = Number(closeTime);
    if (!Number.isFinite(closeAt) || closeAt <= Date.now() + 5000) {
      this.lastError = `Skipped ${symbol} ${side || 'unknown'} entry: market close time is missing or already ending.`;
      return false;
    }
    const isSettle = strategy === 'settle';
    const minutesLeft = (closeAt - Date.now()) / 60000;
    const minMinutesToOpen = isSettle
      ? Number.isFinite(Number(this.config.settleMinMinutesToOpen))
        ? Number(this.config.settleMinMinutesToOpen)
        : 0.5
      : Number.isFinite(Number(this.config.minMinutesToOpen))
        ? Number(this.config.minMinutesToOpen)
        : 3;
    if (minMinutesToOpen > 0 && minutesLeft < minMinutesToOpen) {
      this.lastDecision =
        `Skipped ${symbol}: only ${minutesLeft.toFixed(1)} min left (min ${minMinutesToOpen} to open).`;
      return false;
    }
    if (isSettle) {
      const maxMinutes = Number(this.config.settleMaxMinutesToOpen);
      if (Number.isFinite(maxMinutes) && maxMinutes > 0 && minutesLeft > maxMinutes) {
        this.lastDecision =
          `Skipped ${symbol}: ${minutesLeft.toFixed(1)} min left (settle mode only opens with ≤ ${maxMinutes} min left).`;
        return false;
      }
      if (!isSettleEntryPriceCents(priceCents, this.config, minutesLeft)) {
        const band = settleEffectiveEntryBand(this.config, minutesLeft);
        this.lastDecision =
          `Skipped ${symbol} ${String(side || '').toUpperCase()} @ ${priceCents}¢: outside settle band ${band.min}–${band.max}¢` +
          (band.late ? ' (late fallback)' : '') +
          '.';
        return false;
      }
      const richFloor = settleRichAskFloorCents(this.config);
      const minUpside = settleMinUpsideCents(this.config);
      const upside = 100 - priceCents;
      if (priceCents >= richFloor || (minUpside > 0 && upside < minUpside)) {
        this.lastDecision =
          `Skipped ${symbol} settle @ ${priceCents}¢: not enough upside` +
          ` (need <${richFloor}¢ and ≥${minUpside}¢ to 100) — trying other cryptos.`;
        return false;
      }
    } else {
      const minEntry = Number(this.config.minEntryCents);
      if (Number.isFinite(minEntry) && minEntry > 0 && priceCents < minEntry) {
        this.lastDecision =
          `Skipped ${symbol} ${String(side || '').toUpperCase()} @ ${priceCents}¢: below min entry ${minEntry}¢ (longshot ban).`;
        return false;
      }
    }
    // Max positions is a concurrency cap across coins — stacking two opens
    // on the same symbol (or ticker) just doubles correlated exposure.
    if (this._hasOpenOnSymbol(symbol) || this._hasOpenOnTicker(ticker)) {
      this.lastDecision = `Skipped ${symbol}: already have an open position on this coin/market.`;
      return false;
    }
    // Each Kalshi contract costs `priceCents` cents and pays out $1 if it
    // wins, so buying (stakeDollars * 100 / priceCents) contracts risks
    // approximately stakeDollars. Always at least 1 contract.
    const stakeDollars = this._stakeDollarsForEntry(priceCents, { settle: isSettle, symbol });
    const contracts = Math.max(1, Math.floor((stakeDollars * 100) / priceCents));
    const entryCostCents = contracts * priceCents;
    const capital = this._capitalStatus();
    if (this.config.mode === 'paper' && entryCostCents > capital.paperAvailableCents) {
      this.lastDecision = `Insufficient paper funds: $${(capital.paperAvailableCents / 100).toFixed(2)} is spendable after the reserved skim.`;
      return false;
    }
    if (this.config.mode === 'live' && Number.isFinite(this.liveBalanceCents) && entryCostCents > this.liveBalanceCents) {
      this.lastDecision = `Insufficient live balance: $${(this.liveBalanceCents / 100).toFixed(2)} is available on Kalshi.`;
      return false;
    }
    const trade = {
      id: crypto.randomUUID ? crypto.randomUUID() : `${Date.now()}-${Math.random()}`,
      mode: this.config.mode,
      strategy: isSettle ? 'settle' : 'edge',
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
      // One attempt per coin. Refresh ask, pay up to +1¢ to cross, IOC, size to book.
      let filled = 0;
      let fill = null;
      let orderId = null;
      let workingPrice = priceCents;
      let lastErr = null;

      // Re-quote so we don't GTC a ghost ask that already walked.
      let liveMarket = null;
      try {
        liveMarket = await this._getMarketBounded(ticker, 2000);
      } catch {
        liveMarket = null;
      }
      const freshAsk = await this._refreshLiveEntryAskCents(ticker, side);
      if (Number.isFinite(freshAsk)) {
        const band = isSettle ? settleEffectiveEntryBand(this.config, minutesLeft) : null;
        const richFloor = isSettle ? settleRichAskFloorCents(this.config) : 100;
        const ceiling = isSettle
          ? Math.min(99, richFloor - 1, Math.max(band?.max ?? priceCents, priceCents) + 1)
          : Math.min(99, priceCents + 2);
        // Cross by at most +1¢ above the live ask / planned price.
        workingPrice = Math.min(ceiling, Math.max(priceCents, freshAsk, Math.min(99, freshAsk + 1)));
        workingPrice = Math.max(1, Math.min(99, Math.round(workingPrice)));
        if (isSettle) {
          const upside = 100 - workingPrice;
          const minUpside = settleMinUpsideCents(this.config);
          if (
            workingPrice >= richFloor ||
            (minUpside > 0 && upside < minUpside) ||
            !isSettleEntryPriceCents(workingPrice, this.config, minutesLeft)
          ) {
            // Can't cross without leaving the band — skip rather than rest a dead bid.
            this._noteEntryMiss(symbol);
            this.lastError =
              `Skipped ${symbol} live entry: live ask ${freshAsk}¢ can't cross inside settle band ` +
              `(would need ${workingPrice}¢). Focusing on other cryptos.`;
            this.lastDecision = this.lastError;
            this._logActivity(this.lastDecision, { kind: 'open', symbol, side, strategy: trade.strategy });
            return false;
          }
        }
      }

      let attemptContracts = Math.max(
        1,
        Math.floor(
          (this._stakeDollarsForEntry(workingPrice, { settle: isSettle, symbol }) * 100) / workingPrice
        )
      );
      const bookAskSize =
        liveMarket &&
        (side === 'yes'
          ? Number(liveMarket.yes_ask_size)
          : Number(liveMarket.no_ask_size) ||
            (Number.isFinite(Number(liveMarket.yes_bid_size))
              ? Number(liveMarket.yes_bid_size)
              : NaN));
      if (Number.isFinite(bookAskSize) && bookAskSize >= 1 && bookAskSize < attemptContracts) {
        console.warn(
          `[bot] sizing ${symbol} entry down ${attemptContracts}→${bookAskSize} to visible ask size`
        );
        attemptContracts = Math.max(1, Math.floor(bookAskSize));
      }
      const attemptCost = attemptContracts * workingPrice;
      if (Number.isFinite(this.liveBalanceCents) && attemptCost > this.liveBalanceCents) {
        this.lastDecision =
          `Insufficient live balance: need $${(attemptCost / 100).toFixed(2)}, have $${(this.liveBalanceCents / 100).toFixed(2)}.`;
        return false;
      }
      trade.contracts = attemptContracts;
      trade.entryPriceCents = workingPrice;
      trade.stakeDollars = +(attemptCost / 100).toFixed(2);

      try {
        const order = await this.client.createOrder({
          ticker,
          side,
          action: 'buy',
          count: trade.contracts,
          priceCents: workingPrice,
          // IOC: take what's there now; don't rest a GTC that we cancel empty ~2s later.
          timeInForce: 'immediate_or_cancel',
        });
        orderId = this._extractOrderId(order);
        if (!orderId) {
          lastErr = new Error('createOrder returned no order_id');
          console.error(`[bot] Live entry on ${symbol} returned no order_id`);
        } else {
          fill = await this._awaitOrderFill(orderId, {
            minFill: 1, // accept partials — full-size FOC was a common 0/N miss
            attempts: 4,
            delayMs: 200,
            seedOrder: order,
            heldSide: side,
            action: 'buy',
          });
          filled = Math.max(0, Number(fill.filled) || 0);
          if (filled < 1) {
            const lastChance = await this._recoverOrderFillsAfterCancel(orderId, {
              priorOrder: fill.order,
              attempts: 2,
              delayMs: 300,
            });
            if (lastChance.filled > 0) {
              filled = lastChance.filled;
              fill.order = lastChance.order || fill.order;
              fill.recovered = true;
              console.warn(
                `[bot] fill recovery: live entry ${symbol} order ${orderId} had ${filled} fills on final getOrder — recording trade`
              );
            }
          }
          if (filled < 1) {
            lastErr = new Error(`no fill (0/${trade.contracts})`);
            console.warn(
              `[bot] Live entry on ${symbol} did not fill @ ${workingPrice}¢ (IOC; fresh ask was ${freshAsk}¢)`
            );
          }
        }
      } catch (err) {
        lastErr = err;
        console.error(`[bot] Live entry failed:`, err.message);
      }

      if (filled < 1) {
        const miss = this._noteEntryMiss(symbol);
        const coolMin = Math.max(1, Math.round((miss.cooldownMs || 120_000) / 60000));
        this.lastError =
          `Live entry on ${symbol} did not fill` +
          (lastErr ? ` (${lastErr.message})` : '') +
          ` — skipping this coin ~${coolMin}m (miss #${miss.streak}); focusing on other cryptos.`;
        this.lastDecision = this.lastError;
        this._logActivity(this.lastDecision, {
          kind: 'open',
          symbol,
          side,
          strategy: trade.strategy,
        });
        console.error('[bot]', this.lastError);
        return false;
      }
      this._clearEntryMiss(symbol);
      if (fill && fill.recovered) {
        console.warn(
          `[bot] entry fill recovery on ${symbol}: order ${orderId} filled ${filled}/${trade.contracts} after timeout/cancel — ledgered`
        );
      }
      if (filled < trade.contracts) {
        trade.contracts = filled;
        trade.stakeDollars = +((trade.contracts * workingPrice) / 100).toFixed(2);
      }
      let avg = this._orderAvgFillPriceCents(fill && fill.order, side, 'buy', workingPrice);
      if (Number.isFinite(avg)) {
        avg = this._sanityCheckEntryFillCents(avg, workingPrice);
        trade.entryPriceCents = avg;
        trade.stakeDollars = +((trade.contracts * avg) / 100).toFixed(2);
      }
      // Settle: never book an entry far outside the band from a bad fill parse.
      if (isSettle && Number.isFinite(trade.entryPriceCents)) {
        const minsLeftNow = (closeAt - Date.now()) / 60000;
        const band = settleEffectiveEntryBand(this.config, minsLeftNow);
        const chaseCeiling = Math.min(97, band.max + 2);
        if (trade.entryPriceCents < band.min || trade.entryPriceCents > chaseCeiling) {
          console.warn(
            `[bot] settle entry fill ${trade.entryPriceCents}¢ outside band — booking limit ${workingPrice}¢`
          );
          trade.entryPriceCents = workingPrice;
          trade.stakeDollars = +((trade.contracts * workingPrice) / 100).toFixed(2);
        }
      }
      trade.entryFeesCents = this._orderFeesCents(fill && fill.order);
      trade.liveOrderId = orderId;
      this._clearEntryMiss(symbol);
    }

    this.ledger.trades.unshift(trade);
    if (this.ledger.trades.length > 200) this.ledger.trades.length = 200;
    this._noteProtectionGate(false); // open implies gate no longer blocking
    if (isSettle) {
      const minsLeftNow = (closeAt - Date.now()) / 60000;
      const eff = settleEffectiveEntryBand(this.config, minsLeftNow);
      const primary = settleEntryBand(this.config);
      const lateNote =
        eff.late && trade.entryPriceCents < primary.min ? ' · late fallback' : '';
      const halfNote =
        this._stakeDollarsForEntry(trade.entryPriceCents, { settle: true, symbol }) <
        Number(this._computeNextStake()) - 0.001
          ? ' · half stake'
          : '';
      this.lastDecision =
        `Opened ${symbol} ${side.toUpperCase()} settle position at ${trade.entryPriceCents}¢` +
        ` (hold to settlement${lateNote}${halfNote}).`;
    } else {
      this.lastDecision =
        `Opened ${symbol} ${side.toUpperCase()} ${this.config.mode} position at ${trade.entryPriceCents}¢` +
        ` (confidence ${engineConfidence}%).`;
    }
    this._logActivity(this.lastDecision, {
      kind: 'open',
      symbol,
      side,
      strategy: trade.strategy,
      tradeId: trade.id,
    });
    upsertTradeLog({
      id: trade.id,
      mode: trade.mode,
      strategy: trade.strategy,
      symbol: trade.symbol,
      ticker: trade.ticker,
      side: trade.side,
      contracts: trade.contracts,
      stakeDollars: trade.stakeDollars,
      entryPriceCents: trade.entryPriceCents,
      entryFeesCents: trade.entryFeesCents || 0,
      floorStrike: trade.floorStrike,
      openedAt: trade.openedAt,
      windowCloseTime: trade.windowCloseTime,
      engineProbability: trade.engineProbability,
      engineConfidence: trade.engineConfidence,
      status: 'open',
    });
    this._persist();
    return true;
  }

  /**
   * After a live fill miss, hard-skip this coin on an escalating ladder so we
   * stop pinging the same thin book and focus on other cryptos:
   * 2m → 5m → 10m → 15m (cap).
   */
  _noteEntryMiss(symbol, cooldownMs = null) {
    if (!symbol) return;
    const sym = String(symbol).toUpperCase();
    if (!this._entryMissStreak) this._entryMissStreak = Object.create(null);
    if (!this._entryMissUntil) this._entryMissUntil = Object.create(null);
    const streak = (this._entryMissStreak[sym] || 0) + 1;
    this._entryMissStreak[sym] = streak;
    const ladder = [120_000, 300_000, 600_000, 900_000];
    const ms =
      Number.isFinite(cooldownMs) && cooldownMs > 0
        ? cooldownMs
        : ladder[Math.min(streak - 1, ladder.length - 1)];
    this._entryMissUntil[sym] = Date.now() + ms;
    return { streak, cooldownMs: ms };
  }

  _clearEntryMiss(symbol) {
    if (!symbol) return;
    const sym = String(symbol).toUpperCase();
    if (this._entryMissUntil) delete this._entryMissUntil[sym];
    if (this._entryMissStreak) delete this._entryMissStreak[sym];
  }

  _entryMissCooldownMs(symbol) {
    if (!this._entryMissUntil || !symbol) return 0;
    const until = this._entryMissUntil[String(symbol).toUpperCase()];
    if (!Number.isFinite(until)) return 0;
    return Math.max(0, until - Date.now());
  }

  _hasRecentEntryMiss(symbol) {
    if (!this._entryMissUntil || !symbol) return false;
    const until = this._entryMissUntil[String(symbol).toUpperCase()];
    if (!Number.isFinite(until)) return false;
    if (Date.now() >= until) {
      delete this._entryMissUntil[String(symbol).toUpperCase()];
      return false;
    }
    return true;
  }

  _entryMissCooldownSymbols() {
    if (!this._entryMissUntil) return [];
    const now = Date.now();
    const out = [];
    for (const [sym, until] of Object.entries(this._entryMissUntil)) {
      if (Number.isFinite(until) && until > now) out.push(sym);
      else delete this._entryMissUntil[sym];
    }
    return out;
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

    // One open is fine; a second only if something already held is green.
    if (this.openTrades.length >= 1) {
      const extra = await this._canOpenAdditionalPosition();
      if (!extra.ok) {
        this.lastDecision = extra.reason;
        return;
      }
    }

    // After a stop, don't stack a second leg while the wound is still fresh —
    // briefly cap at 1 open (postStopMaxOneMinutes, default 1.5m), then
    // normal maxOpenPositions applies again. Other gates still apply.
    const preferOtherThan = this._lastStopLossSymbol();
    const settleMode = isSettleStrategyMode(this.config);
    const maxOneActive = isPostStopMaxOneActive(this._lastStopLossTrade(), this.config);
    if (preferOtherThan && this.openTrades.length >= 1 && maxOneActive) {
      const mins = Number(this.config.postStopMaxOneMinutes);
      const minsLabel = Number.isFinite(mins) && mins > 0 ? mins : POST_STOP_MAX_ONE_DEFAULT_MINUTES;
      this.lastDecision =
        `Waiting: after ${preferOtherThan} stop — max 1 open until post-stop calm (${minsLabel}m) (avoids loss strings).`;
      this._noteProtectionGate(this.lastDecision);
      return;
    }
    if (this._lastProtectionGateKey === 'post-stop-max1') {
      this._noteProtectionGate(null);
    }

    // After a stop-loss, scan other coins first instead of immediately
    // rebuying the same one that just stopped (even if it still ranks highest).
    const scanAllAfterStop =
      preferOtherThan != null &&
      (this.config.symbol === 'AUTO' || preferOtherThan === this.config.symbol);

    let opportunity;
    if (settleMode) {
      const ranked =
        this.config.symbol === 'AUTO' || scanAllAfterStop
          ? await this._rankSettleOpportunities(predictions, { preferOtherThan })
          : [await this._evaluateSymbolForSettle(this.config.symbol, predictions)].filter(Boolean);
      // Try best → next coin on fill miss (no same-coin chase spam).
      for (const opp of ranked) {
        if (preferOtherThan && opp.symbol !== preferOtherThan && ranked[0] === opp) {
          this.lastDecision =
            `Post-stop: chose ${opp.symbol} over recently stopped ${preferOtherThan} ` +
            `(checking other cryptos first).`;
        }
        const opened = await this._openPosition({
          symbol: opp.symbol,
          ticker: opp.market.ticker,
          side: opp.side,
          priceCents: opp.priceCents,
          floorStrike: opp.market.floor_strike,
          closeTime: opp.closeTime,
          engineProbability: opp.side === 'yes' ? opp.window.probabilityUp : opp.window.probabilityDown,
          engineConfidence: opp.window.confidence,
          strategy: 'settle',
        });
        if (opened) return;
        if (this.openTrades.length >= this.config.maxOpenPositions) return;
      }
      return;
    }

    opportunity =
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
      strategy: 'edge',
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
   * After a stop (while it remains the latest closed trade), gate new entries:
   * session expiry → allow; max-age → allow; peers cascading → block all;
   * stopped-coin bounce not met → block all; same-coin same-side thesis → knife-catch only.
   */
  async _stoppedCoinRecoveryGate(candidateSymbol, candidateSide, candidatePriceCents, candidateWindow, predictions) {
    const lastStop = this._lastStopLossTrade();
    if (!lastStop) return { ok: true };

    // Settle needs these too — without same-side sit-out the bot knife-catches
    // the same 85–95¢ print after every stop (see SOL 12:57–12:59 loss string).

    const now = Date.now();
    const maxAgeMs = stopRecoveryMaxAgeMs(this.config);
    const sameSideCooldownMs = postStopSameSideCooldownMs(this.config);

    // Same-side sit-out from closedAt — independent of bounce / session / max-age.
    const sameSideCheck = checkPostStopSameSideCooldown({
      lastStopTrade: lastStop,
      forCandidateSymbol: candidateSymbol,
      forCandidateSide: candidateSide,
      cooldownMs: sameSideCooldownMs,
      now,
    });
    if (!sameSideCheck.ok) return sameSideCheck;

    // 1) Session window ended → allow (never freeze into the next 15m).
    if (isPostStopRecoverySessionExpired(lastStop, now)) {
      return { ok: true };
    }

    // 2) Max-age backup within a long window → allow.
    const closedAt = Number(lastStop.closedAt);
    if (
      maxAgeMs > 0 &&
      Number.isFinite(closedAt) &&
      now - closedAt >= maxAgeMs
    ) {
      return { ok: true };
    }

    // 3) Peers still cascading → block EVERY candidate until calm / session / short max age.
    const peerCheck = checkPostStopPeerCascade({
      lastStopTrade: lastStop,
      candidateSide,
      predictions,
      seriesBySymbol: SERIES_BY_SYMBOL,
      minConfidence: this.config.minConfidence,
      maxAgeMs: peerCascadeMaxAgeMs(this.config),
      now,
    });
    if (!peerCheck.ok) return peerCheck;

    const recoveryCents = stopRecoveryCentsRequired(this.config);
    if (recoveryCents <= 0) return { ok: true };

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

    // 5–6) Bounce required for everyone; knife-catch only same-coin same-side.
    // sameSideCooldownMs passed so checkPostStopRecovery stays consistent (already
    // enforced above; remaining bounce/thesis gates still apply).
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
      sameSideCooldownMs,
      now,
    });
  }

  /**
   * Fetches the current open market for one symbol and checks whether
   * there's a large enough edge (and enough confidence) to be worth
   * trading. Returns an opportunity descriptor, or null if there's nothing
   * worth acting on (or the market/prediction data isn't available).
   */
  async _evaluateSymbolForEdge(symbol, predictions) {
    if (!isKalshiTradeEnabled(symbol)) {
      this.lastDecision = `Waiting: ${symbol} is opted out of trading.`;
      return null;
    }

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
      : 3;
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

    // Post-stop: peers calm + stopped-coin bounce (knife-catch only same-coin).
    const recoveryCheck = await this._stoppedCoinRecoveryGate(
      symbol,
      side,
      priceCents,
      window,
      predictions
    );
    if (!recoveryCheck.ok) {
      this.lastDecision = recoveryCheck.reason;
      this._noteProtectionGate(recoveryCheck.reason, { fromSymbol: symbol });
      return null;
    }
    this._noteProtectionGate(null, { fromSymbol: symbol });

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
   * Settle mode: buy a side in the primary band (default 85–95¢). If nothing
   * hits and ≤ settleLateEntryMinutes remain (default 3.5), expand the floor
   * down to settleLateEntryMinCents (default 70) and take the closest ask to
   * the primary band (highest price). Soft thesis (engine lean) applies only
   * when Coinbase spot is ready; otherwise Kalshi quotes alone are enough.
   */
  async _evaluateSymbolForSettle(symbol, predictions, { quiet = false, onSkip = null } = {}) {
    const say = (msg) => {
      if (typeof onSkip === 'function') onSkip(symbol, msg);
      if (!quiet) this.lastDecision = msg;
    };
    if (!isKalshiTradeEnabled(symbol)) {
      say(`Waiting: ${symbol} is opted out of trading.`);
      return null;
    }
    if (this._hasOpenOnSymbol(symbol)) {
      say(`Waiting: already holding an open ${symbol} position (one open per coin).`);
      return null;
    }

    const assetPrediction = predictions && predictions[symbol];
    const engineReady = Boolean(
      assetPrediction &&
        assetPrediction.ready &&
        assetPrediction.windows &&
        typeof assetPrediction.windows === 'object'
    );

    const seriesTicker = SERIES_BY_SYMBOL[symbol];
    if (!seriesTicker) {
      say(`Waiting: ${symbol} has no supported Kalshi market.`);
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
      say(`Waiting: no open Kalshi market found for ${symbol}.`);
      return null;
    }
    if (this._hasOpenOnTicker(market.ticker)) {
      say(`Waiting: already holding an open position on ${market.ticker}.`);
      return null;
    }

    const now = Date.now();
    const closeTime = new Date(market.close_time).getTime();
    if (!Number.isFinite(closeTime) || closeTime <= now) {
      say(`Waiting: the available ${symbol} market is already closed.`);
      return null;
    }

    const minutesRemaining = Math.max(0.1, (closeTime - now) / 60000);
    const minMinutes = Number.isFinite(Number(this.config.settleMinMinutesToOpen))
      ? Number(this.config.settleMinMinutesToOpen)
      : 0.5;
    const maxMinutes = Number.isFinite(Number(this.config.settleMaxMinutesToOpen))
      ? Number(this.config.settleMaxMinutesToOpen)
      : 12;
    if (minMinutes > 0 && minutesRemaining < minMinutes) {
      say(`Waiting: ${symbol} settle — only ${minutesRemaining.toFixed(1)} min left (need ≥ ${minMinutes}).`);
      return null;
    }
    if (maxMinutes > 0 && minutesRemaining > maxMinutes) {
      say(
        `Waiting: ${symbol} settle — price may qualify, but ${minutesRemaining.toFixed(1)} min left ` +
          `(only opens with ≤ ${maxMinutes} min left).`
      );
      return null;
    }

    // Neutral placeholder when Coinbase isn't seeded — band/quote gates still apply.
    const window = engineReady
      ? this._pickWindow(assetPrediction.windows, minutesRemaining)
      : { probabilityUp: 50, probabilityDown: 50, confidence: 0 };
    if (!window) {
      say(`Waiting: ${symbol} has no usable prediction window for settle.`);
      return null;
    }

    const yesBid = Number(market.yes_bid);
    const yesAsk = Number(market.yes_ask);
    if (!Number.isFinite(yesBid) || !Number.isFinite(yesAsk) || yesBid < 1 || yesAsk > 99 || yesBid > yesAsk) {
      this.lastError = `Skipped ${symbol}: Kalshi has no usable two-sided quote yet.`;
      return null;
    }

    const primary = settleEntryBand(this.config);
    const noAsk = 100 - yesBid;
    const collect = (minCents, maxCents) => {
      const out = [];
      if (yesAsk >= minCents && yesAsk <= maxCents) {
        out.push({ side: 'yes', priceCents: yesAsk });
      }
      if (noAsk >= minCents && noAsk <= maxCents) {
        out.push({ side: 'no', priceCents: noAsk });
      }
      return out;
    };

    const minUpside = settleMinUpsideCents(this.config);
    const richFloor = settleRichAskFloorCents(this.config);
    const profitableEnough = (c) => {
      const upside = 100 - c.priceCents;
      if (minUpside > 0 && upside < minUpside) return false;
      // Hard skip nearly-certain tickets — leave them; hunt other coins.
      if (c.priceCents >= richFloor) return false;
      return true;
    };

    let candidates = collect(primary.min, primary.max).filter(profitableEnough);
    let usedLateBand = false;
    if (candidates.length === 0) {
      const late = settleEffectiveEntryBand(this.config, minutesRemaining);
      if (late.late) {
        candidates = collect(late.min, late.max).filter(profitableEnough);
        usedLateBand = candidates.length > 0;
      }
    }
    if (candidates.length === 0) {
      const lateMins = settleLateEntryMinutes(this.config);
      const lateFloor = settleLateEntryMinCents(this.config);
      const inBandRaw = collect(primary.min, primary.max);
      const richOnly =
        inBandRaw.length > 0 && inBandRaw.every((c) => c.priceCents >= richFloor || (100 - c.priceCents) < minUpside);
      if (richOnly) {
        say(
          `Waiting: ${symbol} settle — ask too rich (need ≤${richFloor - 1}¢ and ≥${minUpside}¢ upside to 100; trying other cryptos).`
        );
        return null;
      }
      const lateHint =
        lateMins > 0 && minutesRemaining > lateMins
          ? ` (late fallback ${lateFloor}–${primary.max}¢ only with ≤ ${lateMins} min left)`
          : '';
      say(
        `Waiting: ${symbol} settle — YES ask ${yesAsk}¢ / NO ask ${noAsk}¢ outside ${primary.min}–${primary.max}¢` +
          lateHint +
          '.'
      );
      return null;
    }

    // Prefer engine-agreed side when spot is ready; else highest ask under rich floor.
    if (engineReady) {
      const favorsYes = window.probabilityUp >= window.probabilityDown;
      candidates.sort((a, b) => {
        const aAgree = (a.side === 'yes') === favorsYes ? 0 : 1;
        const bAgree = (b.side === 'yes') === favorsYes ? 0 : 1;
        if (aAgree !== bAgree) return aAgree - bAgree;
        return b.priceCents - a.priceCents;
      });
    } else {
      candidates.sort((a, b) => b.priceCents - a.priceCents);
    }
    const pick = candidates[0];

    // Soft thesis only with a live Coinbase lean — Kalshi-only skips this filter.
    if (engineReady) {
      if (pick.side === 'yes' && window.probabilityUp < window.probabilityDown) {
        say(`Waiting: ${symbol} settle YES @ ${pick.priceCents}¢ but engine leans NO.`);
        return null;
      }
      if (pick.side === 'no' && window.probabilityDown < window.probabilityUp) {
        say(`Waiting: ${symbol} settle NO @ ${pick.priceCents}¢ but engine leans YES.`);
        return null;
      }
    }

    // Don't open if we're already inside this entry's stale window — would
    // churn: enter → immediately green → settle_stale → reopen (see BTC 7:25–7:27).
    if (isSettleTieredExitsEnabled(this.config)) {
      const entryPlan = settleExitPlan(pick.priceCents);
      if (
        entryPlan.staleMinutesLeft != null &&
        minutesRemaining <= entryPlan.staleMinutesLeft
      ) {
        say(
          `Waiting: ${symbol} settle — ≤${entryPlan.staleMinutesLeft}m left (already in stale zone); not opening a churn entry.`
        );
        return null;
      }
    }

    const lastClosed = this.ledger.trades.find((t) => t.status === 'closed');
    const staleSitOut = checkSameSideExitCooldown({
      lastTrade: lastClosed,
      exitReasons: ['settle_stale', 'take_profit', 'settle_stuck'],
      forCandidateSymbol: symbol,
      forCandidateSide: pick.side,
      cooldownMs: settlePostStaleSameSideCooldownMs(this.config),
      now: Date.now(),
      reasonVerb: 'banked',
    });
    if (!staleSitOut.ok) {
      say(staleSitOut.reason);
      return null;
    }

    const recoveryCheck = await this._stoppedCoinRecoveryGate(
      symbol,
      pick.side,
      pick.priceCents,
      window,
      predictions
    );
    if (!recoveryCheck.ok) {
      if (!quiet) this.lastDecision = recoveryCheck.reason;
      this._noteProtectionGate(recoveryCheck.reason, { fromSymbol: symbol });
      return null;
    }
    this._noteProtectionGate(null, { fromSymbol: symbol });

    return {
      symbol,
      market,
      window,
      side: pick.side,
      priceCents: pick.priceCents,
      closeTime,
      edge: 100 - pick.priceCents,
      // Mid-band asks first (under rich floor, default 94¢); among those prefer
      // higher ask + liquidity + tighter spread. 94¢+ only after nothing sweeter.
      rankScore:
        settleRankAskScore(pick.priceCents, {
          richFloorCents: settleRichAskFloorCents(this.config),
          usedLateBand,
        }) +
        liquidityPriority(symbol) +
        Math.max(0, 15 - Math.max(0, yesAsk - yesBid)),
      strategy: 'settle',
      settleLateEntry: usedLateBand,
      engineReady,
    };
  }

  async _rankSettleOpportunities(predictions, { preferOtherThan = null } = {}) {
    const cooling = this._entryMissCooldownSymbols();
    const allTradeable = tradeableKalshiSymbols();
    const noSpotLean = allTradeable.filter((sym) => !predictions[sym] || !predictions[sym].ready);
    // Settle scans every tradeable Kalshi series — Coinbase ready is optional (Kalshi-only).
    const candidates = allTradeable.filter(
      (sym) => !this._hasOpenOnSymbol(sym) && !this._hasRecentEntryMiss(sym)
    );
    if (candidates.length === 0) {
      if (cooling.length) {
        this.lastDecision =
          `Waiting: fill-miss cool-down on ${cooling.join(', ')} — not pinging those.`;
      } else {
        this.lastDecision = `Waiting: no tradeable coins available for settle scan.`;
      }
      return [];
    }
    const skips = [];
    const shortSkip = (msg) => {
      const m = String(msg || '');
      if (/not ready|seeding/i.test(m)) return 'feed not ready';
      if (/too rich|not enough upside|≥\d+¢/i.test(m)) return 'ask too rich / thin upside';
      if (/stale zone|churn entry/i.test(m)) return 'already in stale window';
      if (/leans NO/i.test(m)) return 'engine leans NO';
      if (/leans YES/i.test(m)) return 'engine leans YES';
      if (/outside .+¢/i.test(m)) return 'ask outside band';
      if (/sit-out|same-side/i.test(m)) return 'same-side sit-out';
      if (/min left/i.test(m)) return 'time window gate';
      if (/no open Kalshi/i.test(m)) return 'no Kalshi market';
      return m.replace(/^Waiting:\s*/i, '').slice(0, 48);
    };
    const evaluations = await Promise.all(
      candidates.map((sym) =>
        this._evaluateSymbolForSettle(sym, predictions, {
          quiet: true,
          onSkip: (s, msg) => {
            if (skips.length < 12) skips.push({ symbol: s, why: shortSkip(msg) });
          },
        })
      )
    );
    const valid = evaluations.filter(Boolean);
    const skipLine = skips.length
      ? skips.map((s) => `${s.symbol} (${s.why})`).join('; ')
      : '';
    const kalshiOnlyLine =
      noSpotLean.length > 0
        ? `Kalshi-only (no spot lean): ${noSpotLean.join(', ')}.`
        : '';
    if (valid.length === 0) {
      this.lastDecision =
        `Settle scan: no entry.` +
        (kalshiOnlyLine ? ` ${kalshiOnlyLine}` : '') +
        (skipLine ? ` Skipped: ${skipLine}.` : '') +
        (cooling.length ? ` Cooling: ${cooling.join(', ')}.` : '');
      return [];
    }
    valid.sort((a, b) => {
      if (preferOtherThan) {
        const aPen = a.symbol === preferOtherThan ? 1 : 0;
        const bPen = b.symbol === preferOtherThan ? 1 : 0;
        if (aPen !== bPen) return aPen - bPen;
      }
      // Prefer coins with fewer recent fill-miss streaks, then ask score / liquidity.
      const aMiss = (this._entryMissStreak && this._entryMissStreak[a.symbol]) || 0;
      const bMiss = (this._entryMissStreak && this._entryMissStreak[b.symbol]) || 0;
      if (aMiss !== bMiss) return aMiss - bMiss;
      // When scores tie, prefer a Coinbase lean over pure Kalshi-only.
      const aLean = a.engineReady ? 1 : 0;
      const bLean = b.engineReady ? 1 : 0;
      if (aLean !== bLean) return bLean - aLean;
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return liquidityPriority(b.symbol) - liquidityPriority(a.symbol);
    });
    // Keep Decision honest when alts were in mind but lost to filters / ranking.
    const best = valid[0];
    const altNote = skipLine ? ` Also skipped: ${skipLine}.` : '';
    const feedNote = kalshiOnlyLine ? ` ${kalshiOnlyLine}` : '';
    const leanTag = best.engineReady ? '' : ' · no spot lean';
    this.lastDecision =
      `Settle scan: best ${best.symbol} ${String(best.side).toUpperCase()} @ ${best.priceCents}¢` +
      ` (${valid.length} mid-band${leanTag}).${feedNote}${altNote}`;
    return valid;
  }

  async _findBestSettleOpportunity(predictions, { preferOtherThan = null } = {}) {
    const ranked = await this._rankSettleOpportunities(predictions, { preferOtherThan });
    return ranked[0] || null;
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
    const cooling = this._entryMissCooldownSymbols();
    const candidates = tradeableKalshiSymbols().filter(
      (sym) =>
        predictions[sym] &&
        !this._hasOpenOnSymbol(sym) &&
        !this._hasRecentEntryMiss(sym)
    );
    if (candidates.length === 0) {
      if (cooling.length) {
        this.lastDecision =
          `Waiting: recent fill misses on ${cooling.join(', ')} — cooling ~90s before retry.`;
      }
      return null;
    }
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
      if (b.rankScore !== a.rankScore) return b.rankScore - a.rankScore;
      return liquidityPriority(b.symbol) - liquidityPriority(a.symbol);
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
        insuranceDepositedCents: this.ledger.insuranceDepositedCents || 0,
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
  DISABLED_TRADE_SYMBOLS,
  isKalshiTradeEnabled,
  tradeableKalshiSymbols,
  liquidityPriority,
  LIQUIDITY_PRIORITY_BY_SYMBOL,
  settleEntryBand,
  settleLateEntryMinutes,
  settleLateEntryMinCents,
  settleEffectiveEntryBand,
  isSettleEntryPriceCents,
  isSettleStrategyMode,
  isSettleTrade,
  isSettleTieredExitsEnabled,
  settleExitPlan,
  settleExitTiersForDashboard,
  SETTLE_EXIT_TIERS,
  settleStuckHoldMs,
  settleRichAskFloorCents,
  settleRankAskScore,
  settleMinUpsideCents,
  stopRecoveryCentsRequired,
  stopRecoveryMaxAgeMs,
  peerCascadeMaxAgeMs,
  postStopMaxOneAgeMs,
  isPostStopMaxOneActive,
  postStopSameSideCooldownMs,
  checkPostStopSameSideCooldown,
  checkSameSideExitCooldown,
  settlePostStaleSameSideCooldownMs,
  SETTLE_STALE_MIN_HOLD_MS,
  SETTLE_STUCK_HOLD_DEFAULT_MINUTES,
  stopTradeReferenceMs,
  tradeWindowCloseMs,
  isPostStopRecoverySessionExpired,
  checkPostStopRecovery,
  checkPostStopPeerCascade,
  applyProfitBuckets,
  insuranceArmFloorCents,
  insuranceOverflowCents,
  syncInsuranceReady,
  normalizeInsuranceThresholds,
  INSURANCE_ARM_DEFAULT,
  INSURANCE_FLOOR_DEFAULT,
  INSURANCE_OVERFLOW_DEFAULT,
};
