/** Owns low-level fetch, number parsing, and embedded-object extraction for providers. */

import { Script } from "node:vm";

export function toFiniteNumber(value: unknown): number | null {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

export function parseNumberText(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().replace(/[$,%]/g, "").replace(/,/g, "").replace(/^\+/, "");
  if (!normalized || normalized.toLowerCase() === "n/a") {
    return null;
  }
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

export function toPercent(value: number | null): number | null {
  if (value == null || !Number.isFinite(value)) {
    return null;
  }
  return Math.abs(value) <= 1.5 ? value * 100 : value;
}

/** Fetch plain text from a public provider URL. */
export async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0",
      },
    });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

/** Fetch JSON from a public provider URL. */
export async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "user-agent": "Mozilla/5.0",
      },
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

/** Extract one embedded object literal by field name from a page source. */
export function extractObjectLiteral(source: string, fieldName: string): string | null {
  const fieldIndex = source.indexOf(`${fieldName}:`);
  if (fieldIndex < 0) {
    return null;
  }

  const objectStart = source.indexOf("{", fieldIndex);
  if (objectStart < 0) {
    return null;
  }

  let depth = 0;
  let inSingleQuote = false;
  let inDoubleQuote = false;
  let escaped = false;

  for (let index = objectStart; index < source.length; index += 1) {
    const character = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (character === "\\") {
      escaped = true;
      continue;
    }
    if (!inDoubleQuote && character === "'") {
      inSingleQuote = !inSingleQuote;
      continue;
    }
    if (!inSingleQuote && character === '"') {
      inDoubleQuote = !inDoubleQuote;
      continue;
    }
    if (inSingleQuote || inDoubleQuote) {
      continue;
    }
    if (character === "{") {
      depth += 1;
      continue;
    }
    if (character === "}") {
      depth -= 1;
      if (depth === 0) {
        return source.slice(objectStart, index + 1);
      }
    }
  }

  return null;
}

/** Evaluate one trusted embedded object literal inside a sandboxed VM. */
export function evaluateObjectLiteral<T>(literal: string | null): T | null {
  if (!literal) {
    return null;
  }
  try {
    const script = new Script(`(${literal})`);
    return script.runInNewContext({}) as T;
  } catch {
    return null;
  }
}
