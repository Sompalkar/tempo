/**
 * These tests are the spec. Each `it(...)` name is a sentence you should be
 * able to read without knowing the code. If a test name is confusing, fix
 * the name.
 */
import { describe, expect, it } from 'vitest';
import { TempoStore } from './store.ts';

// Fixed clock so tests are deterministic. Times are ms since epoch.
const T = (day: number) => Date.UTC(2026, 0, day); // Jan <day>, 2026

const alice = { writer: 'agent-alice', kind: 'session', ref: 'sess-a1' } as const;
const bob = { writer: 'agent-bob', kind: 'slack', ref: 'https://slack/msg/1' } as const;

function fresh() {
  return new TempoStore(':memory:');
}

describe('remember: basic writes', () => {
  it('stores a brand new fact and can read it back with its provenance', () => {
    const s = fresh();
    const r = s.remember({ org: 'acme', key: 'deploy.command', value: 'make deploy', source: alice, now: T(1) });
    expect(r.action).toBe('inserted');

    const { facts } = s.recall({ org: 'acme', key: 'deploy.command', asOf: T(1), validAt: T(1) });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.value).toBe('make deploy');
    expect(facts[0]!.status).toBe('current');
    expect(facts[0]!.source).toEqual(alice);
  });

  it('remembers whether validFrom was given or guessed', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'a', value: '1', source: alice, now: T(1) });
    s.remember({ org: 'acme', key: 'b', value: '1', source: alice, now: T(1), validFrom: T(1) });
    const { facts } = s.recall({ org: 'acme', asOf: T(2), validAt: T(2) });
    const a = facts.find((f) => f.key === 'a')!;
    const b = facts.find((f) => f.key === 'b')!;
    expect(a.validFromExplicit).toBe(false);
    expect(b.validFromExplicit).toBe(true);
  });

  it('private mode writes nothing at all', () => {
    const s = fresh();
    const r = s.remember({ org: 'acme', key: 'secret', value: 'x', source: alice, private: true });
    expect(r).toEqual({ action: 'skipped-private', id: null });
    expect(s.recall({ org: 'acme' }).facts).toHaveLength(0);
  });
});

describe('remember: agreement', () => {
  it('two writers saying the same thing corroborate one fact instead of duplicating it', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'deploy.command', value: 'make deploy', source: alice, now: T(1) });
    const r = s.remember({ org: 'acme', key: 'deploy.command', value: 'make deploy', source: bob, now: T(2) });
    expect(r.action).toBe('corroborated');

    const { facts } = s.recall({ org: 'acme', key: 'deploy.command' });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.confirmations).toBe(2);
  });
});

describe('remember: the world changed (supersede)', () => {
  it('a fact with a later validFrom replaces the current one, and the old one is kept as history', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'refund.policy', value: '30 days', source: alice, validFrom: T(1), now: T(1) });
    const r = s.remember({ org: 'acme', key: 'refund.policy', value: '14 days', source: bob, validFrom: T(10), now: T(10) });
    expect(r.action).toBe('superseded');

    // Now: only the new one is current.
    const now = s.recall({ org: 'acme', key: 'refund.policy', asOf: T(11), validAt: T(11) });
    expect(now.facts.map((f) => f.value)).toEqual(['14 days']);
    expect(now.facts[0]!.status).toBe('current');

    // Asking about the past returns what was true then — no extra flag needed.
    // The 'superseded' label says it was replaced later; it does not hide it.
    const past = s.recall({ org: 'acme', key: 'refund.policy', asOf: T(11), validAt: T(5) });
    expect(past.facts.map((f) => [f.value, f.status])).toEqual([['30 days', 'superseded']]);

    // includeHistory returns the whole timeline regardless of validAt.
    const hist = s.recall({ org: 'acme', key: 'refund.policy', asOf: T(11), validAt: T(11), includeHistory: true });
    expect(hist.facts.map((f) => f.value).sort()).toEqual(['14 days', '30 days']);
  });

  it('the same writer contradicting itself on the same day is treated as a self-correction', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'k', value: 'wrong', source: alice, now: T(1) });
    const r = s.remember({ org: 'acme', key: 'k', value: 'right', source: alice, now: T(1) });
    expect(r.action).toBe('superseded');
    const { facts, conflicts } = s.recall({ org: 'acme', key: 'k', asOf: T(2), validAt: T(2) });
    expect(facts.map((f) => f.value)).toEqual(['right']);
    expect(conflicts).toHaveLength(0);
  });
});

