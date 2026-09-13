/**
 * Core types for tempo.
 *
 * All times are milliseconds since the Unix epoch (what `Date.now()` returns).
 * We use plain numbers instead of Date objects so they sort correctly in
 * SQLite and are easy to compare.
 */

/** Where a fact came from. Every observation carries one of these. */
export interface Source {
  /** Who wrote it: an agent id, a person, a bot name. */
  writer: string;
  /** What kind of thing it came from. Free-form, but keep it consistent. */
  kind: 'session' | 'slack' | 'github' | 'doc' | 'manual' | (string & {});
  /** A pointer back to the original: session id, message URL, commit sha. */
  ref?: string;
}

/** What you pass to `remember`. */
export interface RememberInput {
  /** Hard boundary. Nothing is ever read across orgs. */
  org: string;
  /** What the fact is about. Dotted names work well: "deploy.command". */
  key: string;
  /** The fact itself. */
  value: string;
  source: Source;
  /**
   * When this became true in the real world. If you leave it out, tempo uses
   * "now" and remembers that it was a guess (see DESIGN.md §4).
   */
  validFrom?: number;
  /** When this stopped being true. Leave out if it is still true. */
  validTo?: number;
  /** If true, tempo writes nothing at all. A hard off switch. */
  private?: boolean;
  /** Override "now". Used by tests and by replay. */
  now?: number;
}

/** What `remember` did with your input. */
export type RememberAction =
  | 'inserted'      // brand new key, nothing to compare against
  | 'corroborated'  // same value already current; confirmation count bumped
  | 'superseded'    // replaced the current fact; old one kept and closed
  | 'backfilled'    // inserted as history; did not touch the current fact
  | 'conflict'      // disagrees with a current fact and we cannot pick a winner
  | 'skipped-private';

export interface RememberResult {
  action: RememberAction;
  /** The id of the observation written (or matched, for corroborate). */
  id: string | null;
  /** For 'superseded' and 'conflict': the other observation involved. */
  otherId?: string;
  /** For 'conflict': the conflict row that was opened. */
  conflictId?: string;
}

/** One stored fact, as returned by `recall`. */
export interface Observation {
  id: string;
  org: string;
  key: string;
  value: string;
  validFrom: number;
  validTo: number | null;
  /** False means tempo guessed validFrom = recordedAt. */
  validFromExplicit: boolean;
  recordedAt: number;
  /** When validTo was set (null if still open). Needed for as-of queries. */
  closedAt: number | null;
  supersededBy: string | null;
  /** How many separate writes agreed with this exact value. Starts at 1. */
  confirmations: number;
  source: Source;
}

export type FactStatus = 'current' | 'conflicted' | 'superseded';

export interface Fact extends Observation {
  status: FactStatus;
}

export interface RecallInput {
  org: string;
  /** Exact key, or a prefix if it ends with "." */
  key?: string;
  /** Plain-text search over keys and values (case-insensitive substring). */
  query?: string;
  /** "What was true at this moment?" Defaults to now. */
  validAt?: number;
  /** "What did we know at this moment?" Defaults to now. */
  asOf?: number;
  /** Also return facts that have been superseded. Default false. */
  includeHistory?: boolean;
  limit?: number;
}

export interface Conflict {
  id: string;
  org: string;
  key: string;
  /** The two observations that disagree. */
  aId: string;
  bId: string;
  detectedAt: number;
  status: 'open' | 'resolved';
  winnerId: string | null;
  reason: string | null;
  resolvedAt: number | null;
}

export interface RecallResult {
  facts: Fact[];
  /** Open conflicts touching any returned fact. */
  conflicts: Conflict[];
}
