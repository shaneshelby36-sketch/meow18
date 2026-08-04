'use strict';

const crypto = require('crypto');
const fs = require('fs');
const fetch = require('node-fetch');

// Kalshi's current market endpoints return decimal-dollar strings such as
// "0.5600" in `yes_bid_dollars`; older responses used integer-cent fields
// such as `yes_bid`. Normalize both shapes so the trading bot always sees
// integer cents.
function priceInCents(legacyCents, dollarValue) {
  const legacy = Number(legacyCents);
  if (Number.isFinite(legacy)) return Math.round(legacy);
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

  /**
   * side: 'yes' | 'no'
   * action: 'buy' | 'sell'
   * priceCents: limit price in cents (1-99)
   */
  async createOrder({ ticker, side, action, count, priceCents, clientOrderId }) {
    const priceField = side === 'yes' ? 'yes_price' : 'no_price';
    return this._request('POST', '/portfolio/orders', {
      body: {
        ticker,
        side,
        action,
        count,
        type: 'limit',
        [priceField]: priceCents,
        client_order_id: clientOrderId || crypto.randomUUID(),
      },
    });
  }

  async cancelOrder(orderId) {
    return this._request('DELETE', `/portfolio/orders/${orderId}`);
  }
}

module.exports = { KalshiClient };
