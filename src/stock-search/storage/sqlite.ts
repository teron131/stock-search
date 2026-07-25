/** Execute the shared SQL store against the local node:sqlite database. */

import { mkdirSync } from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";

import { type SqlStatement, SqlStore, type SqlValue } from "./sql-store.js";

export class SQLiteStore extends SqlStore {
  private readonly database: DatabaseSync;

  constructor(dbPath: string) {
    super("sqlite");
    mkdirSync(path.dirname(dbPath), { recursive: true });
    this.database = new DatabaseSync(dbPath);
    this.database.exec("PRAGMA journal_mode=WAL");
    this.ensureLocalSchema();
  }

  protected async ready(): Promise<void> {}

  protected async query(
    sql: string,
    params: SqlValue[] = [],
  ): Promise<Array<Record<string, unknown>>> {
    return this.database.prepare(sql).all(...params) as Array<Record<string, unknown>>;
  }

  protected async execute(sql: string, params: SqlValue[] = []): Promise<void> {
    this.database.prepare(sql).run(...params);
  }

  protected async batch(statements: SqlStatement[]): Promise<void> {
    this.runTransaction(() => {
      for (const statement of statements) {
        if (statement.sql.trim()) {
          this.database.prepare(statement.sql).run(...(statement.params ?? []));
        }
      }
    });
  }

  private ensureLocalSchema(): void {
    for (const statement of this.schemaStatements()) {
      this.database.exec(statement.sql);
    }
  }

  private runTransaction(work: () => void): void {
    this.database.exec("BEGIN");
    try {
      work();
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }
}
