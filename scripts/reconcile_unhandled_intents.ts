/**
 * reconcile_unhandled_intents.ts — thin CLI shell (LE-03).
 *
 * The sweep logic lives in @agent/core reconcile-ops (reconcileUnhandledIntents)
 * and is exposed in-process as the `system:reconcile_unhandled_intents` op.
 * This shell remains for direct CLI / cron use and prints the same JSON
 * summary to stdout that pipelines used to consume via system:shell.
 */

import { reconcileUnhandledIntents } from '@agent/core';

process.stdout.write(JSON.stringify(reconcileUnhandledIntents(), null, 2));
