import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeRmSync } from './secure-io.js';
import { setSeamSelectionRule } from './seam-selection-rules.js';

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

const rulesDir = pathResolver.sharedTmp('ocr-provider-selection-test');
const rulesFile = path.join(rulesDir, 'rules.json');

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
    vi.stubEnv('KYBERION_SEAM_SELECTION_RULES_PATH', rulesFile);
    safeRmSync(rulesDir, { recursive: true, force: true });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    safeRmSync(rulesDir, { recursive: true, force: true });
  });

  it('leaves the default chain untouched when no purpose is given', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none'),
      makeProvider('llm_api', 'external'),
    ]);

    const candidates = await router.resolveCandidates({
      path: 'test.png',
      training_use: 'training_eligible',
    });

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
      training_use: 'training_eligible',
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

    const byPrivacy = await router.resolveCandidates({
      path: 'test.png',
      purpose: 'privacy',
      training_use: 'training_eligible',
    });
    expect(byPrivacy.map((p) => p.id)).toEqual(['apple_vision', 'llm_api']);

    const byAccuracy = await router.resolveCandidates({
      path: 'test.png',
      purpose: 'accuracy',
      training_use: 'training_eligible',
    });
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
      training_use: 'training_eligible',
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

    const candidates = await router.resolveCandidates({
      path: 'test.png',
      purpose: 'accuracy',
      training_use: 'training_eligible',
    });

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

  it('applies an operator rule even without a purpose, using decisionKey "default"', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none'),
      makeProvider('llm_api', 'external'),
    ]);

    const before = await router.resolveCandidates({
      path: 'test.png',
      training_use: 'training_eligible',
    });
    expect(before.map((p) => p.id)).toEqual(['apple_vision', 'llm_api']);
    expect(record).not.toHaveBeenCalled();

    setSeamSelectionRule({
      rule_id: 'always-llm',
      seam: 'ocr-provider',
      when: {},
      prefer: ['llm_api'],
      set_by: 'user:owner',
    });
    // Rule changes are audited too; assertions below are about selection.
    record.mockClear();

    const after = await router.resolveCandidates({
      path: 'test.png',
      training_use: 'training_eligible',
    });
    expect(after[0]!.id).toBe('llm_api');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'ocr-provider/llm_api',
        metadata: expect.objectContaining({ decision_key: 'default', rule_id: 'always-llm' }),
      })
    );
  });

  it('does not apply an operator rule when an explicit providerPreference is given', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none'),
      makeProvider('llm_api', 'external'),
    ]);

    setSeamSelectionRule({
      rule_id: 'always-llm-2',
      seam: 'ocr-provider',
      when: {},
      prefer: ['llm_api'],
      set_by: 'user:owner',
    });
    // Rule changes are audited too; assertions below are about selection.
    record.mockClear();

    const candidates = await router.resolveCandidates({
      path: 'test.png',
      training_use: 'training_eligible',
      providerPreference: ['apple_vision'],
    });
    expect(candidates[0]!.id).toBe('apple_vision');
    expect(record).not.toHaveBeenCalled();
  });

  it('passes the request language as selection context so a rule can match on it', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none'),
      makeProvider('llm_api', 'external'),
    ]);

    setSeamSelectionRule({
      rule_id: 'ja-accuracy',
      seam: 'ocr-provider',
      when: { purpose: 'accuracy', context: { language: 'ja' } },
      prefer: ['llm_api'],
      set_by: 'user:owner',
    });
    // Rule changes are audited too; assertions below are about selection.
    record.mockClear();

    const jaCandidates = await router.resolveCandidates({
      path: 'test.png',
      training_use: 'training_eligible',
      purpose: 'accuracy',
      language: 'ja',
    });
    expect(jaCandidates[0]!.id).toBe('llm_api');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({ context: { language: 'ja' }, rule_id: 'ja-accuracy' }),
      })
    );

    record.mockClear();
    const enCandidates = await router.resolveCandidates({
      path: 'test.png',
      purpose: 'accuracy',
      language: 'en',
      training_use: 'training_eligible',
    });
    expect(enCandidates[0]!.id).toBe('llm_api');
    expect(record).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.not.objectContaining({ rule_id: expect.anything() }),
      })
    );
  });

  it('keeps the legacy per-mode chain when rules exist but none matches the request', async () => {
    const router = new AdaptivePolicyRouter([
      makeProvider('apple_vision', 'none'),
      makeProvider('llm_api', 'external'),
    ]);
    setSeamSelectionRule({
      rule_id: 'ja-only',
      seam: 'ocr-provider',
      when: { context: { language: 'ja' } },
      prefer: ['llm_api'],
      set_by: 'user:owner',
    });
    // Rule changes are audited too; assertions below are about selection.
    record.mockClear();

    const en = await router.resolveCandidates({
      path: 'test.png',
      language: 'en',
      training_use: 'training_eligible',
    });
    expect(en.map((p) => p.id)).toEqual(['apple_vision', 'llm_api']);
    expect(record).not.toHaveBeenCalled();

    const ja = await router.resolveCandidates({
      path: 'test.png',
      language: 'ja',
      training_use: 'training_eligible',
    });
    expect(ja[0]!.id).toBe('llm_api');
  });
});
