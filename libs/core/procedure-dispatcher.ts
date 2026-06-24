import { logger } from './core.js';
import { enforceApprovalGate } from './approval-gate.js';
import { matchesAllowedOrigin } from './origin-policy.js';
import {
  type BrowserExtensionLease,
  type BrowserExtensionRecording,
  type BrowserExtensionSessionRequest,
  type SegmentedLease,
  enforceBrowserExtensionApproval,
  issueBrowserExtensionLease,
  issueSegmentedLeases,
  preflightBrowserExtensionSession,
  segmentRecording,
  subRecordingForSegment,
} from './browser-extension-bridge.js';
import { isExternalEffectStep, type ServiceRecording } from './service-recording.js';
import {
  executeServiceProcedure,
  type ServicePresetRunner,
  type ServiceStepResult,
} from './service-procedure-executor.js';
import { type ProcedureEntry } from './procedure-types.js';

/** Approval-gate operation id for external-effect service actions. */
export const SERVICE_EXTERNAL_EFFECT_OP = 'service:external_effect';

// re-export for consumers that need it alongside dispatch
export { extendLeaseForMfa } from './browser-extension-bridge.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * Outcome of a dispatch attempt.
 *
 * - `lease_issued`       — browser substrate: lease ready for the extension to use.
 * - `approval_required`  — a human approval request is pending; retry after approval.
 * - `blocked`            — hard error; the procedure cannot execute.
 * - `not_implemented`    — substrate executor not yet wired up (service/desktop/media).
 */
export type DispatchStatus =
  | 'lease_issued'
  | 'executed'
  | 'approval_required'
  | 'blocked'
  | 'not_implemented';

export interface DispatchInput {
  /** The procedure to execute (from the catalog). */
  procedure: ProcedureEntry;
  /** Agent identity for the approval gate audit trail. */
  agentId: string;
  /** Owning mission. */
  missionId: string;
  pipelineId?: string;
  /**
   * Required for `extension_session` executor.
   * Must have `review.status === 'approved'` for lease issuance.
   */
  recording?: BrowserExtensionRecording;
  /**
   * Required for `extension_session` executor.
   * Must have `recording_id` and `origin` matching the recording.
   */
  session?: BrowserExtensionSessionRequest;
  /** Required for the `service:preset` executor (review must be approved). */
  serviceRecording?: ServiceRecording;
  /** User inputs for `{{input.NAME}}` placeholders (service execution). */
  serviceInputs?: Record<string, unknown>;
  /** Injected preset runner for service execution (tests). Defaults to the real engine. */
  executePreset?: ServicePresetRunner;
  /** Surface channel forwarded to the approval gate (e.g. "browser-extension"). */
  channel?: string;
  correlationId?: string;
}

