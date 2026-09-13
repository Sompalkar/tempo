import { TempoStore } from '../../store.js';
import type { MemoryAdapter, ReadOp, ReturnedFact, WriteOp } from '../adapter.js';

export function tempoAdapter(): MemoryAdapter {
  let store = new TempoStore(':memory:');
  return {
    name: 'tempo',
    description: 'bitemporal, provenance on every fact, conflicts surfaced not guessed',
    reset() {
      store.close();
      store = new TempoStore(':memory:');
    },
    write(op: WriteOp) {
      const source: { writer: string; kind: string; ref?: string } = { writer: op.writer, kind: 'test' };
      if (op.ref !== undefined) source.ref = op.ref;
      const input: Parameters<TempoStore['remember']>[0] = {
        org: op.org,
        key: op.key,
        value: op.value,
        source,
        now: op.at,
      };
      if (op.validFrom !== undefined) input.validFrom = op.validFrom;
      if (op.private !== undefined) input.private = op.private;
      store.remember(input);
    },
    read(op: ReadOp): ReturnedFact[] {
      const { facts } = store.recall({
        org: op.org,
        key: op.key,
        validAt: op.validAt,
        asOf: op.asOf,
        includeHistory: true,
      });
      return facts.map((f) => {
        const r: ReturnedFact = { value: f.value, writer: f.source.writer, conflicted: f.status === 'conflicted' };
        if (f.source.ref !== undefined) r.ref = f.source.ref;
        return r;
      });
    },
    resolve(org, key, winnerValue, at) {
      for (const c of store.conflicts(org)) {
        if (c.key !== key) continue;
        const a = store.get(org, c.aId)!;
        const b = store.get(org, c.bId)!;
        const winnerId = a.value === winnerValue ? a.id : b.value === winnerValue ? b.id : null;
        if (winnerId) store.resolve({ org, conflictId: c.id, winnerId, reason: 'bench', now: at });
      }
    },
  };
}
