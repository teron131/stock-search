import { html } from "https://esm.sh/htm@3.1.1/preact";
import { useMemo, useState } from "https://esm.sh/preact@10.19.6/hooks";

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
		if (isUsingDemoData) return;

		setIsSubmitting(true);
		try {
			await onSubmit({
				ticker,
				quantity: qty,
				existingQuantity: existingQty,
			});
			setTicker("");
			setQty("");
		} finally {
			setIsSubmitting(false);
		}
	};

	const submitLabel = existingQty != null ? "UPDATE" : "ADD";

	return html`
    <form id="quick-add-form" class="quick-add-compact" onSubmit=${submit}>
      <input
        type="text"
        id="input-ticker"
        aria-label="Ticker symbol"
        placeholder="TICKER"
        required
        autocomplete="off"
        value=${ticker}
        onInput=${(e) => setTicker(e.target.value)}
        disabled=${isSubmitting}
      />
      <input
        type="number"
        id="input-qty"
        aria-label="Position quantity"
        placeholder="QTY"
        step="any"
        required
        value=${qty}
        onInput=${(e) => setQty(e.target.value)}
        disabled=${isSubmitting}
      />
      <button
        type="submit"
        class="btn-add-mini"
        title=${existingQty != null ? "Update existing position" : "Add new position"}
        disabled=${isSubmitting}
      >
        ${isSubmitting ? "…" : submitLabel}
      </button>
    </form>
  `;
}
