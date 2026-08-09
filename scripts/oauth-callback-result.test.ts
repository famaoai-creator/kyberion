import { describe, expect, it } from 'vitest';
import { toPersistedOAuthCallbackResult } from './oauth-callback-result.js';

describe('oauth callback result persistence', () => {
  it('redacts provider credentials from the runtime summary', () => {
    const persisted = toPersistedOAuthCallbackResult({
      ok: true,
      serviceId: 'canva',
      result: {
        access_token: 'access-secret',
        refresh_token: 'refresh-secret',
        persisted_path: 'knowledge/personal/connections/canva.json',
        persisted_keys: ['access_token', 'refresh_token'],
      },
    });

    expect(persisted).toEqual({
      ok: true,
      serviceId: 'canva',
      persisted_path: 'knowledge/personal/connections/canva.json',
      persisted_keys: ['access_token', 'refresh_token'],
    });
    expect(JSON.stringify(persisted)).not.toContain('access-secret');
    expect(JSON.stringify(persisted)).not.toContain('refresh-secret');
  });
});
