/**
 * reconcile_unclassified_errors.ts — thin CLI shell (LE-03).
 *
 * The sweep logic lives in @agent/core reconcile-ops (reconcileUnclassifiedErrors)
 * and is exposed in-process as the `system:reconcile_unclassified_errors` op.
 * This shell remains for direct CLI / cron use and prints the same JSON
 * summary to stdout that pipelines used to consume via system:shell.
 */

import { reconcileUnclassifiedErrors } from '@agent/core/reconcile-ops';
import { defineScript, isDirectScript } from './lib/harness.js';

export const main = defineScript({
  name: 'reconcile-unclassified-errors',
  flags: [],
  run(context) {
    context.print(JSON.stringify(reconcileUnclassifiedErrors(), null, 2));
  },
});

if (
  isDirectScript(import.meta.url, 'reconcile_unclassified_errors.ts') ||
  isDirectScript(import.meta.url, 'reconcile_unclassified_errors.js')
)
  void main();
