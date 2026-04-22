/** Generic Exa-backed fallback helpers for StockAnalysis pages. */

import type { z, ZodType } from "zod";

type ExaAgentCtor = new <T extends ZodType>(
	systemPrompt: string,
	outputSchema: T,
) => {
	invoke(query: string): Promise<z.output<T>>;
};

async function loadExaAgent(): Promise<ExaAgentCtor> {
	const importer = new Function(
		"return import('../../../../../llm-harness-js/src/agents/index.js')",
	) as () => Promise<{ ExaAgent: ExaAgentCtor }>;
	const module = await importer();
	return module.ExaAgent;
}

/** Run a structured Exa search using a StockAnalysis-oriented prompt. */
export async function invokeStockanalysisSearch<T extends ZodType>({
	outputSchema,
	systemPromptTemplate,
	query,
	promptValues,
}: {
	outputSchema: T;
	systemPromptTemplate: string;
	query: string;
	promptValues: Record<string, string>;
}): Promise<z.output<T>> {
	const ExaAgent = await loadExaAgent();
	const agent = new ExaAgent(
		systemPromptTemplate.replace(
			/\{([^}]+)\}/g,
			(_match, key: string) => promptValues[key] ?? "",
		),
		outputSchema,
	);
	return agent.invoke(query);
}

/** Run a structured Exa search and return a default value on failure. */
export async function invokeStockanalysisSearchOrDefault<T extends ZodType>({
	outputSchema,
	systemPromptTemplate,
	query,
	promptValues,
	defaultFactory,
}: {
	outputSchema: T;
	systemPromptTemplate: string;
	query: string;
	promptValues: Record<string, string>;
	defaultFactory: () => z.output<T>;
}): Promise<z.output<T>> {
	try {
		return await invokeStockanalysisSearch({
			outputSchema,
			systemPromptTemplate,
			query,
			promptValues,
		});
	} catch {
		return defaultFactory();
	}
}
