/**
 * The pure parts of the extractor, tested with no API key and no network.
 * The LLM call itself is exercised by scripts/extract-eval.ts, which costs
 * money and is not part of `npm test`.
 */
import { describe, expect, it } from 'vitest';
import { buildPrompt, sanitize, SYSTEM_PROMPT, type ExtractedFact } from './extract.ts';

const f = (o: Partial<ExtractedFact>): ExtractedFact => ({
  key: 'deploy.command',
  value: 'make deploy',
  validFrom: '',
  quote: 'we deploy with make deploy',
  ...o,
});

describe('the prompt', () => {
  it('tells the model that an empty validFrom is the expected answer', () => {
    expect(SYSTEM_PROMPT).toMatch(/empty validFrom is the correct, expected answer/i);
  });
  it('forbids using the date the text was written as validFrom', () => {
    expect(SYSTEM_PROMPT).toMatch(/Do NOT use the date the text was written/i);
  });
  it('includes the text and the source label', () => {
    const p = buildPrompt('hello world', { sourceLabel: 'slack #eng' });
    expect(p).toContain('hello world');
    expect(p).toContain('slack #eng');
  });
});

describe('sanitize', () => {
  it('keeps a well-formed fact and lowercases the key', () => {
    const { kept, dropped } = sanitize([f({ key: 'Deploy.Command' })]);
    expect(dropped).toHaveLength(0);
    expect(kept[0]!.key).toBe('deploy.command');
  });

  it('keeps an ISO validFrom', () => {
    const { kept } = sanitize([f({ validFrom: '2026-03-01' })]);
    expect(kept[0]!.validFrom).toBe('2026-03-01');
  });

  it.each([
    ['a key with spaces', f({ key: 'how we deploy' })],
    ['a key with slashes', f({ key: 'deploy/command' })],
    ['an empty key', f({ key: '  ' })],
    ['an empty value', f({ value: '' })],
    ['a vague date', f({ validFrom: 'last Tuesday' })],
    ['a half date', f({ validFrom: '2026-03' })],
    ['an impossible date', f({ validFrom: '2026-13-45' })],
  ])('drops %s', (_label, bad) => {
    const { kept, dropped } = sanitize([bad]);
    expect(kept).toHaveLength(0);
    expect(dropped).toHaveLength(1);
  });

  it('drops a repeated key within one extraction, keeping the first', () => {
    const { kept, dropped } = sanitize([f({ value: 'first' }), f({ value: 'second' })]);
    expect(kept.map((x) => x.value)).toEqual(['first']);
    expect(dropped[0]!.why).toMatch(/duplicate/);
  });

  it('says why each fact was dropped', () => {
    const { dropped } = sanitize([f({ key: 'bad key' })]);
    expect(dropped[0]!.why).toContain('bad key');
  });
});
