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

function normalizeMarketPrices(market) {
  if (!market) return market;
  return {
    ...market,
    yes_bid: priceInCents(market.yes_bid, market.yes_bid_dollars),
    yes_ask: priceInCents(market.yes_ask, market.yes_ask_dollars),
    no_bid: priceInCents(market.no_bid, market.no_bid_dollars),
    no_ask: priceInCents(market.no_ask, market.no_ask_dollars),
    last_price: priceInCents(market.last_price, market.last_price_dollars),
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
 * priceCents is the limit on the traded outcome (1–99), same as legacy yes_price/no_price.
 */
function buildCreateOrderV2Body({ ticker, side, action, count, priceCents, clientOrderId }) {
  const rounded = Math.round(Number(priceCents));
  if (!Number.isFinite(rounded) || rounded < 1 || rounded > 99) {
    throw new Error(`Invalid Kalshi limit price: ${priceCents}`);
  }
  const contracts = Math.floor(Number(count));
  if (!Number.isFinite(contracts) || contracts < 1) {
    throw new Error(`Invalid Kalshi order count: ${count}`);
  }
  return {
    ticker,
    side: bookSideFromLegacy(side, action),
    count: `${contracts}.00`,
    price: (rounded / 100).toFixed(4),
    time_in_force: 'good_till_canceled',
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
  if (nested.fill_count == null && data && data.fill_count != null) {
    nested.fill_count = data.fill_count;
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

  async _request(method, path, { query, body, auth = true } = {}) {
    const qs = query
      ? '?' + new URLSearchParams(Object.entries(query).filter(([, v]) => v != null)).toString()
      : '';
    const url = `${this.baseUrl}${path}${qs}`;
    const headers = { 'Content-Type': 'application/json' };
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

  async getOpenMarkets(seriesTicker, limit = 5) {
    const data = await this._request('GET', '/markets', {
      query: { series_ticker: seriesTicker, status: 'open', limit },
      auth: false,
    });
    return (data.markets || []).map(normalizeMarketPrices);
  }

  async getMarket(ticker) {
    const data = await this._request('GET', `/markets/${ticker}`, { auth: false });
    return normalizeMarketPrices(data.market);
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
  async createOrder({ ticker, side, action, count, priceCents, clientOrderId }) {
    const body = buildCreateOrderV2Body({
      ticker,
      side,
      action,
      count,
      priceCents,
      clientOrderId,
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
  bookSideFromLegacy,
  buildCreateOrderV2Body,
  normalizeCreateOrderResponse,
};
