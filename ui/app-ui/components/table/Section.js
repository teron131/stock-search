import { html } from "htm/react";

import { QuickAdd } from "./QuickAdd.js";
import { Table } from "./Table.js";

export function TableSection({
  tab,
  rows,
  stats,
  sortCol,
  sortDir,
  onTabChange,
  onSort,
  onRemove,
  onSetQuantity,
  colorStandards,
  isUsingDemoData,
  isBackgroundLoading,
  isLoading,
  onAddOrUpdate,
  tableDisplayOptions,
  onToggleNotionalDisplay,
  correlationView,
}) {
  const showNotional = tableDisplayOptions?.showNotional !== false;
  const isCorrelationTab = tab === "correlation";
  const notionalToggleTitle = showNotional ? "Hide notional columns" : "Show notional columns";

  return html`
    <div className="tabs-container" id="dashboard-tables">
      <div className="tabs-header">
        <div className="tab-group">
          <button
            type="button"
            className=${`tab-btn ${tab === "all" ? "active" : ""}`}
            onClick=${() => onTabChange("all")}
          >
            ALL
          </button>
          <button
            type="button"
            className=${`tab-btn ${tab === "holdings" ? "active" : ""}`}
            onClick=${() => onTabChange("holdings")}
          >
            PORTFOLIO
          </button>
          <button
            type="button"
            className=${`tab-btn ${tab === "evaluations" ? "active" : ""}`}
            onClick=${() => onTabChange("evaluations")}
          >
            EVALUATION
          </button>
          <button
            type="button"
            className=${`tab-btn ${isCorrelationTab ? "active" : ""}`}
            onClick=${() => onTabChange("correlation")}
          >
            CORRELATION
          </button>
        </div>
        <div
          className="dashboard-tabs-actions"
          style=${{ display: isCorrelationTab ? "none" : undefined }}
        >
          <div className="table-display-options" aria-label="Table display options">
            <button
              type="button"
              className=${`table-option-toggle ${showNotional ? "active" : ""}`.trim()}
              aria-pressed=${showNotional}
              title=${notionalToggleTitle}
              onClick=${onToggleNotionalDisplay}
            >
              NOTIONAL
            </button>
          </div>
          <${QuickAdd} rows=${rows} isUsingDemoData=${isUsingDemoData} onSubmit=${onAddOrUpdate} />
        </div>
      </div>

      ${isCorrelationTab
        ? correlationView
        : html`<${Table}
            tab=${tab}
            rows=${rows}
            stats=${stats}
            sortCol=${sortCol}
            sortDir=${sortDir}
            onSort=${onSort}
            onRemove=${onRemove}
            onSetQuantity=${onSetQuantity}
            colorStandards=${colorStandards}
            isUsingDemoData=${isUsingDemoData}
            isLoading=${isLoading}
            animateRows=${!isBackgroundLoading}
            tableDisplayOptions=${tableDisplayOptions}
          />`}
    </div>
  `;
}
