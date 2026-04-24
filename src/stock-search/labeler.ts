/** Generate label tags with the portfolio labeling graph. */

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Annotation, END, START, StateGraph } from "@langchain/langgraph";
import { ExaAnswerAgent } from "llm-harness-js/agents";
import { ChatOpenAI } from "llm-harness-js/clients";
import { z } from "zod";

import { normalizeTickerSymbol } from "./common-utils.js";
import { ModelConfig } from "./config.js";
import {
	INDUSTRY_LABELS,
	INDUSTRY_LABELS_BY_SECTOR,
} from "./models/labels.js";
import { TickerLabelsSchema, type TickerLabels } from "./models/schemas.js";

const INDUSTRY_LABEL_SET = new Set(INDUSTRY_LABELS);
const MAX_LABELS = 5;

const PillarSchema = z.object({
	pillar: z.string().describe("Business pillar name."),
	portion: z
		.number()
		.min(0)
		.max(100)
		.nullable()
		.optional()
		.describe(
			"Estimated portion of company valuation / revenue represented by this pillar (0-100).",
		),
	description: z
		.string()
		.describe("Brief one-sentence description of what this pillar does."),
});

const PillarsSchema = z.object({
	pillars: z
		.array(PillarSchema)
		.min(1)
		.max(5)
		.default([])
		.describe("Top business pillars ranked by strategic importance."),
});

const OutlookSchema = z.object({
	outlook: z
		.string()
		.describe(
			"Outlook of the company's existing pillars and emerging businesses.",
		),
	impact: z
		.string()
		.describe("Expected impact on the company's sector / industry exposure."),
});

const labelGraphState = Annotation.Root({
	ticker: Annotation<string>,
	pillars: Annotation<z.infer<typeof PillarsSchema> | null>,
	outlook: Annotation<z.infer<typeof OutlookSchema> | null>,
	labels: Annotation<TickerLabels | null>,
});

type LabelGraphState = typeof labelGraphState.State;

const PILLARS_SYSTEM_PROMPT = `Perspective: Current business pillars.

Task:
- Identify the company's current core pillars that drive revenue/profit/value today.

Finance guidance (be economically grounded):
- Prefer segment reporting and how the company itself breaks out revenue/profit (10-K/20-F, earnings deck, IR materials).
- Separate distinct business models when relevant (subscription vs usage-based, hardware vs services, ads vs transaction fees).
- Anchor pillars to cash-flow drivers (where gross profit comes from), not headlines or TAM narratives.
- If you provide \`portion\`, base it on reported segment mix or best-effort inference and keep it directionally plausible.

Rules:
- Use high-signal sources: filings, earnings materials, investor relations, reputable financial reporting.
- Avoid low-signal aggregation summaries.
- Do not copy third-party label taxonomies.
- Keep output concise and factual.`;

const OUTLOOK_QUERY =
	"Ticker: {ticker}\nCompany pillars context: {pillars}\nProvide concise outlook and sector/industry exposure impact.";

const OUTLOOK_SYSTEM_PROMPT = `Perspective: Forward outlook and exposure shift.

Task:
- Based on current pillars + fresh evidence, summarize near/medium-term outlook.
- Explain whether sector/industry exposure is likely to shift or mostly deepen.

Finance guidance (what to cover):
- Demand drivers: cyclical vs secular, and key end-markets.
- Competitive dynamics: pricing power, substitutes, switching costs, market share trajectory.
- Margin structure: mix shift, operating leverage, input costs.
- Risk factors: regulatory, customer concentration, geopolitics/supply chain, credit cycle (if relevant).
- Keep it timeframe-aware: near-term (next ~4 quarters) vs medium-term (1-3 years).

Rules:
- Stay practical and concise; avoid deep speculation.
- Use management guidance, product roadmap, and segment direction signals.`;

