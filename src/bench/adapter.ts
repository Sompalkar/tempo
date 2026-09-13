/**
 * The tiny interface a memory system must implement to be scored by
 * StaleBench. Deliberately minimal so that adding a new system is an hour
 * of work, not a day.
 */

export interface WriteOp {
  org: string;
  writer: string;
  key: string;
  value: string;
  /** Source pointer, if the writer has one. */
  ref?: string;
  /** When the fact became true, if the writer knows. ms epoch. */
  validFrom?: number;
  /** The wall clock at the moment of the write. ms epoch. */
  at: number;
  /** If true, the system must write nothing. */
  private?: boolean;
}

export interface ReadOp {
  org: string;
  key: string;
  /** "What was true at this moment?" ms epoch. */
  validAt: number;
  /** "What did we know at this moment?" ms epoch. */
  asOf: number;
}

/** One fact as returned by a memory system. Only `value` is required. */
export interface ReturnedFact {
  value: string;
  writer?: string;
  ref?: string;
  /** True if the system is telling us another current fact disagrees. */
  conflicted?: boolean;
}

export interface MemoryAdapter {
  name: string;
  /** Short description of how this system behaves, for the report. */
  description: string;
  reset(): void | Promise<void>;
  write(op: WriteOp): void | Promise<void>;
  read(op: ReadOp): ReturnedFact[] | Promise<ReturnedFact[]>;
  /** Optional: pick a winner between two disagreeing values. */
  resolve?(org: string, key: string, winnerValue: string, at: number): void | Promise<void>;
}
