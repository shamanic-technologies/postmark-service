import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";

/**
 * Ensures drizzle migration files are committed and valid.
 * Prevents deploying without the migration folder, which causes
 * "Can't find meta/_journal.json" crashes at startup.
 */

const DRIZZLE_DIR = path.resolve(__dirname, "../../drizzle");
const META_DIR = path.join(DRIZZLE_DIR, "meta");
const JOURNAL_PATH = path.join(META_DIR, "_journal.json");

describe("drizzle migrations", () => {
  it("drizzle/ directory exists", () => {
    expect(fs.existsSync(DRIZZLE_DIR)).toBe(true);
  });

  it("meta/_journal.json exists", () => {
    expect(fs.existsSync(JOURNAL_PATH)).toBe(true);
  });

  it("_journal.json is valid JSON with entries", () => {
    const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8"));
    expect(journal).toHaveProperty("entries");
    expect(Array.isArray(journal.entries)).toBe(true);
    expect(journal.entries.length).toBeGreaterThan(0);
  });

  it("every journal entry has a matching .sql file", () => {
    const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8"));
    for (const entry of journal.entries) {
      const sqlFile = path.join(DRIZZLE_DIR, `${entry.tag}.sql`);
      expect(fs.existsSync(sqlFile), `Missing migration file: ${entry.tag}.sql`).toBe(true);
    }
  });

  it("every journal entry has a matching snapshot", () => {
    const journal = JSON.parse(fs.readFileSync(JOURNAL_PATH, "utf-8"));
    for (const entry of journal.entries) {
      const snapshotFile = path.join(META_DIR, `${entry.idx.toString().padStart(4, "0")}_snapshot.json`);
      expect(fs.existsSync(snapshotFile), `Missing snapshot: ${snapshotFile}`).toBe(true);
    }
  });
});
