const columnConfig = [
  { key: "ticker", label: "Ticker" },
  { key: "quantity", label: "Qty", format: "number" },
  { key: "current_price", label: "Price", format: "currency" },
  { key: "change_percent", label: "Change %", format: "percent", badge: true },
  { key: "rsi", label: "RSI", format: "number" },
  { key: "twenty_day_change_percent", label: "20D %", format: "percent", badge: true },
  { key: "fifty_day_change_percent", label: "50D %", format: "percent", badge: true },
  { key: "two_hundred_day_change_percent", label: "200D %", format: "percent", badge: true },
  { key: "median_upside", label: "Upside", format: "percent" },
  { key: "notional", label: "Notional", format: "currency" },
  { key: "weight_pct", label: "Weight %", format: "percent" },
];

const table = document.getElementById("dashboard-table");
const thead = table.querySelector("thead");
const tbody = table.querySelector("tbody");
const totalPositions = document.getElementById("total-positions");
const totalNotional = document.getElementById("total-notional");
const refreshButton = document.getElementById("refresh");

const formatValue = (value, format) => {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return "--";
  }
  switch (format) {
    case "currency":
      return new Intl.NumberFormat("en-US", {
        style: "currency",
        currency: "USD",
        maximumFractionDigits: 2,
      }).format(value);
    case "percent":
      return `${Number(value).toFixed(2)}%`;
    case "number":
      return new Intl.NumberFormat("en-US", {
        maximumFractionDigits: 2,
      }).format(value);
    default:
      return String(value);
  }
};

const buildHeader = () => {
  const row = document.createElement("tr");
  columnConfig.forEach((column) => {
    const th = document.createElement("th");
    th.textContent = column.label;
    row.appendChild(th);
  });
  thead.innerHTML = "";
  thead.appendChild(row);
};

const buildRows = (rows) => {
  tbody.innerHTML = "";
  rows.forEach((rowData, index) => {
    const tr = document.createElement("tr");
    tr.classList.add("fade-in");
    tr.style.animationDelay = `${index * 0.02}s`;

    columnConfig.forEach((column) => {
      const td = document.createElement("td");
      const rawValue = rowData[column.key];
      const formatted = formatValue(rawValue, column.format);

      if (column.badge && rawValue !== null && rawValue !== undefined) {
        const badge = document.createElement("span");
        badge.classList.add("badge");
        badge.classList.add(Number(rawValue) >= 0 ? "positive" : "negative");
        badge.textContent = formatted;
        td.appendChild(badge);
      } else {
        td.textContent = formatted;
      }

      tr.appendChild(td);
    });

    tbody.appendChild(tr);
  });
};

const updateTotals = (rows) => {
  totalPositions.textContent = rows.length;
  const notionalSum = rows.reduce((acc, row) => acc + (row.notional || 0), 0);
  totalNotional.textContent = formatValue(notionalSum, "currency");
};

const loadDashboard = async () => {
  try {
    const response = await fetch("/api/dashboard");
    if (!response.ok) {
      throw new Error("Failed to fetch dashboard data");
    }
    const data = await response.json();
    buildHeader();
    buildRows(data.rows || []);
    updateTotals(data.rows || []);
  } catch (error) {
    tbody.innerHTML = "<tr><td colspan=\"11\">Unable to load data. Check the API.</td></tr>";
  }
};

refreshButton.addEventListener("click", () => {
  loadDashboard();
});

loadDashboard();
