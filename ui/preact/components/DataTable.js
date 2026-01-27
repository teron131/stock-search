import { html } from "https://esm.sh/htm@3.1.1/preact";

import { useEffect, useRef, useState } from "https://esm.sh/preact@10.19.6/hooks";

import { calculateScoreColorMetadata, getScoreColor } from "../color.js";
import { COLS, CONFIG } from "../config.js";
import { fmt, normalizeTicker, parseMarketCap } from "../format.js";

function compareNullable(a, b, dir) {
  if (a == null) return 1;
  if (b == null) return -1;

  const na = typeof a === "string" ? a.toLowerCase() : a;
  const nb = typeof b === "string" ? b.toLowerCase() : b;

  if (na === nb) return 0;
  return dir === "asc" ? (na < nb ? -1 : 1) : na < nb ? 1 : -1;
}

function sortRows(rows, col, dir) {
  const sorted = [...rows];
  sorted.sort((a, b) => {
    if (col === "market_cap") {
      return compareNullable(parseMarketCap(a.market_cap), parseMarketCap(b.market_cap), dir);
    }

    return compareNullable(a[col], b[col], dir);
  });
  return sorted;
}

function QtyCell({ row, isUsingDemoData, onSetQuantity }) {
  const canEdit = !isUsingDemoData;
  const initialQty = Number(row.quantity) || 0;

  const [draftQty, setDraftQty] = useState(String(initialQty));
  const lastCommitted = useRef(initialQty);
  const numericDraftRef = useRef(initialQty);
  const debounceRef = useRef(null);

  const ignoreNextClickRef = useRef(false);
  const holdRef = useRef({
    isActive: false,
    timer: null,
    startMs: 0,
    delta: 0,
    step: 1,
    captureTarget: null,
    pointerId: null,
  });

  function clearDebounce() {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  }

  // When backend updates quantity (after refresh), sync draft unless user is mid-edit.
  useEffect(() => {
    const next = Number(row.quantity) || 0;
    // If we haven't diverged, keep in sync
    if (Number(draftQty) === lastCommitted.current) {
      setDraftQty(String(next));
      numericDraftRef.current = next;
    }
    lastCommitted.current = next;
  }, [row.quantity]);

  const markHeaderUpdating = () => {
    const lastUpdateEl = document.getElementById("last-update");
    if (!lastUpdateEl) return;
    const modeText = isUsingDemoData ? " [DEMO]" : "";
    lastUpdateEl.textContent = `UPDATING...${modeText}`;
  };

  const commit = async (qty) => {
    if (!canEdit) return;
    if (Number.isNaN(qty)) return;

    markHeaderUpdating();

    lastCommitted.current = qty;
    const res = await onSetQuantity({
      ticker: row.ticker,
      quantity: qty,
      delta: row.delta ?? 1.0,
      bucket: row.bucket,
      silent: true,
    });

    if (!res?.ok) return;
  };

  const scheduleCommit = (qty) => {
    if (!canEdit) return;

    markHeaderUpdating();

    clearDebounce();

    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      commit(qty);
    }, 3000);
  };

  const applyDelta = (delta, evt, overrideStep) => {
    const step = overrideStep ?? (evt?.shiftKey ? 10 : evt?.altKey ? 100 : 1);
    const base = Number.isFinite(numericDraftRef.current) ? numericDraftRef.current : lastCommitted.current;
    const next = Math.max(0, (Number(base) || 0) + delta * step);
    numericDraftRef.current = next;
    setDraftQty(String(next));
    scheduleCommit(next);
  };

  const stopHold = (evt) => {
    if (!holdRef.current.isActive) return;

    // If the pointer interaction won't generate a click (cancel/leave), clear suppression.
    if (evt && evt.type !== "pointerup") {
      ignoreNextClickRef.current = false;
    }

    holdRef.current.isActive = false;
    if (holdRef.current.timer) clearTimeout(holdRef.current.timer);
    holdRef.current.timer = null;

    if (holdRef.current.captureTarget && holdRef.current.pointerId != null) {
      try {
        holdRef.current.captureTarget.releasePointerCapture(holdRef.current.pointerId);
      } catch {
        // ignore
      }
    }

    holdRef.current.captureTarget = null;
    holdRef.current.pointerId = null;
  };

  const startHold = (delta, evt) => {
    if (!canEdit) return;

    ignoreNextClickRef.current = true;
    evt.preventDefault();

    const step = evt.shiftKey ? 10 : evt.altKey ? 100 : 1;

    stopHold();
    holdRef.current.isActive = true;
    holdRef.current.startMs = performance.now();
    holdRef.current.delta = delta;
    holdRef.current.step = step;
    holdRef.current.captureTarget = evt.currentTarget;
    holdRef.current.pointerId = evt.pointerId;

    try {
      evt.currentTarget.setPointerCapture(evt.pointerId);
    } catch {
      // ignore
    }

    // Apply once immediately
    applyDelta(delta, evt, step);

    const tick = () => {
      if (!holdRef.current.isActive) return;

      const elapsedMs = performance.now() - holdRef.current.startMs;
      const intervalMs = Math.max(30, Math.round(220 * Math.pow(0.78, elapsedMs / 650)));

      applyDelta(holdRef.current.delta, null, holdRef.current.step);
      holdRef.current.timer = setTimeout(tick, intervalMs);
    };

    // Initial delay before repeat
    holdRef.current.timer = setTimeout(tick, 320);
  };

  const onInput = (e) => {
    const nextText = e.target.value;
    setDraftQty(nextText);

    const parsed = Number(nextText);
    if (Number.isNaN(parsed)) return;

    numericDraftRef.current = parsed;
    scheduleCommit(parsed);
  };

  const onKeyDown = (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const parsed = Number(draftQty);
      if (Number.isNaN(parsed)) return;
      clearDebounce();
      commit(parsed);
      e.target.blur();
    }
  };

  const onBlur = () => {
    stopHold();

    const parsed = Number(draftQty);
    if (Number.isNaN(parsed)) return;
    clearDebounce();
    commit(parsed);
  };

  useEffect(() => {
    return () => {
      stopHold();
      clearDebounce();
    };
  }, []);

  const onSpinClick = (delta) => (evt) => {
    // Pointer interaction increments happen in onPointerDown.
    if (ignoreNextClickRef.current) {
      ignoreNextClickRef.current = false;
      return;
    }

    applyDelta(delta, evt);
  };

  const onSpinKeyDown = (delta) => (evt) => {
    if (evt.key !== "Enter" && evt.key !== " ") return;
    evt.preventDefault();
    applyDelta(delta, evt);
  };

  return html`<div class="qty-control">
    <input
      class="qty-input"
      type="number"
      step="1"
      min="0"
      value=${draftQty}
      onInput=${onInput}
      onKeyDown=${onKeyDown}
      onBlur=${onBlur}
      disabled=${!canEdit}
    />
    <div class="qty-spin">
      <button
        class="qty-spin-btn"
        disabled=${!canEdit}
        onPointerDown=${(e) => startHold(1, e)}
        onPointerUp=${stopHold}
        onPointerCancel=${stopHold}
        onPointerLeave=${stopHold}
        onClick=${onSpinClick(1)}
        onKeyDown=${onSpinKeyDown(1)}
        title="Up"
      >▲</button>
      <button
        class="qty-spin-btn"
        disabled=${!canEdit}
        onPointerDown=${(e) => startHold(-1, e)}
        onPointerUp=${stopHold}
        onPointerCancel=${stopHold}
        onPointerLeave=${stopHold}
        onClick=${onSpinClick(-1)}
        onKeyDown=${onSpinKeyDown(-1)}
        title="Down"
      >▼</button>
    </div>
  </div>`;
}

function renderCell({ row, col, colorMeta, onRemove, onSetQuantity, isUsingDemoData }) {
  const key = col.key;
  const format = col.format;

  if (key === "quantity" && onSetQuantity) {
    return html`<${QtyCell} row=${row} isUsingDemoData=${isUsingDemoData} onSetQuantity=${onSetQuantity} />`;
  }
  
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

    if (textColor) {
      return html`<span style=${{ color: textColor }}>${content}</span>`;
    }
  }

  return content;
}

export function DataTable({
  tab,
  rows,
  sortCol,
  sortDir,
  onSort,
  onRemove,
  onSetQuantity,
  isUsingDemoData = false,
  animateRows = true,
}) {
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
                  (row, i) => html`<tr
                    key=${normalizeTicker(row.ticker)}
                    class=${animateRows ? "animate-in" : ""}
                    style=${animateRows ? { animationDelay: `${i * CONFIG.animationDelayMs}ms` } : null}
                  >
                    ${cols.map(                      (col) => html`<td>${renderCell({ row, col, colorMeta, onRemove, onSetQuantity, isUsingDemoData })}</td>`)}
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