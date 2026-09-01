import { describe, expect, it } from 'vitest';
import { readRequestObject } from './request-input';

describe('readRequestObject', () => {
  it.each([
    ['malformed JSON', () => Promise.reject(new SyntaxError('invalid JSON'))],
    ['null', async () => null],
    ['array', async () => []],
    ['string', async () => 'body'],
  ])('rejects %s instead of treating it as an empty request', async (_label, json) => {
    await expect(readRequestObject({ json })).resolves.toMatchObject({ ok: false });
  });

  it('returns the object for route-specific validation', async () => {
    const body = { decision: 'approved', note: 'operator confirmed' };
    await expect(readRequestObject({ json: async () => body })).resolves.toEqual({
      ok: true,
      body,
    });
  });
});
