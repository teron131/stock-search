const columnConfig = [
  { key: "ticker", label: "Ticker" },
  { key: "quantity", label: "Qty", format: "number" },
  { key: "current_price", label: "Price", format: "currency" },
  { key: "change_percent", label: "Change %", format: "percent" },
  { key: "rsi", label: "RSI", format: "number" },
  { key: "twenty_day_change_percent", label: "20D %", format: "percent" },
  { key: "fifty_day_change_percent", label: "50D %", format: "percent" },
  { key: "two_hundred_day_change_percent", label: "200D %", format: "percent" },
  { key: "median_upside", label: "Upside", format: "percent" },
  { key: "notional", label: "Notional", format: "currency" },
  { key: "weight_pct", label: "Weight %", format: "percent" },
];

const elements = {
  table: document.getElementById("dashboard-table"),
  thead: document.querySelector("#dashboard-table thead"),
  tbody: document.querySelector("#dashboard-table tbody"),
  totalPositions: document.getElementById("total-positions"),
  totalNotional: document.getElementById("total-notional"),
  refreshButton: document.getElementById("refresh"),
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
  default: (val) => String(val),
};

function formatValue(value, format) {
  if (value == null || Number.isNaN(value)) return "--";
  return (formatters[format] || formatters.default)(value);
}

function buildHeader() {
  const row = document.createElement("tr");
  columnConfig.forEach((col) => {
    const th = document.createElement("th");
    th.textContent = col.label;
    row.appendChild(th);
  });
  elements.thead.replaceChildren(row);
}

function buildRows(rows) {
  const fragment = document.createDocumentFragment();

  rows.forEach((rowData, i) => {
    const tr = document.createElement("tr");
    tr.className = "fade-in";
    tr.style.animationDelay = `${i * 0.01}s`;

    columnConfig.forEach((col) => {
      const td = document.createElement("td");
      const value = rowData[col.key];
      const text = formatValue(value, col.format);

      if (col.format === "percent" && value != null) {
        td.className = value >= 0 ? "positive badge" : "negative badge";
      }

      td.textContent = text;
      tr.appendChild(td);
    });

    fragment.appendChild(tr);
  });

  elements.tbody.replaceChildren(fragment);
}

function updateTotals(rows) {
  elements.totalPositions.textContent = rows.length;
  const total = rows.reduce((acc, row) => acc + (row.notional || 0), 0);
  elements.totalNotional.textContent = formatters.currency(total);
}

async function loadDashboard() {
  try {
    elements.refreshButton.disabled = true;
    const res = await fetch("/api/dashboard");
    if (!res.ok) throw new Error("API Error");
    const data = await res.json();
    
    buildHeader();
    buildRows(data.rows || []);
    updateTotals(data.rows || []);
  } catch (err) {
    console.error(err);
    elements.tbody.innerHTML = `<tr><td colspan="${columnConfig.length}" style="text-align:center;padding:2rem;color:var(--muted)">Failed to load data</td></tr>`;
  } finally {
    elements.refreshButton.disabled = false;
  }
}

elements.refreshButton.addEventListener("click", loadDashboard);
loadDashboard();
