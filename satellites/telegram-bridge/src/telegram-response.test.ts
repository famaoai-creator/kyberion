import { describe, expect, it } from 'vitest';
import { parseTelegramApiResponse } from './index.js';
import { parsePollingResponse, parsePollingUpdates } from './polling-response.js';

describe('telegram external response parsers', () => {
  it('fails closed for an unsafe API response root', () => {
    const value = JSON.parse('{"ok":true,"__proto__":{"polluted":true}}') as unknown;

    expect(parseTelegramApiResponse(value)).toEqual({});
  });

  it('preserves only a safe polling response and valid update objects', () => {
    const response = parsePollingResponse({
      ok: true,
      result: [
        { update_id: 7, message: { text: 'hello' } },
        { update_id: 8.5, message: { text: 'invalid id' } },
        'invalid update',
      ],
    });

    expect(response.ok).toBe(true);
    expect(parsePollingUpdates(response.result)).toEqual([
      { update_id: 7, message: { text: 'hello' } },
    ]);
  });

  it('fails closed for an unsafe polling update', () => {
    const value = JSON.parse('[{"update_id":9,"__proto__":{"polluted":true}}]') as unknown;

    expect(parsePollingUpdates(value)).toEqual([]);
  });
});
