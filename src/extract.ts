/**
 * Turn raw text into facts tempo can store.
 *
 * The engine only accepts `key = value` with an optional date. Real life
 * arrives as prose: a Slack message, a chunk of an agent session. This file
 * is the bridge.
 *
 * Design rules:
 *  - The LLM does ONE job: pull out durable facts. It does not decide what
 *    supersedes what — that is the engine's job, and it is deterministic.
 *  - If the text does not say when a fact became true, the extractor must
 *    leave `validFrom` empty. Inventing a date would hand the engine a fake
 *    reason to pick a winner, which is the exact bug tempo exists to avoid.
 *  - Everything except the single API call is a pure function, so the hard
 *    parts are tested without a key and without a network.
 */
import Anthropic from '@anthropic-ai/sdk';
import { z } from 'zod';
import { zodOutputFormat } from '@anthropic-ai/sdk/helpers/zod';

/** One fact the extractor believes the text asserts. */
export const ExtractedFact = z.object({
  key: z
    .string()
    .describe('Dotted, lowercase, stable across time. e.g. "deploy.command", "db.primary", "customer.acme.owner"'),
  value: z.string().describe('The fact itself, short and self-contained.'),
  validFrom: z
    .string()
    .describe('ISO date (YYYY-MM-DD) ONLY if the text says when this became true. Empty string if it does not say.'),
  quote: z.string().describe('The sentence or phrase from the text this came from, copied exactly.'),
});
export type ExtractedFact = z.infer<typeof ExtractedFact>;

const Extraction = z.object({ facts: z.array(ExtractedFact) });

export const SYSTEM_PROMPT = `You pull durable facts out of engineering text so they can be stored in a shared team memory.

A durable fact is something that would still be useful to a teammate next month: a command, a decision and its reason, a convention, a config value, an owner, a policy, a gotcha that cost someone time.

NOT durable, do not extract:
- Anything about one specific task in progress ("the test is failing right now", "I'm on step 3").
- Restatements of what the code obviously says.
- Opinions with no decision attached.
- Anything you had to guess at.

Rules:
1. key: dotted, lowercase, stable. The SAME fact discussed on two different days must produce the SAME key. Prefer "deploy.command" over "how-we-deploy-the-app".
2. value: short, self-contained, readable on its own with no surrounding context.
3. validFrom: fill this in ONLY when the text states when the fact became true ("since March", "as of the 1st", "we switched last Tuesday"). If the text does not say, return an empty string. Do NOT use the date the text was written. Do NOT guess. An empty validFrom is the correct, expected answer most of the time.
4. quote: copy the exact words the fact came from, so a human can check you.
5. If the text contains no durable facts, return an empty list. That is a good answer, not a failure.`;

/** Build the user message. Kept separate so it can be tested without a network call. */
export function buildPrompt(text: string, opts: { sourceLabel?: string } = {}): string {
  const label = opts.sourceLabel ? `Source: ${opts.sourceLabel}\n\n` : '';
  return `${label}Text:\n"""\n${text}\n"""\n\nPull out the durable facts.`;
}

/**
 * Clean up what the model returned. Pure function — no network.
 * Drops anything malformed rather than passing junk into the store.
 */
export function sanitize(facts: ExtractedFact[]): { kept: ExtractedFact[]; dropped: { fact: ExtractedFact; why: string }[] } {
  const kept: ExtractedFact[] = [];
  const dropped: { fact: ExtractedFact; why: string }[] = [];
  const seen = new Set<string>();

  for (const f of facts) {
    const key = f.key.trim().toLowerCase();
    const value = f.value.trim();

    if (!key || !value) {
      dropped.push({ fact: f, why: 'empty key or value' });
      continue;
    }
    if (!/^[a-z0-9]+([._-][a-z0-9]+)*$/.test(key)) {
      dropped.push({ fact: f, why: `key is not a clean dotted name: "${f.key}"` });
      continue;
    }
    if (f.validFrom !== '' && !/^\d{4}-\d{2}-\d{2}$/.test(f.validFrom)) {
      dropped.push({ fact: f, why: `validFrom is not an ISO date: "${f.validFrom}"` });
      continue;
    }
    if (f.validFrom !== '' && Number.isNaN(Date.parse(f.validFrom))) {
      dropped.push({ fact: f, why: `validFrom is not a real date: "${f.validFrom}"` });
      continue;
    }
    if (seen.has(key)) {
      dropped.push({ fact: f, why: `duplicate key in one extraction: "${key}"` });
      continue;
    }
    seen.add(key);
    kept.push({ ...f, key, value });
  }
  return { kept, dropped };
}

export interface ExtractOptions {
  client?: Anthropic;
  model?: string;
  sourceLabel?: string;
}

/**
 * Ask Claude for the facts in a piece of text.
 * Uses Haiku: this is a narrow, high-volume job, and the prompt carries the
 * judgement. Returns sanitized facts plus whatever was dropped and why.
 */
export async function extractFacts(
  text: string,
  opts: ExtractOptions = {},
): Promise<{ kept: ExtractedFact[]; dropped: { fact: ExtractedFact; why: string }[] }> {
  if (!text.trim()) return { kept: [], dropped: [] };

  const client = opts.client ?? new Anthropic();
  const response = await client.messages.parse({
    model: opts.model ?? 'claude-haiku-4-5',
    max_tokens: 8000,
    system: SYSTEM_PROMPT,
    messages: [{ role: 'user', content: buildPrompt(text, opts.sourceLabel !== undefined ? { sourceLabel: opts.sourceLabel } : {}) }],
    output_config: { format: zodOutputFormat(Extraction) },
  });

  const parsed = response.parsed_output;
  if (!parsed) return { kept: [], dropped: [] };
  return sanitize(parsed.facts);
}
