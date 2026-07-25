/** Owns tolerant JSON reads and atomic-ish JSON writes for file-backed stores. */

import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

/** Missing or invalid JSON files fall back to the caller-owned default. */
export async function loadJson<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const payload = await readFile(filePath, "utf8");
    return JSON.parse(payload) as T;
  } catch {
    return defaultValue;
  }
}

/** Temp-file writes avoid leaving partially written JSON at the target path. */
export async function writeJson(
  filePath: string,
  data: unknown,
  { indent = 2 }: { indent?: number } = {},
): Promise<void> {
  const parentDir = path.dirname(filePath);
  const tempDir = await mkdtemp(path.join(parentDir, ".tmp-"));
  const tempPath = path.join(tempDir, path.basename(filePath));

  try {
    await writeFile(tempPath, JSON.stringify(data, null, indent), "utf8");
    await rename(tempPath, filePath);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}
