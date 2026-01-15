/**
 * TERMINAL // Stock News
 * Core Application Logic
 */

// --- Configuration ---
const CONFIG = {
  isDemoMode: window.location.hostname.includes('github.io') || new URLSearchParams(window.location.search).get('demo') === 'true',
  animationDelayMs: 30,
  defaultBucket: 'Tactical Opportunities',
  maxTickerLength: 10,
  maxTickerTapeCount: 20,
  scoreThresholds: { high: 8, low: 4 },
  endpoints: {
    portfolio: '/api/portfolio',
    eval: '/api/eval',
    position: '/api/portfolio/position',
  },
  demoPaths: {
    primary: 'data',
    fallback: 'sample_data'
  },
  heatmapWidget: {
    blockSize: "Value.Traded|1W",
    blockColor: "change",
    grouping: "sector",
    locale: "en",
    symbolUrl: "",
    colorTheme: "dark",
    exchanges: ["NYSE", "NASDAQ"],
    hasTopBar: true,
    isDataSetEnabled: false,
    isZoomEnabled: true,
    hasSymbolTooltip: true,
    isMonoSize: false,
    width: "100%",
    height: "100%"
  }
};

const CSS_CLASSES = {
  active: 'active',
  sorted: 'sorted',
  positive: 'positive',
  negative: 'negative',
  neutral: 'neutral',
  collapsed: 'collapsed',
  btnRemove: 'btn-remove-cell',
  badge: 'badge',
  animateIn: 'animate-in'
};

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

const VIEW_TITLES = {
  dashboard: 'DASHBOARD',
  heatmap: 'MARKET MAP',
  calendar: 'ECONOMIC CALENDAR'
};

const EMPTY_TABLE_MESSAGES = {
  holdings: 'NO ACTIVE POSITIONS FOUND',
  evaluations: 'NO EVALUATIONS FOUND'
};

const VIEW_NAMES = {
  dashboard: 'dashboard',
  heatmap: 'heatmap',
  calendar: 'calendar'
};

const TAB_NAMES = {
  holdings: 'holdings',
  evaluations: 'evaluations'
};

const SORT_DIRECTIONS = {
  asc: 'asc',
  desc: 'desc'
};

const DEFAULT_SORT_COLS = {
  holdings: 'weight_pct',
  evaluations: 'overall'
};

const DEMO_MESSAGES = {
  changesNotSaved: 'Demo Mode: Changes not saved.',
  usingPath: (path) => `Demo Mode: Using ${path}/`
};

const CONFIRMATION_MESSAGES = {
  removePosition: (ticker) => `CONFIRM: Eliminate ${ticker} from portfolio?`
};

const ERROR_MESSAGES = {
  apiFailure: 'API Failure',
  dataEmpty: (path) => `Data empty in ${path}`,
  removeFailed: 'Failed to remove asset.',
  addFailed: 'Failed to add asset.'
};

const TOAST_STYLES = {
  position: 'fixed',
  bottom: '20px',
  right: '20px',
  background: '#333',
  color: '#fff',
  padding: '12px 24px',
  borderRadius: '4px',
  borderLeft: '4px solid #00f2fe',
  zIndex: '10000',
  fontFamily: 'var(--font-mono)',
  fontSize: '12px',
  boxShadow: '0 4px 12px rgba(0,0,0,0.5)',
  animation: 'fadeIn 0.3s ease-out'
};

const TOAST_DURATION_MS = 3000;
const TOAST_FADE_DURATION_MS = 500;

