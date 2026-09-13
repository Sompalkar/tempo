# DM to Nikos — draft

Keep it short. He reads hundreds of these. The repo does the talking.

---

Hey Nikos — saw you're hiring founding MTS. Rather than send a resume I built something.

Your essay names four problems that show up the moment memory is shared across an org — contradiction, time, provenance, boundaries — and says everyone else defines them out of scope. I took that as a spec.

**tempo** — a small bitemporal memory engine: every fact has two clocks (when it was true, when we learned it) and a source. When two agents disagree and neither gave a date, it keeps both and flags them instead of picking whichever wrote last. `recall(asOf: April)` sees what agents believed in April — the time-travel your 100-PR replay needed.

Ships as a Claude Code plugin (hook + 4 tools, no API key, one SQLite file) and a CLI.

**StaleBench** — 15 scenarios across those four problems. tempo 15/15, last-write-wins 9/15, append-only 5/15. Adapters are ~50 lines; I'd love to see a Glen row.

**On my own history** — ran it over 10 sessions of a real project. [N] facts, [N] changed over time, [N] real disagreements between my own past sessions. One: `uvicorn app.main:app` in June, `./venv/bin/uvicorn app.main:app` in August — the first breaks on a clean machine. I hadn't noticed.

Journal of 13 bugs I found and fixed along the way, including the one where my benchmark was passing only because I'd unconsciously worked around the bug in the adapter.

Repo: github.com/Sompalkar/tempo
2-min demo: [link]

Would love 20 minutes to hear where this is naive vs. what you've actually hit inside Glen.

— Som

---

## Notes to self before sending

- Fill in the three [N]s from `tempo report`.
- Record the demo (docs/DEMO.md), upload, paste the link.
- Re-read the README once as him: does the first screen make the idea obvious?
- Don't oversell. "Where this is naive" is the strongest line — it invites the conversation.