describe('remember: learning history (backfill)', () => {
  it('a fact with an earlier validFrom is filed as history and does not disturb the current fact', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'refund.policy', value: '14 days', source: alice, validFrom: T(10), now: T(10) });
    const r = s.remember({ org: 'acme', key: 'refund.policy', value: '30 days', source: bob, validFrom: T(1), now: T(12) });
    expect(r.action).toBe('backfilled');

    const now = s.recall({ org: 'acme', key: 'refund.policy', asOf: T(13), validAt: T(13) });
    expect(now.facts.map((f) => f.value)).toEqual(['14 days']);

    const past = s.recall({ org: 'acme', key: 'refund.policy', asOf: T(13), validAt: T(5) });
    expect(past.facts.map((f) => f.value)).toEqual(['30 days']);
  });

  it('a fact that arrives already closed (validTo given) is pure history', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'oncall', value: 'alice', source: alice, validFrom: T(1), validTo: T(8), now: T(20) });
    expect(s.recall({ org: 'acme', key: 'oncall', asOf: T(21), validAt: T(21) }).facts).toHaveLength(0);
    expect(s.recall({ org: 'acme', key: 'oncall', asOf: T(21), validAt: T(3) }).facts[0]!.value).toBe('alice');
  });
});

describe('remember: real disagreement (conflict)', () => {
  it('two different writers with no dates and different values open a conflict instead of picking a winner', () => {
    const s = fresh();
    // Both just say "this is the deploy command" on the same instant. Neither gives a date.
    s.remember({ org: 'acme', key: 'deploy.command', value: 'make deploy', source: alice, now: T(1) });
    const r = s.remember({ org: 'acme', key: 'deploy.command', value: './ship.sh', source: bob, now: T(1) });
    expect(r.action).toBe('conflict');
    expect(r.conflictId).toBeDefined();

    const { facts, conflicts } = s.recall({ org: 'acme', key: 'deploy.command', asOf: T(2), validAt: T(2) });
    expect(facts).toHaveLength(2);
    expect(facts.every((f) => f.status === 'conflicted')).toBe(true);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]!.status).toBe('open');
  });

  it('two different writers with no dates on DIFFERENT days still get a conflict (a guessed time is not a reason)', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'deploy.command', value: 'make deploy', source: alice, now: T(1) });
    const r = s.remember({ org: 'acme', key: 'deploy.command', value: './ship.sh', source: bob, now: T(3) });
    expect(r.action).toBe('conflict');
    const { facts } = s.recall({ org: 'acme', key: 'deploy.command', asOf: T(4), validAt: T(4) });
    expect(facts.map((f) => f.value).sort()).toEqual(['./ship.sh', 'make deploy']);
  });

  it('but an explicit later date IS a reason: the dated fact wins over an undated one', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'deploy.command', value: 'make deploy', source: alice, now: T(1) });
    const r = s.remember({ org: 'acme', key: 'deploy.command', value: './ship.sh', source: bob, validFrom: T(3), now: T(3) });
    expect(r.action).toBe('superseded');
  });

  it('with the opt-in prefer-newer policy, undated disagreements pick the newer one and label it as a guess', () => {
    const s = new TempoStore(':memory:', { onUndatedDisagreement: 'prefer-newer' });
    s.remember({ org: 'acme', key: 'k', value: 'A', source: alice, now: T(1) });
    const r = s.remember({ org: 'acme', key: 'k', value: 'B', source: bob, now: T(3) });
    expect(r.action).toBe('superseded');
    const trail = s.conflicts('acme', { status: 'resolved' });
    expect(trail).toHaveLength(1);
    expect(trail[0]!.reason).toBe('policy:prefer-newer-undated');
  });

  it('resolving a conflict closes the loser and records who won and why', () => {
    const s = fresh();
    const a = s.remember({ org: 'acme', key: 'k', value: 'A', source: alice, now: T(1) });
    const b = s.remember({ org: 'acme', key: 'k', value: 'B', source: bob, now: T(1) });
    const c = s.resolve({ org: 'acme', conflictId: b.conflictId!, winnerId: b.id!, reason: 'bob checked the repo', now: T(3) });
    expect(c.status).toBe('resolved');
    expect(c.winnerId).toBe(b.id);

    const after = s.recall({ org: 'acme', key: 'k', asOf: T(4), validAt: T(4) });
    expect(after.facts.map((f) => f.value)).toEqual(['B']);
    expect(after.facts[0]!.status).toBe('current');
    expect(after.conflicts).toHaveLength(0);

    // The loser is still there as history, pointing at the winner.
    expect(s.get('acme', a.id!)!.supersededBy).toBe(b.id);
  });

  it('an open conflict is closed automatically when a dated newer fact replaces both sides', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'k', value: 'A', source: alice, now: T(1) });
    s.remember({ org: 'acme', key: 'k', value: 'B', source: bob, now: T(1) });
    expect(s.conflicts('acme')).toHaveLength(1);
    const r = s.remember({ org: 'acme', key: 'k', value: 'C', source: { writer: 'carol', kind: 'doc' }, validFrom: T(5), now: T(5) });
    expect(r.action).toBe('superseded');
    expect(s.conflicts('acme')).toHaveLength(0);
    const closed = s.conflicts('acme', { status: 'resolved' }).find((c) => c.reason?.startsWith('both-superseded'));
    expect(closed).toBeDefined();
    expect(closed!.winnerId).toBe(r.id);
    const { facts, conflicts } = s.recall({ org: 'acme', key: 'k', asOf: T(6), validAt: T(6) });
    expect(conflicts).toHaveLength(0);
    expect(facts.map((f) => f.value)).toEqual(['C']);
  });

  it('refuses to resolve with an observation that is not part of the conflict', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'k', value: 'A', source: alice, now: T(1) });
    const b = s.remember({ org: 'acme', key: 'k', value: 'B', source: bob, now: T(1) });
    expect(() =>
      s.resolve({ org: 'acme', conflictId: b.conflictId!, winnerId: 'nope', reason: 'x' }),
    ).toThrow(/winnerId/);
  });
});

