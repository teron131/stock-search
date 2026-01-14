const commonCols = [
  { key: "ticker", label: "Ticker" },
];

const holdingsCols = [
  { key: "quantity", label: "Qty", format: "number" },
  { key: "current_price", label: "Price", format: "currency" },
  { key: "change_percent", label: "Change %", format: "percent" },
  { key: "bucket", label: "Bucket" },
  { key: "rsi", label: "RSI", format: "number" },
  { key: "twenty_day_change_percent", label: "20D %", format: "percent" },
  { key: "fifty_day_change_percent", label: "50D %", format: "percent" },
  { key: "two_hundred_day_change_percent", label: "200D %", format: "percent" },
  { key: "median_upside", label: "Upside", format: "percent" },
  { key: "notional", label: "Notional", format: "currency" },
  { key: "weight_pct", label: "Weight %", format: "percent" },
  { key: "remove", label: "", format: "remove" },
];

const evalCols = [
  { key: "rank", label: "Rank" },
  { key: "overall", label: "Overall", format: "score" },
  { key: "moat", label: "Moat", format: "score" },
  { key: "quality", label: "Quality", format: "score" },
  { key: "valuation", label: "Valuation", format: "score" },
  { key: "market_cap", label: "Size", format: "score" },
  { key: "upside", label: "Upside", format: "score" },
  { key: "bull", label: "Bull %", format: "prob" },
  { key: "bear", label: "Bear %", format: "prob" },
  { key: "remove", label: "", format: "remove" },
];

let currentTab = "holdings";
let mergedData = [];
let sortCol = "weight_pct";
let sortDir = "desc";

const elements = {
  thead: document.querySelector("#main-table thead"),
  tbody: document.querySelector("#main-table tbody"),
  totalPositions: document.getElementById("total-positions"),
  totalNotional: document.getElementById("total-notional"),
  refreshButton: document.getElementById("refresh"),
  tabButtons: document.querySelectorAll(".tab-btn"),
  // Quick Add
  quickAddForm: document.getElementById("quick-add-form"),
};

const formatters = {
  currency: (val) =>
    new Intl.NumberFormat("en-US", {
      style: "currency",
      currency: "USD",
    }).format(val),
  percent: (val) => `${val > 0 ? "+" : ""}${Number(val).toFixed(2)}%`,
  number: (val) =>
    new Intl.NumberFormat("en-US", {
      maximumFractionDigits: 2,
    }).format(val),
  score: (val) => Number(val).toFixed(2),
  prob: (val) => (val * 100).toFixed(0) + "%",
  default: (val) => String(val),
};

function formatValue(value, format) {
  if (value == null || Number.isNaN(value)) return "--";
  return (formatters[format] || formatters.default)(value);
}

function handleSort(colKey) {
  if (colKey === "remove") return;
  if (sortCol === colKey) {
    sortDir = sortDir === "asc" ? "desc" : "asc";
  } else {
    sortCol = colKey;
    sortDir = "desc";
  }
  renderTable();
}

async function removeTicker(ticker) {
  if (!confirm(`Remove ${ticker} from portfolio?`)) return;
  try {
    const res = await fetch(`/api/portfolio/position/${ticker}`, { method: "DELETE" });
    if (res.ok) await loadData();
  } catch (err) {
    console.error(err);
  }
}

