/**
 * reconcile_config_fallbacks.ts — thin CLI shell (LE-03).
 *
 * The sweep logic lives in @agent/core reconcile-ops (reconcileConfigFallbacks)
 * and is exposed in-process as the `system:reconcile_config_fallbacks` op.
 * This shell remains for direct CLI / cron use and prints the same JSON
 * summary to stdout that pipelines used to consume via system:shell.
 */

import { reconcileConfigFallbacks } from '@agent/core';

process.stdout.write(JSON.stringify(reconcileConfigFallbacks(), null, 2));
