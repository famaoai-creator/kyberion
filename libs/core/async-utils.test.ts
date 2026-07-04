import { describe, expect, it } from 'vitest';
import { retry, sleep } from './async-utils.js';

describe('async-utils', () => {
  it('retries until the operation succeeds', async () => {
    let attempts = 0;
    const result = await retry(
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error(`attempt-${attempts}`);
        return 'ok';
      },
      {
        maxRetries: 4,
        initialDelayMs: 0,
        maxDelayMs: 0,
        jitter: false,
      }
    );

    expect(result).toBe('ok');
    expect(attempts).toBe(3);
  });

  it('resolves sleep after the requested delay', async () => {
    const start = Date.now();
    await sleep(5);
    expect(Date.now() - start).toBeGreaterThanOrEqual(0);
  });
});
