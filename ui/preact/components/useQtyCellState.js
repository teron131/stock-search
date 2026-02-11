import {
  useEffect,
  useRef,
  useState,
} from "https://esm.sh/preact@10.19.6/hooks";

export function useQtyCellState({ row, isUsingDemoData, onSetQuantity }) {
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

  const clearDebounce = () => {
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
  };

  useEffect(() => {
    const next = Number(row.quantity) || 0;
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
      delta: row.delta ?? 0.0,
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
    const base = Number.isFinite(numericDraftRef.current)
      ? numericDraftRef.current
      : lastCommitted.current;
    const next = Math.max(0, (Number(base) || 0) + delta * step);
    numericDraftRef.current = next;
    setDraftQty(String(next));
    scheduleCommit(next);
  };

  const stopHold = (evt) => {
    if (!holdRef.current.isActive) return;

    if (evt && evt.type !== "pointerup") {
      ignoreNextClickRef.current = false;
    }

    holdRef.current.isActive = false;
    if (holdRef.current.timer) clearTimeout(holdRef.current.timer);
    holdRef.current.timer = null;

    if (holdRef.current.captureTarget && holdRef.current.pointerId != null) {
      try {
        holdRef.current.captureTarget.releasePointerCapture(
          holdRef.current.pointerId,
        );
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

    applyDelta(delta, evt, step);

    const tick = () => {
      if (!holdRef.current.isActive) return;

      const elapsedMs = performance.now() - holdRef.current.startMs;
      const intervalMs = Math.max(
        30,
        Math.round(220 * Math.pow(0.78, elapsedMs / 650)),
      );

      applyDelta(holdRef.current.delta, null, holdRef.current.step);
      holdRef.current.timer = setTimeout(tick, intervalMs);
    };

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

  const onSpinPointerDown = (delta) => (evt) => startHold(delta, evt);

  return {
    canEdit,
    draftQty,
    onInput,
    onKeyDown,
    onBlur,
    stopHold,
    onSpinClick,
    onSpinKeyDown,
    onSpinPointerDown,
  };
}
