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
