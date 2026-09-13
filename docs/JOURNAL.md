# Build journal

A plain-English log of what we built, what broke, and what we decided.
Newest entries at the bottom. Read DESIGN.md first if you have not.

---

## Day 1 — 2026-09-13

### What we set out to do

Build the core engine: a store that can `remember` facts, `recall` them with
two clocks (valid time and record time), and handle disagreement between
writers without silently picking a winner.

### Decisions

- **Node's built-in `node:sqlite` instead of `better-sqlite3`.** Node 26 ships
  SQLite in the box. No native compile step means `npm install` never fails
  on someone's machine, which matters a lot for something meant to be
  installed as a plugin in one command.
- **Plain numbers for time (ms since epoch), not `Date` objects.** They sort
  correctly in SQLite and compare with `<` and `>`. Less to get wrong.
- **Do the two-clock filtering in TypeScript, not SQL.** The SQL for "what
  was true at X as far as we knew at Y" gets ugly fast. Per-key row counts
  are small, so we pull rows for the org and filter in code where it reads
  like the design doc.
- **Every supersession is also written to the `conflicts` table as
  `resolved`.** So there is one place to look for "why did this fact get
  replaced?" — both automatic replacements and human resolutions leave the
  same kind of trail.

### Failure #1 — the code did not match the design, and the tests passed anyway

After all 20 tests went green on the first run, I re-read `store.ts`
against DESIGN.md and found a real bug.

The design says: two different writers who both gave *no* date and disagree
should produce a **conflict**. The code compared their `valid_from` values —
but when no date is given, `valid_from` is just "the time of the write". So
Alice writing on Monday and Bob disagreeing on Wednesday made Bob win,
silently, with the reason `newer-valid-time`. That is last-write-wins with
extra steps — exactly the thing we are building tempo to avoid.

Why the tests missed it: my conflict test had both writers write at the
*same* instant. Same time → same `valid_from` → conflict. Correct answer,
wrong reason. A test that passes for the wrong reason is worse than a
failing one.

The fix: a guessed time is never a reason to pick a winner. tempo now
checks `valid_from_explicit` on both sides before comparing times. If both
are guesses and the writers differ → conflict. Added three tests: the
different-days case (must conflict), the explicit-date case (dated fact
wins over undated), and an opt-in `prefer-newer` policy that guesses but
labels the guess in the trail.

Lesson: green tests tell you the code does what the *tests* say, not what
the *design* says. Re-read the design after the tests pass.

### Where things stand

- `src/store.ts` — the engine. `remember`, `recall`, `conflicts`, `resolve`, `get`.
- `src/store.test.ts` — 23 tests, each named as a sentence. They are the spec.
- No MCP server yet. No eval yet. No LLM anywhere yet — the engine is fully
  deterministic on purpose, so it can be tested without an API key.

### MCP server

`src/mcp.ts` wraps the store in four tools over stdio. The test for it is
the real thing: it spawns `dist/mcp.js` as a child process and talks to it
with the official MCP client. A second test spawns a *second* server
process as a different writer against the same SQLite file, so we know two
agents on one machine can share a store without stepping on each other
(SQLite WAL mode handles the locking).

Small choice worth noting: dates can be passed as ISO strings
(`"2026-03-01"`) because that is what an LLM will naturally produce. The
server converts; the engine only ever sees numbers.

### StaleBench

15 scenarios, four groups, three systems. tempo 15/15, last-write-wins
9/15, append-only 5/15.

The two baselines are not straw men. Each is a faithful model of a common
design — a KV map with overwrite, and a log you search — and both were
given writer/ref/org fields so they pass provenance and boundary for free.
They only fail on time and contradiction, which is the point.

The most telling baseline failures:

- **T5** — last-write-wins learns *old* history late (someone backfills the
  March policy in June) and it clobbers today's answer. This is a real
  failure mode when you ingest Slack history after the fact.
