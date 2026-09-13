# Demo script

Two minutes. Every command below was run for real; nothing is mocked.

## Setup (off camera)

```bash
claude plugin marketplace add Sompalkar/tempo
claude plugin install tempo@tempo
export TEMPO_DB=~/.tempo/demo.db TEMPO_ORG=acme
```

## Part 1 — two agents disagree (45s)

Three separate Claude Code sessions, three different writers, one shared memory.

**Session 1 — Alice**
```bash
echo "Use tempo_remember to store key 'deploy.command' with value 'make deploy'." \
  | TEMPO_WRITER=agent-alice claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember
```
> Tempo inserted the fact.

**Session 2 — Bob**
```bash
echo "Use tempo_remember to store key 'deploy.command' with value './scripts/ship.sh'." \
  | TEMPO_WRITER=agent-bob claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember
```
> The tool returned a conflict — there's an existing fact that deploy.command is "make deploy".

**Session 3 — Carol, who just wants to deploy**
```bash
echo "What is our deploy command? Check team memory first." \
  | TEMPO_WRITER=agent-carol claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_recall
```
> Based on team memory, **there's a conflict** — two different deploy commands are recorded:
> 1. `./scripts/ship.sh` (recorded by agent-bob)
> 2. `make deploy` (recorded by agent-alice)
>
> Neither is marked as the authoritative answer. **You need to clarify which one is actually correct.**

**The point:** every other memory tool would have told Carol `./scripts/ship.sh` with total confidence, because Bob wrote last. tempo told her the truth: two agents disagree, here's who said what, go ask.

## Part 2 — time travel (45s)

**Store a policy that changed**
```bash
echo "tempo_remember: key 'refund.policy', value '30 days', validFrom '2026-03-01'. Then key 'refund.policy', value '14 days', validFrom '2026-06-01'." \
  | claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember
```
> Call 1: inserted. Call 2: superseded.

**Ask about the past**
```bash
echo "A customer is disputing an April 2026 charge. What was our refund policy then, and what is it now?" \
  | claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_recall
```
> April 2026: **30 days** (superseded June 1)
> Today: **14 days**

**The point:** the March fact was not overwritten. It was *closed*, with the date it stopped being true, and it still answers questions about April. A last-write-wins store would say "14 days" and the customer would get the wrong answer.

## Part 3 — on my own history (30s)

```bash
TEMPO_ORG=som tempo report
```

Show the real numbers from ingesting 68 of my own Claude Code sessions:
facts found, things that changed over time, disagreements between my own
past sessions that I never noticed.

```bash
TEMPO_ORG=som tempo conflicts
```

Pick one. `uvicorn app.main:app` vs `./venv/bin/uvicorn app.main:app` —
two sessions three weeks apart, and one of them would fail on a clean
machine. tempo found it; I hadn't.

## Close (10s)

- Repo: github.com/Sompalkar/tempo
- 96 tests, StaleBench 15/15 vs last-write-wins 9/15
- `docs/JOURNAL.md`: 11 bugs found and fixed, written up honestly — including the one where the benchmark was passing only because I'd unconsciously worked around the bug in the adapter.
