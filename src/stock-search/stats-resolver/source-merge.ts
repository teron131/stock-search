/** Policy-driven construction of canonical fields from provider snapshots. */

import { asNumber } from "../utils.js";

export type SourceSnapshot = {
  source: string;
  fields: Record<string, unknown>;
};

export type SourceMergeMode = "first" | "mean";

export type SourceFieldPolicy = {
  field: string;
  mode: SourceMergeMode;
  sources: string[];
  fallbackSources?: string[];
};

export type SourceFieldPolicyGroup = {
  fields: Iterable<string>;
  mode: SourceMergeMode;
  sources: string[];
  fallbackSources?: string[];
};

export type SourceMergeInput = {
  fields: Iterable<string>;
  sources: SourceSnapshot[];
  policies?: SourceFieldPolicy[];
  defaultSources?: string[];
};

export const SOURCE_CACHE = "cache";
export const SOURCE_FINVIZ = "finviz";
export const SOURCE_STOCKANALYSIS = "stockanalysis";
export const SOURCE_YAHOO = "yahoo";

export const SAME_DEFINITION_BLEND_FIELDS = new Set([
  "market_cap",
  "pe",
  "ps",
  "beta",
  "roe",
  "roic",
  "gross_margin",
  "operating_margin",
  "debt_to_equity",
  "rsi",
  "revenue_growth",
  "eps_growth",
]);

function firstValue(
  field: string,
  sourceNames: string[],
  fieldsBySource: Map<string, Record<string, unknown>>,
): unknown {
  for (const sourceName of sourceNames) {
    const value = fieldsBySource.get(sourceName)?.[field];
    if (value !== null && value !== undefined) {
      return value;
    }
  }
  return null;
}

function meanValue(
  field: string,
  sourceNames: string[],
  fieldsBySource: Map<string, Record<string, unknown>>,
): number | null {
  const values = sourceNames
    .map((sourceName) => asNumber(fieldsBySource.get(sourceName)?.[field]))
    .filter((value) => value != null);
  if (values.length === 0) {
    return null;
  }
  const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
  return Number(mean.toFixed(6));
}

/** Expand grouped field policies into one policy per field, preserving first-match precedence. */
export function sourceFieldPolicies(...groups: SourceFieldPolicyGroup[]): SourceFieldPolicy[] {
  return groups.flatMap((group) =>
    Array.from(group.fields, (field) => ({
      field,
      mode: group.mode,
      sources: group.sources,
      fallbackSources: group.fallbackSources,
    })),
  );
}

/** Merge provider snapshots into canonical fields using reusable field policies. */
export function mergeSourceFields(input: SourceMergeInput): Record<string, unknown> {
  const fieldsBySource = new Map(
    input.sources.map((snapshot) => [snapshot.source, snapshot.fields]),
  );
  const defaultSources = input.defaultSources ?? input.sources.map((snapshot) => snapshot.source);
  const policyByField = new Map<string, SourceFieldPolicy>();
  for (const policy of input.policies ?? []) {
    if (!policyByField.has(policy.field)) {
      policyByField.set(policy.field, policy);
    }
  }
  const output: Record<string, unknown> = {};

  for (const field of input.fields) {
    const policy = policyByField.get(field);
    if (policy?.mode === "mean") {
      output[field] =
        meanValue(field, policy.sources, fieldsBySource) ??
        firstValue(field, policy.fallbackSources ?? [], fieldsBySource);
      continue;
    }

    output[field] = firstValue(field, policy?.sources ?? defaultSources, fieldsBySource);
  }

  return output;
}