- **C1** — both baselines hide that two agents disagree. Last-write-wins
  returns one value with no warning; append-only returns both with no
  warning. Neither tells the reader there is a problem.

Honesty note, also in the README: we wrote the scenarios and the system.
15/15 proves the engine does what the design says, not that the design is
the best possible. The value is that the scenarios are specific and an
adapter is ~50 lines, so real systems can be added and compared.

### Where things stand (end of day 1)

- Engine, MCP server, StaleBench, README, this journal.
- 44 tests. All deterministic — no API keys, no network.
- Not done yet: a Claude Code hook that recalls automatically on each
  prompt; an ingestion path from real session transcripts; npm publish;
  a GitHub repo.

### Failure #2 and #3 — found by reading, not by tests

After the README was written I re-read `store.ts` one more time looking
for edge cases. Found two.

**#2 — a conflict that never closes.** Alice and Bob disagree, so a
conflict is open. Then Carol writes a *dated* fact that is newer than both.
Alice's and Bob's facts get superseded correctly, but the conflict row
stayed `open` forever, pointing at two facts that are no longer current.
Harmless for `recall` (it only shows conflicts touching returned facts),
but `tempo_conflicts` would list a ghost. Fix: when a fact is superseded,
any open conflict it is part of is closed with reason
`both-superseded:<why>` and the new fact as winner.

**#3 — SQL LIKE escaping was half done.** I escaped `%` and `_` in
prefix and query strings with a backslash, but never told SQLite
`ESCAPE '\'`. SQLite has no default escape character, so the backslash
was just a literal backslash and `_` still meant "any one character". A
key prefix like `deploy_prod.` would also match `deployXprod.`. Wrong
results, no error. Fix: add the `ESCAPE` clause and escape backslash too.

Both got a test. Both tests were checked to **fail on the old code** before
being trusted (`git stash` the fix, run, see red, `git stash pop`).

Lesson: after tests are green, read the code once more specifically
hunting for "what input would make this quietly wrong?" Quiet wrongness is
worse than a crash.

---

## Day 1, later — public repo and the Claude Code plugin

Repo is public: https://github.com/Sompalkar/tempo

### The hook

`src/hook.ts` runs before every prompt in Claude Code. It pulls the
meaningful words out of the prompt ("deploy", "billing", "postgres"),
searches memory for each, and hands the matching facts to Claude as extra
context. No LLM involved — it is a word match, on purpose: it runs in a few
milliseconds and cannot fail in interesting ways. If nothing matches it
prints nothing. If anything breaks it prints nothing and exits 0, because a
memory hiccup must never block someone's prompt.

Small engine change to support it: `recall({ query })` now searches keys as
well as values. A prompt says "deploy"; the key is `deploy.command`.

### Failure #4 — "prepare" never ran

Plan was: the plugin points at `dist/`, and a `prepare` script in
package.json builds `dist/` when Claude Code runs `npm ci` on install.
Claude Code does run `npm ci` — `node_modules/` appeared in the plugin
cache — but with lifecycle scripts disabled (sensible: you do not want a
plugin running arbitrary scripts on install). So no `dist/`, and the plugin
would have failed on first use.

Two fixes were possible: commit `dist/` (noisy, easy to forget to rebuild),
or run the TypeScript directly. Node 26 strips types natively with no flag,
so the plugin now runs `node src/mcp.ts` and `node src/hook.ts`. Imports
changed from `./store.js` to `./store.ts`; TypeScript's
`rewriteRelativeImportExtensions` still emits `.js` in `dist/` for the npm
package. The end-to-end tests now spawn the `.ts` files — the exact thing
the plugin runs — not the built output.

This is also a nicer story: no build step anywhere. Clone and it works.

### Failure #5 — the plugin was installed but "failed to load"

`claude plugin list` showed `✘ failed to load: Duplicate hooks file`.
`hooks/hooks.json` and `.mcp.json` are discovered automatically; naming
them again in `plugin.json` counts as loading them twice. Removed both
lines from the manifest. Now `✔ enabled`.

