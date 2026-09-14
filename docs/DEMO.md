# Demo — short version

About 70 seconds. Six commands. Bold = what you say. Say it your way.

## Setup (before you hit record, same terminal)

```bash
cd ~/dev/glen
alias tempo='node ~/dev/glen/src/cli.ts'
export TEMPO_DB=~/.tempo/demo.db TEMPO_ORG=acme TEMPO_LLM=claude TEMPO_CAPTURE=off
rm -f ~/.tempo/demo.db ~/.tempo/demo.db-wal ~/.tempo/demo.db-shm
```

Then `clear`, then Cmd+Shift+5, then go.

---

**Hi Nikos. You wrote that shared memory breaks in four ways — contradictions, time, provenance, boundaries — and most tools skip them. I built a small one that doesn't. Three quick things.**

---

**One. Two agents disagree.**

**Alice saves the deploy command.**

```bash
echo "Use tempo_remember to store key 'deploy.command' with value 'make deploy'." | TEMPO_WRITER=agent-alice claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember
```

**Bob saves a different one.**

```bash
echo "Use tempo_remember to store key 'deploy.command' with value './scripts/ship.sh'." | TEMPO_WRITER=agent-bob claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember
```

**See — it says conflict. It kept both. It didn't just take Bob because he was last.**

**Now Carol asks.**

```bash
echo "What is our deploy command? Check team memory first." | TEMPO_WRITER=agent-carol claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_recall
```

**She gets both, and who said what, and "you need to decide". Most tools would have told her ship.sh with full confidence. This one tells her the truth.**

---

**Two. Time.**

```bash
echo "tempo_remember: key 'refund.policy', value '30 days', validFrom '2026-03-01'. Then key 'refund.policy', value '14 days', validFrom '2026-06-01'." | claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_remember
```

**Policy was 30 days from March, then 14 days from June. The old one isn't deleted — it just got an end date. So:**

```bash
echo "A customer is disputing an April 2026 charge. What was our refund policy then, and what is it now?" | claude -p --allowedTools mcp__plugin_tempo_tempo__tempo_recall
```

**April: 30 days. Now: 14 days. Both right. That's the time travel your hundred-PR replay needed.**

---

**Three. My own history.**

```bash
TEMPO_DB=~/.tempo/som.db TEMPO_ORG=som tempo report
```

**I ran this on ten of my own Claude Code sessions. Twelve hundred facts. Fourteen changed over time. This one —** *(point at uvicorn)* **— my deploy command changed weeks apart, and the old one breaks on a clean machine. I didn't know. It found it.**

---

**It also captures every session when it ends, so the next one already knows. No API key. One SQLite file. Fifteen-scenario benchmark in the repo, and a journal of every bug I hit — seventeen so far.**

**Repo's at github.com/Sompalkar/tempo. I'd like twenty minutes to hear where this is naive compared to what you've hit inside Glen. Thanks.**

---

## If something goes wrong

- Scene 3 shows zeros → you forgot `TEMPO_DB=~/.tempo/som.db` on that line. It's in the command above; copy it exactly.
- A `claude -p` says "MCP failed" → tell me, don't keep recording.
- A call takes 10 seconds → just wait. Don't talk over it.
