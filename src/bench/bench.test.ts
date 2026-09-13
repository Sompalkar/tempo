/**
 * Guard: tempo must pass every StaleBench scenario. If the engine regresses,
 * this fails with the scenario title so you know which promise broke.
 */
import { describe, expect, it } from 'vitest';
import { tempoAdapter } from './adapters/tempo.js';
import { lastWriteWinsAdapter, appendOnlyAdapter } from './adapters/baselines.js';
import { scenarios } from './scenarios.js';

describe('StaleBench: tempo', () => {
  const m = tempoAdapter();
  for (const s of scenarios) {
    it(`${s.id} ${s.title}`, async () => {
      const r = await s.run(m);
      expect(r.pass, r.got).toBe(true);
    });
  }
});

describe('StaleBench: baselines behave as documented', () => {
  it('last-write-wins hides disagreement (C1 fails)', async () => {
    const c1 = scenarios.find((s) => s.id === 'C1')!;
    expect((await c1.run(lastWriteWinsAdapter())).pass).toBe(false);
  });
  it('append-only cannot tell what is current (T2 fails)', async () => {
    const t2 = scenarios.find((s) => s.id === 'T2')!;
    expect((await t2.run(appendOnlyAdapter())).pass).toBe(false);
  });
});
