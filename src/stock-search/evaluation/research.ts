/** Run the research graph that produces evidence-backed analysis. */

import { writeFile } from "node:fs/promises";

import { HumanMessage } from "@langchain/core/messages";
import { type ToolRuntime, tool } from "@langchain/core/tools";
import {
	Annotation,
	END,
	InMemoryStore,
	START,
	StateGraph,
} from "@langchain/langgraph";
import { createAgent, todoListMiddleware } from "langchain";
import { WebLoaderAgent } from "llm-harness-js/agents";
import { ChatOpenAI } from "llm-harness-js/clients";
import { type ZodType, z } from "zod";

import { extractDomain } from "../utils.js";
import { ThresholdConfig } from "./constants.js";

const DEFAULT_ALLOWED_DOMAINS = ["example.com", "placeholder.org"] as const;
const RESEARCH_AGENT_PROMPT = `Research with web search to find reliable, recent sources.
Focus on concrete facts, numbers, and named entities. No meta-language. Exclude ads/boilerplate.
Return concise bullet points with sources.`;

const WEBLOADER_AGENT_PROMPT = `Loads and summarizes pages from approved domains.
Extract only facts that help score moat, quality, and outlook. No meta-language.
Return short bullet points with sources if available.`;

const VALIDATOR_AGENT_PROMPT = `Validates claims for factual support.
Flag statements that lack evidence or conflict with sources. Return a short checklist of issues or "ok".`;

const MAX_VALIDATION_RETRIES = 2;
const RESEARCH_STORE = new InMemoryStore();

const ValidationResultSchema = z.object({
	is_valid: z.boolean(),
	reasons: z.array(z.string()).default([]),
});

const researchGraphState = Annotation.Root({
	ticker: Annotation<string>,
	researchNotes: Annotation<string | null>,
	loadedNotes: Annotation<string | null>,
	validation: Annotation<z.infer<typeof ValidationResultSchema> | null>,
	attempts: Annotation<number>,
	plan: Annotation<string | null>,
	structuredResponse: Annotation<unknown | null>,
});

type ResearchGraphState = typeof researchGraphState.State;
type ResearchStore = {
	get(
		namespace: string[],
		key: string,
	): Promise<{ value?: { notes?: string } } | null>;
	put(
		namespace: string[],
		key: string,
		value: { notes: string },
	): Promise<void>;
};

function researchMemoryKey(ticker: string): string {
	return `research:${ticker.toUpperCase()}`;
}

function getAllowedDomains(): Set<string> {
	const env = process.env.RESEARCH_ALLOWED_DOMAINS ?? "";
	if (env.trim()) {
		return new Set(
			env
				.split(",")
				.map((item) => item.trim().toLowerCase())
				.filter(Boolean),
		);
	}
	return new Set(DEFAULT_ALLOWED_DOMAINS);
}

function isDomainAllowed(domain: string, allowed: Set<string>): boolean {
	const normalizedDomain = domain.toLowerCase();
	return [...allowed].some(
		(entry) =>
			normalizedDomain === entry || normalizedDomain.endsWith(`.${entry}`),
	);
}

function filterAllowedUrls(urls: Iterable<string>): string[] {
	const allowed = getAllowedDomains();
	return [...urls].filter((url) => {
		const domain = extractDomain(url);
		return domain ? isDomainAllowed(domain, allowed) : false;
	});
}

function extractUrls(text: string | null | undefined): string[] {
	if (!text) {
		return [];
	}
	return text.match(/https?:\/\/[^\s\])>,]+/g) ?? [];
}

function extractTodoItems(plan: string | null | undefined): string[] {
	if (!plan) {
		return [];
	}
	const items: string[] = [];
	for (const rawLine of plan.split("\n")) {
		let line = rawLine
			.trim()
			.replace(/^[-*]\s*/, "")
			.trim();
		if (!line) {
			continue;
		}
		if (
			line.toLowerCase().startsWith("todo:") ||
			line.toLowerCase().startsWith("plan:")
		) {
			line = line.split(":", 2).at(-1)?.trim() ?? "";
		}
		if (line) {
			items.push(line);
		}
	}
	return items;
}

function extractTicker(text: string | null | undefined): string | null {
	if (!text) {
		return null;
	}
	const candidate = text.trim();
	if (/^[A-Za-z0-9.-]{1,10}$/.test(candidate)) {
		return candidate.toUpperCase();
	}
	const match = text.match(/Ticker:\s*([A-Za-z0-9.-]+)/);
	return match?.[1]?.toUpperCase() ?? null;
}

