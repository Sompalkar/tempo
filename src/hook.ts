#!/usr/bin/env node
/**
 * Claude Code hook: recall relevant facts before every prompt.
 *
 * Wired up by hooks/hooks.json for the UserPromptSubmit event. Claude Code
 * pipes a JSON object to stdin; we print JSON with `additionalContext` and
 * exit 0. If we find nothing, we print nothing. If anything goes wrong, we
 * print nothing and still exit 0 — a memory hiccup must never block a prompt.
 *
 * Same env config as the MCP server: TEMPO_DB, TEMPO_ORG.
 */
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { TempoStore } from './store.js';
import { formatFacts } from './format.js';
import type { Conflict, Fact } from './types.js';

const STOP = new Set([
  'the', 'and', 'for', 'with', 'this', 'that', 'from', 'what', 'when', 'where', 'which', 'how', 'why',
  'does', 'did', 'have', 'has', 'had', 'are', 'was', 'were', 'will', 'can', 'could', 'should', 'would',
  'about', 'into', 'over', 'then', 'than', 'them', 'they', 'there', 'here', 'just', 'like', 'make',
  'please', 'want', 'need', 'help', 'also', 'some', 'more', 'most', 'very', 'file', 'files', 'code',
  'thing', 'things', 'using', 'used', 'use', 'let', 'lets', 'you', 'your', 'our', 'out', 'not', 'but',
]);

/** Words worth searching memory for. Short, dumb, and deterministic on purpose. */
export function termsFrom(prompt: string, max = 8): string[] {
  const seen = new Set<string>();
  for (const raw of prompt.toLowerCase().split(/[^a-z0-9_.-]+/)) {
    const w = raw.replace(/^[.-]+|[.-]+$/g, '');
    if (w.length < 4 || STOP.has(w) || seen.has(w)) continue;
    seen.add(w);
    if (seen.size >= max) break;
  }
  return [...seen];
}

export function recallForPrompt(store: TempoStore, org: string, prompt: string, cap = 12): { facts: Fact[]; conflicts: Conflict[] } {
  const byId = new Map<string, Fact>();
  const conflicts = new Map<string, Conflict>();
  for (const term of termsFrom(prompt)) {
    const r = store.recall({ org, query: term, limit: 6 });
    for (const f of r.facts) byId.set(f.id, f);
    for (const c of r.conflicts) conflicts.set(c.id, c);
    if (byId.size >= cap) break;
  }
  return { facts: [...byId.values()].slice(0, cap), conflicts: [...conflicts.values()] };
}

async function main(): Promise<void> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as { user_input?: string; prompt?: string };
  const prompt = input.user_input ?? input.prompt ?? '';
  if (!prompt.trim()) return;

  const dbPath = process.env['TEMPO_DB'] ?? join(homedir(), '.tempo', 'tempo.db');
  if (!existsSync(dbPath)) return; // nothing remembered yet
  const org = process.env['TEMPO_ORG'] ?? 'default';

  const store = new TempoStore(dbPath);
  try {
    const { facts, conflicts } = recallForPrompt(store, org, prompt);
    if (facts.length === 0) return;
    const body = formatFacts(facts, conflicts);
    const context =
      `tempo (team memory) found facts that may be relevant to this prompt. ` +
      `Facts marked CONFLICTED have another current fact that disagrees; do not trust either blindly. ` +
      `If you learn a durable fact during this task (a command, a decision, a policy, a contact), save it with tempo_remember.\n\n` +
      body;
    process.stdout.write(
      JSON.stringify({ hookSpecificOutput: { hookEventName: 'UserPromptSubmit', additionalContext: context } }),
    );
  } finally {
    store.close();
  }
}

// Only run when executed directly, not when imported by tests.
if (process.argv[1] && /hook\.js$/.test(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`tempo hook: ${(e as Error).message}\n`);
    process.exit(0);
  });
}
