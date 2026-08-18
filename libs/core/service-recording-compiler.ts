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
  /** Draft ADF that can be preflighted and promoted after review. */
  pipeline: {
    action: 'pipeline';
    pipeline_id: string;
    name: string;
    version: '2.0.0';
    description: string;
    _draft: true;
    steps: Array<Record<string, unknown>>;
  };
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
    .map((s) => ({
      kind: 'response_field',
      params: { channel: s.produces, service_id: s.service_id, action: s.action },
    }));
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
  opts: CompileServiceOptions
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
      `${recording.steps.filter(isExternalEffectStep).length} external-effect step(s) require approval before execution.`
    );
  }

  for (const step of recording.steps) {
    if (step.validation_errors?.length) {
      warnings.push(
        `${step.step_id} has plan validation errors: ${step.validation_errors.join('; ')}`
      );
    }
    if (step.secret_refs?.length) {
      warnings.push(
        `${step.step_id} requires human secret binding: ${step.secret_refs.join(', ')}`
      );
    }
  }

  const inputNames = collectServiceInputNames(recording);
  const requiredInputs = inputNames.map((name) => ({ name, label: name, type: 'string' as const }));
  const approvalChannel = `service-recording-${recording.recording_id
    .toLowerCase()
    .replace(/[^a-z0-9-]/gu, '-')}`.slice(0, 64);

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

  const pipelineSteps: Array<Record<string, unknown>> = [];
  for (const step of recording.steps) {
    if (step.risk_class === 'high') {
      pipelineSteps.push({
        id: `${step.step_id}-approval`,
        role: 'gate',
        op: 'core:await_decision',
        params: {
          approval: {
            title: `Service execution: ${recording.target.name}`,
            summary: `Approve ${step.service_id}.${step.action} before external execution.`,
            severity: 'high',
          },
          storage_channel: approvalChannel,
          export_as: `${step.step_id}_approval`,
        },
      });
    }
    pipelineSteps.push({
      id: step.step_id,
      role: step.risk_class === 'read' ? 'source' : 'sink',
      op: 'service:preset',
      ...(step.produces ? { produces: { channel: step.produces, type: 'ServiceResult' } } : {}),
      ...(step.consumes?.length ? { consumes: step.consumes } : {}),
      ...(step.risk_class === 'high' ? { budget: { approval_required: true } } : {}),
      params: {
        service_id: step.service_id,
        action: step.action,
        auth: 'secret-guard',
        params: step.params || {},
      },
    });
  }

  const pipeline = {
    action: 'pipeline' as const,
    pipeline_id: procedureId,
    name: procedureId,
    version: '2.0.0' as const,
    description: `Draft service procedure for ${recording.target.name}.`,
    _draft: true as const,
    steps: pipelineSteps,
  };

  return { procedureEntry, pipeline, goldenScenario, isReadOnly, warnings };
}
