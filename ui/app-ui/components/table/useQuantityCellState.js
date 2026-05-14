import { useEffect, useRef, useState } from "react";

export function useQuantityCellState({ row, isUsingDemoData, onSetQuantity }) {
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
		direction: 0,
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
	}, [draftQty, row.quantity]);

	const commit = async (qty) => {
		if (!canEdit) return;
		if (Number.isNaN(qty)) return;

		lastCommitted.current = qty;
		const res = await onSetQuantity({
			ticker: row.ticker,
			quantity: qty,
			silent: true,
		});

		if (!res?.ok) return;
	};

	const scheduleCommit = (qty) => {
		if (!canEdit) return;

		clearDebounce();

		debounceRef.current = setTimeout(() => {
			debounceRef.current = null;
			commit(qty);
		}, 3000);
	};

	const applyStep = (direction, evt, overrideStep) => {
		const step = overrideStep ?? (evt?.shiftKey ? 10 : evt?.altKey ? 100 : 1);
		const base = Number.isFinite(numericDraftRef.current)
			? numericDraftRef.current
			: lastCommitted.current;
		const next = Math.max(0, (Number(base) || 0) + direction * step);
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

	const startHold = (direction, evt) => {
		if (!canEdit) return;

		ignoreNextClickRef.current = true;
		evt.preventDefault();

		const step = evt.shiftKey ? 10 : evt.altKey ? 100 : 1;

		stopHold();
		holdRef.current.isActive = true;
		holdRef.current.startMs = performance.now();
		holdRef.current.direction = direction;
		holdRef.current.step = step;
		holdRef.current.captureTarget = evt.currentTarget;
		holdRef.current.pointerId = evt.pointerId;

		try {
			evt.currentTarget.setPointerCapture(evt.pointerId);
		} catch {
			// ignore
		}

		applyStep(direction, evt, step);

		const tick = () => {
			if (!holdRef.current.isActive) return;

			const elapsedMs = performance.now() - holdRef.current.startMs;
			const intervalMs = Math.max(
				30,
				Math.round(220 * 0.78 ** (elapsedMs / 650)),
			);

			applyStep(holdRef.current.direction, null, holdRef.current.step);
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
			if (holdRef.current.timer) {
				clearTimeout(holdRef.current.timer);
			}
			holdRef.current.isActive = false;
			holdRef.current.timer = null;
			holdRef.current.captureTarget = null;
			holdRef.current.pointerId = null;
			if (debounceRef.current) {
				clearTimeout(debounceRef.current);
				debounceRef.current = null;
			}
		};
	}, []);

	const onSpinClick = (direction) => (evt) => {
		if (ignoreNextClickRef.current) {
			ignoreNextClickRef.current = false;
			return;
		}

		applyStep(direction, evt);
	};

	const onSpinKeyDown = (direction) => (evt) => {
		if (evt.key !== "Enter" && evt.key !== " ") return;
		evt.preventDefault();
		applyStep(direction, evt);
	};

	const onSpinPointerDown = (direction) => (evt) => startHold(direction, evt);

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
