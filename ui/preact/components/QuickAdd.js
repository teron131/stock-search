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
    // Treat 0/NaN as "not present" (acts like add-new)
    return qty && !Number.isNaN(qty) ? qty : null;
  }, [rows, ticker]);

  const submit = async (e) => {
    e.preventDefault();
    if (isUsingDemoData) return;

    setIsSubmitting(true);
    try {
      await onSubmit({ ticker, quantity: qty, existingQuantity: existingQty });
      setTicker("");
      setQty("");
    } finally {
      setIsSubmitting(false);
    }
  };

  return html`
    <form id="quick-add-form" class="quick-add-compact" onSubmit=${submit}>
      <input
        type="text"
        id="input-ticker"
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
        title="Update or Add Position"
        disabled=${isSubmitting}
      >
        ${isSubmitting
          ? "…"
          : html`
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="14"
                height="14"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-linejoin="round"
              >
                <line x1="5" y1="12" x2="19" y2="12"></line>
                <polyline points="12 5 19 12 12 19"></polyline>
              </svg>
            `}
      </button>
    </form>
  `;
}
