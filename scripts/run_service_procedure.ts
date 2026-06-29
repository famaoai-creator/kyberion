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

import {
  dispatchProcedure,
  safeReadFile,
  validateServiceRecording,
  withExecutionContext,
  loadProcedures,
  resolveAllowlistedRecordingRef,
} from '@agent/core';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (!argv[i].startsWith('--')) continue;
    const key = argv[i].slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) out[key] = 'true';
    else { out[key] = next; i++; }
  }
  return out;
}

function printUsage(): void {
  process.stdout.write(
    '[run-service-procedure] Usage: node dist/scripts/run_service_procedure.js --procedure-id <id> --inputs <json> [--mission-id <id>]\n',
  );
}

function fail(message: string): never {
  process.stderr.write(`[run-service-procedure] ${message}\n`);
  process.exit(1);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  if (args.help === 'true') {
    printUsage();
    process.exit(0);
  }
  const procedureId = args['procedure-id'];
  if (!procedureId) fail('--procedure-id is required');

  const entry = loadProcedures().find((p) => p.procedure_id === procedureId);
  if (!entry) fail(`procedure "${procedureId}" not found in catalog`);
  if (entry!.substrate !== 'service') fail(`procedure "${procedureId}" is not a service procedure (substrate=${entry!.substrate})`);

  const recordingAbs = resolveAllowlistedRecordingRef(entry!.adapter.recording_ref);
  if (!recordingAbs) fail(`procedure "${procedureId}" has no allowlisted recording_ref`);

  let raw: unknown;
  try {
    raw = JSON.parse(safeReadFile(recordingAbs!, { encoding: 'utf8' }) as string);
  } catch (err) {
    return fail(`failed to read recording: ${err instanceof Error ? err.message : String(err)}`);
  }
  const recording = validateServiceRecording(raw);
  if (!recording.value) fail(`service recording invalid: ${recording.errors.join('; ')}`);

  let inputs: Record<string, unknown> = {};
  if (args['inputs']) {
    try {
      const parsed = JSON.parse(args['inputs']);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) inputs = parsed;
      else throw new Error('must be a JSON object');
    } catch (err) {
      return fail(`--inputs ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const missionId = args['mission-id'] || process.env.MISSION_ID || `MSN-PROC-${procedureId}`;
  const result = await withExecutionContext('surface_runtime', () =>
    dispatchProcedure({
      procedure: entry!,
      serviceRecording: recording.value!,
      serviceInputs: inputs,
      agentId: 'run-service-procedure',
      missionId,
      channel: 'service',
    }),
  );

  if (result.status === 'approval_required') {
    process.stdout.write(`[run-service-procedure] approval required (request ${result.approvalRequestId ?? 'n/a'}). Approve in Kyberion and re-run.\n`);
    process.exit(2);
  }
  if (result.status !== 'executed') {
    fail(`${result.status}: ${result.errors.join('; ')}`);
  }
  process.stdout.write(`[run-service-procedure] executed "${procedureId}"\n${JSON.stringify(result.serviceResults, null, 2)}\n`);
}

main().catch((err) => fail(err instanceof Error ? err.message : String(err)));
