/**
 * Turn recall results into short text an LLM can read in a prompt.
 * Kept separate so the engine never cares how results are displayed.
 */
import type { Conflict, Fact } from './types.js';

function day(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function formatFacts(facts: Fact[], conflicts: Conflict[]): string {
  if (facts.length === 0) return '(no facts)';
  const lines: string[] = [];
  for (const f of facts) {
    const when = f.validTo === null ? `since ${day(f.validFrom)}` : `${day(f.validFrom)} → ${day(f.validTo)}`;
    const src = f.source.ref ? `${f.source.writer} via ${f.source.kind} ${f.source.ref}` : `${f.source.writer} via ${f.source.kind}`;
    const flag = f.status === 'conflicted' ? ' ⚠ CONFLICTED' : f.status === 'superseded' ? ' (superseded)' : '';
    const conf = f.confirmations > 1 ? ` ×${f.confirmations}` : '';
    lines.push(`- ${f.key} = ${f.value}${flag}${conf}\n    ${when} · ${src} · id ${f.id.slice(0, 8)}`);
  }
  if (conflicts.length > 0) {
    lines.push('');
    lines.push(`${conflicts.length} open conflict(s). These facts disagree and tempo has not picked a winner.`);
    lines.push('Use tempo_resolve with the conflict id once you know which is right.');
    for (const c of conflicts) lines.push(`  conflict ${c.id.slice(0, 8)} on "${c.key}": ${c.aId.slice(0, 8)} vs ${c.bId.slice(0, 8)}`);
  }
  return lines.join('\n');
}
