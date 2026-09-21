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

import { AdaptivePolicyRouter, listOcrProviders } from '@agent/core/ocr-bridge';
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

/**
 * Character Error Rate: Levenshtein edit distance between the recognized and
 * expected text, normalised by the expected text's length. 0 = exact match,
 * 1 (capped) = as different as an empty guess. A sibling calibration adapter
 * for speech-to-text implements its own CER the same way — the duplication
 * across seams is intentional (each stays self-contained) rather than
 * sharing a helper across unrelated seams.
 */
export function characterErrorRate(actual: string, expected: string): number {
  const a = actual ?? '';
  const b = expected ?? '';
  if (b.length === 0) return a.length === 0 ? 0 : 1;
  if (a.length === 0) return 1;

  let previous = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i += 1) {
    const current = new Array<number>(b.length + 1);
    current[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      current[j] = Math.min(
        previous[j]! + 1, // deletion
        current[j - 1]! + 1, // insertion
        previous[j - 1]! + cost // substitution
      );
    }
    previous = current;
  }
  return Math.min(1, previous[b.length]! / b.length);
}

function providerById(id: string): OcrProvider | undefined {
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
