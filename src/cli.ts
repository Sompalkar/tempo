#!/usr/bin/env node
/**
 * tempo command line.
 *
 *   tempo ingest [options]     read Claude Code sessions -> facts -> memory
 *   tempo recall <query>       search memory
 *   tempo conflicts            show facts that disagree
 *   tempo report               what ingest found: conflicts, supersessions
 *
 * Ingest is the only command that costs money (one Haiku call per chunk).
 * It prints the estimated number of calls and waits for confirmation unless
 * --yes is passed.
 */
import { createInterface } from 'node:readline/promises';
import { homedir } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { TempoStore } from './store.ts';
import { formatFacts } from './format.ts';
import { extractFacts } from './extract.ts';
import { Reconciler } from './reconcile.ts';
import { defaultLLM } from './llm.ts';
import { chunkSession, findSessions, type Chunk } from './ingest/claude-code.ts';
import { KeyedQueue } from './ingest/keyed-queue.ts';
import type { RememberAction } from './types.ts';

const args = process.argv.slice(2);
const cmd = args[0] ?? 'help';

/** Options that take a value. Their value must not be mistaken for a positional word. */
const VALUED = new Set(['project', 'sessions', 'chunks', 'concurrency', 'limit', 'key', 'valid-at', 'as-of', 'status']);

function flag(name: string): boolean {
  return args.includes(`--${name}`);
}
function opt(name: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}
/** Words after the subcommand that are not options or option values. */
export function positionals(argv: string[]): string[] {
  const out: string[] = [];
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith('--')) {
      if (VALUED.has(a.slice(2))) i++; // skip this option's value
      continue;
    }
    out.push(a);
  }
  return out;
}

const dbPath = process.env['TEMPO_DB'] ?? join(homedir(), '.tempo', 'tempo.db');
const org = process.env['TEMPO_ORG'] ?? 'default';
mkdirSync(dirname(dbPath), { recursive: true });

function openStore(): TempoStore {
  return new TempoStore(dbPath);
}

async function confirm(question: string): Promise<boolean> {
  if (flag('yes')) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const a = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
  rl.close();
  return a === 'y' || a === 'yes';
}

// ---------------------------------------------------------------------------

