#!/usr/bin/env node
import { compileServiceRecording } from '@agent/core/service-recording-compiler';
import { buildServiceProcedureCandidate } from '@agent/core/service-distill-candidate';
import { promoteServiceProcedure } from '@agent/core/service-procedure-promotion';
import { resolveAllowlistedRecordingRef } from '@agent/core/procedure-registry';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
} from '@agent/core/secure-io';
import {
  serviceRecordingContentHash,
  type ServiceRecording,
  validateServiceRecording,
} from '@agent/core/service-recording';
import { validatePipelineAdf } from '@agent/core/pipeline-contract';
import { validatePipelineGuardrails } from '@agent/core/adf-guardrails';
import { startServiceRecordingSession } from '@agent/core/service-recording-session';
import { withExecutionContext } from '@agent/core/authority';
import { nowIso, parseSafeJsonInput, readJson } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import {
  defineScript,
  isDirectScript,
  ScriptExitError,
  stripSharedScriptFlags,
} from './lib/harness.js';

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

function resolveServicePath(value: unknown, label: string, allowMissingLeaf = false): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`${label} is required`);
  return assertSafeRepositoryPath(pathResolver.resolve(requested), { allowMissingLeaf });
}

function readJsonArgument(value: string, label: string): unknown {
  const candidate = value.startsWith('@') ? value.slice(1) : value;
  const resolved = pathResolver.resolve(candidate);
  const source = value.startsWith('@')
    ? String(safeReadFile(resolveServicePath(candidate, `--${label} path`), { encoding: 'utf8' }))
    : safeExistsSync(resolved)
      ? String(safeReadFile(resolveServicePath(candidate, `--${label} path`), { encoding: 'utf8' }))
      : value;
  try {
    return parseSafeJsonInput(source, `service recording ${label} input`);
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

function printUsage(): string {
  return `Usage:
  service_recording capture --target-name <name> --calls <json|@path> [--recording-id <id>]
  service_recording compile --recording <path> --procedure-id <id> --intent-phrases <json> [--output <path>] [--dry-run]
  service_recording candidate --recording <path> --procedure-id <id> --intent-phrases <json> [--mission-id <id>] [--tenant-slug <slug>] [--tier <personal|confidential>] [--title <text>]
  service_recording review --recording <path> --approve|--reject [--reviewer <id>] [--note <text>]
  service_recording promote --recording <path> --procedure-id <id> --intent-phrases <json>`;
}

type CommandResult = { value: unknown; exitCode?: number };

function loadRecording(ref: string) {
  const absolute = resolveAllowlistedRecordingRef(ref);
  if (!absolute) throw new Error('recording path is outside the allowlisted recording stores');
  const validation = validateServiceRecording(readJson(absolute));
  if (!validation.value) throw new Error(`recording invalid: ${validation.errors.join('; ')}`);
  return { absolute, value: validation.value };
}

function compile(args: Record<string, string>): CommandResult {
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
    ? resolveServicePath(args.output, 'output path', true)
    : pathResolver.shared(`tmp/service-drafts/${args['procedure-id']}.json`);
  if (args['dry-run'] !== 'true') {
    withExecutionContext('surface_runtime', () => {
      safeWriteFile(output, `${JSON.stringify(pipeline, null, 2)}\n`);
    });
  }
  return {
    value: {
      status: args['dry-run'] === 'true' ? 'dry-run' : 'draft-written',
      recording_ref: pathResolver.toRepoRelative(loaded.absolute),
      pipeline_ref: pathResolver.toRepoRelative(output),
      preflight: { ok: guardrails.ok, findings: guardrails.findings },
      procedure: compiled.procedureEntry,
      golden_scenario: compiled.goldenScenario,
      warnings: compiled.warnings,
      pipeline,
    },
    ...(guardrails.ok ? {} : { exitCode: 2 }),
  };
}

function capture(args: Record<string, string>): CommandResult {
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
  return {
    value: { status: 'recorded', recording_ref: recordingRef, recording: session.toRecording() },
  };
}

function candidate(args: Record<string, string>): CommandResult {
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
  return {
    value: {
      status: 'candidate-created',
      candidate_id: result.candidate.candidate_id,
      procedure_id: result.procedure_id,
      preflight: result.preflight,
      candidate: result.candidate,
    },
    ...(result.preflight.ok ? {} : { exitCode: 2 }),
  };
}

function review(args: Record<string, string>): CommandResult {
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
      reviewed_at: nowIso(),
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
  return { value: { status, recording_ref: pathResolver.toRepoRelative(loaded.absolute) } };
}

function promote(args: Record<string, string>): CommandResult {
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
  return {
    value: {
      status: 'promoted',
      ...result,
      pipelinePath: pathResolver.toRepoRelative(result.pipelinePath),
    },
  };
}

export async function main(
  argv: string[] = [],
  options: { dryRun?: boolean; check?: boolean } = {}
): Promise<CommandResult> {
  const normalizedArgs = stripSharedScriptFlags(argv);
  const command = normalizedArgs[0];
  if (!command || command === 'help') return { value: printUsage() };
  const args = argMap(normalizedArgs.slice(1));
  if (options.dryRun || options.check || argv.includes('--dry-run')) args['dry-run'] = 'true';
  if (command === 'capture') return capture(args);
  if (command === 'compile') return compile(args);
  if (command === 'candidate') return candidate(args);
  if (command === 'review') return review(args);
  if (command === 'promote') return promote(args);
  throw new Error(`unknown command: ${command}`);
}

export const runServiceRecording = defineScript({
  name: 'service:recording',
  flags: ['json', 'dry-run', 'check', 'quiet'],
  run: async ({ argv, dryRun, check, print }) => {
    const result = await main(argv, { dryRun, check });
    print(result.value);
    if (result.exitCode !== undefined) throw new ScriptExitError(result.exitCode, '', true);
    return result.value;
  },
});

if (
  isDirectScript(import.meta.url, 'service_recording.ts') ||
  isDirectScript(import.meta.url, 'service_recording.js')
)
  void runServiceRecording();
