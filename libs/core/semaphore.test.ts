import { describe, expect, it } from 'vitest';
import { Semaphore } from './semaphore.js';

describe('Semaphore', () => {
  it('limits concurrent tasks', async () => {
    const semaphore = new Semaphore(2);
    let active = 0;
    let peak = 0;

    await Promise.all(
      Array.from({ length: 5 }, () =>
        semaphore.run(async () => {
          active += 1;
          peak = Math.max(peak, active);
          await new Promise((resolve) => setTimeout(resolve, 5));
          active -= 1;
        }),
      ),
    );

    expect(peak).toBe(2);
  });

  it('releases the slot when a task throws', async () => {
    const semaphore = new Semaphore(1);

    await expect(semaphore.run(async () => {
      throw new Error('boom');
    })).rejects.toThrow('boom');

    await expect(semaphore.run(async () => 'ok')).resolves.toBe('ok');
  });
});
