/**
 * reconcile_config_fallbacks.ts — thin CLI shell (LE-03).
 *
 * The sweep logic lives in @agent/core reconcile-ops (reconcileConfigFallbacks)
 * and is exposed in-process as the `system:reconcile_config_fallbacks` op.
 * This shell remains for direct CLI / cron use and prints the same JSON
 * summary to stdout that pipelines used to consume via system:shell.
 */

import { reconcileConfigFallbacks } from '@agent/core/reconcile-ops';
import { defineScript, isDirectScript } from './lib/harness.js';

export const runReconcileConfigFallbacks = defineScript({
  name: 'reconcile:config-fallbacks',
  flags: [],
  run(context) {
    const result = reconcileConfigFallbacks();
    context.print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'reconcile_config_fallbacks.ts') ||
  isDirectScript(import.meta.url, 'reconcile_config_fallbacks.js')
)
  void runReconcileConfigFallbacks();
