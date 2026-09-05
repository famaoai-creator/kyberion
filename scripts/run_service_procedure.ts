/**
 * Run a registered service-substrate procedure (Pattern B execution entry point
 * for `substrate: service`). Service procedures are NOT driven by the Chrome
 * native host — this CLI is their executor.
 *
 * Flow: load procedure (catalog) → load + validate its service recording
 * (allowlisted store) → dispatchProcedure (origin/service guard → approval gate
 * for external effects → executeServicePreset per step, threading
 * produces/consumes) → print results.
 *
 * Usage:
 *   node dist/scripts/run_service_procedure.js \
 *     --procedure-id deal.intake.jira-slack \
 *     --inputs '{"title":"New deal"}' \
 *     [--mission-id MSN-123]
 */

import { dispatchProcedure } from '@agent/core/procedure-dispatcher';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { loadServiceRecordingAtPath } from '@agent/core/service-recording';
import { withExecutionContext } from '@agent/core/authority';
import { loadProcedures, resolveAllowlistedRecordingRef } from '@agent/core/procedure-registry';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { parseSafeJsonObjectInput } from './lib/json-input.js';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = 'true';
    else {
      out[key] = next;
      i++;
    }
  }
  return out;
}

export const main = defineScript({
  name: 'run-service-procedure',
  flags: [],
  async run(context) {
    const args = parseArgs(context.positional);
    if (args.help === 'true') {
      context.print(
        '[run-service-procedure] Usage: node dist/scripts/run_service_procedure.js --procedure-id <id> --inputs <json> [--mission-id <id>]'
      );
      return;
    }
    const procedureId = args['procedure-id'];
    if (!procedureId) throw new ScriptExitError(1, '--procedure-id is required');

    const entry = loadProcedures().find((p) => p.procedure_id === procedureId);
    if (!entry) throw new ScriptExitError(1, `procedure "${procedureId}" not found in catalog`);
    if (entry!.substrate !== 'service')
      throw new ScriptExitError(
        1,
        `procedure "${procedureId}" is not a service procedure (substrate=${entry!.substrate})`
      );

    const recordingAbs = resolveAllowlistedRecordingRef(entry!.adapter.recording_ref);
    if (!recordingAbs)
      throw new ScriptExitError(1, `procedure "${procedureId}" has no allowlisted recording_ref`);

    let recording;
    try {
      recording = loadServiceRecordingAtPath(recordingAbs);
    } catch (err) {
      throw new ScriptExitError(
        1,
        `service recording invalid: ${err instanceof Error ? err.message : String(err)}`
      );
    }

    let inputs: Record<string, unknown> = {};
    if (args['inputs']) {
      try {
        inputs = parseSafeJsonObjectInput(args['inputs'], '--inputs') || {};
      } catch (err) {
        throw new ScriptExitError(
          1,
          `--inputs ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }

    const missionId =
      args['mission-id'] || getRegisteredEnvText('MISSION_ID') || `MSN-PROC-${procedureId}`;
    const result = await withExecutionContext('surface_runtime', () =>
      dispatchProcedure({
        procedure: entry!,
        serviceRecording: recording,
        serviceInputs: inputs,
        agentId: 'run-service-procedure',
        missionId,
        channel: 'service',
      })
    );

    if (result.status === 'approval_required') {
      context.print(
        `[run-service-procedure] approval required (request ${result.approvalRequestId ?? 'n/a'}). Approve in Kyberion and re-run.`
      );
      throw new ScriptExitError(2);
    }
    if (result.status !== 'executed') {
      throw new ScriptExitError(1, `${result.status}: ${result.errors.join('; ')}`);
    }
    context.print(
      `[run-service-procedure] executed "${procedureId}"\n${JSON.stringify(result.serviceResults, null, 2)}`
    );
  },
});

if (
  isDirectScript(import.meta.url, 'run_service_procedure.ts') ||
  isDirectScript(import.meta.url, 'run_service_procedure.js')
) {
  void main();
}
