import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { Pool } from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";
import * as path from "path";
import * as schema from "../../src/db/schema";
import { normalizeSslMode } from "../../src/db/utils";

/**
 * The migration SQL and src/db/schema.ts must describe the same tables.
 *
 * Nothing else in this repo checks that. CI builds its test database with
 * `drizzle-kit push --force` straight from schema.ts, and the unit tests mock the
 * DB, so a column declared in schema.ts but never added by a migration passes every
 * gate and then fails in production on the first insert that names it. That is
 * exactly what happened to postmark_messages.payer: migration 0016 added the column
 * to the bronze table only, and every send after v0.32.3 died on
 * `column "payer" of relation "postmark_messages" does not exist` — after Postmark
 * had already delivered the mail.
 *
 * This test replays the real migration folder into a throwaway Postgres schema and
 * compares the resulting columns against what schema.ts declares, table by table.
 * It needs a real database, which is the point: a mock cannot see this class of drift.
 */

const DRIFT_DATABASE = "postmark_migration_drift";
const MIGRATIONS_FOLDER = path.resolve(__dirname, "../../drizzle");

type ActualColumn = { name: string; nullable: boolean; hasDefault: boolean };

let adminPool: Pool;
let driftPool: Pool;
let actualByTable: Map<string, Map<string, ActualColumn>>;

const declaredTables = Object.values(schema).filter((t): t is PgTable => is(t, PgTable));

/** Same server, same credentials, a throwaway database. */
function withDatabase(connectionString: string, database: string): string {
  const url = new URL(connectionString);
  url.pathname = `/${database}`;
  return url.toString();
}

beforeAll(async () => {
  const connectionString = normalizeSslMode(process.env.POSTMARK_SERVICE_DATABASE_URL!);

  // A whole database rather than a schema: migration 0000 writes a foreign key that
  // names "public"."tasks" explicitly, so a search_path pointing elsewhere cannot
  // hold the replay. Dropping and recreating the database keeps it off the test one.
  adminPool = new Pool({ connectionString, connectionTimeoutMillis: 15_000 });
  await adminPool.query(`DROP DATABASE IF EXISTS "${DRIFT_DATABASE}"`);
  await adminPool.query(`CREATE DATABASE "${DRIFT_DATABASE}"`);

  driftPool = new Pool({
    connectionString: withDatabase(connectionString, DRIFT_DATABASE),
    connectionTimeoutMillis: 15_000,
  });
  await migrate(drizzle(driftPool), { migrationsFolder: MIGRATIONS_FOLDER });

  const { rows } = await driftPool.query<{
    table_name: string;
    column_name: string;
    is_nullable: string;
    column_default: string | null;
  }>(
    `SELECT table_name, column_name, is_nullable, column_default
       FROM information_schema.columns
      WHERE table_schema = 'public'`
  );

  actualByTable = new Map();
  for (const row of rows) {
    if (!actualByTable.has(row.table_name)) actualByTable.set(row.table_name, new Map());
    actualByTable.get(row.table_name)!.set(row.column_name, {
      name: row.column_name,
      nullable: row.is_nullable === "YES",
      hasDefault: row.column_default !== null,
    });
  }
}, 120_000);

afterAll(async () => {
  await driftPool?.end();
  if (adminPool) {
    await adminPool.query(`DROP DATABASE IF EXISTS "${DRIFT_DATABASE}"`);
    await adminPool.end();
  }
});

describe("migrations match src/db/schema.ts", () => {
  it("replays every migration in drizzle/ without error", () => {
    expect(actualByTable.size).toBeGreaterThan(0);
  });

  it("declares at least the tables this service reads and writes", () => {
    expect(declaredTables.length).toBeGreaterThan(0);
    for (const table of declaredTables) {
      expect(
        actualByTable.has(getTableName(table)),
        `Table "${getTableName(table)}" is declared in schema.ts but no migration creates it.`
      ).toBe(true);
    }
  });

  it("gives every declared column a migration that adds it", () => {
    const missing: string[] = [];
    for (const table of declaredTables) {
      const tableName = getTableName(table);
      const actual = actualByTable.get(tableName);
      if (!actual) continue; // reported by the table test above
      for (const column of Object.values(getTableColumns(table))) {
        if (!actual.has(column.name)) missing.push(`${tableName}.${column.name}`);
      }
    }
    expect(
      missing,
      `Declared in src/db/schema.ts but absent from the migrations — an insert naming ` +
        `these columns fails in production: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("agrees with the migrations on nullability and defaults", () => {
    const mismatched: string[] = [];
    for (const table of declaredTables) {
      const tableName = getTableName(table);
      const actual = actualByTable.get(tableName);
      if (!actual) continue;
      for (const column of Object.values(getTableColumns(table))) {
        const live = actual.get(column.name);
        if (!live) continue; // reported by the column test above
        if (column.notNull === live.nullable) {
          mismatched.push(
            `${tableName}.${column.name}: schema.ts says ${column.notNull ? "NOT NULL" : "nullable"}, ` +
              `migrations say ${live.nullable ? "nullable" : "NOT NULL"}`
          );
        }
        if (column.hasDefault && !live.hasDefault && !column.primary) {
          mismatched.push(`${tableName}.${column.name}: schema.ts has a default, the migrations do not`);
        }
      }
    }
    expect(mismatched, mismatched.join("\n")).toEqual([]);
  });
});
