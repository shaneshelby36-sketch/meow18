'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fetch = globalThis.fetch
  ? (...args) => globalThis.fetch(...args)
  : require('node-fetch');

// Kalshi's current market endpoints return decimal-dollar strings such as
// "0.5600" in `yes_bid_dollars`; older responses used integer-cent fields
// such as `yes_bid`. Normalize both shapes so the trading bot always sees
// integer cents.
function priceInCents(legacyCents, dollarValue) {
  // Treat null/undefined/'' as "missing" — Number(null)===0 would wrongly
  // prefer a fake 0¢ bid over a valid dollar-string quote.
  if (legacyCents != null && legacyCents !== '') {
    const legacy = Number(legacyCents);
    if (Number.isFinite(legacy)) return Math.round(legacy);
  }
  const dollars = Number.parseFloat(dollarValue);
  return Number.isFinite(dollars) ? Math.round(dollars * 100) : null;
}

function parseMarketCloseMs(market) {
  if (!market || typeof market !== 'object') return NaN;
  const closeRaw = market.close_time != null ? market.close_time : market.expected_expiration_time;
  if (closeRaw == null || closeRaw === '') return NaN;
  if (typeof closeRaw === 'number' && Number.isFinite(closeRaw)) {
    return closeRaw < 1e12 ? closeRaw * 1000 : closeRaw;
  }
  const ms = new Date(closeRaw).getTime();
  return Number.isFinite(ms) ? ms : NaN;
}

/**
 * Kalshi 15m crypto strike. List payloads sometimes omit `floor_strike`
 * (subtitle still has "Target Price: $63,048.28") or use cap-only `less`
 * markets. Never treat TBD / missing as 0.
 */
