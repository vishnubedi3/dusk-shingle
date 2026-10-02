import { migrateForum } from './migrate.js';
import { schemaSql } from './schema.js';

export type Row = Record<string, unknown>;

/** Minimal database interface so the same handlers run on pg (production) and PGlite (dev/tests). */
export interface Db {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  /** Run `fn` inside a transaction. */
  transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>;
}

/** Create anything missing, then bring an existing database up to the current model. */
export async function applySchema(db: Db): Promise<void> {
  // Line comments are stripped before splitting: this runs on every cold start,
  // and a semicolon inside a comment would otherwise be parsed as a statement
  // boundary and take the whole schema down with it. No literal in schemaSql
  // contains "--", so this cannot cut a string in half.
  const statements = schemaSql
    .replace(/--[^\n]*/g, '')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);
  for (const statement of statements) {
    await db.query(statement);
  }
  await migrateForum(db);
}

let productionDb: Promise<Db> | undefined;

/** Resolve the configured production database, or undefined when none is configured. */
export function getProductionDb(): Promise<Db> | undefined {
  const url = process.env.DATABASE_URL ?? process.env.POSTGRES_URL;
  if (!url) return undefined;
  productionDb ??= (async () => {
    const { default: pg } = await import('pg');
    const local = /localhost|127\.0\.0\.1/.test(url);
    const pool = new pg.Pool({
      connectionString: url,
      max: 3,
      ssl: local ? undefined : { rejectUnauthorized: false },
    });
    // Never let pg print connection strings or query parameters.
    pool.on('error', () => undefined);
    const db: Db = {
      query: async (sql, params) => pool.query(sql, params as unknown[]) as never,
      transaction: async (fn) => {
        const client = await pool.connect();
        try {
          await client.query('BEGIN');
          const tx: Db = {
            query: async (sql, params) => client.query(sql, params as unknown[]) as never,
            transaction: (inner) => inner(tx),
          };
          const result = await fn(tx);
          await client.query('COMMIT');
          return result;
        } catch (error) {
          await client.query('ROLLBACK').catch(() => undefined);
          throw error;
        } finally {
          client.release();
        }
      },
    };
    await applySchema(db);
    return db;
  })().catch((error) => {
    productionDb = undefined;
    throw error;
  });
  return productionDb;
}
