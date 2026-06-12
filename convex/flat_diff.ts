type GenericRow = Record<string, unknown>;
type TimestampedRow = GenericRow & { updatedAt: number };

function stableValue(value: unknown): unknown {
	if (Array.isArray(value)) {
		return value.map(stableValue);
	}
	if (typeof value !== "object" || value === null) {
		return value;
	}
	const row = value as GenericRow;
	return Object.fromEntries(
		Object.keys(row)
			.sort()
			.map((key) => [key, stableValue(row[key])]),
	);
}

export function stableJsonStringify(value: unknown): string {
	return JSON.stringify(stableValue(value));
}

function valuesEqual(left: unknown, right: unknown): boolean {
	return stableJsonStringify(left) === stableJsonStringify(right);
}

export function changedFields<T extends TimestampedRow>(
	existing: GenericRow,
	payload: T,
): Partial<T> | null {
	const patch: GenericRow = {};
	for (const [key, value] of Object.entries(payload)) {
		if (key === "updatedAt") {
			continue;
		}
		if (!valuesEqual(existing[key], value)) {
			patch[key] = value;
		}
	}
	if (Object.keys(patch).length === 0) {
		return null;
	}
	patch.updatedAt = payload.updatedAt;
	return patch as Partial<T>;
}