describe('recall: the two clocks', () => {
  it('validAt answers "what was true then?"', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'p', value: 'v1', source: alice, validFrom: T(1), now: T(1) });
    s.remember({ org: 'acme', key: 'p', value: 'v2', source: alice, validFrom: T(10), now: T(10) });
    const q = (validAt: number) =>
      s.recall({ org: 'acme', key: 'p', asOf: T(20), validAt }).facts.map((f) => f.value);
    expect(q(T(5))).toEqual(['v1']);
    expect(q(T(15))).toEqual(['v2']);
  });

  it('asOf answers "what did we know then?" and hides later supersessions', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'p', value: 'v1', source: alice, validFrom: T(1), now: T(1) });
    s.remember({ org: 'acme', key: 'p', value: 'v2', source: alice, validFrom: T(10), now: T(10) });

    // On day 5 we only knew v1, and it looked current (not superseded yet).
    const day5 = s.recall({ org: 'acme', key: 'p', asOf: T(5), validAt: T(5) });
    expect(day5.facts.map((f) => [f.value, f.status])).toEqual([['v1', 'current']]);
    expect(day5.facts[0]!.validTo).toBeNull();
    expect(day5.facts[0]!.supersededBy).toBeNull();

    // Even asking "what is true on day 15, as far as we knew on day 5" -> v1.
    const day5about15 = s.recall({ org: 'acme', key: 'p', asOf: T(5), validAt: T(15) });
    expect(day5about15.facts.map((f) => f.value)).toEqual(['v1']);
  });

  it('asOf hides a conflict resolution that happened later', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'k', value: 'A', source: alice, now: T(1) });
    const b = s.remember({ org: 'acme', key: 'k', value: 'B', source: bob, now: T(1) });
    s.resolve({ org: 'acme', conflictId: b.conflictId!, winnerId: b.id!, reason: 'r', now: T(5) });

    const before = s.recall({ org: 'acme', key: 'k', asOf: T(3), validAt: T(3) });
    expect(before.facts).toHaveLength(2);
    expect(before.conflicts[0]!.status).toBe('open');

    const after = s.recall({ org: 'acme', key: 'k', asOf: T(6), validAt: T(6) });
    expect(after.facts.map((f) => f.value)).toEqual(['B']);
  });

  it('a fact recorded after asOf is invisible', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'k', value: 'late', source: alice, now: T(10) });
    expect(s.recall({ org: 'acme', key: 'k', asOf: T(5), validAt: T(20) }).facts).toHaveLength(0);
  });
});

