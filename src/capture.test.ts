import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { captureCommand, worthCapturing, MAX_CHUNKS_PER_CAPTURE } from './capture.ts';
import { childEnv } from './llm.ts';

const T = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();
const turn = (role: 'user' | 'assistant', text: string, at: string) => ({
  type: role, timestamp: at, sessionId: 's', cwd: '/', message: { role, content: [{ type: 'text', text }] },
});
function writeTranscript(dir: string, lines: unknown[]): string {
  const p = join(dir, 'sess.jsonl');
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}
/** A transcript with enough real content to be worth a model call. */
function realTranscript(dir: string): string {
  return writeTranscript(dir, [
    turn('user', 'For the record, staging is Postgres 16 at db-staging.internal and we deploy with make ship. '.repeat(6), T(1)),
    turn('assistant', 'Noted. Staging is Postgres 16 at db-staging.internal; deploys go through make ship.'.repeat(6), T(1)),
    turn('user', 'Also the on-call rotation lives in #ops-oncall. Remember that too please.'.repeat(4), T(2)),
  ]);
}

describe('capture hook', () => {
  it('builds an ingest command for exactly the finished transcript, capped', () => {
    const { cmd, args } = captureCommand('/x/y/sess.jsonl');
    expect(cmd).toBe(process.execPath);
    expect(args.slice(1)).toEqual(['ingest', '--file', '/x/y/sess.jsonl', '--chunks', String(MAX_CHUNKS_PER_CAPTURE), '--yes', '--quiet']);
    expect(args[0]).toMatch(/cli\.ts$/);
  });

  // The bug: the extractor's own `claude -p` is a Claude Code session, so its
  // SessionEnd fired capture, which spawned an extractor, which... 8,476
  // times. Two independent guards, both tested here.
  it('GUARD 1: the extractor child env turns capture off', () => {
    expect(childEnv({ PATH: '/bin', TEMPO_CAPTURE: 'on' })['TEMPO_CAPTURE']).toBe('off');
  });

  it('GUARD 2: a one-line helper session is not worth a model call', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-'));
    try {
      const tiny = writeTranscript(dir, [turn('user', 'say ok', T(1)), turn('assistant', 'ok', T(1))]);
      expect(worthCapturing(tiny)).toBe(false);
      expect(worthCapturing(realTranscript(dir))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('GUARD 2 end to end: the hook does nothing for a tiny transcript', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-'));
    try {
      const tiny = writeTranscript(dir, [turn('user', 'say ok', T(1)), turn('assistant', 'ok', T(1))]);
      const out = execFileSync('node', [join(process.cwd(), 'src', 'capture.ts')], {
        input: JSON.stringify({ hook_event_name: 'SessionEnd', transcript_path: tiny }),
        env: { ...process.env, TEMPO_DB: join(dir, 't.db'), TEMPO_CAPTURE_DRYRUN: '1' },
      }).toString();
      expect(out).toBe('');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('starts a detached ingest and returns immediately', () => {
    const dir = mkdtempSync(join(tmpdir(), 'cap-'));
    try {
      const transcript = realTranscript(dir);
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
