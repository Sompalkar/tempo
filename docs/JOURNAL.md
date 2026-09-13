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
