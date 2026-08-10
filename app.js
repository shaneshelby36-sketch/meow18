'use strict';

// When the dashboard is served from the same place as the engine (e.g. one
// combined Render deployment), it should just talk to itself automatically
// — no manual settings needed. Falls back to localhost only if opened as a
// bare local file with no real origin.
const AUTO_ENGINE_URL =
  typeof window !== 'undefined' && window.location && window.location.origin && window.location.origin !== 'null'
    ? window.location.origin
    : 'http://localhost:4000';

const DEFAULTS = {
  engineUrl: AUTO_ENGINE_URL,
  refreshSeconds: 7,
};

const ASSET_LABELS = {
  BTC: 'Bitcoin',
  XRP: 'XRP',
  ETH: 'Ethereum',
  SOL: 'Solana',
  BNB: 'BNB',
  NEAR: 'NEAR',
  HYPE: 'HYPE',
  DOGE: 'Dogecoin',
  ZEC: 'Zcash',
};

// Non-asset keys that can appear alongside per-symbol entries in the
// /api/latest response — used to figure out which keys are actual assets.
const NON_ASSET_KEYS = new Set(['correlation', 'timestamp', 'feedStatus', 'message']);

const REC_CLASS = {
  'Strong Buy': 'strong-buy',
  Buy: 'buy',
  Wait: 'wait',
  Sell: 'sell',
  'Strong Sell': 'strong-sell',
};

const MAX_BROWSER_WINDOWS = 3;
const WINDOW_REGISTRY_KEY = 'cpe-window-registry';
const WINDOW_CHANNEL_NAME = 'cpe-windows';
const THIS_WINDOW_ID = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

function parseFocusView() {
  const view = new URLSearchParams(window.location.search).get('view');
  if (!view) return { mode: 'hub' };
  if (view.toLowerCase() === 'bot') return { mode: 'bot' };
  return { mode: 'asset', symbol: view.toUpperCase() };
}

const FOCUS_VIEW = parseFocusView();

let pollTimer = null;
let lastPrices = {};
let activeAssetSymbol = null;
let latestRankedSymbols = [];
let windowChannel = null;
const companionHandles = {};

// ---------- multi-window registry (max 3: 2 cryptos + bot) ----------

function readWindowRegistry() {
  try {
    const raw = JSON.parse(localStorage.getItem(WINDOW_REGISTRY_KEY) || '[]');
    return Array.isArray(raw) ? raw : [];
  } catch {
    return [];
  }
}

function writeWindowRegistry(entries) {
  localStorage.setItem(WINDOW_REGISTRY_KEY, JSON.stringify(entries.slice(0, MAX_BROWSER_WINDOWS)));
}

function registerThisWindow() {
  const role =
    FOCUS_VIEW.mode === 'bot' ? 'bot' : FOCUS_VIEW.mode === 'asset' ? `asset:${FOCUS_VIEW.symbol}` : 'hub';
  const now = Date.now();
  const entries = readWindowRegistry()
    .filter((e) => e && e.id && now - (e.seenAt || 0) < 60000)
    .filter((e) => e.id !== THIS_WINDOW_ID);
  entries.push({ id: THIS_WINDOW_ID, role, seenAt: now, href: location.href });
  writeWindowRegistry(entries);
  if (windowChannel) {
    windowChannel.postMessage({ type: 'ping', id: THIS_WINDOW_ID, role, href: location.href });
  }
  updateOpenWindowsButton();
}

function unregisterThisWindow() {
  writeWindowRegistry(readWindowRegistry().filter((e) => e.id !== THIS_WINDOW_ID));
  if (windowChannel) windowChannel.postMessage({ type: 'closed', id: THIS_WINDOW_ID });
}

function initWindowCoordination() {
  try {
    windowChannel = new BroadcastChannel(WINDOW_CHANNEL_NAME);
    windowChannel.onmessage = (event) => {
      const msg = event.data || {};
      if (msg.type === 'ping' || msg.type === 'closed') {
        registerThisWindow();
      }
    };
  } catch {
    windowChannel = null;
  }
  registerThisWindow();
  setInterval(registerThisWindow, 15000);
  window.addEventListener('beforeunload', unregisterThisWindow);
  window.addEventListener('pagehide', unregisterThisWindow);
}

function buildViewUrl(view) {
  const url = new URL(window.location.href);
  url.searchParams.set('view', view);
  return url.toString();
}

function openViewWindow(view, name) {
  const registry = readWindowRegistry().filter((e) => Date.now() - (e.seenAt || 0) < 60000);
  const role = view === 'bot' ? 'bot' : `asset:${String(view).toUpperCase()}`;
  const existingRole = registry.find((e) => e.role === role);
  if (existingRole && companionHandles[name] && !companionHandles[name].closed) {
    companionHandles[name].focus();
    return { ok: true, existing: true };
  }
  if (registry.length >= MAX_BROWSER_WINDOWS) {
    return { ok: false, reason: 'max' };
  }
  const handle = window.open(buildViewUrl(view), name, 'noopener,noreferrer');
  if (!handle) return { ok: false, reason: 'blocked' };
  companionHandles[name] = handle;
  registerThisWindow();
  return { ok: true };
}

function openOtherWindows() {
  const ranked = latestRankedSymbols;
  const btn = document.getElementById('open-windows-btn');

  if (FOCUS_VIEW.mode === 'hub') {
    const best = ranked[0];
    const second = ranked[1];
    let blocked = false;
    let opened = 0;

    // Turn this hub into the best-crypto window, and open the other two roles.
    if (second) {
      const result = openViewWindow(second, `cpe-${second}`);
      if (result.reason === 'blocked') blocked = true;
      if (result.ok && !result.existing) opened += 1;
    }
    {
      const result = openViewWindow('bot', 'cpe-bot');
      if (result.reason === 'blocked') blocked = true;
      if (result.ok && !result.existing) opened += 1;
    }

    if (blocked && btn) {
      btn.textContent = 'Pop-ups blocked — allow pop-ups, then try again';
      setTimeout(() => updateOpenWindowsButton(), 3500);
      return;
    }

    if (best) {
      window.location.assign(buildViewUrl(best));
      return;
    }

    updateOpenWindowsButton();
    if (btn && opened === 0) {
      btn.textContent = 'Windows already open';
      setTimeout(() => updateOpenWindowsButton(), 2500);
    }
    return;
  }

  const targets = [];
  if (FOCUS_VIEW.mode === 'asset') {
    const others = ranked.filter((s) => s !== FOCUS_VIEW.symbol).slice(0, 2);
    others.forEach((symbol) => targets.push({ view: symbol, name: `cpe-${symbol}` }));
    if (targets.length < 2) targets.push({ view: 'bot', name: 'cpe-bot' });
  } else {
    ranked.slice(0, 2).forEach((symbol) => targets.push({ view: symbol, name: `cpe-${symbol}` }));
  }

  const slotsLeft = Math.max(0, MAX_BROWSER_WINDOWS - 1);
  let opened = 0;
  let blocked = false;
  for (const target of targets) {
    if (opened >= slotsLeft) break;
    const result = openViewWindow(target.view, target.name);
    if (result.ok && !result.existing) opened += 1;
    if (result.reason === 'blocked') blocked = true;
  }
  updateOpenWindowsButton();
  if (!btn) return;
  if (blocked) {
    btn.textContent = 'Pop-ups blocked';
    setTimeout(() => updateOpenWindowsButton(), 2500);
  } else if (opened === 0) {
    btn.textContent = 'Windows already open';
    setTimeout(() => updateOpenWindowsButton(), 2500);
  }
}

function updateOpenWindowsButton() {
  const btn = document.getElementById('open-windows-btn');
  if (!btn) return;
  const count = readWindowRegistry().length;
  btn.textContent = count >= MAX_BROWSER_WINDOWS ? `Windows full (${count}/3)` : `Open other windows (${count}/3)`;
  btn.disabled = count >= MAX_BROWSER_WINDOWS && FOCUS_VIEW.mode !== 'hub';
}

function applyFocusModeLayout() {
  document.body.dataset.viewMode = FOCUS_VIEW.mode;
  if (FOCUS_VIEW.mode === 'asset') document.body.dataset.viewSymbol = FOCUS_VIEW.symbol;
  const note = document.getElementById('server-note');
  if (note && FOCUS_VIEW.mode !== 'hub') {
    note.textContent =
      FOCUS_VIEW.mode === 'bot'
        ? 'Bot window — trading still runs on the server if you close this.'
        : `${FOCUS_VIEW.symbol} window — predictions keep computing on the server.`;
  }
}

// ---------- settings persistence ----------

function loadSettings() {
  let engineUrl = localStorage.getItem('engineUrl') || DEFAULTS.engineUrl;
  let refreshSeconds = parseInt(localStorage.getItem('refreshSeconds') || '', 10);
  if (!refreshSeconds || refreshSeconds < 5 || refreshSeconds > 10) refreshSeconds = DEFAULTS.refreshSeconds;
  return { engineUrl: engineUrl.replace(/\/+$/, ''), refreshSeconds };
}

function saveSettings(engineUrl, refreshSeconds) {
  localStorage.setItem('engineUrl', engineUrl.replace(/\/+$/, ''));
  localStorage.setItem('refreshSeconds', String(refreshSeconds));
}

// ---------- rendering ----------

function ensurePanels(symbols) {
  const grid = document.getElementById('main-grid');
  const panelTpl = document.getElementById('asset-panel-template');
  const windowTpl = document.getElementById('window-card-template');

  for (const symbol of symbols) {
    if (grid.querySelector(`.asset-panel[data-symbol="${symbol}"]`)) continue; // already built

    const panel = panelTpl.content.firstElementChild.cloneNode(true);
    panel.dataset.symbol = symbol;
    panel.hidden = true; // hub only reveals the two featured cryptos
    panel.querySelector('.asset-symbol').textContent = symbol;
    panel.querySelector('.asset-name').textContent = ASSET_LABELS[symbol] || symbol;

    const row = panel.querySelector('.windows-row');
    for (let i = 0; i < 3; i++) {
      const card = windowTpl.content.firstElementChild.cloneNode(true);
      row.appendChild(card);
    }

    // Wire up tab clicks. A manual click "locks" the selection so the
    // real-time phase auto-switching (see updateActivePhase) stops
    // overriding what the user chose to look at — the glow on the tab
    // itself keeps showing the real current phase either way.
    panel.querySelectorAll('.window-tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        panel.dataset.userSelectedTab = 'true';
        selectTab(panel, tab.dataset.windowKey);
      });
    });
    // Default starting tab before any real data/phase info has arrived.
    selectTab(panel, 'w5');

    grid.appendChild(panel);
  }
}

function assetOpportunityScore(asset) {
  if (!asset || !asset.ready || !asset.overall) return -1;
  const conviction = Math.abs(Number(asset.overall.probabilityUp) - 50);
  const confidence = Number(asset.overall.confidence) || 0;
  // Favor a decisive call that the model itself trusts, rather than merely
  // a high confidence score with no directional edge.
  return conviction * (confidence / 100);
}

function rankAssets(data, symbols) {
  return [...symbols].sort((a, b) => {
    const difference = assetOpportunityScore(data[b]) - assetOpportunityScore(data[a]);
    return difference || a.localeCompare(b);
  });
}

function renderAssetTabs(symbols, data) {
  const picker = document.getElementById('asset-picker');
  const grid = document.getElementById('main-grid');
  const ranked = rankAssets(data, symbols);
  latestRankedSymbols = ranked;

  // Focused companion windows show exactly one panel.
  if (FOCUS_VIEW.mode === 'bot') {
    picker.replaceChildren();
    picker.hidden = true;
    grid.querySelectorAll('.asset-panel[data-symbol]').forEach((panel) => {
      panel.hidden = true;
    });
    const botCard = document.getElementById('bot-dashboard-card');
    if (botCard) {
      botCard.hidden = false;
      grid.appendChild(botCard);
    }
    updateOpenWindowsButton();
    return;
  }

  if (FOCUS_VIEW.mode === 'asset') {
    picker.hidden = true;
    picker.replaceChildren();
    const focusSymbol = ranked.includes(FOCUS_VIEW.symbol) ? FOCUS_VIEW.symbol : ranked[0];
    grid.querySelectorAll('.asset-panel[data-symbol]').forEach((panel) => {
      panel.hidden = panel.dataset.symbol !== focusSymbol;
    });
    const botCard = document.getElementById('bot-dashboard-card');
    if (botCard) botCard.hidden = true;
    if (focusSymbol) {
      const panel = grid.querySelector(`.asset-panel[data-symbol="${focusSymbol}"]`);
      if (panel) grid.appendChild(panel);
    }
    updateOpenWindowsButton();
    return;
  }

  // Hub: at most two best cryptos + the bot card (3 panels total).
  picker.hidden = false;
  const topSymbol = ranked[0] || null;
  if (!ranked.includes(activeAssetSymbol) || activeAssetSymbol === topSymbol) activeAssetSymbol = null;
  const featured = [topSymbol, activeAssetSymbol || ranked[1]].filter((symbol, index, arr) => symbol && arr.indexOf(symbol) === index).slice(0, 2);

  picker.replaceChildren();
  ranked.forEach((symbol, index) => {
    const asset = data[symbol];
    const tab = document.createElement('button');
    tab.type = 'button';
    tab.className = 'asset-tab' + (featured.includes(symbol) ? ' selected' : '');
    const rec = asset && asset.ready && asset.overall ? asset.overall.recommendation : 'Seeding';
    tab.textContent = `${index === 0 ? 'Best: ' : index === 1 ? '2nd: ' : ''}${symbol} · ${rec}`;
    tab.addEventListener('click', () => {
      // Second slot only — best stays pinned; never show more than 2 crypto panels.
      activeAssetSymbol = symbol === topSymbol ? null : symbol;
      renderAssetTabs(symbols, data);
    });
    picker.appendChild(tab);
  });

  grid.querySelectorAll('.asset-panel[data-symbol]').forEach((panel) => {
    panel.hidden = !featured.includes(panel.dataset.symbol);
  });
  featured.forEach((symbol) => {
    const panel = grid.querySelector(`.asset-panel[data-symbol="${symbol}"]`);
    if (panel) grid.appendChild(panel);
  });
  const botCard = document.getElementById('bot-dashboard-card');
  if (botCard) grid.appendChild(botCard);
  updateOpenWindowsButton();
}

