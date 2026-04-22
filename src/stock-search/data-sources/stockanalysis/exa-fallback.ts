/** Generic Exa-backed fallback helpers for StockAnalysis pages. */

import { ExaAgent } from "llm-harness-js/agents";
import type { z, ZodType } from "zod";

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