Lesson: "installed" and "working" are different states. Check the second
one.

### Failure #6 (not ours) — could not run the live demo yet

Wanted to drive real Claude Code headlessly: one session remembers, a
fresh session recalls via the hook. The CLI's login token had expired, so
this is waiting on a re-login. The hook and MCP paths are covered by the
end-to-end tests, but a real session is the proof that matters.

### How to install it (for the README)

```
claude plugin marketplace add Sompalkar/tempo
claude plugin install tempo@tempo
```

---

## Day 1, evening — the live demo found the worst bug so far

### The demo worked

Three real Claude Code sessions, three different writers, one shared store:

1. `agent-alice` → `tempo_remember` deploy.command = "make deploy" → **inserted**
2. `agent-bob` → same key, "./scripts/ship.sh" → **conflict**
3. `agent-carol` asked "what is our deploy command?" and got both, flagged.
   Its answer: *"there's a conflict... Neither is marked as the
   authoritative answer. You need to clarify which one is actually
   correct."*

That last line is the whole product in one sentence. A normal memory tool
would have told Carol "./scripts/ship.sh" with total confidence.

### Failure #7 — time travel silently returned nothing

Then the second half of the demo: store a refund policy that was "30 days"
from March and "14 days" from June, and ask an agent "what was the policy
in April?"

It answered **"No refund policy on record for that date."**

The data was stored perfectly — dumping the table showed the 30-day fact
with valid_from = March 1 and valid_to = June 1, exactly right. The bug
was in `recall`: after correctly filtering to facts true at `validAt`, it
then dropped any fact with `superseded_by` set unless you passed
`includeHistory: true`.

That is nonsense. A fact that was true in April **is** the answer to a
question about April. Being replaced in June does not make it history you
have to opt into. The flagship feature — the one the whole design is built
around — returned an empty result by default.

The fix: remove that second filter. The valid-time filter already excludes
anything that stopped being true before `validAt`. `superseded` goes back
to being a *label* ("this was replaced later"), not a filter.
`includeHistory` was redefined to mean something actually useful: return
the whole timeline for a key, ignoring `validAt`.

**The uncomfortable part.** StaleBench was passing T1 and P3 — the exact
scenarios this bug breaks. Why? Because my tempo adapter passed
`includeHistory: true` on every read. I wrote the adapter and the engine on
the same day and unconsciously compensated in the adapter for the engine's
bad default. The benchmark was measuring a configuration no real caller
would use.

Removing that one line from the adapter made T1 and P3 fail on the old
engine, and pass on the fixed one. The benchmark now tests the default path.

Lesson, and it is the same one as Failure #1 in a new costume: tests and
benchmarks written by the same person on the same day as the code will
quietly agree with the code. The only thing that caught this was driving
the real product with a real agent and reading the answer as a user would.

### Failure #8 — the CLI ate its own option values

`tempo recall --key refund.policy --valid-at 2026-04-15` returned nothing
even after the engine fix. The positional-argument parser filtered out
anything starting with `--` but kept the *values* after them, so the search
query became the literal string "refund.policy 2026-04-15", which matches
nothing. Fixed by teaching the parser which options take a value.

Small bug, but it is the kind that makes someone try your tool once and
conclude it does not work.

---

## Day 1, night — running it on real sessions

The first real ingest: 40 chunks from 15 RoboTrain sessions. Extraction
quality was good — real facts, real provenance. And then the numbers:

```
inserted: 258   corroborated: 33   conflict: 54
```

54 conflicts, and almost none were real:

```
auth.clerk.instance = "Both frontend and backend use Clerk instance driving-tapir-92.clerk.accounts.dev"
auth.clerk.instance = "driving-tapir-92.clerk.accounts.dev"
auth.clerk_instance = "driving-tapir-92"
```

