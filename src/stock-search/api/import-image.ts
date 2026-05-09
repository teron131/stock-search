import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatOpenAI, MediaMessage } from "llm-harness-js/clients";
import { z } from "zod";
import { savePortfolioPositionsAndForgetRemoved } from "../portfolio.js";
import { normalizeTicker } from "../utils.js";
import type { BackendStore, PositionRow } from "./data-store.js";

const PortfolioImageExtractionSchema = z
	.object({
		holdings: z.array(
			z.object({
				ticker: z
					.string()
					.describe("Uppercase stock ticker symbol read from the image."),
				quantity: z
					.number()
					.describe("Numeric share quantity read from the same holding row."),
			}),
		),
	})
	.describe(
		"[STRUCTURED OUTPUTS] Portfolio holdings extracted from an uploaded image.",
	);

async function extractPortfolioImage(
	file: File,
	modelOverride: string | null,
): Promise<z.infer<typeof PortfolioImageExtractionSchema>> {
	const model =
		modelOverride || process.env.QUALITY_LLM || process.env.FAST_LLM;
	if (!model) {
		throw new Error("No model configured for image extraction.");
	}

	const fileBytes = Buffer.from(await file.arrayBuffer());
	const suffix = path.extname(file.name || "") || ".png";
	const tempPath = path.join(
		tmpdir(),
		`stock-search-import-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`,
	);
	await writeFile(tempPath, fileBytes);

	try {
		const mediaMessage = await MediaMessage.fromPathAsync({
			paths: tempPath,
			description:
				"Read this portfolio image and extract holdings. Keep ticker uppercase. Quantity must be numeric. Skip rows if ticker or quantity is unreadable. Return only holdings.",
		});
		const response = await ChatOpenAI({
			model,
			temperature: 0,
			reasoningEffort: "low",
		})
			.withStructuredOutput(PortfolioImageExtractionSchema)
			.invoke([
				{
					role: "user",
					content: mediaMessage.content as never,
				},
			]);
		return PortfolioImageExtractionSchema.parse(response);
	} catch {
		throw new Error("Failed to extract holdings from image.");
	} finally {
		await unlink(tempPath).catch(() => undefined);
	}
}

export async function importPortfolioImage(
	store: BackendStore,
	{
		file,
		replace,
		strategy,
		model,
	}: {
		file: File;
		replace: boolean;
		strategy: string | null;
		model: string | null;
	},
): Promise<{
	status: string;
	applied_count: number;
	applied: Array<{ ticker: string; quantity: number }>;
	replace: boolean;
}> {
	if (!file.name) {
		throw new Error("Image filename is required.");
	}
	if (file.type && !file.type.startsWith("image/")) {
		throw new Error("Uploaded file must be an image.");
	}
	if (file.size <= 0) {
		throw new Error("Uploaded image is empty.");
	}

	const previousPositionsPromise = store.loadPositions();
	const positionsPromise: Promise<PositionRow[]> = replace
		? Promise.resolve([])
		: previousPositionsPromise;
	const [extraction, positions, previousPositions] = await Promise.all([
		extractPortfolioImage(file, model),
		positionsPromise,
		previousPositionsPromise,
	]);
	const previousTickers = previousPositions
		.map((position) => normalizeTicker(position.ticker))
		.filter(Boolean);
	const positionIndex = new Map<string, number>();
	for (const [index, position] of positions.entries()) {
		const ticker = normalizeTicker(position.ticker);
		if (ticker) {
			positionIndex.set(ticker, index);
		}
	}

	const applied: Array<{ ticker: string; quantity: number }> = [];
	for (const holding of extraction.holdings) {
		const ticker = normalizeTicker(holding.ticker);
		const quantity = Number(holding.quantity);
		if (!ticker || quantity <= 0) {
			continue;
		}

		const payload: PositionRow = { ticker, quantity };
		if (strategy) {
			payload.strategy = strategy;
		}

		const existingIndex = positionIndex.get(ticker);
		if (existingIndex !== undefined) {
			const existing: PositionRow = {
				...positions[existingIndex],
				quantity,
			};
			if (strategy) {
				existing.strategy = strategy;
			}
			positions[existingIndex] = existing;
		} else {
			positionIndex.set(ticker, positions.length);
			positions.push(payload);
		}
		applied.push({ ticker, quantity });
	}

	await savePortfolioPositionsAndForgetRemoved(
		store,
		positions,
		previousTickers,
	);
	return {
		status: "ok",
		applied_count: applied.length,
		applied,
		replace,
	};
}
