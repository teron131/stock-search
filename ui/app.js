/**
 * TERMINAL // Stock News
 * Core Application Logic
 */

const STATE = {
  currentView: 'dashboard', // dashboard | heatmap
  currentTab: 'holdings',   // holdings | evaluations
  sortCol: 'weight_pct',
  sortDir: 'desc',
  data: [],                 // Merged portfolio + eval data
  isLoading: false
};

// --- Configuration ---

const API_ENDPOINTS = {
  dashboard: '/api/dashboard',
  eval: '/api/eval',
  portfolio: '/api/portfolio/position',
};

const ANIMATION_DELAY_MS = 30;
const DEFAULT_BUCKET = 'Tactical Opportunities';

const COLS = {
  holdings: [
    { key: "ticker", label: "TICKER" },
    { key: "quantity", label: "QTY", format: "number" },
    { key: "current_price", label: "PRICE", format: "currency" },
    { key: "change_percent", label: "CHANGE", format: "percent" },
    { key: "notional", label: "VALUE", format: "currency" },
    { key: "weight_pct", label: "WEIGHT", format: "percent" },
    { key: "bucket", label: "STRATEGY" },
    { key: "rsi", label: "RSI", format: "number" },
    { key: "remove", label: "", format: "action" }
  ],
  evaluations: [
    { key: "ticker", label: "TICKER" },
    { key: "rank", label: "RANK" },
    { key: "overall", label: "SCORE", format: "score" },
    { key: "quality", label: "QUALITY", format: "score" },
    { key: "valuation", label: "VALUE", format: "score" },
    { key: "moat", label: "MOAT", format: "score" },
    { key: "upside", label: "UPSIDE", format: "score" },
    { key: "bull", label: "BULL", format: "prob" },
    { key: "bear", label: "BEAR", format: "prob" },
    { key: "remove", label: "", format: "action" }
  ]
};

// --- DOM Elements ---
const el = {
  navItems: document.querySelectorAll('.nav-item'),
  views: {
    dashboard: document.querySelector('.content-area'), // wrapper
    stats: document.querySelector('.overview-panel'),
    tabs: document.querySelector('.tabs-container'),
    heatmap: document.getElementById('heatmap-section'),
    calendar: document.getElementById('calendar-section')
  },
  tabs: document.querySelectorAll('.tab-btn'),
  table: {
    head: document.querySelector('#main-table thead'),
    body: document.querySelector('#main-table tbody')
  },
  stats: {
    positions: document.getElementById('total-positions'),
    value: document.getElementById('total-notional'),
    change: document.getElementById('portfolio-change')
  },
  tickerTape: document.getElementById('ticker-tape-widget'),
  quickAdd: {
    form: document.getElementById('quick-add-form'),
    ticker: document.getElementById('input-ticker'),
    qty: document.getElementById('input-qty')
  },
  refreshBtn: document.getElementById('refresh-btn'),
  viewTitle: document.getElementById('view-title'),
  sidebar: {
    el: document.getElementById('sidebar'),
    toggle: document.getElementById('sidebar-toggle')
  },
  lastUpdate: document.getElementById('last-update'),
  heatmap: {
    tabs: document.querySelectorAll('#heatmap-section .tab-btn'),
    container: document.getElementById('heatmap-widget-container')
  }
};

// --- Utilities ---

function normalizeTicker(ticker) {
  return ticker.replace('-', '.').toUpperCase();
}

