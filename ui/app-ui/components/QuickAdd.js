import { html } from "htm/react";
import { useMemo, useState } from "react";

import { normalizeTicker } from "../format.js";

export function QuickAdd({ rows, isUsingDemoData, onSubmit }) {
	const [ticker, setTicker] = useState("");
	const [qty, setQty] = useState("");
	const [isSubmitting, setIsSubmitting] = useState(false);

	const existingQty = useMemo(() => {
		const t = normalizeTicker(ticker);
		const existing = rows.find((r) => normalizeTicker(r.ticker) === t);
		const qty = existing ? Number(existing.quantity) : null;
		return qty != null && !Number.isNaN(qty) ? qty : null;
	}, [rows, ticker]);

	const submit = async (e) => {
		e.preventDefault();

		setIsSubmitting(true);
		try {
			const result = await onSubmit({
				ticker,
				quantity: qty.trim() === "" ? null : qty,
				existingQuantity: existingQty,
			});
			if (!result?.ok) return;
			setTicker("");
			setQty("");
		} finally {
			setIsSubmitting(false);
		}
	};

	const submitLabel = existingQty != null ? "UPDATE" : "ADD";

	return html`
    <form id="quick-add-form" className="quick-add-compact" onSubmit=${submit}>
      <input
        type="text"
        id="input-ticker"
        aria-label="Ticker symbol"
        placeholder="TICKER"
        required
        autoComplete="off"
        value=${ticker}
        onInput=${(e) => setTicker(e.target.value)}
        disabled=${isSubmitting}
        suppressHydrationWarning=${true}
      />
      <input
        type="number"
        id="input-qty"
        aria-label="Position quantity"
        placeholder="QTY / 0"
        step="any"
        value=${qty}
        onInput=${(e) => setQty(e.target.value)}
        disabled=${isSubmitting}
        suppressHydrationWarning=${true}
      />
      <button
        type="submit"
        className="btn-add-mini"
        title=${
					isUsingDemoData
						? "Demo mode: changes are not saved"
						: existingQty != null
							? "Update existing position"
							: "Add new position"
				}
        disabled=${isSubmitting}
      >
        ${isSubmitting ? "…" : submitLabel}
      </button>
    </form>
  `;
}