function renderTable() {
  const activeCols = [...commonCols, ...(currentTab === "holdings" ? holdingsCols : evalCols)];

  // Sort data
  const sortedData = [...mergedData].sort((a, b) => {
    let valA = a[sortCol];
    let valB = b[sortCol];

    if (valA == null) return 1;
    if (valB == null) return -1;

    if (typeof valA === "string") {
      valA = valA.toLowerCase();
      valB = valB.toLowerCase();
    }

    if (valA < valB) return sortDir === "asc" ? -1 : 1;
    if (valA > valB) return sortDir === "asc" ? 1 : -1;
    return 0;
  });

  // Render Header
  const trHead = document.createElement("tr");
  activeCols.forEach((col) => {
    const th = document.createElement("th");
    if (col.key !== "remove") {
      th.className = "sortable";
      if (sortCol === col.key) th.classList.add(sortDir);
      th.addEventListener("click", () => handleSort(col.key));
    }
    th.textContent = col.label;
    trHead.appendChild(th);
  });
  elements.thead.replaceChildren(trHead);

  // Render Rows
  const fragment = document.createDocumentFragment();
  sortedData.forEach((row, i) => {
    const tr = document.createElement("tr");
    tr.className = "fade-in";
    tr.style.animationDelay = `${i * 0.01}s`;

    activeCols.forEach((col) => {
      const td = document.createElement("td");
      
      if (col.format === "remove") {
        const btn = document.createElement("button");
        btn.innerHTML = "&times;";
        btn.className = "btn-remove-inline";
        btn.title = "Remove from portfolio";
        btn.onclick = (e) => {
          e.stopPropagation();
          removeTicker(row.ticker);
        };
        td.appendChild(btn);
      } else {
        const value = row[col.key];
        const text = formatValue(value, col.format);

        if (col.key === "ticker" && row.name) {
          td.setAttribute("data-name", row.name);
          td.style.cursor = "help";
        }

        if (col.format === "percent" && value != null) {
          td.className = value >= 0 ? "positive badge" : "negative badge";
        } else if (col.format === "score" && value != null) {
          if (value >= 8) td.className = "score-high";
          else if (value <= 4) td.className = "score-low";
        }

        td.textContent = text;
      }
      tr.appendChild(td);
    });
    fragment.appendChild(tr);
  });
  elements.tbody.replaceChildren(fragment);
}

async function loadData() {
  try {
    elements.refreshButton.disabled = true;

    const [dashRes, evalRes] = await Promise.all([
      fetch("/api/dashboard"),
      fetch("/api/eval")
    ]);

    if (!dashRes.ok || !evalRes.ok) throw new Error("API Error");

    const dashData = await dashRes.json();
    const evalData = await evalRes.json();

    // Join data on ticker
    const evalMap = new Map(evalData.map(e => [e.ticker.replace("-", ".").toUpperCase(), e]));
    
    mergedData = (dashData.rows || []).map(row => {
      const key = row.ticker.replace("-", ".").toUpperCase();
      const evalInfo = evalMap.get(key) || {};
      return {
        ...row,
        ...evalInfo,
        name: row.name || evalInfo.name || row.ticker
      };
    });

    // Update Totals
    elements.totalPositions.textContent = mergedData.length;
    const total = mergedData.reduce((acc, row) => acc + (row.notional || 0), 0);
    elements.totalNotional.textContent = formatters.currency(total);

    renderTable();
  } catch (err) {
    console.error(err);
    elements.tbody.innerHTML = `<tr><td colspan="5" style="text-align:center;padding:2rem;color:var(--muted)">Failed to load data</td></tr>`;
  } finally {
    elements.refreshButton.disabled = false;
  }
}

elements.tabButtons.forEach(btn => {
  btn.addEventListener("click", () => {
    currentTab = btn.dataset.tab;
    sortCol = currentTab === "holdings" ? "weight_pct" : "overall";
    sortDir = "desc";
    elements.tabButtons.forEach(b => b.classList.toggle("active", b === btn));
    renderTable();
  });
});

elements.quickAddForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const ticker = document.getElementById("quick-ticker").value.toUpperCase();
  const quantity = parseFloat(document.getElementById("quick-qty").value);

  // Auto-detect bucket if not exists (fallback to Tactical)
  const existing = mergedData.find(d => d.ticker.toUpperCase() === ticker);
  const bucket = existing ? existing.bucket : "Tactical Opportunities";
  const name = existing ? existing.name : ticker;

  const payload = { ticker, name, quantity, bucket, delta: 1.0, current_price: 0.0 };

  try {
    const res = await fetch("/api/portfolio/position", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) {
      await loadData();
      elements.quickAddForm.reset();
    }
  } catch (err) {
    console.error(err);
  }
});

elements.refreshButton.addEventListener("click", loadData);
loadData();
