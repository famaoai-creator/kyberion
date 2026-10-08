import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ServicePresetRecord } from './service-preset-registry.js';

const mocks = vi.hoisted(() => ({
  secureFetch: vi.fn(),
  loadConnectionDocument: vi.fn(),
  loadConnectionWithFallback: vi.fn(() => {
    throw new Error('probe must not load runtime connection');
  }),
  transformPreset: (preset: ServicePresetRecord): ServicePresetRecord => preset,
}));
vi.mock('../network.js', async () => ({
  ...(await vi.importActual<typeof import('../network.js')>('../network.js')),
  secureFetch: mocks.secureFetch,
}));
vi.mock('../secret/secret-guard.js', async () => ({
  ...(await vi.importActual<typeof import('../secret/secret-guard.js')>(
    '../secret/secret-guard.js'
  )),
  loadConnectionDocument: mocks.loadConnectionDocument,
}));
vi.mock('./service-engine-helpers.js', async () => ({
  ...(await vi.importActual<typeof import('./service-engine-helpers.js')>(
    './service-engine-helpers.js'
  )),
  loadConnectionWithFallback: mocks.loadConnectionWithFallback,
}));
vi.mock('./service-preset-registry.js', async () => {
  const actual = await vi.importActual<typeof import('./service-preset-registry.js')>(
    './service-preset-registry.js'
  );
  return {
    ...actual,
    getServicePresetRecord: (...args: Parameters<typeof actual.getServicePresetRecord>) => {
      const preset = actual.getServicePresetRecord(...args);
      return preset ? mocks.transformPreset(structuredClone(preset)) : null;
    },
  };
});

import { logger } from '../core.js';
import { SecureFetchError } from '../network.js';
import { getSecret } from '../secret/secret-guard.js';
import { registerSecretResolver, resetSecretResolver } from '../secret/secret-resolver.js';
import { withPluginExecutionFrame } from '../shell/sandbox-policy.js';
import { executeServicePreset } from './service-engine.js';
import { getServiceEndpointRecord } from './service-endpoint-registry.js';
import {
  listOperatorServiceConnections,
  probeOperatorServiceConnection,
  type OperatorServiceConnectionPrincipal,
} from './operator-service-connection.js';
import { loadOperatorServiceConnectionCatalog } from './operator-service-connection-catalog.js';
import {
  consumeOperatorServiceProbeAdmission,
  issueOperatorServiceProbeAdmission,
  operatorProbeSecretAccess,
  runOperatorServiceProbeScope,
} from './operator-service-connection-admission.js';

const principal: OperatorServiceConnectionPrincipal = {
  role: 'localadmin',
  source: 'loopback',
  principalId: 'human:test-operator',
  loopback: true,
};
const tokens: Record<string, string> = {
  github: 'synthetic-github-registration',
  slack: 'synthetic-slack-registration',
};
const probe = (serviceId = 'github') => probeOperatorServiceConnection({ principal, serviceId });
const frame = {
  pluginId: 'untrusted-test',
  grant: {
    network: { mode: 'none' as const, hosts: [] },
    fs: { mode: 'none' as const, paths: [] },
    ops_invoke: [],
    env: [],
    secrets: ['*'],
  },
};

