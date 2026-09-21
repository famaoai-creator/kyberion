/**
 * Seam calibration adapter for 'browser-automation-runtime': run the same
 * pipeline steps through every registered browser runtime (Chromium,
 * Lightpanda, ...) and compare success + latency.
 *
 * Candidate eligibility reuses the same capability preflight the live
 * selector runs (browser-actuator's preflightBrowserRuntimePipeline) instead
 * of re-deriving it. Each trial loads the browser-actuator the same way the
 * host executor does (scripts/browser_playwright_executor.ts) and forces the
 * candidate runtime via `browser_runtime`, with a fresh, unique session id
 * and `keep_alive: false` so trials never share or leak browser sessions.
 */

import {
  getBrowserAutomationRuntimeCapabilities,
  listBrowserAutomationRuntimeBridges,
} from '@agent/core/browser-automation-runtime-bridge';
import type {
  SeamCalibrationAdapter,
  SeamCalibrationTrialContext,
  SeamCalibrationTrialResult,
} from '@agent/core/seam-calibration';
import type { SeamProviderCandidate } from '@agent/core/seam-provider-selection';
import { preflightBrowserRuntimePipeline } from '../../../libs/actuators/browser-actuator/src/browser-runtime-capabilities.js';
import {
  loadBrowserActuator,
  type BrowserActuatorHandle,
} from '../../browser_playwright_executor.js';

export interface BrowserAutomationRuntimeCalibrationInput {
  steps: unknown[];
  options?: Record<string, unknown>;
}

let cachedActuator: Promise<BrowserActuatorHandle> | null = null;

/** Loaded once per process and reused across listCandidates()/runTrial() calls. */
function getBrowserActuator(): Promise<BrowserActuatorHandle> {
  if (!cachedActuator) cachedActuator = loadBrowserActuator();
  return cachedActuator;
}

/** Test-only seam: force a fresh actuator load on the next call. */
export function resetBrowserAutomationRuntimeCalibrationActuatorForTest(): void {
  cachedActuator = null;
}

function uniqueSessionId(providerId: string): string {
  return `seam-calibration--${providerId}--${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

function isSuccessfulStatus(status: unknown): boolean {
  return status === 'succeeded' || status === 'success';
}

export const browserAutomationRuntimeCalibrationAdapter: SeamCalibrationAdapter<BrowserAutomationRuntimeCalibrationInput> =
  {
    seam: 'browser-automation-runtime',
    description:
      'Run the same pipeline steps through every registered browser runtime and compare success + latency.',
    input_example: {
      steps: [
        { type: 'capture', op: 'goto', params: { url: 'https://example.com/' } },
        { type: 'capture', op: 'distill_dom', params: {} },
      ],
    },

    async listCandidates(
      input: BrowserAutomationRuntimeCalibrationInput
    ): Promise<SeamProviderCandidate[]> {
      // Loading the actuator registers every browser-automation-runtime
      // bridge (browser-runtime-helpers.ts) as a side effect.
      await getBrowserActuator();
      const options = input.options ?? {};
      return listBrowserAutomationRuntimeBridges().map((bridge) => {
        const { blocking } = preflightBrowserRuntimePipeline(
          input.steps,
          options,
          getBrowserAutomationRuntimeCapabilities(bridge)
        );
        return {
          id: bridge.bridge_id,
          eligible: blocking.length === 0,
          unmet: blocking.map((issue) => `${issue.op ?? issue.option} (${issue.capability})`),
        };
      });
    },

    async runTrial(
      providerId: string,
      input: BrowserAutomationRuntimeCalibrationInput,
      _context: SeamCalibrationTrialContext
    ): Promise<SeamCalibrationTrialResult> {
      const { handleAction } = await getBrowserActuator();
      try {
        const result = await handleAction({
          action: 'pipeline',
          steps: input.steps,
          session_id: uniqueSessionId(providerId),
          options: {
            ...(input.options ?? {}),
            browser_runtime: providerId,
            keep_alive: false,
          },
        });
        const ok = isSuccessfulStatus((result as { status?: unknown }).status);
        const errors = (result as { errors?: string[] }).errors;
        return {
          ok,
          ...(ok ? {} : { error: errors?.join('; ') || `${providerId}_pipeline_failed` }),
          metrics: { success: ok ? 1 : 0 },
        };
      } catch (error: unknown) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
    },

    trait_mappings: {
      speed: { metric: 'latency_ms', higher_is_better: false },
    },
  };