Three sessions saying one thing three ways, plus key drift
(`auth.clerk.instance` / `auth.clerk_instance` / `backend.auth.clerk`).
The engine was right — those are different strings — but a tool that cries
wolf 54 times is a tool nobody keeps installed.

This is hard problem #1 from the essay arriving in person: contradiction
resolution cannot be string equality.

### Fix: fuzziness outside the engine

The temptation was to make the engine smarter. That would have been a
mistake — the engine is deterministic, which is the only reason it is
testable.

Instead, `src/reconcile.ts` sits in front of it. Before writing, it asks:
is this a rewording of a value we already hold? If yes, it writes **the
exact existing string**, so the engine sees agreement rather than a new
contradiction. The engine still only compares strings.

Three tiers, cheapest first:
1. exact match after normalising case and whitespace
2. token containment — every distinctive token of the short statement
   appears in the long one, so the long one is the short one plus prose
3. an LLM judge, only for pairs the first two cannot settle

On the real run: 64 decided for free, 45 judged, 7 from cache. Most
comparisons never cost anything.

### Failure #9 — the key fix overcorrected

Telling the extractor "REUSE THE EXACT KEY" fixed key drift and created
something worse: the model crammed unrelated facts into existing keys.

```
backend.database
  A  Connects to Modal and Supabase; worker polls jobs every ~5s
  B  schema_v2.sql is force-tracked because .gitignore ignores *.sql
```

Not a contradiction — two unrelated facts under one name. Conflicts went
*up*, to 82.

Softened to: reuse a key only when the fact is about exactly that topic,
otherwise make a new one, because "a wrong key is worse than a new one".
Also told it one fact per entry — "Uses FastAPI; worker polls every 5s" is
two facts, and joining them guarantees a false conflict later. Down to 37.

### Failure #10 — a race in the ingest pipeline

Still seeing obvious rewordings flagged as conflicts. The reconciler was
not broken; it was being skipped.

Ingest ran N workers, each doing read-current → reconcile → write. Two
workers handling the same key at the same time both read *nothing*, both
reconciled against *nothing*, and both wrote — inventing a contradiction
that never existed.

Read-then-write is not parallel-safe when the write depends on the read.
Split into two stages: extraction stays parallel (it is network-bound and
touches no shared state), while every write goes through one serialized
consumer. Slower on paper, correct in fact, and the write stage was never
the bottleneck.

### Failure #11 — the cheap tier was too confident

`"driving-tapir-92"` vs `"...instance is driving-tapir-92.clerk.accounts.dev"`
share no *exact* token, so tier 2 returned "different" and never asked the
judge. One is plainly the other spelled out. Now, when nothing is shared,
it checks whether any token is a prefix or suffix of another before
declaring a difference — and returns "unknown" so the judge decides.

The asymmetry is deliberate: a wrong "different" costs one visible conflict
someone can resolve; a wrong "same" silently destroys a fact. When unsure,
be noisy rather than lossy. The same rule is why a judge failure counts as
"not the same".

### Where it landed

| run | change | conflicts |
|---|---|---|
| 1 | no reconciliation | 54 (nearly all false) |
| 2 | + reconciler, keys forced | 82 (wrong keys) |
| 3 | + softened key rule | 37 |
| 4 | + near-miss check, serialized writes | **16** |

The 16 that remain are real judgement calls, not noise:

- `uvicorn app.main:app` vs `./venv/bin/uvicorn app.main:app` — materially
  different to act on; someone should decide
- `backend.python.version` = "3.11" vs "3.11.15" — precision
- `/health` vs `/api/v1/worker/stats` filed under one key

That is exactly where tempo should stop guessing and ask a person.

**Known limitation, stated plainly:** key drift is reduced, not solved.
`backend.startup.command` and `backend.launch.command` still coexist. A
fact filed under two names never meets itself, so a real contradiction
between them would go unnoticed. Merging near-duplicate keys is the next
piece of work.