// Shows the given window's card and marks its tab as selected, without
// touching the separate real-time-phase glow.
function selectTab(panel, windowKey) {
  panel.querySelectorAll('.window-tab').forEach((tab) => {
    tab.classList.toggle('selected', tab.dataset.windowKey === windowKey);
  });
  panel.querySelectorAll('.window-card').forEach((card) => {
    card.classList.toggle('tab-visible', card.dataset.windowKey === windowKey);
  });
}

function formatPrice(v, symbol) {
  if (v == null) return '—';
  const decimals = symbol === 'XRP' ? 4 : 2;
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

function renderAsset(symbol, assetData) {
  const panel = document.querySelector(`.asset-panel[data-symbol="${symbol}"]`);
  if (!panel || !assetData) return;

  const priceEl = panel.querySelector('.asset-price');
  const changeEl = panel.querySelector('.asset-price-change');
  const price = assetData.price;
  priceEl.textContent = price != null ? `$${formatPrice(price, symbol)}` : '—';

  const prev = lastPrices[symbol];
  if (prev != null && price != null) {
    const diff = price - prev;
    const pct = (diff / prev) * 100;
    changeEl.textContent = `${diff >= 0 ? '▲' : '▼'} ${Math.abs(pct).toFixed(3)}%`;
    changeEl.className = 'asset-price-change ' + (diff >= 0 ? 'up' : 'down');
  }
  if (price != null) lastPrices[symbol] = price;

  if (!assetData.ready) {
    const patternEl = panel.querySelector('.meta-pattern');
    if (patternEl) patternEl.textContent = 'Seeding history…';
    return;
  }

  // One shared target price per asset — Kalshi's real 15-minute strike when
  // available, otherwise the current price itself as a neutral fallback.
  const targetEl = panel.querySelector('.target-price');
  const sourceEl = panel.querySelector('.target-source');
  targetEl.textContent = assetData.targetPrice != null ? `$${formatPrice(assetData.targetPrice, symbol)}` : '—';
  sourceEl.textContent = assetData.targetSource === 'kalshi' ? 'Live Kalshi strike' : 'No Kalshi market found — using current price';
  if (assetData.targetCloseTime) {
    panel.dataset.targetCloseTime = String(assetData.targetCloseTime);
    updateBigCountdown(panel);
  }

  const snap = assetData.indicatorsSnapshot;
  panel.querySelector('.meta-rsi').textContent = snap.rsi != null ? snap.rsi.toFixed(0) : '—';
  panel.querySelector('.meta-macd').textContent = snap.macdHistogram != null ? snap.macdHistogram.toFixed(3) : '—';
  panel.querySelector('.meta-vol').textContent = snap.volatilityPct != null ? `${snap.volatilityPct.toFixed(2)}%` : '—';
  panel.querySelector('.meta-flow').textContent =
    snap.orderBookImbalance != null ? `${(snap.orderBookImbalance * 100).toFixed(0)}%` : '—';
  panel.querySelector('.meta-pattern').textContent = snap.candlePattern || '—';

  const cards = panel.querySelectorAll('.window-card');
  const windowKeys = ['w5', 'w10', 'w15'];
  windowKeys.forEach((key, i) => {
    const w = assetData.windows[key];
    const card = cards[i];
    if (!w || !card) return;
    card.dataset.windowKey = key;

    card.querySelector('.window-label').textContent = w.window;
    const recEl = card.querySelector('.window-rec');
    recEl.textContent = w.recommendation;
    recEl.className = 'window-rec ' + (REC_CLASS[w.recommendation] || 'wait');

    card.querySelector('.prob-up').style.width = `${w.probabilityUp}%`;
    card.querySelector('.prob-down').style.width = `${w.probabilityDown}%`;
    card.querySelector('.prob-up-text').textContent = `UP ${w.probabilityUp}%`;
    card.querySelector('.prob-down-text').textContent = `DOWN ${w.probabilityDown}%`;

    if (w.signalScore) {
      const { upScore, downScore, trend } = w.signalScore;
      const total = upScore + downScore || 1;
      card.querySelector('.signal-up-fill').style.width = `${(upScore / total) * 100}%`;
      card.querySelector('.signal-down-fill').style.width = `${(downScore / total) * 100}%`;
      card.querySelector('.signal-up-value').textContent = `UP ${upScore.toFixed(1)}`;
      card.querySelector('.signal-down-value').textContent = `DOWN ${downScore.toFixed(1)}`;
      const badge = card.querySelector('.signal-trend-badge');
      badge.textContent = trend === 'strengthening' ? '↗ Strengthening' : trend === 'weakening' ? '↘ Weakening' : '→ Flat';
      badge.className = `signal-trend-badge ${trend}`;
    }

    card.querySelector('.confidence-value').textContent = `${w.confidence}%`;
    card.querySelector('.risk-value').textContent = `${w.riskAdjustmentPct}%`;
    card.querySelector('.window-explanation').textContent = w.explanation;

    // Live countdown to when this specific checkpoint settles (all three
    // windows share one baseline price, shown once at the top of the panel)
    if (w.tracking) {
      card.dataset.targetTime = String(w.tracking.targetTime);
      updateCountdownEl(card);
    }

    // Most recent settled result for this window, if any
    const resultBox = card.querySelector('.track-result');
    if (w.lastResult) {
      resultBox.classList.remove('hidden');
      const badge = resultBox.querySelector('.result-badge');
      const text = resultBox.querySelector('.result-text');
      badge.textContent = w.lastResult.correct ? 'CORRECT' : 'MISSED';
      badge.className = 'result-badge ' + (w.lastResult.correct ? 'win' : 'loss');
      const dir = w.lastResult.actualDirection;
      const pct = w.lastResult.changePct;
      text.textContent = `Last settled: went ${dir} ${Math.abs(pct).toFixed(3)}% (predicted ${w.lastResult.predictedDirection})`;
    } else {
      resultBox.classList.add('hidden');
    }

    // Rolling accuracy for this asset/window pair
    const accEl = card.querySelector('.accuracy-value');
    if (w.accuracy && w.accuracy.sampleSize > 0) {
      accEl.textContent = `${w.accuracy.correctCount}/${w.accuracy.sampleSize} correct (${w.accuracy.accuracyPct}%)`;
    } else {
      accEl.textContent = 'No settled predictions yet';
    }
  });
}

function updateCountdownEl(card) {
  const el = card.querySelector('.countdown-value');
  const target = parseInt(card.dataset.targetTime || '0', 10);
  if (!target) {
    el.textContent = '—';
    return;
  }
  const remainingMs = target - Date.now();
  if (remainingMs <= 0) {
    el.textContent = 'Next window…';
    el.classList.add('settling');
    return;
  }
  el.classList.remove('settling');
  const totalSeconds = Math.round(remainingMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  el.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
}

function tickAllCountdowns() {
  document.querySelectorAll('.window-card').forEach(updateCountdownEl);
  document.querySelectorAll('.asset-panel').forEach((panel) => {
    updateBigCountdown(panel);
    updateActivePhase(panel);
  });
  updateBotRuntimeDisplays();
}

function updateBigCountdown(panel) {
  const el = panel.querySelector('.big-countdown');
  if (!el) return;
  const target = parseInt(panel.dataset.targetCloseTime || '0', 10);
  if (!target) {
    el.textContent = '—';
    return;
  }
  const remainingMs = target - Date.now();
  if (remainingMs <= 0) {
    // Gap between Kalshi windows (or a stale close time). Do not sit on
    // "Settling…" forever — the next poll should pick up a fresh market.
    el.textContent = 'Next window…';
    el.classList.add('settling');
    return;
  }
  el.classList.remove('settling');
  const totalSeconds = Math.round(remainingMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  el.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
}

// Highlights whichever window (0-5 / 5-10 / 10-15 min) matches where we
// actually are right now in the real Kalshi 15-minute window, based on the
// same close time driving the big countdown at the top of the panel. Also
// auto-switches which tab is visible to follow the real phase, UNLESS the
// user has manually picked a tab of their own — the glow itself, though,
// always shows the real phase regardless of manual selection.
function updateActivePhase(panel) {
  const target = parseInt(panel.dataset.targetCloseTime || '0', 10);
  const tabs = panel.querySelectorAll('.window-tab');
  if (!target) {
    tabs.forEach((t) => t.classList.remove('active-phase'));
    return;
  }
  const secondsRemaining = Math.max(0, Math.round((target - Date.now()) / 1000));
  let activeKey;
  if (secondsRemaining > 600) activeKey = 'w5'; // more than 10 min left -> still in the first 5 minutes
  else if (secondsRemaining > 300) activeKey = 'w10'; // 5-10 min left -> in the middle stretch
  else activeKey = 'w15'; // 5 min or less left -> final stretch

  tabs.forEach((tab) => {
    tab.classList.toggle('active-phase', tab.dataset.windowKey === activeKey);
  });

  if (panel.dataset.userSelectedTab !== 'true') {
    selectTab(panel, activeKey);
  }
}

function setStatus(state, text) {
  const dot = document.getElementById('status-dot');
  const label = document.getElementById('status-text');
  dot.className = 'status-dot ' + (state === 'live' ? 'live' : state === 'down' ? 'down' : '');
  label.textContent = text;
}

function setAppVersion(version) {
  if (!version) return;
  const text = `v${String(version).replace(/^v/i, '')}`;
  document.querySelectorAll('#app-version, [data-app-version], .app-version').forEach((el) => {
    el.textContent = text;
  });
}

function renderUpdatedTime() {
  const el = document.getElementById('updated-text');
  const now = new Date();
  el.textContent = `Updated ${now.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}`;
}

// ---------- polling ----------

async function fetchLatest() {
  const { engineUrl } = loadSettings();
  try {
    const res = await fetch(`${engineUrl}/api/latest`, { cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    const assetSymbols = Object.keys(data).filter((k) => !NON_ASSET_KEYS.has(k));

    if (data.message && assetSymbols.length === 0) {
      setStatus('wait', data.message);
      return;
    }

    ensurePanels(assetSymbols);
    for (const symbol of assetSymbols) {
      renderAsset(symbol, data[symbol]);
    }
    renderAssetTabs(assetSymbols, data);
    refreshBotStatus();
    renderUpdatedTime();
    setStatus('live', 'Live');
  } catch (err) {
    setStatus('down', 'Connection lost — retrying…');
    console.error('[dashboard] fetch failed:', err.message);
  }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  const { refreshSeconds } = loadSettings();
  fetchLatest();
  pollTimer = setInterval(fetchLatest, refreshSeconds * 1000);
}

// ---------- settings overlay ----------

function openSettings() {
  const { engineUrl, refreshSeconds } = loadSettings();
  document.getElementById('engine-url').value = engineUrl;
  document.getElementById('refresh-interval').value = refreshSeconds;
  document.getElementById('settings-overlay').classList.remove('hidden');
}

function closeSettings() {
  document.getElementById('settings-overlay').classList.add('hidden');
}

function wireSettingsUI() {
  document.getElementById('settings-btn').addEventListener('click', openSettings);
  document.getElementById('settings-cancel').addEventListener('click', closeSettings);
  document.getElementById('settings-save').addEventListener('click', () => {
    const url = document.getElementById('engine-url').value.trim() || DEFAULTS.engineUrl;
    let refresh = parseInt(document.getElementById('refresh-interval').value, 10);
    if (!refresh || refresh < 5) refresh = 5;
    if (refresh > 10) refresh = 10;
    saveSettings(url, refresh);
    closeSettings();
    startPolling();
  });
}

// ---------- bot overlay: live status, editable settings, backtest ----------

async function loadCalibration() {
  const { engineUrl } = loadSettings();
  const container = document.getElementById('calibration-table');
  try {
    const res = await fetch(`${engineUrl}/api/bot/calibration`, { cache: 'no-store' });
    if (!res.ok) {
      container.innerHTML = '<p class="settings-hint">Bot not enabled — no calibration data yet.</p>';
      return;
    }
    const data = await res.json();
    if (!data.buckets || data.buckets.length === 0) {
      container.innerHTML = '<p class="settings-hint">No settled trades yet — this fills in as the bot trades over time.</p>';
      return;
    }
    const qualityLabel = { too_few: 'Too few to trust yet', minimal: 'Minimal — starting to mean something', good: 'Good sample size', best: 'Strong sample size' };
    const rows = data.buckets
      .map(
        (b) => `
      <div class="calibration-row quality-${b.sampleQuality}">
        <span class="cal-range">${b.range}</span>
        <span class="cal-trades">${b.trades} trades</span>
        <span class="cal-wins">${b.wins} wins</span>
        <span class="cal-rate">${b.winRatePct != null ? b.winRatePct + '%' : '—'}</span>
        <span class="cal-quality">${qualityLabel[b.sampleQuality]}</span>
      </div>`
      )
      .join('');
    container.innerHTML = `
      <div class="calibration-row calibration-header">
        <span class="cal-range">Probability</span>
        <span class="cal-trades">Trades</span>
        <span class="cal-wins">Wins</span>
        <span class="cal-rate">Win rate</span>
        <span class="cal-quality">Sample</span>
      </div>
      ${rows}`;
  } catch (err) {
    container.innerHTML = `<p class="settings-hint">Could not load calibration data: ${err.message}</p>`;
  }
}

function openBotOverlay() {
  document.getElementById('bot-overlay').classList.remove('hidden');
  refreshBotStatus();
  loadBotConfigIntoForm();
  loadKalshiCredentialsStatus();
  loadCalibration();
}

function closeBotOverlay() {
  document.getElementById('bot-overlay').classList.add('hidden');
}

async function refreshBotStatus() {
  const { engineUrl } = loadSettings();
  const modeLine = document.getElementById('bot-mode-line');
  const persistLine = document.getElementById('bot-persist-line');
  const body = document.getElementById('bot-status-body');
  try {
    const healthRes = await fetch(`${engineUrl}/api/health`, { cache: 'no-store' });
    if (healthRes.ok) {
      const health = await healthRes.json();
      setAppVersion(health.version);
      if (persistLine) {
        if (health.dataDirEphemeral) {
          persistLine.hidden = false;
          persistLine.style.color = 'var(--wait)';
          persistLine.textContent =
            'Warning: Render disk is ephemeral — Save works until the next restart, then settings reset. Attach a Persistent Disk at /var/data.';
        } else {
          persistLine.hidden = false;
          persistLine.style.color = 'var(--up)';
          persistLine.textContent = health.configFileExists
            ? `Settings persist on disk (${health.dataDir}).`
            : `Durable data dir ready (${health.dataDir}) — save settings once to create the config file.`;
        }
      }
    }

    const res = await fetch(`${engineUrl}/api/bot/status`, { cache: 'no-store' });
    const data = await res.json();
    setAppVersion(data.version);
    if (!data.enabled) {
      modeLine.textContent = data.message || 'Bot is not enabled on the engine.';
      body.innerHTML = '';
      renderBotDashboard(data);
      return;
    }
    const mode = data.config.mode;
    modeLine.textContent = `Mode: ${mode === 'live' ? 'LIVE (real orders)' : 'Paper (simulated)'} · ${data.config.strategyMode === 'settle' ? 'Settle' : 'Edge'} · Trading ${data.config.symbol}`;
    updateModeButtons(mode, data.config.liveAuthorized);

    const chips = [];
    chips.push(chip('Lifetime trades', data.tradeLogTotal != null ? data.tradeLogTotal : '—'));
    chips.push(chip('Trades opened', data.stats.totalAttempts));
    chips.push(chip('Settled', data.stats.totalTrades));
    chips.push(chip('Profitable exits', data.stats.profitableExits));
    chips.push(chip('Win rate', data.stats.winRatePct != null ? `${data.stats.winRatePct}%` : '—'));
    chips.push(chip('Current streak', `${data.stats.currentWinStreak} win${data.stats.currentWinStreak === 1 ? '' : 's'}`));
    chips.push(chip('Best streak', `${data.stats.longestWinStreak} win${data.stats.longestWinStreak === 1 ? '' : 's'}`));
    if (Number(data.overdueOpenCount) > 0) {
      chips.push(chip('Overdue (force-settling)', data.overdueOpenCount));
    }
    const capital = data.capital;
    if (capital && data.config.mode === 'live') {
      chips.push(chip('Kalshi available', capital.liveAvailableCents == null ? 'Checking…' : `$${(capital.liveAvailableCents / 100).toFixed(2)}`));
    }
    if (data.lastDecision) chips.push(chip('Decision', data.lastDecision));
    if (data.lastError) chips.push(chip('Last error', data.lastError));
    renderSettleWindowRec(data.settleWindowRec);
    const activityScroll = captureLogScroll('bot-activity-log-list', 'bottom');
    const tradeScroll = captureLogScroll('bot-trade-log-list', 'top');
    body.innerHTML = [
      buildCapitalLedgerHtml(capital, { depositControls: true }),
      buildHourlyPnlHtml(data.hourlyPnl || (data.stats && data.stats.hourlyPnl)),
      buildOpenPositionsHtml(data.openTrades),
      `<div class="bot-stat-chips">${chips.join('')}</div>`,
      buildTradeLogHtml(data.tradeLog, data.tradeLogTotal),
      buildActivityLogHtml(data.activityLog, data.recentTrades),
    ].join('');
    restoreLogScroll('bot-activity-log-list', activityScroll, 'bottom');
    restoreLogScroll('bot-trade-log-list', tradeScroll, 'top');
    bindActivityLogUi();
    bindTradeLogUi();
    renderBotDashboard(data);
  } catch (err) {
    modeLine.textContent = 'Could not reach the engine to check bot status.';
    body.innerHTML = '';
  }
}

function formatBotRuntime(runningSince) {
  if (!runningSince) return 'Stopped';
  const seconds = Math.max(0, Math.floor((Date.now() - runningSince) / 1000));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
}

let lastBotRunningSince = null;
let lastBotIsRunning = false;

function updateBotRuntimeDisplays() {
  const runtimeText = lastBotIsRunning ? formatBotRuntime(lastBotRunningSince) : 'Stopped';
  const runtimeEl = document.getElementById('bot-runtime-value');
  if (runtimeEl) {
    runtimeEl.textContent = lastBotIsRunning ? `Running ${runtimeText}` : 'Stopped';
    runtimeEl.classList.toggle('is-running', lastBotIsRunning);
    runtimeEl.classList.toggle('is-stopped', !lastBotIsRunning);
  }
  const banner = document.getElementById('bot-runtime-banner');
  if (banner) {
    banner.hidden = false;
    banner.classList.toggle('is-running', lastBotIsRunning);
  }
  const timer = document.getElementById('bot-running-timer');
  if (timer) timer.textContent = lastBotIsRunning ? `Running ${runtimeText}` : 'Stopped';
}

function renderBotDashboard(data) {
  const card = document.getElementById('bot-dashboard-card');
  if (!card) return;
  if (FOCUS_VIEW.mode === 'asset') {
    card.hidden = true;
    return;
  }
  if (FOCUS_VIEW.mode === 'bot') {
    card.hidden = false;
  } else {
    card.hidden = !data.enabled;
  }
  if (card.hidden) return;
  const state = document.getElementById('bot-dashboard-state');
  const stats = document.getElementById('bot-dashboard-stats');
  const toggle = document.getElementById('bot-dashboard-toggle');
  if (!data.enabled) {
    state.textContent = data.message || 'Bot not enabled on the server (set KALSHI_ENABLED=true).';
    stats.innerHTML = '';
    toggle.hidden = true;
    lastBotIsRunning = false;
    lastBotRunningSince = null;
    updateBotRuntimeDisplays();
    return;
  }
  toggle.hidden = false;
  lastBotIsRunning = !!data.isRunning;
  lastBotRunningSince = data.isRunning ? (Number(data.runningSince) || Date.now()) : null;
  updateBotRuntimeDisplays();

  const mode = data.config.mode === 'live' ? 'LIVE' : 'PAPER';
  state.textContent = `${mode} · ${data.config.strategyMode === 'settle' ? 'Settle' : 'Edge'} · ${data.config.symbol || '—'} · ${formatSkimLabel(data.config)} · ${data.lastDecision || ''}`;
  const capital = data.capital || {};
  const openCount = (data.openTrades || []).length;
  stats.innerHTML = [
    buildCapitalLedgerHtml(capital, { depositControls: false }),
    buildOpenPositionsHtml(data.openTrades),
    chip('Open', openCount),
    chip('Trades opened', data.stats.totalAttempts),
    chip('Lifetime log', data.tradeLogTotal != null ? data.tradeLogTotal : data.stats.lifetimeTrades || 0),
    chip('Profitable exits', data.stats.profitableExits),
    buildTradeLogHtml(data.tradeLog, data.tradeLogTotal),
  ].join('');
  toggle.textContent = data.isRunning ? 'Stop new trades' : 'Start bot';
  toggle.dataset.running = String(!data.isRunning);
  const overlayToggle = document.getElementById('bot-running-toggle');
  if (overlayToggle) overlayToggle.textContent = toggle.textContent;
}

async function setBotRunning(running) {
  const { engineUrl } = loadSettings();
  try {
    const res = await fetch(`${engineUrl}/api/bot/running`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ running }),
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || 'Could not update bot state.');
    await refreshBotStatus();
  } catch (err) {
    console.error('[dashboard] bot state update failed:', err.message);
  }
}

function formatTradeTime(ms) {
  if (!Number.isFinite(ms)) return '—';
  const d = new Date(ms);
  return d.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function formatCloseCountdown(closeTime) {
  if (!Number.isFinite(closeTime)) return '—';
  const remainingMs = closeTime - Date.now();
  if (remainingMs <= 0) {
    // Past close: bot should force-settle within a cycle. Don't imply a
    // forever "Settling…" hang on the open-positions list.
    const overdueSec = Math.round(-remainingMs / 1000);
    if (overdueSec > 20) return `overdue ${overdueSec}s`;
    return 'closing…';
  }
  const totalSeconds = Math.round(remainingMs / 1000);
  const mm = Math.floor(totalSeconds / 60);
  const ss = totalSeconds % 60;
  return `${mm}:${String(ss).padStart(2, '0')} left`;
}

function buildOpenPositionsHtml(openTrades) {
  const opens = (openTrades || []).filter(Boolean);
  if (!opens.length) {
    return `
      <div class="bot-positions">
        <div class="bot-panel-title">Open positions <span>0</span></div>
        <p class="bot-empty-line">No open positions.</p>
      </div>`;
  }
  const rows = opens
    .map((t) => {
      const side = String(t.side || '').toUpperCase();
      const entry = Number.isFinite(t.entryPriceCents) ? `${t.entryPriceCents}¢` : '—';
      const stake = Number.isFinite(t.stakeDollars) ? `$${Number(t.stakeDollars).toFixed(2)}` : '—';
      const contracts = Number.isFinite(t.contracts) ? t.contracts : '—';
      const conf = Number.isFinite(t.engineConfidence) ? `${t.engineConfidence}%` : '—';
      const strategy = t.strategy === 'settle' ? 'Settle' : 'Edge';
      return `
        <div class="bot-position-row">
          <div class="bot-position-main">
            <strong>${t.symbol || '?'} ${side}</strong>
            <span>${entry} · ${contracts} ct · ${stake} · ${strategy}</span>
          </div>
          <div class="bot-position-meta">
            <span>Opened ${formatTradeTime(t.openedAt)}</span>
            <span>${formatCloseCountdown(Number(t.windowCloseTime))}</span>
            <span>Conf ${conf}</span>
          </div>
        </div>`;
    })
    .join('');
  return `
    <div class="bot-positions">
      <div class="bot-panel-title">Open positions <span>${opens.length}</span></div>
      ${rows}
    </div>`;
}

function buildTradeLogHtml(tradeLog, tradeLogTotal) {
  const trades = Array.isArray(tradeLog) ? tradeLog : [];
  const total = Number.isFinite(tradeLogTotal) ? tradeLogTotal : trades.length;
  if (!trades.length) {
    return `
      <div class="bot-log bot-trade-log">
        <div class="bot-panel-title">Trade log <span>0</span></div>
        <p class="bot-empty-line">No trades saved yet. Every open/close is written to disk and stays after the 12h stats rotation.</p>
      </div>`;
  }

  const rows = trades
    .map((t) => {
      const side = String(t.side || '').toUpperCase();
      const status = t.status === 'open' ? 'OPEN' : String(t.exitReason || 'closed').toUpperCase();
      const entry = Number.isFinite(t.entryPriceCents) ? `${t.entryPriceCents}¢` : '—';
      const exit = Number.isFinite(t.exitPriceCents) ? `${t.exitPriceCents}¢` : '—';
      const pnl = t.status === 'closed' && Number.isFinite(t.pnlCents) ? t.pnlCents : null;
      const pnlClass =
        pnl != null && pnl > 0 ? 'chip-positive' : pnl != null && pnl < 0 ? 'chip-negative' : '';
      const skim =
        Number.isFinite(t.skimmedCents) && t.skimmedCents > 0
          ? ` · skim $${(t.skimmedCents / 100).toFixed(2)}`
          : '';
      const fees =
        Number.isFinite(t.feesCents) && t.feesCents > 0
          ? ` · fees $${(t.feesCents / 100).toFixed(2)}`
          : '';
      const conf = Number.isFinite(t.engineConfidence) ? ` · conf ${t.engineConfidence}%` : '';
      let stopNote = '';
      let stopCopy = '';
      if (t.exitReason === 'stop_loss') {
        if (t.stopVerdictPending || t.stopVerdict === 'pending') {
          stopNote = `<span class="bot-log-sub stop-verdict pending">Stop review: checking whether this prevented more loss or missed a bounce…</span>`;
          stopCopy = 'Stop review pending';
        } else if (t.stopVerdict === 'prevented_loss') {
          const detail = t.stopVerdictDetail || 'Stop helped — prevented further loss';
          stopNote = `<span class="bot-log-sub stop-verdict helped">${escapeHtml(detail)}</span>`;
          stopCopy = detail;
        } else if (t.stopVerdict === 'missed_opportunity') {
          const detail = t.stopVerdictDetail || 'Missed opportunity — would have recovered';
          stopNote = `<span class="bot-log-sub stop-verdict missed">${escapeHtml(detail)}</span>`;
          stopCopy = detail;
        } else if (t.stopVerdict === 'mixed') {
          const detail = t.stopVerdictDetail || 'Stop outcome unclear';
          stopNote = `<span class="bot-log-sub stop-verdict mixed">${escapeHtml(detail)}</span>`;
          stopCopy = detail;
        }
      }
      const rowId = escapeHtml(t.id || `${t.symbol || 'x'}-${t.openedAt || ''}-${t.closedAt || ''}`);
      const copyLine = [
        formatTradeTime(t.closedAt || t.openedAt),
        `${t.symbol || '?'} ${side}`,
        status,
        `${entry}${t.status === 'closed' ? ` → ${exit}` : ''}`,
        Number.isFinite(t.stakeDollars) ? `$${Number(t.stakeDollars).toFixed(2)}` : null,
        conf ? conf.replace(/^\s·\s/, '') : null,
        fees ? fees.replace(/^\s·\s/, '') : null,
        skim ? skim.replace(/^\s·\s/, '') : null,
        `opened ${formatTradeTime(t.openedAt)}${t.mode ? ` · ${t.mode}` : ''}`,
        stopCopy || null,
        pnl != null ? formatMoneyCents(pnl, { signed: true }) : t.status === 'open' ? 'open' : null,
      ]
        .filter(Boolean)
        .join(' · ');
      return `
        <div class="bot-log-row kind-${t.status === 'open' ? 'open' : 'close'}" data-log-id="${rowId}" data-copy-line="${escapeHtml(copyLine)}">
          <span class="bot-log-time">${formatTradeTime(t.closedAt || t.openedAt)}</span>
          <span class="bot-log-msg">
            <strong>${t.symbol || '?'} ${side}</strong>
            ${status} · ${entry}${t.status === 'closed' ? ` → ${exit}` : ''}
            ${Number.isFinite(t.stakeDollars) ? ` · $${Number(t.stakeDollars).toFixed(2)}` : ''}${conf}${fees}${skim}
            <span class="bot-log-sub">opened ${formatTradeTime(t.openedAt)}${t.mode ? ` · ${t.mode}` : ''}</span>
            ${stopNote}
          </span>
          <span class="bot-log-pnl ${pnlClass}">${pnl != null ? formatMoneyCents(pnl, { signed: true }) : t.status === 'open' ? 'open' : ''}</span>
        </div>`;
    })
    .join('');

  return `
    <div class="bot-log bot-trade-log">
      <div class="bot-panel-title">Trade log <span>${total}</span> <button type="button" class="bot-log-copy" id="bot-trade-copy" title="Copy trade log text">Copy</button></div>
      <p class="bot-empty-line">Saved on disk (survives reboot + 12h rotation). Showing latest ${trades.length}${total > trades.length ? ` of ${total}` : ''}.</p>
      <div class="bot-log-list" id="bot-trade-log-list">${rows}</div>
    </div>`;
}

function buildHourlyPnlHtml(hourlyPnl) {
  const buckets = Array.isArray(hourlyPnl) ? hourlyPnl : [];
  if (!buckets.length) return '';
  const rows = buckets
    .map((b) => {
      const pnl = Number(b.pnlCents) || 0;
      const pnlClass = pnl > 0 ? 'chip-positive' : pnl < 0 ? 'chip-negative' : '';
      const trades = Number(b.trades) || 0;
      return `
        <div class="hourly-pnl-row">
          <span class="hourly-pnl-hour">${escapeHtml(b.label || '—')}</span>
          <span class="hourly-pnl-trades">${trades} trade${trades === 1 ? '' : 's'}</span>
          <span class="hourly-pnl-value ${pnlClass}">${formatMoneyCents(pnl, { signed: true })}</span>
        </div>`;
    })
    .join('');
  const total = buckets.reduce((sum, b) => sum + (Number(b.pnlCents) || 0), 0);
  const totalClass = total > 0 ? 'chip-positive' : total < 0 ? 'chip-negative' : '';
  return `
    <div class="hourly-pnl">
      <div class="bot-panel-title">P&amp;L by hour <span>last 6h</span></div>
      <div class="hourly-pnl-list">${rows}</div>
      <div class="hourly-pnl-total">
        <span>6h total</span>
        <span class="${totalClass}">${formatMoneyCents(total, { signed: true })}</span>
      </div>
    </div>`;
}

const LOG_STICKY_PX = 64;

function captureLogScroll(id, mode = 'bottom') {
  const el = document.getElementById(id);
  if (!el) return null;
  const nearLatest =
    mode === 'bottom'
      ? el.scrollHeight - el.scrollTop - el.clientHeight <= LOG_STICKY_PX
      : el.scrollTop <= LOG_STICKY_PX;
  let anchorId = null;
  let anchorOffset = 0;
  for (const child of el.children) {
    if (!(child instanceof HTMLElement)) continue;
    if (child.offsetTop + child.offsetHeight > el.scrollTop + 1) {
      anchorId = child.getAttribute('data-log-id') || child.id || null;
      anchorOffset = child.offsetTop - el.scrollTop;
      break;
    }
  }
  return { scrollTop: el.scrollTop, stickToLatest: nearLatest, mode, anchorId, anchorOffset };
}

function restoreLogScroll(id, state, defaultMode = 'bottom') {
  const el = document.getElementById(id);
  if (!el) return;
  const mode = (state && state.mode) || defaultMode;
  const apply = () => {
    if (!state || state.stickToLatest) {
      el.scrollTop = mode === 'bottom' ? el.scrollHeight : 0;
      return;
    }
    if (state.anchorId) {
      const anchor = el.querySelector(`[data-log-id="${CSS.escape(String(state.anchorId))}"]`);
      if (anchor instanceof HTMLElement) {
        el.scrollTop = Math.max(0, anchor.offsetTop - (Number(state.anchorOffset) || 0));
        return;
      }
    }
    el.scrollTop = state.scrollTop;
  };
  apply();
  // Second pass after images/fonts/layout — keep the same row under the thumb.
  requestAnimationFrame(apply);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function bindActivityLogUi() {
  const list = document.getElementById('bot-activity-log-list');
  const copyBtn = document.getElementById('bot-activity-copy');
  if (!copyBtn || !list) return;
  copyBtn.onclick = () => {
    const text = Array.from(list.querySelectorAll('.bot-log-row'))
      .map((row) => row.innerText.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .join('\n');
    if (!text) return;
    const done = () => {
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        fallbackCopyText(text);
        done();
      });
    } else {
      fallbackCopyText(text);
      done();
    }
  };
}

function bindTradeLogUi() {
  const list = document.getElementById('bot-trade-log-list');
  const copyBtn = document.getElementById('bot-trade-copy');
  if (!copyBtn || !list) return;
  copyBtn.onclick = () => {
    const text = Array.from(list.querySelectorAll('.bot-log-row'))
      .map((row) => {
        const fromAttr = row.getAttribute('data-copy-line');
        if (fromAttr && fromAttr.trim()) return fromAttr.trim();
        return row.innerText.replace(/\s+/g, ' ').trim();
      })
      .filter(Boolean)
      .join('\n');
    if (!text) return;
    const done = () => {
      copyBtn.textContent = 'Copied';
      setTimeout(() => {
        copyBtn.textContent = 'Copy';
      }, 1200);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done).catch(() => {
        fallbackCopyText(text);
        done();
      });
    } else {
      fallbackCopyText(text);
      done();
    }
  };
}

function fallbackCopyText(text) {
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.left = '-9999px';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  } catch (_) {
    /* ignore */
  }
}

function buildActivityLogHtml(activityLog, recentTrades) {
  const events = Array.isArray(activityLog) ? activityLog.slice(0, 30) : [];
  // Fallback: synthesize from trades if log is empty (pre-upgrade ledgers).
  const rows = events.length
    ? events
    : (recentTrades || []).slice(0, 20).map((t) => ({
        at: t.closedAt || t.openedAt,
        kind: t.status === 'open' ? 'open' : 'close',
        message:
          t.status === 'open'
            ? `Open ${t.symbol} ${String(t.side || '').toUpperCase()} @ ${t.entryPriceCents}¢`
            : `Closed ${t.symbol} ${String(t.side || '').toUpperCase()} via ${t.exitReason || 'exit'} (P&L $${((t.pnlCents || 0) / 100).toFixed(2)})`,
        pnlCents: t.pnlCents,
      }));

  if (!rows.length) {
    return `
      <div class="bot-log bot-activity-log">
        <div class="bot-panel-title">Activity log</div>
        <p class="bot-empty-line">No activity yet — opens, closes, and mode changes show up here.</p>
      </div>`;
  }

  // Chronological (oldest → newest) so sticky-bottom follows the latest line.
  const displayRows = rows.slice().reverse();

  const html = displayRows
    .map((e) => {
      const pnl = e.pnlCents;
      const pnlClass =
        Number.isFinite(pnl) && pnl > 0 ? 'chip-positive' : Number.isFinite(pnl) && pnl < 0 ? 'chip-negative' : '';
      const kind = e.kind || 'info';
      const rowId = escapeHtml(`${e.at || ''}-${kind}-${String(e.message || '').slice(0, 40)}`);
      return `
        <div class="bot-log-row kind-${escapeHtml(kind)}" data-log-id="${rowId}">
          <span class="bot-log-time">${escapeHtml(formatTradeTime(e.at))}</span>
          <span class="bot-log-msg">${escapeHtml(e.message || '')}</span>
          ${Number.isFinite(pnl) ? `<span class="bot-log-pnl ${pnlClass}">${escapeHtml(formatMoneyCents(pnl, { signed: true }))}</span>` : '<span class="bot-log-pnl"></span>'}
        </div>`;
    })
    .join('');

  return `
    <div class="bot-log bot-activity-log">
      <div class="bot-panel-title">Activity log <button type="button" class="bot-log-copy" id="bot-activity-copy" title="Copy log text">Copy</button></div>
      <div class="bot-log-list" id="bot-activity-log-list">${html}</div>
    </div>`;
}

function formatMoneyCents(cents, { signed = false } = {}) {
  const value = (Number(cents) || 0) / 100;
  const abs = `$${Math.abs(value).toFixed(2)}`;
  if (!signed) return value < 0 ? `-${abs}` : abs;
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

/**
 * Capital ledger. Uses existing capital fields as-is:
 * Available + Open + Wallet + Insurance = Total Equity
 * Net P&L = Total Equity − Starting Bankroll − Insurance deposits (manual seeds)
 *
 * Deposit controls are overlay-only (`depositControls: true`) so the dashboard
 * summary cannot duplicate `#bot-insurance-deposit*` ids and steal getElementById.
 */
function buildCapitalLedgerHtml(capital, opts = {}) {
  if (!capital) return '';
  const depositControls = opts.depositControls === true;
  const starting = Number(capital.startingCents) || 0;
  const available = Number(capital.paperAvailableCents) || 0;
  const openPositions = Number(capital.openExposureCents) || 0;
  const reserved = Number(capital.reserveCents) || 0;
  const insurance = Number(capital.insuranceCents) || 0;
  const insuranceCap = Number(capital.insuranceCapCents) || 1000;
  const insuranceFloor = Number(capital.insuranceFloorCents) || 600;
  const insuranceOverflow = Number(capital.insuranceOverflowCents) || 1500;
  const deposited = Number(capital.insuranceDepositedCents) || 0;
  const insuranceReady = !!capital.insuranceReady;
  const totalEquity = available + openPositions + reserved + insurance;
  const netPnl = totalEquity - starting - deposited;
  const pnlClass = netPnl > 0 ? 'chip-positive' : netPnl < 0 ? 'chip-negative' : '';
  const reservedClass = reserved > 0 ? 'chip-positive' : '';
  const insuranceClass = insurance > 0 ? 'chip-positive' : '';
  const readyLabel = insuranceReady ? ' · armed' : '';
  const depositBlock = depositControls
    ? `<div class="insurance-deposit-row">
        <input id="bot-insurance-deposit" type="number" min="0.01" max="500" step="0.01" inputmode="decimal" placeholder="Amount $" aria-label="Insurance deposit dollars" />
        <button class="btn-secondary" id="bot-insurance-deposit-btn" type="button">Add to Insurance</button>
      </div>
      <p class="field-hint insurance-deposit-hint">Seed or top up with your own money (external — does not take from Available). Max $500 per add.</p>
      <p class="settings-hint" id="bot-insurance-deposit-feedback" role="status" aria-live="polite"></p>`
    : '';

  return `
    <div class="capital-ledger">
      <div class="capital-ledger-title">Capital</div>
      <div class="capital-row capital-reserved">
        <span>Personal Wallet <em>(locked)</em></span>
        <span class="${reservedClass}">${formatMoneyCents(reserved)}</span>
      </div>
      <div class="capital-row capital-reserved">
        <span>Insurance Fund <em>(arm ${formatMoneyCents(insuranceCap)} / floor ${formatMoneyCents(insuranceFloor)} / overflow ${formatMoneyCents(insuranceOverflow)}${readyLabel})</em></span>
        <span class="${insuranceClass}">${formatMoneyCents(insurance)}</span>
      </div>
      ${depositBlock}
      <div class="capital-divider"></div>
      <div class="capital-row"><span>Starting Bankroll</span><span>${formatMoneyCents(starting)}</span></div>
      ${deposited > 0 ? `<div class="capital-row"><span>Insurance deposits <em>(manual)</em></span><span>${formatMoneyCents(deposited)}</span></div>` : ''}
      <div class="capital-row"><span>Available Cash</span><span>${formatMoneyCents(available)}</span></div>
      <div class="capital-row"><span>Open Positions Value</span><span>${formatMoneyCents(openPositions)}</span></div>
      <div class="capital-divider"></div>
      <div class="capital-row capital-total"><span>Total Equity</span><span>${formatMoneyCents(totalEquity)}</span></div>
      <div class="capital-row capital-pnl"><span>Net P&amp;L</span><span class="${pnlClass}">${formatMoneyCents(netPnl, { signed: true })}</span></div>
      <p class="capital-formula">Insurance: every win is 20% Insurance / 40% Wallet / 40% Available. Arms at ${formatMoneyCents(insuranceCap)}; stays usable down to ${formatMoneyCents(insuranceFloor)}. Soft fill ceiling ${formatMoneyCents(insuranceOverflow)} — excess 20% skim → Available (fund stays as cushion). Below the floor, Available takes losses until re-armed. Manual Add seeds without touching Available.</p>
    </div>`;
}

function insuranceDepositEls() {
  const root = document.getElementById('bot-overlay') || document;
  return {
    input: root.querySelector('#bot-insurance-deposit'),
    feedback: root.querySelector('#bot-insurance-deposit-feedback'),
    btn: root.querySelector('#bot-insurance-deposit-btn'),
  };
}

function setInsuranceDepositFeedback(message, ok) {
  const { feedback } = insuranceDepositEls();
  if (!feedback) {
    console[ok ? 'log' : 'error']('[insurance deposit]', message);
    return;
  }
  feedback.textContent = message;
  feedback.style.color = ok ? 'var(--up)' : 'var(--down)';
}

async function depositInsuranceFromUi() {
  const { input, feedback, btn } = insuranceDepositEls();
  if (!input || !feedback) {
    console.error('[insurance deposit] controls missing — open the bot panel and try again.');
    return;
  }
  const dollars = parseFloat(String(input.value || '').trim());
  if (!Number.isFinite(dollars) || dollars <= 0) {
    setInsuranceDepositFeedback('Enter a positive dollar amount.', false);
    input.focus();
    return;
  }
  const { engineUrl } = loadSettings();
  if (!engineUrl) {
    setInsuranceDepositFeedback('Engine URL is not set. Open Settings and connect first.', false);
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${engineUrl}/api/bot/insurance/deposit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ dollars }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) throw new Error(data.message || `Deposit failed (HTTP ${res.status}).`);
    input.value = '';
    await refreshBotStatus();
    setInsuranceDepositFeedback(data.message || 'Insurance updated.', true);
  } catch (err) {
    setInsuranceDepositFeedback(`Could not add to Insurance: ${err.message}`, false);
  } finally {
    const after = insuranceDepositEls();
    if (after.btn) after.btn.disabled = false;
  }
}

function chip(label, value, colorClass) {
  const cls = colorClass ? (colorClass === 'up' ? 'chip-positive' : 'chip-negative') : '';
  return `<div class="bot-stat-chip"><span class="stat-label">${label}</span><span class="stat-value${cls ? ' ' + cls : ''}">${value}</span></div>`;
}

const SLIDER_UNITS = {
  'bot-edge': (v) => `${(+v).toFixed(1)}%`,
  'bot-confidence': (v) => `${Math.round(v)}%`,
  'bot-stoploss': (v) => `−${Math.round(v)}¢`,
  'bot-stoprecovery': (v) => (Number(v) <= 0 ? 'off' : `+${Math.round(v)}¢`),
  'bot-takeprofit': (v) => `+${Math.round(v)}¢`,
  'bot-minentries': (v) => `${Math.round(v)}¢`,
  'bot-settle-min': (v) => `${Math.round(v)}¢`,
  'bot-settle-max': (v) => `${Math.round(v)}¢`,
  'bot-settle-stoploss': (v) => `−${Math.round(v)}¢`,
  'bot-settle-maxmin': (v) => `${(+v).toFixed(1)} min`,
  'bot-settle-cooldown': (v) => (Number(v) <= 0 ? 'off' : `${(+v).toFixed(1)} min`),
  'bot-settle-late-min': (v) => (Number(v) <= 0 ? 'off' : `${(+v).toFixed(1)} min`),
  'bot-settle-late-floor': (v) => `${Math.round(v)}¢`,
  'bot-settle-stuck': (v) => (Number(v) <= 0 ? 'off' : `${(+v).toFixed(1)} min`),
  'bot-stake': (v) => `$${Math.round(v)}`,
  'bot-maxpos': (v) => `${Math.round(v)}`,
  'bot-paper-balance': (v) => `$${Math.round(v)}`,
};

function setBotStrategyTab(mode) {
  const strategy = mode === 'settle' ? 'settle' : 'edge';
  const hidden = document.getElementById('bot-strategy-mode');
  if (hidden) hidden.value = strategy;
  document.querySelectorAll('.bot-strategy-tab').forEach((btn) => {
    btn.classList.toggle('active', btn.dataset.strategy === strategy);
  });
  const edgePanel = document.getElementById('bot-settings-edge');
  const settlePanel = document.getElementById('bot-settings-settle');
  if (edgePanel) edgePanel.hidden = strategy === 'settle';
  if (settlePanel) settlePanel.hidden = strategy !== 'settle';
  syncSettleExitTableEnabled();
}

/** Fallback if API omits tiers (offline / old deploy). Keep in sync with bot SETTLE_EXIT_TIERS. */
const SETTLE_EXIT_TIERS_FALLBACK = [
  { entryLabel: '≥90¢', aimLabel: 'hold to settle', staleLabel: '—' },
  { entryLabel: '85–89¢', aimLabel: '96¢', staleLabel: '≤2m left' },
  { entryLabel: '80–84¢', aimLabel: '94¢', staleLabel: '≤2.5m left' },
  { entryLabel: '75–79¢', aimLabel: '93¢', staleLabel: '≤3m left' },
  { entryLabel: '70–74¢ (late)', aimLabel: '88¢', staleLabel: '≤3.5m left' },
  { entryLabel: '<70¢ (late)', aimLabel: '85¢', staleLabel: '≤4m left' },
];

function renderSettleExitTable(tiers) {
  const body = document.getElementById('settle-exit-table-body');
  if (!body) return;
  const rows = Array.isArray(tiers) && tiers.length ? tiers : SETTLE_EXIT_TIERS_FALLBACK;
  body.innerHTML = rows
    .map(
      (t) =>
        `<tr><td>${escapeHtml(t.entryLabel || '')}</td><td>${escapeHtml(t.aimLabel || '')}</td><td>${escapeHtml(t.staleLabel || '')}</td></tr>`
    )
    .join('');
  syncSettleExitTableEnabled();
}

function renderSettleExitTableNote(config) {
  const note = document.getElementById('settle-exit-table-note');
  if (!note) return;
  const volatileOn =
    config &&
    (config.settleVolatileExits === 'on' || config.settleVolatileExits === true);
  note.textContent = volatileOn
    ? 'Volatile package ON (red Apply): no hold-to-settle; TP ≥95¢; stuck/stale still run. Stop-loss still applies. Green Apply restores normal hold/TP tiers.'
    : 'Live from bot tiers. After a trade’s bid tags 90¢, stuck/stale turn off and it rides settlement even if price dips back under 90 (stop still applies). Tier TP (e.g. 96¢) can still bank if hit. Red-light volatile (when Applied) removes hold-to-settle and banks at ≥95¢ instead.';
}

function syncSettleExitTableEnabled() {
  const wrap = document.getElementById('settle-exit-table-wrap');
  const tiered = document.getElementById('bot-settle-tiered');
  if (!wrap) return;
  const off = tiered && tiered.value === 'off';
  wrap.classList.toggle('is-disabled', !!off);
}

function wireBotStrategyTabs() {
  document.querySelectorAll('.bot-strategy-tab').forEach((btn) => {
    btn.addEventListener('click', () => {
      setBotStrategyTab(btn.dataset.strategy);
      scheduleAutoSaveBotConfig();
    });
  });
}

function updateSliderDisplay(id) {
  const input = document.getElementById(id);
  const display = document.getElementById(`${id}-value`);
  if (!input || !display) return;
  const formatter = SLIDER_UNITS[id];
  display.textContent = formatter ? formatter(input.value) : input.value;
}

function updateSkimSliderDisplay() {
  const mode = document.getElementById('bot-skim-mode').value;
  const input = document.getElementById('bot-skim-amount');
  const display = document.getElementById('bot-skim-amount-value');
  const label = document.getElementById('bot-skim-amount-label');
  const hint = document.getElementById('bot-skim-hint');
  if (!input || !display) return;
  if (mode === 'insurance') {
    input.min = '1';
    input.max = '50';
    display.textContent = `$${Math.round(input.value)} arm`;
    if (hint) {
      hint.textContent =
        'Each win: 20% → Insurance, 40% → Wallet, 40% → Available. Arms at this amount; stays usable down to the $6 floor. Soft fill ceiling $15 — excess 20% skim → Available (fund stays as cushion). Below floor, Available takes losses until re-armed.';
    }
    if (label) label.querySelector('span.field-hint') || hint;
  } else if (mode === 'percent') {
    input.min = '0';
    input.max = '100';
    display.textContent = `${Math.round(input.value)}%`;
    if (hint) hint.textContent = 'Percent of each win → Reserved (locked). Rest stays in Available. Losses do not draw Reserved.';
  } else if (mode === 'off') {
    display.textContent = 'off';
    if (hint) hint.textContent = 'No skim — full win/loss hits Available Cash.';
  } else {
    input.min = '0';
    input.max = '100';
    display.textContent = `$${Math.round(input.value)}`;
    if (hint) hint.textContent = 'Fixed dollar skim per win → Reserved (locked), capped at that trade’s profit.';
  }
}

function formatSkimLabel(config) {
  if (!config || config.skimMode === 'off') return 'skim off';
  if (config.skimMode === 'insurance') {
    const cap = config.insuranceCapDollars != null ? config.insuranceCapDollars : 10;
    const floor = config.insuranceFloorDollars != null ? config.insuranceFloorDollars : 6;
    const overflow = config.insuranceOverflowDollars != null ? config.insuranceOverflowDollars : 15;
    return `insurance 20/40/40 · arm $${cap} / floor $${floor} / overflow $${overflow}`;
  }
  if (config.skimMode === 'percent') return `skim ${config.skimPercent}% of each win → Wallet`;
  return `skim $${Number(config.skimFixedDollars || 0).toFixed(0)} per win → Wallet`;
}

function wireSliderDisplays() {
  [
    'bot-edge',
    'bot-confidence',
    'bot-stoploss',
    'bot-stoprecovery',
    'bot-takeprofit',
    'bot-minentries',
    'bot-settle-min',
    'bot-settle-max',
    'bot-settle-stoploss',
    'bot-settle-maxmin',
    'bot-settle-cooldown',
    'bot-settle-late-min',
    'bot-settle-late-floor',
    'bot-settle-stuck',
    'bot-stake',
    'bot-maxpos',
    'bot-paper-balance',
  ].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('input', () => updateSliderDisplay(id));
  });
  const skimAmount = document.getElementById('bot-skim-amount');
  if (skimAmount) skimAmount.addEventListener('input', updateSkimSliderDisplay);
  const skimMode = document.getElementById('bot-skim-mode');
  if (skimMode) {
    skimMode.addEventListener('change', () => {
      const input = document.getElementById('bot-skim-amount');
      if (input && skimMode.value === 'insurance' && (Number(input.value) < 1 || Number(input.value) > 50)) {
        input.value = 10;
      }
      if (input && skimMode.value === 'percent' && Number(input.value) === 5) input.value = 50;
      if (input && skimMode.value === 'percent' && Number(input.value) === 10 && input.max === '50') input.value = 50;
      if (input && skimMode.value === 'fixed' && Number(input.value) === 50) input.value = 5;
      if (input && skimMode.value === 'fixed' && Number(input.value) === 10) input.value = 5;
      updateSkimSliderDisplay();
    });
  }
}