beforeEach(() => {
  vi.clearAllMocks();
  resetSecretResolver();
  mocks.transformPreset = (preset) => preset;
  vi.stubEnv('MISSION_ID', '');
  vi.stubEnv('AUTHORIZED_SCOPE', '');
  vi.stubEnv('GITHUB_ACCESS_TOKEN', tokens.github);
  vi.stubEnv('SLACK_ACCESS_TOKEN', tokens.slack);
  mocks.loadConnectionDocument.mockImplementation((serviceId: string) => ({
    access_token: tokens[serviceId],
    client_secret: 'unrelated-private-field',
    base_url: 'https://attacker.invalid',
  }));
  mocks.secureFetch.mockImplementation(async ({ url }: { url: string }) =>
    url === 'https://api.github.com/user'
      ? { id: 123, login: 'synthetic', private: tokens.github }
      : { ok: true, token: tokens.slack }
  );
});
afterEach(() => {
  resetSecretResolver();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('local operator service connection capability', () => {
  it('loads validated descriptors and separates registration presence from authentication', () => {
    const descriptors = listOperatorServiceConnections(principal);
    expect(
      descriptors.map(({ serviceId, secretKey, credential_present }) => ({
        serviceId,
        secretKey,
        credential_present,
      }))
    ).toEqual([
      { serviceId: 'github', secretKey: 'ACCESS_TOKEN', credential_present: true },
      { serviceId: 'slack', secretKey: 'ACCESS_TOKEN', credential_present: true },
    ]);
    expect(JSON.stringify(descriptors)).not.toContain('synthetic-');
    expect(JSON.stringify(descriptors)).not.toContain('unrelated-private-field');
    expect(mocks.secureFetch).not.toHaveBeenCalled();
    const catalog = loadOperatorServiceConnectionCatalog();
    catalog[0].serviceId = 'mutated';
    expect(loadOperatorServiceConnectionCatalog()[0].serviceId).toBe('github');
  });

  it.each([
    { loopback: false },
    { source: 'token' },
    { role: 'readonly' },
    { role: 'member' },
    { source: 'anonymous' },
    { principalId: '' },
  ])('denies an unproven or non-operator principal before secret reads: %o', async (change) => {
    const invalid = { ...principal, ...change } as OperatorServiceConnectionPrincipal;
    expect(() => listOperatorServiceConnections(invalid)).toThrow(
      'OPERATOR_SERVICE_CONNECTION_DENIED'
    );
    await expect(
      probeOperatorServiceConnection({ principal: invalid, serviceId: 'github' })
    ).rejects.toThrow('OPERATOR_SERVICE_CONNECTION_DENIED');
    expect(mocks.loadConnectionDocument).not.toHaveBeenCalled();
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });

  it('denies plugin frames even when the plugin has wildcard secrets', async () => {
    await expect(withPluginExecutionFrame(frame, () => probe())).rejects.toThrow(
      'OPERATOR_SERVICE_CONNECTION_DENIED'
    );
    expect(mocks.loadConnectionDocument).not.toHaveBeenCalled();
  });

  it('fails closed on unsupported services without reading credentials', async () => {
    expect(await probe('evil')).toMatchObject({ serviceId: 'evil', status: 'unsupported' });
    expect(mocks.loadConnectionDocument).not.toHaveBeenCalled();
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });

  it('uses the actual GitHub runtime API adapter with one pinned access token', async () => {
    const resolver = vi.fn(() => tokens.github);
    registerSecretResolver({ name: 'synthetic', resolve: resolver });
    const result = await probe();
    expect(result).toEqual({
      serviceId: 'github',
      status: 'authenticated',
      checkedAt: expect.any(String),
    });
    expect(resolver).toHaveBeenCalledTimes(1);
    expect(resolver).toHaveBeenCalledWith({
      key: 'GITHUB_ACCESS_TOKEN',
      scope: 'github',
      operation: 'service.resolve',
    });
    expect(mocks.loadConnectionWithFallback).not.toHaveBeenCalled();
    expect(mocks.secureFetch).toHaveBeenCalledTimes(1);
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://api.github.com/user',
        method: 'GET',
        headers: { Authorization: 'Bearer ' + tokens.github },
        authenticateRequest: true,
        maxRedirects: 0,
        maxContentLength: 65536,
        timeout: 10000,
        kyberion_allow_local_network: false,
        params: {},
      })
    );
    expect(JSON.stringify(result)).not.toContain(tokens.github);
    expect(() => getSecret('GITHUB_ACCESS_TOKEN', 'github', 'service.resolve')).toThrow(
      'TIBA_VIOLATION'
    );
  });

  it('uses the documented Slack POST auth.test and requires ok=true', async () => {
    expect(await probe('slack')).toMatchObject({ status: 'authenticated' });
    expect(mocks.secureFetch).toHaveBeenCalledWith(
      expect.objectContaining({
        url: 'https://slack.com/api/auth.test',
        method: 'POST',
        headers: expect.objectContaining({ Authorization: 'Bearer ' + tokens.slack }),
      })
    );
    mocks.secureFetch.mockResolvedValue({ ok: false, error: 'invalid_auth', token: tokens.slack });
    expect(await probe('slack')).toMatchObject({ status: 'authentication_failed' });
    mocks.secureFetch.mockResolvedValue({ ok: 'true' });
    expect(await probe('slack')).toMatchObject({ status: 'authentication_failed' });
  });

  it.each([
    {},
    { id: 1 },
    { id: '1', login: 'test' },
    { id: 0, login: 'test' },
    { id: 1, login: '' },
    [],
    null,
  ])('does not authenticate a malformed GitHub response: %o', async (payload) => {
    mocks.secureFetch.mockResolvedValue(payload);
    expect(await probe()).toMatchObject({ status: 'authentication_failed' });
  });

  it('does not send an environment or upstream token shadowing the local registration', async () => {
    vi.stubEnv('GITHUB_ACCESS_TOKEN', 'synthetic-environment-shadow');
    expect(await probe()).toMatchObject({ status: 'credential_shadowed' });
    vi.stubEnv('GITHUB_ACCESS_TOKEN', tokens.github);
    registerSecretResolver({ name: 'upstream', resolve: () => 'synthetic-upstream-shadow' });
    expect(await probe()).toMatchObject({ status: 'credential_shadowed' });
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });

  it('reports missing registration even when a service-global token exists', async () => {
    mocks.loadConnectionDocument.mockReturnValue({});
    expect(await probe()).toMatchObject({ status: 'credential_missing' });
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });

  it('never re-resolves the token after comparing the effective runtime binding', async () => {
    let calls = 0;
    registerSecretResolver({
      name: 'rotating',
      resolve: () => (++calls === 1 ? tokens.github : 'later-secret'),
    });
    expect(await probe()).toMatchObject({ status: 'authenticated' });
    expect(calls).toBe(1);
    expect(mocks.secureFetch.mock.calls[0][0].headers.Authorization).toBe(
      'Bearer ' + tokens.github
    );
  });

  it('does not mark a concurrent newer registration verified', async () => {
    mocks.secureFetch.mockImplementation(async () => {
      mocks.loadConnectionDocument.mockReturnValue({ access_token: 'newer-registration' });
      return { id: 1, login: 'test' };
    });
    expect(await probe()).toMatchObject({ status: 'unavailable' });
  });

  it.each([
    { method: 'DELETE' },
    { path: 'repos/write' },
    { risk: 'write' },
    { alternatives: [{ type: 'cli', command: 'gh' }] },
    { base_url: 'https://attacker.invalid' },
    { output_mapping: { id: 'other' } },
    { headers: { Authorization: 'unexpected' } },
    { parameters: { url: { type: 'string' } } },
    { allow_local_network: true },
  ])('rejects drift from the allowlisted fixed read-only runtime operation: %o', async (patch) => {
    mocks.transformPreset = (preset) => ({
      ...preset,
      operations: {
        ...preset.operations,
        authenticated_user: { ...preset.operations.authenticated_user, ...patch },
      },
    });
    expect(await probe()).toMatchObject({ status: 'unsupported' });
    expect(mocks.secureFetch).not.toHaveBeenCalled();
  });

  it('returns only a bounded failure status with no retries or raw provider error', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined);
    mocks.secureFetch.mockRejectedValue(
      new Error('Authorization: Bearer ' + tokens.github + ' PRIVATE_PROVIDER_RESPONSE')
    );
    const result = await probe();
    expect(result).toMatchObject({ status: 'unavailable' });
    expect(mocks.secureFetch).toHaveBeenCalledTimes(1);
    expect(JSON.stringify([result, warn.mock.calls, error.mock.calls])).not.toContain(
      tokens.github
    );
    expect(JSON.stringify([result, warn.mock.calls, error.mock.calls])).not.toContain(
      'PRIVATE_PROVIDER_RESPONSE'
    );
  });

  it.each([
    [401, 'authentication_failed'],
    [403, 'unavailable'],
    [429, 'unavailable'],
    [503, 'unavailable'],
  ])('classifies only safe HTTP 401 as failed authentication (%s)', async (status, expected) => {
    mocks.secureFetch.mockRejectedValue(
      new SecureFetchError('provider-private-detail', status as number)
    );
    const result = await probe();
    expect(result.status).toBe(expected);
    expect(JSON.stringify(result)).not.toContain('provider-private-detail');
  });

  it('sanitizes upstream resolver failure logs without changing fallback binding semantics', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    registerSecretResolver({
      name: 'UNTRUSTED_RESOLVER_NAME',
      resolve: () => {
        throw new Error('UNTRUSTED_ERROR ' + tokens.github);
      },
    });
    expect(await probe()).toMatchObject({ status: 'authenticated' });
    const logs = JSON.stringify(warn.mock.calls);
    expect(logs).not.toContain('UNTRUSTED_');
    expect(logs).not.toContain(tokens.github);
  });

  it('sanitizes resolver diagnostics during registration presence checks outside a probe', () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    registerSecretResolver({
      name: 'PRIVATE_NAME',
      resolve: () => {
        throw new Error('PRIVATE_ERROR');
      },
    });
    expect(getSecret('GITHUB_ACCESS_TOKEN')).toBe(tokens.github);
    expect(JSON.stringify(warn.mock.calls)).not.toContain('PRIVATE_');
  });

  it('consumes a rejected async upstream resolver without leaking its error', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
    registerSecretResolver({
      name: 'UNTRUSTED_ASYNC_NAME',
      resolve: async () => {
        throw new Error('UNTRUSTED_ASYNC_ERROR ' + tokens.github);
      },
    });
    expect(await probe()).toMatchObject({ status: 'authenticated' });
    await new Promise<void>((resolve) => setImmediate(resolve));
    const logs = JSON.stringify(warn.mock.calls);
    expect(logs).not.toContain('UNTRUSTED_');
    expect(logs).not.toContain(tokens.github);
    expect(logs).toContain('Async resolver rejected after sync fallback');
  });

  it('isolates simultaneous probes and leaves unrelated requests unauthorized', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.secureFetch.mockImplementation(async ({ url }: { url: string }) => {
      await gate;
      return url.includes('github') ? { id: 1, login: 'test' } : { ok: true };
    });
    const github = probe();
    const slack = probe('slack');
    expect(() => getSecret('GITHUB_ACCESS_TOKEN', 'github', 'service.resolve')).toThrow(
      'TIBA_VIOLATION'
    );
    release();
    expect((await Promise.all([github, slack])).map((result) => result.status)).toEqual([
      'authenticated',
      'authenticated',
    ]);
    expect(
      mocks.secureFetch.mock.calls.map(([request]) => request.headers.Authorization).sort()
    ).toEqual(['Bearer ' + tokens.github, 'Bearer ' + tokens.slack].sort());
  });
});

