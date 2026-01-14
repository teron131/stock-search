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
    stats: document.querySelector('.stats-grid'),
    tabs: document.querySelector('.tabs-container'),
    heatmap: document.getElementById('heatmap-section')
  },
  tabs: document.querySelectorAll('.tab-btn'),
  table: {
    head: document.querySelector('#main-table thead'),
    body: document.querySelector('#main-table tbody')
  },
  stats: {
    positions: document.getElementById('total-positions'),
    value: document.getElementById('total-notional'),
    change: document.getElementById('portfolio-change'),
    topTicker: document.getElementById('top-gainer-ticker'),
    topValue: document.getElementById('top-gainer-value')
  },
  quickAdd: {
    form: document.getElementById('quick-add-form'),
    ticker: document.getElementById('input-ticker'),
    qty: document.getElementById('input-qty')
  },
  refreshBtn: document.getElementById('refresh-btn'),
  sidebar: {
    el: document.getElementById('sidebar'),
    toggle: document.getElementById('sidebar-toggle')
  }
};

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
}

function toggleSidebar() {
  el.sidebar.el.classList.toggle('collapsed');
}

// --- View Logic ---
function switchView(viewName) {
  STATE.currentView = viewName;
  
  // Update Nav
  el.navItems.forEach(n => n.classList.toggle('active', n.dataset.view === viewName));
  
  // Toggle Visibility
  if (viewName === 'dashboard') {
    el.views.stats.style.display = 'grid';
    el.views.tabs.style.display = 'flex';
    el.views.heatmap.style.display = 'none';
  } else {
    el.views.stats.style.display = 'none';
    el.views.tabs.style.display = 'none';
    el.views.heatmap.style.display = 'block';
  }
}

function switchTab(tabName) {
  STATE.currentTab = tabName;
  STATE.sortCol = tabName === 'holdings' ? 'weight_pct' : 'overall';
  STATE.sortDir = 'desc';
  
  el.tabs.forEach(t => t.classList.toggle('active', t.dataset.tab === tabName));
  renderTable();
}

// --- Data Logic ---
async function loadData() {
  if (STATE.isLoading) return;
  STATE.isLoading = true;
  el.refreshBtn.style.opacity = '0.5';

  try {
    const [dashRes, evalRes] = await Promise.all([
      fetch('/api/dashboard'),
      fetch('/api/eval')
    ]);

    if (!dashRes.ok || !evalRes.ok) throw new Error('System Error: API Failure');

    const dashData = await dashRes.json();
    const evalData = await evalRes.json();

    // Full Join Logic
    const portfolioMap = new Map((dashData.rows || []).map(r => [r.ticker.replace("-", ".").toUpperCase(), r]));
    const evalMap = new Map(evalData.map(e => [e.ticker.replace("-", ".").toUpperCase(), e]));
    
    // Get all unique tickers from both sources
    const allTickers = new Set([...portfolioMap.keys(), ...evalMap.keys()]);

    STATE.data = Array.from(allTickers).map(ticker => {
      const p = portfolioMap.get(ticker) || {};
      const e = evalMap.get(ticker) || {};
      
      return {
        ticker: ticker,
        name: p.name || e.name || ticker,
        ...p, // Spread portfolio data first
        ...e, // Spread eval data second (might overwrite some overlapping keys if any)
        // Explicitly ensure ticker is set correctly
        ticker: ticker
      };
    });

    updateStats();
    renderTable();

  } catch (err) {
    console.error(err);
    alert('SYSTEM ERROR: Could not fetch data.');
  } finally {
    STATE.isLoading = false;
    el.refreshBtn.style.opacity = '1';
  }
}

function updateStats() {
  // Total Positions
  el.stats.positions.textContent = STATE.data.length;

  // Total Value
  const totalVal = STATE.data.reduce((acc, r) => acc + (r.notional || 0), 0);
  el.stats.value.textContent = fmt.currency(totalVal);
  
  // Day Change (Approximate based on weights if not provided directly)
  // Assuming 'change_percent' is available for each
  // This is a rough weighted average for the portfolio change
  let weightedChange = 0;
  if (totalVal > 0) {
    weightedChange = STATE.data.reduce((acc, r) => {
      return acc + ((r.change_percent || 0) * (r.notional || 0));
    }, 0) / totalVal;
  }
  
  el.stats.change.textContent = fmt.percent(weightedChange);
  el.stats.change.className = `stat-trend ${weightedChange >= 0 ? 'positive' : 'negative'}`;

  // Top Gainer
  const sortedByChange = [...STATE.data].sort((a, b) => (b.change_percent || 0) - (a.change_percent || 0));
  const winner = sortedByChange[0];
  if (winner) {
    el.stats.topTicker.textContent = winner.ticker;
    el.stats.topValue.textContent = fmt.percent(winner.change_percent || 0);
    el.stats.topValue.className = `stat-trend ${winner.change_percent >= 0 ? 'positive' : 'negative'}`;
  } else {
    el.stats.topTicker.textContent = '--';
    el.stats.topValue.textContent = '--';
  }
}

