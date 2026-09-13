import { DatabaseSync } from 'node:sqlite';
import { SCHEMA_SQL, SCHEMA_VERSION } from './schema.ts';

/**
 * Open (or create) a tempo database file and make sure the schema exists.
 * Pass ':memory:' for a throwaway database (used by tests).
 */
export function openDatabase(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(SCHEMA_SQL);

  const row = db.prepare(`SELECT v FROM meta WHERE k = 'schema_version'`).get() as
    | { v: string }
    | undefined;
  if (!row) {
    db.prepare(`INSERT INTO meta (k, v) VALUES ('schema_version', ?)`).run(String(SCHEMA_VERSION));
  } else if (Number(row.v) !== SCHEMA_VERSION) {
    // No migrations yet. When we add one, this is where it runs.
    throw new Error(
      `tempo: database schema is v${row.v} but this code expects v${SCHEMA_VERSION}`,
    );
  }
  return db;
}
