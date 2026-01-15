/**
 * TERMINAL // Stock News
 * Core Application Logic
 */

// --- Configuration ---
const CONFIG = {
  isDemoMode: window.location.hostname.includes('github.io') || new URLSearchParams(window.location.search).get('demo') === 'true',
  animationDelayMs: 30,
  defaultBucket: 'Tactical Opportunities',
  endpoints: {
    dashboard: '/api/dashboard',
    eval: '/api/eval',
    portfolio: '/api/portfolio/position',
  }
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

// --- Application State ---
const STATE = {
  currentView: 'dashboard',
  currentTab: 'holdings',
  sortCol: 'weight_pct',
  sortDir: 'desc',
  data: [],
  isLoading: false,
  isUsingDemoData: false
};

// --- DOM References ---
const el = {
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
  normalizeTicker: (t) => t.replace('-', '.').toUpperCase(),
  
  format: {
    currency: (v) => new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' }).format(v),
    percent: (v) => `${v > 0 ? '+' : ''}${Number(v).toFixed(2)}%`,
    number: (v) => new Intl.NumberFormat('en-US', { maximumFractionDigits: 2 }).format(v),
    score: (v) => Number(v).toFixed(1),
    prob: (v) => `${(v * 100).toFixed(0)}%`,
    default: (v) => String(v || '--')
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

  calculateWeights: (data) => {
    const totalVal = data.reduce((acc, r) => acc + (r.notional || 0), 0);
    data.forEach(row => {
      if (totalVal > 0) row.weight_pct = (row.notional / totalVal) * 100;
    });
    return totalVal;
  }
};

// --- UI Logic ---
const UI = {
  switchView: (viewName) => {
    STATE.currentView = viewName;
    el.navItems.forEach(n => n.classList.toggle('active', n.dataset.view === viewName));
    
    if (el.viewTitle) {
      const titles = { dashboard: 'DASHBOARD', heatmap: 'MARKET MAP', calendar: 'ECONOMIC CALENDAR' };
      el.viewTitle.textContent = titles[viewName] || 'TERMINAL';
    }
    
    const isDash = viewName === 'dashboard';
    el.views.stats.style.display = isDash ? 'flex' : 'none';
    el.views.tabs.style.display = isDash ? 'flex' : 'none';
    el.views.heatmap.style.display = viewName === 'heatmap' ? 'block' : 'none';
    el.views.calendar.style.display = viewName === 'calendar' ? 'block' : 'none';
    
    // Ensure ticker tape theme is always dark
    if (el.tickerTape) {
      el.tickerTape.setAttribute('theme', 'dark');
    }
  },

  switchTab: (tabName) => {
    STATE.currentTab = tabName;
    STATE.sortCol = tabName === 'holdings' ? 'weight_pct' : 'overall';
    STATE.sortDir = 'desc';
    el.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
    UI.renderTable();
  },

  updateStats: () => {
    el.stats.positions.textContent = STATE.data.length || '--';
    const totalVal = Utils.calculateWeights(STATE.data);
    el.stats.value.textContent = totalVal > 0 ? Utils.format.currency(totalVal) : '--';

    const change = Utils.calculateWeightedChange(STATE.data, totalVal);
    el.stats.change.textContent = totalVal > 0 ? Utils.format.percent(change) : '--';
    
    let trendClass = 'neutral';
    if (totalVal > 0) {
      if (change > 0) trendClass = 'positive';
      else if (change < 0) trendClass = 'negative';
    }
    el.stats.change.className = `stat-trend ${trendClass}`;
  },

  updateTimestamp: (customTime) => {
    if (!el.lastUpdate) return;
    const time = customTime ? new Date(customTime) : new Date();
    const dateStr = time.toLocaleDateString('en-US', { month: 'short', day: '2-digit' });
    const timeStr = time.toLocaleTimeString('en-US', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const modeText = STATE.isUsingDemoData ? " [DEMO]" : "";
    el.lastUpdate.textContent = `LAST UPDATED: ${dateStr} ${timeStr}${modeText}`;
  },

  updateTickerTape: () => {
    if (!el.tickerTape) return;
    if (!STATE.data.length) {
      el.tickerTape.setAttribute('symbols', '');
      el.tickerTapeContainer.style.display = 'none';
      return;
    }

    el.tickerTapeContainer.style.display = 'block';
    const tickers = [...STATE.data]
      .sort((a, b) => (b.weight_pct || 0) - (a.weight_pct || 0))
      .map(item => Utils.normalizeTicker(item.ticker))
      .filter((t, i, self) => t && t.length < 10 && self.indexOf(t) === i)
      .slice(0, 20);

    el.tickerTape.setAttribute('symbols', tickers.join(','));
  },

  renderTable: () => {
    const cols = COLS[STATE.currentTab];
    const sorted = [...STATE.data].sort((a, b) => {
      let valA = a[STATE.sortCol], valB = b[STATE.sortCol];
      if (valA == null) return 1;
      if (valB == null) return -1;
      if (typeof valA === 'string') { valA = valA.toLowerCase(); valB = valB.toLowerCase(); }
      return valA < valB ? (STATE.sortDir === 'asc' ? -1 : 1) : (STATE.sortDir === 'asc' ? 1 : -1);
    });

    // Render Head
    let headHtml = '<tr>';
    cols.forEach(col => {
      if (col.key === 'remove') headHtml += '<th></th>';
      else {
        const sortedClass = STATE.sortCol === col.key ? `sorted ${STATE.sortDir}` : '';
        headHtml += `<th data-sort="${col.key}" class="${sortedClass}">${col.label}</th>`;
      }
    });
    el.table.head.innerHTML = headHtml + '</tr>';

    // Render Body
    el.table.body.innerHTML = '';
    if (sorted.length === 0) {
      el.table.body.innerHTML = `<tr><td colspan="${cols.length}" style="text-align: center; color: var(--muted); height: 200px; font-family: var(--font-mono);">NO ACTIVE POSITIONS FOUND</td></tr>`;
      return;
    }

    const fragment = document.createDocumentFragment();
    sorted.forEach((row, i) => {
      const tr = document.createElement('tr');
      tr.style.animationDelay = `${i * CONFIG.animationDelayMs}ms`;
      tr.classList.add('animate-in');
      
      cols.forEach(col => {
        const td = document.createElement('td');
        const val = row[col.key];
        
        if (col.key === 'remove') {
          td.innerHTML = `<button class="btn-remove-cell" data-ticker="${row.ticker}">&times;</button>`;
        } else if (col.key === 'ticker') {
          td.innerHTML = `<tv-ticker-tag symbol="${val}" theme="light" preserve-text hide-change hide-background transparent>${val}</tv-ticker-tag>`;
        } else {
          const content = col.format && Utils.format[col.format] ? Utils.format[col.format](val) : Utils.format.default(val);
          if (col.format === 'percent' && val != null) {
            td.innerHTML = `<span class="badge ${val >= 0 ? 'positive' : 'negative'}">${content}</span>`;
          } else if (col.format === 'score' && val != null) {
            const cls = val >= 8 ? 'score-high' : (val <= 4 ? 'score-low' : 'score-mid');
            td.innerHTML = `<span class="${cls}">${content}</span>`;
          } else {
            td.textContent = content;
          }
        }
        tr.appendChild(td);
      });
      fragment.appendChild(tr);
    });
    el.table.body.appendChild(fragment);
  },

  showToast: (message) => {
    const toast = document.createElement('div');
    toast.style.cssText = `position: fixed; bottom: 20px; right: 20px; background: #333; color: #fff; padding: 12px 24px; border-radius: 4px; border-left: 4px solid #00f2fe; z-index: 10000; font-family: var(--font-mono); font-size: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); animation: fadeIn 0.3s ease-out;`;
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { toast.style.opacity = '0'; toast.style.transition = 'opacity 0.5s'; setTimeout(() => toast.remove(), 500); }, 3000);
  }
};

// --- Data Logic ---
const Data = {
  load: async () => {
    if (STATE.isLoading) return;
    if (CONFIG.isDemoMode) return Data.loadDemo();

    STATE.isLoading = true;
    el.refreshBtn.style.opacity = '0.5';

    try {
      const [dashRes, evalRes] = await Promise.all([fetch(CONFIG.endpoints.dashboard), fetch(CONFIG.endpoints.eval)]);
      if (!dashRes.ok || !evalRes.ok) throw new Error('API Failure');

      const dashData = await dashRes.json();
      const evalData = await evalRes.json();
      STATE.data = Utils.mergeData(dashData, evalData);
      STATE.isUsingDemoData = false;
      Data.refreshUI();
    } catch (err) {
      console.warn("API Failure or No Data:", err);
      STATE.data = [];
      Data.refreshUI();
    } finally {
      STATE.isLoading = false;
      el.refreshBtn.style.opacity = '1';
    }
  },

  loadDemo: async () => {
    STATE.isUsingDemoData = true;
    
    const tryLoad = async (basePath) => {
      const [dashRes, evalRes] = await Promise.all([
        fetch(`${basePath}/dashboard.json`),
        fetch(`${basePath}/eval.json`)
      ]);
      if (!dashRes.ok || !evalRes.ok) throw new Error(`Data missing in ${basePath}`);
      return { dashData: await dashRes.json(), evalData: await evalRes.json() };
    };

    try {
      // 1. Try 'data/' first
      const { dashData, evalData } = await tryLoad('data');
      STATE.data = Utils.mergeData(dashData, evalData);
      Data.refreshUI(dashData.generated_at);
      console.log("Demo Mode: Data loaded from data/");
    } catch (err) {
      console.warn("data/ not found, falling back to sample_data/", err);
      try {
        // 2. Fallback to 'sample_data/'
        const { dashData, evalData } = await tryLoad('sample_data');
        STATE.data = Utils.mergeData(dashData, evalData);
        Data.refreshUI(dashData.generated_at);
        console.log("Demo Mode: Sample data loaded from sample_data/");
      } catch (fallbackErr) {
        console.error("All data sources failed.", fallbackErr);
        STATE.data = [];
        Data.refreshUI();
      }
    }
  },

  refreshUI: (customTime) => {
    Utils.calculateWeights(STATE.data);
    UI.updateStats();
    UI.updateTickerTape();
    UI.renderTable();
    UI.updateTimestamp(customTime);
  },

  handleRemove: async (ticker) => {
    if (!confirm(`CONFIRM: Eliminate ${ticker} from portfolio?`)) return;
    if (STATE.isUsingDemoData) return UI.showToast("Demo Mode: Changes not saved.");
    try {
      const res = await fetch(`${CONFIG.endpoints.portfolio}/${ticker}`, { method: 'DELETE' });
      if (res.ok) Data.load();
    } catch (err) { alert('Failed to remove asset.'); }
  },

  handleAdd: async (e) => {
    e.preventDefault();
    if (STATE.isUsingDemoData) { UI.showToast("Demo Mode: Changes not saved."); el.quickAdd.form.reset(); return; }
    
    const ticker = el.quickAdd.ticker.value.toUpperCase();
    const quantity = parseFloat(el.quickAdd.qty.value);
    const existing = STATE.data.find(d => d.ticker.toUpperCase() === ticker);
    
    const payload = { ticker, name: existing?.name || ticker, quantity, bucket: existing?.bucket || CONFIG.defaultBucket, delta: 1.0, current_price: 0.0 };

    try {
      const res = await fetch(CONFIG.endpoints.portfolio, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
      if (res.ok) { el.quickAdd.form.reset(); Data.load(); }
    } catch (err) { alert('Failed to add asset.'); }
  }
};

// --- Initialization ---
function init() {
  // Event Listeners
  el.navItems.forEach(btn => btn.addEventListener('click', () => UI.switchView(btn.dataset.view)));
  el.tabs.forEach(btn => btn.addEventListener('click', () => UI.switchTab(btn.dataset.tab)));
  el.quickAdd.form.addEventListener('submit', Data.handleAdd);
  el.refreshBtn.addEventListener('click', Data.load);
  el.sidebar.toggle.addEventListener('click', () => el.sidebar.el.classList.toggle('collapsed'));
  el.table.head.addEventListener('click', (e) => {
    if (e.target.dataset.sort) {
      const key = e.target.dataset.sort;
      STATE.sortDir = (STATE.sortCol === key && STATE.sortDir === 'asc') ? 'desc' : 'asc';
      STATE.sortCol = key;
      UI.renderTable();
    }
  });
  el.table.body.addEventListener('click', (e) => {
    if (e.target.classList.contains('btn-remove-cell')) Data.handleRemove(e.target.dataset.ticker);
  });

  // Heatmap Source
  el.heatmap.tabs.forEach(tab => tab.addEventListener('click', () => {
    const source = tab.dataset.source;
    el.heatmap.tabs.forEach(t => t.classList.toggle('active', t.dataset.source === source));
    el.heatmap.container.innerHTML = '<div class="tradingview-widget-container__widget"></div>';
    const s = document.createElement('script');
    s.type = 'text/javascript'; s.src = 'https://s3.tradingview.com/external-embedding/embed-widget-stock-heatmap.js'; s.async = true;
    s.innerHTML = JSON.stringify({ "dataSource": source, "blockSize": "Value.Traded|1W", "blockColor": "change", "grouping": "sector", "locale": "en", "symbolUrl": "", "colorTheme": "dark", "exchanges": ["NYSE", "NASDAQ"], "hasTopBar": true, "isDataSetEnabled": false, "isZoomEnabled": true, "hasSymbolTooltip": true, "isMonoSize": false, "width": "100%", "height": "100%" });
    el.heatmap.container.appendChild(s);
  }));

  Data.load();
}

init();