let botFormHydrating = false;
let botAutoSaveTimer = null;
const BOT_SETTINGS_LOCK_KEY = 'botSettingsLocked';

function isBotSettingsLocked() {
  try {
    return localStorage.getItem(BOT_SETTINGS_LOCK_KEY) === '1';
  } catch {
    return false;
  }
}

function setBotSettingsLocked(locked) {
  try {
    localStorage.setItem(BOT_SETTINGS_LOCK_KEY, locked ? '1' : '0');
  } catch {
    // ignore quota / private mode
  }
  applyBotSettingsLockUi();
}

function applyBotSettingsLockUi() {
  const locked = isBotSettingsLocked();
  const fields = document.getElementById('bot-settings-fields');
  if (fields) fields.classList.toggle('is-locked', locked);
  const btn = document.getElementById('bot-settings-lock');
  if (btn) {
    btn.setAttribute('aria-pressed', locked ? 'true' : 'false');
    btn.textContent = locked ? 'Locked — tap to edit' : 'Lock settings';
  }
  if (fields) {
    fields.querySelectorAll('input, select, button.bot-strategy-tab').forEach((el) => {
      if (el.id === 'bot-strategy-mode') return;
      el.disabled = locked;
    });
  }
  const saveBtn = document.getElementById('bot-settings-save');
  if (saveBtn) saveBtn.disabled = locked;
}

