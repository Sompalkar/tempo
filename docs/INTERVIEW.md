# Interview prep

Nikos said what he screens for: *"Do you actually crush the technicals.
Explain design decisions and trade-offs. Niche knowledge from hands-on
experience."* Every answer below comes from something we actually built or
broke. Don't memorise these — know them well enough to say them your way.

---

## The three things to be able to say cold

**1. Why two clocks?**
"When was it true" and "when did we learn it" are different questions.
The refund policy was 30 days in March — that's valid time. On April 5th
our agents *believed* it was 30 days — that's record time. You need both
to replay an old session honestly: the agent must not see facts learned
later. It's an old idea from accounting and legal databases. Almost no
agent memory tool does it.

**2. Why doesn't tempo just pick the newest fact?**
Because a timestamp on a write is when the agent *wrote*, not when the
fact became *true*. Two agents writing different values on different days
with no dates isn't evidence of change — it's two agents disagreeing. So
tempo only picks a winner when there's a real reason: an explicit date, or
the same writer correcting itself. Otherwise it keeps both, flags them,
and lets a person or an opt-in policy decide. The resolution and its
reason are stored too.

**3. Why is fuzzy matching outside the engine?**
The engine compares strings with `===`. That's why it's deterministic and
has a hundred tests that run in half a second with no network. Real
agents don't produce identical strings, so a layer in front decides "is
this a rewording of something we hold?" and, if so, writes the *exact
existing string*. The engine sees agreement. The fuzzy part can fail — and
when it does, it fails toward "different", which is a visible conflict a
person can resolve, never toward "same", which silently loses a fact.

---

## Questions he'll probably ask, and honest answers

**"How is this different from what we have?"**
It probably isn't, in ambition — Glen is the whole system; this is one box
in the middle, built from your essay to see where the hard parts are. What
I'd want to know is whether the rules I landed on match what you've seen
with real customers. Where they don't, I want to know why.

**"What happens when two agents use different keys for the same fact?"**
They never meet, so a real contradiction between them goes unnoticed.
That's the biggest known gap. Two things reduce it — the extractor is
shown existing keys and told to reuse them, and underscores and dots are
normalised — but it's reduced, not solved. Next step is clustering keys
by embedding similarity and proposing merges, with a person confirming.
I'd rather say that than pretend it's handled.

**"How does it scale? SQLite?"**
SQLite is right for one machine and for making the engine testable. For
an org it's Postgres with row-level security per org — your essay names
exactly that. The engine logic doesn't change; the two-clock filtering is
a few predicates. What *does* change at scale is recall: text search over
a few thousand facts is fine, over a few million you want embeddings in
front of it. I kept that out on purpose — it's not the hard part.

**"Why extract facts with an LLM at all? Isn't that lossy?"**
Yes. The transcript is the truth; facts are a lossy index over it. That's
why every fact carries a pointer back to its source chunk — you can always
go read what was actually said. The first real ingest showed the lossiness
concretely: 54 "conflicts" that were mostly one fact worded three ways.
Fixing that was most of a day.

**"Why batch ingest? We capture live."**
Live is right. Batch was the fastest way to get real numbers on real
history. The live version is a Stop hook — after each turn, extract from
the last assistant message only, small and cheap. The engine is the same
either way. I didn't build it before sending because I wanted to send
something finished rather than something wide.

**"How did you test the time-travel logic?"**
Fixed clock, tests named as sentences: "asOf hides a supersession that
happened later." And then the live demo found a bug the tests missed —
asking about April returned nothing because a second filter hid
superseded facts by default. The benchmark was passing because my adapter
had `includeHistory: true` on every read; I'd unconsciously worked around
the bug in the test harness. Removed that line, the bench failed on the
old engine, passed on the fixed one. Tests written by the same person on
the same day as the code tend to agree with the code.

**"What would you do first if you joined?"**
Ask to sit with one design partner for a day and watch what they actually
recall and what they ignore. You said the founder-FDE loop is 30 minutes;
I want to see what's in that loop before I have opinions about the store.

**"What's wrong with tempo?"**
Key drift. Extraction quality depends on prompt wording more than I'd
like. The benchmark is self-authored. The reconciler's cheap tier had two
dumb bugs that hid real matches (a trailing full stop; dropping numbers as
"too short"). The subscription ingest path hits a usage ceiling on big
projects. All of it's in the journal.

---

## Things to have on screen

- `docs/JOURNAL.md` open — if he asks about any failure, read the real entry.
- `bench/RESULTS.md` — the per-scenario table.
- `bench/REPORT-robotrain.md` — the real numbers.
- One terminal with the demo DB ready, in case he wants to see it live.

## Things not to do

- Don't claim tempo does anything Glen doesn't. You don't know Glen's internals.
- Don't defend a weak spot. Name it and say what you'd do.
- Don't say "AI helped me build it" defensively, and don't hide it either.
  If asked: "I used Claude Code heavily, the way I'd use it at Glen. Every
  design decision and every bug in the journal, I can walk you through."