function chunkList(values: string[], size: number): string[][] {
	if (size <= 0) {
		return [values];
	}
	const chunks: string[][] = [];
	for (let index = 0; index < values.length; index += size) {
		chunks.push(values.slice(index, index + size));
	}
	return chunks;
}

function stringifyMessageContent(content: unknown): string {
	if (typeof content === "string") {
		return content;
	}
	return JSON.stringify(content);
}

function lastMessageText(response: unknown): string {
	const messages =
		response &&
		typeof response === "object" &&
		Array.isArray((response as { messages?: unknown[] }).messages)
			? (response as { messages: unknown[] }).messages
			: [];
	const lastMessage = messages.at(-1) as { content?: unknown } | undefined;
	return stringifyMessageContent(lastMessage?.content ?? "");
}

function structuredResponseValue<T>(response: unknown): T | null {
	const structuredResponse =
		response && typeof response === "object"
			? (response as { structuredResponse?: T }).structuredResponse
			: undefined;
	return structuredResponse ?? null;
}

function createResearchAgents(systemPrompt: string, responseFormat: ZodType) {
	const qualityModel = process.env.QUALITY_LLM;
	const fastModel = process.env.FAST_LLM;
	if (!qualityModel || !fastModel) {
		throw new Error("No model configured. Set FAST_LLM and QUALITY_LLM.");
	}

	const loadResearchMemory = tool(
		async ({ ticker }: { ticker: string }, runtime: ToolRuntime) => {
			const key = researchMemoryKey(ticker);
			const store =
				(runtime.store as unknown as ResearchStore | null) ?? RESEARCH_STORE;
			const stored = await store.get(["research"], key);
			const value = stored?.value?.notes;
			return typeof value === "string" ? value : "";
		},
		{
			name: "load_research_memory",
			description: "Load cached research notes for a ticker.",
			schema: z.object({
				ticker: z.string(),
			}),
		},
	);

	const saveResearchMemory = tool(
		async (
			{ ticker, notes }: { ticker: string; notes: string },
			runtime: ToolRuntime,
		) => {
			const key = researchMemoryKey(ticker);
			const store =
				(runtime.store as unknown as ResearchStore | null) ?? RESEARCH_STORE;
			await store.put(["research"], key, { notes });
			return "saved";
		},
		{
			name: "save_research_memory",
			description: "Save research notes for a ticker.",
			schema: z.object({
				ticker: z.string(),
				notes: z.string(),
			}),
		},
	);

	const supervisor = createAgent({
		model: ChatOpenAI({
			model: qualityModel,
			temperature: 0,
			reasoningEffort: "medium",
		}),
		tools: [loadResearchMemory, saveResearchMemory],
		systemPrompt,
		responseFormat,
		middleware: [todoListMiddleware()],
		store: RESEARCH_STORE,
	});

	const searcher = createAgent({
		model: ChatOpenAI({
			model: qualityModel,
			temperature: 0,
			reasoningEffort: "medium",
			webSearch: true,
			webSearchMaxResults: ThresholdConfig.WEB_SEARCH_MAX_RESULTS,
		}),
		tools: [loadResearchMemory],
		systemPrompt: RESEARCH_AGENT_PROMPT,
		store: RESEARCH_STORE,
	});

	const loader = new WebLoaderAgent({
		model: fastModel,
		temperature: 0,
		reasoningEffort: "low",
		systemPrompt: WEBLOADER_AGENT_PROMPT,
	});

	const validator = createAgent({
		model: ChatOpenAI({
			model: fastModel,
			temperature: 0,
			reasoningEffort: "medium",
		}),
		tools: [],
		systemPrompt: VALIDATOR_AGENT_PROMPT,
		responseFormat: ValidationResultSchema,
		store: RESEARCH_STORE,
	});

	return {
		supervisor,
		searcher,
		loader,
		validator,
	};
}

