import { describe, expect, it } from 'vitest';
import { KeyedQueue } from './keyed-queue.ts';

const tick = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('KeyedQueue', () => {
  it('runs jobs with the same key strictly in order, even if the first is slow', async () => {
    const q = new KeyedQueue(8);
    const log: string[] = [];
    q.add('k', async () => { await tick(30); log.push('first'); });
    q.add('k', async () => { log.push('second'); });
    q.add('k', async () => { log.push('third'); });
    await q.drain();
    expect(log).toEqual(['first', 'second', 'third']);
  });

  it('lets jobs with different keys overlap', async () => {
    const q = new KeyedQueue(8);
    let peak = 0;
    let running = 0;
    const job = async () => {
      running++;
      peak = Math.max(peak, running);
      await tick(20);
      running--;
    };
    for (const k of ['a', 'b', 'c', 'd']) q.add(k, job);
    await q.drain();
    expect(peak).toBe(4);
  });

  it('never runs more than maxInFlight at once across all keys', async () => {
    const q = new KeyedQueue(2);
    let peak = 0;
    let running = 0;
    const job = async () => {
      running++;
      peak = Math.max(peak, running);
      await tick(15);
      running--;
    };
    for (let i = 0; i < 6; i++) q.add(`k${i}`, job);
    await q.drain();
    expect(peak).toBe(2);
  });

  it('a failing job does not block later jobs on the same key', async () => {
    const q = new KeyedQueue(4);
    const log: string[] = [];
    const failing = q.add('k', async () => { throw new Error('boom'); });
    q.add('k', async () => { log.push('after'); });
    await expect(failing).rejects.toThrow('boom');
    await q.drain();
    expect(log).toEqual(['after']);
  });

  it('returns each job\'s own result', async () => {
    const q = new KeyedQueue(4);
    const r = await q.add('k', async () => 42);
    expect(r).toBe(42);
  });

  it('drain waits for jobs added while draining', async () => {
    const q = new KeyedQueue(4);
    const log: string[] = [];
    q.add('a', async () => {
      await tick(10);
      log.push('a');
      q.add('b', async () => { log.push('b'); });
    });
    await q.drain();
    expect(log).toEqual(['a', 'b']);
  });

  it('rejects a cap below 1', () => {
    expect(() => new KeyedQueue(0)).toThrow();
  });
});