const LABEL_SYSTEM_PROMPT_TEMPLATE = `Final step: assign industry labels from two perspectives.

Inputs you receive:
- Perspective 1: current business pillars.
- Perspective 2: forward outlook and exposure impact.

Task:
- Produce final labels using ONLY those two perspectives.
- Choose 1 to {max_labels} labels from INDUSTRY_LABELS, ranked by importance.

Finance guidance (how to choose labels):
- Label the company by economic exposure (where revenue/gross profit is earned) rather than buzzwords.
- If the company is a "picks-and-shovels" supplier, label by the primary customer end-market(s) implied by pillars.
- If the company is diversified, pick labels that correspond to distinct pillars that together explain most of the business.

Selection rubric (consistency rules):
- Anchor each chosen label to a concrete pillar or outlook statement (revenue/profit/value driver).
- Prefer the most specific label that fits the described business; avoid overly broad labels.
- Do not pick "adjacent" labels just because they are related; pick the best-fit exposure.
- If two labels overlap, keep the more specific one unless there are clearly separate pillars.
- Order labels by estimated contribution to valuation/revenue today, then by near-term direction from outlook.

Hard rules:
- Do not introduce unsupported labels or synonyms.
- Do not rely on website taxonomies or third-party label sets.
- Do not copy labels from what you may have seen on websites; decide labels yourself based on the facts in the pillars/outlook.
- Do not perform web search in this final step.
- Output only the \`labels\` field (no extra text).

Allowed label taxonomy (sector -> industries; must choose only from these industries):
{allowed_labels_by_sector}`;

const LABEL_QUERY =
	"Ticker: {ticker}\nCompany pillars: {pillars}\nOutlook: {outlook}\nAssign final labels.";

function fillPrompt(
	template: string,
	values: Record<string, string | number>,
): string {
	return template.replace(/\{([a-z_]+)\}/gi, (match, key) =>
		key in values ? String(values[key]) : match,
	);
}

function normalizeLabels(labels: string[]): string[] {
	const orderedUniqueLabels = [...new Set(labels)];
	return orderedUniqueLabels
		.filter((label) => INDUSTRY_LABEL_SET.has(label))
		.slice(0, MAX_LABELS);
}

function buildLabelSystemPrompt(): string {
	const allowedLabelsBySector = INDUSTRY_LABELS_BY_SECTOR.map(
		([sector, industryLabels]) => `- ${sector}: ${industryLabels.join(", ")}`,
	).join("\n");
	return fillPrompt(LABEL_SYSTEM_PROMPT_TEMPLATE, {
		max_labels: MAX_LABELS,
		allowed_labels_by_sector: allowedLabelsBySector,
	});
}

async function pillarNode(state: LabelGraphState) {
	const pillarsAgent = new ExaAnswerAgent(PILLARS_SYSTEM_PROMPT, PillarsSchema);
	const pillars = await pillarsAgent.invoke(state.ticker);
	return { pillars };
}

async function outlookNode(state: LabelGraphState) {
	const outlookAgent = new ExaAnswerAgent(OUTLOOK_SYSTEM_PROMPT, OutlookSchema);
	const outlook = await outlookAgent.invoke(
		fillPrompt(OUTLOOK_QUERY, {
			ticker: state.ticker,
			pillars: JSON.stringify(state.pillars),
		}),
	);
	return { outlook };
}

async function labelNode(state: LabelGraphState) {
	const labelModel = ChatOpenAI({
		model: ModelConfig.qualityOrFast(),
		temperature: 0.1,
		reasoningEffort: "medium",
	}).withStructuredOutput(TickerLabelsSchema);
	const rawResult = await labelModel.invoke(
		`${buildLabelSystemPrompt()}\n\n${fillPrompt(LABEL_QUERY, {
			ticker: state.ticker,
			pillars: JSON.stringify(state.pillars),
			outlook: JSON.stringify(state.outlook),
		})}`,
	);

	const rawLabels = rawResult.labels ?? [];
	const normalized = normalizeLabels(rawLabels);
	if (normalized.length === 0) {
		throw new Error(
			`Could not normalize labels into INDUSTRY_LABELS: ${rawLabels.join(", ")}`,
		);
	}

	return {
		labels: TickerLabelsSchema.parse({
			labels: normalized,
		}),
	};
}