async function ingest(): Promise<void> {
  const projects = opt('project')?.split(',');
  const limitSessions = Number(opt('sessions') ?? '0') || undefined;
  const limitChunks = Number(opt('chunks') ?? '0') || undefined;
  const concurrency = Number(opt('concurrency') ?? '6');

  const findOpts: Parameters<typeof findSessions>[0] = {};
  if (projects) findOpts.projects = projects;
  let sessions = findSessions(findOpts);
  if (limitSessions) sessions = sessions.slice(0, limitSessions);

  const store = openStore();
  const chunkRef = (c: Chunk) => `${c.sessionId}#${c.index}`;

  let chunks: Chunk[] = [];
  for (const s of sessions) chunks.push(...chunkSession(s));
  // Oldest first, so the store learns history in the order it happened.
  chunks.sort((a, b) => a.at - b.at);
  // Skip what a previous run already finished. Makes ingest safe to re-run
  // (a nightly cron, or resuming after a crash) without double-counting.
  const total = chunks.length;
  chunks = chunks.filter((c) => !store.isIngested(org, chunkRef(c)));
  const skipped = total - chunks.length;
  if (limitChunks) chunks = chunks.slice(0, limitChunks);

  if (chunks.length === 0) {
    console.log(skipped ? `Nothing new: all ${skipped} chunk(s) already ingested.` : 'No sessions found.');
    store.close();
    return;
  }

  console.log(`${sessions.length} session(s), ${chunks.length} chunk(s)${skipped ? ` (${skipped} already done, skipped)` : ''}.`);
  console.log(`That is ${chunks.length} model call(s) via ${defaultLLM().name}. Writing to ${dbPath} (org "${org}").`);
  if (!(await confirm('Run it?'))) {
    console.log('Stopped.');
    store.close();
    return;
  }

  const counts: Record<RememberAction, number> = {
    inserted: 0,
    corroborated: 0,
    superseded: 0,
    backfilled: 0,
    conflict: 0,
    'skipped-private': 0,
  };
  let dropped = 0;
  let failed = 0;
  let done = 0;

  const llm = defaultLLM();
  const reconciler = new Reconciler({ llm });
  let reconciled = 0;

  // Two stages on purpose.
  //
  // Extraction is network-bound and touches no shared state, so it runs
  // several chunks at once.
  //
  // Writing is only parallel-safe ACROSS keys. What a new fact does depends
  // on what is already stored under its key, so two writes to the same key
  // must not interleave (JOURNAL, failure #10). Writes to different keys
  // never look at each other, so they overlap freely. KeyedQueue enforces
  // exactly that. A fully serialized writer was tried first and fell hours
  // behind extraction on a real run.
  const queue = [...chunks];
  const writes = new KeyedQueue(concurrency);

  const writeFact = async (fact: { key: string; value: string; validFrom: string }, chunk: Chunk): Promise<void> => {
    // Is this just a rewording of something we already hold? If so, write
    // the EXACT existing string so the engine sees agreement rather than a
    // new contradiction. The engine stays a string comparison; the
    // fuzziness lives out here. See reconcile.ts.
    let value = fact.value;
    const existing = store.currentValues(org, fact.key);
    if (existing.length > 0 && !existing.includes(value)) {
      const match = await reconciler.matchExisting(fact.key, value, existing);
      if (match !== null) {
        value = match;
        reconciled++;
      }
    }
    const input: Parameters<TempoStore['remember']>[0] = {
      org,
      key: fact.key,
      value,
      source: { writer: `session:${chunk.sessionId.slice(0, 8)}`, kind: 'session', ref: chunkRef(chunk) },
      now: chunk.at,
    };
    if (fact.validFrom) input.validFrom = Date.parse(fact.validFrom);
    counts[store.remember(input).action]++;
  };

  const extractor = async (): Promise<void> => {
    for (;;) {
      const chunk = queue.shift();
      if (!chunk) return;
      try {
        const { kept, dropped: bad } = await extractFacts(chunk.text, {
          sourceLabel: `Claude Code session "${chunk.title}" in ${chunk.project}`,
          llm,
          knownKeys: store.keys(org, 50),
        });
        dropped += bad.length;
        const settled: Promise<unknown>[] = [];
        for (const fact of kept) {
          settled.push(
            writes.add(fact.key, () => writeFact(fact, chunk)).catch((e: unknown) => {
              failed++;
              if (failed <= 3) console.error(`  write failed: ${(e as Error).message}`);
            }),
          );
        }
        // Only mark the chunk done once every one of its facts has landed.
        void Promise.all(settled).then(() => store.markIngested(org, chunkRef(chunk)));
      } catch (e) {
        failed++;
        if (failed <= 3) console.error(`\n  chunk failed: ${(e as Error).message}`);
        if (failed === 3) console.error('  (further failures counted silently; re-run ingest to retry them)');
      }
      done++;
      if (done % 10 === 0 || done === chunks.length) {
        process.stderr.write(`\r  extracted ${done}/${chunks.length} chunks…`);
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, () => extractor()));
  process.stderr.write('\n  finishing writes…');
  await writes.drain();
  process.stderr.write('\n');

  console.log('\nDone.');
  for (const [k, v] of Object.entries(counts)) if (v) console.log(`  ${k}: ${v}`);
  if (reconciled) console.log(`  rewordings merged instead of flagged: ${reconciled}`);
  console.log(`  same/different decided without an LLM: ${reconciler.stats.cheap}, judged: ${reconciler.stats.judged}, cached: ${reconciler.stats.cacheHits}`);
  if (dropped) console.log(`  malformed facts dropped: ${dropped}`);
  if (failed) console.log(`  chunks that failed: ${failed}`);
  store.close();
}

function recall(): void {
  const query = positionals(args).join(' ');
  const store = openStore();
  const input: Parameters<TempoStore['recall']>[0] = { org, limit: Number(opt('limit') ?? '20') };
  if (query) input.query = query;
  if (opt('key')) input.key = opt('key')!;
  if (opt('valid-at')) input.validAt = Date.parse(opt('valid-at')!);
  if (opt('as-of')) input.asOf = Date.parse(opt('as-of')!);
  if (flag('history')) input.includeHistory = true;
  const r = store.recall(input);
  console.log(formatFacts(r.facts, r.conflicts));
  store.close();
}

function conflicts(): void {
  const store = openStore();
  const list = store.conflicts(org, { status: (opt('status') as 'open' | 'resolved' | 'all') ?? 'open' });
  if (list.length === 0) {
    console.log('No conflicts.');
  } else {
    for (const c of list) {
      const a = store.get(org, c.aId);
      const b = store.get(org, c.bId);
      console.log(`${c.status}  ${c.key}`);
      console.log(`   A  ${a?.value ?? '?'}`);
      console.log(`      ${a?.source.writer ?? '?'} · ${a?.source.ref ?? ''}`);
      console.log(`   B  ${b?.value ?? '?'}`);
      console.log(`      ${b?.source.writer ?? '?'} · ${b?.source.ref ?? ''}`);
      if (c.winnerId) console.log(`   winner: ${c.winnerId === c.aId ? 'A' : 'B'} (${c.reason})`);
      console.log();
    }
  }
  store.close();
}

/** What did ingest actually find? The interesting part is disagreement over time. */
function report(): void {
  const store = openStore();
  const all = store.recall({ org, limit: 100000, includeHistory: true });
  const open = store.conflicts(org, { status: 'open' });
  const resolved = store.conflicts(org, { status: 'resolved' });
  const superseded = all.facts.filter((f) => f.status === 'superseded');
  const corroborated = all.facts.filter((f) => f.confirmations > 1);

  console.log(`facts stored ............ ${all.facts.length}`);
  console.log(`still current ........... ${all.facts.filter((f) => f.status !== 'superseded').length}`);
  console.log(`superseded (changed) .... ${superseded.length}`);
  console.log(`confirmed by 2+ sources . ${corroborated.length}`);
  console.log(`open conflicts .......... ${open.length}`);
  console.log(`auto-resolved ........... ${resolved.length}`);

  if (superseded.length) {
    console.log('\nThings that changed over time:');
    for (const f of superseded.slice(0, 10)) {
      const now = store.recall({ org, key: f.key, limit: 1 }).facts[0];
      console.log(`  ${f.key}`);
      console.log(`    was: ${f.value}`);
      console.log(`    now: ${now?.value ?? '(nothing current)'}`);
    }
  }
  if (open.length) {
    console.log('\nDisagreements nobody has settled:');
    for (const c of open.slice(0, 10)) {
      console.log(`  ${c.key}`);
      console.log(`    A: ${store.get(org, c.aId)?.value}`);
      console.log(`    B: ${store.get(org, c.bId)?.value}`);
    }
  }
  store.close();
}

// ---------------------------------------------------------------------------

const help = `tempo — memory that knows when things stopped being true

  tempo ingest [--project <slug,...>] [--sessions N] [--chunks N] [--yes]
        Read Claude Code sessions, pull out durable facts, store them.
        One Haiku call per chunk. Runs on your Claude Code subscription by
        default (TEMPO_LLM=claude); set ANTHROPIC_API_KEY for the faster API path.

  tempo recall <words...> [--key <k>] [--valid-at <date>] [--as-of <date>] [--history]
        Search memory. --valid-at asks "what was true then";
        --as-of asks "what did we know then".

  tempo conflicts [--status open|resolved|all]
        Facts that disagree.

  tempo report
        What ingest found: what changed, what disagrees.

Environment: TEMPO_DB (${dbPath}), TEMPO_ORG (${org}), TEMPO_LLM (claude|api), ANTHROPIC_API_KEY`;

switch (cmd) {
  case 'ingest':
    await ingest();
    break;
  case 'recall':
    recall();
    break;
  case 'conflicts':
    conflicts();
    break;
  case 'report':
    report();
    break;
  default:
    console.log(help);
}
