import {
  BACKEND_LIVE_TURN_TIMEOUT_MS,
  formatBackendLiveScenarioTable,
  recordBackendLiveScenarioRun,
  runBackendLiveScenarios,
  type BackendLiveScenarioRecord,
} from '@agent/core/backend-live-scenarios';
import { withExecutionContext } from '@agent/core/authority';
import { parseGuardedCliArgs } from '@agent/core/cli-guard';
import { logger } from '@agent/core/core';
import {
  getLastServedReasoningMode,
  resetReasoningFailoverTracking,
} from '@agent/core/reasoning/reasoning-backend';
import { buildTaskReasoningBackend } from '@agent/core/reasoning/reasoning-bootstrap';
import { listCliReasoningProviderDescriptors } from '@agent/core/reasoning/reasoning-provider-registry';
import type { ReasoningBackendMode } from '@agent/core/reasoning/reasoning-backend-policy';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

/**
 * MSN-HARNESS-ADOPT R1: opt-in live backend conformance scenarios.
 *
 * Without `--live` this only prints the plan (which backends and models it
 * would drive) and the cost warning — it never spends a model turn. With
 * `--live --mode <m[,m2]>` it drives each named backend through the
 * first / follow_up / reset_continue / abort / artifact scenarios, prints a
 * Markdown table and writes one JSON record per backend under
 * active/shared/runtime/backend-live-scenarios/, where
 * `check:backend-capability-honesty` reads it.
 */
const SPEC = {
  command: 'pnpm kyberion check backend-live-scenarios',
  manifestId: 'script.check.backend-live-scenarios',
  options: [
    { flag: '--live' },
    { flag: '--mode', value: '<mode[,mode]>' },
    { flag: '--model', value: '<model-id>' },
  ],
} as const;

const COST_WARNING =
  'WARNING: live scenarios spend real model turns (about 8 prompts and 2 delegations per backend) and may incur provider cost.';

export const runCheckBackendLiveScenarios = defineScript({
  name: 'check:backend-live-scenarios',
  flags: ['json', 'quiet'],
  async run(context) {
    const parsed = parseGuardedCliArgs(context.positional, SPEC, context.print);
    if (parsed.handled) return undefined;
    const live = parsed.options['--live'] === true;
    const model = typeof parsed.options['--model'] === 'string' ? parsed.options['--model'] : '';
    const requestedModes =
      typeof parsed.options['--mode'] === 'string'
        ? parsed.options['--mode']
            .split(',')
            .map((mode) => mode.trim())
            .filter(Boolean)
        : [];
    const cliModes = listCliReasoningProviderDescriptors().map((descriptor) => descriptor.mode);
    const modes = requestedModes.length > 0 ? requestedModes : cliModes;

    context.print(
      [
        'backend live scenarios — plan',
        ...modes.map((mode) => `  ${mode}  model=${model || 'provider default'}`),
        COST_WARNING,
      ].join('\n')
    );
    if (!live) {
      context.print('Dry plan only: pass --live --mode <mode> to run it.');
      return { live: false, modes };
    }
    if (requestedModes.length === 0) {
      throw new ScriptExitError(
        2,
        '--live requires an explicit --mode list, so no backend is driven by accident.'
      );
    }

    const records: BackendLiveScenarioRecord[] = [];
    const written: string[] = [];
    for (const mode of requestedModes) {
      let backend;
      try {
        // The scenarios bound every call themselves. The route's request
        // wrapper would answer an abort for the provider (rejecting the moment
        // the signal fires) and cap each turn at the route's 60s limit, so the
        // run would measure the wrapper instead of the provider.
        backend = buildTaskReasoningBackend({
          mode: mode as ReasoningBackendMode,
          ...(model ? { model } : {}),
          requestTimeout: 'caller',
          timeoutMs: BACKEND_LIVE_TURN_TIMEOUT_MS,
        });
      } catch (error) {
        logger.warn(
          `[check:backend-live-scenarios] ${mode} skipped — backend could not be built: ${error instanceof Error ? error.message : String(error)} | next: run pnpm kyberion auth check for this mode | evidence: no record written`
        );
        continue;
      }
      resetReasoningFailoverTracking();
      const record = await runBackendLiveScenarios(backend, {
        mode,
        turnTimeoutMs: BACKEND_LIVE_TURN_TIMEOUT_MS,
        // A CLI backend's abort passes only once its child process is seen
        // to exit; an API backend has no child, so its abort error suffices.
        requireChildExit: (cliModes as readonly string[]).includes(mode),
        ...(model ? { model } : {}),
        servedMode: () => getLastServedReasoningMode()?.mode,
      });
      records.push(record);
      written.push(
        withExecutionContext('ecosystem_architect', () => recordBackendLiveScenarioRun(record))
      );
    }

    context.print(formatBackendLiveScenarioTable(records));
    if (written.length > 0) context.print(`records: ${written.join(', ')}`);
    return { live: true, records, written };
  },
});

if (
  isDirectScript(import.meta.url, 'check_backend_live_scenarios.ts') ||
  isDirectScript(import.meta.url, 'check_backend_live_scenarios.js')
)
  void runCheckBackendLiveScenarios();
