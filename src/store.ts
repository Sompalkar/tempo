/**
 * The tempo engine: remember, recall, conflicts, resolve.
 *
 * Read docs/DESIGN.md first. The comments here point back to its sections.
 */
import { randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { openDatabase } from './db.ts';
import type {
  Conflict,
  Fact,
  Observation,
  RecallInput,
  RecallResult,
  RememberInput,
  RememberResult,
} from './types.ts';

/** Make a string safe to put inside a LIKE pattern (with ESCAPE '\\'). */
function escapeLike(s: string): string {
  return s.replace(/[\\%_]/g, '\\$&');
}

// ---------------------------------------------------------------------------
// Row <-> object mapping
// ---------------------------------------------------------------------------

/** What a row from the observations table looks like coming out of SQLite. */
interface ObsRow {
  id: string;
  org: string;
  key: string;
  value: string;
  valid_from: number;
  valid_to: number | null;
  valid_from_explicit: number;
  recorded_at: number;
  closed_at: number | null;
  superseded_by: string | null;
  confirmations: number;
  writer: string;
  source_kind: string;
  source_ref: string | null;
}

interface ConflictRow {
  id: string;
  org: string;
  key: string;
  a_id: string;
  b_id: string;
  detected_at: number;
  status: 'open' | 'resolved';
  winner_id: string | null;
  reason: string | null;
  resolved_at: number | null;
}

function rowToObservation(r: ObsRow): Observation {
  const source: Observation['source'] = { writer: r.writer, kind: r.source_kind };
  if (r.source_ref !== null) source.ref = r.source_ref;
  return {
    id: r.id,
    org: r.org,
    key: r.key,
    value: r.value,
    validFrom: r.valid_from,
    validTo: r.valid_to,
    validFromExplicit: r.valid_from_explicit === 1,
    recordedAt: r.recorded_at,
    closedAt: r.closed_at,
    supersededBy: r.superseded_by,
    confirmations: r.confirmations,
    source,
  };
}

function rowToConflict(r: ConflictRow): Conflict {
  return {
    id: r.id,
    org: r.org,
    key: r.key,
    aId: r.a_id,
    bId: r.b_id,
    detectedAt: r.detected_at,
    status: r.status,
    winnerId: r.winner_id,
    reason: r.reason,
    resolvedAt: r.resolved_at,
  };
}

/** A remember() input after defaults have been filled in. */
interface Prepared {
  org: string;
  key: string;
  value: string;
  source: RememberInput['source'];
  validFrom: number;
  validFromExplicit: boolean;
  now: number;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

/**
 * What to do when two different writers disagree and neither said when
 * their fact became true.
 *
 * - 'conflict'     (default) keep both, flag them, let someone resolve it.
 * - 'prefer-newer' pick the more recently recorded one, but record that
 *                  this was a policy guess, not knowledge.
 */
export type UndatedDisagreementPolicy = 'conflict' | 'prefer-newer';

export interface TempoOptions {
  onUndatedDisagreement?: UndatedDisagreementPolicy;
}

export class TempoStore {
  private db: DatabaseSync;
  private policy: UndatedDisagreementPolicy;

  constructor(path: string = ':memory:', opts: TempoOptions = {}) {
    this.db = openDatabase(path);
    this.policy = opts.onUndatedDisagreement ?? 'conflict';
  }

  close(): void {
    this.db.close();
  }

  // -------------------------------------------------------------------------
  // remember  (DESIGN.md §4)
  // -------------------------------------------------------------------------

  remember(input: RememberInput): RememberResult {
    if (input.private) {
      return { action: 'skipped-private', id: null };
    }
    if (!input.org || !input.key || !input.value) {
      throw new Error('tempo.remember: org, key and value are required');
    }

    const now = input.now ?? Date.now();
    const validFromExplicit = input.validFrom !== undefined;
    const validFrom = input.validFrom ?? now;
    const validTo = input.validTo ?? null;

    if (validTo !== null && validTo <= validFrom) {
      throw new Error('tempo.remember: validTo must be after validFrom');
    }

    // Everything below must happen together or not at all.
    this.db.exec('BEGIN');
    try {
      const result = this.rememberInTx({
        org: input.org,
        key: input.key,
        value: input.value,
        source: input.source,
        validFrom,
        validTo,
        validFromExplicit,
        now,
      });
      this.db.exec('COMMIT');
      return result;
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  private rememberInTx(p: Prepared & { validTo: number | null }): RememberResult {
    // A fact that arrives already closed (validTo given) is pure history.
    // It cannot be "current", so it never competes with the current fact.
    if (p.validTo !== null) {
      const id = this.insertObservation(p, { validTo: p.validTo, closedAt: p.now });
      return { action: 'backfilled', id };
    }

    const current = this.currentFor(p.org, p.key);

    // Case 0: nothing to compare against.
    if (current.length === 0) {
      const id = this.insertObservation(p, { validTo: null, closedAt: null });
      return { action: 'inserted', id };
    }

    // Case 1: some current fact already says exactly this. Corroborate.
    const same = current.find((c) => c.value === p.value);
    if (same) {
      this.db
        .prepare(`UPDATE observations SET confirmations = confirmations + 1 WHERE id = ?`)
        .run(same.id);
      return { action: 'corroborated', id: same.id };
    }

    // From here on, every current fact has a *different* value.
    // We compare against the newest current fact (by valid_from). If several
    // are current (an open conflict), they all get the same treatment.
    const newest = current.reduce((a, b) => (b.validFrom > a.validFrom ? b : a));
    const anotherWriter = current.some((c) => c.source.writer !== p.source.writer);

    // Case 2: nobody gave a date, and it is a different writer.
    // A guessed time is not a reason to pick a winner (DESIGN.md §4).
    if (!p.validFromExplicit && !newest.validFromExplicit && anotherWriter) {
      if (this.policy === 'prefer-newer' && p.validFrom >= newest.validFrom) {
        const id = this.insertObservation(p, { validTo: null, closedAt: null });
        for (const c of current) this.supersede(c, id, p.validFrom, p.now, 'policy:prefer-newer-undated');
        return { action: 'superseded', id, otherId: newest.id };
      }
      return this.openConflict(p, newest);
    }

    // Case 3: the new fact is older history. Backfill, do not touch current.
    if (p.validFrom < newest.validFrom) {
      const id = this.insertObservation(p, { validTo: newest.validFrom, closedAt: p.now });
      return { action: 'backfilled', id };
    }

    // Case 4: the new fact is newer. The world changed. Supersede.
    if (p.validFrom > newest.validFrom) {
      const id = this.insertObservation(p, { validTo: null, closedAt: null });
      for (const c of current) this.supersede(c, id, p.validFrom, p.now, 'newer-valid-time');
      return { action: 'superseded', id, otherId: newest.id };
    }

    // Case 5: same valid_from. Same writer = self-correction.
    if (!anotherWriter) {
      const id = this.insertObservation(p, { validTo: null, closedAt: null });
      for (const c of current) this.supersede(c, id, p.validFrom, p.now, 'same-writer-correction');
      return { action: 'superseded', id, otherId: newest.id };
    }

    // Case 6: same valid_from, different writers, different values.
    // We do not know who is right. Keep both, open a conflict.
    return this.openConflict(p, newest);
  }

  /** Insert the new fact alongside the existing one and record that they disagree. */
  private openConflict(p: Prepared, other: Observation): RememberResult {
    const id = this.insertObservation(p, { validTo: null, closedAt: null });
    const conflictId = randomUUID();
    this.db
      .prepare(
        `INSERT INTO conflicts (id, org, key, a_id, b_id, detected_at, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`,
      )
      .run(conflictId, p.org, p.key, other.id, id, p.now);
    return { action: 'conflict', id, otherId: other.id, conflictId };
  }

  /** Close an old observation because a newer one replaced it. */
  private supersede(
    old: Observation,
    newId: string,
    validTo: number,
    now: number,
    reason: string,
  ): void {
    this.db
      .prepare(
        `UPDATE observations SET valid_to = ?, closed_at = ?, superseded_by = ? WHERE id = ?`,
      )
      .run(validTo, now, newId, old.id);
    // Any open conflict the old fact was part of is now moot: both sides
    // are being replaced by something newer. Close it and say why.
    this.db
      .prepare(
        `UPDATE conflicts SET status = 'resolved', winner_id = ?, reason = ?, resolved_at = ?
         WHERE status = 'open' AND (a_id = ? OR b_id = ?)`,
      )
      .run(newId, 'both-superseded:' + reason, now, old.id, old.id);
    // Record it as a resolved conflict so the trail is visible later.
    this.db
      .prepare(
        `INSERT INTO conflicts (id, org, key, a_id, b_id, detected_at, status, winner_id, reason, resolved_at)
         VALUES (?, ?, ?, ?, ?, ?, 'resolved', ?, ?, ?)`,
      )
      .run(randomUUID(), old.org, old.key, old.id, newId, now, newId, reason, now);
  }

  private insertObservation(
    p: Prepared,
    o: { validTo: number | null; closedAt: number | null },
  ): string {
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO observations
           (id, org, key, value, valid_from, valid_to, valid_from_explicit,
            recorded_at, closed_at, superseded_by, confirmations,
            writer, source_kind, source_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 1, ?, ?, ?)`,
      )
      .run(
        id,
        p.org,
        p.key,
        p.value,
        p.validFrom,
        o.validTo,
        p.validFromExplicit ? 1 : 0,
        p.now,
        o.closedAt,
        p.source.writer,
        p.source.kind,
        p.source.ref ?? null,
      );
    return id;
  }

  /** All observations for org+key that are still open (valid_to IS NULL). */
  private currentFor(org: string, key: string): Observation[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM observations WHERE org = ? AND key = ? AND valid_to IS NULL
         ORDER BY valid_from ASC, recorded_at ASC`,
      )
      .all(org, key) as unknown as ObsRow[];
    return rows.map(rowToObservation);
  }

  // -------------------------------------------------------------------------
  // recall  (DESIGN.md §5)
  // -------------------------------------------------------------------------

  recall(input: RecallInput): RecallResult {
    if (!input.org) throw new Error('tempo.recall: org is required');
    const now = Date.now();
    const validAt = input.validAt ?? now;
    const asOf = input.asOf ?? now;
    const limit = input.limit ?? 50;

    const where: string[] = ['org = ?', 'recorded_at <= ?'];
    const args: (string | number)[] = [input.org, asOf];

    if (input.key !== undefined) {
      if (input.key.endsWith('.')) {
        where.push(`key LIKE ? ESCAPE '\\'`);
        args.push(escapeLike(input.key) + '%');
      } else {
        where.push('key = ?');
        args.push(input.key);
      }
    }
    if (input.query !== undefined && input.query !== '') {
      // Search keys and values. A prompt says "deploy"; the key is "deploy.command".
      where.push(`(value LIKE ? ESCAPE '\\' COLLATE NOCASE OR key LIKE ? ESCAPE '\\' COLLATE NOCASE)`);
      const pat = '%' + escapeLike(input.query) + '%';
      args.push(pat, pat);
    }

    const rows = this.db
      .prepare(
        `SELECT * FROM observations WHERE ${where.join(' AND ')}
         ORDER BY key ASC, valid_from DESC, recorded_at DESC`,
      )
      .all(...args) as unknown as ObsRow[];

    // Apply the two clocks in code — it is clearer than in SQL, and the
    // per-key row counts are small.
    const facts: Fact[] = [];
    for (const r of rows) {
      const o = rowToObservation(r);

      // As-of: a close that happened after `asOf` has not happened yet.
      const effectiveValidTo = o.closedAt !== null && o.closedAt > asOf ? null : o.validTo;
      const effectiveSupersededBy = o.closedAt !== null && o.closedAt > asOf ? null : o.supersededBy;

      // Valid-at: was it true at `validAt`? A fact that was true then IS the
      // answer to a question about then, even if something replaced it later.
      // `includeHistory` skips this filter to return the whole timeline.
      if (!input.includeHistory) {
        const trueAtValidAt =
          o.validFrom <= validAt && (effectiveValidTo === null || effectiveValidTo > validAt);
        if (!trueAtValidAt) continue;
      }

      // 'superseded' is a label, not a filter: it says this fact was replaced
      // at some point after it stopped being true.
      const superseded = effectiveSupersededBy !== null;

      facts.push({ ...o, validTo: effectiveValidTo, supersededBy: effectiveSupersededBy, status: superseded ? 'superseded' : 'current' });
    }

    // Mark conflicts. Only conflicts that were open as of `asOf`.
    const ids = new Set(facts.map((f) => f.id));
    const conflicts = this.conflictsTouching(input.org, ids, asOf);
    const conflictedIds = new Set<string>();
    for (const c of conflicts) {
      conflictedIds.add(c.aId);
      conflictedIds.add(c.bId);
    }
    for (const f of facts) {
      if (f.status === 'current' && conflictedIds.has(f.id)) f.status = 'conflicted';
    }

    return { facts: facts.slice(0, limit), conflicts };
  }

  /** Open conflicts (as of `asOf`) that involve any of the given ids. */
  private conflictsTouching(org: string, ids: Set<string>, asOf: number): Conflict[] {
    if (ids.size === 0) return [];
    const rows = this.db
      .prepare(`SELECT * FROM conflicts WHERE org = ? AND detected_at <= ?`)
      .all(org, asOf) as unknown as ConflictRow[];
    return rows
      .map(rowToConflict)
      .filter((c) => ids.has(c.aId) || ids.has(c.bId))
      // A resolution that happened after asOf has not happened yet.
      .filter((c) => c.status === 'open' || (c.resolvedAt !== null && c.resolvedAt > asOf))
      .map((c) =>
        c.status === 'resolved'
          ? { ...c, status: 'open' as const, winnerId: null, reason: null, resolvedAt: null }
          : c,
      );
  }

  // -------------------------------------------------------------------------
  // conflicts + resolve
  // -------------------------------------------------------------------------

  /** List conflicts for an org. Default: open ones only. */
  conflicts(org: string, opts: { status?: 'open' | 'resolved' | 'all' } = {}): Conflict[] {
    const status = opts.status ?? 'open';
    const rows =
      status === 'all'
        ? this.db.prepare(`SELECT * FROM conflicts WHERE org = ? ORDER BY detected_at DESC`).all(org)
        : this.db
            .prepare(`SELECT * FROM conflicts WHERE org = ? AND status = ? ORDER BY detected_at DESC`)
            .all(org, status);
    return (rows as unknown as ConflictRow[]).map(rowToConflict);
  }

  /**
   * Resolve an open conflict by picking a winner. The loser is closed
   * (valid_to = now) and marked superseded_by the winner.
   */
  resolve(input: { org: string; conflictId: string; winnerId: string; reason: string; now?: number }): Conflict {
    const now = input.now ?? Date.now();
    const row = this.db
      .prepare(`SELECT * FROM conflicts WHERE id = ? AND org = ?`)
      .get(input.conflictId, input.org) as unknown as ConflictRow | undefined;
    if (!row) throw new Error('tempo.resolve: conflict not found in this org');
    if (row.status === 'resolved') throw new Error('tempo.resolve: conflict already resolved');
    if (input.winnerId !== row.a_id && input.winnerId !== row.b_id) {
      throw new Error('tempo.resolve: winnerId must be one of the two conflicting observations');
    }
    const loserId = input.winnerId === row.a_id ? row.b_id : row.a_id;

    this.db.exec('BEGIN');
    try {
      this.db
        .prepare(`UPDATE observations SET valid_to = ?, closed_at = ?, superseded_by = ? WHERE id = ?`)
        .run(now, now, input.winnerId, loserId);
      this.db
        .prepare(
          `UPDATE conflicts SET status = 'resolved', winner_id = ?, reason = ?, resolved_at = ? WHERE id = ?`,
        )
        .run(input.winnerId, input.reason, now, input.conflictId);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    return rowToConflict({
      ...row,
      status: 'resolved',
      winner_id: input.winnerId,
      reason: input.reason,
      resolved_at: now,
    });
  }

  /** Distinct keys in this org, most-used first. Used to steer extraction. */
  keys(org: string, limit = 300): string[] {
    const rows = this.db
      .prepare(
        `SELECT key, COUNT(*) n FROM observations WHERE org = ? GROUP BY key ORDER BY n DESC, key ASC LIMIT ?`,
      )
      .all(org, limit) as unknown as { key: string }[];
    return rows.map((r) => r.key);
  }

  /** The values currently held for a key (there can be more than one during a conflict). */
  currentValues(org: string, key: string): string[] {
    const rows = this.db
      .prepare(`SELECT value FROM observations WHERE org = ? AND key = ? AND valid_to IS NULL`)
      .all(org, key) as unknown as { value: string }[];
    return rows.map((r) => r.value);
  }

  // -------------------------------------------------------------------------
  // ingest bookkeeping: which source chunks have already been processed
  // -------------------------------------------------------------------------

  /** Has this source chunk already been ingested into this org? */
  isIngested(org: string, ref: string): boolean {
    return (
      this.db.prepare(`SELECT 1 FROM meta WHERE k = ?`).get(`ingested:${org}:${ref}`) !== undefined
    );
  }

  /** Record that a source chunk has been fully ingested. Safe to call twice. */
  markIngested(org: string, ref: string): void {
    this.db
      .prepare(`INSERT OR REPLACE INTO meta (k, v) VALUES (?, ?)`)
      .run(`ingested:${org}:${ref}`, String(Date.now()));
  }

  /** Fetch one observation by id (scoped to org). */
  get(org: string, id: string): Observation | null {
    const row = this.db
      .prepare(`SELECT * FROM observations WHERE id = ? AND org = ?`)
      .get(id, org) as unknown as ObsRow | undefined;
    return row ? rowToObservation(row) : null;
  }
}
