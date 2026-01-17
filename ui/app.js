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
  colorBandFraction: 0.5,
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
    { key: "change_percent", label: "CHANGE%", format: "percent" },
    { key: "market_cap", label: "MKT_CAP" },
    { key: "pe", label: "PE", format: "number" },
    { key: "pe_forward", label: "FWD_PE", format: "number" },
    { key: "peg", label: "PEG", format: "number" },
    { key: "gross_margin", label: "MARGIN", format: "percent_neutral" },
    { key: "median_upside", label: "UPSIDE%", format: "percent" },
    { key: "rsi", label: "RSI", format: "number" },
    { key: "twenty_day_change_percent", label: "20D%", format: "percent" },
    { key: "fifty_day_change_percent", label: "50D%", format: "percent" },
    { key: "one_hundred_day_change_percent", label: "100D%", format: "percent" },
    { key: "two_hundred_day_change_percent", label: "200D%", format: "percent" },
    { key: "earning_direction", label: "EARN_DIR" },
    { key: "notional", label: "VALUE", format: "currency" },
    { key: "weight_pct", label: "WEIGHT", format: "percent_neutral" },
    { key: "bucket", label: "STRATEGY" },
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
    { key: "bucket", label: "STRATEGY" },
    { key: "remove", label: "", format: "action" }
  ]
};

const DEFAULT_SORT_COLS = {
  holdings: 'weight_pct',
  evaluations: 'overall'
};

// --- Application State ---
const STATE = {
  currentView: 'dashboard',
  currentTab: 'holdings',
  sortCol: DEFAULT_SORT_COLS.holdings,
  sortDir: 'desc',
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
  menuToggle: document.getElementById('menu-toggle'),
    sidebar: {
      el: document.getElementById('sidebar'),
      toggle: document.getElementById('sidebar-toggle')
    },
    loadingOverlay: document.getElementById('loading-overlay'),
    lastUpdate: document.getElementById('last-update'),
    heatmap: {
      tabs: document.querySelectorAll('#heatmap-section .tab-btn'),
      container: document.getElementById('heatmap-widget-container')
    }
  };

// --- Utilities ---
const Utils = {
  normalizeTicker: (ticker) => ticker.replace('-', '.').toUpperCase(),

  parseMarketCap: (value) => {
    if (value == null) return null;
    const raw = String(value).trim().toUpperCase();
    const match = raw.match(/^(-?\d+(?:\.\d+)?)([TBMK])?$/);
    if (!match) return null;

    const numeric = Number(match[1]);
    if (Number.isNaN(numeric)) return null;

    const suffix = match[2];
    const multiplier = suffix === 'T' ? 1e12 : suffix === 'B' ? 1e9 : suffix === 'M' ? 1e6 : suffix === 'K' ? 1e3 : 1;
    return numeric * multiplier;
  },
  
  format: {
    currency: (value) => {
      if (value == null) return '--';
      const numeric = Number(value);
      if (Number.isNaN(numeric)) return '--';
      return new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(numeric);
    },
    percent: (value) => {
      if (value == null) return '--';
      const numeric = Number(value);
      if (Number.isNaN(numeric)) return '--';
      const sign = numeric > 0 ? '+' : '';
      return `${sign}${numeric.toFixed(2)}%`;
    },
    percent_neutral: (value) => {
      if (value == null) return '--';
      const numeric = Number(value);
      if (Number.isNaN(numeric)) return '--';
      return `${numeric.toFixed(2)}%`;
    },
    number: (value) => {
      if (value == null) return '--';
      const numeric = Number(value);
      if (Number.isNaN(numeric)) return '--';
      return new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(numeric);
    },
    score: (value) => {
      if (value == null) return '--';
      const numeric = Number(value);
      if (Number.isNaN(numeric)) return '--';
      return numeric.toFixed(1);
    },
    prob: (value) => {
      if (value == null) return '--';
      const numeric = Number(value);
      if (Number.isNaN(numeric)) return '--';
      return `${(numeric * 100).toFixed(0)}%`;
    },
    default: (value) => (value == null || value === '' ? '--' : String(value))
  },

  /**
   * Calculate median of an array of numbers
   */
  median: (values) => {
    if (!values.length) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 
      ? (sorted[mid - 1] + sorted[mid]) / 2 
      : sorted[mid];
  },

  /**
   * Determine score color based on dynamic thresholds (top/bottom 20% of range).
   * @returns {string} CSS variable string or null (for neutral)
   */
  getScoreColor: (value, meta) => {
    if (value == null || !meta) return null;
    
    // Standard logic: Low Value = Red, High Value = Green
    let color = null;
    
    // Check Low Threshold (Bottom 20%)
    if (value <= meta.lowThreshold) {
      color = meta.invert ? 'var(--positive)' : 'var(--negative)';
    } 
    // Check High Threshold (Top 20%)
    else if (value >= meta.highThreshold) {
      color = meta.invert ? 'var(--negative)' : 'var(--positive)';
    }

    return color;
  },


  calculateWeightedChange: (data, totalVal) => {
    if (totalVal <= 0) return { percent: 0, absolute: 0 };
    const absolute = data.reduce((acc, r) => acc + ((r.change_percent || 0) / 100 * (r.notional || 0) / (1 + (r.change_percent || 0) / 100)), 0);
    const percent = (absolute / (totalVal - absolute)) * 100;
    return { percent, absolute };
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
        name: p.name || e.name || safeTicker
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
        if (row.notional == null || Number.isNaN(Number(row.notional))) {
          row.weight_pct = null;
          return;
        }
        row.weight_pct = (Number(row.notional) / totalVal) * 100;
      });
    }
    return totalVal;
  }
};

