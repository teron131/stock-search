export class ConvexApiError extends Error {}

export class ConvexHttpClient {
	private readonly headers: HeadersInit;

	constructor(
		private readonly baseUrl: string,
		deployKey: string,
		private readonly maxRetries = 2,
		private readonly requestTimeoutMs = 7_000,
	) {
		if (!baseUrl) {
			throw new Error("Missing CONVEX_URL for Convex data store.");
		}
		if (!deployKey) {
			throw new Error("Missing CONVEX_DEPLOY_KEY for Convex data store.");
		}
		this.headers = {
			"content-type": "application/json",
			authorization: `Convex ${deployKey}`,
		};
	}

	query<T = unknown>(path: string, args?: Record<string, unknown>): Promise<T> {
		return this.call<T>("query", path, args);
	}

	mutation<T = unknown>(
		path: string,
		args?: Record<string, unknown>,
	): Promise<T> {
		return this.call<T>("mutation", path, args);
	}

	private async call<T>(
		endpoint: "query" | "mutation",
		path: string,
		args?: Record<string, unknown>,
	): Promise<T> {
		let lastError: unknown;
		for (let attempt = 0; attempt <= this.maxRetries; attempt += 1) {
			try {
				const controller = new AbortController();
				const timeoutId = setTimeout(
					() => controller.abort(),
					this.requestTimeoutMs,
				);
				const response = await fetch(
					`${this.baseUrl.replace(/\/$/, "")}/api/${endpoint}`,
					{
						method: "POST",
						headers: this.headers,
						body: JSON.stringify({
							path,
							args: args ?? {},
							format: "json",
						}),
						signal: controller.signal,
					},
				).finally(() => {
					clearTimeout(timeoutId);
				});
				if (!response.ok) {
					throw new Error(`Convex HTTP ${response.status}`);
				}
				const payload = (await response.json()) as {
					status?: string;
					errorMessage?: string;
					value?: T;
				};
				if (payload.status !== "success") {
					throw new ConvexApiError(
						`Convex ${endpoint} failed for ${path}: ${payload.errorMessage ?? "Unknown Convex error"}`,
					);
				}
				return payload.value as T;
			} catch (error) {
				lastError = error;
				if (attempt >= this.maxRetries) {
					throw error;
				}
				await new Promise((resolve) =>
					setTimeout(resolve, 250 * (attempt + 1)),
				);
			}
		}

		throw lastError instanceof Error ? lastError : new Error("Convex request failed");
	}
}
