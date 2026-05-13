import { html } from "htm/react";

import { getScoreColor } from "./color.js";

const DEFAULT_COLUMN_PADDING_CHARS = 1;
const DEFAULT_COLUMN_EXTRA_PX = 2;
const COLUMN_CHARACTER_WIDTH_PX = 7.2;
const MIN_COLUMN_EXTRA_PX = 2;
const SORT_INDICATOR_WIDTH_PX = 5;

function getTextLength(value) {
	return String(value ?? "").length;
}

export function getColumnCharCount(
	values,
	headerLabel,
	{ paddingChars = DEFAULT_COLUMN_PADDING_CHARS } = {},
) {
	const headerLength = getTextLength(headerLabel);
	const contentLength = values.reduce(
		(maxLength, value) => Math.max(maxLength, getTextLength(value)),
		0,
	);
	return Math.max(headerLength, contentLength) + Math.max(1, paddingChars);
}

export function getToneClass(value, baseClass = "") {
	const numeric = Number(value);
	const tone =
		Number.isNaN(numeric) || numeric === 0
			? "neutral"
			: numeric > 0
				? "positive"
				: "negative";
	return baseClass ? `${baseClass} ${tone}` : tone;
}

export function renderConditionallyColoredValue(
	content,
	{ value, colorMeta, colorKey },
) {
	if (!colorMeta?.[colorKey]) {
		return content;
	}

	const textColor = getScoreColor(value, colorMeta[colorKey]);
	if (!textColor) {
		return content;
	}

	return html`<span style=${{ color: textColor }}>${content}</span>`;
}

export function getColumnWidthStyle(
	charCount,
	{ extraPx = DEFAULT_COLUMN_EXTRA_PX, minPx = 0 } = {},
) {
	if (!charCount) {
		return null;
	}

	const widthPx =
		charCount * COLUMN_CHARACTER_WIDTH_PX +
		Math.max(extraPx, MIN_COLUMN_EXTRA_PX) +
		SORT_INDICATOR_WIDTH_PX;
	const width = `${Math.max(minPx, widthPx)}px`;
	return {
		width,
		minWidth: width,
		maxWidth: width,
	};
}
