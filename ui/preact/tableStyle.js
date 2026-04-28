import { html } from "htm/preact";

import { getScoreColor } from "./color.js";

const DEFAULT_COLUMN_PADDING_CHARS = 0;
const DEFAULT_COLUMN_EXTRA_PX = 8;

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
		(maxLength, value) =>
			Math.max(maxLength, getTextLength(value) + paddingChars),
		0,
	);
	return Math.max(headerLength, contentLength);
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
	{ extraPx = DEFAULT_COLUMN_EXTRA_PX } = {},
) {
	if (!charCount) {
		return null;
	}

	const width = `calc((${charCount} * 1ch) + ${extraPx}px)`;
	return {
		width,
		minWidth: width,
		maxWidth: width,
	};
}
