# DM to Nikos — draft

Keep it short. He reads hundreds of these. The repo does the talking.

---

Hey Nikos — saw you're hiring founding MTS. Rather than send a resume I built something.

Your essay names four problems that show up the moment memory is shared across an org — contradiction, time, provenance, boundaries — and says everyone else defines them out of scope. I took that as a spec.

**tempo** — a small bitemporal memory engine: every fact has two clocks (when it was true, when we learned it) and a source. When two agents disagree and neither gave a date, it keeps both and flags them instead of picking whichever wrote last. `recall(asOf: April)` sees what agents believed in April — the time-travel your 100-PR replay needed.

Ships as a Claude Code plugin: when a session ends it captures the durable facts in the background; the next session gets them before the first prompt. No API key, one SQLite file. Tell one session "staging is Postgres 16 at db-staging.internal", close it, ask the next one — it knows.

**StaleBench** — 15 scenarios across those four problems. tempo 15/15, last-write-wins 9/15, append-only 5/15. Adapters are ~50 lines; I'd love to see a Glen row.

**On my own history** — ran it over 10 sessions of a real project, on a Pro subscription, no API key. 1,262 facts, 14 that changed over time, 9 real disagreements between my own past sessions. One change: `uvicorn app.main:app` → `./venv/bin/uvicorn app.main:app`, weeks apart — the first breaks on a clean machine. I hadn't noticed. It also reconstructed my test count going 15 → 35 → 54 → 62 → 63 across five sessions.

Journal of 16 bugs I found and fixed along the way, including the one where my benchmark was passing only because I'd unconsciously worked around the bug in the adapter.

Repo: github.com/Sompalkar/tempo
2-min demo: [link]

Would love 20 minutes to hear where this is naive vs. what you've actually hit inside Glen.

— Som

---

## Notes to self before sending

- Record the demo (docs/DEMO.md), upload, paste the link.
- Re-read the README once as him: does the first screen make the idea obvious?
- Don't oversell. "Where this is naive" is the strongest line — it invites the conversation.
