import { afterEach, describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { secretGuard } from '../secret/secret-guard.js';
import { resolveServiceSecret } from './service-secret-resolver.js';

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
});
