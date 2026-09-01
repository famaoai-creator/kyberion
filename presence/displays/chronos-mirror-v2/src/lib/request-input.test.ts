import { describe, expect, it } from 'vitest';
import { readChronosJsonObject } from './request-input';

describe('readChronosJsonObject', () => {
  it.each([
    ['malformed JSON', () => Promise.reject(new SyntaxError('invalid JSON'))],
    ['null', async () => null],
    ['array', async () => []],
    ['string', async () => 'body'],
  ])('rejects %s before route logic', async (_label, json) => {
    await expect(readChronosJsonObject({ json }, 'Chronos test')).resolves.toMatchObject({
      ok: false,
    });
  });

  it('returns a JSON object unchanged', async () => {
    const body = { operation: 'approve', nested: { value: true } };
    await expect(
      readChronosJsonObject({ json: async () => body }, 'Chronos test')
    ).resolves.toEqual({
      ok: true,
      body,
    });
  });
});