function wireBotSettingsLock() {
  const btn = document.getElementById('bot-settings-lock');
  if (!btn || btn.dataset.wired === '1') return;
  btn.dataset.wired = '1';
  // Default locked so a redeploy can't leave sliders naked for a sleepy bump.
  if (localStorage.getItem(BOT_SETTINGS_LOCK_KEY) == null) {
    setBotSettingsLocked(true);
  } else {
    applyBotSettingsLockUi();
  }
  btn.addEventListener('click', () => {
    setBotSettingsLocked(!isBotSettingsLocked());
  });
}

function scheduleAutoSaveBotConfig() {
  if (botFormHydrating || isBotSettingsLocked()) return;
  clearTimeout(botAutoSaveTimer);
  botAutoSaveTimer = setTimeout(() => {
    if (isBotSettingsLocked()) return;
    saveBotConfig({ auto: true });
  }, 700);
}

function wireBotConfigAutoSave() {
  const ids = [
    'bot-symbol',
    'bot-edge',
    'bot-confidence',
    'bot-stoploss',
    'bot-stoprecovery',
    'bot-takeprofit',
    'bot-minentries',
    'bot-settle-min',
    'bot-settle-max',
    'bot-settle-stoploss',
    'bot-settle-maxmin',
    'bot-settle-cooldown',
    'bot-settle-late-min',
    'bot-settle-late-floor',
    'bot-settle-stuck',
    'bot-stake',
    'bot-maxpos',
    'bot-paper-balance',
    'bot-skim-mode',
    'bot-skim-amount',
  ];
  for (const id of ids) {
    const el = document.getElementById(id);
    if (!el) continue;
    el.addEventListener('change', scheduleAutoSaveBotConfig);
    if (el.tagName === 'INPUT') el.addEventListener('input', scheduleAutoSaveBotConfig);
  }
  for (const id of [
    'bot-settle-tiered',
    'bot-half-stake-near',
    'bot-second-green',
    'bot-trade-near',
    'bot-trade-doge',
    'bot-symbol',
    'bot-strategy-mode',
  ]) {
    const el = document.getElementById(id);
    if (el) el.addEventListener('change', scheduleAutoSaveBotConfig);
  }
  const settleTieredEl = document.getElementById('bot-settle-tiered');
  if (settleTieredEl) settleTieredEl.addEventListener('change', syncSettleExitTableEnabled);
}

