/** Child-process entrypoint that lets synchronous labeler wrappers call async graph code. */

import { agetLabel, agetLabels } from "./labeler.js";

async function main(): Promise<void> {
  const [command, rawPayload = "{}"] = process.argv.slice(2);
  const payload = JSON.parse(rawPayload) as {
    ticker?: string;
    tickers?: string[];
    maxConcurrency?: number;
  };

  if (command === "get-label") {
    const result = await agetLabel(payload.ticker ?? "");
    process.stdout.write(JSON.stringify(result));
    return;
  }

  if (command === "get-labels") {
    const result = await agetLabels(payload.tickers ?? [], {
      maxConcurrency: payload.maxConcurrency ?? 4,
    });
    process.stdout.write(JSON.stringify(result));
    return;
  }

  throw new Error(`Unsupported labeler sync command: ${command}`);
}

void main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(message);
  process.exitCode = 1;
});
