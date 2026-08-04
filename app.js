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
    el.textContent = 'Settling…';
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
    el.textContent = 'Settling…';
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
  const body = document.getElementById('bot-status-body');
  try {
    const res = await fetch(`${engineUrl}/api/bot/status`, { cache: 'no-store' });
    const data = await res.json();
    if (!data.enabled) {
      modeLine.textContent = data.message || 'Bot is not enabled on the engine.';
      body.innerHTML = '';
      renderBotDashboard(data);
      return;
    }
    const mode = data.config.mode;
    modeLine.textContent = `Mode: ${mode === 'live' ? 'LIVE (real orders)' : 'Paper (simulated)'} · Trading ${data.config.symbol}`;
    updateModeButtons(mode, data.config.liveAuthorized);

    const chips = [];
    const open = data.openTrades && data.openTrades[0];
    const hasValidEntryPrice = open && Number.isFinite(open.entryPriceCents) && open.entryPriceCents > 0;
    const side = open && typeof open.side === 'string' ? open.side.toUpperCase() : '—';
    const stake = open && Number.isFinite(open.stakeDollars) ? open.stakeDollars.toFixed(2) : '—';
    chips.push(chip('Open position', open
      ? hasValidEntryPrice ? `${open.symbol || 'Unknown'} ${side} @ ${open.entryPriceCents}¢ ($${stake})` : `${open.symbol || 'Unknown'} ${side} · awaiting a valid quote`
      : 'None'));
    chips.push(chip('Trades opened', data.stats.totalAttempts));
    chips.push(chip('Settled', data.stats.totalTrades));
    chips.push(chip('Profitable exits', data.stats.profitableExits));
    chips.push(chip('Win rate', data.stats.winRatePct != null ? `${data.stats.winRatePct}%` : '—'));
    chips.push(chip('Current streak', `${data.stats.currentWinStreak} win${data.stats.currentWinStreak === 1 ? '' : 's'}`));
    chips.push(chip('Best streak', `${data.stats.longestWinStreak} win${data.stats.longestWinStreak === 1 ? '' : 's'}`));
    const capital = data.capital;
    if (capital) {
      chips.push(chip('Guardrail remaining', `$${((capital.guardrailRemainingCents || 0) / 100).toFixed(2)} / $${((capital.guardrailCents || 0) / 100).toFixed(2)}`));
      if (data.config.mode === 'live') {
        chips.push(chip('Kalshi available', capital.liveAvailableCents == null ? 'Checking…' : `$${(capital.liveAvailableCents / 100).toFixed(2)}`));
      }
    }
    if (data.lastDecision) chips.push(chip('Decision', data.lastDecision));
    if (data.lastError) chips.push(chip('Last error', data.lastError));
    body.innerHTML = `${buildCapitalLedgerHtml(capital)}${chips.join('')}`;
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
  return `Running ${hours}h ${String(minutes).padStart(2, '0')}m ${String(secs).padStart(2, '0')}s`;
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
    return;
  }
  toggle.hidden = false;
  const mode = data.config.mode === 'live' ? 'LIVE' : 'PAPER';
  state.textContent = `${mode} · ${data.isRunning ? formatBotRuntime(data.runningSince) : 'Stopped'} · ${data.lastDecision || ''}`;
  const capital = data.capital || {};
  stats.innerHTML = [
    buildCapitalLedgerHtml(capital),
    chip('Trades opened', data.stats.totalAttempts),
    chip('Profitable exits', data.stats.profitableExits),
  ].join('');
  toggle.textContent = data.isRunning ? 'Stop new trades' : 'Start bot';
  toggle.dataset.running = String(!data.isRunning);
  const overlayToggle = document.getElementById('bot-running-toggle');
  const timer = document.getElementById('bot-running-timer');
  if (overlayToggle) overlayToggle.textContent = toggle.textContent;
  if (timer) timer.textContent = data.isRunning ? formatBotRuntime(data.runningSince) : 'Stopped';
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

