import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { chunkSession, findSessions, parseTranscript, type Session } from './claude-code.ts';

const T = (n: number) => new Date(Date.UTC(2026, 0, n)).toISOString();

function write(dir: string, name: string, lines: unknown[]): string {
  const p = join(dir, name);
  writeFileSync(p, lines.map((l) => JSON.stringify(l)).join('\n') + '\n');
  return p;
}

const userMsg = (text: string, at: string) => ({
  type: 'user',
  timestamp: at,
  sessionId: 's1',
  cwd: '/repo',
  message: { role: 'user', content: [{ type: 'text', text }] },
});
const asstMsg = (content: unknown[], at: string) => ({
  type: 'assistant',
  timestamp: at,
  sessionId: 's1',
  cwd: '/repo',
  message: { role: 'assistant', content },
});

describe('parseTranscript', () => {
  it('pulls out user text, assistant prose, and bash commands in order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-'));
    try {
      const p = write(dir, 's1.jsonl', [
        { type: 'custom-title', customTitle: 'Deploy work' },
        userMsg('how do we deploy?', T(1)),
        asstMsg(
          [
            { type: 'thinking', thinking: 'hmm' },
            { type: 'text', text: 'We use make deploy.' },
            { type: 'tool_use', name: 'Bash', input: { command: 'make deploy', description: 'Deploy the app' } },
          ],
          T(2),
        ),
      ]);
      const s = parseTranscript(p, 'proj')!;
      expect(s.title).toBe('Deploy work');
      expect(s.cwd).toBe('/repo');
      expect(s.turns.map((t) => t.role)).toEqual(['user', 'assistant', 'command']);
      expect(s.turns[2]!.text).toBe('$ make deploy    # Deploy the app');
      expect(s.startedAt).toBe(Date.parse(T(1)));
      expect(s.endedAt).toBe(Date.parse(T(2)));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips thinking blocks, non-Bash tools, sidechains, and system reminders', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-'));
    try {
      const p = write(dir, 's1.jsonl', [
        userMsg('<system-reminder>ignore me</system-reminder>', T(1)),
        { ...userMsg('sidechain prompt', T(1)), isSidechain: true },
        asstMsg(
          [
            { type: 'thinking', thinking: 'secret reasoning' },
            { type: 'tool_use', name: 'Read', input: { file_path: '/a/b.ts' } },
          ],
          T(2),
        ),
        userMsg('real question', T(3)),
      ]);
      const s = parseTranscript(p, 'proj')!;
      expect(s.turns.map((t) => t.text)).toEqual(['real question']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('survives corrupt lines instead of throwing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-'));
    try {
      const p = join(dir, 's1.jsonl');
      writeFileSync(p, `{not json\n${JSON.stringify(userMsg('hi', T(1)))}\n\n`);
      expect(parseTranscript(p, 'proj')!.turns).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a transcript with no usable turns', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tc-'));
    try {
      const p = write(dir, 's1.jsonl', [{ type: 'mode', mode: 'normal' }]);
      expect(parseTranscript(p, 'proj')).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns null for a missing file', () => {
    expect(parseTranscript('/nope/nope.jsonl', 'proj')).toBeNull();
  });
});

describe('findSessions', () => {
  it('finds sessions across projects, newest first, and can filter by project', () => {
    const root = mkdtempSync(join(tmpdir(), 'root-'));
    try {
      mkdirSync(join(root, 'projA'));
      mkdirSync(join(root, 'projB'));
      write(join(root, 'projA'), 'a.jsonl', [userMsg('old', T(1))]);
      write(join(root, 'projB'), 'b.jsonl', [userMsg('new', T(9))]);
      writeFileSync(join(root, 'projA', 'notes.txt'), 'ignored');

      const all = findSessions({ root });
      expect(all.map((s) => s.project)).toEqual(['projB', 'projA']);
      expect(findSessions({ root, projects: ['projA'] }).map((s) => s.project)).toEqual(['projA']);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns nothing when the root does not exist', () => {
    expect(findSessions({ root: '/nope' })).toEqual([]);
  });
});

describe('chunkSession', () => {
  const session = (turns: Session['turns']): Session => ({
    sessionId: 's1',
    cwd: '/repo',
    project: 'proj',
    title: 't',
    startedAt: Date.parse(T(1)),
    endedAt: Date.parse(T(2)),
    turns,
    path: '/p',
  });

  it('never splits a turn, and starts a new chunk when the target is passed', () => {
    const turns = Array.from({ length: 6 }, (_, i) => ({
      role: 'user' as const,
      text: 'x'.repeat(40),
      at: Date.parse(T(i + 1)),
    }));
    const chunks = chunkSession(session(turns), 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      // Each chunk is whole turns joined by a blank line.
      for (const part of c.text.split('\n\n')) expect(part).toMatch(/^HUMAN: x+$/);
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it('labels each turn by role and dates the chunk from its first turn', () => {
    const chunks = chunkSession(
      session([
        { role: 'user', text: 'q', at: Date.parse(T(3)) },
        { role: 'assistant', text: 'a', at: Date.parse(T(3)) },
        { role: 'command', text: '$ ls', at: Date.parse(T(3)) },
      ]),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text).toBe('HUMAN: q\n\nASSISTANT: a\n\nRAN: $ ls');
    expect(chunks[0]!.at).toBe(Date.parse(T(3)));
  });

  it('truncates one enormous turn instead of emitting a giant chunk', () => {
    const chunks = chunkSession(session([{ role: 'user', text: 'y'.repeat(50_000), at: 0 }]), 1000);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.text.length).toBeLessThan(1100);
  });

  it('returns nothing for a session with no turns', () => {
    expect(chunkSession(session([]))).toEqual([]);
  });
});
