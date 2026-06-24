import {
  collectServiceInputNames,
  isExternalEffectStep,
  type ServiceRecording,
} from './service-recording.js';
import {
  type GoldenScenario,
  type GoldenSuccessCondition,
  type ProcedureEntry,
  type ProcedureRiskClass,
} from './procedure-types.js';

export interface CompileServiceOptions {
  procedureId?: string;
  /** Natural-language intent phrases (≥1). */
  intentPhrases: string[];
  /** Human-readable name; defaults to the recording's target name. */
  targetName?: string;
  /** Repo-relative path to the reviewed recording (stored on adapter.recording_ref). */
  recordingRef?: string;
  status?: ProcedureEntry['status'];
}

export interface CompileServiceResult {
  procedureEntry: ProcedureEntry;
  goldenScenario: GoldenScenario;
  /** True iff every step is read-only (safe to dry-run). */
  isReadOnly: boolean;
  warnings: string[];
}

function deriveProcedureId(recording: ServiceRecording): string {
  const services = recording.target.services.join('-').replace(/[^a-z0-9-]/gi, '_');
  return `service.${services}.${recording.recording_id}`.toLowerCase();
}

/** Success conditions: each step that produces a channel asserts that field exists. */
function extractSuccessConditions(recording: ServiceRecording): GoldenSuccessCondition[] {
  const conditions: GoldenSuccessCondition[] = recording.steps
    .filter((s) => s.produces)
    .map((s) => ({ kind: 'response_field', params: { channel: s.produces, service_id: s.service_id, action: s.action } }));
  if (conditions.length === 0) {
    conditions.push({ kind: 'response_field', params: { anchor: 'last_service_result' } });
  }
  return conditions;
}

/**
 * Compile a validated `service-recording.v1` into a draft `ProcedureEntry`
 * (substrate: service) + paired GoldenScenario. ref→selector resolution is not
 * needed (service actions are structured), so this is far simpler than browser.
 *
 * Agent-S2 (Compiler). Design: docs/INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md §7-③
 */
export function compileServiceRecording(
  recording: ServiceRecording,
  opts: CompileServiceOptions,
): CompileServiceResult {
  if (opts.intentPhrases.length === 0) {
    throw new Error('[service-recording-compiler] intentPhrases must be non-empty');
  }
  const warnings: string[] = [];
  const procedureId = opts.procedureId ?? deriveProcedureId(recording);
  const hasExternalEffect = recording.steps.some(isExternalEffectStep);
  const isReadOnly = recording.steps.every((s) => s.risk_class === 'read');
  const riskClass: ProcedureRiskClass = hasExternalEffect ? 'high' : isReadOnly ? 'low' : 'medium';

  if (hasExternalEffect) {
    warnings.push(
      `${recording.steps.filter(isExternalEffectStep).length} external-effect step(s) require approval before execution.`,
    );
  }

  const inputNames = collectServiceInputNames(recording);
  const requiredInputs = inputNames.map((name) => ({ name, label: name, type: 'string' as const }));

  const procedureEntry: ProcedureEntry = {
    procedure_id: procedureId,
    substrate: 'service',
    adapter: {
      recorder: 'service-capture',
      executor: 'service:preset',
      ...(opts.recordingRef ? { recording_ref: opts.recordingRef } : {}),
    },
    target: {
      name: opts.targetName ?? recording.target.name,
      services: [...recording.target.services],
    },
    intent_phrases: opts.intentPhrases,
    pipeline_ref: `pipelines/service/${procedureId}.json`,
    ...(requiredInputs.length > 0 ? { required_inputs: requiredInputs } : {}),
    risk_class: riskClass,
    version: '1.0.0',
    status: opts.status ?? 'active',
  };

  const goldenScenario: GoldenScenario = {
    schema_version: 'golden-scenario.v1',
    scenario_id: `gs-${procedureId}`,
    procedure_id: procedureId,
    success_conditions: extractSuccessConditions(recording),
    captured_from: recording.recording_id,
    version: '1.0.0',
  };

  return { procedureEntry, goldenScenario, isReadOnly, warnings };
}
