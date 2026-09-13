/**
 * Two baselines that behave the way most agent memory tools behave.
 * They are not straw men: each is a faithful model of a common design.
 * Both are given org-scoped storage to be fair. The point is to test time
 * and contradiction handling, not to catch them on something trivial.
 */
import type { MemoryAdapter, ReadOp, ReturnedFact, WriteOp } from '../adapter.js';

interface Entry {
  value: string;
  writer: string;
  ref?: string;
  at: number;
}

/**
 * Last-write-wins key/value store. One value per key. Newest write replaces.
 * This is what a "remember X" tool backed by a KV map, or a facts table
 * updated with UPDATE, does.
 */
export function lastWriteWinsAdapter(): MemoryAdapter {
  let data = new Map<string, Entry>();
  const k = (org: string, key: string) => `${org} ${key}`;
  return {
    name: 'last-write-wins',
    description: 'one value per key; newest write silently replaces the old one',
    reset() {
      data = new Map();
    },
    write(op: WriteOp) {
      if (op.private) return;
      const e: Entry = { value: op.value, writer: op.writer, at: op.at };
      if (op.ref !== undefined) e.ref = op.ref;
      data.set(k(op.org, op.key), e);
    },
    read(op: ReadOp): ReturnedFact[] {
      const e = data.get(k(op.org, op.key));
      if (!e || e.at > op.asOf) return [];
      const r: ReturnedFact = { value: e.value, writer: e.writer };
      if (e.ref !== undefined) r.ref = e.ref;
      return [r];
    },
  };
}

/**
 * Append-only store that returns everything ever written for a key.
 * This is what a vector/text search over a growing log does: every chunk
 * that matches comes back, with no notion of which one is current.
 */
export function appendOnlyAdapter(): MemoryAdapter {
  let data: (Entry & { org: string; key: string })[] = [];
  return {
    name: 'append-only',
    description: 'keeps every write; returns all of them; no idea which is current',
    reset() {
      data = [];
    },
    write(op: WriteOp) {
      if (op.private) return;
      const e: (typeof data)[number] = { org: op.org, key: op.key, value: op.value, writer: op.writer, at: op.at };
      if (op.ref !== undefined) e.ref = op.ref;
      data.push(e);
    },
    read(op: ReadOp): ReturnedFact[] {
      return data
        .filter((e) => e.org === op.org && e.key === op.key && e.at <= op.asOf)
        .map((e) => {
          const r: ReturnedFact = { value: e.value, writer: e.writer };
          if (e.ref !== undefined) r.ref = e.ref;
          return r;
        });
    },
  };
}
