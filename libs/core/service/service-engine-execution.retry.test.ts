import { beforeEach, describe, expect, it, vi } from 'vitest';
import { secureFetch } from '../network.js';
import {
  executeServicePresetAlternative,
  type ServicePresetAlternativeExecutionContext,
} from './service-engine-execution.js';
import { ServiceEffectOutcomeUnknownError } from './service-engine-helpers.js';

const authority = vi.hoisted(() => ({ active: false, allowed: true }));
vi.mock('../governance/human-execution.js', () => ({
  hasHumanExecutionContext: () => false,
  currentHumanExecutionAuthorization: () => undefined,
}));
vi.mock('../network.js', () => ({ secureFetch: vi.fn() }));
vi.mock('../governance/delegated-execution.js', () => ({
  hasDelegatedExecutionContext: () => authority.active,
  currentDelegatedExecution: () =>
    authority.active && authority.allowed ? { target: {} } : undefined,
  delegatedExecutionEffectConfigurationHash: () => 'configuration',
}));

function context(method: string, risk: string): ServicePresetAlternativeExecutionContext {
  return {
    serviceId: 'example',
    action: 'operate',
    alt: {
      type: 'api',
      method,
      path: 'operation',
      retry: { maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1, jitter: false },
    },
    serviceConfig: {},
    preset: { base_url: 'https://example.test', operations: { operate: { risk } } },
    params: {},
    envelope: { templateVars: {}, hasBody: false },
    mergedParams: {},
    effectConfigurationHash: 'configuration',
    binding: { authMode: 'none' },
  } as ServicePresetAlternativeExecutionContext;
}

describe('service transport retry safety', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    authority.active = false;
    authority.allowed = true;
  });

  it('does not repeat an uncertain POST and emits a reconciliation signal without provider text', async () => {
    vi.mocked(secureFetch).mockRejectedValue(
      new Error('network timeout sensitive-provider-detail')
    );
    await expect(executeServicePresetAlternative(context('POST', 'write'))).rejects.toThrow(
      ServiceEffectOutcomeUnknownError
    );
    expect(secureFetch).toHaveBeenCalledTimes(1);
  });

  it('can retry a declared read without changing its request identity', async () => {
    vi.mocked(secureFetch)
      .mockRejectedValueOnce(new Error('network timeout'))
      .mockResolvedValueOnce({ ok: true });
    await expect(executeServicePresetAlternative(context('GET', 'read'))).resolves.toEqual({
      result: { ok: true },
    });
    expect(secureFetch).toHaveBeenCalledTimes(2);
    expect(vi.mocked(secureFetch).mock.calls[0]).toEqual(vi.mocked(secureFetch).mock.calls[1]);
  });

  it('preserves definite pre-dispatch failures for safe alternative selection', async () => {
    const input = context('POST', 'write');
    input.preset.base_url = undefined;
    await expect(executeServicePresetAlternative(input)).rejects.toThrow('No base_url resolved');
    expect(secureFetch).not.toHaveBeenCalled();
  });

  it('rechecks delegated authority before each retry dispatch', async () => {
    authority.active = true;
    vi.mocked(secureFetch).mockImplementationOnce(async () => {
      authority.allowed = false;
      throw new Error('network timeout');
    });
    await expect(executeServicePresetAlternative(context('GET', 'read'))).rejects.toThrow(
      'authority changed'
    );
    expect(secureFetch).toHaveBeenCalledTimes(1);
  });

  it('dispatches an exact loaded service configuration under verified delegated authority', async () => {
    authority.active = true;
    vi.mocked(secureFetch).mockResolvedValueOnce({ assigned: true });
    await expect(executeServicePresetAlternative(context('POST', 'write'))).resolves.toEqual({
      result: { assigned: true },
    });
    expect(secureFetch).toHaveBeenCalledTimes(1);
  });

  it('refuses a stale loaded B configuration even when the current authority/catalog has returned to A', async () => {
    authority.active = true;
    const input = context('POST', 'write');
    // The trusted engine captured B; the active permit currently verifies
    // catalog A again. Rechecking only the latest catalog would miss this ABA.
    input.effectConfigurationHash = 'loaded-configuration-B';
    input.alt.base_url = 'https://stale-account-b.test';
    await expect(executeServicePresetAlternative(input)).rejects.toThrow(
      'Loaded service configuration differs'
    );
    expect(secureFetch).not.toHaveBeenCalled();
  });
});
