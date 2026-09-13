/**
 * StaleBench scenarios.
 *
 * Each one is a tiny story: a few agents write facts over time, then someone
 * asks a question. `check` says what a correct answer looks like.
 *
 * They are grouped by the four hard problems from DESIGN.md §1.
 * Read the `title` of each — that is the whole test in one sentence.
 */
import type { MemoryAdapter, ReturnedFact } from './adapter.ts';

export type Problem = 'temporal' | 'contradiction' | 'provenance' | 'boundary';

export interface Scenario {
  id: string;
  problem: Problem;
  title: string;
  run(m: MemoryAdapter): Promise<{ pass: boolean; got: string }>;
}

// Fixed clock. Day N of 2026.
const D = (n: number) => Date.UTC(2026, 0, n);

const alice = 'agent-alice';
const bob = 'agent-bob';

const vals = (f: ReturnedFact[]) => f.map((x) => x.value).sort();
const show = (f: ReturnedFact[]) =>
  f.length === 0
    ? '(nothing)'
    : f.map((x) => `${x.value}${x.conflicted ? ' [conflicted]' : ''}${x.writer ? ` by ${x.writer}` : ''}`).join(' | ');

export const scenarios: Scenario[] = [
  // -------------------------------------------------------------------------
  // TEMPORAL — "the refund policy from March is wrong in June"
  // -------------------------------------------------------------------------
  {
    id: 'T1',
    problem: 'temporal',
    title: 'Policy was "30 days" from March, "14 days" from June. Asked about May, answer must be "30 days" only.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'refund.policy', value: '30 days', validFrom: D(60), at: D(60) });
      await m.write({ org: 'acme', writer: bob, key: 'refund.policy', value: '14 days', validFrom: D(152), at: D(152) });
      const got = await m.read({ org: 'acme', key: 'refund.policy', validAt: D(130), asOf: D(200) });
      return { pass: JSON.stringify(vals(got)) === JSON.stringify(['30 days']), got: show(got) };
    },
  },
  {
    id: 'T2',
    problem: 'temporal',
    title: 'Same history. Asked about July, answer must be "14 days" only.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'refund.policy', value: '30 days', validFrom: D(60), at: D(60) });
      await m.write({ org: 'acme', writer: bob, key: 'refund.policy', value: '14 days', validFrom: D(152), at: D(152) });
      const got = await m.read({ org: 'acme', key: 'refund.policy', validAt: D(190), asOf: D(200) });
      return { pass: JSON.stringify(vals(got)) === JSON.stringify(['14 days']), got: show(got) };
    },
  },
  {
    id: 'T3',
    problem: 'temporal',
    title: 'Replay: asked "what did we know in April?" (before the June write happened), answer must be "30 days", not flagged.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'refund.policy', value: '30 days', validFrom: D(60), at: D(60) });
      await m.write({ org: 'acme', writer: bob, key: 'refund.policy', value: '14 days', validFrom: D(152), at: D(152) });
      const got = await m.read({ org: 'acme', key: 'refund.policy', validAt: D(100), asOf: D(100) });
      const ok = JSON.stringify(vals(got)) === JSON.stringify(['30 days']) && !got[0]?.conflicted;
      return { pass: ok, got: show(got) };
    },
  },
  {
    id: 'T4',
    problem: 'temporal',
    title: 'History learned late: June fact written first, March fact written afterwards. Asked about May, answer must still be "30 days".',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: bob, key: 'refund.policy', value: '14 days', validFrom: D(152), at: D(152) });
      await m.write({ org: 'acme', writer: alice, key: 'refund.policy', value: '30 days', validFrom: D(60), at: D(160) });
      const got = await m.read({ org: 'acme', key: 'refund.policy', validAt: D(130), asOf: D(200) });
      return { pass: JSON.stringify(vals(got)) === JSON.stringify(['30 days']), got: show(got) };
    },
  },
  {
    id: 'T5',
    problem: 'temporal',
    title: 'Same late-learned history. Asked about today, answer must be "14 days" — the late write must not clobber the present.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: bob, key: 'refund.policy', value: '14 days', validFrom: D(152), at: D(152) });
      await m.write({ org: 'acme', writer: alice, key: 'refund.policy', value: '30 days', validFrom: D(60), at: D(160) });
      const got = await m.read({ org: 'acme', key: 'refund.policy', validAt: D(200), asOf: D(200) });
      return { pass: JSON.stringify(vals(got)) === JSON.stringify(['14 days']), got: show(got) };
    },
  },

  // -------------------------------------------------------------------------
  // CONTRADICTION — "two agents write conflicting facts"
  // -------------------------------------------------------------------------
  {
    id: 'C1',
    problem: 'contradiction',
    title: 'Alice says deploy is "make deploy". Two days later Bob says "./ship.sh". Neither gave a date. Both must come back, flagged as disagreeing.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'deploy.command', value: 'make deploy', at: D(1) });
      await m.write({ org: 'acme', writer: bob, key: 'deploy.command', value: './ship.sh', at: D(3) });
      const got = await m.read({ org: 'acme', key: 'deploy.command', validAt: D(5), asOf: D(5) });
      const both = JSON.stringify(vals(got)) === JSON.stringify(['./ship.sh', 'make deploy']);
      const flagged = got.every((f) => f.conflicted === true);
      return { pass: both && flagged, got: show(got) };
    },
  },
  {
    id: 'C2',
    problem: 'contradiction',
    title: 'Alice says X, then Alice says Y (correcting herself). Only Y must come back, and not flagged.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'db.port', value: '5432', at: D(1) });
      await m.write({ org: 'acme', writer: alice, key: 'db.port', value: '5433', at: D(1) });
      const got = await m.read({ org: 'acme', key: 'db.port', validAt: D(2), asOf: D(2) });
      return { pass: JSON.stringify(vals(got)) === JSON.stringify(['5433']) && !got[0]?.conflicted, got: show(got) };
    },
  },
  {
    id: 'C3',
    problem: 'contradiction',
    title: 'Alice and Bob both say "make deploy". Exactly one fact must come back, not two copies.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'deploy.command', value: 'make deploy', at: D(1) });
      await m.write({ org: 'acme', writer: bob, key: 'deploy.command', value: 'make deploy', at: D(2) });
      const got = await m.read({ org: 'acme', key: 'deploy.command', validAt: D(3), asOf: D(3) });
      return { pass: got.length === 1 && got[0]!.value === 'make deploy', got: show(got) };
    },
  },
  {
    id: 'C4',
    problem: 'contradiction',
    title: 'After a disagreement is resolved in favour of Bob, only Bob\'s value must come back, unflagged.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'deploy.command', value: 'make deploy', at: D(1) });
      await m.write({ org: 'acme', writer: bob, key: 'deploy.command', value: './ship.sh', at: D(3) });
      if (!m.resolve) return { pass: false, got: '(system has no way to resolve a disagreement)' };
      await m.resolve('acme', 'deploy.command', './ship.sh', D(4));
      const got = await m.read({ org: 'acme', key: 'deploy.command', validAt: D(5), asOf: D(5) });
      return { pass: JSON.stringify(vals(got)) === JSON.stringify(['./ship.sh']) && !got[0]?.conflicted, got: show(got) };
    },
  },
  {
    id: 'C5',
    problem: 'contradiction',
    title: 'Bob disagrees with Alice but gives an explicit later date. That IS a reason: Bob\'s value must win, unflagged.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'deploy.command', value: 'make deploy', at: D(1) });
      await m.write({ org: 'acme', writer: bob, key: 'deploy.command', value: './ship.sh', validFrom: D(3), at: D(3) });
      const got = await m.read({ org: 'acme', key: 'deploy.command', validAt: D(5), asOf: D(5) });
      return { pass: JSON.stringify(vals(got)) === JSON.stringify(['./ship.sh']) && !got[0]?.conflicted, got: show(got) };
    },
  },

  // -------------------------------------------------------------------------
  // PROVENANCE — "says who?"
  // -------------------------------------------------------------------------
  {
    id: 'P1',
    problem: 'provenance',
    title: 'Every returned fact must say who wrote it.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'k', value: 'v', at: D(1) });
      const got = await m.read({ org: 'acme', key: 'k', validAt: D(2), asOf: D(2) });
      return { pass: got.length === 1 && got[0]!.writer === alice, got: show(got) };
    },
  },
  {
    id: 'P2',
    problem: 'provenance',
    title: 'When the writer gave a source pointer (a Slack link), the returned fact must carry it.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'k', value: 'v', ref: 'https://slack/msg/42', at: D(1) });
      const got = await m.read({ org: 'acme', key: 'k', validAt: D(2), asOf: D(2) });
      return { pass: got[0]?.ref === 'https://slack/msg/42', got: show(got) + (got[0]?.ref ? ` ref=${got[0].ref}` : ' (no ref)') };
    },
  },
  {
    id: 'P3',
    problem: 'provenance',
    title: 'A fact that was replaced must still be retrievable for the time it was true, with its original writer.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'oncall', value: 'alice', validFrom: D(1), at: D(1) });
      await m.write({ org: 'acme', writer: bob, key: 'oncall', value: 'bob', validFrom: D(8), at: D(8) });
      const got = await m.read({ org: 'acme', key: 'oncall', validAt: D(3), asOf: D(20) });
      return { pass: got.length === 1 && got[0]!.value === 'alice' && got[0]!.writer === alice, got: show(got) };
    },
  },

  // -------------------------------------------------------------------------
  // BOUNDARY — "one org can never read another's"
  // -------------------------------------------------------------------------
  {
    id: 'B1',
    problem: 'boundary',
    title: 'A fact written in org "acme" must be invisible to org "globex".',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'secret', value: 'acme-only', at: D(1) });
      const got = await m.read({ org: 'globex', key: 'secret', validAt: D(2), asOf: D(2) });
      return { pass: got.length === 0, got: show(got) };
    },
  },
  {
    id: 'B2',
    problem: 'boundary',
    title: 'A write in private mode must leave no trace.',
    async run(m) {
      await m.reset();
      await m.write({ org: 'acme', writer: alice, key: 'secret', value: 'shh', at: D(1), private: true });
      const got = await m.read({ org: 'acme', key: 'secret', validAt: D(2), asOf: D(2) });
      return { pass: got.length === 0, got: show(got) };
    },
  },
];
