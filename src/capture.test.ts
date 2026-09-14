import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCommand } from './capture.ts';

describe('capture hook', () => {
  it('builds an ingest command for exactly the finished transcript', () => {
    const { cmd, args } = captureCommand('/x/y/sess.jsonl');
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['ingest', '--file', '/x/y/sess.jsonl', '--yes', '--quiet']);
    expect(args[0]).toMatch(/cli\.ts$/);
  });

  it('starts a detached ingest and returns immediately', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-'));
    try {
      const transcript = join(dir, 's.jsonl');
      writeFileSync(transcript, '');
      const t = Date.now();
      const out = execFileSync('node', [join(process.cwd(), 'src', 'capture.ts')], {
        input: JSON.stringify({ hook_event_name: 'SessionEnd', transcript_path: transcript, reason: 'other' }),
        env: { ...process.env, TEMPO_DB: join(dir, 't.db'), TEMPO_CAPTURE_DRYRUN: '1', TEMPO_LLM: 'claude' },
      }).toString();
      expect(Date.now() - t).toBeLessThan(1500); // inside the SessionEnd budget
      const { args } = JSON.parse(out) as { args: string[] };
      expect(args).toContain(transcript);
      expect(existsSync(join(dir, 'capture.log'))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('does nothing when TEMPO_CAPTURE=off or the transcript is missing', () => {
    const run = (env: Record<string, string>, input: object) =>
      execFileSync('node', [join(process.cwd(), 'src', 'capture.ts')], {
        input: JSON.stringify(input),
        env: { ...process.env, TEMPO_CAPTURE_DRYRUN: '1', ...env },
      }).toString();
    expect(run({ TEMPO_CAPTURE: 'off' }, { transcript_path: '/nope' })).toBe('');
    expect(run({}, { transcript_path: '/definitely/not/here.jsonl' })).toBe('');
  });

  it('exits 0 on garbage input', () => {
    const out = execFileSync('node', [join(process.cwd(), 'src', 'capture.ts')], { input: 'not json', stdio: ['pipe', 'pipe', 'ignore'] }).toString();
    expect(out).toBe('');
  });
});
