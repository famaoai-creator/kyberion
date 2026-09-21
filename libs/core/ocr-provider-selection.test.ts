import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mirrors libs/actuators/browser-actuator/src/browser-runtime-selection.test.ts:
// exercise the real seam-provider-selection engine and the real ocr-provider
// policy file, mocking only the audit chain so tests stay hermetic. MISSION_ID
// is kept unset so no pin file is ever written.
const record = vi.fn();
vi.mock('./audit-chain.js', () => ({
  auditChain: { record: (...args: unknown[]) => record(...args) },
}));

const { AdaptivePolicyRouter } = await import('./ocr-bridge.js');
import type { OcrProvider, OcrDataEgress } from './ocr-types.js';

function makeProvider(id: string, dataEgress: OcrDataEgress, available = true): OcrProvider {
  return {
    id,
    dataEgress,
    isAvailable: vi.fn().mockResolvedValue(available),
    recognize: vi.fn(),
  };
}

describe('purpose-driven OCR provider selection', () => {
  beforeEach(() => {
    record.mockClear();
    vi.stubEnv('MISSION_ID', '');
  });
  afterEach(() => vi.unstubAllEnvs());

  it('leaves the default chain untouched when no purpose is given', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none'),
      makeProvider('llm_api', 'external'),
    ]);

    const candidates = await router.resolveCandidates({ path: 'test.png' });

    expect(candidates.map((p) => p.id)).toEqual(['apple_vision', 'llm_api']);
    expect(record).not.toHaveBeenCalled();
  });

  it('lets an explicit providerPreference win over a purpose', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none'),
      makeProvider('llm_api', 'external'),
    ]);

    const candidates = await router.resolveCandidates({
      path: 'test.png',
      purpose: 'accuracy',
      providerPreference: ['llm_api'],
    });

    expect(candidates[0]!.id).toBe('llm_api');
    expect(record).not.toHaveBeenCalled();
  });

  it('ranks eligible providers by the purpose and orders the chain accordingly', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none'),
      makeProvider('llm_api', 'external'),
    ]);

    const byPrivacy = await router.resolveCandidates({ path: 'test.png', purpose: 'privacy' });
    expect(byPrivacy.map((p) => p.id)).toEqual(['apple_vision', 'llm_api']);

    const byAccuracy = await router.resolveCandidates({ path: 'test.png', purpose: 'accuracy' });
    expect(byAccuracy.map((p) => p.id)).toEqual(['llm_api', 'apple_vision']);

    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'ocr-provider/apple_vision' })
    );
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({ operation: 'ocr-provider/llm_api' })
    );
  });

  it('excludes a provider the mode forbids, even for a purpose that would otherwise prefer it', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none'),
      makeProvider('llm_api', 'external'),
    ]);

    const candidates = await router.resolveCandidates({
      path: 'test.png',
      mode: 'local_only',
      purpose: 'accuracy',
    });

    expect(candidates.map((p) => p.id)).toEqual(['apple_vision']);
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          excluded: [
            {
              id: 'llm_api',
              unmet: [`dataEgress 'external' not permitted by mode 'local_only'`],
            },
          ],
        }),
      })
    );
  });

  it('excludes a provider that is not currently available', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none', false),
      makeProvider('llm_api', 'external'),
    ]);

    const candidates = await router.resolveCandidates({ path: 'test.png', purpose: 'accuracy' });

    expect(candidates.map((p) => p.id)).toEqual(['llm_api']);
  });

  it('throws a clear error for an unknown purpose, naming the known purposes', async () => {
    const router = new AdaptivePolicyRouter([makeProvider('apple_vision', 'none')]);

    await expect(
      router.resolveCandidates({ path: 'test.png', purpose: 'cheapest' })
    ).rejects.toThrow(
      /\[OCR_PROVIDER_SELECTION\].*unknown purpose 'cheapest'.*known: accuracy, cost, privacy, speed/
    );
  });

  it('throws when no provider is eligible to serve a known purpose', async () => {
    const router = new AdaptivePolicyRouter([makeProvider('llm_api', 'external')]);

    await expect(
      router.resolveCandidates({ path: 'test.png', mode: 'local_only', purpose: 'accuracy' })
    ).rejects.toThrow(/\[OCR_PROVIDER_SELECTION\].*no provider can run this task/);
  });
});
