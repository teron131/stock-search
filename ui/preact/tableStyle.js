import { html } from "htm/preact";

import { getScoreColor } from "./color.js";

function getTextLength(value) {
	return String(value ?? "").length;
}

export function getColumnCharCount(
	values,
	headerLabel,
	{ paddingChars = 0 } = {},
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
