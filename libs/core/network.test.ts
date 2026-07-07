import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { resetEgressPolicyCache } from './egress-policy.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';

const mocks = vi.hoisted(() => ({
  axios: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('axios', () => ({
  default: mocks.axios,
}));

vi.mock('./core.js', async () => {
  const actual = (await vi.importActual('./core.js')) as any;
  return {
    ...actual,
    logger: {
      ...actual.logger,
      warn: mocks.warn,
    },
  };
});

const tmpRoot = pathResolver.sharedTmp('network-policy-tests');

describe('secureFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    resetEgressPolicyCache();
  });

  afterEach(() => {
    if (safeExistsSync(tmpRoot)) safeRmSync(tmpRoot, { recursive: true, force: true });
    delete process.env.KYBERION_EGRESS_POLICY_PATH;
    resetEgressPolicyCache();
  });

  it('blocks non-allowlisted hosts when egress policy is enforce', async () => {
    safeMkdir(tmpRoot, { recursive: true });
    const policyPath = path.join(tmpRoot, 'egress-policy.json');
    safeWriteFile(
      policyPath,
      JSON.stringify(
        {
          version: '1',
          mode: 'enforce',
          manual_allowed_domains: [],
          blocked_domains: [],
        },
        null,
        2
      ),
      { encoding: 'utf8' }
    );
    process.env.KYBERION_EGRESS_POLICY_PATH = policyPath;

    const { secureFetch } = await import('./network.js');

    await expect(
      secureFetch({
        url: 'https://notgithub.com/api',
        params: { apiKey: 'secret-token' },
        authenticateRequest: true,
      })
    ).rejects.toThrow('Egress host is not allowlisted');

    expect(mocks.axios).not.toHaveBeenCalled();
  });

  it('allows non-allowlisted hosts when egress policy is warn', async () => {
    mocks.axios.mockResolvedValue({ data: { ok: true } });
    const { secureFetch } = await import('./network.js');

    await secureFetch({
      url: 'https://unknown.example.com/test',
      data: { payload: 'ok' },
    });

    expect(mocks.axios).toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalled();
  });

  it('redacts sensitive payload fields and headers before dispatching', async () => {
    mocks.axios.mockResolvedValue({ data: { ok: true } });
    const { secureFetch } = await import('./network.js');

    await secureFetch({
      url: 'https://api.github.com/test',
      data: {
        user: 'alice',
        credentials: {
          apiKey: 'sk-test-1234567890abcdef',
          nested: ['keep', 'also-keep'],
        },
      },
      params: {
        token: 'top-secret-token',
        path: '/Users/alice/project/secrets.txt',
      },
      headers: {
        Authorization: 'Bearer top-secret-token',
        'X-Trace': 'safe-value',
      },
    });

    expect(mocks.axios).toHaveBeenCalledWith(
      expect.objectContaining({
        data: {
          user: 'alice',
          credentials: {
            apiKey: '[REDACTED_SECRET]',
            nested: ['keep', 'also-keep'],
          },
        },
        params: {
          token: '[REDACTED_SECRET]',
          path: '[REDACTED_PATH]/project/secrets.txt',
        },
        // secureFetch injects its own User-Agent — match the redactions
        // without pinning the full header set.
        headers: expect.objectContaining({
          Authorization: '[REDACTED_SECRET]',
          'X-Trace': 'safe-value',
        }),
      })
    );
  });
});