function buildResearchGraph(systemPrompt: string, responseFormat: ZodType) {
	const agents = createResearchAgents(systemPrompt, responseFormat);

	async function plannerNode(state: ResearchGraphState) {
		const prompt = `Create a short todo list for researching this ticker. Do not answer the task.\nTicker: ${state.ticker}`;
		const response = await agents.supervisor.invoke({
			messages: [new HumanMessage(prompt)],
		});
		return {
			plan: lastMessageText(response),
		};
	}

	async function fanoutNode(state: ResearchGraphState) {
		return {
			ticker: state.ticker,
			researchNotes: null,
			loadedNotes: null,
			validation: null,
		};
	}

	async function websearchNode(state: ResearchGraphState) {
		const ticker = state.ticker || extractTicker(state.ticker) || state.ticker;
		const queries = extractTodoItems(state.plan) || [state.ticker];
		const notes = (
			await Promise.all(
				queries.map(async (query) => {
					const prompt = `${query}\nSummarize with concrete facts, numbers, and named entities. No meta-language.\nReturn concise bullet points. Include a 'Sources:' list with URLs you used.`;
					const response = await agents.searcher.invoke({
						messages: [new HumanMessage(prompt)],
					});
					return lastMessageText(response);
				}),
			)
		).join("\n\n");

		return {
			ticker,
			researchNotes: notes,
		};
	}

	async function loaderNode(state: ResearchGraphState) {
		const urls = filterAllowedUrls(extractUrls(state.researchNotes));
		if (urls.length === 0) {
			return { loadedNotes: "" };
		}

		const urlBatches = chunkList(urls, 5);
		const loadedNotes = (
			await Promise.all(
				urlBatches.map((batch) =>
					agents.loader.invoke(`Load and summarize these URLs:\n${batch}`),
				),
			)
		).join("\n\n");
		return { loadedNotes };
	}

	async function validatorNode(state: ResearchGraphState) {
		const evidence = [state.researchNotes, state.loadedNotes]
			.filter(Boolean)
			.join("\n\n");
		const prompt = `Check the response for unsupported claims.\nIf everything is grounded, set is_valid=True. Otherwise set is_valid=False and list the reasons.\n\nNotes:\n${evidence}`;
		const response = await agents.validator.invoke({
			messages: [new HumanMessage(prompt)],
		});
		return {
			validation:
				structuredResponseValue<z.infer<typeof ValidationResultSchema>>(
					response,
				),
			attempts: state.attempts + 1,
		};
	}

	async function writerNode(state: ResearchGraphState) {
		const evidence = [state.researchNotes, state.loadedNotes]
			.filter(Boolean)
			.join("\n\n");
		const prompt = `${state.ticker}\n\nEvidence:\n${evidence}`;
		const response = await agents.supervisor.invoke({
			messages: [new HumanMessage(prompt)],
		});
		const result = structuredResponseValue<unknown>(response);
		if (state.ticker && result != null) {
			await RESEARCH_STORE.put(["research"], researchMemoryKey(state.ticker), {
				notes: JSON.stringify(result),
			});
		}
		return {
			structuredResponse: result,
		};
	}

	function routeFromValidator(state: ResearchGraphState) {
		if (state.validation?.is_valid) {
			return END;
		}
		if (state.attempts >= MAX_VALIDATION_RETRIES) {
			return END;
		}
		return "writer";
	}

	return new StateGraph(researchGraphState)
		.addNode("plan", plannerNode)
		.addNode("fanout", fanoutNode)
		.addNode("websearch", websearchNode)
		.addNode("loader", loaderNode)
		.addNode("validator", validatorNode)
		.addNode("writer", writerNode)
		.addEdge(START, "plan")
		.addEdge("plan", "fanout")
		.addEdge("fanout", "websearch")
		.addEdge("fanout", "loader")
		.addEdge("websearch", "writer")
		.addEdge("loader", "writer")
		.addEdge("writer", "validator")
		.addConditionalEdges("validator", routeFromValidator, {
			writer: "writer",
			[END]: END,
		})
		.compile();
}

/** Execute structured LLM search/analysis for a specific ticker. */
export async function runLlmEvaluation<T extends ZodType>(
	ticker: string,
	systemPrompt: string,
	responseFormat: T,
): Promise<import("zod").infer<T>> {
	const graph = buildResearchGraph(systemPrompt, responseFormat);
	const response = await graph.invoke({
		ticker,
		researchNotes: null,
		loadedNotes: null,
		validation: null,
		attempts: 0,
		plan: null,
		structuredResponse: null,
	});
	return response.structuredResponse as import("zod").infer<T>;
}

/** Render the research graph to a PNG file. */
export async function saveResearchGraphPng<T extends ZodType>(
	systemPrompt: string,
	responseFormat: T,
	path: string,
): Promise<string | null> {
	const graph = buildResearchGraph(systemPrompt, responseFormat);
	const pngBytes = await graph.getGraph().drawMermaidPng();
	await writeFile(path, Buffer.from(await pngBytes.arrayBuffer()));
	return path;
}
