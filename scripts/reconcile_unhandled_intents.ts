/**
 * reconcile_unhandled_intents.ts — thin CLI shell (LE-03).
 *
 * The sweep logic lives in @agent/core reconcile-ops (reconcileUnhandledIntents)
 * and is exposed in-process as the `system:reconcile_unhandled_intents` op.
 * This shell remains for direct CLI / cron use and prints the same JSON
 * summary to stdout that pipelines used to consume via system:shell.
 */

import { reconcileUnhandledIntents } from '@agent/core/reconcile-ops';
import { defineScript, isDirectScript } from './lib/harness.js';

export const runReconcileUnhandledIntents = defineScript({
  name: 'reconcile:unhandled-intents',
  flags: [],
  run(context) {
    const result = reconcileUnhandledIntents();
    context.print(result);
    return result;
  },
});

if (
  isDirectScript(import.meta.url, 'reconcile_unhandled_intents.ts') ||
  isDirectScript(import.meta.url, 'reconcile_unhandled_intents.js')
)
  void runReconcileUnhandledIntents();