function formatMoneyCents(cents, { signed = false } = {}) {
  const value = (Number(cents) || 0) / 100;
  const abs = `$${Math.abs(value).toFixed(2)}`;
  if (!signed) return value < 0 ? `-${abs}` : abs;
  if (value > 0) return `+${abs}`;
  if (value < 0) return `-${abs}`;
  return abs;
}

/**
 * Display-only capital ledger. Uses existing capital fields as-is:
 * Available Cash + Open Positions + Reserved Profit = Total Equity
 * Net P&L = Total Equity − Starting Bankroll
 */
function buildCapitalLedgerHtml(capital) {
  if (!capital) return '';
  const starting = Number(capital.startingCents) || 0;
  const available = Number(capital.paperAvailableCents) || 0;
  const openPositions = Number(capital.openExposureCents) || 0;
  const reserved = Number(capital.reserveCents) || 0;
  const totalEquity = available + openPositions + reserved;
  const netPnl = totalEquity - starting;
  const pnlClass = netPnl > 0 ? 'chip-positive' : netPnl < 0 ? 'chip-negative' : '';

  return `
    <div class="capital-ledger">
      <div class="capital-ledger-title">Capital</div>
      <div class="capital-row"><span>Starting Bankroll</span><span>${formatMoneyCents(starting)}</span></div>
      <div class="capital-row"><span>Available Cash</span><span>${formatMoneyCents(available)}</span></div>
      <div class="capital-row"><span>Open Positions Value</span><span>${formatMoneyCents(openPositions)}</span></div>
      <div class="capital-row"><span>Reserved Profit</span><span>${formatMoneyCents(reserved)}</span></div>
      <div class="capital-divider"></div>
      <div class="capital-row capital-total"><span>Total Equity</span><span>${formatMoneyCents(totalEquity)}</span></div>
      <div class="capital-row capital-pnl"><span>Net P&amp;L</span><span class="${pnlClass}">${formatMoneyCents(netPnl, { signed: true })}</span></div>
      <p class="capital-formula">Total Equity = Available Cash + Open Positions + Reserved Profit</p>
    </div>`;
}

function chip(label, value, colorClass) {
  const cls = colorClass ? (colorClass === 'up' ? 'chip-positive' : 'chip-negative') : '';
  return `<div class="bot-stat-chip"><span class="stat-label">${label}</span><span class="stat-value${cls ? ' ' + cls : ''}">${value}</span></div>`;
}

const SLIDER_UNITS = {
  'bot-edge': (v) => `${(+v).toFixed(1)}%`,
  'bot-confidence': (v) => `${Math.round(v)}%`,
  'bot-stoploss': (v) => `${Math.round(v)}¢`,
  'bot-stake': (v) => `$${Math.round(v)}`,
  'bot-maxpos': (v) => `${Math.round(v)}`,
  'bot-guardrail': (v) => `$${Math.round(v)}`,
  'bot-paper-balance': (v) => `$${Math.round(v)}`,
};

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
  if (!input || !display) return;
  display.textContent = mode === 'percent' ? `${Math.round(input.value)}%` : `$${Math.round(input.value)}`;
}

function wireSliderDisplays() {
  ['bot-edge', 'bot-confidence', 'bot-stoploss', 'bot-stake', 'bot-maxpos', 'bot-guardrail', 'bot-paper-balance'].forEach((id) => {
    const input = document.getElementById(id);
    if (input) input.addEventListener('input', () => updateSliderDisplay(id));
  });
  const skimAmount = document.getElementById('bot-skim-amount');
  if (skimAmount) skimAmount.addEventListener('input', updateSkimSliderDisplay);
  const skimMode = document.getElementById('bot-skim-mode');
  if (skimMode) skimMode.addEventListener('change', updateSkimSliderDisplay);
}