// --- Table Rendering ---
function renderTable() {
  const cols = COLS[STATE.currentTab];
  
  // Sort
  const sorted = [...STATE.data].sort((a, b) => {
    let valA = a[STATE.sortCol];
    let valB = b[STATE.sortCol];
    
    // Handle nulls
    if (valA == null) return 1;
    if (valB == null) return -1;
    
    if (typeof valA === 'string') {
      valA = valA.toLowerCase();
      valB = valB.toLowerCase();
    }
    
    if (valA < valB) return STATE.sortDir === 'asc' ? -1 : 1;
    if (valA > valB) return STATE.sortDir === 'asc' ? 1 : -1;
    return 0;
  });

  // Render Head
  let theadHTML = '<tr>';
  cols.forEach(col => {
    if (col.key === 'remove') {
      theadHTML += '<th></th>';
    } else {
      let classList = [];
      if (STATE.sortCol === col.key) {
        classList.push('sorted');
        classList.push(STATE.sortDir); // 'asc' or 'desc'
      }
      theadHTML += `<th onclick="handleSort('${col.key}')" class="${classList.join(' ')}">${col.label}</th>`;
    }
  });
  theadHTML += '</tr>';
  el.table.head.innerHTML = theadHTML;

  // Render Body
  const fragment = document.createDocumentFragment();
  sorted.forEach((row, i) => {
    const tr = document.createElement('tr');
    tr.style.animationDelay = `${i * 30}ms`;
    tr.classList.add('animate-in');
    
    cols.forEach(col => {
      const td = document.createElement('td');
      const val = row[col.key];

      if (col.key === 'remove') {
        td.innerHTML = `<button class="btn-remove-cell" onclick="handleRemove('${row.ticker}')">&times;</button>`;
      } else if (col.key === 'ticker') {
        td.textContent = val;
      } else {
        // Formatting
        let content = fmt.default(val);
        if (col.format && fmt[col.format]) {
          content = fmt[col.format](val);
        }

        // Styling Badges
        if (col.format === 'percent' && val != null) {
          td.innerHTML = `<span class="badge ${val >= 0 ? 'positive' : 'negative'}">${content}</span>`;
        } else if (col.format === 'score' && val != null) {
          let scoreClass = 'score-mid';
          if (val >= 8) scoreClass = 'score-high';
          if (val <= 4) scoreClass = 'score-low';
          td.innerHTML = `<span class="${scoreClass}">${content}</span>`;
        } else {
          td.textContent = content;
        }
      }
      tr.appendChild(td);
    });
    fragment.appendChild(tr);
  });
  el.table.body.innerHTML = '';
  el.table.body.appendChild(fragment);
}

// --- Interaction Handlers ---
window.handleSort = (key) => {
  if (STATE.sortCol === key) {
    STATE.sortDir = STATE.sortDir === 'asc' ? 'desc' : 'asc';
  } else {
    STATE.sortCol = key;
    STATE.sortDir = 'desc';
  }
  renderTable();
};

window.handleRemove = async (ticker) => {
  if (!confirm(`CONFIRM: Eliminate ${ticker} from portfolio?`)) return;
  try {
    const res = await fetch(`/api/portfolio/position/${ticker}`, { method: 'DELETE' });
    if (res.ok) await loadData();
  } catch (err) {
    console.error(err);
    alert('Failed to remove asset.');
  }
};

async function handleAddTicker(e) {
  e.preventDefault();
  const ticker = el.quickAdd.ticker.value.toUpperCase();
  const quantity = parseFloat(el.quickAdd.qty.value);

  const existing = STATE.data.find(d => d.ticker.toUpperCase() === ticker);
  const bucket = existing ? existing.bucket : "Tactical Opportunities";
  const name = existing ? existing.name : ticker;

  const payload = { 
    ticker, 
    name, 
    quantity, 
    bucket, 
    delta: 1.0, 
    current_price: 0.0 
  };

  try {
    const res = await fetch('/api/portfolio/position', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
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
