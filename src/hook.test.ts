import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { recallForPrompt, termsFrom } from './hook.js';
import { TempoStore } from './store.js';

const alice = { writer: 'agent-alice', kind: 'session' } as const;

describe('termsFrom', () => {
  it('keeps meaningful words, drops filler and short words, dedupes', () => {
    expect(termsFrom('How do I deploy the billing service to prod? deploy it please')).toEqual([
      'deploy', 'billing', 'service', 'prod',
    ]);
  });
  it('caps the number of terms', () => {
    expect(termsFrom('alpha bravo charlie delta echo foxtrot golf hotel india juliet', 3)).toHaveLength(3);
  });
});

describe('recallForPrompt', () => {
  it('finds facts whose key or value mentions a word from the prompt', () => {
    const s = new TempoStore(':memory:');
    s.remember({ org: 'acme', key: 'deploy.command', value: 'make ship', source: alice });
    s.remember({ org: 'acme', key: 'db.primary', value: 'postgres 16', source: alice });
    s.remember({ org: 'acme', key: 'unrelated', value: 'nothing', source: alice });
    const { facts } = recallForPrompt(s, 'acme', 'how do I deploy this, and which postgres version?');
    expect(facts.map((f) => f.key).sort()).toEqual(['db.primary', 'deploy.command']);
  });
});

describe('hook binary', () => {
  it('prints additionalContext when memory has something relevant, nothing when it does not', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tempo-hook-'));
    try {
      const db = join(dir, 't.db');
      const s = new TempoStore(db);
      s.remember({ org: 'acme', key: 'deploy.command', value: 'make ship', source: alice });
      s.close();

      const run = (prompt: string) =>
        execFileSync('node', [join(process.cwd(), 'dist', 'hook.js')], {
          input: JSON.stringify({ hook_event_name: 'UserPromptSubmit', user_input: prompt }),
          env: { ...process.env, TEMPO_DB: db, TEMPO_ORG: 'acme' },
        }).toString();

      const hit = JSON.parse(run('how do we deploy?')) as { hookSpecificOutput: { additionalContext: string } };
      expect(hit.hookSpecificOutput.additionalContext).toContain('deploy.command = make ship');
      expect(run('tell me a joke')).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('exits 0 and prints nothing on garbage input', () => {
    const out = execFileSync('node', [join(process.cwd(), 'dist', 'hook.js')], { input: 'not json', stdio: ['pipe', 'pipe', 'ignore'] }).toString();
    expect(out).toBe('');
  });
});
