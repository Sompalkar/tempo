/**
 * Run async jobs where jobs sharing a key must run one after another, but
 * jobs with different keys may overlap. A global cap limits how many run at
 * once.
 *
 * Why this exists: writing a fact to tempo depends on what is already stored
 * under that fact's key. Two writes to the SAME key must not interleave, or
 * they invent a contradiction that never happened (see JOURNAL, failure #10).
 * Two writes to DIFFERENT keys never look at each other's rows, so
 * serializing them too just wastes time — and it was wasting a lot: a
 * fully serialized writer fell hours behind extraction on a real run.
 */
export class KeyedQueue {
  private tails = new Map<string, Promise<void>>();
  private running = 0;
  private waiters: (() => void)[] = [];
  private all: Promise<void>[] = [];
  private readonly maxInFlight: number;

  constructor(maxInFlight: number) {
    if (maxInFlight < 1) throw new Error('KeyedQueue: maxInFlight must be >= 1');
    this.maxInFlight = maxInFlight;
  }

  /** Wait for a slot under the global cap. */
  private acquire(): Promise<void> {
    if (this.running < this.maxInFlight) {
      this.running++;
      return Promise.resolve();
    }
    return new Promise((resolve) => {
      this.waiters.push(() => {
        this.running++;
        resolve();
      });
    });
  }

  private release(): void {
    this.running--;
    const next = this.waiters.shift();
    if (next) next();
  }

  /**
   * Schedule `job` after every earlier job with the same key has finished.
   * Returns the job's own promise so a caller can await one specific result.
   */
  add<T>(key: string, job: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(async () => {
      await this.acquire();
      try {
        return await job();
      } finally {
        this.release();
      }
    });
    // The chain for this key continues regardless of whether this job threw.
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.tails.set(key, tail);
    this.all.push(tail);
    return result;
  }

  /** Resolve once everything scheduled so far has finished (or failed). */
  async drain(): Promise<void> {
    // New jobs may be added while we wait, so loop until the list is stable.
    let seen = 0;
    while (seen < this.all.length) {
      const batch = this.all.slice(seen);
      seen = this.all.length;
      await Promise.all(batch);
    }
    this.all = [];
    this.tails.clear();
  }
}
