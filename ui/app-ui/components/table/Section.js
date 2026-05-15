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
}) {
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
				</div>
				<div className="dashboard-tabs-actions">
					<${QuickAdd}
						rows=${rows}
						isUsingDemoData=${isUsingDemoData}
						onSubmit=${onAddOrUpdate}
					/>
				</div>
			</div>

			<${Table}
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
			/>
		</div>
	`;
}
