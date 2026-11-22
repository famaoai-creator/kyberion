/**
 * Browser-control orchestration — the CLI-facing layer over the session
 * store (browser-control-sessions.ts) and the bridge mailbox.
 *
 * Flow:
 *   requestBrowserControlSession  → operator approval request (session lease)
 *   mintSessionIfApproved         → mints BCS-* once granted
 *   enqueueSessionStep            → admit → enqueue control_step (or escalate)
 *   completeStepApproval          → record hash + enqueue after a step grant
 *
 * Every transition lands in the session journal; secrets returned by the page
 * ride the mailbox's secret_capture side-channel, never the record itself.
 */
import {
  createApprovalRequest,
  type ApprovalRequestRecord,
} from '@agent/core/governance/approval-store';
import {
  isApprovalRequestExpired,
  loadApprovalRequest,
} from '@agent/core/governance/approval-store-reader';
import { approvalRequesterActorId } from '@agent/core/governance/approval-requester';
import { resolveCliApprovalRequester } from '@agent/core/governance/cli-operator-principal';
import {
  admitControlStep,
  appendBrowserControlJournal,
  clearPendingControlStep,
  listBrowserControlSessions,
  loadPendingControlStep,
  mintBrowserControlSession,
  recordApprovedControlStep,
  revokeBrowserControlSession,
  savePendingControlStep,
  type BrowserControlSession,
  type PendingControlStep,
} from './browser-control-sessions.js';
import {
  awaitBrowserBridgeResponse,
  canonicalHttpOrigin,
  enqueueBrowserBridgeRequest,
  readBrowserControlSecrets,
  type BrowserBridgeControlStep,
  type BrowserBridgeRequest,
  type BrowserBridgeScope,
} from './browser-bridge-mailbox.js';

export const BROWSER_CONTROL_APPROVAL_CHANNEL = 'browser-control';

