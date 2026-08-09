import { describe, expect, it } from 'vitest';
import {
  buildProcedureCandidateFromTrace,
  promoteTraceProcedureCandidate,
} from './trace-procedure-candidate.js';
import { TraceContext } from './src/trace.js';

describe('trace procedure candidates', () => {
  it('creates a draft ADF candidate with trace provenance and no executable status', () => {
    const trace = new TraceContext('mission', { missionId: 'MSN-DR' });
    trace.startSpan('system:log', { op: 'system:log', message: 'done' });
    trace.endSpan();
    const draft = buildProcedureCandidateFromTrace(trace.finalize());
    expect(draft.candidate.target_kind).toBe('procedure');
    expect(draft.candidate.status).toBe('proposed');
    expect(draft.pipeline._draft).toBe(true);
    expect(draft.preflight.ok).toBe(true);
    expect(draft.candidate.metadata?.provenance_trace_id).toBe(trace.traceId);
    expect(draft.pipeline.steps[0].op).toBe('system:log');
    const promoted = promoteTraceProcedureCandidate(draft.candidate.candidate_id, {
      status: 'approved',
      reviewer: 'operator',
    });
    expect(promoted?.status).toBe('promoted');
    expect(promoted?.metadata).toMatchObject({
      executable: false,
      promotion_ready: true,
      next_gate: 'procedure_catalog_promotion',
    });
  });
});
