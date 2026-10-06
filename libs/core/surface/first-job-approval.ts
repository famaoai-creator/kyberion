import { normalizeLocale } from '../locale-normalize.js';
/** The only first-job decision writer: raw verified browser session, exact current effect. */
import { createHmac } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { withLockSync } from '../lock-utils.js';
import { assertBuiltinOnlyWorkerEventStream } from '../workforce/worker-event-stream.js';
import { browserSessionKey, verifyBrowserSessionToken } from '../authn-providers.js';
import { resolveAuthnSurfaceViewerScope } from './surface-authn.js';
import { resolveOidcLoginConfig } from './oidc-browser-login.js';
import { resolveMemberByPrincipal } from '../organization/member-registry.js';
import { findDotCharter } from '../dot/dot-charter.js';
import { currentDotActions, dotProposalHash } from '../dot/dot-dispatch.js';
import {
  computeApprovalPayloadHash,
  decideApprovalRequest,
  loadApprovalRequest,
  isApprovalRequestExpired,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import {
  conversationRef,
  listConfiguredFrontDeskExecutions,
  inspectFrontDeskExecution,
} from './front-desk-conversation-store.js';
import {
  frontDeskExecutionViewerMatches,
  type FrontDeskExecutionBinding,
} from './front-desk-execution-contract.js';
import { frontDeskBindingsEqual, frontDeskExecutionProposal } from './front-desk-execution.js';
import { resolveFirstJobViewer } from './first-job.js';
import type { SurfaceViewerScope } from './surface-mutation-guard.js';
import {
  parseFirstJobApprovalDecisionRequest,
  type FirstJobReadRequest,
  type FirstJobApprovalDecisionRequest,
} from './first-job-contract.js';
import {
  firstJobApprovalEffect,
  firstJobApprovalDisplayDigest,
  firstJobProofMessage,
  hasVerifiedFirstJobDecision,
  type FirstJobDecisionProof,
} from './first-job-approval-proof.js';

const LOGIN_HREF = '/login?next=%2Ffirst-job';
function requireDiagnosticEventBoundary(): void {
  try {
    assertBuiltinOnlyWorkerEventStream();
  } catch {
    reject(409, 'event_subscribers_unavailable');
  }
}
export class FirstJobApprovalError extends Error {
  constructor(
    public readonly status: 400 | 401 | 403 | 409 | 503,
    message: string
  ) {
    super(message);
  }
}
function reject(status: 400 | 401 | 403 | 409 | 503, code: string): never {
  throw new FirstJobApprovalError(status, 'first_job_' + code);
}
/** No injectable identity, auth boolean, provider selection, key, or member registry. */
function authenticate(token: string) {
  try {
    const { principal } = resolveAuthnSurfaceViewerScope({
      token,
      local: false,
      allowLoopback: false,
      registrations: null,
      configuredCredentials: [],
      providerIds: ['browser-session'],
      surface: 'presence-studio-first-job',
    });
    const session = verifyBrowserSessionToken(token);
    if (
      principal.provider !== 'browser-session' ||
      principal.actor.kind !== 'human' ||
      !principal.memberId ||
      principal.actor.id !== 'user:' + principal.memberId ||
      !session ||
      !/^[a-f0-9]{24}$/.test(session.sid)
    )
      reject(401, 'authentication_required');
    return { principal, session };
  } catch {
    return reject(401, 'authentication_required');
  }
}
function ownerViewer(
  authenticated: SurfaceViewerScope,
  memberId: string,
  input: FirstJobReadRequest
) {
  const resolution = resolveFirstJobViewer(authenticated);
  if (!resolution.ready) reject(409, 'diagnostic_unavailable');
  const viewer = resolution.viewer;
  if (input.session_id && input.session_id !== conversationRef(viewer).sessionId)
    reject(409, 'scope_changed');
  let owner: ReturnType<typeof resolveMemberByPrincipal>;
  try {
    owner = withExecutionContext('sovereign_concierge', () =>
      resolveMemberByPrincipal({
        principalId: viewer.principalId,
        memberId: viewer.memberId,
        source: 'loopback',
      })
    );
  } catch {
    return reject(403, 'access_denied');
  }
  const tenant = viewer.tenantSlugs[0];
  if (
    !owner ||
    owner.status !== 'active' ||
    owner.member_id !== memberId ||
    !owner.memberships.some(
      (entry) => entry.tenant_slug === tenant && ['owner', 'approver'].includes(entry.role)
    )
  )
    reject(403, 'access_denied');
  return viewer;
}
function inspect(
  viewer: SurfaceViewerScope,
  binding: FrontDeskExecutionBinding,
  approvalId: string,
  sessionExpiry: number
) {
  const entries = listConfiguredFrontDeskExecutions((mapping) =>
    frontDeskExecutionViewerMatches(viewer, mapping)
  );
  const entry = entries.find((candidate) => frontDeskBindingsEqual(binding, candidate.binding));
  if (!entry || entry.request.status !== 'pending') reject(409, 'request_changed');
  const charter = findDotCharter(entry.mapping.dotId)?.charter;
  if (!charter) reject(409, 'diagnostic_unavailable');
  const admission = inspectFrontDeskExecution(binding, charter);
  if (!admission.ok) reject(409, 'request_changed');
  const effect = firstJobApprovalEffect(charter, binding);
  const expected = frontDeskExecutionProposal(binding);
  const actions = currentDotActions(charter.dot_id).filter(
    (action) => action.request_id === approvalId
  );
  const action = actions[0];
  if (
    actions.length !== 1 ||
    !action ||
    action.status !== 'parked' ||
    action.decision !== 'approve' ||
    action.dot_id !== charter.dot_id ||
    action.actor_id !== 'dot:' + charter.dot_id ||
    action.action_id !== expected.action_id ||
    action.work_shape !== expected.work_shape ||
    action.pipeline_ref !== expected.pipeline_ref ||
    action.target !== expected.target ||
    action.intent !== expected.intent ||
    action.handoff_to ||
    action.proposal_hash !== dotProposalHash(charter.dot_id, expected) ||
    !frontDeskBindingsEqual(binding, action.front_desk_execution)
  )
    reject(409, 'request_changed');
  const record = loadApprovalRequest('autonomy', approvalId);
  if (
    !record ||
    record.id !== approvalId ||
    record.storageChannel !== 'autonomy' ||
    record.kind !== 'channel-approval' ||
    record.status !== 'pending' ||
    !record.expiresAt ||
    !Number.isFinite(Date.parse(record.expiresAt)) ||
    isApprovalRequestExpired(record) ||
    record.requestedBy !== 'dot:' + charter.dot_id ||
    record.accountability?.finalDecision !== 'human_only' ||
    record.accountability.payloadHash !== effect.payloadHash ||
    record.accountability.effectBinding !== effect.effectBinding ||
    computeApprovalPayloadHash({ scope: record.scope }) !==
      computeApprovalPayloadHash({ scope: effect.effect.scope }) ||
    record.target ||
    record.steering ||
    record.workflow ||
    record.veto ||
    record.diagnosticDecision
  )
    reject(409, 'approval_unavailable');
  const deadline = new Date(
    Math.min(Date.parse(record.expiresAt), sessionExpiry * 1000)
  ).toISOString();
  if (Date.parse(deadline) <= Date.now()) reject(409, 'approval_expired');
  return {
    record,
    effect,
    deadline,
    displayDigest: firstJobApprovalDisplayDigest(record, effect, deadline),
  };
}
export function readFirstJobApprovals(
  authenticated: SurfaceViewerScope,
  token: string,
  input: FirstJobReadRequest = {}
) {
  if (input.locale !== undefined && (!normalizeLocale(input.locale) || input.locale.length > 32))
    reject(400, 'invalid_request');
  const base = {
    ok: true as const,
    auth: { status: 'authentication_required', login_href: LOGIN_HREF },
    readiness: { ready: false, status: 'authentication_required' },
    approvals: [] as FirstJobApprovalView[],
    held_requests: [] as Array<{
      request_id: string;
      status: 'approval_verification_failed';
      recovery: 'operator_recovery';
    }>,
  };
  let auth: ReturnType<typeof authenticate>;
  try {
    auth = authenticate(token);
  } catch {
    base.auth.status = resolveOidcLoginConfig().config
      ? 'authentication_required'
      : 'authentication_configuration_required';
    return base;
  }
  base.auth.status = 'ready';
  let viewer: SurfaceViewerScope;
  try {
    viewer = ownerViewer(authenticated, auth.principal.memberId!, input);
  } catch (error) {
    if (error instanceof FirstJobApprovalError && error.status === 403)
      base.auth.status = 'access_denied';
    base.readiness.status =
      error instanceof FirstJobApprovalError && error.message === 'first_job_scope_changed'
        ? 'scope_changed'
        : 'diagnostic_unavailable';
    return base;
  }
  const entries = listConfiguredFrontDeskExecutions((mapping) =>
    frontDeskExecutionViewerMatches(viewer, mapping)
  );
  for (const entry of entries) {
    const actions = currentDotActions(entry.mapping.dotId).filter(
      (action) =>
        action.request_id &&
        action.status === 'parked' &&
        frontDeskBindingsEqual(entry.binding, action.front_desk_execution)
    );
    for (const action of actions) {
      try {
        const record = loadApprovalRequest('autonomy', action.request_id!);
        const charter = findDotCharter(entry.mapping.dotId)?.charter;
        if (record && charter && hasVerifiedFirstJobDecision(record, charter, entry.binding))
          continue;
        const result = inspect(viewer, entry.binding, action.request_id!, auth.session.exp);
        base.approvals.push({
          approval_request_id: result.record.id,
          request_id: entry.binding.request_id,
          revision: entry.binding.revision,
          expires_at: result.record.expiresAt!,
          execution_deadline_at: result.deadline,
          display_digest: result.displayDigest,
          payload_hash: result.effect.payloadHash,
          effect_binding: result.effect.effectBinding,
          artifact_path: result.effect.effect.artifact_path,
          receipt_format: result.effect.effect.receipt_format,
          tenant: result.effect.effect.scope.tenant_slug,
        });
      } catch {
        // Pure recovery projection: the old parked action still owns its concurrency slot. Never reset, re-sign, or recycle it.
        if (!base.held_requests.some((held) => held.request_id === entry.binding.request_id))
          base.held_requests.push({
            request_id: entry.binding.request_id,
            status: 'approval_verification_failed',
            recovery: 'operator_recovery',
          });
      }
    }
  }
  base.readiness = { ready: true, status: 'ready' };
  return base;
}
export interface FirstJobApprovalView {
  approval_request_id: string;
  request_id: string;
  revision: number;
  expires_at: string;
  execution_deadline_at: string;
  display_digest: string;
  payload_hash: string;
  effect_binding: string;
  artifact_path: string;
  receipt_format: string;
  tenant: string;
}
/** Synchronous, serialized read/auth/verify/write. No task execution or live session issuance. */
export function decideFirstJobApproval(
  authenticated: SurfaceViewerScope,
  token: string,
  approvalId: string,
  input: FirstJobApprovalDecisionRequest
): ApprovalRequestRecord {
  requireDiagnosticEventBoundary();
  if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(approvalId))
    reject(400, 'invalid_request');
  if (!parseFirstJobApprovalDecisionRequest(input)) reject(400, 'invalid_request');
  // The verifier owns authentication; callers cannot inject an asserted principal.
  const auth = authenticate(token);
  const viewer = ownerViewer(authenticated, auth.principal.memberId!, input);
  return withExecutionContext('infrastructure_sentinel', () =>
    withLockSync('first-job-approval-' + approvalId, () => {
      const fresh = authenticate(token);
      ownerViewer(authenticated, fresh.principal.memberId!, input);
      const entries = listConfiguredFrontDeskExecutions((mapping) =>
        frontDeskExecutionViewerMatches(viewer, mapping)
      );
      const candidates = entries.filter((entry) =>
        currentDotActions(entry.mapping.dotId).some(
          (action) =>
            action.request_id === approvalId &&
            frontDeskBindingsEqual(entry.binding, action.front_desk_execution)
        )
      );
      if (candidates.length !== 1) reject(409, 'approval_unavailable');
      const checked = inspect(viewer, candidates[0].binding, approvalId, fresh.session.exp);
      if (
        checked.effect.ownerMemberId !== fresh.principal.memberId ||
        checked.displayDigest !== input.display_digest
      )
        reject(409, 'display_changed');
      const unsigned: Omit<FirstJobDecisionProof, 'signature'> = {
        version: 1,
        decision: input.decision,
        member_id: fresh.principal.memberId!,
        session_id: fresh.session.sid,
        session_expires_at: new Date(fresh.session.exp * 1000).toISOString(),
        identity_digest: computeApprovalPayloadHash({
          issuer: fresh.session.idp_iss,
          subject: fresh.session.sub,
        }),
        issued_at: new Date().toISOString(),
        display_digest: checked.displayDigest,
      };
      const key = browserSessionKey();
      if (
        !key ||
        !verifyBrowserSessionToken(token, {
          env: { ...process.env, KYBERION_SESSION_SECRET: key.toString('utf8') },
        })
      )
        reject(401, 'authentication_required');
      const proof = {
        ...unsigned,
        signature: createHmac('sha256', key)
          .update(firstJobProofMessage(checked.record, unsigned))
          .digest('hex'),
      };
      requireDiagnosticEventBoundary();
      const result = decideApprovalRequest('infrastructure_sentinel', {
        channel: checked.record.channel,
        storageChannel: 'autonomy',
        requestId: checked.record.id,
        decision: input.decision,
        decidedBy: fresh.principal.actor.id,
        decidedByType: 'human',
        authMethod: 'surface_session',
        authenticated: true,
        payloadHash: checked.effect.payloadHash,
        effectBinding: checked.effect.effectBinding,
        diagnosticDecision: proof,
        expectedRecordHash: computeApprovalPayloadHash({ record: checked.record }),
      });
      const readback = loadApprovalRequest('autonomy', checked.record.id);
      if (
        !readback ||
        readback.status !== input.decision ||
        readback.diagnosticDecision?.signature !== proof.signature ||
        readback.decidedBy !== fresh.principal.actor.id
      )
        reject(503, 'decision_uncertain');
      return result;
    })
  );
}
