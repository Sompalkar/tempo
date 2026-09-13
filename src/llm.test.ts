/**
 * The CLI backend for real: spawns `claude -p` on the user's subscription.
 * Skipped when `claude` is not logged in, so `npm test` stays green offline.
 */
import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { z } from 'zod';
import { claudeCliLLM, defaultLLM } from './llm.ts';

function cliLoggedIn(): boolean {
  try {
    const out = execFileSync('claude', ['auth', 'status'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return (JSON.parse(out) as { loggedIn?: boolean }).loggedIn === true;
  } catch {
    return false;
  }
}

describe('defaultLLM', () => {
  it('picks the CLI when there is no API key, and honours TEMPO_LLM', () => {
    const saved = { key: process.env['ANTHROPIC_API_KEY'], llm: process.env['TEMPO_LLM'] };
    try {
      delete process.env['ANTHROPIC_API_KEY'];
      delete process.env['TEMPO_LLM'];
      expect(defaultLLM().name).toMatch(/^claude-cli/);
      process.env['ANTHROPIC_API_KEY'] = 'x';
      expect(defaultLLM().name).toMatch(/^api/);
      process.env['TEMPO_LLM'] = 'claude';
      expect(defaultLLM().name).toMatch(/^claude-cli/);
      process.env['TEMPO_LLM'] = 'nope';
      expect(() => defaultLLM()).toThrow(/TEMPO_LLM/);
    } finally {
      if (saved.key === undefined) delete process.env['ANTHROPIC_API_KEY']; else process.env['ANTHROPIC_API_KEY'] = saved.key;
      if (saved.llm === undefined) delete process.env['TEMPO_LLM']; else process.env['TEMPO_LLM'] = saved.llm;
    }
  });
});

describe.skipIf(!cliLoggedIn())('claude cli backend (live)', () => {
  it('returns schema-valid structured output on the subscription', async () => {
    const llm = claudeCliLLM();
    const out = await llm.parse({
      system: 'Extract key/value facts. Keys are dotted lowercase.',
      user: 'we deploy with make deploy',
      schema: z.object({ facts: z.array(z.object({ key: z.string(), value: z.string() })) }),
    });
    expect(out?.facts.some((f) => f.value.includes('make deploy'))).toBe(true);
  }, 60_000);
});
