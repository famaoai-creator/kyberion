import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { secretGuard } from '../secret/secret-guard.js';
import { loadServiceEndpointsCatalog } from './service-endpoint-registry.js';
import { buildServiceSecretReference, resolveServiceSecret } from './service-secret-resolver.js';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('strict service credential resolution', () => {
  it('preserves missing binding and contradictory identity failures for real consumers', () => {
    vi.stubEnv('AUTHORIZED_SCOPE', 'slack');
    runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () => {
      expect(() => resolveServiceSecret('slack', ['BOT_TOKEN'])).toThrow(
        '[CREDENTIAL_BINDING_REQUIRED]'
      );
      runInResourceAccessScope(
        { tenantSlug: 'beta', readExact: [], writeExact: [], mkdirExact: [] },
        () =>
          expect(() => resolveServiceSecret('slack', ['BOT_TOKEN'])).toThrow(
            '[CREDENTIAL_SCOPE_DENIED]'
          )
      );
      withTaskCredentialBinding({ tenantSlug: 'alpha', secrets: {} }, () =>
        expect(resolveServiceSecret('slack', ['BOT_TOKEN'])).toBeNull()
      );
    });
  });

  it('uses governed suffix fallbacks inside a matching trusted binding', () => {
    vi.stubEnv('AUTHORIZED_SCOPE', 'slack');
    vi.stubEnv('SLACK_ACCESS_TOKEN', 'operator-token');
    runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () =>
      withTaskCredentialBinding(
        { tenantSlug: 'alpha', secrets: { SLACK_BOT_TOKEN: 'bound-service-token' } },
        () =>
          expect(resolveServiceSecret('slack', ['ACCESS_TOKEN', 'BOT_TOKEN'])).toBe(
            'bound-service-token'
          )
      )
    );
  });

  it('preserves unrelated resolver errors', () => {
    const failure = new Error('secret resolver offline');
    vi.spyOn(secretGuard, 'getSecret').mockImplementation(() => {
      throw failure;
    });
    expect(() => resolveServiceSecret('slack', ['BOT_TOKEN'])).toThrow(failure);
  });

  it('finds a hyphenated service secret stored under its env-safe name (google-maps → GOOGLE_MAPS_API_KEY)', () => {
    // The reference name stays the binding / probe form; only the stored name is env-safe.
    expect(buildServiceSecretReference('google-maps', 'API_KEY').env).toBe('GOOGLE-MAPS_API_KEY');
    vi.stubEnv('AUTHORIZED_SCOPE', 'google-maps');
    vi.stubEnv('GOOGLE_MAPS_API_KEY', 'maps-operator-key');
    expect(resolveServiceSecret('google-maps', ['API_KEY'])).toBe('maps-operator-key');
  });

  it('keeps the env-safe stored names unique across the service catalog', () => {
    // secret-guard falls back from `A-B_X` to the stored `A_B_X`; two ids with
    // the same env-safe form (a-b and a_b) would share stored secrets.
    const ids = Object.keys(loadServiceEndpointsCatalog().services);
    const byStored = new Map<string, string[]>();
    for (const id of ids) {
      const stored = id.toUpperCase().replace(/[^A-Z0-9]+/g, '_');
      byStored.set(stored, [...(byStored.get(stored) ?? []), id]);
    }
    expect([...byStored.values()].filter((group) => group.length > 1)).toEqual([]);
  });
});