export interface DispatchResult {
  status: DispatchStatus;
  /** `extension_session` single-origin: the lease the extension uses to authorize execution. */
  lease?: BrowserExtensionLease;
  /**
   * `extension_session` multi-origin (segmented): one origin-bound lease per
   * segment. Present instead of `lease` when the procedure spans >1 origin.
   */
  segments?: SegmentedLease[];
  /** `service:preset`: per-step execution results (status === 'executed'). */
  serviceResults?: ServiceStepResult[];
  /** Set when `status === 'approval_required'`. */
  approvalRequestId?: string;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Main entry point
// ---------------------------------------------------------------------------

/**
 * Route a procedure execution request to the correct substrate executor.
 *
 * Currently implemented: `extension_session` (browser substrate).
 * Stubs: `service:preset`, `system` (desktop), `media:pipeline`.
 *
 * Agent-C (Dispatcher) in the intent-driven automation design.
 * Design: docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md §7 Layer③
 */
export async function dispatchProcedure(input: DispatchInput): Promise<DispatchResult> {
  const executor = input.procedure.adapter.executor;
  switch (executor) {
    case 'extension_session':
      return dispatchExtensionSession(input);
    case 'service:preset':
      return dispatchServiceSession(input);
    case 'system':
    case 'media:pipeline':
      // Contracts + routing exist; executors are deferred (desktop has no OS
      // automation backend; media recipe→pipeline mapping is a separate phase).
      logger.info(`[procedure-dispatcher] executor "${executor}" is not yet implemented`);
      return {
        status: 'not_implemented',
        errors: [`Executor "${executor}" is not yet implemented (planned substrate adapter)`],
      };
    default:
      return {
        status: 'blocked',
        errors: [`Unknown executor: "${executor}"`],
      };
  }
}

// ---------------------------------------------------------------------------
// Browser / extension_session executor
// ---------------------------------------------------------------------------

function dispatchExtensionSession(input: DispatchInput): DispatchResult {
  const { procedure, recording, session, agentId, channel, correlationId } = input;

  if (!recording) {
    return {
      status: 'blocked',
      errors: ['extension_session executor requires a recording'],
    };
  }
  if (!session) {
    return {
      status: 'blocked',
      errors: ['extension_session executor requires a session'],
    };
  }

  // Origin guard: every origin the recording touches (each segment) must be in
  // the procedure's approved allowed-origins set.
  const segments = segmentRecording(recording);
  if (procedure.target.origins && procedure.target.origins.length > 0) {
    for (const segment of segments) {
      const allowed = procedure.target.origins.some((o) => matchesAllowedOrigin(o, segment.origin));
      if (!allowed) {
        return {
          status: 'blocked',
          errors: [
            `Segment origin "${segment.origin}" is not in allowed origins for ` +
              `procedure "${procedure.procedure_id}": [${procedure.target.origins.join(', ')}]`,
          ],
        };
      }
    }
  }

  // Enforce the approval gate (synchronous — reads the approval store). A single
  // approval covers all high-risk steps across every segment. The correlation key
  // is procedure-scoped and stable, independent of the synthetic mission_id, so
  // the same approval is found regardless of entry point (review finding AR-M4).
  const approval = enforceBrowserExtensionApproval({
    recording,
    session,
    agentId,
    channel: channel ?? 'browser-extension',
    correlationId: correlationId ?? `procedure:${procedure.procedure_id}:${recording.recording_id}`,
  });

  if (!approval.allowed) {
    logger.info(
      `[procedure-dispatcher] approval required for "${procedure.procedure_id}" ` +
        `— request_id=${approval.requestId ?? 'n/a'}`,
    );
    return {
      status: 'approval_required',
      approvalRequestId: approval.requestId,
      errors: [],
    };
  }

  // --- Multi-origin (segmented): one origin-bound lease per segment ---------
  if (segments.length > 1) {
    const issued = issueSegmentedLeases({ recording, session, approval });
    if (issued.errors.length > 0 || !issued.leases) {
      return { status: 'blocked', errors: issued.errors.length > 0 ? issued.errors : ['segmented lease issuance failed'] };
    }
    // Authoritative per-segment execute-mode preflight: each segment's
    // sub-recording validated against its own origin-bound lease (origin /
    // recording_id / expiry / step-hash coverage). Any blocked segment fails all.
    for (const seg of issued.leases) {
      const sub = subRecordingForSegment(recording, segments[seg.segment_index]);
      const verified = preflightBrowserExtensionSession({
        recording: sub,
        session: { ...session, origin: seg.origin, lease: seg.lease },
        bridgeAvailable: true,
      });
      if (verified.status === 'blocked') {
        return { status: 'blocked', errors: [`segment ${seg.segment_index} (${seg.origin}): ${verified.errors.join('; ')}`] };
      }
    }
    logger.info(
      `[procedure-dispatcher] ${issued.leases.length} segment leases issued for "${procedure.procedure_id}" ` +
        `origins=[${issued.leases.map((s) => s.origin).join(', ')}]`,
    );
    return { status: 'lease_issued', segments: issued.leases, errors: [] };
  }

  // --- Single-origin --------------------------------------------------------
  const issued = issueBrowserExtensionLease({ recording, session, approval });
  if (issued.errors.length > 0 || !issued.lease) {
    return {
      status: 'blocked',
      errors: issued.errors.length > 0 ? issued.errors : ['lease issuance failed unexpectedly'],
    };
  }

  logger.info(
    `[procedure-dispatcher] lease issued for "${procedure.procedure_id}" ` +
      `origin="${recording.tab.origin}" lease="${issued.lease.lease_id}"`,
  );
  return { status: 'lease_issued', lease: issued.lease, errors: [] };
}

// ---------------------------------------------------------------------------
// Service / service:preset executor (Agent-S3)
// Design: docs/INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md §7-C
// ---------------------------------------------------------------------------

async function dispatchServiceSession(input: DispatchInput): Promise<DispatchResult> {
  const { procedure, serviceRecording, agentId, channel, correlationId } = input;

  if (!serviceRecording) {
    return { status: 'blocked', errors: ['service:preset executor requires a serviceRecording'] };
  }
  if (serviceRecording.review?.status !== 'approved') {
    return { status: 'blocked', errors: ['service execution requires an approved recording review'] };
  }

  // Service guard: every step's service_id must be in the procedure's allowed set.
  const allowedServices = procedure.target.services ?? [];
  if (allowedServices.length > 0) {
    for (const step of serviceRecording.steps) {
      if (!allowedServices.includes(step.service_id)) {
        return {
          status: 'blocked',
          errors: [`step ${step.step_id} uses service "${step.service_id}" not in allowed services [${allowedServices.join(', ')}]`],
        };
      }
    }
  }

  // External-effect (high-risk) steps must pass the approval gate — read-only
  // compositions run ungated. A single approval covers all external effects.
  const externalEffectSteps = serviceRecording.steps.filter(isExternalEffectStep);
  if (externalEffectSteps.length > 0) {
    const approval = enforceApprovalGate({
      intentId: SERVICE_EXTERNAL_EFFECT_OP,
      operationId: SERVICE_EXTERNAL_EFFECT_OP,
      agentId,
      correlationId: correlationId ?? `procedure:${procedure.procedure_id}:${serviceRecording.recording_id}`,
      channel: channel ?? 'service',
      payload: {
        services: allowedServices,
        operations: externalEffectSteps.map((s) => `${s.service_id}.${s.action}`),
      },
      draft: {
        title: `Service 実行: ${procedure.target.name}`,
        summary: `${externalEffectSteps.length} 件の external-effect（${externalEffectSteps.map((s) => `${s.service_id}.${s.action}`).join(', ')}）`,
        severity: 'high',
      },
    });
    if (!approval.allowed) {
      logger.info(`[procedure-dispatcher] service approval required for "${procedure.procedure_id}" — request_id=${approval.requestId ?? 'n/a'}`);
      return { status: 'approval_required', approvalRequestId: approval.requestId, errors: [] };
    }
  }

  const exec = await executeServiceProcedure({
    recording: serviceRecording,
    inputs: input.serviceInputs,
    externalEffectApproved: true,
    executePreset: input.executePreset,
  });

  if (exec.status === 'completed') {
    logger.info(`[procedure-dispatcher] service procedure "${procedure.procedure_id}" executed (${exec.results.length} steps)`);
    return { status: 'executed', serviceResults: exec.results, errors: [] };
  }
  const failed = exec.results.find((r) => r.status === 'error' || r.status === 'blocked');
  return {
    status: 'blocked',
    serviceResults: exec.results,
    errors: [failed ? `step ${failed.step_id} ${failed.status}: ${failed.detail ?? ''}` : `service execution ${exec.status}`],
  };
}