const CellRenderers = {
  remove: (row) => `<button class="${CSS_CLASSES.btnRemove}" data-ticker="${row.ticker}">&times;</button>`,
  ticker: (row, val) => `<tv-ticker-tag symbol="${val}" preserve-text hide-change hide-background theme="dark" transparent>${val}</tv-ticker-tag>`,
  percent: (row, val, formatter) => {
    if (val == null || Number.isNaN(Number(val))) {
      return `<span class="${CSS_CLASSES.badge}">${formatter(val)}</span>`;
    }
    const badgeClass = Number(val) >= 0 ? CSS_CLASSES.positive : CSS_CLASSES.negative;
    return `<span class="${CSS_CLASSES.badge} ${badgeClass}">${formatter(val)}</span>`;
  },
  percent_neutral: (row, val, formatter) => {
    return `<span class="cell-weight">${formatter(val)}</span>`;
  },
  pnl_abs: (row, val, formatter) => {
    const badgeClass = val >= 0 ? CSS_CLASSES.positive : CSS_CLASSES.negative;
    const sign = val >= 0 ? '+' : '-';
    return `<span class="${CSS_CLASSES.badge} ${badgeClass}">${sign}${Utils.format.currency(Math.abs(val))}</span>`;
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
    const isDashboard = viewName === 'dashboard';
    DOM.views.stats.style.display = isDashboard ? 'flex' : 'none';
    DOM.views.tabs.style.display = isDashboard ? 'flex' : 'none';
    DOM.views.heatmap.style.display = viewName === 'heatmap' ? 'block' : 'none';
    DOM.views.calendar.style.display = viewName === 'calendar' ? 'block' : 'none';
  },

  switchView: (viewName) => {
    STATE.currentView = viewName;
    DOM.navItems.forEach(n => n.classList.toggle(CSS_CLASSES.active, n.dataset.view === viewName));
    
    if (DOM.viewTitle) {
      DOM.viewTitle.textContent = ({
        dashboard: 'DASHBOARD',
        heatmap: 'MARKET MAP',
        calendar: 'ECONOMIC CALENDAR'
      })[viewName] || 'TERMINAL';
    }
    
    UI.updateViewVisibility(viewName);
    
    if (DOM.tickerTape) {
      DOM.tickerTape.setAttribute('theme', 'dark');
    }
  },

  switchTab: (tabName) => {
    STATE.currentTab = tabName;
    STATE.sortCol = DEFAULT_SORT_COLS[tabName] || DEFAULT_SORT_COLS.holdings;
    STATE.sortDir = 'desc';
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

    const { percent, absolute } = Utils.calculateWeightedChange(STATE.data, computedTotal);
    
    if (computedTotal > 0) {
      const sign = absolute >= 0 ? '+' : '';
      const absFormatted = sign + Utils.format.currency(Math.abs(absolute));
      const pctFormatted = Utils.format.percent(percent);
      DOM.stats.change.textContent = `${absFormatted} (${pctFormatted})`;
    } else {
      DOM.stats.change.textContent = '--';
    }

    const trendClass = UI.getTrendClass(percent, computedTotal);
    DOM.stats.change.className = `stat-trend ${trendClass}`;
    
    if (DOM.stats.value) {
      DOM.stats.value.classList.remove(CSS_CLASSES.positive, CSS_CLASSES.negative);
    }
  },

  updateTimestamp: (customTime) => {
    if (!DOM.lastUpdate) return;
    const time = customTime ? new Date(customTime) : new Date();
    const dateStr = time.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    const timeStr = time.toLocaleTimeString('en-US', {
      hour12: false,
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    });
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
    DOM.tickerTape.setAttribute('symbols', [...STATE.data]
      .sort((a, b) => (b.weight_pct || 0) - (a.weight_pct || 0))
      .map(item => Utils.normalizeTicker(item.ticker))
      .filter((t, i, self) => t && t.length < CONFIG.maxTickerLength && self.indexOf(t) === i)
      .slice(0, CONFIG.maxTickerTapeCount)
      .join(','));
    
    // Ensure height is not constrained
    DOM.tickerTape.style.height = 'auto';
  },

  sortData: (data, col, dir) => {
    return [...data].sort((a, b) => {
      const valA = a[col];
      const valB = b[col];

      // Special-case: market cap is stored as a formatted string (e.g. "4.534T")
      // but should sort numerically.
      if (col === 'market_cap') {
        const capA = Utils.parseMarketCap(valA);
        const capB = Utils.parseMarketCap(valB);

        if (capA == null) return 1;
        if (capB == null) return -1;
        if (capA === capB) return 0;

        return dir === 'asc' ? (capA < capB ? -1 : 1) : (capA < capB ? 1 : -1);
      }
      
      if (valA == null) return 1;
      if (valB == null) return -1;
      
      const normalizedA = typeof valA === 'string' ? valA.toLowerCase() : valA;
      const normalizedB = typeof valB === 'string' ? valB.toLowerCase() : valB;
      
      if (normalizedA === normalizedB) return 0;
      
      return dir === 'asc'
        ? (normalizedA < normalizedB ? -1 : 1)
        : (normalizedA < normalizedB ? 1 : -1);
    });
  },

  getFilteredRows: () => {
    const hasHolding = (row) => row.quantity != null && row.notional != null;
    const hasEvaluation = (row) => row.overall != null || row.rank != null;
    return STATE.data.filter(STATE.currentTab === 'holdings' ? hasHolding : hasEvaluation);
  },

  buildTableHead: (cols) => {
    DOM.table.head.innerHTML = `<tr>${cols.map(col => {
      if (col.key === 'remove') return '<th></th>';
      const sortedClass = STATE.sortCol === col.key ? `${CSS_CLASSES.sorted} ${STATE.sortDir}` : '';
      return `<th data-sort="${col.key}" class="${sortedClass}">${col.label}</th>`;
    }).join('')}</tr>`;
  },

  buildTableCell: (row, col, colorMetadata) => {
    const td = document.createElement('td');

    // Lookup order: specific column renderer (e.g., 'ticker', 'remove') → format renderer → default
    const renderer = CellRenderers[col.key] || CellRenderers[col.format] || CellRenderers.default;

    const content = renderer(row, row[col.key], Utils.format[col.format] || Utils.format.default);
    // Use innerHTML for custom renderers that return HTML (all except default text renderer)
    
    if (renderer !== CellRenderers.default) {
      td.innerHTML = content;
    } else {
      td.textContent = content;
    }

    // Apply gradual font coloring to numeric columns (scores, probs, ranks, etc)
    const isTargetFormat = ['score', 'prob', 'percent_neutral', 'number'].includes(col.format);
    const isTargetKey = ['rank', 'rsi'].includes(col.key);
    
    if ((isTargetFormat || isTargetKey) && colorMetadata && colorMetadata[col.key]) {
      const value = row[col.key];
      const textColor = Utils.getScoreColor(value, colorMetadata[col.key]);
      
      // Find the span with the score class (or create one/apply to cell if text only)
      // Note: Most number formatters wrap in spans now.
      const span = td.querySelector('span');
      if (span) {
        span.style.color = textColor || ''; // Apply color or reset
      } else if (textColor) {
        td.style.color = textColor; // Fallback for raw text cells
      } else {
         td.style.color = '';
      }
    }
    
    return td;
  },

  buildTableRow: (row, cols, rowIndex, colorMetadata) => {
    const tr = document.createElement('tr');
    tr.style.animationDelay = `${rowIndex * CONFIG.animationDelayMs}ms`;
    tr.classList.add(CSS_CLASSES.animateIn);

    cols.forEach(col => {
      tr.appendChild(UI.buildTableCell(row, col, colorMetadata));
    });

    return tr;
  },

  /**
   * Calculate color metadata for columns.
   * - Scores (0-10): Use fixed median 5.0
   * - Others (Rank, Weight, Prob): Use actual dataset median
   */
  calculateScoreColorMetadata: (data, cols) => {
    const metadata = {};
    const BACKEND_MEDIAN_SCORE = 5.0;
    
    // Columns to colorize
    const targetFormats = ['score', 'prob', 'percent_neutral', 'number'];
    const targetKeys = ['rank', 'rsi']; // Specific keys to include even if format differs

    cols.forEach(col => {
      if (targetFormats.includes(col.format) || targetKeys.includes(col.key)) {
        const values = data
          .map(row => row[col.key])
          .filter(v => v != null && !isNaN(v));
        
        if (values.length > 0) {
          const min = Math.min(...values);
          const max = Math.max(...values);
          
          // Use fixed 5.0 for standard scores, otherwise calculate actual median
          const median = col.format === 'score' 
            ? BACKEND_MEDIAN_SCORE 
            : Utils.median(values);
            
          // Invert colors for metrics where lower is better
          // (e.g., Rank, Bear probability, valuation ratios like PE/PEG)
          const invert = ['rank', 'bear', 'pe', 'pe_forward', 'peg'].includes(col.key);
          
          const colorBandFraction = CONFIG.colorBandFraction;

          metadata[col.key] = {
            median,
            min,
            max,
            invert,
            // Red zone: Bottom N% of the spread towards median
            lowThreshold: min + colorBandFraction * (median - min),
            // Green zone: Top N% of the spread from median
            highThreshold: max - colorBandFraction * (max - median)
          };
        }
      }
    });
    
    return metadata;
  },

  renderEmptyTable: (colSpan) => {
    DOM.table.body.innerHTML = `<tr><td colspan="${colSpan}" style="text-align: center; color: var(--muted); height: 200px; font-family: var(--font-mono);">${STATE.currentTab === 'holdings' ? 'NO ACTIVE POSITIONS FOUND' : STATE.currentTab === 'evaluations' ? 'NO EVALUATIONS FOUND' : 'NO DATA FOUND'}</td></tr>`;
  },

  renderTable: () => {
    const cols = COLS[STATE.currentTab];
    
    const sorted = UI.sortData(UI.getFilteredRows(), STATE.sortCol, STATE.sortDir);
    UI.buildTableHead(cols);

    // Render Body
    DOM.table.body.innerHTML = '';
    if (sorted.length === 0) {
      UI.renderEmptyTable(cols.length);
      return;
    }

    // Calculate color metadata for score columns
    const colorMetadata = UI.calculateScoreColorMetadata(sorted, cols);

    const fragment = document.createDocumentFragment();
    sorted.forEach((row, i) => {
      fragment.appendChild(UI.buildTableRow(row, cols, i, colorMetadata));
    });
    DOM.table.body.appendChild(fragment);
  },

  showToast: (message) => {
    const toast = document.createElement('div');
    toast.className = 'toast';
    toast.textContent = message;
    document.body.appendChild(toast);
    
    setTimeout(() => {
      toast.classList.add('toast-fade');
      setTimeout(() => toast.remove(), 500);
    }, 3000);
  }
};

