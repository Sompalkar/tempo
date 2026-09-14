/**
 * Read Claude Code session transcripts and turn them into chunks of text the
 * extractor can read.
 *
 * A transcript is a .jsonl file under ~/.claude/projects/<slug>/<session>.jsonl.
 * Each line is one event. We keep the parts where durable facts actually live:
 *
 *   - what the human asked for (user text)
 *   - what the assistant said in prose (assistant text)
 *   - shell commands that were run, and whether they worked
 *
 * We deliberately drop: thinking blocks (not decisions yet), file contents
 * (the repo already stores those), image blocks, and the giant tool results
 * from Read/Grep (search output, not knowledge).
 *
 * Nothing here talks to a network or an LLM, so it is fully tested.
 */
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface Turn {
  role: 'user' | 'assistant' | 'command';
  text: string;
  at: number;
}

export interface Session {
  sessionId: string;
  /** The working directory the session ran in. */
  cwd: string;
  /** The project slug, e.g. "-Users-som-dev-Robotrain-v2". */
  project: string;
  title: string;
  startedAt: number;
  endedAt: number;
  turns: Turn[];
  path: string;
}

interface Line {
  type?: string;
  uuid?: string;
  timestamp?: string;
  cwd?: string;
  sessionId?: string;
  customTitle?: string;
  aiTitle?: string;
  isSidechain?: boolean;
  message?: { role?: string; content?: unknown };
}

/** Text blocks only. Returns '' for anything else. */
function textOf(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const b of content as { type?: string; text?: string }[]) {
    if (b.type === 'text' && typeof b.text === 'string') out.push(b.text);
  }
  return out.join('\n').trim();
}

/** A Bash tool call becomes a one-line "command" turn. Other tools are skipped. */
function commandOf(content: unknown): string {
  if (!Array.isArray(content)) return '';
  const out: string[] = [];
  for (const b of content as { type?: string; name?: string; input?: Record<string, unknown> }[]) {
    if (b.type !== 'tool_use' || b.name !== 'Bash') continue;
    const cmd = b.input?.['command'];
    const desc = b.input?.['description'];
    if (typeof cmd === 'string') out.push(typeof desc === 'string' ? `$ ${cmd}    # ${desc}` : `$ ${cmd}`);
  }
  return out.join('\n');
}

/** Parse one .jsonl transcript. Bad lines are skipped, not fatal. */
export function parseTranscript(path: string, project: string): Session | null {
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return null;
  }

  const turns: Turn[] = [];
  let sessionId = '';
  let cwd = '';
  let title = '';
  let first = Infinity;
  let last = 0;

  for (const line of raw.split('\n')) {
    if (!line) continue;
    let d: Line;
    try {
      d = JSON.parse(line) as Line;
    } catch {
      continue;
    }

    if (d.sessionId && !sessionId) sessionId = d.sessionId;
    if (d.cwd && !cwd) cwd = d.cwd;
    if (d.customTitle) title = d.customTitle;
    else if (d.aiTitle && !title) title = d.aiTitle;

    // Sidechains are subagent runs; their conclusions reach the main thread anyway.
    if (d.isSidechain) continue;
    if (d.type !== 'user' && d.type !== 'assistant') continue;

    const at = d.timestamp ? Date.parse(d.timestamp) : 0;
    if (at) {
      if (at < first) first = at;
      if (at > last) last = at;
    }

    const content = d.message?.content;
    if (d.type === 'user') {
      const t = textOf(content);
      // Pasted tool output and system reminders are noise, not intent.
      if (t && !t.startsWith('<system-reminder>') && !t.startsWith('Caveat:')) {
        turns.push({ role: 'user', text: t, at });
      }
    } else {
      const t = textOf(content);
      if (t) turns.push({ role: 'assistant', text: t, at });
      const c = commandOf(content);
      if (c) turns.push({ role: 'command', text: c, at });
    }
  }

  if (turns.length === 0) return null;
  return {
    sessionId: sessionId || path,
    cwd,
    project,
    title: title || '(untitled)',
    startedAt: first === Infinity ? 0 : first,
    endedAt: last,
    turns,
    path,
  };
}

/** The project slug is the transcript's parent directory name. */
export function projectOf(transcriptPath: string): string {
  const parts = transcriptPath.split('/');
  return parts[parts.length - 2] ?? 'unknown';
}

/** Every session under ~/.claude/projects, newest first. */
export function findSessions(opts: { root?: string; projects?: string[] } = {}): Session[] {
  const root = opts.root ?? join(homedir(), '.claude', 'projects');
  const out: Session[] = [];
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return out;
  }
  for (const project of dirs) {
    if (opts.projects && !opts.projects.includes(project)) continue;
    const dir = join(root, project);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.jsonl')) continue;
      const s = parseTranscript(join(dir, file), project);
      if (s) out.push(s);
    }
  }
  return out.sort((a, b) => b.startedAt - a.startedAt);
}

/**
 * The key ingest uses to remember a chunk is done. Content only — no session
 * id — because Claude Code gives a resumed conversation a NEW session id
 * with the OLD messages copied in. Keyed by session, every resume re-ingested
 * the whole history.
 */
export function chunkDoneKey(c: Chunk): string {
  return `chunk:${c.hash}`;
}

export interface Chunk {
  text: string;
  sessionId: string;
  project: string;
  title: string;
  /** Timestamp of the first turn in this chunk. Used as the write time. */
  at: number;
  /** Index of this chunk within its session, for the source pointer. */
  index: number;
  /**
   * Short hash of the text. The LAST chunk of a live session keeps growing
   * as turns are added, so "chunk 7 already done" is only true for the text
   * chunk 7 had at the time. Ingest keys its done-list on index + hash.
   */
  hash: string;
}

/**
 * Cut a session into chunks of roughly `targetChars`, never splitting a turn.
 * Chunking on turn boundaries keeps a question and its answer together, which
 * is where facts usually live.
 */
export function chunkSession(s: Session, targetChars = 6000): Chunk[] {
  const chunks: Chunk[] = [];
  let buf: string[] = [];
  let size = 0;
  let at = s.startedAt;

  const flush = () => {
    if (buf.length === 0) return;
    const text = buf.join('\n\n');
    chunks.push({
      text,
      sessionId: s.sessionId,
      project: s.project,
      title: s.title,
      at,
      index: chunks.length,
      hash: createHash('sha1').update(text).digest('hex').slice(0, 16),
    });
    buf = [];
    size = 0;
  };

  for (const t of s.turns) {
    const label = t.role === 'user' ? 'HUMAN' : t.role === 'assistant' ? 'ASSISTANT' : 'RAN';
    // One very long turn still gets through, just truncated — a 200KB paste
    // is not worth the tokens and its tail is rarely the interesting part.
    const piece = `${label}: ${t.text.slice(0, targetChars)}`;
    if (size > 0 && size + piece.length > targetChars) flush();
    if (buf.length === 0) at = t.at || s.startedAt;
    buf.push(piece);
    size += piece.length;
  }
  flush();
  return chunks;
}
