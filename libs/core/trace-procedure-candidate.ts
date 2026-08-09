import type { Trace, TraceSpan } from './src/trace.js';
import {
  createDistillCandidateRecord,
  saveDistillCandidateRecord,
  loadDistillCandidateRecord,
  updateDistillCandidateRecord,
  type DistillCandidateRecord,
} from './distill-candidate-registry.js';
import { determineActuatorStepType } from './actuator-op-registry.js';
import { validatePipelineAdf } from './pipeline-contract.js';
import { validatePipelineGuardrails } from './adf-guardrails.js';
import { redactSensitiveString } from './network.js';

export interface TraceProcedureDraft {
  procedure_id: string;
  pipeline: {
    pipeline_id: string;
    version: '0.1.0';
    action: 'pipeline';
    _draft: true;
    steps: Array<{ role: 'sink'; op: string; params: Record<string, unknown> }>;
  };
  preflight: { ok: boolean; findings: string[] };
  candidate: DistillCandidateRecord;
}

function flatten(span: TraceSpan, output: TraceSpan[] = []): TraceSpan[] {
  output.push(span);
  for (const child of span.children || []) flatten(child, output);
  return output;
}

function opForSpan(span: TraceSpan): string {
  const declared = span.attributes?.op;
  if (typeof declared === 'string' && declared.includes(':')) return declared;
  if (span.name.includes(':')) return span.name;
  return 'system:log';
}

const SAFE_TRACE_ATTRIBUTE_KEYS = new Set([
  'duration_ms',
  'http_method',
  'resource_type',
  'status',
  'success',
  'retry_count',
]);

function safeTraceParams(span: TraceSpan, op: string): Record<string, unknown> {
  const params: Record<string, unknown> = { trace_span_id: span.spanId };
  for (const key of SAFE_TRACE_ATTRIBUTE_KEYS) {
    const value = span.attributes?.[key];
    if (typeof value === 'string') params[key] = redactSensitiveString(value).slice(0, 160);
    else if (typeof value === 'number' && Number.isFinite(value)) params[key] = value;
    else if (typeof value === 'boolean') params[key] = value;
  }
  if (op === 'system:log') params.message = 'trace event captured; raw span attributes withheld';
  return params;
}

export function buildProcedureCandidateFromTrace(
  trace: Trace,
  options: { procedureId?: string; title?: string } = {}
): TraceProcedureDraft {
  const procedureId = options.procedureId || `trace.${trace.traceId.slice(0, 12)}`;
  const steps = flatten(trace.rootSpan)
    .slice(1)
    .map((span) => {
      const op = opForSpan(span);
      const separator = op.indexOf(':');
      const domain = separator > 0 ? op.slice(0, separator) : '';
      const action = separator > 0 ? op.slice(separator + 1) : op;
      try {
        determineActuatorStepType(domain, action);
      } catch {
        return {
          role: 'sink' as const,
          op: 'system:log',
          params: safeTraceParams(span, 'system:log'),
        };
      }
      return { role: 'sink' as const, op, params: safeTraceParams(span, op) };
    });
  const pipeline = {
    pipeline_id: procedureId,
    version: '0.1.0' as const,
    action: 'pipeline' as const,
    _draft: true as const,
    steps,
  };
  const preflight = (() => {
    try {
      const validated = validatePipelineAdf(pipeline);
      const guardrails = validatePipelineGuardrails(validated, `trace:${trace.traceId}`);
      return {
        ok: guardrails.ok,
        findings: guardrails.findings.map(
          (finding) => `${finding.severity}:${finding.code}:${finding.message}`
        ),
      };
    } catch (error) {
      return {
        ok: false,
        findings: [error instanceof Error ? error.message : String(error)],
      };
    }
  })();
  const candidate = createDistillCandidateRecord({
    source_type: 'mission',
    tier: 'confidential',
    mission_id: trace.metadata.missionId,
    title: options.title || `Reusable procedure from ${trace.traceId.slice(0, 12)}`,
    summary: `Draft procedure distilled from successful trace ${trace.traceId}; remains non-executable until human approval.`,
    status: 'proposed',
    target_kind: 'procedure',
    evidence_refs: [`trace:${trace.traceId}`],
    metadata: {
      pipeline,
      preflight,
      procedure_id: procedureId,
      provenance_trace_id: trace.traceId,
      review_required: true,
    },
  });
  saveDistillCandidateRecord(candidate);
  return { procedure_id: procedureId, pipeline, preflight, candidate };
}

/** Human review is the only transition that makes a trace candidate promotable. */
export function promoteTraceProcedureCandidate(
  candidateId: string,
  review: { status: 'approved' | 'rejected'; reviewer: string; note?: string }
): DistillCandidateRecord | null {
  if (review.status !== 'approved')
    return updateDistillCandidateRecord(candidateId, { status: 'archived', metadata: { review } });
  const current = loadDistillCandidateRecord(candidateId);
  const preflight = current?.metadata?.preflight;
  if (
    !current ||
    current.status !== 'proposed' ||
    current.target_kind !== 'procedure' ||
    !preflight ||
    typeof preflight !== 'object' ||
    (preflight as { ok?: unknown }).ok !== true
  )
    return null;
  return updateDistillCandidateRecord(candidateId, {
    status: 'promoted',
    promoted_ref: `procedure-candidate:${candidateId}`,
    metadata: {
      review,
      executable: false,
      promotion_ready: true,
      next_gate: 'procedure_catalog_promotion',
    },
  });
}
