#!/usr/bin/env node
/**
 * tempo as an MCP server (stdio).
 *
 * Any MCP client — Claude Code, Codex, Cursor, your own agent — can add this
 * and get four tools: tempo_remember, tempo_recall, tempo_conflicts,
 * tempo_resolve.
 *
 * Configuration is by environment variable so the same binary works for
 * every client:
 *   TEMPO_DB      path to the sqlite file   (default ~/.tempo/tempo.db)
 *   TEMPO_ORG     org name                  (default "default")
 *   TEMPO_WRITER  who this agent is         (default "$USER@$HOST")
 *   TEMPO_POLICY  conflict | prefer-newer   (default conflict)
 */
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { hostname, homedir, userInfo } from 'node:os';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { TempoStore, type UndatedDisagreementPolicy } from './store.ts';
import { formatFacts } from './format.ts';

const dbPath = process.env['TEMPO_DB'] ?? join(homedir(), '.tempo', 'tempo.db');
const org = process.env['TEMPO_ORG'] ?? 'default';
const writer = process.env['TEMPO_WRITER'] ?? `${userInfo().username}@${hostname()}`;
const policy = (process.env['TEMPO_POLICY'] ?? 'conflict') as UndatedDisagreementPolicy;

mkdirSync(dirname(dbPath), { recursive: true });
const store = new TempoStore(dbPath, { onUndatedDisagreement: policy });

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const server = new McpServer({ name: 'tempo', version: pkg.version });

/** ISO date or ms → ms. Lets agents pass "2026-03-01" instead of a number. */
const timeArg = z
  .union([z.number(), z.string()])
  .optional()
  .transform((v) => {
    if (v === undefined) return undefined;
    if (typeof v === 'number') return v;
    const ms = Date.parse(v);
    if (Number.isNaN(ms)) throw new Error(`not a date: ${v}`);
    return ms;
  });

server.registerTool(
  'tempo_remember',
  {
    title: 'Remember a fact',
    description:
      'Store one fact about one thing. Use a dotted key like "deploy.command" or "customer.acme.contract_end". ' +
      'If you know WHEN the fact became true, pass validFrom (ISO date). If you do not, leave it out — tempo ' +
      'will treat the time as unknown rather than guessing. Returns what tempo did: inserted, corroborated, ' +
      'superseded, backfilled, or conflict.',
    inputSchema: {
      key: z.string().min(1),
      value: z.string().min(1),
      validFrom: timeArg,
      validTo: timeArg,
      sourceKind: z.string().default('session'),
      sourceRef: z.string().optional(),
      private: z.boolean().optional().describe('If true, write nothing at all.'),
    },
  },
  (args) => {
    const source: { writer: string; kind: string; ref?: string } = { writer, kind: args.sourceKind };
    if (args.sourceRef !== undefined) source.ref = args.sourceRef;
    const input: Parameters<TempoStore['remember']>[0] = { org, key: args.key, value: args.value, source };
    if (args.validFrom !== undefined) input.validFrom = args.validFrom;
    if (args.validTo !== undefined) input.validTo = args.validTo;
    if (args.private !== undefined) input.private = args.private;
    const r = store.remember(input);
    const text =
      r.action === 'conflict'
        ? `conflict: "${args.key}" already has a different current value from another writer. Both kept. conflict id ${r.conflictId}. Call tempo_recall to see both, tempo_resolve to pick.`
        : `${r.action}: ${args.key}`;
    return { content: [{ type: 'text', text }], structuredContent: { ...r } };
  },
);

server.registerTool(
  'tempo_recall',
  {
    title: 'Recall facts',
    description:
      'Read facts. Filter by key (exact, or prefix ending in "."), and/or by query (text search in values). ' +
      'validAt asks "what was true at this moment?" asOf asks "what did we know at this moment?" ' +
      'Both default to now. Facts marked CONFLICTED have another current fact that disagrees — do not trust either blindly.',
    inputSchema: {
      key: z.string().optional(),
      query: z.string().optional(),
      validAt: timeArg,
      asOf: timeArg,
      includeHistory: z.boolean().optional(),
      limit: z.number().int().positive().max(200).optional(),
    },
  },
  (args) => {
    const input: Parameters<TempoStore['recall']>[0] = { org };
    if (args.key !== undefined) input.key = args.key;
    if (args.query !== undefined) input.query = args.query;
    if (args.validAt !== undefined) input.validAt = args.validAt;
    if (args.asOf !== undefined) input.asOf = args.asOf;
    if (args.includeHistory !== undefined) input.includeHistory = args.includeHistory;
    if (args.limit !== undefined) input.limit = args.limit;
    const r = store.recall(input);
    return { content: [{ type: 'text', text: formatFacts(r.facts, r.conflicts) }], structuredContent: { ...r } };
  },
);

server.registerTool(
  'tempo_conflicts',
  {
    title: 'List conflicts',
    description: 'List facts that disagree. Default: open ones only.',
    inputSchema: { status: z.enum(['open', 'resolved', 'all']).optional() },
  },
  (args) => {
    const list = store.conflicts(org, args.status !== undefined ? { status: args.status } : {});
    const text =
      list.length === 0
        ? 'no conflicts'
        : list
            .map((c) => {
              const a = store.get(org, c.aId);
              const b = store.get(org, c.bId);
              return `${c.status} · ${c.id}\n  key "${c.key}"\n  A ${c.aId} = ${a?.value ?? '?'} (${a?.source.writer ?? '?'})\n  B ${c.bId} = ${b?.value ?? '?'} (${b?.source.writer ?? '?'})${c.winnerId ? `\n  winner ${c.winnerId}: ${c.reason}` : ''}`;
            })
            .join('\n');
    return { content: [{ type: 'text', text }], structuredContent: { conflicts: list } };
  },
);

server.registerTool(
  'tempo_resolve',
  {
    title: 'Resolve a conflict',
    description: 'Pick which of two disagreeing facts is right. Say why — the reason is kept forever.',
    inputSchema: { conflictId: z.string(), winnerId: z.string(), reason: z.string().min(1) },
  },
  (args) => {
    const c = store.resolve({ org, ...args });
    return { content: [{ type: 'text', text: `resolved ${c.id}: winner ${c.winnerId}` }], structuredContent: { ...c } };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
