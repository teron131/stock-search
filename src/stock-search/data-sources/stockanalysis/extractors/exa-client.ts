/** Owns Exa Contents loading rules for StockAnalysis extractor modules. */

import { ExaAnswerAgent, ExaLoadAgent } from "llm-harness-js/agents";
import type { z, ZodType } from "zod";

export const DEFAULT_CONTENT_OPTIONS = {
  maxCharacters: 20_000,
  maxAgeHours: 0,
  filterEmptyResults: false,
};

const STOCKANALYSIS_SYSTEM_PROMPT = [
  "You extract structured data only from the supplied StockAnalysis page contents fetched through Exa Contents.",
  "Do not search, use memory, infer updated facts, or merge in outside values.",
  "Return null for fields absent from the supplied contents.",
  "Preserve displayed table row order.",
  "Use percentage fields as displayed percentage-point numbers, not fractions.",
].join(" ");

export async function loadStockAnalysisPage<T extends ZodType>({
  urls,
  outputSchema,
  instruction,
  maxCharacters = DEFAULT_CONTENT_OPTIONS.maxCharacters,
}: {
  urls: string | string[];
  outputSchema: T;
  instruction: string;
  maxCharacters?: number;
}): Promise<z.output<T>> {
  const agent = new ExaLoadAgent<T>({
    outputSchema,
    contentOptions: {
      ...DEFAULT_CONTENT_OPTIONS,
      maxCharacters,
    },
    systemPrompt: STOCKANALYSIS_SYSTEM_PROMPT,
  });
  return (await agent.invoke(urls, instruction)) as z.output<T>;
}

export async function loadStockAnalysisPageOrDefault<T extends ZodType>({
  urls,
  outputSchema,
  instruction,
  defaultValue,
  maxCharacters,
}: {
  urls: string | string[];
  outputSchema: T;
  instruction: string;
  defaultValue: z.output<T>;
  maxCharacters?: number;
}): Promise<z.output<T>> {
  try {
    return await loadStockAnalysisPage({
      urls,
      outputSchema,
      instruction,
      maxCharacters,
    });
  } catch {
    return defaultValue;
  }
}

export async function loadStockAnalysisText(
  url: string,
  maxCharacters = DEFAULT_CONTENT_OPTIONS.maxCharacters,
): Promise<string | null> {
  try {
    const agent = new ExaLoadAgent({
      contentOptions: {
        ...DEFAULT_CONTENT_OPTIONS,
        maxCharacters,
      },
    });
    const { pages } = await agent.load(url);
    return pages[0]?.text ?? null;
  } catch {
    return null;
  }
}

export async function answerWithExaOrDefault<T extends ZodType>({
  query,
  outputSchema,
  systemPrompt,
  defaultValue,
}: {
  query: string;
  outputSchema: T;
  systemPrompt: string;
  defaultValue: z.output<T>;
}): Promise<z.output<T>> {
  try {
    return await new ExaAnswerAgent(systemPrompt, outputSchema).invoke(query);
  } catch {
    return defaultValue;
  }
}
