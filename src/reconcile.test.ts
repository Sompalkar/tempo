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
      .toEqual(['frontend', 'backend', 'clerk', 'instance', 'driving-tapir-92.clerk.accounts.dev']);
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
});

/** A judge that records what it was asked, so we can prove when it is skipped. */
function fakeClient(answers: Record<string, boolean>) {
  const asked: string[] = [];
  return {
    asked,
    client: {
      messages: {
        parse: vi.fn(async ({ messages }: { messages: { content: string }[] }) => {
          const content = messages[0]!.content;
          asked.push(content);
          const hit = Object.entries(answers).find(([k]) => content.includes(k));
          return { parsed_output: { same: hit ? hit[1] : false, why: 'test' } };
        }),
      },
    } as never,
  };
}

describe('Reconciler', () => {
  it('matches a restatement without ever calling the model', async () => {
    const f = fakeClient({});
    const r = new Reconciler({ client: f.client });
    const match = await r.matchExisting('auth.clerk', 'driving-tapir-92.clerk.accounts.dev', [
      'Both frontend and backend use Clerk instance driving-tapir-92.clerk.accounts.dev',
    ]);
    expect(match).toBe('Both frontend and backend use Clerk instance driving-tapir-92.clerk.accounts.dev');
    expect(f.asked).toHaveLength(0);
    expect(r.stats.judged).toBe(0);
  });

  it('returns null for a genuinely different value, without calling the model', async () => {
    const f = fakeClient({});
    const r = new Reconciler({ client: f.client });
    expect(await r.matchExisting('deploy.command', './scripts/ship.sh', ['make deploy'])).toBeNull();
    expect(f.asked).toHaveLength(0);
  });

  it('calls the model only for the undecidable pair', async () => {
    const f = fakeClient({ '5433': false });
    const r = new Reconciler({ client: f.client });
    const match = await r.matchExisting('db.port', 'the database runs on port 5433', [
      'runs on port 5432',
      'something entirely unrelated here',
    ]);
    expect(match).toBeNull();
    expect(f.asked).toHaveLength(1); // only the 5432 pair was ambiguous
    expect(r.stats.judged).toBe(1);
  });

  it('uses the model verdict when it says the facts are the same', async () => {
    const f = fakeClient({ 'Statement B: runs on port 5432': true });
    const r = new Reconciler({ client: f.client });
    expect(await r.matchExisting('db.port', 'listens on 5432 by default', ['runs on port 5432'])).toBe('runs on port 5432');
  });

  it('caches a verdict instead of asking twice', async () => {
    const f = fakeClient({ '5432': true });
    const r = new Reconciler({ client: f.client });
    await r.matchExisting('db.port', 'listens on 5432 by default', ['runs on port 5432']);
    await r.matchExisting('db.port', 'listens on 5432 by default', ['runs on port 5432']);
    expect(f.asked).toHaveLength(1);
    expect(r.stats.cacheHits).toBe(1);
  });

  it('treats a judge failure as "not the same" so nothing is silently merged', async () => {
    const client = { messages: { parse: vi.fn(async () => { throw new Error('boom'); }) } } as never;
    const r = new Reconciler({ client });
    expect(await r.matchExisting('db.port', 'listens on 5432 by default', ['runs on port 5432'])).toBeNull();
  });

  it('returns null when there is nothing to compare against', async () => {
    const r = new Reconciler({ client: fakeClient({}).client });
    expect(await r.matchExisting('k', 'v', [])).toBeNull();
  });
});
