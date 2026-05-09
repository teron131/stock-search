import { unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChatOpenAI, MediaMessage } from "llm-harness-js/clients";
import { z } from "zod";
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

type PortfolioImageExtraction = z.infer<typeof PortfolioImageExtractionSchema>;
type ImportedHolding = { ticker: string; quantity: number };

type ImageImportOptions = {
	file: File;
	strategy: string | null;
	model: string | null;
};

type ImageImportResult = {
	status: string;
	applied_count: number;
	applied: ImportedHolding[];
};

function validatePortfolioImageFile(file: File): void {
	if (!file.name) {
		throw new Error("Image filename is required.");
	}
	if (file.type && !file.type.startsWith("image/")) {
		throw new Error("Uploaded file must be an image.");
	}
	if (file.size <= 0) {
		throw new Error("Uploaded image is empty.");
	}
}

function mergeExtractedHoldings(
	positions: PositionRow[],
	holdings: PortfolioImageExtraction["holdings"],
	strategy: string | null,
): { positions: PositionRow[]; applied: ImportedHolding[] } {
	const nextPositions = [...positions];
	const positionIndex = new Map<string, number>();
	for (const [index, position] of nextPositions.entries()) {
		const ticker = normalizeTicker(position.ticker);
		if (ticker) {
			positionIndex.set(ticker, index);
		}
	}

	const applied: ImportedHolding[] = [];
	for (const holding of holdings) {
		const ticker = normalizeTicker(holding.ticker);
		const quantity = Number(holding.quantity);
		if (!ticker || quantity <= 0) {
			continue;
		}

		const existingIndex = positionIndex.get(ticker);
		if (existingIndex !== undefined) {
			nextPositions[existingIndex] = {
				...nextPositions[existingIndex],
				quantity,
				...(strategy ? { strategy } : {}),
			};
		} else {
			positionIndex.set(ticker, nextPositions.length);
			nextPositions.push({
				ticker,
				quantity,
				...(strategy ? { strategy } : {}),
			});
		}
		applied.push({ ticker, quantity });
	}

	return { positions: nextPositions, applied };
}

async function extractPortfolioImage(
	file: File,
	modelOverride: string | null,
): Promise<PortfolioImageExtraction> {
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
	{ file, strategy, model }: ImageImportOptions,
): Promise<ImageImportResult> {
	validatePortfolioImageFile(file);

	const [extraction, positions] = await Promise.all([
		extractPortfolioImage(file, model),
		store.loadPositions(),
	]);
	const merged = mergeExtractedHoldings(
		positions,
		extraction.holdings,
		strategy,
	);

	await store.savePositions(merged.positions);
	return {
		status: "ok",
		applied_count: merged.applied.length,
		applied: merged.applied,
	};
}
