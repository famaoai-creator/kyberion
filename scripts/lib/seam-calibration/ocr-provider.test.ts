import { describe, expect, it, vi } from 'vitest';
import type { OcrProvider } from '@agent/core/ocr-types';
import { characterErrorRate, ocrProviderCalibrationAdapter } from './ocr-provider.js';

describe('characterErrorRate', () => {
  it('is 0 for an exact match', () => {
    expect(characterErrorRate('hello world', 'hello world')).toBe(0);
  });

  it('is 1 when the guess is empty but expected text is not', () => {
    expect(characterErrorRate('', 'hello')).toBe(1);
  });

  it('is 0 when both are empty', () => {
    expect(characterErrorRate('', '')).toBe(0);
  });

  it('counts a single substitution as 1/length', () => {
    expect(characterErrorRate('hollo', 'hello')).toBeCloseTo(1 / 5);
  });

  it('counts insertions and deletions', () => {
    // 'helloo' -> 'hello' needs one deletion; expected length 5.
    expect(characterErrorRate('helloo', 'hello')).toBeCloseTo(1 / 5);
    // 'hell' -> 'hello' needs one insertion; expected length 5.
    expect(characterErrorRate('hell', 'hello')).toBeCloseTo(1 / 5);
  });

  it('caps at 1 for a completely different, longer guess', () => {
    expect(characterErrorRate('xxxxxxxxxx', 'hi')).toBe(1);
  });
});

function makeProvider(id: string, overrides: Partial<OcrProvider> = {}): OcrProvider {
  return {
    id,
    dataEgress: 'none',
    isAvailable: vi.fn().mockResolvedValue(true),
    recognize: vi.fn(),
    ...overrides,
  } as OcrProvider;
}

describe('ocr-provider calibration adapter', () => {
  it('opts cloud/off-machine providers in only explicitly', () => {
    expect(ocrProviderCalibrationAdapter.requiresExplicitOptIn?.('llm_api')).toBe(true);
    expect(ocrProviderCalibrationAdapter.requiresExplicitOptIn?.('local_vlm')).toBe(true);
    expect(ocrProviderCalibrationAdapter.requiresExplicitOptIn?.('apple_vision')).toBe(false);
    expect(ocrProviderCalibrationAdapter.requiresExplicitOptIn?.('tesseract')).toBe(false);
  });

  it('declares latency and accuracy trait mappings', () => {
    expect(ocrProviderCalibrationAdapter.trait_mappings).toEqual({
      latency: { metric: 'latency_ms', higher_is_better: false },
      accuracy: { metric: 'char_error_rate', higher_is_better: false },
    });
  });

  it('reports a failed trial for an unknown provider id without touching listOcrProviders', async () => {
    const result = await ocrProviderCalibrationAdapter.runTrial(
      'not-a-real-provider',
      { image_path: 'active/shared/tmp/does-not-matter.png' },
      { outDir: 'active/shared/tmp/ocr-calibration-test', repeat: 0 }
    );
    expect(result).toEqual({
      ok: false,
      error: "unknown ocr provider 'not-a-real-provider'",
    });
  });
});