// --- Data Logic ---
const Data = {
  fetchPortfolioData: async (endpoints) => {
    const [dashRes, evalRes] = await Promise.all([
      fetch(endpoints.portfolio),
      fetch(endpoints.eval)
    ]);
    
    if (!dashRes.ok || !evalRes.ok) throw new Error('API Failure');
    
    return {
      dashData: await dashRes.json(),
      evalData: await evalRes.json()
    };
  },

  determineDemoPath: async () => {
    try {
      const testRes = await fetch(`${CONFIG.demoPaths.primary}/portfolio.json`);
      if (!testRes.ok) return CONFIG.demoPaths.fallback;

      const payload = await testRes.json();
      const hasRows = payload && Array.isArray(payload.rows);
      const hasGeneratedAt = payload && typeof payload.generated_at === 'string' && payload.generated_at.length > 0;

      return hasRows && hasGeneratedAt ? CONFIG.demoPaths.primary : CONFIG.demoPaths.fallback;
    } catch {
      return CONFIG.demoPaths.fallback;
    }
  },

  setLoading: (isLoading) => {
    STATE.isLoading = isLoading;
    DOM.refreshBtn.style.opacity = isLoading ? '0.5' : '1';
    if (DOM.loadingOverlay) {
      DOM.loadingOverlay.style.display = isLoading ? 'flex' : 'none';
    }
  },

  fetchDemoData: async () => {
    STATE.isUsingDemoData = true;
    const basePath = await Data.determineDemoPath();
    console.log(`Demo Mode: Using ${basePath}/`);
    
    const { dashData, evalData } = await Data.fetchPortfolioData({
      portfolio: `${basePath}/portfolio.json`,
      eval: `${basePath}/eval.json`
    });

    if ((!dashData.rows || dashData.rows.length === 0) && (!evalData || evalData.length === 0)) {
       throw new Error(`Data empty in ${basePath}`);
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
      // Small artificial delay for "Sync" feel
      await new Promise(resolve => setTimeout(resolve, 800));

      const { dashData, evalData } = CONFIG.isDemoMode
        ? await Data.fetchDemoData()
        : await Data.fetchLiveData();

      STATE.data = Utils.mergeData(dashData, evalData);
      Data.refreshUI(dashData.generated_at);
      UI.showToast('TERMINAL SYNCHRONIZED');

    } catch (err) {
      console.warn("API Failure or No Data:", err);
      STATE.data = [];
      Data.refreshUI();
      UI.showToast('SYNCHRONIZATION FAILED');
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
    if (!confirm(`CONFIRM: Eliminate ${ticker} from portfolio?`)) return;
    
    if (STATE.isUsingDemoData) {
      UI.showToast('Demo Mode: Changes not saved.');
      return;
    }
    
    try {
      const res = await fetch(`${CONFIG.endpoints.position}/${ticker}`, { method: 'DELETE' });
      if (res.ok) {
        Data.load();
      }
    } catch (err) {
      console.warn('Remove position failed:', err);
      UI.showToast('Failed to remove asset.');
    }
  },

  handleAdd: async (e) => {
    e.preventDefault();
    
    if (STATE.isUsingDemoData) {
      UI.showToast('Demo Mode: Changes not saved.');
      DOM.quickAdd.form.reset();
      return;
    }
    
    const ticker = DOM.quickAdd.ticker.value.toUpperCase();
    const quantity = parseFloat(DOM.quickAdd.qty.value);
    const existing = STATE.data.find(d => d.ticker.toUpperCase() === ticker);
    
    try {
      const res = await fetch(CONFIG.endpoints.position, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ticker,
          name: existing?.name || ticker,
          quantity,
          bucket: existing?.bucket || CONFIG.defaultBucket,
          delta: 1.0,
          current_price: 0.0
        })
      });
      
      if (res.ok) {
        DOM.quickAdd.form.reset();
        Data.load();
      }
    } catch (err) {
      console.warn('Add position failed:', err);
      UI.showToast('Failed to add asset.');
    }
  }
};

