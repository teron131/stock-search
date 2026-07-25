/** Execute the shared SQL store against Cloudflare D1 through the REST SQL API. */

import { type SqlStatement, SqlStore, type SqlValue } from "./sql-store.js";

type D1QueryResult = {
  success?: boolean;
  results?: Array<Record<string, unknown>>;
  meta?: Record<string, unknown>;
};
type D1ApiResponse = {
  success?: boolean;
  errors?: Array<{ message?: string; code?: number }>;
  result?: D1QueryResult[];
};
const BATCH_SIZE = 500;

export class D1Store extends SqlStore {
  private readonly endpoint: string;
  private readonly headers: HeadersInit;
  private schemaPromise: Promise<void> | null = null;

  constructor(accountId: string, databaseId: string, apiToken: string) {
    super("d1");
    if (!accountId) {
      throw new Error("Missing D1_ACCOUNT_ID for D1 data store.");
    }
    if (!databaseId) {
      throw new Error("Missing D1_DATABASE_ID for D1 data store.");
    }
    if (!apiToken) {
      throw new Error("Missing D1_API_TOKEN for D1 data store.");
    }
    this.endpoint = `https://api.cloudflare.com/client/v4/accounts/${accountId}/d1/database/${databaseId}/query`;
    this.headers = {
      authorization: `Bearer ${apiToken}`,
      "content-type": "application/json",
    };
  }

  protected ready(): Promise<void> {
    this.schemaPromise ??= this.batch(this.schemaStatements());
    return this.schemaPromise;
  }

  protected async query(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    const result = await this.request({ sql, params });
    return result.results ?? [];
  }

  protected async execute(sql: string, params: SqlValue[] = []): Promise<void> {
    await this.request({ sql, params });
  }

  protected async batch(statements: SqlStatement[]): Promise<void> {
    const compacted = statements.filter((statement) => statement.sql.trim());
    for (let index = 0; index < compacted.length; index += BATCH_SIZE) {
      const chunk = compacted.slice(index, index + BATCH_SIZE);
      await this.requestBatch(chunk);
    }
  }

  private async request(statement: SqlStatement): Promise<D1QueryResult> {
    const response = await this.call({
      sql: statement.sql,
      params: statement.params ?? [],
    });
    const result = response.result?.[0];
    if (!result?.success) {
      throw new Error("D1 query failed.");
    }
    return result;
  }

  private async requestBatch(statements: SqlStatement[]): Promise<void> {
    if (statements.length === 0) {
      return;
    }
    const response = await this.call({ batch: statements });
    const failed = response.result?.find((result) => !result.success);
    if (failed) {
      throw new Error("D1 batch query failed.");
    }
  }

  private async call(body: unknown): Promise<D1ApiResponse> {
    const response = await fetch(this.endpoint, {
      method: "POST",
      headers: this.headers,
      body: JSON.stringify(body),
    });
    const payload = (await response.json()) as D1ApiResponse;
    if (!response.ok || payload.success === false) {
      const message =
        payload.errors
          ?.map((error) => error.message)
          .filter(Boolean)
          .join("; ") || `D1 HTTP ${response.status}`;
      throw new Error(message);
    }
    return payload;
  }
}