export interface BrowserControlActor {
  actor_id: string;
  mission_id?: string;
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/** Ask the operator for a control session bound to one origin. */
export function requestBrowserControlSession(input: {
  origin: string;
  risk_ceiling?: 'observe' | 'low';
  label?: string;
  ttl_ms?: number;
  actor: BrowserControlActor;
}): { approval_request_id: string; origin: string } {
  const origin = canonicalHttpOrigin(input.origin);
  if (!origin) {
    throw new Error(`[BROWSER_CONTROL_INVALID] origin must be a canonical http(s) origin`);
  }
  const requester = resolveCliApprovalRequester({ legacy: input.actor.actor_id });
  const record = createApprovalRequest('mission_controller', {
    channel: BROWSER_CONTROL_APPROVAL_CHANNEL,
    threadTs: `browser-control-${Date.now()}`,
    correlationId: `browser-control:session:${origin}`,
    requestedBy: requester.requestedBy,
    ...(requester.displayName ? { requestedByDisplayName: requester.displayName } : {}),
    kind: 'mission_gate',
    draft: {
      title: `Browser control session: ${origin}`,
      summary:
        `Allow CLI-driven browser control of ${origin} ` +
        `(${input.risk_ceiling ?? 'low'}-risk ceiling, up to 30 minutes). ` +
        `Low-risk steps run under this lease; high-risk steps still ask individually.`,
      details: [
        `Origin: ${origin}`,
        `Risk ceiling: ${input.risk_ceiling ?? 'low'}`,
        ...(input.label ? [`Label: ${input.label}`] : []),
        ...(input.actor.mission_id ? [`Mission: ${input.actor.mission_id}`] : []),
      ].join('\n'),
      severity: 'medium',
    },
    requestedByContext: {
      surface: 'terminal',
      actorId: approvalRequesterActorId(requester),
      actorRole: 'browser-control-cli',
    },
    justification: {
      reason:
        'The CLI asked for an interactive browser-control session; a human grants the lease once.',
      impactSummary: `Drives the operator's Chrome on ${origin} with the schema-bounded step vocabulary.`,
      requestedEffects: [`browser-control:${origin}`],
    },
  });
  return { approval_request_id: record.id, origin };
}

export function approvalStatus(approvalRequestId: string): {
  status: string;
  record?: ApprovalRequestRecord;
} {
  const record = loadApprovalRequest(BROWSER_CONTROL_APPROVAL_CHANNEL, approvalRequestId);
  if (!record) return { status: 'missing' };
  if (record.status === 'pending' && isApprovalRequestExpired(record)) {
    return { status: 'expired', record };
  }
  return { status: record.status, record };
}

/**
 * Mint the session once its approval request is granted. Idempotent: repeated
 * calls after minting return the same session (approval_request_id lookup).
 */
export function mintSessionIfApproved(
  approvalRequestId: string,
  input: {
    origin: string;
    risk_ceiling?: 'observe' | 'low';
    label?: string;
    ttl_ms?: number;
    actor: BrowserControlActor;
  }
): { status: string; session?: BrowserControlSession } {
  const existing = listBrowserControlSessions().find(
    (session) => session.approval_request_id === approvalRequestId
  );
  if (existing) return { status: 'minted', session: existing };
  const { status } = approvalStatus(approvalRequestId);
  if (status !== 'approved') return { status };
  const origin = canonicalHttpOrigin(input.origin);
  if (!origin) {
    throw new Error(`[BROWSER_CONTROL_INVALID] origin must be a canonical http(s) origin`);
  }
  const session = mintBrowserControlSession({
    origin,
    risk_ceiling: input.risk_ceiling,
    requested_by: { actor_id: input.actor.actor_id, mission_id: input.actor.mission_id },
    approval_request_id: approvalRequestId,
    label: input.label,
    ttl_ms: input.ttl_ms,
  });
  appendBrowserControlJournal(session.session_id, {
    event: 'session.minted',
    origin: session.origin,
    risk_ceiling: session.risk_ceiling,
    actor: input.actor.actor_id,
    ...(input.actor.mission_id ? { mission_id: input.actor.mission_id } : {}),
  });
  return { status: 'minted', session };
}

// ---------------------------------------------------------------------------
// Step admission
// ---------------------------------------------------------------------------

export type EnqueueStepResult =
  | { status: 'queued'; request_id: string }
  | { status: 'approval_required'; approval_request_id: string }
  | { status: 'denied'; reason: string };

function journalStep(
  sessionId: string,
  event: string,
  step: BrowserBridgeControlStep,
  extra?: Record<string, unknown>
): void {
  appendBrowserControlJournal(sessionId, {
    event,
    step_id: step.step_id,
    op: step.op,
    ...(step.ref ? { ref: step.ref } : {}),
    ...(step.label ? { label: step.label } : {}),
    // Full step payload so a journal can be exported as a browser-recording.
    // `file.data_b64` (up to ~1MB) is replaced by metadata — the binary lives
    // only in the mailbox request payload it was shipped with. `fill_ref`
    // values are scrubbed too: the executable copy stays in the pending-step
    // file and the exporter only needs the variable placeholder.
    step: {
      ...step,
      ...(step.op === 'fill_ref' && step.value !== undefined
        ? { value: undefined, value_redacted: true }
        : {}),
      ...(step.file
        ? {
            file: {
              name: step.file.name,
              mime: step.file.mime,
              bytes: Math.floor(step.file.data_b64.length * 0.75),
            },
          }
        : {}),
    },
    ...extra,
  });
}

/**
 * Admit one step against the session and enqueue it as a mailbox
 * `control_step` request. High-risk ops short-circuit to a per-step approval
 * request whose payload hash must be granted before enqueue.
 */
export function enqueueSessionStep(input: {
  session_id: string;
  step: BrowserBridgeControlStep;
  actor: BrowserControlActor;
  scope?: BrowserBridgeScope;
  ttl_ms?: number;
}): EnqueueStepResult {
  const { session_id, step } = input;
  const admission = admitControlStep(session_id, step);
  if (admission.ok === false) {
    journalStep(session_id, `step.denied.${admission.reason}`, step, {
      detail: admission.detail,
    });
    if (admission.reason === 'approval_required') {
      const requester = resolveCliApprovalRequester({ legacy: input.actor.actor_id });
      const record = createApprovalRequest('mission_controller', {
        channel: BROWSER_CONTROL_APPROVAL_CHANNEL,
        threadTs: `browser-control-step-${Date.now()}`,
        correlationId: `browser-control:step:${session_id}:${step.step_id}`,
        requestedBy: requester.requestedBy,
        kind: 'mission_gate',
        draft: {
          title: `High-risk browser step: ${step.op}`,
          summary:
            `Session ${session_id} wants to run high-risk op ${step.op}` +
            (step.label ? ` (${step.label})` : '') +
            `. Approve to execute this one step.`,
          details: JSON.stringify(
            {
              session_id,
              step: step.file
                ? {
                    ...step,
                    file: {
                      name: step.file.name,
                      mime: step.file.mime,
                      bytes: Math.floor(step.file.data_b64.length * 0.75),
                    },
                  }
                : step,
            },
            null,
            2
          ),
          severity: 'high',
        },
        requestedByContext: {
          surface: 'terminal',
          actorId: approvalRequesterActorId(requester),
          actorRole: 'browser-control-cli',
        },
        justification: {
          reason:
            'A high-risk browser-control step is outside the session lease; a human approves it once.',
          impactSummary: `Executes ${step.op} under browser-control session ${session_id}.`,
          requestedEffects: [`browser-control-step:${session_id}:${step.step_id}`],
        },
      });
      savePendingControlStep({
        approval_request_id: record.id,
        session_id,
        step,
        created_at: new Date().toISOString(),
      });
      journalStep(session_id, 'step.approval_requested', step, {
        approval_request_id: record.id,
      });
      return { status: 'approval_required', approval_request_id: record.id };
    }
    return { status: 'denied', reason: admission.detail };
  }
  const { session } = admission;
  const request = enqueueBrowserBridgeRequest(
    {
      request_kind: 'control_step',
      payload: {
        session_id: session.session_id,
        lease_id: session.lease_id,
        origin: session.origin,
        step,
      },
      requested_by: {
        actor_id: input.actor.actor_id,
        ...(input.actor.mission_id ? { mission_id: input.actor.mission_id } : {}),
      },
      scope: input.scope ?? { tier: 'personal' },
      ttl_ms: input.ttl_ms,
    },
    {
      assertTenant: (tenantSlug) => {
        // control steps are operator-local; a tenant scope is only a partition
        void tenantSlug;
      },
    }
  );
  journalStep(session_id, 'step.enqueued', step, { request_id: request.request_id });
  return { status: 'queued', request_id: request.request_id };
}

/**
 * Re-admit a step after its per-step approval was granted: records the hash so
 * the session admits it, then enqueues. Returns the same shape as
 * enqueueSessionStep.
 */
export function completeStepApproval(input: {
  session_id: string;
  step: BrowserBridgeControlStep;
  approval_request_id: string;
  actor: BrowserControlActor;
  scope?: BrowserBridgeScope;
  ttl_ms?: number;
}): EnqueueStepResult {
  const { status } = approvalStatus(input.approval_request_id);
  if (status !== 'approved') return { status: 'denied', reason: `approval is ${status}` };
  const session = recordApprovedControlStep(input.session_id, input.step);
  if (!session) return { status: 'denied', reason: `session ${input.session_id} not found` };
  journalStep(input.session_id, 'step.approved', input.step, {
    approval_request_id: input.approval_request_id,
  });
  clearPendingControlStep(input.approval_request_id);
  return enqueueSessionStep(input);
}

/** Load the step a per-step approval was filed for (CLI `resume`). */
export function loadPendingStep(approvalRequestId: string): PendingControlStep | null {
  return loadPendingControlStep(approvalRequestId);
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export async function awaitStepResult(
  sessionId: string,
  requestId: string,
  options: { timeoutMs?: number; pollMs?: number } = {}
): Promise<BrowserBridgeRequest> {
  const record = await awaitBrowserBridgeResponse(requestId, options);
  appendBrowserControlJournal(sessionId, {
    event: `step.${record.status}`,
    request_id: requestId,
    ...(record.response?.error ? { error: record.response.error } : {}),
    ...(record.response?.result?.secret_capture
      ? { secret_capture: record.response.result.secret_capture }
      : {}),
  });
  return record;
}

/** Fetch a step's captured secrets and scrub the side file. */
export function drainStepSecrets(requestId: string): Record<string, string> | null {
  return readBrowserControlSecrets(requestId, { delete: true });
}

export function endBrowserControlSession(sessionId: string): BrowserControlSession | null {
  const session = revokeBrowserControlSession(sessionId);
  if (session) {
    appendBrowserControlJournal(sessionId, { event: 'session.revoked' });
  }
  return session;
}