function marketStrikePrice(market) {
  if (!market || typeof market !== 'object') return null;
  const type = String(market.strike_type || market.strikeType || '').toLowerCase();
  const ordered =
    type === 'less' || type === 'less_or_equal'
      ? [market.cap_strike, market.capStrike, market.floor_strike, market.floorStrike]
      : [market.floor_strike, market.floorStrike, market.cap_strike, market.capStrike];
  ordered.push(market.strike_price, market.strikePrice, market.strike);
  for (const raw of ordered) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) return n;
  }
  const subtitle = String(
    market.yes_sub_title || market.yesSubTitle || market.subtitle || market.title || ''
  );
  const m = subtitle.match(/\$\s*([\d,]+(?:\.\d+)?)/);
  if (m) {
    const n = Number(String(m[1]).replace(/,/g, ''));
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function sizeFromFp(legacy, fpValue) {
  if (legacy != null && legacy !== '') {
    const n = Number(legacy);
    if (Number.isFinite(n) && n >= 0) return Math.floor(n);
  }
  const fp = Number.parseFloat(fpValue);
  return Number.isFinite(fp) && fp >= 0 ? Math.floor(fp) : null;
}

function normalizeMarketPrices(market) {
  if (!market) return market;
  return {
    ...market,
    yes_bid: priceInCents(market.yes_bid, market.yes_bid_dollars),
    yes_ask: priceInCents(market.yes_ask, market.yes_ask_dollars),
    no_bid: priceInCents(market.no_bid, market.no_bid_dollars),
    no_ask: priceInCents(market.no_ask, market.no_ask_dollars),
    last_price: priceInCents(market.last_price, market.last_price_dollars),
    yes_ask_size: sizeFromFp(market.yes_ask_size, market.yes_ask_size_fp),
    no_ask_size: sizeFromFp(market.no_ask_size, market.no_ask_size_fp),
    yes_bid_size: sizeFromFp(market.yes_bid_size, market.yes_bid_size_fp),
    no_bid_size: sizeFromFp(market.no_bid_size, market.no_bid_size_fp),
  };
}

/**
 * Map legacy (action, side) to V2 book_side.
 * bid ≡ yes exposure, ask ≡ no exposure (Kalshi single-book convention).
 */
function bookSideFromLegacy(side, action) {
  const s = String(side || '').toLowerCase();
  const a = String(action || '').toLowerCase();
  if ((a === 'buy' && s === 'yes') || (a === 'sell' && s === 'no')) return 'bid';
  if ((a === 'buy' && s === 'no') || (a === 'sell' && s === 'yes')) return 'ask';
  throw new Error(`Invalid Kalshi order direction: action=${action} side=${side}`);
}

/**
 * Build Create Order V2 body (POST /portfolio/events/orders).
 *
 * V2 uses a single YES-denominated book: `bid` = buy YES, `ask` = sell YES
 * (= buy NO at 1−price). `priceCents` from callers is always the traded
 * outcome limit (YES ¢ or NO ¢). For NO outcomes we convert to the YES-leg
 * wire price (100 − noCents) — sending the raw NO ¢ as `price` never crosses.
 */
function buildCreateOrderV2Body({
  ticker,
  side,
  action,
  count,
  priceCents,
  clientOrderId,
  timeInForce = 'good_till_canceled',
}) {
  const rounded = Math.round(Number(priceCents));
  if (!Number.isFinite(rounded) || rounded < 1 || rounded > 99) {
    throw new Error(`Invalid Kalshi limit price: ${priceCents}`);
  }
  const contracts = Math.floor(Number(count));
  if (!Number.isFinite(contracts) || contracts < 1) {
    throw new Error(`Invalid Kalshi order count: ${count}`);
  }
  const outcome = String(side || '').toLowerCase();
  const yesLegCents = outcome === 'no' ? 100 - rounded : rounded;
  if (yesLegCents < 1 || yesLegCents > 99) {
    throw new Error(`Invalid Kalshi YES-leg price from ${outcome} ${rounded}¢`);
  }
  const tif = String(timeInForce || 'good_till_canceled').toLowerCase();
  const allowedTif = new Set(['good_till_canceled', 'immediate_or_cancel', 'fill_or_kill']);
  return {
    ticker,
    side: bookSideFromLegacy(side, action),
    count: `${contracts}.00`,
    price: (yesLegCents / 100).toFixed(4),
    time_in_force: allowedTif.has(tif) ? tif : 'good_till_canceled',
    self_trade_prevention_type: 'taker_at_cross',
    client_order_id: clientOrderId || crypto.randomUUID(),
  };
}

/**
 * Accept V2 flat `{ order_id, fill_count, ... }`, legacy `{ order: { order_id } }`,
 * or occasional `{ orders: [{ order_id }] }`. Always expose a nested `order`
 * with fill fields preserved so callers can seed fill polling from create.
 */
function normalizeCreateOrderResponse(data) {
  const fromArray =
    data &&
    Array.isArray(data.orders) &&
    data.orders[0] &&
    typeof data.orders[0] === 'object'
      ? data.orders[0]
      : null;
  const orderId =
    (data && data.order_id) ||
    (data && data.orderId) ||
    (data && data.order && (data.order.order_id || data.order.orderId)) ||
    (fromArray && (fromArray.order_id || fromArray.orderId)) ||
    null;
  if (!orderId) {
    throw new Error('create order response missing order_id');
  }
  const nested =
    data && data.order && typeof data.order === 'object'
      ? { ...data.order, order_id: orderId }
      : fromArray
        ? { ...fromArray, order_id: orderId }
        : { ...(data || {}), order_id: orderId };
  // Preserve V2 immediate-fill fields on the nested order for seed polling.
  // Create Order V2 uses `fill_count`; keep `fills_count` alias for callers/tests.
  if (nested.fills_count == null) {
    const fc =
      (data && data.fills_count != null ? data.fills_count : null) ??
      (data && data.fill_count != null ? data.fill_count : null) ??
      nested.fill_count;
    if (fc != null) nested.fills_count = fc;
  }
  if (nested.fill_count == null && nested.fills_count != null) {
    nested.fill_count = nested.fills_count;
  }
  if (nested.fill_count_fp == null && data && data.fill_count_fp != null) {
    nested.fill_count_fp = data.fill_count_fp;
  }
  if (nested.remaining_count == null && data && data.remaining_count != null) {
    nested.remaining_count = data.remaining_count;
  }
  if (nested.average_fill_price == null && data && data.average_fill_price != null) {
    nested.average_fill_price = data.average_fill_price;
  }
  if (nested.average_fee_paid == null && data && data.average_fee_paid != null) {
    nested.average_fee_paid = data.average_fee_paid;
  }
  if (nested.taker_fees_dollars == null && data && data.taker_fees_dollars != null) {
    nested.taker_fees_dollars = data.taker_fees_dollars;
  }
  if (nested.maker_fees_dollars == null && data && data.maker_fees_dollars != null) {
    nested.maker_fees_dollars = data.maker_fees_dollars;
  }
  return { ...(data || {}), order: nested, order_id: orderId };
}

/**
 * Thin REST client for Kalshi's trading API.
 *
 * IMPORTANT: Kalshi's API surface (base URL, field names, endpoint paths)
 * has shifted between doc revisions in the past. Before relying on this in
 * production, cross-check every endpoint/field used below against the
 * current official reference at https://docs.kalshi.com and its
 * openapi.yaml — this file is written to be easy to patch if something
 * has moved.
 *
 * Auth: every private request is signed with RSA-PSS (SHA-256) over
 * `${timestampMs}${METHOD}${path}` (path only, no query string), using a
 * private key you generate yourself. Kalshi never sees the private key —
 * only the signature. Public market-data endpoints (GET /markets, GET
 * .../orderbook) do not require auth.
 */
class KalshiClient {
  constructor({ baseUrl, keyId, privateKeyPath, privateKeyPem }) {
    this.baseUrl = (baseUrl || 'https://api.elections.kalshi.com/trade-api/v2').replace(/\/+$/, '');
    this.keyId = keyId || null;
    this.privateKey = privateKeyPem || (privateKeyPath && fs.existsSync(privateKeyPath)
      ? fs.readFileSync(privateKeyPath, 'utf8')
      : null);
    this._openMarketsCache = new Map();
    this._openMarketsInflight = new Map();
    this._marketByTickerCache = new Map();
    this._marketByTickerInflight = new Map();
    this._publicGate = Promise.resolve();
    this._lastPublicAt = 0;
    this._cooldownUntil = 0;
    this._429LogAt = 0;
  }

  get hasCredentials() {
    return !!(this.keyId && this.privateKey);
  }

  /**
   * Update credentials at runtime (e.g. from a dashboard input) instead of
   * only at construction time. Never logs or echoes the private key back —
   * callers should only ever report hasCredentials, not the key itself.
   */
  setCredentials({ keyId, privateKeyPem }) {
    if (keyId) this.keyId = keyId;
    if (privateKeyPem) this.privateKey = privateKeyPem;
  }

  _sign(method, path) {
    const timestamp = Date.now().toString();
    // Kalshi signs the full URL pathname, including /trade-api/v2.
    const apiPrefix = new URL(this.baseUrl).pathname.replace(/\/$/, '');
    const message = `${timestamp}${method.toUpperCase()}${apiPrefix}${path}`;
    const signature = crypto.sign('sha256', Buffer.from(message), {
      key: this.privateKey,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    });
    return {
      'KALSHI-ACCESS-KEY': this.keyId,
      'KALSHI-ACCESS-TIMESTAMP': timestamp,
      'KALSHI-ACCESS-SIGNATURE': signature.toString('base64'),
    };
  }

  async _request(method, path, opts = {}) {
    const { query, body, auth = true } = opts;
    const qs = query
      ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString()
      : '';
    const url = `${this.baseUrl}${path}${qs}`;
    const headers = {
      'Content-Type': 'application/json',
      'User-Agent': 'crypto-prediction-engine',
      Accept: 'application/json',
    };
    if (auth) {
      if (!this.hasCredentials) throw new Error('Kalshi credentials not configured for an authenticated request');
      Object.assign(headers, this._sign(method, path));
    }
    const res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
    });
    const text = await res.text();
    let json;
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      json = { raw: text };
    }
    if (!res.ok) {
      const err = new Error(`Kalshi API ${method} ${path} -> HTTP ${res.status}: ${JSON.stringify(json)}`);
      err.status = res.status;
      err.body = json;
      throw err;
    }
    return json;
  }

  // ---------- public market data (no auth needed) ----------

  _noteRateLimit() {
    this._cooldownUntil = Date.now() + 20_000;
    if (Date.now() - this._429LogAt > 10_000) {
      this._429LogAt = Date.now();
      console.warn('[kalshi] rate limited (429) — pausing public GETs ~20s and using cached markets');
    }
  }

  async _withPublicGate(fn) {
    const run = this._publicGate.then(async () => {
      const wait = Math.max(
        0,
        this._cooldownUntil - Date.now(),
        this._lastPublicAt + 350 - Date.now()
      );
      if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
      this._lastPublicAt = Date.now();
      return fn();
    });
    this._publicGate = run.then(
      () => undefined,
      () => undefined
    );
    return run;
  }

  async _listOpenMarketsUncached(seriesTicker, limit) {
    const fetchList = async (query) => {
      const data = await this._request('GET', '/markets', {
        query: { series_ticker: seriesTicker, limit, ...query },
        auth: false,
      });
      return (data.markets || []).map(normalizeMarketPrices);
    };
    const usable = (list) =>
      (Array.isArray(list) ? list : []).filter((m) => {
        const s = String(m.status || '').toLowerCase();
        return !s || s === 'open' || s === 'active' || s === 'initialized' || s === 'unopened';
      });

    let open = usable(await fetchList({ status: 'open' }));
    if (!open.length) {
      open = usable(await fetchList({ min_close_ts: Math.floor(Date.now() / 1000) }));
    }
    return open;
  }

  async getOpenMarkets(seriesTicker, limit = 20) {
    if (!this._openMarketsCache) this._openMarketsCache = new Map();
    if (!this._openMarketsInflight) this._openMarketsInflight = new Map();
    const cacheKey = String(seriesTicker || '');
    const now = Date.now();
    const cached = this._openMarketsCache.get(cacheKey);
    if (cached && now - cached.at < 12_000) return cached.markets;

    const inflight = this._openMarketsInflight.get(cacheKey);
    if (inflight) return inflight;

    if (now < this._cooldownUntil) {
      if (cached) return cached.markets;
      return [];
    }

    const work = this._withPublicGate(async () => {
      try {
        if (Date.now() < this._cooldownUntil) {
          const again = this._openMarketsCache.get(cacheKey);
          return again ? again.markets : [];
        }
        const markets = await this._listOpenMarketsUncached(seriesTicker, limit);
        this._openMarketsCache.set(cacheKey, { at: Date.now(), markets });
        return markets;
      } catch (err) {
        if (err && err.status === 429) {
          this._noteRateLimit();
          if (cached) return cached.markets;
          return [];
        }
        if (cached && now - cached.at < 60_000) return cached.markets;
        console.warn(`[kalshi] getOpenMarkets ${seriesTicker}:`, err && err.message ? err.message : err);
        return cached ? cached.markets : [];
      } finally {
        this._openMarketsInflight.delete(cacheKey);
      }
    });

    this._openMarketsInflight.set(cacheKey, work);
    return work;
  }

  /**
   * Current tradeable 15m market for a series (soonest close still live).
   */
  async getLiveOpenMarket(seriesTicker, { minMsLeft = 1500, limit = 20 } = {}) {
    const markets = await this.getOpenMarkets(seriesTicker, limit);
    const pick = (floorMs) => {
      const nowMs = Date.now();
      const live = (Array.isArray(markets) ? markets : [])
        .map((m) => ({ m, closeMs: parseMarketCloseMs(m) }))
        .filter(({ closeMs }) => Number.isFinite(closeMs) && closeMs > nowMs + floorMs);
      if (!live.length) return null;
      live.sort((a, b) => a.closeMs - b.closeMs);
      return live[0].m;
    };
    return pick(minMsLeft) || pick(0);
  }

  async getMarket(ticker) {
    const key = String(ticker || '');
    if (!key) return null;
    if (!this._marketByTickerCache) this._marketByTickerCache = new Map();
    if (!this._marketByTickerInflight) this._marketByTickerInflight = new Map();
    const now = Date.now();
    const cached = this._marketByTickerCache.get(key);
    if (cached && now - cached.at < 1500) return cached.market;

    const inflight = this._marketByTickerInflight.get(key);
    if (inflight) return inflight;

    if (now < this._cooldownUntil && cached) return cached.market;

    const work = this._withPublicGate(async () => {
      try {
        if (Date.now() < this._cooldownUntil) {
          return cached ? cached.market : null;
        }
        const data = await this._request('GET', `/markets/${key}`, { auth: false });
        const market = normalizeMarketPrices(data.market);
        this._marketByTickerCache.set(key, { at: Date.now(), market });
        return market;
      } catch (err) {
        if (err && err.status === 429) this._noteRateLimit();
        if (cached) return cached.market;
        throw err;
      } finally {
        this._marketByTickerInflight.delete(key);
      }
    });
    this._marketByTickerInflight.set(key, work);
    return work;
  }

  async getOrderbook(ticker) {
    return this._request('GET', `/markets/${ticker}/orderbook`, { auth: false });
  }

  // ---------- authenticated trading endpoints ----------

  async getBalance() {
    return this._request('GET', '/portfolio/balance');
  }

  async getPositions() {
    const data = await this._request('GET', '/portfolio/positions');
    return data.market_positions || [];
  }

  async getOrder(orderId) {
    // Get Order remains on /portfolio/orders/{id} (full Order object with fill_count_fp).
    return this._request('GET', `/portfolio/orders/${orderId}`);
  }

  /**
   * side: 'yes' | 'no'
   * action: 'buy' | 'sell'
   * priceCents: limit price in cents (1-99) on the traded outcome
   *
   * Uses Create Order V2 (POST /portfolio/events/orders). Returns a shape
   * compatible with legacy callers: `{ order: { order_id, ... } }`.
   */
  async createOrder({ ticker, side, action, count, priceCents, clientOrderId, timeInForce }) {
    const body = buildCreateOrderV2Body({
      ticker,
      side,
      action,
      count,
      priceCents,
      clientOrderId,
      timeInForce,
    });
    const data = await this._request('POST', '/portfolio/events/orders', { body });
    return normalizeCreateOrderResponse(data);
  }

  async cancelOrder(orderId) {
    return this._request('DELETE', `/portfolio/events/orders/${orderId}`);
  }
}

module.exports = {
  KalshiClient,
  normalizeMarketPrices,
  priceInCents,
  marketStrikePrice,
  parseMarketCloseMs,
  bookSideFromLegacy,
  buildCreateOrderV2Body,
  normalizeCreateOrderResponse,
};
