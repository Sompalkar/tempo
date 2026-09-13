# tempo

**Memory for AI agents that knows when things stopped being true.**

Most agent memory is a notebook: write a fact, read it back later. That works
for one agent. It breaks the moment a *company's* agents share one notebook:

- Two agents disagree, and the store silently keeps whichever wrote last.
- A fact that was true in March is served as truth in July.
- A fact shows up with no trail back to who said it or where.

tempo is a small, deterministic memory engine built to get those three things
right, plus a hard org boundary. One SQLite file. No server. No native build.
Ships as a library and as an MCP server so Claude Code, Codex, Cursor, or your
own agent can use it in one config line.

```
claude plugin marketplace add Sompalkar/tempo
claude plugin install tempo@tempo
```

That gives Claude Code the four `tempo_*` tools and a hook that recalls
relevant facts before every prompt. No build step — Node 26 runs the
TypeScript directly.

## The idea in one table

Every fact carries **two clocks** and **a source**:

| Field | Question it answers |
|---|---|
| `valid_from` → `valid_to` | *When was this true in the real world?* |
| `recorded_at` | *When did we learn it?* |
| `writer`, `source_kind`, `source_ref` | *Says who? Where?* |

Two clocks let you ask two different questions:

- `recall({ key, validAt: "2026-05-01" })` — *what was the refund policy in May?*
- `recall({ key, asOf: "2026-04-01" })` — *what did our agents believe on April 1st?*
  (Everything learned after April 1st is invisible — including facts that
  were later replaced. This is what lets you replay an old agent session honestly.)

## What happens when agents disagree

When a new fact arrives for a key that already has one, tempo does **not**
just overwrite:

| Situation | tempo does |
|---|---|
| Same value | Corroborate (one fact, confirmation count +1) |
| Different value, new one has a **later** date | Supersede — old fact kept, closed, points at its replacement |
| Different value, new one has an **earlier** date | Backfill — filed as history, present untouched |
| Different value, same writer | Self-correction — supersede |
| Different value, **different writers, no dates** | **Open a conflict.** Both returned, both flagged. |

That last row is the whole point. A guessed timestamp is not a reason to pick
a winner. tempo only picks one when there is a real reason (an explicit date,
or a writer correcting itself). Otherwise it tells you two agents disagree and
lets you — or a policy you opt into — resolve it. The resolution and its reason
are kept forever.

### Rewordings are not disagreements

Two agents rarely describe one fact with identical strings. Before a write,
tempo checks whether the new value is just a rewording of one it already
holds — exact match first, then token containment, then a small LLM judge
only for the pairs those can't settle. If so it writes the existing string,
so the engine sees agreement. The engine itself stays a deterministic string
comparison; the fuzziness lives in front of it, where it can fail safe
("different" when unsure, never "same").

On a real ingest this took false conflicts from 54 down to 16, and the 16
that remain are genuine judgement calls (`uvicorn` vs `./venv/bin/uvicorn`,
`3.11` vs `3.11.15`).

Full design with reasoning: [docs/DESIGN.md](docs/DESIGN.md).

## StaleBench

A small, reproducible eval for exactly these problems. 15 scenarios across
four groups — temporal, contradiction, provenance, boundary — each one a
sentence you can read. Run against tempo and two baselines that model how
most memory tools behave:

| | last-write-wins | append-only | tempo |
|---|:---:|:---:|:---:|
| temporal (5) | 2 | 1 | 5 |
| contradiction (5) | 3 | 0 | 5 |
| provenance (3) | 2 | 2 | 3 |
| boundary (2) | 2 | 2 | 2 |
| **total** | **9/15** | **5/15** | **15/15** |

```
npm run bench          # prints the table and what each system actually returned
```

Full results, including what every system returned for every scenario:
[bench/RESULTS.md](bench/RESULTS.md).