const DATE_FORMAT_OPTIONS = { month: 'short', day: '2-digit' };
const TIME_FORMAT_OPTIONS = { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' };

// --- Application State ---
const STATE = {
  currentView: VIEW_NAMES.dashboard,
  currentTab: TAB_NAMES.holdings,
  sortCol: DEFAULT_SORT_COLS.holdings,
  sortDir: SORT_DIRECTIONS.desc,
  data: [],
  isLoading: false,
  isUsingDemoData: false
};

// --- DOM References ---
const DOM = {
  navItems: document.querySelectorAll('.nav-item'),
  views: {
    dashboard: document.querySelector('.content-area'),
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
  tickerTapeContainer: document.getElementById('ticker-tape-view'),
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
const Utils = {
  normalizeTicker: (ticker) => ticker.replace('-', '.').toUpperCase(),
  
  format: {
    currency: (value) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(value),
    percent: (value) => {
      const sign = value > 0 ? '+' : '';
      return `${sign}${Number(value).toFixed(2)}%`;
    },
    number: (value) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(value),
    score: (value) => Number(value).toFixed(1),
    prob: (value) => `${(value * 100).toFixed(0)}%`,
    default: (value) => String(value || '--')
  },

  calculateWeightedChange: (data, totalVal) => {
    if (totalVal <= 0) return 0;
    return data.reduce((acc, r) => acc + ((r.change_percent || 0) * (r.notional || 0)), 0) / totalVal;
  },

  mergeData: (dashData, evalData) => {
    const portfolioMap = new Map((dashData.rows || []).map(r => [Utils.normalizeTicker(r.ticker), r]));
    const evalMap = new Map(evalData.map(e => [Utils.normalizeTicker(e.ticker), e]));
    const allTickers = new Set([...portfolioMap.keys(), ...evalMap.keys()]);

    return Array.from(allTickers).map(ticker => {
      const p = portfolioMap.get(ticker) || {};
      const e = evalMap.get(ticker) || {};
      const safeTicker = p.ticker || e.ticker || ticker;
      return {
        ...p, ...e,
        ticker: safeTicker,
        name: p.name || e.name || safeTicker,
      };
    });
  },

  /**
   * Calculates portfolio weights for each row (mutates data in place).
   * Returns the total portfolio value.
   */
  calculateAndAssignWeights: (data) => {
    const totalVal = data.reduce((acc, r) => acc + (r.notional || 0), 0);
    if (totalVal > 0) {
      data.forEach(row => {
        row.weight_pct = (row.notional / totalVal) * 100;
      });
    }
    return totalVal;
  }
};

const CellRenderers = {
  remove: (row) => `<button class="${CSS_CLASSES.btnRemove}" data-ticker="${row.ticker}">&times;</button>`,
  ticker: (row, val) => `<tv-ticker-tag symbol="${val}" preserve-text hide-change hide-background theme="dark" transparent>${val}</tv-ticker-tag>`,
  percent: (row, val, formatter) => {
    const badgeClass = val >= 0 ? CSS_CLASSES.positive : CSS_CLASSES.negative;
    return `<span class="${CSS_CLASSES.badge} ${badgeClass}">${formatter(val)}</span>`;
  },
  score: (row, val, formatter) => {
    const { high, low } = CONFIG.scoreThresholds;
    const scoreClass = val >= high ? 'score-high' : val <= low ? 'score-low' : 'score-mid';
    return `<span class="${scoreClass}">${formatter(val)}</span>`;
  },
  default: (row, val, formatter) => formatter(val)
};


// --- UI Logic ---
const UI = {
  updateViewVisibility: (viewName) => {
    const isDashboard = viewName === VIEW_NAMES.dashboard;
    DOM.views.stats.style.display = isDashboard ? 'flex' : 'none';
    DOM.views.tabs.style.display = isDashboard ? 'flex' : 'none';
    DOM.views.heatmap.style.display = viewName === VIEW_NAMES.heatmap ? 'block' : 'none';
    DOM.views.calendar.style.display = viewName === VIEW_NAMES.calendar ? 'block' : 'none';
  },

  switchView: (viewName) => {
    STATE.currentView = viewName;
    DOM.navItems.forEach(n => n.classList.toggle(CSS_CLASSES.active, n.dataset.view === viewName));
    
    if (DOM.viewTitle) {
      DOM.viewTitle.textContent = VIEW_TITLES[viewName] || 'TERMINAL';
    }
    
    UI.updateViewVisibility(viewName);
    
    if (DOM.tickerTape) {
      DOM.tickerTape.setAttribute('theme', 'dark');
    }
  },

  switchTab: (tabName) => {
    STATE.currentTab = tabName;
    STATE.sortCol = DEFAULT_SORT_COLS[tabName] || DEFAULT_SORT_COLS.holdings;
    STATE.sortDir = SORT_DIRECTIONS.desc;
    DOM.tabs.forEach(t => t.classList.toggle(CSS_CLASSES.active, t.dataset.tab === tabName));
    UI.renderTable();
  },

  getTrendClass: (change, totalVal) => {
    if (totalVal <= 0) return CSS_CLASSES.neutral;
    if (change > 0) return CSS_CLASSES.positive;
    if (change < 0) return CSS_CLASSES.negative;
    return CSS_CLASSES.neutral;
  },

  updateStats: (totalVal) => {
    DOM.stats.positions.textContent = STATE.data.length || '--';
    const computedTotal = totalVal == null ? Utils.calculateAndAssignWeights(STATE.data) : totalVal;
    DOM.stats.value.textContent = computedTotal > 0 ? Utils.format.currency(computedTotal) : '--';

    const change = Utils.calculateWeightedChange(STATE.data, computedTotal);
    DOM.stats.change.textContent = computedTotal > 0 ? Utils.format.percent(change) : '--';
    
    const trendClass = UI.getTrendClass(change, computedTotal);
    DOM.stats.change.className = `stat-trend ${trendClass}`;
  },

  updateTimestamp: (customTime) => {
    if (!DOM.lastUpdate) return;
    const time = customTime ? new Date(customTime) : new Date();
    const dateStr = time.toLocaleDateString('en-US', DATE_FORMAT_OPTIONS);
    const timeStr = time.toLocaleTimeString('en-US', TIME_FORMAT_OPTIONS);
    const modeText = STATE.isUsingDemoData ? " [DEMO]" : "";
    DOM.lastUpdate.textContent = `LAST UPDATED: ${dateStr} ${timeStr}${modeText}`;
  },

  updateTickerTape: () => {
    if (!DOM.tickerTape) return;
    if (!STATE.data.length) {
      DOM.tickerTape.setAttribute('symbols', '');
      DOM.tickerTapeContainer.style.display = 'none';
      return;
    }

    DOM.tickerTapeContainer.style.display = 'block';
    const tickers = [...STATE.data]
      .sort((a, b) => (b.weight_pct || 0) - (a.weight_pct || 0))
      .map(item => Utils.normalizeTicker(item.ticker))
      .filter((t, i, self) => t && t.length < CONFIG.maxTickerLength && self.indexOf(t) === i)
      .slice(0, CONFIG.maxTickerTapeCount);

    DOM.tickerTape.setAttribute('symbols', tickers.join(','));
  },

  sortData: (data, col, dir) => {
    return [...data].sort((a, b) => {
      const valA = a[col];
      const valB = b[col];
      
      if (valA == null) return 1;
      if (valB == null) return -1;
      
      const normalizedA = typeof valA === 'string' ? valA.toLowerCase() : valA;
      const normalizedB = typeof valB === 'string' ? valB.toLowerCase() : valB;
      
      if (normalizedA === normalizedB) return 0;
      
      const comparison = normalizedA < normalizedB ? -1 : 1;
      return dir === SORT_DIRECTIONS.asc ? comparison : -comparison;
    });
  },

  getFilteredRows: () => {
    const isHoldingsTab = STATE.currentTab === TAB_NAMES.holdings;
    const hasHolding = (row) => row.quantity != null && row.notional != null;
    const hasEvaluation = (row) => row.overall != null || row.rank != null;
    return STATE.data.filter(isHoldingsTab ? hasHolding : hasEvaluation);
  },

  buildTableHead: (cols) => {
    const headCells = cols.map(col => {
      if (col.key === 'remove') return '<th></th>';
      const sortedClass = STATE.sortCol === col.key ? `${CSS_CLASSES.sorted} ${STATE.sortDir}` : '';
      return `<th data-sort="${col.key}" class="${sortedClass}">${col.label}</th>`;
    }).join('');
    DOM.table.head.innerHTML = `<tr>${headCells}</tr>`;
  },

  buildTableCell: (row, col) => {
    const td = document.createElement('td');
    const val = row[col.key];

    // Lookup order: specific column renderer (e.g., 'ticker', 'remove') → format renderer → default
    const renderer = CellRenderers[col.key] || CellRenderers[col.format] || CellRenderers.default;
    const formatter = Utils.format[col.format] || Utils.format.default;

    const content = renderer(row, val, formatter);
    // Use innerHTML for custom renderers that return HTML (all except default text renderer)
    const needsHtmlParsing = renderer !== CellRenderers.default;
    
    if (needsHtmlParsing) {
      td.innerHTML = content;
    } else {
      td.textContent = content;
    }
    
    return td;
  },

  buildTableRow: (row, cols, rowIndex) => {
    const tr = document.createElement('tr');
    tr.style.animationDelay = `${rowIndex * CONFIG.animationDelayMs}ms`;
    tr.classList.add(CSS_CLASSES.animateIn);

    cols.forEach(col => {
      tr.appendChild(UI.buildTableCell(row, col));
    });

    return tr;
  },

  renderEmptyTable: (colSpan) => {
    const emptyMsg = EMPTY_TABLE_MESSAGES[STATE.currentTab] || 'NO DATA FOUND';
    DOM.table.body.innerHTML = `<tr><td colspan="${colSpan}" style="text-align: center; color: var(--muted); height: 200px; font-family: var(--font-mono);">${emptyMsg}</td></tr>`;
  },

  renderTable: () => {
    const cols = COLS[STATE.currentTab];
    
    const filtered = UI.getFilteredRows();
    const sorted = UI.sortData(filtered, STATE.sortCol, STATE.sortDir);
    UI.buildTableHead(cols);

    // Render Body
    DOM.table.body.innerHTML = '';
    if (sorted.length === 0) {
      UI.renderEmptyTable(cols.length);
      return;
    }

    const fragment = document.createDocumentFragment();
    sorted.forEach((row, i) => {
      fragment.appendChild(UI.buildTableRow(row, cols, i));
    });
    DOM.table.body.appendChild(fragment);
  },

  showToast: (message) => {
    const toast = document.createElement('div');
    Object.assign(toast.style, TOAST_STYLES);
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transition = `opacity ${TOAST_FADE_DURATION_MS}ms`;
      setTimeout(() => toast.remove(), TOAST_FADE_DURATION_MS);
    }, TOAST_DURATION_MS);
  }
};

// --- Data Logic ---
const Data = {
  fetchPortfolioData: async (endpoints) => {
    const [dashRes, evalRes] = await Promise.all([
      fetch(endpoints.portfolio),
      fetch(endpoints.eval)
    ]);
    
    if (!dashRes.ok || !evalRes.ok) throw new Error(ERROR_MESSAGES.apiFailure);
    
    return {
      dashData: await dashRes.json(),
      evalData: await evalRes.json()
    };
  },

  determineDemoPath: async () => {
    try {
      const testRes = await fetch(`${CONFIG.demoPaths.primary}/portfolio.json`);
      return testRes.ok ? CONFIG.demoPaths.primary : CONFIG.demoPaths.fallback;
    } catch {
      return CONFIG.demoPaths.fallback;
    }
  },

  setLoading: (isLoading) => {
    STATE.isLoading = isLoading;
    DOM.refreshBtn.style.opacity = isLoading ? '0.5' : '1';
  },

  fetchDemoData: async () => {
    STATE.isUsingDemoData = true;
    const basePath = await Data.determineDemoPath();
    console.log(DEMO_MESSAGES.usingPath(basePath));
    
    const data = await Data.fetchPortfolioData({
      portfolio: `${basePath}/portfolio.json`,
      eval: `${basePath}/eval.json`
    });
    const { dashData, evalData } = data;

    if ((!dashData.rows || dashData.rows.length === 0) && (!evalData || evalData.length === 0)) {
       throw new Error(ERROR_MESSAGES.dataEmpty(basePath));
    }

    return { dashData, evalData };
  },

  fetchLiveData: async () => {
    STATE.isUsingDemoData = false;
    return Data.fetchPortfolioData(CONFIG.endpoints);
  },

  load: async () => {
    if (STATE.isLoading) return;
    Data.setLoading(true);

    try {
      const data = CONFIG.isDemoMode ? await Data.fetchDemoData() : await Data.fetchLiveData();
      const { dashData, evalData } = data;

      STATE.data = Utils.mergeData(dashData, evalData);
      Data.refreshUI(dashData.generated_at);

    } catch (err) {
      console.warn("API Failure or No Data:", err);
      STATE.data = [];
      Data.refreshUI();
    } finally {
      Data.setLoading(false);
    }
  },

  refreshUI: (customTime) => {
    const totalVal = Utils.calculateAndAssignWeights(STATE.data);
    UI.updateStats(totalVal);
    UI.updateTickerTape();
    UI.renderTable();
    UI.updateTimestamp(customTime);
  },

  handleRemove: async (ticker) => {
    if (!confirm(CONFIRMATION_MESSAGES.removePosition(ticker))) return;
    
    if (STATE.isUsingDemoData) {
      UI.showToast(DEMO_MESSAGES.changesNotSaved);
      return;
    }
    
    try {
      const res = await fetch(`${CONFIG.endpoints.position}/${ticker}`, { method: 'DELETE' });
      if (res.ok) {
        Data.load();
      }
    } catch (err) {
      console.warn('Remove position failed:', err);
      UI.showToast(ERROR_MESSAGES.removeFailed);
    }
  },

  handleAdd: async (e) => {
    e.preventDefault();
    
    if (STATE.isUsingDemoData) {
      UI.showToast(DEMO_MESSAGES.changesNotSaved);
      DOM.quickAdd.form.reset();
      return;
    }
    
    const ticker = DOM.quickAdd.ticker.value.toUpperCase();
    const quantity = parseFloat(DOM.quickAdd.qty.value);
    const existing = STATE.data.find(d => d.ticker.toUpperCase() === ticker);
    
    const payload = {
      ticker,
      name: existing?.name || ticker,
      quantity,
      bucket: existing?.bucket || CONFIG.defaultBucket,
      delta: 1.0,
      current_price: 0.0
    };

    try {
      const res = await fetch(CONFIG.endpoints.position, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      
      if (res.ok) {
        DOM.quickAdd.form.reset();
        Data.load();
      }
    } catch (err) {
      console.warn('Add position failed:', err);
      UI.showToast(ERROR_MESSAGES.addFailed);
    }
  }
};

// --- Initialization ---
function initNavigation() {
  DOM.navItems.forEach(btn => 
    btn.addEventListener('click', () => UI.switchView(btn.dataset.view))
  );
  DOM.tabs.forEach(btn => 
    btn.addEventListener('click', () => UI.switchTab(btn.dataset.tab))
  );
  DOM.sidebar.toggle.addEventListener('click', () => 
    DOM.sidebar.el.classList.toggle(CSS_CLASSES.collapsed)
  );
}

function initTable() {
  DOM.table.head.addEventListener('click', (e) => {
    if (!e.target.dataset.sort) return;
    
    const key = e.target.dataset.sort;
    const isSameColumn = STATE.sortCol === key;
    STATE.sortDir = (isSameColumn && STATE.sortDir === SORT_DIRECTIONS.asc) 
      ? SORT_DIRECTIONS.desc 
      : SORT_DIRECTIONS.asc;
    STATE.sortCol = key;
    UI.renderTable();
  });
  
  DOM.table.body.addEventListener('click', (e) => {
    if (e.target.classList.contains(CSS_CLASSES.btnRemove)) {
      Data.handleRemove(e.target.dataset.ticker);
    }
  });
}

function initForm() {
  DOM.quickAdd.form.addEventListener('submit', Data.handleAdd);
  DOM.refreshBtn.addEventListener('click', Data.load);
}

function createHeatmapWidget(dataSource) {
  DOM.heatmap.container.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
  const script = document.createElement('script');
  script.type = 'text/javascript';
  script.src = 'https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js';
  script.async = true;
  script.innerHTML = JSON.stringify({ ...CONFIG.heatmapWidget, dataSource });
  DOM.heatmap.container.appendChild(script);
}

function initHeatmap() {
  DOM.heatmap.tabs.forEach(tab => tab.addEventListener('click', () => {
    const source = tab.dataset.source;
    DOM.heatmap.tabs.forEach(t => t.classList.toggle(CSS_CLASSES.active, t.dataset.source === source));
    createHeatmapWidget(source);
  }));
}

function init() {
  initNavigation();
  initTable();
  initForm();
  initHeatmap();
  Data.load();
}

init();
