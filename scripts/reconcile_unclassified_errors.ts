/**
 * reconcile_unclassified_errors.ts — thin CLI shell (LE-03).
 *
 * The sweep logic lives in @agent/core reconcile-ops (reconcileUnclassifiedErrors)
 * and is exposed in-process as the `system:reconcile_unclassified_errors` op.
 * This shell remains for direct CLI / cron use and prints the same JSON
 * summary to stdout that pipelines used to consume via system:shell.
 */

import { reconcileUnclassifiedErrors } from '@agent/core';

process.stdout.write(JSON.stringify(reconcileUnclassifiedErrors(), null, 2));
