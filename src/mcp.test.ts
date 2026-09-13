/**
 * End-to-end: spawn the real MCP server as a child process and talk to it
 * with the real MCP client, the way Claude Code would.
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

let dir: string;
let client: Client;

async function connect(writer: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: 'node',
    args: [join(process.cwd(), 'src', 'mcp.ts')],
    env: { ...process.env, TEMPO_DB: join(dir, 't.db'), TEMPO_ORG: 'acme', TEMPO_WRITER: writer },
  });
  const c = new Client({ name: 'test', version: '0' });
  await c.connect(transport);
  return c;
}

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'tempo-'));
  client = await connect('agent-alice');
});
afterAll(async () => {
  await client.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('mcp server', () => {
  it('exposes the four tools', async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual(['tempo_conflicts', 'tempo_recall', 'tempo_remember', 'tempo_resolve']);
  });

  it('remember then recall round-trips through the protocol', async () => {
    const r = await client.callTool({ name: 'tempo_remember', arguments: { key: 'deploy.command', value: 'make deploy' } });
    expect((r.structuredContent as { action: string }).action).toBe('inserted');

    const q = await client.callTool({ name: 'tempo_recall', arguments: { key: 'deploy.command' } });
    const text = (q.content as { type: string; text: string }[])[0]!.text;
    expect(text).toContain('deploy.command = make deploy');
    expect(text).toContain('agent-alice');
  });

  it('accepts ISO dates for validFrom', async () => {
    const r = await client.callTool({ name: 'tempo_remember', arguments: { key: 'refund.policy', value: '30 days', validFrom: '2026-03-01' } });
    expect((r.structuredContent as { action: string }).action).toBe('inserted');
    const q = await client.callTool({ name: 'tempo_recall', arguments: { key: 'refund.policy' } });
    expect((q.content as { text: string }[])[0]!.text).toContain('since 2026-03-01');
  });

  it('a second agent disagreeing produces a visible conflict, and resolve clears it', async () => {
    const bob = await connect('agent-bob');
    try {
      const r = await client.callTool({ name: 'tempo_remember', arguments: { key: 'db.primary', value: 'postgres' } });
      expect((r.structuredContent as { action: string }).action).toBe('inserted');
      const r2 = await bob.callTool({ name: 'tempo_remember', arguments: { key: 'db.primary', value: 'mysql' } });
      const s2 = r2.structuredContent as { action: string; conflictId: string; id: string };
      expect(s2.action).toBe('conflict');

      const q = await bob.callTool({ name: 'tempo_recall', arguments: { key: 'db.primary' } });
      const text = (q.content as { text: string }[])[0]!.text;
      expect(text).toContain('CONFLICTED');
      expect(text).toContain('1 open conflict');

      await bob.callTool({ name: 'tempo_resolve', arguments: { conflictId: s2.conflictId, winnerId: s2.id, reason: 'checked docker-compose' } });
      const q2 = await client.callTool({ name: 'tempo_recall', arguments: { key: 'db.primary' } });
      const t2 = (q2.content as { text: string }[])[0]!.text;
      expect(t2).toContain('= mysql');
      expect(t2).not.toContain('CONFLICTED');
    } finally {
      await bob.close();
    }
  });
});
