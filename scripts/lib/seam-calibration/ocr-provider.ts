/**
 * Seam calibration adapter for 'ocr-provider': run the same image through
 * every eligible OCR backend and compare recognized text quality.
 *
 * Candidate eligibility reuses AdaptivePolicyRouter.eligibleCandidates() —
 * the same mode/availability test the live OCR router uses — instead of
 * re-deriving it here. Each trial calls the chosen provider directly so a
 * failure never silently falls through to a different provider, which would
 * misattribute the measurement.
 */

import {
  AdaptivePolicyRouter,
  ensureBuiltinOcrProviders,
  listOcrProviders,
} from '@agent/core/ocr-bridge';
import type { OcrProvider, OcrRequest, OcrRoutingMode } from '@agent/core/ocr-types';
import type {
  SeamCalibrationAdapter,
  SeamCalibrationTrialContext,
  SeamCalibrationTrialResult,
} from '@agent/core/seam-calibration';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';

export interface OcrCalibrationInput {
  image_path: string;
  /** Ground truth text; when given, each trial reports char_error_rate against it. */
  expected_text?: string;
  language?: string;
  mode?: OcrRoutingMode;
}

/** Shared normalised CER (whitespace / punctuation / width insensitive). */
export { characterErrorRate } from './text-metrics.js';
import { characterErrorRate } from './text-metrics.js';

function providerById(id: string): OcrProvider | undefined {
  ensureBuiltinOcrProviders();
  return listOcrProviders().find((provider) => provider.id === id);
}

function toOcrRequest(input: OcrCalibrationInput, providerPreference?: string[]): OcrRequest {
  return {
    path: input.image_path,
    ...(input.mode ? { mode: input.mode } : {}),
    ...(input.language ? { language: input.language } : {}),
    ...(providerPreference ? { providerPreference } : {}),
  };
}

/** Cloud / off-machine providers only run when the operator lists them explicitly. */
const OPT_IN_PROVIDERS = new Set(['llm_api', 'local_vlm']);

export const ocrProviderCalibrationAdapter: SeamCalibrationAdapter<OcrCalibrationInput> = {
  seam: 'ocr-provider',
  description:
    'Run the same image through every eligible OCR backend and compare recognized text (char_error_rate against expected_text when given).',
  input_example: {
    image_path: 'active/shared/tmp/sample.png',
    expected_text: 'Hello world',
    language: 'eng',
    mode: 'balanced',
  },

  async listCandidates(input: OcrCalibrationInput): Promise<SeamProviderCandidate[]> {
    ensureBuiltinOcrProviders();
    const router = new AdaptivePolicyRouter(listOcrProviders());
    return router.eligibleCandidates(toOcrRequest(input));
  },

  async runTrial(
    providerId: string,
    input: OcrCalibrationInput,
    _context: SeamCalibrationTrialContext
  ): Promise<SeamCalibrationTrialResult> {
    const provider = providerById(providerId);
    if (!provider) return { ok: false, error: `unknown ocr provider '${providerId}'` };

    const result = await provider.recognize(toOcrRequest(input, [providerId]));
    if (result.status !== 'succeeded') {
      return { ok: false, error: result.error || `${providerId}_ocr_failed` };
    }
    const metrics: Record<string, number> = {};
    if (input.expected_text) {
      metrics.char_error_rate = characterErrorRate(result.text, input.expected_text);
    }
    return { ok: true, output: { text: result.text }, metrics };
  },

  trait_mappings: {
    latency: { metric: 'latency_ms', higher_is_better: false },
    accuracy: { metric: 'char_error_rate', higher_is_better: false },
  },

  requiresExplicitOptIn(providerId: string): boolean {
    return OPT_IN_PROVIDERS.has(providerId);
  },
};