describe('private probe authority and opaque engine admission', () => {
  it('allows only the exact service, secret names, and binding operation', async () => {
    vi.stubEnv('AUTHORIZED_SCOPE', 'github');
    await runOperatorServiceProbeScope(
      'github',
      'authenticated_user',
      ['GITHUB_ACCESS_TOKEN'],
      async () => {
        expect(getSecret('GITHUB_ACCESS_TOKEN', 'github', 'service.resolve')).toBe(tokens.github);
        expect(() => getSecret('GITHUB_CLIENT_SECRET', 'github', 'service.resolve')).toThrow(
          'OPERATOR_SERVICE_PROBE_DENIED'
        );
        expect(() => getSecret('SLACK_ACCESS_TOKEN', 'slack', 'service.resolve')).toThrow(
          'OPERATOR_SERVICE_PROBE_DENIED'
        );
        expect(() => getSecret('GITHUB_ACCESS_TOKEN', 'github', 'other')).toThrow(
          'OPERATOR_SERVICE_PROBE_DENIED'
        );
        expect(() => getSecret('GITHUB_ACCESS_TOKEN')).toThrow('OPERATOR_SERVICE_PROBE_DENIED');
        withPluginExecutionFrame(frame, () => {
          expect(() => getSecret('GITHUB_ACCESS_TOKEN', 'github', 'service.resolve')).toThrow(
            'OPERATOR_SERVICE_PROBE_DENIED'
          );
        });
      }
    );
  });

  it('revokes inherited async authority after success and failure', async () => {
    for (const shouldFail of [false, true]) {
      let delayed!: () => void;
      let observed: boolean | undefined;
      let ready!: () => void;
      const finished = new Promise<void>((resolve) => {
        ready = resolve;
      });
      const blocked = new Promise<void>((resolve) => {
        delayed = resolve;
      });
      const work = runOperatorServiceProbeScope(
        'github',
        'authenticated_user',
        ['GITHUB_ACCESS_TOKEN'],
        async () => {
          void blocked.then(() => {
            observed = operatorProbeSecretAccess(
              'GITHUB_ACCESS_TOKEN',
              'github',
              'service.resolve'
            );
            ready();
          });
          if (shouldFail) throw new Error('synthetic-failure');
        }
      );
      if (shouldFail) await expect(work).rejects.toThrow('synthetic-failure');
      else await work;
      delayed();
      await finished;
      expect(observed).toBe(false);
    }
  });

  it('rejects forged, wrong-action and reused capabilities', async () => {
    await expect(
      executeServicePreset(
        'github',
        'authenticated_user',
        {},
        'secret-guard',
        undefined,
        undefined,
        {}
      )
    ).rejects.toThrow('OPERATOR_SERVICE_PROBE_DENIED');
    await runOperatorServiceProbeScope(
      'github',
      'authenticated_user',
      ['GITHUB_ACCESS_TOKEN'],
      async () => {
        const capability = issueOperatorServiceProbeAdmission({
          serviceId: 'github',
          action: 'authenticated_user',
          binding: { serviceId: 'github', authMode: 'secret-guard', accessToken: tokens.github },
          serviceConfig: getServiceEndpointRecord('github')!,
          preset: { service_id: 'github', operations: {} },
        });
        expect(() =>
          consumeOperatorServiceProbeAdmission(capability, 'github', 'create_issue')
        ).toThrow('OPERATOR_SERVICE_PROBE_DENIED');
        expect(() =>
          consumeOperatorServiceProbeAdmission(capability, 'github', 'authenticated_user')
        ).toThrow('OPERATOR_SERVICE_PROBE_DENIED');
      }
    );
  });
});
