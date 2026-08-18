#!/usr/bin/env node
import {
  compileServiceRecording,
  buildServiceProcedureCandidate,
  promoteServiceProcedure,
  resolveAllowlistedRecordingRef,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
  serviceRecordingContentHash,
  startServiceRecordingSession,
  type ServiceRecording,
  validatePipelineAdf,
  validatePipelineGuardrails,
  validateServiceRecording,
  withExecutionContext,
} from '@agent/core';
import { pathResolver } from '@agent/core';

type JsonObject = Record<string, unknown>;

function argMap(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value?.startsWith('--')) continue;
    const key = value.slice(2);
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) out[key] = 'true';
    else {
      out[key] = next;
      index += 1;
    }
  }
  return out;
}

function readJsonArgument(value: string, label: string): unknown {
  const candidate = value.startsWith('@') ? value.slice(1) : value;
  const absolute = pathResolver.rootResolve(candidate);
  const source =
    value.startsWith('@') || safeExistsSync(absolute)
      ? String(safeReadFile(absolute, { encoding: 'utf8' }))
      : value;
  try {
    return JSON.parse(source);
  } catch (error) {
    throw new Error(
      `--${label} must be JSON or @path: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value as JsonObject;
}

function requireCalls(value: unknown): Array<JsonObject> {
  if (!Array.isArray(value) || value.length === 0)
    throw new Error('--calls must contain a non-empty JSON array');
  return value.map((call, index) => requireObject(call, `calls[${index}]`));
}

function printUsage(): void {
  console.log(`Usage:
  service_recording capture --target-name <name> --calls <json|@path> [--recording-id <id>]
  service_recording compile --recording <path> --procedure-id <id> --intent-phrases <json> [--output <path>] [--dry-run]
  service_recording candidate --recording <path> --procedure-id <id> --intent-phrases <json> [--mission-id <id>] [--tenant-slug <slug>] [--tier <personal|confidential>] [--title <text>]
  service_recording review --recording <path> --approve|--reject [--reviewer <id>] [--note <text>]
  service_recording promote --recording <path> --procedure-id <id> --intent-phrases <json>`);
}

function loadRecording(ref: string) {
  const absolute = resolveAllowlistedRecordingRef(ref);
  if (!absolute) throw new Error('recording path is outside the allowlisted recording stores');
  const validation = validateServiceRecording(
    JSON.parse(String(safeReadFile(absolute, { encoding: 'utf8' })))
  );
  if (!validation.value) throw new Error(`recording invalid: ${validation.errors.join('; ')}`);
  return { absolute, value: validation.value };
}

function compile(args: Record<string, string>): void {
  if (!args.recording || !args['procedure-id'] || !args['intent-phrases']) {
    throw new Error('compile requires --recording, --procedure-id, and --intent-phrases');
  }
  const loaded = loadRecording(args.recording);
  const intentPhrases = readJsonArgument(args['intent-phrases'], 'intent-phrases');
  if (!Array.isArray(intentPhrases) || intentPhrases.some((phrase) => typeof phrase !== 'string')) {
    throw new Error('--intent-phrases must be a JSON array of strings');
  }
  const compiled = compileServiceRecording(loaded.value, {
    procedureId: args['procedure-id'],
    intentPhrases,
    recordingRef: pathResolver.toRepoRelative(loaded.absolute),
  });
  const pipeline = validatePipelineAdf(compiled.pipeline);
  const guardrails = validatePipelineGuardrails(pipeline, `service:${args['procedure-id']}`);
  const output = args.output
    ? pathResolver.rootResolve(args.output)
    : pathResolver.shared(`tmp/service-drafts/${args['procedure-id']}.json`);
  if (args['dry-run'] !== 'true') {
    withExecutionContext('surface_runtime', () => {
      safeWriteFile(output, `${JSON.stringify(pipeline, null, 2)}\n`);
    });
  }
  console.log(
    JSON.stringify(
      {
        status: args['dry-run'] === 'true' ? 'dry-run' : 'draft-written',
        recording_ref: pathResolver.toRepoRelative(loaded.absolute),
        pipeline_ref: pathResolver.toRepoRelative(output),
        preflight: { ok: guardrails.ok, findings: guardrails.findings },
        procedure: compiled.procedureEntry,
        golden_scenario: compiled.goldenScenario,
        warnings: compiled.warnings,
        pipeline,
      },
      null,
      2
    )
  );
  if (!guardrails.ok) process.exitCode = 2;
}

function capture(args: Record<string, string>): void {
  if (!args['target-name'] || !args.calls)
    throw new Error('capture requires --target-name and --calls');
  const calls = requireCalls(readJsonArgument(args.calls, 'calls'));
  const session = startServiceRecordingSession({
    target_name: args['target-name'],
    recording_id: args['recording-id'],
  });
  for (const call of calls)
    session.recordCall({
      service_id: String(call.service_id || ''),
      action: String(call.action || ''),
      params: requireObject(call.params || {}, 'call.params'),
      ...(call.result !== undefined ? { result: call.result } : {}),
      ...(typeof call.summary === 'string' ? { summary: call.summary } : {}),
      ...(typeof call.produces === 'string' ? { produces: call.produces } : {}),
      ...(Array.isArray(call.consumes) ? { consumes: call.consumes.map(String) } : {}),
    });
  const recordingRef = withExecutionContext('surface_runtime', () => session.persist());
  console.log(
    JSON.stringify(
      { status: 'recorded', recording_ref: recordingRef, recording: session.toRecording() },
      null,
      2
    )
  );
}

function candidate(args: Record<string, string>): void {
  if (!args.recording || !args['procedure-id'] || !args['intent-phrases']) {
    throw new Error('candidate requires --recording, --procedure-id, and --intent-phrases');
  }
  const loaded = loadRecording(args.recording);
  const intentPhrases = readJsonArgument(args['intent-phrases'], 'intent-phrases');
  if (!Array.isArray(intentPhrases) || intentPhrases.some((phrase) => typeof phrase !== 'string')) {
    throw new Error('--intent-phrases must be a JSON array of strings');
  }
  const result = withExecutionContext('surface_runtime', () =>
    buildServiceProcedureCandidate(loaded.value, {
      procedureId: args['procedure-id'],
      intentPhrases,
      recordingRef: pathResolver.toRepoRelative(loaded.absolute),
      ...(args.title ? { title: args.title } : {}),
      ...(args['mission-id'] ? { missionId: args['mission-id'] } : {}),
      ...(args['task-session-id'] ? { taskSessionId: args['task-session-id'] } : {}),
      ...(args['tenant-slug'] ? { tenantSlug: args['tenant-slug'] } : {}),
      ...(args['project-id'] ? { projectId: args['project-id'] } : {}),
      ...(args['owner-nhi'] ? { ownerNhi: args['owner-nhi'] } : {}),
      ...(args.tier ? { tier: args.tier as 'personal' | 'confidential' } : {}),
    })
  );
  console.log(
    JSON.stringify(
      {
        status: 'candidate-created',
        candidate_id: result.candidate.candidate_id,
        procedure_id: result.procedure_id,
        preflight: result.preflight,
        candidate: result.candidate,
      },
      null,
      2
    )
  );
  if (!result.preflight.ok) process.exitCode = 2;
}

function review(args: Record<string, string>): void {
  if (!args.recording || (args.approve !== 'true' && args.reject !== 'true')) {
    throw new Error('review requires --recording and exactly one of --approve/--reject');
  }
  const loaded = loadRecording(args.recording);
  const status: 'approved' | 'rejected' = args.approve === 'true' ? 'approved' : 'rejected';
  const updated: ServiceRecording = {
    ...loaded.value,
    review: {
      status,
      reviewer: args.reviewer || 'human:operator',
      reviewed_at: new Date().toISOString(),
      decisions: loaded.value.steps.map((step) => ({ step_id: step.step_id, status })),
      ...(args.note ? { note: args.note } : {}),
    },
  };
  if (status === 'approved') {
    updated.review.content_hash = serviceRecordingContentHash(updated);
  }
  withExecutionContext('surface_runtime', () =>
    safeWriteFile(loaded.absolute, `${JSON.stringify(updated, null, 2)}\n`)
  );
  console.log(
    JSON.stringify({ status, recording_ref: pathResolver.toRepoRelative(loaded.absolute) }, null, 2)
  );
}

function promote(args: Record<string, string>): void {
  if (!args.recording || !args['procedure-id'] || !args['intent-phrases']) {
    throw new Error('promote requires --recording, --procedure-id, and --intent-phrases');
  }
  const intentPhrases = readJsonArgument(args['intent-phrases'], 'intent-phrases');
  if (!Array.isArray(intentPhrases) || intentPhrases.some((phrase) => typeof phrase !== 'string')) {
    throw new Error('--intent-phrases must be a JSON array of strings');
  }
  const result = withExecutionContext('ecosystem_architect', () =>
    promoteServiceProcedure({
      recordingRef: args.recording,
      procedureId: args['procedure-id'],
      intentPhrases,
    })
  );
  console.log(
    JSON.stringify(
      {
        status: 'promoted',
        ...result,
        pipelinePath: pathResolver.toRepoRelative(result.pipelinePath),
      },
      null,
      2
    )
  );
}

async function main(): Promise<void> {
  const command = process.argv[2] === '--' ? process.argv[3] : process.argv[2];
  const offset = process.argv[2] === '--' ? 4 : 3;
  if (!command || command === 'help') return printUsage();
  const args = argMap(process.argv.slice(offset));
  if (command === 'capture') return capture(args);
  if (command === 'compile') return compile(args);
  if (command === 'candidate') return candidate(args);
  if (command === 'review') return review(args);
  if (command === 'promote') return promote(args);
  throw new Error(`unknown command: ${command}`);
}

main().catch((error) => {
  console.error(`[service-recording] ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