**Honesty note.** We wrote both the scenarios and tempo, so 15/15 proves less
than it looks. The baselines are faithful models of common designs, not straw
men — they get provenance and org scoping for free so they are only tested on
the hard part. The useful thing is that adding a real system is ~50 lines
(`src/bench/adapter.ts`). If you maintain a memory tool and think your system
passes these, add an adapter and open a PR. We will run it and publish the row.

## Run it on your own sessions

tempo can read your Claude Code transcripts, pull out the durable facts
(commands, decisions, config, gotchas), and tell you what changed over time
and where your own past sessions disagree with each other.

```
tempo ingest --sessions 10   # reads ~/.claude/projects, asks before running
tempo report                 # what changed, what disagrees
tempo conflicts              # the disagreements, with who said what
tempo recall deploy          # search
```

**No API key needed.** By default ingest runs on your existing Claude Code
subscription (`claude -p` under the hood, Haiku, ~8s a chunk). Set
`ANTHROPIC_API_KEY` and it switches to the API for speed; `TEMPO_LLM=claude|api`
forces either.

The extractor is told: if the text does not say *when* a fact became true,
leave the date empty. Inventing a date would hand the engine a fake reason
to pick a winner.

<!-- FULL_RUN_NUMBERS -->

## Using it

### As a library

```ts
import { TempoStore } from 'tempo';

const store = new TempoStore('./team.db');

store.remember({
  org: 'acme',
  key: 'refund.policy',
  value: '14 days',
  validFrom: Date.parse('2026-06-01'),
  source: { writer: 'agent-bob', kind: 'slack', ref: 'https://slack/msg/42' },
});

const { facts, conflicts } = store.recall({ org: 'acme', key: 'refund.policy' });
```

`remember` returns what it did: `inserted | corroborated | superseded | backfilled | conflict | skipped-private`.

### As a Claude Code plugin (hook + tools)

```
claude plugin marketplace add Sompalkar/tempo
claude plugin install tempo@tempo
```

Before every prompt, the hook looks up facts whose key or value mentions a
word from your prompt and adds them as context. Claude can save new facts
with `tempo_remember`.

### As an MCP server (Codex, Cursor, anything)

```
claude mcp add tempo -e TEMPO_ORG=acme -e TEMPO_WRITER=som -- node /path/to/tempo/src/mcp.ts
```

Four tools: `tempo_remember`, `tempo_recall`, `tempo_conflicts`, `tempo_resolve`.
Dates can be passed as ISO strings. Configuration by env:

| var | default | meaning |
|---|---|---|
| `TEMPO_DB` | `~/.tempo/tempo.db` | the SQLite file |
| `TEMPO_ORG` | `default` | hard boundary; nothing is read across orgs |
| `TEMPO_WRITER` | `$USER@$HOST` | who this agent is, for provenance |
| `TEMPO_POLICY` | `conflict` | or `prefer-newer` to auto-resolve undated disagreements (labelled as a guess) |

### Private mode

`remember({ ..., private: true })` writes nothing and says so. A hard off
switch for sensitive work, not a visibility flag.

## What tempo is not

- Not a vector database. Search is plain SQL. Embeddings can sit on top; they
  are not the hard part.
- Not a framework. ~600 lines of engine, six public methods.
- Not magic. It does not know which of two disagreeing agents is right, and it
  refuses to pretend.

## Development

```
npm install
npm test          # builds, then 103 tests: engine, MCP + hook end-to-end, extractor, reconciler, StaleBench guard
npm run bench     # StaleBench table
```

Tests are written as sentences; they are the spec. The build journal —
what broke, what we decided, and why — is in [docs/JOURNAL.md](docs/JOURNAL.md).

## Why this exists

Nikos Dritsakos's essay [*Single-tenant memory is the wrong default for
agents*](https://dev.to/nikos_dritsakos_a207771fb/single-tenant-memory-is-the-wrong-default-for-agents-49no)
names four problems that appear the moment memory is shared across an org —
contradiction, time, provenance, boundaries — and argues they are "the cost of
admission and also the moat." Almost every open-source memory tool defines
them out of scope. tempo is an attempt to take them seriously in as little
code as possible, with a benchmark so the claims can be checked.