// --- Formatters ---
const fmt = {
  currency: (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v),
  percent: (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`,
  number: (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v),
  score: (v) => Number(v).toFixed(1),
  prob: (v) => `${(v * 100).toFixed(0)}%`,
  default: (v) => String(v || '--')
};

// --- Initialization ---
function init() {
  setupEventListeners();
  loadData();
}

function setupEventListeners() {
  // Navigation
  el.navItems.forEach(btn => {
    btn.addEventListener('click', () => switchView(btn.dataset.view));
  });

  // Tabs
  el.tabs.forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  // Quick Add
  el.quickAdd.form.addEventListener('submit', handleAddTicker);

  // Refresh
  el.refreshBtn.addEventListener('click', loadData);

  // Sidebar Toggle
  el.sidebar.toggle.addEventListener('click', toggleSidebar);

  // Heatmap Source Switching
  el.heatmap.tabs.forEach(tab => {
    tab.addEventListener('click', () => switchHeatmapSource(tab.dataset.source));
  });

  // Table Delegation (Sort + Remove)
  el.table.head.addEventListener('click', handleTableClick);
  el.table.body.addEventListener('click', handleTableClick);
}

function toggleSidebar() {
  el.sidebar.el.classList.toggle('collapsed');
}

// --- View Logic ---
function switchView(viewName) {
  STATE.currentView = viewName;
  
  // Update Nav
  el.navItems.forEach(n => n.classList.toggle('active', n.dataset.view === viewName));
  
  // Update Breadcrumbs
  if (el.viewTitle) {
    if (viewName === 'dashboard') el.viewTitle.textContent = 'DASHBOARD';
    else if (viewName === 'heatmap') el.viewTitle.textContent = 'MARKET MAP';
    else if (viewName === 'calendar') el.viewTitle.textContent = 'ECONOMIC CALENDAR';
  }
  
  // Toggle Visibility
  if (viewName === 'dashboard') {
    el.views.stats.style.display = 'flex';
    el.views.tabs.style.display = 'flex';
    el.views.heatmap.style.display = 'none';
    el.views.calendar.style.display = 'none';
  } else if (viewName === 'heatmap') {
    el.views.stats.style.display = 'none';
    el.views.tabs.style.display = 'none';
    el.views.heatmap.style.display = 'block';
    el.views.calendar.style.display = 'none';
  } else if (viewName === 'calendar') {
    el.views.stats.style.display = 'none';
    el.views.tabs.style.display = 'none';
    el.views.heatmap.style.display = 'none';
    el.views.calendar.style.display = 'block';
  }
}

function switchTab(tabName) {
  STATE.currentTab = tabName;
  STATE.sortCol = tabName === 'holdings' ? 'weight_pct' : 'overall';
  STATE.sortDir = 'desc';
  
  el.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  renderTable();
}

function switchHeatmapSource(source) {
  // Update UI
  el.heatmap.tabs.forEach(t => t.classList.toggle('active', t.dataset.source === source));
  
  // Re-inject TradingView Widget with new source
  // The widget script reads the config inside it when it's appended to the DOM
  const container = el.heatmap.container;
  container.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
  
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js';
  script.async = true;
  script.innerHTML = JSON.stringify({
    "dataSource": source,
    "blockSize": "Value.Traded|1W",
    "blockColor": "change",
    "grouping": "sector",
    "locale": "en",
    "symbolUrl": "",
    "colorTheme": "dark",
    "exchanges": ["NYSE", "NASDAQ"],
    "hasTopBar": true,
    "isDataSetEnabled": false,
    "isZoomEnabled": true,
    "hasSymbolTooltip": true,
    "isMonoSize": false,
    "width": "100%",
    "height": "100%"
  });
  
  container.appendChild(script);
}

// --- Data Logic ---

function mergePortfolioAndEvalData(dashData, evalData) {
  const portfolioMap = new Map((dashData.rows || []).map(r => [normalizeTicker(r.ticker), r]));
  const evalMap = new Map(evalData.map(e => [normalizeTicker(e.ticker), e]));
  const allTickers = new Set([...portfolioMap.keys(), ...evalMap.keys()]);

  return Array.from(allTickers).map(ticker => {
    const p = portfolioMap.get(ticker) || {};
    const e = evalMap.get(ticker) || {};
    const safeTicker = p.ticker || e.ticker || ticker;

    return {
      ...p,
      ...e,
      ticker: safeTicker,
      name: p.name || e.name || safeTicker,
    };
  });
}

async function loadData() {
  if (STATE.isLoading) return;
  STATE.isLoading = true;
  el.refreshBtn.style.opacity = '0.5';

  try {
    const [dashRes, evalRes] = await Promise.all([
      fetch(API_ENDPOINTS.dashboard),
      fetch(API_ENDPOINTS.eval),
    ]);

    if (!dashRes.ok || !evalRes.ok) throw new Error('System Error: API Failure');

    const dashData = await dashRes.json();
    const evalData = await evalRes.json();

    STATE.data = mergePortfolioAndEvalData(dashData, evalData);
    updateStats();
    updateTickerTape();
    renderTable();
    updateTimestamp();
  } catch (err) {
    console.error(err);
    alert('SYSTEM ERROR: Could not fetch data.');
  } finally {
    STATE.isLoading = false;
    el.refreshBtn.style.opacity = '1';
  }
}

function calculateWeightedChange(data, totalVal) {
  if (totalVal <= 0) return 0;
  return data.reduce((acc, r) => acc + ((r.change_percent || 0) * (r.notional || 0)), 0) / totalVal;
}

function updateStats() {
  el.stats.positions.textContent = STATE.data.length;

  const totalVal = STATE.data.reduce((acc, r) => acc + (r.notional || 0), 0);
  el.stats.value.textContent = fmt.currency(totalVal);

  const weightedChange = calculateWeightedChange(STATE.data, totalVal);
  el.stats.change.textContent = fmt.percent(weightedChange);
  el.stats.change.className = `stat-trend ${weightedChange >= 0 ? 'positive' : 'negative'}`;
}

function updateTimestamp() {
  if (!el.lastUpdate) return;
  const now = new Date();
  const dateStr = now.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
  const timeStr = now.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  el.lastUpdate.textContent = `LAST UPDATED: ${dateStr} ${timeStr}`;
}

function updateTickerTape() {
  if (!el.tickerTape || !STATE.data.length) return;

  // Sort by weight descending, then extract unique tickers
  const sortedData = [...STATE.data].sort((a, b) => (b.weight_pct || 0) - (a.weight_pct || 0));
  
  const tickers = [];
  const seen = new Set();
  
  for (const item of sortedData) {
    const t = normalizeTicker(item.ticker);
    if (t && t.length > 0 && t.length < 10 && !seen.has(t)) {
      tickers.push(t);
      seen.add(t);
    }
    if (tickers.length >= 20) break;
  }

  // Format as comma-separated string: "NVDA,GOOGL,TSM,..."
  el.tickerTape.setAttribute('symbols', tickers.join(','));
}

// --- Table Rendering ---

function compareValues(a, b, sortDir) {
  if (a < b) return sortDir === 'asc' ? -1 : 1;
  if (a > b) return sortDir === 'asc' ? 1 : -1;
  return 0;
}

function sortData(data, sortCol, sortDir) {
  return [...data].sort((a, b) => {
    let valA = a[sortCol];
    let valB = b[sortCol];

    if (valA == null) return 1;
    if (valB == null) return -1;

    if (typeof valA === 'string') {
      valA = valA.toLowerCase();
      valB = valB.toLowerCase();
    }

    return compareValues(valA, valB, sortDir);
  });
}

function renderTableHead(cols) {
  let html = '<tr>';
  cols.forEach(col => {
    if (col.key === 'remove') {
      html += '<th></th>';
    } else {
      const classList = [];
      if (STATE.sortCol === col.key) {
        classList.push('sorted', STATE.sortDir);
      }
      html += `<th data-sort="${col.key}" class="${classList.join(' ')}">${col.label}</th>`;
    }
  });
  html += '</tr>';
  el.table.head.innerHTML = html;
}

function renderTable() {
  const cols = COLS[STATE.currentTab];
  const sorted = sortData(STATE.data, STATE.sortCol, STATE.sortDir);

  renderTableHead(cols);

  const fragment = document.createDocumentFragment();
  sorted.forEach((row, i) => {
    const tr = createRow(row, cols, i);
    fragment.appendChild(tr);
  });
  el.table.body.innerHTML = '';
  el.table.body.appendChild(fragment);
}

function createBadge(content, className) {
  const span = document.createElement('span');
  span.className = className;
  span.textContent = content;
  return span;
}

function createPercentBadge(val, content) {
  return createBadge(content, `badge ${val >= 0 ? 'positive' : 'negative'}`);
}

function createScoreBadge(val, content) {
  let scoreClass = 'score-mid';
  if (val >= 8) scoreClass = 'score-high';
  if (val <= 4) scoreClass = 'score-low';
  return createBadge(content, scoreClass);
}

function formatCellValue(row, col) {
  const val = row[col.key];
  if (col.format && fmt[col.format]) {
    return fmt[col.format](val);
  }
  return fmt.default(val);
}

function createCell(row, col) {
  const td = document.createElement('td');
  const val = row[col.key];

  if (col.key === 'remove') {
    const btn = document.createElement('button');
    btn.className = 'btn-remove-cell';
    btn.innerHTML = '&times;';
    btn.dataset.ticker = row.ticker;
    td.appendChild(btn);
  } else if (col.key === 'ticker') {
    const tag = document.createElement('tv-ticker-tag');
    tag.setAttribute('symbol', val);
    tag.setAttribute('preserve-text', '');
    tag.setAttribute('hide-change', '');
    tag.setAttribute('hide-background', '');
    tag.setAttribute('transparent', '');
    tag.textContent = val; // Fallback text
    td.appendChild(tag);
  } else {
    const content = formatCellValue(row, col);

    if (col.format === 'percent' && val != null) {
      td.appendChild(createPercentBadge(val, content));
    } else if (col.format === 'score' && val != null) {
      td.appendChild(createScoreBadge(val, content));
    } else {
      td.textContent = content;
    }
  }

  return td;
}

function createRow(row, cols, index) {
  const tr = document.createElement('tr');
  tr.style.animationDelay = `${index * ANIMATION_DELAY_MS}ms`;
  tr.classList.add('animate-in');

  cols.forEach(col => {
    tr.appendChild(createCell(row, col));
  });

  return tr;
}

// --- Interaction Handlers ---
function handleTableClick(e) {
  // Sort Handling
  if (e.target.tagName === 'TH' && e.target.dataset.sort) {
    const key = e.target.dataset.sort;
    if (STATE.sortCol === key) {
      STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc';
    } else {
      STATE.sortCol = key;
      STATE.sortDir = 'desc';
    }
    renderTable();
  }

  // Remove Handling
  if (e.target.classList.contains('btn-remove-cell')) {
    const ticker = e.target.dataset.ticker;
    handleRemove(ticker);
  }
}

async function handleRemove(ticker) {
  if (!confirm(`CONFIRM: Eliminate ${ticker} from portfolio?`)) return;
  try {
    const res = await fetch(`${API_ENDPOINTS.portfolio}/${ticker}`, { method: 'DELETE' });
    if (res.ok) await loadData();
  } catch (err) {
    console.error(err);
    alert('Failed to remove asset.');
  }
}

async function handleAddTicker(e) {
  e.preventDefault();
  const ticker = el.quickAdd.ticker.value.toUpperCase();
  const quantity = parseFloat(el.quickAdd.qty.value);

  const existing = STATE.data.find(d => d.ticker.toUpperCase() === ticker);
  const bucket = existing ? existing.bucket : DEFAULT_BUCKET;
  const name = existing ? existing.name : ticker;

  const payload = {
    ticker,
    name,
    quantity,
    bucket,
    delta: 1.0,
    current_price: 0.0,
  };

  try {
    const res = await fetch(API_ENDPOINTS.portfolio, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    if (res.ok) {
      el.quickAdd.form.reset();
      await loadData();
    } else {
      throw new Error('API Error');
    }
  } catch (err) {
    alert('Failed to add asset.');
    console.error(err);
  }
}

// Start
init();
