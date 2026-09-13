# tempo — design

*Memory for AI agents that knows when things stopped being true.*

This document explains what tempo is, why it exists, and how it works.
It is written in plain English on purpose. If something here is unclear,
that is a bug in the document.

---

## 1. The problem

Most "memory" tools for AI agents work like a notebook: an agent writes a
fact, and later some agent reads it back. That is fine when **one** agent
writes to **its own** notebook.

It breaks when a **whole company's agents share one notebook**. Four things
go wrong (these are the four problems Nikos Dritsakos names in
"Single-tenant memory is the wrong default for agents"):

| # | Problem | What goes wrong |
|---|---------|-----------------|
| 1 | **Contradiction** | Agent A writes "deploy with `make deploy`". Agent B writes "deploy with `./scripts/ship.sh`". Most tools keep whichever was written last. Nobody notices they disagree. |
| 2 | **Time** | The refund policy in March was "30 days". In June it changed to "14 days". A tool with no idea of *when* a fact was true will happily tell you "30 days" in July. |
| 3 | **Provenance** | A fact shows up with no trail back to where it came from. You cannot check it, so a wrong fact becomes a confident rumor. |
| 4 | **Boundaries** | Company A's memory must never leak into Company B's. And sometimes you are working on something sensitive and want to write *nothing* at all. |

tempo is a small memory engine built to get these four things right.

---

## 2. The core idea: every fact has two clocks

tempo stores **observations**. An observation is one fact about one thing.

```
key:   "deploy.command"
value: "make deploy"
```

Every observation carries **two different times**. This is the single most
important idea in tempo:

| Clock | Field | Question it answers |
|-------|-------|---------------------|
| **Valid time** | `valid_from` → `valid_to` | *When was this true in the real world?* |
| **Record time** | `recorded_at` | *When did we learn it?* |

Why two clocks? Because they are different questions:

- "What was the refund policy in March?" is a **valid-time** question.
- "What did our agents *believe* the refund policy was, back on March 5th?"
  is a **record-time** question. (This is what you need to replay an old
  agent session honestly — the agent must not see facts learned later.)

A database that tracks both is called **bitemporal**. It is an old idea from
accounting and legal systems. It is exactly right for shared agent memory,
and almost no agent memory tool does it.

`valid_to` is `null` while a fact is still true as far as we know.

---

## 3. Provenance: every fact remembers where it came from

Every observation stores:

```
writer:      who wrote it   (an agent id, a person, a bot)
source_kind: session | slack | github | doc | manual | ...
source_ref:  a pointer     (session id, message URL, commit sha)
```

When tempo returns a fact, it returns the provenance with it. An agent (or a
person) can always ask "says who?" and get an answer.

---

## 4. Writing: what happens when a new fact arrives

This is where contradictions are handled. When a new observation arrives for
a `key` that already has a **current** fact (one with `valid_to = null`),
tempo compares them:

| Situation | What tempo does | Why |
|-----------|-----------------|-----|
| Same value | **Corroborate.** No new row. Bump a confirmation count. | Two agents agreeing is evidence, not a duplicate. |
| Different value, **neither** side gave a date, **different** writers | **Open a conflict.** Both stay current. Both are returned, flagged. | A guessed time is not a reason to pick a winner. This is the case most tools get wrong. |
| Different value, new one has a **later** `valid_from` | **Supersede.** Old fact gets `valid_to` = new `valid_from`. Old fact is kept, marked `superseded_by`. | The world changed. The old fact was true, then stopped being true. |
| Different value, new one has an **earlier** `valid_from` | **Backfill.** New fact is inserted already closed (`valid_to` = old `valid_from`). | We are learning history, not changing the present. |
| Different value, **same** `valid_from`, same writer | **Supersede.** | The writer is correcting itself. |
| Different value, **same** `valid_from`, different writers | **Open a conflict.** | We genuinely do not know who is right. |

