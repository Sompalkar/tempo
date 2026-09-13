# StaleBench results

Each row is one scenario. Each column is one memory system. PASS means the system gave the correct answer.

| id | scenario | last-write-wins | append-only | tempo |
|---|---|:---:|:---:|:---:|
| **temporal** | |  |  |  |
| T1 | Policy was "30 days" from March, "14 days" from June. Asked about May, answer must be "30 days" only. | FAIL | FAIL | PASS |
| T2 | Same history. Asked about July, answer must be "14 days" only. | PASS | FAIL | PASS |
| T3 | Replay: asked "what did we know in April?" (before the June write happened), answer must be "30 days", not flagged. | FAIL | PASS | PASS |
| T4 | History learned late: June fact written first, March fact written afterwards. Asked about May, answer must still be "30 days". | PASS | FAIL | PASS |
| T5 | Same late-learned history. Asked about today, answer must be "14 days" — the late write must not clobber the present. | FAIL | FAIL | PASS |
| **contradiction** | |  |  |  |
| C1 | Alice says deploy is "make deploy". Two days later Bob says "./ship.sh". Neither gave a date. Both must come back, flagged as disagreeing. | FAIL | FAIL | PASS |
| C2 | Alice says X, then Alice says Y (correcting herself). Only Y must come back, and not flagged. | PASS | FAIL | PASS |
| C3 | Alice and Bob both say "make deploy". Exactly one fact must come back, not two copies. | PASS | FAIL | PASS |
| C4 | After a disagreement is resolved in favour of Bob, only Bob's value must come back, unflagged. | FAIL | FAIL | PASS |
| C5 | Bob disagrees with Alice but gives an explicit later date. That IS a reason: Bob's value must win, unflagged. | PASS | FAIL | PASS |
| **provenance** | |  |  |  |
| P1 | Every returned fact must say who wrote it. | PASS | PASS | PASS |
| P2 | When the writer gave a source pointer (a Slack link), the returned fact must carry it. | PASS | PASS | PASS |
| P3 | A fact that was replaced must still be retrievable for the time it was true, with its original writer. | FAIL | FAIL | PASS |
| **boundary** | |  |  |  |
| B1 | A fact written in org "acme" must be invisible to org "globex". | PASS | PASS | PASS |
| B2 | A write in private mode must leave no trace. | PASS | PASS | PASS |

| | last-write-wins | append-only | tempo |
|---|:---:|:---:|:---:|
| **total** | 9/15 | 5/15 | 15/15 |

## Systems

- **last-write-wins** — one value per key; newest write silently replaces the old one
- **append-only** — keeps every write; returns all of them; no idea which is current
- **tempo** — bitemporal, provenance on every fact, conflicts surfaced not guessed

## What each system actually returned

### T1 — Policy was "30 days" from March, "14 days" from June. Asked about May, answer must be "30 days" only.

- last-write-wins: FAIL — 14 days by agent-bob
- append-only: FAIL — 30 days by agent-alice | 14 days by agent-bob
- tempo: PASS — 30 days by agent-alice

### T2 — Same history. Asked about July, answer must be "14 days" only.

- last-write-wins: PASS — 14 days by agent-bob
- append-only: FAIL — 30 days by agent-alice | 14 days by agent-bob
- tempo: PASS — 14 days by agent-bob

### T3 — Replay: asked "what did we know in April?" (before the June write happened), answer must be "30 days", not flagged.

- last-write-wins: FAIL — (nothing)
- append-only: PASS — 30 days by agent-alice
- tempo: PASS — 30 days by agent-alice

### T4 — History learned late: June fact written first, March fact written afterwards. Asked about May, answer must still be "30 days".

- last-write-wins: PASS — 30 days by agent-alice
- append-only: FAIL — 14 days by agent-bob | 30 days by agent-alice
- tempo: PASS — 30 days by agent-alice

### T5 — Same late-learned history. Asked about today, answer must be "14 days" — the late write must not clobber the present.

- last-write-wins: FAIL — 30 days by agent-alice
- append-only: FAIL — 14 days by agent-bob | 30 days by agent-alice
- tempo: PASS — 14 days by agent-bob

### C1 — Alice says deploy is "make deploy". Two days later Bob says "./ship.sh". Neither gave a date. Both must come back, flagged as disagreeing.

- last-write-wins: FAIL — ./ship.sh by agent-bob
- append-only: FAIL — make deploy by agent-alice | ./ship.sh by agent-bob
- tempo: PASS — ./ship.sh [conflicted] by agent-bob | make deploy [conflicted] by agent-alice

### C2 — Alice says X, then Alice says Y (correcting herself). Only Y must come back, and not flagged.

- last-write-wins: PASS — 5433 by agent-alice
- append-only: FAIL — 5432 by agent-alice | 5433 by agent-alice
- tempo: PASS — 5433 by agent-alice

### C3 — Alice and Bob both say "make deploy". Exactly one fact must come back, not two copies.

- last-write-wins: PASS — make deploy by agent-bob
- append-only: FAIL — make deploy by agent-alice | make deploy by agent-bob
- tempo: PASS — make deploy by agent-alice

### C4 — After a disagreement is resolved in favour of Bob, only Bob's value must come back, unflagged.

- last-write-wins: FAIL — (system has no way to resolve a disagreement)
- append-only: FAIL — (system has no way to resolve a disagreement)
- tempo: PASS — ./ship.sh by agent-bob

### C5 — Bob disagrees with Alice but gives an explicit later date. That IS a reason: Bob's value must win, unflagged.

- last-write-wins: PASS — ./ship.sh by agent-bob
- append-only: FAIL — make deploy by agent-alice | ./ship.sh by agent-bob
- tempo: PASS — ./ship.sh by agent-bob

### P1 — Every returned fact must say who wrote it.

- last-write-wins: PASS — v by agent-alice
- append-only: PASS — v by agent-alice
- tempo: PASS — v by agent-alice

### P2 — When the writer gave a source pointer (a Slack link), the returned fact must carry it.

- last-write-wins: PASS — v by agent-alice ref=https://slack/msg/42
- append-only: PASS — v by agent-alice ref=https://slack/msg/42
- tempo: PASS — v by agent-alice ref=https://slack/msg/42

### P3 — A fact that was replaced must still be retrievable for the time it was true, with its original writer.

- last-write-wins: FAIL — bob by agent-bob
- append-only: FAIL — alice by agent-alice | bob by agent-bob
- tempo: PASS — alice by agent-alice

### B1 — A fact written in org "acme" must be invisible to org "globex".

- last-write-wins: PASS — (nothing)
- append-only: PASS — (nothing)
- tempo: PASS — (nothing)

### B2 — A write in private mode must leave no trace.

- last-write-wins: PASS — (nothing)
- append-only: PASS — (nothing)
- tempo: PASS — (nothing)

