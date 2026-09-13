import { describe, expect, it, vi } from 'vitest';
import { cheapVerdict, normalize, Reconciler, significantTokens } from './reconcile.ts';

describe('normalize', () => {
  it('ignores case, extra spaces and a trailing full stop', () => {
    expect(normalize('  Make   Deploy. ')).toBe('make deploy');
  });
});

describe('significantTokens', () => {
  it('keeps identifiers and drops prose and short words', () => {
    expect([...significantTokens('Both frontend and backend use Clerk instance driving-tapir-92.clerk.accounts.dev')])
      .toEqual(['frontend', 'backend', 'clerk', 'instance', 'driving-tapir-92.clerk.accounts.dev', 'driving', 'tapir', '92.clerk.accounts.dev']);
  });
  it('drops a trailing full stop but keeps internal dots', () => {
    expect(significantTokens('retained for 72 hours.').has('hours')).toBe(true);
    expect(significantTokens('host is api.example.com.').has('api.example.com')).toBe(true);
  });
  it('keeps numbers no matter how short', () => {
    expect(significantTokens('port 80').has('80')).toBe(true);
    expect(significantTokens('timeout 30.0').has('30.0')).toBe(true);
  });
  it('splits identifiers into their parts as well', () => {
    const t = significantTokens('LOG_RETENTION_HOURS: 72');
    expect(t.has('log_retention_hours')).toBe(true);
    expect(t.has('hours')).toBe(true);
    expect(t.has('72')).toBe(true);
  });
});

describe('cheapVerdict', () => {
  it('says same for identical text ignoring case and spacing', () => {
    expect(cheapVerdict('make deploy', 'Make  Deploy.')).toBe('same');
  });

  it('says same when a long statement just restates a short one with prose', () => {
    expect(
      cheapVerdict(
        'driving-tapir-92.clerk.accounts.dev',
        'Both frontend and backend use Clerk instance driving-tapir-92.clerk.accounts.dev',
      ),
    ).toBe('same');
  });

  it('says different when nothing distinctive is shared', () => {
    expect(cheapVerdict('make deploy', './scripts/ship.sh')).toBe('different');
  });

  it('says unknown when the two partly overlap — that is what the judge is for', () => {
    expect(cheapVerdict('runs on port 5432', 'the database runs on port 5433')).toBe('unknown');
  });

  it('never calls two different port numbers the same', () => {
    expect(cheapVerdict('port 5432', 'port 5433')).not.toBe('same');
  });

  it('asks the judge when one identifier looks like a shortened form of the other', () => {
    expect(cheapVerdict('driving-tapir-92', 'Frontend Clerk instance is driving-tapir-92.clerk.accounts.dev')).toBe('unknown');
  });

  it('still says different when the identifiers merely look alike but are unrelated words', () => {
    expect(cheapVerdict('uses redis', 'uses postgres')).toBe('different');
  });

  it('sends a prose sentence and its config-key twin to the judge, not straight to "different"', () => {
    expect(cheapVerdict('Logs are retained for 72 hours.', 'LOG_RETENTION_HOURS: 72')).toBe('unknown');
    expect(cheapVerdict('Old logs are pruned every 60 minutes.', 'LOG_PRUNE_INTERVAL_MINUTES: 60')).toBe('unknown');
  });
});

/** A judge that records what it was asked, so we can prove when it is skipped. */
function fakeLLM(answers: Record<string, boolean>) {
  const asked: string[] = [];
  const llm = {
    name: 'fake',
    parse: vi.fn(async ({ user }: { user: string }) => {
      asked.push(user);
      // Find which numbered existing line matches an answer marked true.
      const lines = user.split('\n').filter((l) => /^\[\d+\] /.test(l));
      const idx = lines.findIndex((l) => Object.entries(answers).some(([k, v]) => v && l.includes(k)));
      return { sameAs: idx, why: 'test' };
    }),
  } as never;
  return { asked, llm };
}

describe('Reconciler', () => {
  it('matches a restatement without ever calling the model', async () => {
    const f = fakeLLM({});
    const r = new Reconciler({ llm: f.llm });
    const match = await r.matchExisting('auth.clerk', 'driving-tapir-92.clerk.accounts.dev', [
      'Both frontend and backend use Clerk instance driving-tapir-92.clerk.accounts.dev',
    ]);
    expect(match).toBe('Both frontend and backend use Clerk instance driving-tapir-92.clerk.accounts.dev');
    expect(f.asked).toHaveLength(0);
    expect(r.stats.judged).toBe(0);
  });

  it('returns null for a genuinely different value, without calling the model', async () => {
    const f = fakeLLM({});
    const r = new Reconciler({ llm: f.llm });
    expect(await r.matchExisting('deploy.command', './scripts/ship.sh', ['make deploy'])).toBeNull();
    expect(f.asked).toHaveLength(0);
  });

  it('asks the model once, and only about the undecidable candidates', async () => {
    const f = fakeLLM({});
    const r = new Reconciler({ llm: f.llm });
    const match = await r.matchExisting('db.port', 'the database runs on port 5433', [
      'runs on port 5432',
      'something entirely unrelated here',
    ]);
    expect(match).toBeNull();
    expect(f.asked).toHaveLength(1);
    expect(f.asked[0]).toContain('[0] runs on port 5432');
    expect(f.asked[0]).not.toContain('unrelated'); // settled cheaply, not sent
    expect(r.stats.judged).toBe(1);
  });

  it('batches several undecided candidates into one call and picks the right one', async () => {
    const f = fakeLLM({ 'listens on 5432': true });
    const r = new Reconciler({ llm: f.llm });
    const match = await r.matchExisting('db.port', 'the database runs on port 5432', [
      'runs on port 5433',
      'listens on 5432',
    ]);
    expect(match).toBe('listens on 5432');
    expect(f.asked).toHaveLength(1);
  });

  it('uses the model verdict when it says the facts are the same', async () => {
    const f = fakeLLM({ 'runs on port 5432': true });
    const r = new Reconciler({ llm: f.llm });
    expect(await r.matchExisting('db.port', 'listens on 5432 by default', ['runs on port 5432'])).toBe('runs on port 5432');
  });

  it('caches a verdict instead of asking twice', async () => {
    const f = fakeLLM({ '5432': true });
    const r = new Reconciler({ llm: f.llm });
    await r.matchExisting('db.port', 'listens on 5432 by default', ['runs on port 5432']);
    await r.matchExisting('db.port', 'listens on 5432 by default', ['runs on port 5432']);
    expect(f.asked).toHaveLength(1);
    expect(r.stats.cacheHits).toBe(1);
  });

  it('treats a judge failure as "not the same" so nothing is silently merged', async () => {
    const llm = { name: 'fake', parse: vi.fn(async () => { throw new Error('boom'); }) } as never;
    const r = new Reconciler({ llm });
    expect(await r.matchExisting('db.port', 'listens on 5432 by default', ['runs on port 5432'])).toBeNull();
  });

  it('returns null when there is nothing to compare against', async () => {
    const r = new Reconciler({ llm: fakeLLM({}).llm });
    expect(await r.matchExisting('k', 'v', [])).toBeNull();
  });
});