describe('recall: search', () => {
  it('a key ending in "." matches by prefix', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'deploy.command', value: 'x', source: alice, now: T(1) });
    s.remember({ org: 'acme', key: 'deploy.region', value: 'y', source: alice, now: T(1) });
    s.remember({ org: 'acme', key: 'billing.cycle', value: 'z', source: alice, now: T(1) });
    const { facts } = s.recall({ org: 'acme', key: 'deploy.', asOf: T(2), validAt: T(2) });
    expect(facts.map((f) => f.key).sort()).toEqual(['deploy.command', 'deploy.region']);
  });

  it('underscores and percent signs in a key prefix are taken literally, not as wildcards', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'deploy_prod.cmd', value: 'x', source: alice, now: T(1) });
    s.remember({ org: 'acme', key: 'deployXprod.cmd', value: 'y', source: alice, now: T(1) });
    s.remember({ org: 'acme', key: 'rate.100%.limit', value: 'z', source: alice, now: T(1) });
    expect(s.recall({ org: 'acme', key: 'deploy_prod.', asOf: T(2), validAt: T(2) }).facts.map((f) => f.key)).toEqual(['deploy_prod.cmd']);
    expect(s.recall({ org: 'acme', key: 'rate.100%.', asOf: T(2), validAt: T(2) }).facts.map((f) => f.key)).toEqual(['rate.100%.limit']);
  });

  it('query searches keys and values, case-insensitively', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'a', value: 'Use Postgres 16', source: alice, now: T(1) });
    s.remember({ org: 'acme', key: 'b', value: 'Use Redis', source: alice, now: T(1) });
    s.remember({ org: 'acme', key: 'deploy.command', value: 'make ship', source: alice, now: T(1) });
    expect(s.recall({ org: 'acme', query: 'postgres', asOf: T(2), validAt: T(2) }).facts.map((f) => f.key)).toEqual(['a']);
    expect(s.recall({ org: 'acme', query: 'Deploy', asOf: T(2), validAt: T(2) }).facts.map((f) => f.key)).toEqual(['deploy.command']);
  });
});

describe('ingest bookkeeping', () => {
  it('remembers which chunks were ingested, per org', () => {
    const s = fresh();
    expect(s.isIngested('acme', 'sess#0')).toBe(false);
    s.markIngested('acme', 'sess#0');
    s.markIngested('acme', 'sess#0'); // twice is fine
    expect(s.isIngested('acme', 'sess#0')).toBe(true);
    expect(s.isIngested('globex', 'sess#0')).toBe(false);
  });
});

describe('boundaries', () => {
  it('one org can never read another org\'s facts', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'secret', value: 'acme-only', source: alice, now: T(1) });
    s.remember({ org: 'globex', key: 'secret', value: 'globex-only', source: bob, now: T(1) });
    expect(s.recall({ org: 'acme', key: 'secret', asOf: T(2), validAt: T(2) }).facts.map((f) => f.value)).toEqual(['acme-only']);
    expect(s.recall({ org: 'globex', key: 'secret', asOf: T(2), validAt: T(2) }).facts.map((f) => f.value)).toEqual(['globex-only']);
    expect(s.recall({ org: 'acme', query: 'globex', asOf: T(2), validAt: T(2) }).facts).toHaveLength(0);
  });

  it('the same key in two orgs never conflicts', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'k', value: 'A', source: alice, now: T(1) });
    const r = s.remember({ org: 'globex', key: 'k', value: 'B', source: bob, now: T(1) });
    expect(r.action).toBe('inserted');
  });

  it('resolve cannot touch a conflict from another org', () => {
    const s = fresh();
    s.remember({ org: 'acme', key: 'k', value: 'A', source: alice, now: T(1) });
    const b = s.remember({ org: 'acme', key: 'k', value: 'B', source: bob, now: T(1) });
    expect(() =>
      s.resolve({ org: 'globex', conflictId: b.conflictId!, winnerId: b.id!, reason: 'x' }),
    ).toThrow(/not found/);
  });
});