async function loadBotConfigIntoForm() {
  const { engineUrl } = loadSettings();
  try {
    const res = await fetch(`${engineUrl}/api/bot/config`, { cache: 'no-store' });
    if (!res.ok) return;
    const data = await res.json();
    const c = data.config;
    document.getElementById('bot-symbol').value = c.symbol;
    const backtestSymbol = document.getElementById('backtest-symbol');
    if (backtestSymbol && [...backtestSymbol.options].some((o) => o.value === c.symbol)) {
      backtestSymbol.value = c.symbol;
    }
    document.getElementById('bot-edge').value = c.edgeThresholdPct;
    document.getElementById('bot-confidence').value = c.minConfidence;
    document.getElementById('bot-stoploss').value = c.stopLossCents;
    document.getElementById('bot-stake').value = c.stakeDollars;
    document.getElementById('bot-maxpos').value = c.maxOpenPositions;
    document.getElementById('bot-guardrail').value = c.guardrailDollars;
    document.getElementById('bot-paper-balance').value = c.paperStartingBalanceDollars;
    document.getElementById('bot-skim-mode').value = c.skimMode;
    document.getElementById('bot-skim-amount').value = c.skimMode === 'percent' ? c.skimPercent : c.skimFixedDollars;
    ['bot-edge', 'bot-confidence', 'bot-stoploss', 'bot-stake', 'bot-maxpos', 'bot-guardrail', 'bot-paper-balance'].forEach(updateSliderDisplay);
    updateSkimSliderDisplay();
  } catch {
    // Bot likely disabled or engine unreachable — form just stays blank.
  }
}

async function saveBotConfig() {
  const { engineUrl } = loadSettings();
  const feedback = document.getElementById('bot-settings-feedback');
  const skimMode = document.getElementById('bot-skim-mode').value;
  const skimAmount = parseFloat(document.getElementById('bot-skim-amount').value);
  const payload = {
    symbol: document.getElementById('bot-symbol').value,
    edgeThresholdPct: parseFloat(document.getElementById('bot-edge').value),
    minConfidence: parseFloat(document.getElementById('bot-confidence').value),
    stopLossCents: parseFloat(document.getElementById('bot-stoploss').value),
    stakeDollars: parseFloat(document.getElementById('bot-stake').value),
    maxOpenPositions: parseFloat(document.getElementById('bot-maxpos').value),
    guardrailDollars: parseFloat(document.getElementById('bot-guardrail').value),
    paperStartingBalanceDollars: parseFloat(document.getElementById('bot-paper-balance').value),
    skimMode,
    ...(skimMode === 'percent' ? { skimPercent: skimAmount } : { skimFixedDollars: skimAmount }),
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
    feedback.textContent = '✓ Settings saved.';
    feedback.style.color = 'var(--up)';
    refreshBotStatus();
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
    stakeDollars: parseFloat(document.getElementById('bot-stake').value),
    maxOpenPositions: parseFloat(document.getElementById('bot-maxpos').value),
    guardrailDollars: parseFloat(document.getElementById('bot-guardrail').value),
    paperStartingBalanceDollars: parseFloat(document.getElementById('bot-paper-balance').value),
    skimMode,
    ...(skimMode === 'percent' ? { skimPercent: skimAmount } : { skimFixedDollars: skimAmount }),
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
  ['bot-edge', 'bot-confidence', 'bot-stoploss'].forEach(updateSliderDisplay);
}

function renderBacktestResults(data, dayLabel) {
  const t = data.trading || {};
  const s = data.settingsUsed || {};
  const skimLabel =
    s.skimMode === 'off'
      ? 'off'
      : s.skimMode === 'percent'
        ? `${s.skimPercent}% of profit`
        : `$${Number(s.skimFixedDollars || 0).toFixed(0)} per win`;
  const pnlClass = (t.netPnlCents || 0) > 0 ? 'chip-positive' : (t.netPnlCents || 0) < 0 ? 'chip-negative' : '';
  const modeLabel = data.mode === 'AUTO' || t.mode === 'AUTO' ? 'AUTO' : data.symbol;
  const scanned = (data.symbolsScanned || t.symbolsScanned || [data.symbol]).join(', ');
  const settingsLine = `Edge ≥ ${s.edgeThresholdPct}% · Confidence ≥ ${s.minConfidence}% · Stake $${s.stakeDollars} · Stop ${s.stopLossCents}¢ · Max pos ${s.maxOpenPositions} · Guardrail $${s.guardrailDollars} · Skim ${skimLabel} · Bankroll $${s.paperStartingBalanceDollars}`;
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
          `<div class="backtest-row"><span>#${i + 1} edge ${row.settings.edgeThresholdPct}% · conf ${row.settings.minConfidence}% · stop ${row.settings.stopLossCents}¢</span><span>${row.winRatePct != null ? row.winRatePct + '%' : '—'} WR · ${row.trades} trades · ${formatMoneyFromCents(row.netPnlCents, { signed: true })}</span></div>`
      )
      .join('');
    huntBlock = `
      <div class="capital-ledger backtest-ledger">
        <div class="capital-ledger-title">Hunt result — best win rate + profit</div>
        <p class="backtest-settings-line">Searched ${data.hunt.searched} setting combos. Winner: edge ${best.settings.edgeThresholdPct}% · confidence ${best.settings.minConfidence}% · stop ${best.settings.stopLossCents}¢</p>
        <p class="backtest-settings-line">Those values were applied to the settings sliders above — save settings if you want the live bot to use them.</p>
        <div class="backtest-recent-title">Top combos</div>
        ${topRows}
      </div>`;
    applyHuntedSettingsToForm(best.settings);
  }

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
      <div class="capital-divider"></div>
      <div class="capital-row"><span>Starting Bankroll</span><span>${formatMoneyFromCents(t.startingBankrollCents)}</span></div>
      <div class="capital-row"><span>Available Cash</span><span>${formatMoneyFromCents(t.availableCashCents)}</span></div>
      <div class="capital-row"><span>Open Positions Value</span><span>${formatMoneyFromCents(t.openPositionsValueCents)}</span></div>
      <div class="capital-row"><span>Reserved Profit</span><span>${formatMoneyFromCents(t.reservedProfitCents)}</span></div>
      <div class="capital-divider"></div>
      <div class="capital-row capital-total"><span>Total Equity</span><span>${formatMoneyFromCents(t.totalEquityCents)}</span></div>
      <div class="capital-row capital-pnl"><span>Net P&amp;L</span><span class="${pnlClass}">${formatMoneyFromCents(t.netPnlCents, { signed: true })}</span></div>
    </div>`;

  const skips = t.skipCounts || {};
  const skipBlock = `
    <div class="backtest-skips">
      <span>Skipped setups — low confidence: ${skips.lowConfidence || 0}, low edge: ${skips.lowEdge || 0}, guardrail: ${skips.guardrail || 0}, cash: ${skips.insufficientCash || 0}</span>
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

