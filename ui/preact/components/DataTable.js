import { html } from "https://esm.sh/htm@3.1.1/preact";

import { calculateScoreColorMetadata, getScoreColor } from "../color.js";
import { COLS, CONFIG } from "../config.js";
import { fmt, normalizeTicker, parseMarketCap } from "../format.js";

function sortRows(rows, col, dir) {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    const valA = a[col];
    const valB = b[col];

    if (col === "market_cap") {
      const capA = parseMarketCap(a.market_cap);
      const capB = parseMarketCap(b.market_cap);
      if (capA == null) return 1;
      if (capB == null) return -1;
      if (capA === capB) return 0;
      return dir === "asc" ? (capA < capB ? -1 : 1) : capA < capB ? 1 : -1;
    }

    if (valA == null) return 1;
    if (valB == null) return -1;

    const na = typeof valA === "string" ? valA.toLowerCase() : valA;
    const nb = typeof valB === "string" ? valB.toLowerCase() : valB;

    if (na === nb) return 0;
    return dir === "asc" ? (na < nb ? -1 : 1) : na < nb ? 1 : -1;
  });
  return sorted;
}

function renderCell({ row, col, colorMeta, onRemove }) {
  const key = col.key;
  const format = col.format;

  if (key === "remove") {
    return html`<button class="btn-remove-cell" onClick=${() => onRemove(row.ticker)} title="Remove">
      <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
        <line x1="18" y1="6" x2="6" y2="18" />
        <line x1="6" y1="6" x2="18" y2="18" />
      </svg>
    </button>`;
  }

  if (key === "ticker") {
    const val = normalizeTicker(row.ticker);
    return html`<tv-ticker-tag
      symbol=${val}
      preserve-text
      hide-change
      hide-background
      theme="dark"
      transparent
    >${val}</tv-ticker-tag>`;
  }

  const valueForDisplay = row[key];
  const formatter = fmt[format] || fmt.default;

  let content;
  if (format === "percent") {
    const numeric = Number(valueForDisplay);
    const badgeClass = numeric >= 0 ? "positive" : "negative";
    content = html`<span class=${`badge ${badgeClass}`}>${formatter(valueForDisplay)}</span>`;
  } else if (format === "percent_neutral") {
    content = html`<span class="cell-weight">${formatter(valueForDisplay)}</span>`;
  } else if (format === "score") {
    const numeric = Number(valueForDisplay);
    const scoreClass =
      numeric >= CONFIG.scoreThresholds.high
        ? "score-high"
        : numeric <= CONFIG.scoreThresholds.low
          ? "score-low"
          : "score-mid";
    content = html`<span class=${scoreClass}>${formatter(valueForDisplay)}</span>`;
  } else {
    content = formatter(valueForDisplay);
  }

  // Apply conditional coloring
  const colorKey = col.key;
  const isColorizable =
    ["score", "prob", "percent_neutral", "number", "market_cap"].includes(format) ||
    ["rank", "rsi", "market_cap"].includes(colorKey);

  if (isColorizable && colorMeta && colorMeta[colorKey]) {
    const rawValue = colorKey === "market_cap" ? parseMarketCap(row.market_cap) : row[colorKey];
    const textColor = getScoreColor(rawValue, colorMeta[colorKey]);

    if (textColor && typeof content === "string") {
      return html`<span style=${{ color: textColor }}>${content}</span>`;
    }

    // If content is a VNode with span, apply style at a wrapper
    if (textColor) {
      return html`<span style=${{ color: textColor }}>${content}</span>`;
    }
  }

  return content;
}

export function DataTable({ tab, rows, sortCol, sortDir, onSort, onRemove }) {
  const cols = COLS[tab];

  const filtered = rows.filter((r) => {
    if (tab === "holdings") return r.quantity != null && r.notional != null;
    return r.overall != null || r.rank != null;
  });

  const sorted = sortRows(filtered, sortCol, sortDir);
  const colorMeta = calculateScoreColorMetadata(sorted, cols, { colorBandFraction: CONFIG.colorBandFraction });

  return html`
    <div class="tabs-container">
      <div class="table-wrapper">
        <table id="main-table">
          <thead>
            <tr>
              ${cols.map((c) => {
                if (c.key === "remove") return html`<th></th>`;
                const sortedClass = sortCol === c.key ? `sorted ${sortDir}` : "";
                return html`<th data-sort=${c.key} class=${sortedClass} onClick=${() => onSort(c.key)}>${c.label}</th>`;
              })}
            </tr>
          </thead>
          <tbody>
            ${sorted.length
              ? sorted.map(
                  (row, i) => html`<tr class=${"animate-in"} style=${{ animationDelay: `${i * CONFIG.animationDelayMs}ms` }}>
                    ${cols.map(
                      (col) => html`<td>${renderCell({ row, col, colorMeta, onRemove })}</td>`,
                    )}
                  </tr>`,
                )
              : html`<tr>
                  <td colspan=${cols.length} style="text-align:center;color:var(--muted);height:200px;font-family:var(--font-mono);">
                    ${tab === "holdings" ? "NO ACTIVE POSITIONS FOUND" : "NO EVALUATIONS FOUND"}
                  </td>
                </tr>`}
          </tbody>
        </table>
      </div>
    </div>
  `;
}