// --- Initialization ---
function initNavigation() {
  DOM.navItems.forEach(btn => 
    btn.addEventListener('click', () => {
      UI.switchView(btn.dataset.view);
      // Auto-collapse sidebar on mobile after selection
      if (window.innerWidth <= 1024) {
        DOM.sidebar.el.classList.add(CSS_CLASSES.collapsed);
      }
    })
  );
  DOM.tabs.forEach(btn => 
    btn.addEventListener('click', () => UI.switchTab(btn.dataset.tab))
  );
  
  const toggleSidebar = () => {
    DOM.sidebar.el.classList.toggle(CSS_CLASSES.collapsed);
  };
  
  if (DOM.sidebar.toggle) DOM.sidebar.toggle.addEventListener('click', toggleSidebar);
  // On mobile, the logo icon in the top-bar acts as the menu toggle
  if (window.innerWidth <= 1024) {
    const topBarLeft = document.querySelector('.top-bar-left');
    if (topBarLeft) topBarLeft.addEventListener('click', toggleSidebar);
  }
}

function initTable() {
  DOM.table.head.addEventListener('click', (e) => {
    if (!e.target.dataset.sort) return;
    
    const key = e.target.dataset.sort;
    const isSameColumn = STATE.sortCol === key;
    STATE.sortDir = (isSameColumn && STATE.sortDir === 'asc') 
      ? 'desc' 
      : 'asc';
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
