# Demo script

About two minutes. Lines in **bold** are what you say. Everything else is
what you type or what shows up on screen. Every command here was run for
real; the outputs are the real outputs.

Before recording, in the terminal (off camera):

```bash
cd ~/dev/glen
alias tempo='node ~/dev/glen/src/cli.ts'
export TEMPO_DB=~/.tempo/demo.db TEMPO_ORG=acme TEMPO_LLM=claude
rm -f ~/.tempo/demo.db ~/.tempo/demo.db-wal ~/.tempo/demo.db-shm
```

Cost: the whole demo is about 8 small Haiku calls. Scene 3 makes none —
`tempo report` only reads the database that's already there.

Scene 0 needs ~30 seconds between its two commands for the background
capture to finish. Say the middle line slowly, or cut there.

---

## Open

**Hi Nikos. I read your post about single-tenant memory being the wrong
default. You listed four things that break when a company's agents share
one memory — contradictions, time, provenance, boundaries — and said most
tools just skip them. I wanted to see what it takes to not skip them. This
is tempo. Let me show you two things it does, then what it found in my
own history.**

---

## Scene 0 — it just learns

**Quick one before the real demo. Watch this. I'm going to tell a session
something, close it, and ask a new session.**

```bash
echo "For the record: staging is Postgres 16 at db-staging.internal, and deploys go through 'make ship'. Just say OK." \
  | claude -p
```
> OK. Got it.

**Session's closed. tempo read the transcript in the background, pulled
out three facts. I didn't call anything. Now a brand new session:**

```bash
echo "What's our staging database host, and how do we deploy? One line." \
  | claude -p
```
> Staging DB is `db-staging.internal` (Postgres 16), deploy with `make ship`.

**It knows. No tool call, no memory command, no API key — the plugin
captured it when the session ended and handed it to the next one. That's
the loop. Now the interesting part: what happens when facts disagree.**

*(off camera, or just type it — it's fine on screen: fresh DB for the next
scenes, and turn auto-capture off so it doesn't interfere)*

```bash
rm -f ~/.tempo/demo.db ~/.tempo/demo.db-wal ~/.tempo/demo.db-shm; export TEMPO_CAPTURE=off
```

---

## Scene 1 — two agents disagree

**I've got three Claude Code sessions here, all pointed at the same memory
file. Think of them as three people on a team.**

**Alice saves the deploy command.**

```bash
echo "Use tempo_remember to store key 'deploy.command' with value 'make deploy'." \
  | TEMPO_WRITER=agent-alice claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember
```
> Tempo inserted the fact.

**Fine. Now Bob, a different session, saves a different deploy command. Maybe
he's on an older branch, maybe he's right and Alice is wrong — nobody knows
yet.**

```bash
echo "Use tempo_remember to store key 'deploy.command' with value './scripts/ship.sh'." \
  | TEMPO_WRITER=agent-bob claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember
```
> The tool returned a conflict — there's an existing fact that deploy.command is "make deploy".

**See that. It didn't overwrite Alice. It didn't pick Bob because he was
last. It said: these two disagree, and I'm keeping both.**

**Now Carol. She's just trying to ship something and asks the obvious
question.**

```bash
echo "What is our deploy command? Check team memory first." \
  | TEMPO_WRITER=agent-carol claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_recall
```
> Based on team memory, **there's a conflict** — two different deploy commands are recorded:
> 1. `./scripts/ship.sh` (recorded by agent-bob)
> 2. `make deploy` (recorded by agent-alice)
>
> Neither is marked as the authoritative answer. **You need to clarify which one is actually correct.**

**That's the whole idea in one screen. Every memory tool I've tried would
have told Carol "ship.sh" with total confidence, because Bob wrote last.
tempo told her the truth: two people disagree, here's who said what, go
ask. And when someone does settle it, the answer and the reason get
saved too.**

---

## Scene 2 — time

**Second thing. Facts change. Your example was the refund policy — 30 days
in March, 14 days in June. Most memory just keeps the latest one and
forgets the old one ever existed.**

```bash
echo "tempo_remember: key 'refund.policy', value '30 days', validFrom '2026-03-01'. Then key 'refund.policy', value '14 days', validFrom '2026-06-01'." \
  | claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember
```
> Call 1: inserted. Call 2: superseded.

**Superseded — not deleted. The March fact is still there, it just has an
end date now. So I can ask about the past.**

```bash
echo "A customer is disputing an April 2026 charge. What was our refund policy then, and what is it now?" \
  | claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_recall
```
> April 2026: **30 days** (superseded June 1)
> Today: **14 days**

**Right answer for April, right answer for today. That's the time-travel
your hundred-PR replay needed — you rolled memory back to before each PR.
Here it's just a query parameter.**

---

## Scene 3 — my own history

**Okay, that's the toy. Here's the part I actually care about. I pointed
this at my own Claude Code transcripts — ten sessions from one real project
— and had it pull out every durable fact. Commands, config, decisions.**

```bash
TEMPO_ORG=som tempo report
```
*(this reads ~/.tempo/som.db — the RoboTrain data is already there, no model calls)*
> facts stored ............ 1262
> superseded (changed) .... 14
> confirmed by 2+ sources . 78
> open conflicts .......... 9

**Twelve hundred facts. Fourteen of them changed over time. Look at this one.**

*(point at it)*
> robotrain.backend.uvicorn.command
>   was: uvicorn app.main:app --host 127.0.0.1 --port 8000
>   now: ./venv/bin/uvicorn app.main:app --host 127.0.0.1 --port 8000

**Two sessions, weeks apart. The first one works on my machine and breaks on
a clean one. I had no idea I'd changed it. tempo noticed.**

**And this one — it reconstructed my test count across five different
sessions.**

> robotrain.backend.tests.count
>   15 → 35 → 54 → 62 → 63

**Nobody wrote that timeline. It fell out of the data.**

**Nine open disagreements. Some are real — one session says the queue
default is 30 minutes, another describes the fallback rule without the
number. tempo doesn't pretend to know which matters. It flags it and
moves on.**

---

## Close

**So: two clocks on every fact, a source on every fact, and a hard rule
that a guessed timestamp is never a reason to pick a winner. About six
hundred lines. One SQLite file. Runs as a Claude Code plugin with no API
key.**

**There's a small benchmark in the repo — fifteen scenarios across your
four problems. tempo passes all fifteen. A last-write-wins store passes
nine. I wrote both the test and the thing being tested, so take that with
salt — but adapters are fifty lines and I'd genuinely like to see a Glen
row.**

**There's also a journal of every bug I hit building it. Sixteen of them.
One of them, the benchmark was passing only because I'd unconsciously
worked around the bug in the test adapter. That one's worth reading.**

**Repo's at github.com/Sompalkar/tempo. I'd love twenty minutes to hear
where this is naive compared to what you've actually run into inside
Glen. Thanks.**

---

## Notes before you hit record

- Run the setup lines first so the demo DB is empty.
- Scene 3 uses the `som` org — `~/.tempo/som.db` — which already has the
  RoboTrain data. Never delete that file.
- Screen + voice only. Cmd+Shift+5 on a Mac, pick the mic, record the
  terminal window. Big font. One take is fine.
- If a `claude -p` call takes a few seconds, just wait. Don't fill the
  silence.
- You don't have to say every bold line word for word. Say it how you'd
  say it. The points that matter are: *it kept both*, *it didn't delete
  March*, *it found something in my own history I'd missed*.