One subtle rule, and it is the heart of the design: if a writer does **not**
say when a fact became true, tempo uses "now" *but remembers that this was a
guess* (`valid_from_explicit = false`). Two different writers who both just
said "here's the deploy command" with no dates get a **conflict**, not a
winner — even if they said it on different days. A winner is only picked
when there is a real reason: an explicit date, or the same writer correcting
itself.

This is the concrete meaning of "not last-write-wins".

If you *want* tempo to guess, you can opt in:
`new TempoStore(path, { onUndatedDisagreement: 'prefer-newer' })`. It will
then pick the more recently recorded fact, but it writes
`reason = "policy:prefer-newer-undated"` into the trail so anyone reading
later can see it was a guess, not knowledge. The default is `'conflict'`.

Conflicts can be resolved later with `resolve(conflictId, winnerId, reason)`.
The resolution is itself recorded with its own `recorded_at`, so history
stays honest.

---

## 5. Reading: `recall`

```
recall({ org, key?, query?, validAt?, asOf? })
```

- `key` — exact key or a prefix (`"deploy."` matches `"deploy.command"`).
- `query` — plain text search over values.
- `validAt` — "what was true at this moment?" Defaults to now.
- `asOf` — "what did we know at this moment?" Defaults to now.
  Anything recorded after `asOf` is invisible, **including** supersessions
  that happened after `asOf`. So an as-of query from before a fact was
  replaced still sees the old fact as current. This is what makes honest
  replay possible.
- `includeHistory` — return the whole timeline for the matched keys,
  ignoring `validAt`. Off by default.

Every returned fact carries a `status`:

- `current` — true at `validAt`, no open conflict
- `conflicted` — true at `validAt`, but another current fact disagrees
- `superseded` — true at `validAt`, but replaced by something newer since

That last one is a **label, not a filter**. If you ask about April and the
April fact was replaced in June, you still get the April fact — it is the
answer to your question. The label just tells you it is no longer current.
(An earlier version hid superseded facts unless you asked for history. That
made time-travel queries return nothing by default. See JOURNAL, failure #7.)

---

## 5b. Rewordings are not disagreements

The engine compares values with `===`. That is deliberate — it keeps the
engine deterministic and testable. But two agents describing one fact
rarely produce identical strings:

```
"driving-tapir-92.clerk.accounts.dev"
"Both frontend and backend use Clerk instance driving-tapir-92.clerk.accounts.dev"
```

Treating those as a conflict is noise, and on the first real ingest it
was most of the noise: 54 conflicts, almost none real.

The rule: **fuzziness lives outside the engine.** `src/reconcile.ts` runs
before a write and asks "is this a rewording of a value we already hold?"
If yes, it writes the *exact existing string*, so the engine sees
agreement. The engine never learns about fuzzy matching.

Three tiers, cheapest first:

1. exact match after normalising case and whitespace
2. the short statement's distinctive tokens all appear in the long one
3. an LLM judge, only for pairs the first two cannot settle

When unsure, it says "different". A wrong "different" is one visible
conflict a person can resolve. A wrong "same" silently loses a fact.

## 6. Boundaries

- Every observation belongs to an `org`. Every query is scoped to an `org`.
  There is no API that reads across orgs. This is enforced in the store, not
  left to callers.
- `remember({ ..., private: true })` writes **nothing** and says so. This is
  the "private mode" from the essay: a hard off switch, not a visibility flag.

---

## 7. What tempo is NOT (on purpose)

- Not a vector database. Text search is plain SQL. Embeddings can be added
  later as a layer; they are not the hard part.
- Not a framework. It is a small library with a small API, plus an MCP
  server so any agent can use it.
- Not magic. It does not know which of two disagreeing agents is right. It
  refuses to pretend it does.

---

## 8. Storage

One SQLite file, using Node's built-in `node:sqlite`. No native compile
step, no server, nothing to install. Two tables:

- `observations` — the facts, with both clocks and provenance
- `conflicts` — pairs of facts that disagree, and how (if) they were resolved

See `src/schema.ts` for the exact columns. Every column has a comment.
