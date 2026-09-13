#!/usr/bin/env node
/**
 * Run StaleBench against every adapter and print a table.
 *
 *   npm run bench            → table on stdout
 *   npm run bench -- --md    → also writes bench/RESULTS.md
 */
import { writeFileSync, mkdirSync } from 'node:fs';
import type { MemoryAdapter } from './adapter.js';
import { appendOnlyAdapter, lastWriteWinsAdapter } from './adapters/baselines.js';
import { tempoAdapter } from './adapters/tempo.js';
import { scenarios, type Problem } from './scenarios.js';

const adapters: MemoryAdapter[] = [lastWriteWinsAdapter(), appendOnlyAdapter(), tempoAdapter()];

interface Cell {
  pass: boolean;
  got: string;
}

const results = new Map<string, Map<string, Cell>>(); // scenario id -> adapter name -> cell

for (const s of scenarios) {
  const row = new Map<string, Cell>();
  for (const a of adapters) {
    try {
      row.set(a.name, await s.run(a));
    } catch (e) {
      row.set(a.name, { pass: false, got: `threw: ${(e as Error).message}` });
    }
  }
  results.set(s.id, row);
}

// ---- print --------------------------------------------------------------

const problems: Problem[] = ['temporal', 'contradiction', 'provenance', 'boundary'];
const mark = (c: Cell | undefined) => (c?.pass ? 'PASS' : 'FAIL');

const lines: string[] = [];
lines.push('# StaleBench results');
lines.push('');
lines.push('Each row is one scenario. Each column is one memory system. PASS means the system gave the correct answer.');
lines.push('');
lines.push('| id | scenario | ' + adapters.map((a) => a.name).join(' | ') + ' |');
lines.push('|---|---|' + adapters.map(() => ':---:').join('|') + '|');
for (const p of problems) {
  lines.push(`| **${p}** | | ${adapters.map(() => '').join(' | ')} |`);
  for (const s of scenarios.filter((x) => x.problem === p)) {
    const row = results.get(s.id)!;
    lines.push(`| ${s.id} | ${s.title} | ${adapters.map((a) => mark(row.get(a.name))).join(' | ')} |`);
  }
}
lines.push('');
lines.push('| | ' + adapters.map((a) => a.name).join(' | ') + ' |');
lines.push('|---|' + adapters.map(() => ':---:').join('|') + '|');
const totals = adapters.map((a) => {
  let n = 0;
  for (const s of scenarios) if (results.get(s.id)!.get(a.name)?.pass) n++;
  return `${n}/${scenarios.length}`;
});
lines.push('| **total** | ' + totals.join(' | ') + ' |');
lines.push('');
lines.push('## Systems');
lines.push('');
for (const a of adapters) lines.push(`- **${a.name}** — ${a.description}`);
lines.push('');
lines.push('## What each system actually returned');
lines.push('');
for (const s of scenarios) {
  lines.push(`### ${s.id} — ${s.title}`);
  lines.push('');
  for (const a of adapters) {
    const c = results.get(s.id)!.get(a.name)!;
    lines.push(`- ${a.name}: ${c.pass ? 'PASS' : 'FAIL'} — ${c.got}`);
  }
  lines.push('');
}

const out = lines.join('\n');
console.log(out);

if (process.argv.includes('--md')) {
  mkdirSync('bench', { recursive: true });
  writeFileSync('bench/RESULTS.md', out + '\n');
  console.error('wrote bench/RESULTS.md');
}