function buildLabelGraph() {
	return new StateGraph(labelGraphState)
		.addNode("pillars", pillarNode)
		.addNode("outlook", outlookNode)
		.addNode("labels", labelNode)
		.addEdge(START, "pillars")
		.addEdge("pillars", "outlook")
		.addEdge("outlook", "labels")
		.addEdge("labels", END)
		.compile();
}

function runLabelerSync<T>(command: string, payload: unknown): T {
	const workerUrl = new URL("./labeler-sync-worker.ts", import.meta.url);
	const workerPath = fileURLToPath(workerUrl);
	const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));
	const tsxBinaryName = process.platform === "win32" ? "tsx.cmd" : "tsx";
	const tsxBinaryPath = path.join(repoRoot, "node_modules", ".bin", tsxBinaryName);
	const spawnCommand =
		process.execArgv.length > 0
			? process.execPath
			: existsSync(tsxBinaryPath)
				? tsxBinaryPath
				: process.execPath;
	const spawnArgs =
		process.execArgv.length > 0
			? [...process.execArgv, workerPath, command, JSON.stringify(payload)]
			: existsSync(tsxBinaryPath)
				? [workerPath, command, JSON.stringify(payload)]
				: [
						"--import",
						"tsx",
						workerPath,
						command,
						JSON.stringify(payload),
					];
	const result = spawnSync(spawnCommand, spawnArgs, {
		cwd: repoRoot,
		encoding: "utf8",
	});

	if (result.error) {
		throw result.error;
	}
	if (result.status !== 0) {
		const message = result.stderr.trim() || result.stdout.trim() || "Labeler sync worker failed";
		throw new Error(message);
	}

	return JSON.parse(result.stdout) as T;
}

/** Fetch labels for one ticker asynchronously. */
export async function agetLabel(ticker: string): Promise<TickerLabels> {
	const tickerSymbol = normalizeTickerSymbol(ticker);
	if (!tickerSymbol) {
		throw new Error("ticker cannot be empty");
	}

	const graph = buildLabelGraph();
	const response = await graph.invoke({
		ticker: tickerSymbol,
		pillars: null,
		outlook: null,
		labels: null,
	});
	if (!response.labels) {
		throw new Error("Label graph did not produce labels");
	}
	return response.labels;
}

/** Fetch labels for multiple tickers asynchronously. */
export async function agetLabels(
	tickers: string[],
	{ maxConcurrency = 4 }: { maxConcurrency?: number } = {},
): Promise<Record<string, TickerLabels>> {
	const normalizedTickers = [
		...new Set(tickers.map((ticker) => normalizeTickerSymbol(ticker)).filter(Boolean)),
	];
	if (normalizedTickers.length === 0) {
		return {};
	}

	const batchSize = Math.max(1, maxConcurrency);
	const results: Record<string, TickerLabels> = {};
	for (let index = 0; index < normalizedTickers.length; index += batchSize) {
		const batch = normalizedTickers.slice(index, index + batchSize);
		const batchResults = await Promise.all(
			batch.map(async (tickerSymbol) => {
				try {
					return [tickerSymbol, await agetLabel(tickerSymbol)] as const;
				} catch {
					return [tickerSymbol, null] as const;
				}
			}),
		);
		for (const [tickerSymbol, labels] of batchResults) {
			if (labels) {
				results[tickerSymbol] = labels;
			}
		}
	}

	return results;
}

/** Fetch labels for one ticker. */
export function getLabel(ticker: string): TickerLabels {
	return runLabelerSync<TickerLabels>("get-label", { ticker });
}

/** Fetch labels for multiple tickers. */
export function getLabels(
	tickers: string[],
	options: { maxConcurrency?: number } = {},
): Record<string, TickerLabels> {
	return runLabelerSync<Record<string, TickerLabels>>("get-labels", {
		tickers,
		maxConcurrency: options.maxConcurrency ?? 4,
	});
}