function updateModeButtons(mode, liveAuthorized) {
  const paperBtn = document.getElementById('mode-btn-paper');
  const liveBtn = document.getElementById('mode-btn-live');
  paperBtn.classList.toggle('active-mode', mode === 'paper');
  liveBtn.classList.toggle('active-mode', mode === 'live');
  liveBtn.classList.toggle('locked', !liveAuthorized);
  liveBtn.title = liveAuthorized
    ? ''
    : 'Not authorized on this server — requires KALSHI_LIVE_TRADING and KALSHI_LIVE_TRADING_CONFIRM env vars plus a restart.';
}

async function switchMode(requestedMode) {
  const { engineUrl } = loadSettings();
  const feedback = document.getElementById('mode-toggle-feedback');

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
  document.getElementById('bot-settings-save').addEventListener('click', saveBotConfig);
  document.getElementById('bot-running-toggle').addEventListener('click', () => {
    const isRunning = document.getElementById('bot-running-toggle').textContent !== 'Start bot';
    setBotRunning(!isRunning);
  });
  document.getElementById('bot-dashboard-toggle').addEventListener('click', (event) => setBotRunning(event.currentTarget.dataset.running === 'true'));
  document.getElementById('bot-dashboard-open').addEventListener('click', openBotOverlay);
  document.getElementById('bot-reset-paper').addEventListener('click', resetPaperHistory);
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
