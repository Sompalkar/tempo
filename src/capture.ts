#!/usr/bin/env node
/**
 * Claude Code hook: capture the session you just finished.
 *
 * Fires on SessionEnd. That hook gets 1.5 seconds and the process is already
 * exiting, so we cannot run the ingest here. Instead we START it, detached,
 * and return at once. The ingest keeps running after Claude Code has closed
 * and writes its one-line result to ~/.tempo/capture.log.
 *
 * Ingest is idempotent (chunks are keyed by content), so this is safe to
 * fire on every session end, including sessions that were already captured
 * or that a user also imported by hand.
 *
 * Turn it off with TEMPO_CAPTURE=off.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, openSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

interface HookInput {
  hook_event_name?: string;
  transcript_path?: string;
  session_id?: string;
  reason?: string;
}

/** Build the detached command. Exported so it can be tested without spawning. */
export function captureCommand(transcriptPath: string): { cmd: string; args: string[] } {
  const cli = join(dirname(fileURLToPath(import.meta.url)), 'cli.ts');
  return { cmd: process.execPath, args: [cli, 'ingest', '--file', transcriptPath, '--yes', '--quiet'] };
}

async function main(): Promise<void> {
  if ((process.env['TEMPO_CAPTURE'] ?? 'on').toLowerCase() === 'off') return;

  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  const input = JSON.parse(Buffer.concat(chunks).toString('utf8')) as HookInput;

  const transcript = input.transcript_path;
  if (!transcript || !existsSync(transcript)) return;

  const logDir = process.env['TEMPO_DB'] ? dirname(process.env['TEMPO_DB']) : join(homedir(), '.tempo');
  mkdirSync(logDir, { recursive: true });
  const log = openSync(join(logDir, 'capture.log'), 'a');

  const { cmd, args } = captureCommand(transcript);
  const child = spawn(cmd, args, {
    detached: true,
    stdio: ['ignore', log, log],
    env: process.env,
  });
  // Let Claude Code exit without waiting for us.
  child.unref();

  if (process.env['TEMPO_CAPTURE_DRYRUN']) {
    process.stdout.write(JSON.stringify({ cmd, args }));
  }
}

if (process.argv[1] && /capture\.(js|ts)$/.test(process.argv[1])) {
  main().catch((e) => {
    process.stderr.write(`tempo capture: ${(e as Error).message}\n`);
    process.exit(0);
  });
}