async function loadBotConfigIntoForm() {
  const { engineUrl } = loadSettings();
  botFormHydrating = true;
  try {
    const res = await fetch(`${engineUrl}/api/bot/config`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const c = data.config;
    renderSettleExitTable(data.settleExitTiers);
    renderSettleExitTableNote(c);
    document.getElementById('bot-symbol').value = c.symbol;
    setBotStrategyTab(c.strategyMode || 'settle');
    const backtestSymbol = document.getElementById('backtest-symbol');
    if (backtestSymbol && [...backtestSymbol.options].some((o) => o.value === c.symbol)) {
      backtestSymbol.value = c.symbol;
    }
    document.getElementById('bot-edge').value = c.edgeThresholdPct;
    document.getElementById('bot-confidence').value = c.minConfidence;
    document.getElementById('bot-stoploss').value = c.stopLossCents;
    const stopRecEl = document.getElementById('bot-stoprecovery');
    if (stopRecEl) stopRecEl.value = c.stopRecoveryCents != null ? c.stopRecoveryCents : 6;
    document.getElementById('bot-takeprofit').value = c.takeProfitCents != null ? c.takeProfitCents : 15;
    document.getElementById('bot-minentries').value = c.minEntryCents != null ? c.minEntryCents : 40;
    const settleMin = document.getElementById('bot-settle-min');
    if (settleMin) settleMin.value = c.settleEntryMinCents != null ? c.settleEntryMinCents : 80;
    const settleMax = document.getElementById('bot-settle-max');
    if (settleMax) settleMax.value = c.settleEntryMaxCents != null ? c.settleEntryMaxCents : 94;
    const settleStop = document.getElementById('bot-settle-stoploss');
    if (settleStop) {
      const raw = c.settleStopLossCents != null ? Number(c.settleStopLossCents) : 50;
      settleStop.value = Math.max(8, Math.min(60, Number.isFinite(raw) ? raw : 50));
    }
    const settleMaxMin = document.getElementById('bot-settle-maxmin');
    if (settleMaxMin) settleMaxMin.value = c.settleMaxMinutesToOpen != null ? c.settleMaxMinutesToOpen : 8.5;
    const settleCd = document.getElementById('bot-settle-cooldown');
    if (settleCd) {
      settleCd.value =
        c.settlePostStopSameSideCooldownMinutes != null ? c.settlePostStopSameSideCooldownMinutes : 2.5;
    }
    const settleLateMin = document.getElementById('bot-settle-late-min');
    if (settleLateMin) {
      settleLateMin.value = c.settleLateEntryMinutes != null ? c.settleLateEntryMinutes : 3.5;
    }
    const settleLateFloor = document.getElementById('bot-settle-late-floor');
    if (settleLateFloor) {
      settleLateFloor.value = c.settleLateEntryMinCents != null ? c.settleLateEntryMinCents : 70;
    }
    const settleStuck = document.getElementById('bot-settle-stuck');
    if (settleStuck) {
      settleStuck.value = c.settleStuckHoldMinutes != null ? c.settleStuckHoldMinutes : 3;
    }
    const halfStakeNear = document.getElementById('bot-half-stake-near');
    if (halfStakeNear) {
      const nearOff =
        c.halfStakeNear === false ||
        c.halfStakeNear === 0 ||
        c.halfStakeNear === 'off' ||
        c.halfStakeNear === 'false';
      halfStakeNear.value = nearOff ? 'off' : 'on';
    }
    const tradeNear = document.getElementById('bot-trade-near');
    if (tradeNear) {
      const on =
        c.tradeNear === true ||
        c.tradeNear === 1 ||
        c.tradeNear === 'on' ||
        c.tradeNear === 'true';
      tradeNear.value = on ? 'on' : 'off';
    }
    const tradeDoge = document.getElementById('bot-trade-doge');
    if (tradeDoge) {
      const on =
        c.tradeDoge === true ||
        c.tradeDoge === 1 ||
        c.tradeDoge === 'on' ||
        c.tradeDoge === 'true';
      tradeDoge.value = on ? 'on' : 'off';
    }
    const settleTiered = document.getElementById('bot-settle-tiered');
    if (settleTiered) {
      const tieredOff =
        c.settleTieredExits === false ||
        c.settleTieredExits === 0 ||
        c.settleTieredExits === 'off' ||
        c.settleTieredExits === 'false';
      settleTiered.value = tieredOff ? 'off' : 'on';
    }
    document.getElementById('bot-stake').value = c.stakeDollars;
    document.getElementById('bot-maxpos').value = c.maxOpenPositions;
    const secondGreen = document.getElementById('bot-second-green');
    if (secondGreen) {
      const off =
        c.secondOpenRequiresGreen === false ||
        c.secondOpenRequiresGreen === 0 ||
        c.secondOpenRequiresGreen === 'off' ||
        c.secondOpenRequiresGreen === 'false';
      secondGreen.value = off ? 'off' : 'on';
    }
    document.getElementById('bot-paper-balance').value = c.paperStartingBalanceDollars;
    document.getElementById('bot-skim-mode').value = c.skimMode || 'insurance';
    const skimAmt = document.getElementById('bot-skim-amount');
    if (c.skimMode === 'insurance') {
      skimAmt.value = c.insuranceCapDollars != null ? c.insuranceCapDollars : 10;
    } else if (c.skimMode === 'percent') {
      skimAmt.value = c.skimPercent;
    } else {
      skimAmt.value = c.skimFixedDollars;
    }
    [
      'bot-edge',
      'bot-confidence',
      'bot-stoploss',
      'bot-stoprecovery',
      'bot-takeprofit',
      'bot-minentries',
      'bot-settle-min',
      'bot-settle-max',
      'bot-settle-stoploss',
      'bot-settle-maxmin',
      'bot-settle-cooldown',
      'bot-settle-late-min',
      'bot-settle-late-floor',
      'bot-settle-stuck',
      'bot-stake',
      'bot-maxpos',
      'bot-paper-balance',
    ].forEach(updateSliderDisplay);
    updateSkimSliderDisplay();
  } catch {
    // Bot likely disabled or engine unreachable — form just stays blank.
  } finally {
    botFormHydrating = false;
    applyBotSettingsLockUi();
  }
}

function renderSettleWindowRec(rec) {
  const wrap = document.getElementById('settle-window-rec');
  const text = document.getElementById('settle-window-rec-text');
  const btn = document.getElementById('settle-window-apply');
  if (!wrap || !text || !btn) return;
  if (!rec || typeof rec !== 'object') {
    wrap.dataset.light = 'neutral';
    text.textContent = 'Retrospect: waiting for settle history…';
    btn.disabled = true;
    btn.textContent = 'Apply';
    return;
  }
  const light = rec.light === 'green' || rec.light === 'red' ? rec.light : 'neutral';
  wrap.dataset.light = light;
  const mins = rec.suggestedMaxMinutes;
  const look = rec.lookbackHours != null ? `${rec.lookbackHours}h` : '—';
  const n = rec.stats && rec.stats.sampleSize != null ? rec.stats.sampleSize : 0;
  if (light === 'green') {
    text.textContent = `Green · suggest ${mins}m (stable) · ${look}, n=${n}. ${rec.reason || ''}`;
    btn.disabled = false;
    btn.textContent = `Apply ${mins} min`;
  } else if (light === 'red') {
    const tp = rec.volatileTpFloorCents != null ? rec.volatileTpFloorCents : 95;
    const minLeft = rec.suggestedMinMinutes != null ? rec.suggestedMinMinutes : 1.5;
    text.textContent =
      `Red · suggest ${mins}m (volatile) · no hold-to-settle · TP ≥${tp}¢ · no opens ≤${minLeft}m` +
      ` · ${look}, n=${n}. ${rec.reason || ''}`;
    btn.disabled = false;
    btn.textContent = `Apply ${mins} min`;
  } else {
    text.textContent = `Neutral · ${rec.reason || 'Leave slider as-is.'}`;
    btn.disabled = true;
    btn.textContent = 'Apply';
  }
}

async function applySettleWindowRec() {
  const { engineUrl } = loadSettings();
  const feedback = document.getElementById('bot-settings-feedback');
  const btn = document.getElementById('settle-window-apply');
  if (isBotSettingsLocked()) {
    if (feedback) {
      feedback.textContent = 'Settings are locked — unlock before applying the settle window.';
      feedback.style.color = 'var(--wait)';
    }
    return;
  }
  if (btn) btn.disabled = true;
  try {
    const res = await fetch(`${engineUrl}/api/bot/settle-window-rec/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{}',
    });
    const data = await res.json();
    if (!res.ok || !data.ok) {
      if (feedback) {
        feedback.textContent = data.message || 'Could not apply settle window suggestion.';
        feedback.style.color = 'var(--wait)';
      }
      renderSettleWindowRec(data.recommendation);
      return;
    }
    if (feedback) {
      feedback.textContent = data.message || 'Settle open window applied.';
      feedback.style.color = 'var(--up)';
    }
    renderSettleWindowRec(data.recommendation);
    const slider = document.getElementById('bot-settle-maxmin');
    if (slider && data.config && data.config.settleMaxMinutesToOpen != null) {
      slider.value = data.config.settleMaxMinutesToOpen;
      updateSliderDisplay('bot-settle-maxmin');
    }
    renderSettleExitTableNote(data.config);
    refreshBotStatus();
  } catch (err) {
    if (feedback) {
      feedback.textContent = `Could not reach the engine: ${err.message}`;
      feedback.style.color = 'var(--down)';
    }
  }
}

async function saveBotConfig(opts = {}) {
  const { engineUrl } = loadSettings();
  const feedback = document.getElementById('bot-settings-feedback');
  if (isBotSettingsLocked()) {
    if (feedback) {
      feedback.textContent = 'Settings are locked — tap “Locked — tap to edit” before changing anything.';
      feedback.style.color = 'var(--wait)';
    }
    return;
  }
  const skimMode = document.getElementById('bot-skim-mode').value;
  const skimAmount = parseFloat(document.getElementById('bot-skim-amount').value);
  const payload = {
    symbol: document.getElementById('bot-symbol').value,
    strategyMode: document.getElementById('bot-strategy-mode')?.value || 'settle',
    edgeThresholdPct: parseFloat(document.getElementById('bot-edge').value),
    minConfidence: parseFloat(document.getElementById('bot-confidence').value),
    stopLossCents: parseFloat(document.getElementById('bot-stoploss').value),
    stopRecoveryCents: parseFloat(document.getElementById('bot-stoprecovery').value),
    takeProfitCents: parseFloat(document.getElementById('bot-takeprofit').value),
    minEntryCents: parseFloat(document.getElementById('bot-minentries').value),
    settleEntryMinCents: parseFloat(document.getElementById('bot-settle-min')?.value || '80'),
    settleEntryMaxCents: parseFloat(document.getElementById('bot-settle-max')?.value || '94'),
    settleStopLossCents: Math.max(
      8,
      Math.min(60, parseFloat(document.getElementById('bot-settle-stoploss')?.value || '50') || 50)
    ),
    settleMaxMinutesToOpen: parseFloat(document.getElementById('bot-settle-maxmin')?.value || '8.5'),
    settlePostStopSameSideCooldownMinutes: parseFloat(
      document.getElementById('bot-settle-cooldown')?.value || '2.5'
    ),
    settleLateEntryMinutes: parseFloat(document.getElementById('bot-settle-late-min')?.value || '3.5'),
    settleLateEntryMinCents: parseFloat(document.getElementById('bot-settle-late-floor')?.value || '70'),
    settleStuckHoldMinutes: parseFloat(document.getElementById('bot-settle-stuck')?.value || '3'),
    halfStakeNear: document.getElementById('bot-half-stake-near')?.value || 'on',
    tradeNear: document.getElementById('bot-trade-near')?.value || 'off',
    tradeDoge: document.getElementById('bot-trade-doge')?.value || 'off',
    settleTieredExits: document.getElementById('bot-settle-tiered')?.value || 'on',
    stakeDollars: parseFloat(document.getElementById('bot-stake').value),
    maxOpenPositions: parseFloat(document.getElementById('bot-maxpos').value),
    secondOpenRequiresGreen: document.getElementById('bot-second-green')?.value || 'on',
    paperStartingBalanceDollars: parseFloat(document.getElementById('bot-paper-balance').value),
    skimMode,
    ...(skimMode === 'insurance'
      ? { insuranceCapDollars: skimAmount }
      : skimMode === 'percent'
        ? { skimPercent: skimAmount }
        : skimMode === 'fixed'
          ? { skimFixedDollars: skimAmount }
          : {}),
  };
  try {
    const res = await fetch(`${engineUrl}/api/bot/config`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      feedback.textContent = body.message
        ? `Not saved — ${body.message}`
        : `Not saved — engine returned an error (HTTP ${res.status}). Is the bot enabled (KALSHI_ENABLED=true)?`;
      feedback.style.color = 'var(--down)';
      return;
    }
    const saved = await res.json().catch(() => ({}));
    if (saved.settleExitTiers) renderSettleExitTable(saved.settleExitTiers);
    syncSettleExitTableEnabled();
    const skimText = formatSkimLabel(saved.config || payload);
    let msg = opts.auto ? `✓ Auto-saved — ${skimText}.` : `✓ Saved — ${skimText}.`;
    try {
      const healthRes = await fetch(`${engineUrl}/api/health`, { cache: 'no-store' });
      if (healthRes.ok) {
        const health = await healthRes.json();
        if (health.dataDirEphemeral) {
          msg += ' Warning: disk is ephemeral — this will reset on next Render restart until you add a Persistent Disk.';
          feedback.style.color = 'var(--wait)';
        } else {
          feedback.style.color = 'var(--up)';
        }
      } else {
        feedback.style.color = 'var(--up)';
      }
    } catch {
      feedback.style.color = 'var(--up)';
    }
    feedback.textContent = msg;
    if (!opts.auto) refreshBotStatus();
  } catch (err) {
    feedback.textContent = `Not saved — could not reach the engine: ${err.message}`;
    feedback.style.color = 'var(--down)';
  }
}

async function resetPaperHistory() {
  if (!window.confirm('Reset all paper trades, P&L, reserve, and calibration stats? This cannot be undone.')) return;
  const { engineUrl } = loadSettings();
  const feedback = document.getElementById('bot-settings-feedback');
  try {
    const res = await fetch(`${engineUrl}/api/bot/reset-paper`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.message || 'Reset failed.');
    feedback.textContent = data.message;
    feedback.style.color = 'var(--up)';
    await refreshBotStatus();
    await loadCalibration();
  } catch (err) {
    feedback.textContent = `Could not reset paper history: ${err.message}`;
    feedback.style.color = 'var(--down)';
  }
}

function readBacktestSettingsFromForm() {
  const skimMode = document.getElementById('bot-skim-mode').value;
  const skimAmount = parseFloat(document.getElementById('bot-skim-amount').value);
  return {
    edgeThresholdPct: parseFloat(document.getElementById('bot-edge').value),
    minConfidence: parseFloat(document.getElementById('bot-confidence').value),
    stopLossCents: parseFloat(document.getElementById('bot-stoploss').value),
    stopRecoveryCents: parseFloat(document.getElementById('bot-stoprecovery').value),
    takeProfitCents: parseFloat(document.getElementById('bot-takeprofit').value),
    minEntryCents: parseFloat(document.getElementById('bot-minentries').value),
    stakeDollars: parseFloat(document.getElementById('bot-stake').value),
    maxOpenPositions: parseFloat(document.getElementById('bot-maxpos').value),
    paperStartingBalanceDollars: parseFloat(document.getElementById('bot-paper-balance').value),
    skimMode,
    ...(skimMode === 'insurance'
      ? { insuranceCapDollars: skimAmount }
      : skimMode === 'percent'
        ? { skimPercent: skimAmount }
        : skimMode === 'fixed'
          ? { skimFixedDollars: skimAmount }
          : {}),
  };
}

function formatMoneyFromCents(cents, { signed = false } = {}) {
  return formatMoneyCents(cents, { signed });
}

function applyHuntedSettingsToForm(settings) {
  if (!settings) return;
  if (settings.edgeThresholdPct != null) document.getElementById('bot-edge').value = settings.edgeThresholdPct;
  if (settings.minConfidence != null) document.getElementById('bot-confidence').value = settings.minConfidence;
  if (settings.stopLossCents != null) document.getElementById('bot-stoploss').value = settings.stopLossCents;
  if (settings.stopRecoveryCents != null) {
    const el = document.getElementById('bot-stoprecovery');
    if (el) el.value = settings.stopRecoveryCents;
  }
  if (settings.takeProfitCents != null) document.getElementById('bot-takeprofit').value = settings.takeProfitCents;
  if (settings.minEntryCents != null) document.getElementById('bot-minentries').value = settings.minEntryCents;
  ['bot-edge', 'bot-confidence', 'bot-stoploss', 'bot-stoprecovery', 'bot-takeprofit', 'bot-minentries'].forEach(updateSliderDisplay);
}

function renderBacktestResults(data, dayLabel) {
  const t = data.trading || {};
  const s = data.settingsUsed || {};
  const skimLabel =
    s.skimMode === 'off'
      ? 'off'
      : s.skimMode === 'insurance'
        ? `insurance 20/40/40 · arm $${s.insuranceCapDollars != null ? s.insuranceCapDollars : 10} / floor $${s.insuranceFloorDollars != null ? s.insuranceFloorDollars : 6} / overflow $${s.insuranceOverflowDollars != null ? s.insuranceOverflowDollars : 15}`
        : s.skimMode === 'percent'
        ? `${s.skimPercent}% of profit`
        : `$${Number(s.skimFixedDollars || 0).toFixed(0)} per win`;
  const pnlClass = (t.netPnlCents || 0) > 0 ? 'chip-positive' : (t.netPnlCents || 0) < 0 ? 'chip-negative' : '';
  const modeLabel = data.mode === 'AUTO' || t.mode === 'AUTO' ? 'AUTO' : data.symbol;
  const scanned = (data.symbolsScanned || t.symbolsScanned || [data.symbol]).join(', ');
  const settingsLine = `Edge ≥ ${s.edgeThresholdPct}% · Confidence ≥ ${s.minConfidence}% · Stake $${s.stakeDollars} · Min entry ${s.minEntryCents != null ? s.minEntryCents + '¢' : '—'} · Stop −${s.stopLossCents}¢ · Recovery +${s.stopRecoveryCents != null ? s.stopRecoveryCents + '¢' : '—'} · TP +${s.takeProfitCents != null ? s.takeProfitCents + '¢' : '—'} · Max pos ${s.maxOpenPositions} · Skim ${skimLabel} · Bankroll $${s.paperStartingBalanceDollars}`;
  const bySymbol = t.tradesBySymbol
    ? Object.entries(t.tradesBySymbol)
        .sort((a, b) => b[1] - a[1])
        .map(([sym, count]) => `${sym} ${count}`)
        .join(' · ')
    : '';

  let huntBlock = '';
  if (data.hunt && data.hunt.best) {
    const best = data.hunt.best;
    const topRows = (data.hunt.top || [])
      .map(
        (row, i) =>
          `<div class="backtest-row"><span>#${i + 1} edge ${row.settings.edgeThresholdPct}% · conf ${row.settings.minConfidence}% · stop −${row.settings.stopLossCents}¢</span><span>${row.winRatePct != null ? row.winRatePct + '%' : '—'} WR · ${row.trades} trades · ${formatMoneyFromCents(row.netPnlCents, { signed: true })}</span></div>`
      )
      .join('');
    huntBlock = `
      <div class="capital-ledger backtest-ledger">
        <div class="capital-ledger-title">Hunt result — best win rate + profit</div>
        <p class="backtest-settings-line">Searched ${data.hunt.searched} setting combos. Winner: edge ${best.settings.edgeThresholdPct}% · confidence ${best.settings.minConfidence}% · stop −${best.settings.stopLossCents}¢</p>
        <p class="backtest-settings-line">Those values were applied to the settings sliders above — save settings if you want the live bot to use them.</p>
        <div class="backtest-recent-title">Top combos</div>
        ${topRows}
      </div>`;
    applyHuntedSettingsToForm(best.settings);
  }

  const lon = t.longevity || {};
  const longevityVerdict = lon.survivedFullPeriod
    ? `Survived the full ${lon.simulatedDays != null ? lon.simulatedDays : '—'} day(s) — Available Cash never ran dry.`
    : lon.broke
      ? `Available Cash ran dry after ~${lon.daysUntilBroke != null ? lon.daysUntilBroke : '—'} day(s) (${lon.hoursUntilBroke != null ? lon.hoursUntilBroke : '—'}h). Reserved may still hold skimmed profit.`
      : 'Longevity not available for this run.';
  const dailyRows = (lon.dailyEquity || [])
    .map(
      (d) =>
        `<div class="backtest-row"><span>Day ${d.day}${d.broke ? ' · dry' : ''}</span><span>${formatMoneyFromCents(d.totalEquityCents)} equity · ${formatMoneyFromCents(d.availableCashCents)} avail · ${d.tradesSoFar} trades</span></div>`
    )
    .join('');
  const longevityBlock = `
    <div class="capital-ledger backtest-ledger">
      <div class="capital-ledger-title">Bankroll longevity (continuous ${dayLabel})</div>
      <p class="backtest-settings-line">${longevityVerdict}</p>
      <div class="capital-row"><span>Simulated runtime</span><span>${lon.simulatedHours != null ? lon.simulatedHours + 'h' : '—'} (${lon.simulatedDays != null ? lon.simulatedDays : '—'} days)</span></div>
      <div class="capital-row"><span>Days survived</span><span>${lon.daysSurvived != null ? lon.daysSurvived : '—'}</span></div>
      <div class="capital-row"><span>Ran dry?</span><span class="${lon.broke ? 'chip-negative' : 'chip-positive'}">${lon.broke ? 'Yes — Available empty' : 'No'}</span></div>
      ${dailyRows ? `<div class="backtest-recent-title">Equity by day</div>${dailyRows}` : ''}
    </div>`;

  const tradingBlock = `
    <div class="capital-ledger backtest-ledger">
      <div class="capital-ledger-title">${data.hunted ? 'Best-hunt' : 'Settings-based'} trading sim (${modeLabel} · ${dayLabel})</div>
      <p class="backtest-settings-line">${settingsLine}</p>
      <p class="backtest-settings-line">Continuous scan · Scanned: ${scanned}${bySymbol ? ` · Trades taken: ${bySymbol}` : ''}</p>
      <div class="capital-row"><span>Trades taken</span><span>${t.trades ?? 0}</span></div>
      <div class="capital-row"><span>Wins / Losses</span><span>${t.wins ?? 0} / ${t.losses ?? 0}</span></div>
      <div class="capital-row"><span>Win rate</span><span>${t.winRatePct != null ? t.winRatePct + '%' : '—'}</span></div>
      <div class="capital-row"><span>Avg confidence (taken)</span><span>${t.avgConfidenceTaken != null ? t.avgConfidenceTaken + '%' : '—'}</span></div>
      <div class="capital-row"><span>Avg confidence (scanned)</span><span>${t.avgConfidenceScanned != null ? t.avgConfidenceScanned + '%' : '—'}</span></div>
      <div class="capital-row"><span>Stop-loss exits</span><span>${t.stopLossExits ?? 0}</span></div>
      <div class="capital-row"><span>Take-profit exits</span><span>${t.takeProfitExits ?? 0}</span></div>
      <div class="capital-row"><span>Breakeven exits</span><span>${t.breakevenExits ?? 0}</span></div>
      <div class="capital-divider"></div>
      <div class="capital-row capital-reserved"><span>Personal Wallet <em>(locked)</em></span><span class="${(t.reservedProfitCents || 0) > 0 ? 'chip-positive' : ''}">${formatMoneyFromCents(t.reservedProfitCents)}</span></div>
      <div class="capital-row capital-reserved"><span>Insurance Fund</span><span class="${(t.insuranceCents || 0) > 0 ? 'chip-positive' : ''}">${formatMoneyFromCents(t.insuranceCents || 0)}</span></div>
      <div class="capital-divider"></div>
      <div class="capital-row"><span>Starting Bankroll</span><span>${formatMoneyFromCents(t.startingBankrollCents)}</span></div>
      <div class="capital-row"><span>Available Cash</span><span>${formatMoneyFromCents(t.availableCashCents)}</span></div>
      <div class="capital-row"><span>Open Positions Value</span><span>${formatMoneyFromCents(t.openPositionsValueCents)}</span></div>
      <div class="capital-divider"></div>
      <div class="capital-row capital-total"><span>Total Equity</span><span>${formatMoneyFromCents(t.totalEquityCents)}</span></div>
      <div class="capital-row capital-pnl"><span>Net P&amp;L</span><span class="${pnlClass}">${formatMoneyFromCents(t.netPnlCents, { signed: true })}</span></div>
    </div>`;

  const skips = t.skipCounts || {};
  const skipBlock = `
    <div class="backtest-skips">
      <span>Skipped setups — low confidence: ${skips.lowConfidence || 0}, low edge: ${skips.lowEdge || 0}, cash: ${skips.insufficientCash || 0}</span>
    </div>`;

  const recent = (t.recentTrades || [])
    .map(
      (tr) =>
        `<div class="backtest-row"><span>${tr.symbol || data.symbol} ${tr.side.toUpperCase()} · ${tr.window} · conf ${tr.confidence}% · edge ${tr.edge}</span><span class="${tr.pnlDollars >= 0 ? 'chip-positive' : 'chip-negative'}">${tr.pnlDollars >= 0 ? '+' : ''}$${Math.abs(tr.pnlDollars).toFixed(2)} · ${tr.exitReason}</span></div>`
    )
    .join('');

  let windowRows = '';
  if (data.mode === 'AUTO' && data.windows && !data.windows.w5) {
    windowRows = Object.entries(data.windows)
      .map(([sym, windows]) => {
        const lines = Object.values(windows)
          .map(
            (w) =>
              `<div class="backtest-row"><span>${sym} ${w.window}</span><span>${w.accuracyPct != null ? w.accuracyPct + '%' : '—'} acc · avg conf ${w.avgConfidence != null ? w.avgConfidence + '%' : '—'} · high-conf ${w.highConfidenceAccuracyPct != null ? w.highConfidenceAccuracyPct + '%' : '—'} (${w.highConfidenceSampleSize || 0})</span></div>`
          )
          .join('');
        return lines;
      })
      .join('');
  } else {
    windowRows = Object.values(data.windows || {})
      .map(
        (w) =>
          `<div class="backtest-row"><span>Engine ${w.window}</span><span>${w.accuracyPct != null ? w.accuracyPct + '%' : '—'} acc · avg conf ${w.avgConfidence != null ? w.avgConfidence + '%' : '—'} · high-conf (≥55%) ${w.highConfidenceAccuracyPct != null ? w.highConfidenceAccuracyPct + '%' : '—'} (${w.correctCount}/${w.sampleSize})</span></div>`
      )
      .join('');
  }

  return `
    ${huntBlock}
    ${longevityBlock}
    ${tradingBlock}
    ${skipBlock}
    ${recent ? `<div class="backtest-recent-title">Recent simulated trades</div>${recent}` : ''}
    <div class="backtest-recent-title">Engine accuracy + confidence (from live prediction path)</div>
    ${windowRows}
    <p class="backtest-note">${data.candleCount} candles over ${dayLabel} (${data.hoursRequested}h). ${data.note || t.note || ''}</p>`;
}

async function runBacktest(hoursOverride, { hunt = false } = {}) {
  const { engineUrl } = loadSettings();
  const symbol = document.getElementById('backtest-symbol').value;
  const hoursInput = document.getElementById('backtest-hours');
  const hours = hoursOverride || hoursInput.value || 24;
  hoursInput.value = String(hours);
  document.querySelectorAll('.backtest-day-btn').forEach((btn) => {
    btn.classList.toggle('selected', String(btn.dataset.hours) === String(hours));
  });
  const resultsEl = document.getElementById('backtest-results');
  const days = Number(hours) / 24;
  const dayLabel = days === 1 ? '1 day' : `${days} days`;
  resultsEl.innerHTML = `<p class="settings-hint">${hunt ? 'Hunting best settings' : 'Running'} ${dayLabel} backtest${symbol === 'AUTO' ? ' (AUTO — continuous multi-market scan)' : ''}${hunt ? ' — this can take a while' : ''}…</p>`;
  try {
    const res = await fetch(`${engineUrl}/api/backtest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      cache: 'no-store',
      body: JSON.stringify({
        symbol,
        hours: Number(hours),
        hunt,
        ...readBacktestSettingsFromForm(),
      }),
    });
    const data = await res.json();
    if (!res.ok) {
      resultsEl.innerHTML = `<p class="settings-hint">Error: ${data.error || 'unknown error'}</p>`;
      return;
    }
    resultsEl.innerHTML = renderBacktestResults(data, dayLabel);
  } catch (err) {
    resultsEl.innerHTML = `<p class="settings-hint">Failed to run backtest: ${err.message}</p>`;
  }
}

async function loadKalshiCredentialsStatus() {
  const { engineUrl } = loadSettings();
  const statusEl = document.getElementById('kalshi-creds-status');
  try {
    const res = await fetch(`${engineUrl}/api/kalshi/credentials-status`, { cache: 'no-store' });
    const data = await res.json();
    statusEl.textContent = data.configured
      ? `Configured (Key ID ${data.keyIdPreview})`
      : 'Not configured yet — enter your Key ID and private key below.';
  } catch {
    statusEl.textContent = 'Could not check credential status right now.';
  }
}

async function saveKalshiCredentials() {
  const { engineUrl } = loadSettings();
  const statusEl = document.getElementById('kalshi-creds-status');
  const keyId = document.getElementById('kalshi-key-id').value.trim();
  const privateKeyPem = document.getElementById('kalshi-private-key').value.trim();
  if (!keyId && !privateKeyPem) return;
  try {
    const res = await fetch(`${engineUrl}/api/kalshi/credentials`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyId: keyId || undefined, privateKeyPem: privateKeyPem || undefined }),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      statusEl.textContent = `Not saved — ${body.error || 'engine returned HTTP ' + res.status}`;
      return;
    }
    // Never leave the private key sitting visible in the form after saving.
    document.getElementById('kalshi-private-key').value = '';
    loadKalshiCredentialsStatus();
  } catch (err) {
    statusEl.textContent = `Failed to save: ${err.message}`;
  }
}

const LIVE_NOT_AUTHORIZED_HINT =
  'Live is locked on this server. Set KALSHI_LIVE_TRADING=true, ' +
  'KALSHI_LIVE_TRADING_CONFIRM=I_UNDERSTAND_THE_RISK (exact), ensure Kalshi credentials are present at boot, then restart. ' +
  'Saving credentials in the UI alone cannot unlock live.';

function updateModeButtons(mode, liveAuthorized) {
  const paperBtn = document.getElementById('mode-btn-paper');
  const liveBtn = document.getElementById('mode-btn-live');
  const feedback = document.getElementById('mode-toggle-feedback');
  paperBtn.classList.toggle('active-mode', mode === 'paper');
  liveBtn.classList.toggle('active-mode', mode === 'live');
  liveBtn.classList.toggle('locked', !liveAuthorized);
  liveBtn.title = liveAuthorized ? '' : LIVE_NOT_AUTHORIZED_HINT;
  // Show the lock reason in the visible feedback line (tooltips alone are easy to miss).
  if (feedback && !liveAuthorized) {
    feedback.textContent = LIVE_NOT_AUTHORIZED_HINT;
    feedback.style.color = 'var(--wait)';
  } else if (feedback && liveAuthorized && feedback.textContent === LIVE_NOT_AUTHORIZED_HINT) {
    feedback.textContent = '';
  }
}

async function switchMode(requestedMode) {
  const { engineUrl } = loadSettings();
  const feedback = document.getElementById('mode-toggle-feedback');
  const liveBtn = document.getElementById('mode-btn-live');

  // Don't ask for a real-money confirm when the server has not authorized live —
  // surface the lock reason immediately instead of a misleading "Switch to LIVE?" dialog.
  if (requestedMode === 'live' && liveBtn && liveBtn.classList.contains('locked')) {
    feedback.textContent = LIVE_NOT_AUTHORIZED_HINT;
    feedback.style.color = 'var(--wait)';
    return;
  }

  if (requestedMode === 'live') {
    const confirmed = window.confirm(
      'Switch to LIVE trading? This places real orders with real money on Kalshi. ' +
        'Make sure your stake size, stop-loss, and other settings are exactly what you want first.'
    );
    if (!confirmed) return;
  }

  try {
    const res = await fetch(`${engineUrl}/api/bot/mode`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: requestedMode }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.ok) {
      feedback.textContent = body.message || `Could not switch mode (HTTP ${res.status}).`;
      feedback.style.color = 'var(--down)';
      return;
    }
    feedback.textContent = `✓ Now in ${body.mode === 'live' ? 'LIVE' : 'paper'} mode.`;
    feedback.style.color = body.mode === 'live' ? 'var(--down)' : 'var(--up)';
    refreshBotStatus();
  } catch (err) {
    feedback.textContent = `Could not reach the engine: ${err.message}`;
    feedback.style.color = 'var(--down)';
  }
}

function wireBotUI() {
  document.getElementById('bot-btn').addEventListener('click', openBotOverlay);
  document.getElementById('bot-overlay-close').addEventListener('click', closeBotOverlay);
  document.getElementById('bot-settings-refresh').addEventListener('click', () => {
    refreshBotStatus();
    loadBotConfigIntoForm();
  });
  document.getElementById('bot-settings-save').addEventListener('click', () => saveBotConfig());
  const settleWindowApply = document.getElementById('settle-window-apply');
  if (settleWindowApply) {
    settleWindowApply.addEventListener('click', () => applySettleWindowRec());
  }
  document.getElementById('bot-running-toggle').addEventListener('click', () => {
    const isRunning = document.getElementById('bot-running-toggle').textContent !== 'Start bot';
    setBotRunning(!isRunning);
  });
  document.getElementById('bot-dashboard-toggle').addEventListener('click', (event) => setBotRunning(event.currentTarget.dataset.running === 'true'));
  document.getElementById('bot-dashboard-open').addEventListener('click', openBotOverlay);
  document.getElementById('bot-reset-paper').addEventListener('click', resetPaperHistory);
  const botOverlay = document.getElementById('bot-overlay');
  if (botOverlay) {
    botOverlay.addEventListener('click', (event) => {
      const btn = event.target && event.target.closest
        ? event.target.closest('#bot-insurance-deposit-btn')
        : null;
      if (btn) {
        event.preventDefault();
        depositInsuranceFromUi();
      }
    });
    botOverlay.addEventListener('keydown', (event) => {
      if (event.key === 'Enter' && event.target && event.target.id === 'bot-insurance-deposit') {
        event.preventDefault();
        depositInsuranceFromUi();
      }
    });
  }
  document.querySelectorAll('.backtest-day-btn').forEach((btn) => {
    btn.addEventListener('click', () => runBacktest(btn.dataset.hours, { hunt: false }));
  });
  document.getElementById('backtest-hunt').addEventListener('click', () => {
    const hours = document.getElementById('backtest-hours').value || 24;
    runBacktest(hours, { hunt: true });
  });
  document.getElementById('kalshi-creds-save').addEventListener('click', saveKalshiCredentials);
  document.getElementById('mode-btn-paper').addEventListener('click', () => switchMode('paper'));
  document.getElementById('mode-btn-live').addEventListener('click', () => switchMode('live'));
  wireBotStrategyTabs();
  wireBotConfigAutoSave();
  wireBotSettingsLock();
  wireSliderDisplays();
}

// ---------- misc: wake lock, orientation, service worker ----------

let wakeLock = null;
async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator) {
      wakeLock = await navigator.wakeLock.request('screen');
    }
  } catch (err) {
    // Non-fatal — some browsers/OS power modes reject this.
    console.warn('[dashboard] wake lock unavailable:', err.message);
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') requestWakeLock();
});

async function tryLockLandscape() {
  try {
    if (screen.orientation && screen.orientation.lock) {
      await screen.orientation.lock('landscape');
    }
  } catch {
    // Only works in installed/fullscreen PWA context on Android; ignore otherwise.
  }
}

function registerServiceWorker() {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('sw.js').catch((err) => {
      console.warn('[dashboard] service worker registration failed:', err.message);
    });
  }
}

// ---------- boot ----------

window.addEventListener('DOMContentLoaded', () => {
  applyFocusModeLayout();
  initWindowCoordination();
  wireSettingsUI();
  wireBotUI();
  document.getElementById('open-windows-btn').addEventListener('click', openOtherWindows);
  registerServiceWorker();
  requestWakeLock();
  tryLockLandscape();
  startPolling();
  setInterval(tickAllCountdowns, 1000);

  // If this is the very first run, nudge the user to set the engine address.
  if (!localStorage.getItem('engineUrl')) {
    openSettings();
  }
});
