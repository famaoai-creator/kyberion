import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { runInExecutionScope } from '../foundation/execution-scope.js';
import { withTaskCredentialBinding } from '../foundation/credential-binding.js';
import {
  listReasoningProviderDescriptors,
  getReasoningProviderDescriptor,
  primeReasoningProviderRegistryForTests,
  resetReasoningProviderRegistryForTests,
  explainReasoningProviderDescriptor,
} from './reasoning-provider-registry.js';
import {
  listReasoningApiProviders,
  resolveReasoningApiModel,
  registerReasoningApiProofAdapter,
  verifyReasoningApiCredential,
  reasoningCredentialVersion,
  matchesReasoningCredentialVersion,
} from './reasoning-api-credentials.js';
const mock = vi.hoisted(() => ({
  environment: vi.fn((descriptor: { mode: string }) => ({
    [descriptor.mode === 'openai-api' ? 'OPENAI_API_KEY' : 'unused']: 'test-private-key',
  })),
}));
vi.mock('./reasoning-provider-registry.js', async (original) => ({
  ...(await original<typeof import('./reasoning-provider-registry.js')>()),
  resolveReasoningProviderEnvironment: mock.environment,
}));

beforeEach(() => {
  vi.clearAllMocks();
});
afterEach(() => {
  resetReasoningProviderRegistryForTests();
  vi.unstubAllEnvs();
});
describe('API credential proofs', () => {
  it('uses independently salted, serializable verifiers and rejects changed keys and legacy proofs', () => {
    const first = reasoningCredentialVersion('synthetic-key');
    const second = reasoningCredentialVersion('synthetic-key');
    expect(first).not.toBe(second);
    expect(first).toMatch(/^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{64}$/);
    expect(
      matchesReasoningCredentialVersion('synthetic-key', JSON.parse(JSON.stringify(first)))
    ).toBe(true);
    expect(matchesReasoningCredentialVersion('changed-key', first)).toBe(false);
    for (const malformed of [
      undefined,
      null,
      '',
      'a'.repeat(64),
      first + ':extra',
      first.replace('scrypt-v1', 'scrypt-v2'),
      first.slice(0, -1) + 'Z',
    ])
      expect(matchesReasoningCredentialVersion('synthetic-key', malformed)).toBe(false);
  });
  it.each([
    [401, 'authentication_failed'],
    [403, 'authorization_failed'],
    [404, 'model_or_endpoint_unavailable'],
    [429, 'rate_limited'],
  ] as const)(
    'reports safe HTTP failure code for %s without retaining raw errors',
    async (httpStatus, code) => {
      const result = await verifyReasoningApiCredential(
        { provider: 'openai', model: 'test-model', allowPaid: true },
        async () => {
          throw Object.assign(new Error('test-private-key must not be logged'), { httpStatus });
        }
      );
      expect(result.code).toBe(code);
      expect(JSON.stringify(result)).not.toContain('test-private-key');
      expect(result.credential_version).toMatch(/^scrypt-v1:[a-f0-9]{32}:[a-f0-9]{64}$/);
    }
  );
  it('attributes transport and key version and distinguishes DNS from authentication', async () => {
    const result = await verifyReasoningApiCredential(
      { provider: 'openai', model: 'test-model', allowPaid: true },
      async () => {
        throw new Error('Network Error: ENOTFOUND api.openai.com');
      }
    );
    expect(result).toMatchObject({
      code: 'dns_failed',
      execution: { kind: 'operator' },
      transport: 'custom-request',
      endpoint: 'https://api.openai.com/v1/responses',
    });
  });
  it('uses only tenant-bound credentials and refuses ambient operator credentials without a binding', async () => {
    const response = {
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
      ],
    };
    const request = vi.fn(async () => response);
    const unbound = await runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () =>
      verifyReasoningApiCredential(
        { provider: 'openai', model: 'test-model', allowPaid: true },
        request
      )
    );
    expect(unbound.code).toBe('credential_unavailable');
    expect(request).not.toHaveBeenCalled();
    const bound = await runInExecutionScope({ tenantBound: true, tenantSlug: 'alpha' }, () =>
      withTaskCredentialBinding(
        { tenantSlug: 'alpha', secrets: { OPENAI_API_KEY: 'tenant-bound-key' } },
        () =>
          verifyReasoningApiCredential(
            { provider: 'openai', model: 'test-model', allowPaid: true },
            request
          )
      )
    );
    expect(bound.status).toBe('success');
    expect(request.mock.calls[0]![0]).toMatchObject({
      headers: { authorization: 'Bearer tenant-bound-key' },
    });
  });
  it('lists API descriptors and separates model selection from credentials', () => {
    expect(listReasoningApiProviders().map((entry) => entry.mode)).toEqual(
      expect.arrayContaining([
        'openai-api',
        'nemotron-api',
        'anthropic',
        'gemini-api',
        'openrouter',
      ])
    );
    expect(resolveReasoningApiModel('openai', 'test-model')).toBe('test-model');
    expect(
      resolveReasoningApiModel('openai', undefined, { KYBERION_OPENAI_MODEL: 'configured-model' })
    ).toBe('configured-model');
  });
  it('requires billing consent before reading credentials or making any request', async () => {
    const request = vi.fn();
    expect(
      (await verifyReasoningApiCredential({ provider: 'openai', model: 'test-model' }, request))
        .code
    ).toBe('consent_required');
    expect(mock.environment).not.toHaveBeenCalled();
    expect(request).not.toHaveBeenCalled();
  });
  it('makes one bounded Responses request and records no key or generated content', async () => {
    const request = vi.fn(async () => ({
      status: 'completed',
      output: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'OK' }] },
      ],
    }));
    const result = await verifyReasoningApiCredential(
      { provider: 'openai', model: 'test-model', allowPaid: true },
      request
    );
    expect(result.status).toBe('success');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0]![0]).toMatchObject({
      url: 'https://api.openai.com/v1/responses',
      maxRedirects: 0,
      timeout: 20_000,
      headers: { authorization: 'Bearer test-private-key' },
      data: { store: false, max_output_tokens: 128 },
    });
    expect(JSON.stringify(result)).not.toContain('test-private-key');
    expect(JSON.stringify(result)).not.toContain('OK');
  });
  it('redacts provider failures and never retries', async () => {
    const request = vi.fn(async () => {
      throw new Error('401 test-private-key');
    });
    const result = await verifyReasoningApiCredential(
      { provider: 'openai', model: 'test-model', allowPaid: true },
      request
    );
    expect(result.code).toBe('request_failed');
    expect(JSON.stringify(result)).not.toContain('test-private-key');
    expect(request).toHaveBeenCalledTimes(1);
  });
  it('rejects incomplete Responses results', async () => {
    expect(
      (
        await verifyReasoningApiCredential(
          { provider: 'openai', model: 'test-model', allowPaid: true },
          vi.fn(async () => ({ status: 'incomplete', output: [] }))
        )
      ).code
    ).toBe('unexpected_response');
  });
  it('adds a provider and a protocol through descriptor and trusted adapter registration without changing callers', async () => {
    const base = getReasoningProviderDescriptor('openai-api')!;
    const fixture = {
      ...base,
      mode: 'fixture-api',
      provider: 'fixture-api',
      api_proof: { protocol: 'fixture-protocol', base_url: 'https://api.example.com/v1' },
    };
    primeReasoningProviderRegistryForTests([...listReasoningProviderDescriptors(), fixture]);
    mock.environment.mockReturnValueOnce({ OPENAI_API_KEY: 'test-private-key' });
    const unregister = registerReasoningApiProofAdapter({
      protocol: 'fixture-protocol',
      request: ({ baseURL, maxTokens }) => ({
        url: `${baseURL}/proof`,
        data: { limit: maxTokens },
      }),
      text: () => 'OK',
    });
    try {
      expect(
        (
          await verifyReasoningApiCredential(
            { provider: 'fixture-api', model: 'test-model', allowPaid: true },
            vi.fn(async () => ({}))
          )
        ).status
      ).toBe('success');
    } finally {
      unregister();
    }
  });
  it('rejects unregistered protocols before fetching a credential', async () => {
    const base = getReasoningProviderDescriptor('openai-api')!;
    primeReasoningProviderRegistryForTests([
      { ...base, api_proof: { ...base.api_proof!, protocol: 'not-installed' } },
    ]);
    expect(
      (
        await verifyReasoningApiCredential(
          { provider: 'openai', model: 'test-model', allowPaid: true },
          vi.fn()
        )
      ).code
    ).toBe('unsupported_adapter');
    expect(mock.environment).not.toHaveBeenCalled();
  });
  it.each([
    'https://user:password@example.com/v1',
    'http://example.com/v1',
    'https://127.0.0.1/v1',
    'https://example.com/v1?key=secret',
  ])('rejects unsafe proof endpoints', (base_url) => {
    const base = getReasoningProviderDescriptor('openai-api')!;
    expect(
      explainReasoningProviderDescriptor({
        ...base,
        api_proof: { protocol: 'responses', base_url },
      })
    ).toHaveProperty('reason');
  });
});
