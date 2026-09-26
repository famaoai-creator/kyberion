/**
 * FU-02: execution of plugin-view actions declared by `plugin-view-contract.ts`.
 *
 * `agent` actions are dispatched only when the owning plugin is active in
 * this process and op preflight admits the call. `human` actions become a
 * human-only approval request in the shared approval store; the approved
 * action is executed later, exactly once, by `executeApprovedPluginViewAction`
 * — every check (payload hash match, approved copy running under the
 * approved grant, preflight not rewriting the approved params) runs before
 * the approval is claimed (an exclusive-create sidecar), and every outcome is
 * audited. This module owns the action-request sidecars
 * (`active/shared/coordination/channels/chronos/plugin-view-actions/`) that
 * carry the queued params the approval record itself does not store.
 *
 * AU-01: an `agent` dispatch is audited with the same event vocabulary as a
 * human action's execution (`plugin_view.action.started` /
 * `plugin_view.action.execute`, see `auditAgentActionDispatch`) — nobody
 * approves it, so the dispatch itself is the accountable moment. Both audit
 * paths are best-effort (fail-open): a recording failure is logged and
 * swallowed, never blocking or reversing the action outcome (see
 * `auditActionExecution` / `auditAgentActionDispatch`). `params_digest` /
 * the payload hash correlate calls with the same params; they are unsalted
 * hashes for that purpose only, not a confidentiality mechanism.
 */
import { randomUUID } from 'node:crypto';
import {
  getActivePluginContentDigest,
  getActivePluginPermissionsDigest,
} from './plugin-lifecycle.js';
import { isRecord } from './foundation/text.js';
import { safeCreateExclusiveFileSync, safeExistsSync, safeRmSync } from './secure-io.js';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  approvalRequestLogicalPath,
  loadApprovalRequest,
  recordApprovalApplyResult,
  type ApprovalRequestRecord,
} from './approval-store.js';
import {
  listGovernedArtifacts,
  readGovernedArtifactJson,
  resolveGovernedArtifactPath,
  writeGovernedArtifactJson,
} from './artifact-store.js';
import { withExecutionContext } from './authority.js';
import { auditChain } from './audit-chain.js';
import { nowIso } from './foundation/time.js';
import { createLogger } from './logger.js';
import { resolveActuatorOperation } from './actuator-op-registry.js';
import { runOpPreflight } from './op-preflight.js';
import { redactSensitiveString } from './network.js';
import {
  PluginViewError,
  resolvePluginViewAction,
  type LoadedPluginView,
  type PluginViewErrorCode,
  type ResolvedPluginViewAction,
} from './plugin-view-contract.js';

const logger = createLogger('plugin-view-actions');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type PluginViewActionOutcome =
  | { status: 'approval_required'; approvalRequestId: string }
  | { status: 'dispatched'; handled: boolean }
  | { status: 'executed'; handled: boolean; approvalRequestId: string };

export interface DispatchPluginViewActionContext {
  requestedBy: string;
  actorRole: string;
  surface: 'chronos' | 'api';
}

// ---------------------------------------------------------------------------
// Policy constants
// ---------------------------------------------------------------------------

/** Chronos approval channel (listed by the Chronos approvals queue). */
export const PLUGIN_VIEW_APPROVAL_CHANNEL = 'chronos';

/** A human approval of a view action must be executed within this window. */
export const PLUGIN_VIEW_ACTION_APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

const ACTION_REQUEST_DIR = `active/shared/coordination/channels/${PLUGIN_VIEW_APPROVAL_CHANNEL}/plugin-view-actions`;
const MAX_LISTED_ACTION_REQUESTS = 50;
/** Newest sidecars scanned per listing; older requests are not listed. */
export const MAX_SCANNED_PLUGIN_VIEW_ACTION_REQUESTS = 200;
/** Sidecars of terminal approvals older than this are pruned. */
export const PLUGIN_VIEW_ACTION_REQUEST_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_PRUNED_PER_CALL = 50;
const ACTION_REQUEST_TIME_KEY_LENGTH = 15;
const ACTION_REQUEST_ENTRY = /^(\d{15})-[a-z0-9-]{1,128}\.json$/iu;
const ACTION_REQUEST_ID = /^\d{15}-([a-z0-9-]{1,128})\.json$/iu;

function actionTarget(resolved: ResolvedPluginViewAction): string {
  return `${resolved.view.pluginId}/${resolved.view.declaration.id}/${resolved.action.id}`;
}

function actionEffectBinding(resolved: ResolvedPluginViewAction): string {
  return `plugin-view-action:${actionTarget(resolved)}`;
}

/**
 * The approval of a human action is bound to the plugin, its tenant, view,
 * action, op, params, the approved content digest and the approved grant: a
 * reinstalled plugin (also for another tenant), a changed grant or changed
 * params can never reuse it.
 */
export function computePluginViewActionPayloadHash(resolved: ResolvedPluginViewAction): string {
  const { view, action, params } = resolved;
  return computeApprovalPayloadHash({
    plugin_id: view.pluginId,
    tenant_slug: view.tenantSlug ?? null,
    content_digest: view.contentDigest ?? null,
    permissions_digest: view.permissionsDigest ?? null,
    view_id: view.declaration.id,
    action_id: action.id,
    op: action.op,
    params,
  });
}

/** Sidecar of a queued human action (the approval record has no structured params). */
interface PluginViewActionRequestRecord {
  approval_request_id: string;
  plugin_id: string;
  tenant_slug: string | null;
  view_id: string;
  action_id: string;
  params: Record<string, unknown>;
  payload_hash: string;
  requested_at: string;
}

/** Sidecar names start with the request time, so name order is age order. */
function actionRequestPath(approvalRequestId: string, requestedAt: string): string {
  const time = Math.max(0, Date.parse(requestedAt) || 0);
  const key = String(time).padStart(ACTION_REQUEST_TIME_KEY_LENGTH, '0');
  return `${ACTION_REQUEST_DIR}/${key}-${approvalRequestId}.json`;
}

function actionClaimPath(approvalRequestId: string): string {
  return `${ACTION_REQUEST_DIR}/${approvalRequestId}.claim.json`;
}

/** Sidecar entries (with their request time), newest first. */
function listActionRequestEntries(): Array<{ entry: string; time: number }> {
  return listGovernedArtifacts(ACTION_REQUEST_DIR)
    .flatMap((entry) => {
      const match = ACTION_REQUEST_ENTRY.exec(entry);
      return match ? [{ entry, time: Number(match[1]) }] : [];
    })
    .sort((a, b) => (a.entry < b.entry ? 1 : a.entry > b.entry ? -1 : 0));
}

function isActionClaimed(approvalRequestId: string): boolean {
  return safeExistsSync(resolveGovernedArtifactPath(actionClaimPath(approvalRequestId)));
}

/**
 * Atomically claims an approved action for execution. The exclusive create
 * fails when another request already claimed it, so an approval runs once.
 */
function claimApprovedAction(approvalRequestId: string, claim: Record<string, unknown>): boolean {
  try {
    withExecutionContext('mission_controller', () =>
      safeCreateExclusiveFileSync(
        resolveGovernedArtifactPath(actionClaimPath(approvalRequestId)),
        JSON.stringify(claim, null, 2)
      )
    );
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Resolves the op only when the owning plugin is active in this process and
 * runs the approved content. `requireApprovedGrant` (human actions) also
 * requires the running module's grant to be the approved grant.
 */
function activePluginOperation(
  resolved: ResolvedPluginViewAction,
  options: { requireApprovedGrant?: boolean } = {}
) {
  const { view, action } = resolved;
  const [domain, ...rest] = action.op.split(':');
  let operation: ReturnType<typeof resolveActuatorOperation> = null;
  try {
    operation = resolveActuatorOperation(domain, rest.join(':'));
  } catch {
    operation = null; // unknown op: the plugin is not active here
  }
  if (
    !operation?.handler ||
    operation.source !== 'plugin' ||
    operation.pluginId !== view.pluginId
  ) {
    throw new PluginViewError(
      'PLUGIN_VIEW_ACTION_UNAVAILABLE',
      `op '${action.op}' is not active for plugin '${view.pluginId}' in this process`
    );
  }
  // The running module must be the approved copy: a re-approved package that
  // has not been reloaded yet (or an untracked activation) must not execute.
  const activeDigest = getActivePluginContentDigest(view.pluginId);
  if (!view.contentDigest || activeDigest !== view.contentDigest) {
    throw new PluginViewError(
      'PLUGIN_VIEW_ACTION_UNAVAILABLE',
      `plugin '${view.pluginId}' running in this process is not the approved copy; reload it first`
    );
  }
  if (options.requireApprovedGrant) {
    const activeGrant = getActivePluginPermissionsDigest(view.pluginId);
    if (activeGrant === null) {
      throw new PluginViewError(
        'PLUGIN_VIEW_ACTION_UNAVAILABLE',
        `plugin '${view.pluginId}' runs without a permission grant (legacy); approved actions need a grant-bound plugin`
      );
    }
    if (!view.permissionsDigest || activeGrant !== view.permissionsDigest) {
      throw new PluginViewError(
        'PLUGIN_VIEW_ACTION_UNAVAILABLE',
        `plugin '${view.pluginId}' running in this process does not run under the approved grant; reload it first`
      );
    }
  }
  return { ...operation, handler: operation.handler };
}

async function preflightActionInput(
  resolved: ResolvedPluginViewAction
): Promise<Record<string, unknown>> {
  const { action, params } = resolved;
  const preflight = await runOpPreflight({ op: action.op, params, source: 'pipeline' });
  if (preflight.decision !== 'allow') {
    throw new PluginViewError(
      'PLUGIN_VIEW_ACTION_DENIED',
      `op preflight ${preflight.decision}: ${preflight.reason ?? action.op}`
    );
  }
  return preflight.repaired_input ?? params;
}

function isTerminalActionApproval(approval: ApprovalRequestRecord | null, now: number): boolean {
  return (
    !approval ||
    Boolean(approval.applyResult) ||
    (approval.status !== 'pending' && approval.status !== 'approved') ||
    isApprovalRequestExpired(approval, now)
  );
}

/**
 * Removes sidecars (and claims) of requests older than the retention window
 * whose approval is terminal (decided and used, rejected, expired or gone).
 * Oldest first, at most `limit` per call. Returns the number pruned.
 */
export function prunePluginViewActionRequests(
  options: { now?: number; limit?: number } = {}
): number {
  const now = options.now ?? Date.now();
  const limit = options.limit ?? MAX_PRUNED_PER_CALL;
  let pruned = 0;
  for (const { entry, time } of listActionRequestEntries().reverse()) {
    if (pruned >= limit || time > now - PLUGIN_VIEW_ACTION_REQUEST_RETENTION_MS) break;
    const logicalPath = `${ACTION_REQUEST_DIR}/${entry}`;
    // The id comes from the file name (validated by ACTION_REQUEST_ENTRY),
    // never from sidecar content, so a tampered sidecar cannot steer deletes.
    const approvalRequestId = ACTION_REQUEST_ID.exec(entry)?.[1] ?? null;
    const sidecar = readGovernedArtifactJson<PluginViewActionRequestRecord>(logicalPath);
    if (!approvalRequestId || sidecar?.approval_request_id !== approvalRequestId) continue;
    const approval = loadActionApproval(approvalRequestId);
    // Keep outcome-unknown requests (claimed, no recorded result) for the operator.
    if (isActionClaimed(approvalRequestId) && !approval?.applyResult) continue;
    // A missing approval is gone; an unreadable one is kept until it can be read.
    if (!approval && actionApprovalExists(approvalRequestId)) continue;
    if (!isTerminalActionApproval(approval, now)) continue;
    withExecutionContext('mission_controller', () => {
      safeRmSync(resolveGovernedArtifactPath(logicalPath));
      safeRmSync(resolveGovernedArtifactPath(actionClaimPath(approvalRequestId)));
    });
    pruned += 1;
  }
  return pruned;
}

/**
 * `human` actions become a human-only approval request in the shared approval
 * store (the existing approval UI path) and are run later by
 * `executeApprovedPluginViewAction`; `agent` actions are dispatched only
 * when the owning plugin is active in this process and op preflight admits
 * the call. Nothing here imports or activates plugin code.
 */
export async function dispatchPluginViewAction(
  resolved: ResolvedPluginViewAction,
  context: DispatchPluginViewActionContext
): Promise<PluginViewActionOutcome> {
  const { view, action, params } = resolved;
  if (action.authority === 'human') {
    const target = actionTarget(resolved);
    const payloadHash = computePluginViewActionPayloadHash(resolved);
    const effectBinding = actionEffectBinding(resolved);
    const existing = listApprovalRequests({
      storageChannels: [PLUGIN_VIEW_APPROVAL_CHANNEL],
      status: 'pending',
    }).find(
      (request) =>
        request.accountability?.payloadHash === payloadHash &&
        request.accountability?.effectBinding === effectBinding &&
        !isApprovalRequestExpired(request)
    );
    if (existing) return { status: 'approval_required', approvalRequestId: existing.id };
    try {
      prunePluginViewActionRequests();
    } catch (error) {
      logger.warn(`[plugin-view] action request prune failed (ignored): ${String(error)}`);
    }
    // Same authority the plugin subsystem uses for install approvals
    // (plugin-managed-install.ts): the request is a governed artifact of the
    // plugin subsystem; the viewer was authorized by the calling surface.
    const record = createApprovalRequest('mission_controller', {
      channel: PLUGIN_VIEW_APPROVAL_CHANNEL,
      storageChannel: PLUGIN_VIEW_APPROVAL_CHANNEL,
      threadTs: target,
      correlationId: `${target}:${payloadHash.slice(0, 16)}`,
      requestedBy: context.requestedBy,
      expiresAt: new Date(Date.now() + PLUGIN_VIEW_ACTION_APPROVAL_TTL_MS).toISOString(),
      draft: {
        title: `Plugin view action: ${action.op}`,
        summary: `Plugin '${view.pluginId}' view '${view.declaration.id}' requests '${action.op}'.`,
        details: `Params: ${JSON.stringify(params)}`,
        severity: 'medium',
      },
      requestedByContext: {
        surface: context.surface,
        actorId: context.requestedBy,
        actorRole: context.actorRole,
      },
      justification: {
        reason: 'The plugin declared this view action with authority:human.',
        requestedEffects: [effectBinding],
      },
      accountability: { finalDecision: 'human_only', payloadHash, effectBinding },
    });
    const sidecar: PluginViewActionRequestRecord = {
      approval_request_id: record.id,
      plugin_id: view.pluginId,
      tenant_slug: view.tenantSlug ?? null,
      view_id: view.declaration.id,
      action_id: action.id,
      params,
      payload_hash: payloadHash,
      requested_at: record.requestedAt,
    };
    writeGovernedArtifactJson(
      'mission_controller',
      actionRequestPath(record.id, record.requestedAt),
      sidecar
    );
    return { status: 'approval_required', approvalRequestId: record.id };
  }

  // AU-01: an `agent` dispatch runs in-process with nobody to approve it, so
  // it is audited the same way a human action's execution is: a `dispatchId`
  // (generated once per call) correlates the pair the way `approvalRequestId`
  // does for a human action. A pre-handler refusal (plugin not active, op
  // unavailable, preflight rejection) is `denied` without a `started` entry
  // — the call never started; a handler throw is `failed`; success is
  // `completed`. Only `PluginViewError` refusals are audited here, the same
  // policy `executeApprovedPluginViewAction` applies to its own pre-handler
  // checks: an unexpected error type is never masked as a governed refusal.
  const dispatchId = randomUUID();
  let operation: ReturnType<typeof activePluginOperation>;
  let input: Record<string, unknown>;
  try {
    operation = activePluginOperation(resolved);
    input = await preflightActionInput(resolved);
  } catch (error) {
    if (error instanceof PluginViewError) {
      auditAgentActionDispatch(
        resolved,
        dispatchId,
        context,
        { action: 'plugin_view.action.execute', result: 'denied' },
        error.message
      );
    }
    throw error;
  }
  auditAgentActionDispatch(
    resolved,
    dispatchId,
    context,
    { action: 'plugin_view.action.started', result: 'allowed' },
    'agent action admitted by preflight; running the handler'
  );
  let outcome: Awaited<ReturnType<typeof operation.handler>>;
  try {
    outcome = await operation.handler(operation.action, input, {}, operation.stepType);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    auditAgentActionDispatch(
      resolved,
      dispatchId,
      context,
      { action: 'plugin_view.action.execute', result: 'failed' },
      message
    );
    throw error;
  }
  auditAgentActionDispatch(
    resolved,
    dispatchId,
    context,
    { action: 'plugin_view.action.execute', result: 'completed' },
    'agent action executed',
    outcome.handled
  );
  return { status: 'dispatched', handled: outcome.handled };
}

export interface ExecutePluginViewActionContext {
  executedBy: string;
  actorRole: string;
  surface: 'chronos' | 'api';
  now?: number;
}

function actionApprovalExists(approvalRequestId: string): boolean {
  try {
    return safeExistsSync(
      resolveGovernedArtifactPath(
        approvalRequestLogicalPath(PLUGIN_VIEW_APPROVAL_CHANNEL, approvalRequestId)
      )
    );
  } catch {
    return false;
  }
}

function loadActionApproval(approvalRequestId: string): ApprovalRequestRecord | null {
  try {
    return loadApprovalRequest(PLUGIN_VIEW_APPROVAL_CHANNEL, approvalRequestId);
  } catch {
    return null; // malformed id
  }
}

function principalKey(id: string | null | undefined): string {
  return (id ?? '')
    .trim()
    .toLowerCase()
    .replace(/^(?:human|user):/u, '');
}

/**
 * Self-approval is allowed (a single-operator localadmin requests, approves
 * and executes); it is made explicit in the audit instead: true when the
 * approver is also the requester or the executor.
 */
function isSelfApproved(
  approval: ApprovalRequestRecord,
  context: ExecutePluginViewActionContext
): boolean {
  const approver = principalKey(approval.decidedBy);
  return (
    approver.length > 0 &&
    (principalKey(approval.requestedBy) === approver ||
      principalKey(context.executedBy) === approver)
  );
}

type ActionAuditEvent =
  | { action: 'plugin_view.action.execute'; result: 'completed' | 'failed' | 'denied' }
  | { action: 'plugin_view.action.started'; result: 'allowed' };

/** Bound on a persisted audit `reason` (after redaction), see {@link sanitizeAuditReason}. */
const MAX_AUDIT_REASON_LENGTH = 500;

/**
 * A `reason` recorded here can be plugin-authored text this module never
 * validated: a thrown handler `Error.message`, or an op-preflight listener's
 * `reason` — either can echo back the very params the call carried. Redact
 * it with the same helper the audit forwarder already applies to outbound
 * audit entries (`redactSensitiveString`, `network.ts`; backed by
 * secret-guard's active-secret redaction plus generic secret/local-path
 * patterns) before it ever reaches the audit chain, then bound its length so
 * one hostile or buggy plugin cannot bloat the chain. Redaction runs on the
 * full string first so a secret pattern is never split — and left
 * unmatched — by the length cut.
 */
function sanitizeAuditReason(reason: string): string {
  return redactSensitiveString(reason).slice(0, MAX_AUDIT_REASON_LENGTH);
}

function auditActionExecution(
  resolved: ResolvedPluginViewAction,
  approvalRequestId: string,
  approval: ApprovalRequestRecord | null,
  context: ExecutePluginViewActionContext,
  event: ActionAuditEvent,
  reason: string,
  handled?: boolean
): void {
  try {
    auditChain.record({
      agentId: context.executedBy,
      action: event.action,
      operation: resolved.action.op,
      result: event.result,
      reason: sanitizeAuditReason(reason),
      correlationId: approvalRequestId,
      metadata: {
        plugin_id: resolved.view.pluginId,
        view_id: resolved.view.declaration.id,
        action_id: resolved.action.id,
        authority: 'human',
        approval_request_id: approvalRequestId,
        requested_by: approval?.requestedBy ?? null,
        approved_by: approval?.decidedBy ?? null,
        self_approved: approval ? isSelfApproved(approval, context) : false,
        executed_by: context.executedBy,
        actor_role: context.actorRole,
        surface: context.surface,
        content_digest: resolved.view.contentDigest ?? null,
        permissions_digest: resolved.view.permissionsDigest ?? null,
        ...(handled !== undefined ? { handled } : {}),
      },
      ...(resolved.view.tenantSlug ? { tenantSlug: resolved.view.tenantSlug } : {}),
    });
  } catch (error) {
    logger.warn(`[plugin-view] action audit failed (ignored): ${String(error)}`);
  }
}

/**
 * AU-01: same event vocabulary as `auditActionExecution` (`started` /
 * `execute` with `completed` / `failed` / `denied`), for an `agent`-authority
 * dispatch. Best-effort like the human path: never carries raw params, only
 * a stable digest (`computeApprovalPayloadHash`) used purely to correlate
 * repeated calls with the same params — it is an unsalted hash of data this
 * module does not otherwise treat as secret, not a confidentiality
 * guarantee, so it must never be treated as a safe place to smuggle
 * sensitive params either. A recording failure is logged and swallowed,
 * exactly like the human path (fail-open): it never turns a dispatch outcome
 * into something the audit chain could not itself record.
 */
function auditAgentActionDispatch(
  resolved: ResolvedPluginViewAction,
  dispatchId: string,
  context: DispatchPluginViewActionContext,
  event: ActionAuditEvent,
  reason: string,
  handled?: boolean
): void {
  try {
    auditChain.record({
      agentId: context.requestedBy,
      action: event.action,
      operation: resolved.action.op,
      result: event.result,
      reason: sanitizeAuditReason(reason),
      correlationId: dispatchId,
      metadata: {
        plugin_id: resolved.view.pluginId,
        view_id: resolved.view.declaration.id,
        action_id: resolved.action.id,
        authority: 'agent',
        dispatch_id: dispatchId,
        requested_by: context.requestedBy,
        actor_role: context.actorRole,
        surface: context.surface,
        content_digest: resolved.view.contentDigest ?? null,
        permissions_digest: resolved.view.permissionsDigest ?? null,
        params_digest: computeApprovalPayloadHash(resolved.params),
        ...(handled !== undefined ? { handled } : {}),
      },
      ...(resolved.view.tenantSlug ? { tenantSlug: resolved.view.tenantSlug } : {}),
    });
  } catch (error) {
    logger.warn(`[plugin-view] agent action audit failed (ignored): ${String(error)}`);
  }
}

function sameParams(left: Record<string, unknown>, right: Record<string, unknown>): boolean {
  return computeApprovalPayloadHash(left) === computeApprovalPayloadHash(right);
}

/**
 * Runs an approved `human` view action exactly once. The approval must be a
 * human, authenticated, unexpired decision whose payload hash equals the
 * hash recomputed from the current plugin (tenant, content + grant digest),
 * view, action and params; the running module must be the approved copy under
 * the approved grant, and op preflight may not rewrite the approved params
 * (the handler always receives exactly the approved params). Every check
 * runs before the approval is claimed and every refusal is audited, so a
 * refusal never spends it; the claim itself is an exclusive create, so a
 * second execution is refused. A claim without a recorded result (crash
 * mid-execution) is reported as `unknown`, never as executed.
 */
export async function executeApprovedPluginViewAction(
  resolved: ResolvedPluginViewAction,
  approvalRequestId: string,
  context: ExecutePluginViewActionContext
): Promise<PluginViewActionOutcome> {
  const { action } = resolved;
  if (action.authority !== 'human') {
    throw new PluginViewError(
      'PLUGIN_VIEW_ACTION_DENIED',
      `action '${action.id}' has agent authority and needs no approval`
    );
  }
  // Detached snapshot of the params as submitted: preflight listeners get
  // their own copy, so an in-place change to nested params can never reach
  // the handler or the approval comparison.
  let clonedParams: Record<string, unknown> | undefined;
  try {
    clonedParams = structuredClone(resolved.params);
  } catch {
    clonedParams = undefined; // refused (audited) below
  }
  const approval = loadActionApproval(approvalRequestId);
  const deny = (error: PluginViewError): never => {
    auditActionExecution(
      resolved,
      approvalRequestId,
      approval,
      context,
      { action: 'plugin_view.action.execute', result: 'denied' },
      error.message
    );
    throw error;
  };
  const refuse = (code: PluginViewErrorCode, message: string): never =>
    deny(new PluginViewError(code, message));
  if (!clonedParams) {
    return refuse('PLUGIN_VIEW_INVALID', 'action params are not plain data');
  }
  const approvedParams = clonedParams;
  if (!approval) {
    return refuse(
      'PLUGIN_VIEW_NOT_FOUND',
      `approval request '${approvalRequestId}' does not exist`
    );
  }
  if (
    approval.threadTs !== actionTarget(resolved) ||
    approval.accountability?.finalDecision !== 'human_only' ||
    approval.accountability.effectBinding !== actionEffectBinding(resolved) ||
    approval.accountability.payloadHash !== computePluginViewActionPayloadHash(resolved)
  ) {
    refuse(
      'PLUGIN_VIEW_APPROVAL_MISMATCH',
      `approval '${approval.id}' does not cover this plugin, view, action and params`
    );
  }
  if (approval.applyResult || isActionClaimed(approval.id)) {
    refuse('PLUGIN_VIEW_APPROVAL_CONSUMED', `approval '${approval.id}' was already used`);
  }
  if (
    approval.status !== 'approved' ||
    approval.decidedByType !== 'human' ||
    approval.authenticated !== true
  ) {
    refuse(
      'PLUGIN_VIEW_APPROVAL_REQUIRED',
      `approval '${approval.id}' is ${approval.status}; a person must approve it first`
    );
  }
  if (isApprovalRequestExpired(approval, context.now ?? Date.now())) {
    refuse('PLUGIN_VIEW_APPROVAL_REQUIRED', `approval '${approval.id}' has expired`);
  }

  let operation: ReturnType<typeof activePluginOperation>;
  let input: Record<string, unknown>;
  try {
    operation = activePluginOperation(resolved, { requireApprovedGrant: true });
    input = await preflightActionInput({ ...resolved, params: structuredClone(approvedParams) });
  } catch (error) {
    if (error instanceof PluginViewError) return deny(error);
    throw error;
  }
  // A preflight listener (plugin-registered ones included) may not turn the
  // approved call into a different one.
  if (
    !sameParams(input, approvedParams) ||
    approval.accountability?.payloadHash !==
      computePluginViewActionPayloadHash({ ...resolved, params: approvedParams })
  ) {
    refuse(
      'PLUGIN_VIEW_APPROVAL_MISMATCH',
      `op preflight rewrote the params approved in '${approval.id}'`
    );
  }
  if (
    !claimApprovedAction(approval.id, {
      approval_request_id: approval.id,
      claimed_by: context.executedBy,
      claimed_at: nowIso(),
    })
  ) {
    refuse('PLUGIN_VIEW_APPROVAL_CONSUMED', `approval '${approval.id}' was already used`);
  }
  auditActionExecution(
    resolved,
    approval.id,
    approval,
    context,
    { action: 'plugin_view.action.started', result: 'allowed' },
    'approved action claimed; running the handler'
  );

  const recordResult = (result: 'success' | 'failed', auditRef?: string) => {
    try {
      recordApprovalApplyResult('mission_controller', {
        channel: PLUGIN_VIEW_APPROVAL_CHANNEL,
        requestId: approval.id,
        applyResult: {
          appliedAt: nowIso(),
          appliedBy: context.executedBy,
          result,
          ...(auditRef ? { auditRef } : {}),
        },
      });
    } catch (error) {
      // The claim still prevents a second run; the request is reported `unknown`.
      logger.warn(`[plugin-view] recording the action result failed: ${String(error)}`);
    }
  };
  let outcome: Awaited<ReturnType<typeof operation.handler>>;
  try {
    outcome = await operation.handler(
      operation.action,
      structuredClone(approvedParams),
      {},
      operation.stepType
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    recordResult('failed', message.slice(0, 500));
    auditActionExecution(
      resolved,
      approval.id,
      approval,
      context,
      { action: 'plugin_view.action.execute', result: 'failed' },
      message
    );
    throw error;
  }
  recordResult('success');
  auditActionExecution(
    resolved,
    approval.id,
    approval,
    context,
    { action: 'plugin_view.action.execute', result: 'completed' },
    'approved action executed',
    outcome.handled
  );
  return { status: 'executed', handled: outcome.handled, approvalRequestId: approval.id };
}

export type PluginViewActionRequestStatus =
  | 'pending'
  | 'approved'
  | 'rejected'
  | 'expired'
  | 'executed'
  | 'failed'
  | 'unknown'
  | 'stale'
  | 'closed';

export interface PluginViewActionRequestSummary {
  approvalRequestId: string;
  pluginId: string;
  viewId: string;
  actionId: string;
  params: Record<string, unknown>;
  status: PluginViewActionRequestStatus;
  requestedAt: string;
  /** True only for an approved request this process can run now. */
  executable: boolean;
  /** Why an approved request cannot run in this process (error code). */
  unavailableReason?: PluginViewErrorCode;
}

function actionRequestStatus(
  approval: ApprovalRequestRecord,
  currentHash: string | null,
  now: number
): PluginViewActionRequestStatus {
  if (approval.applyResult)
    return approval.applyResult.result === 'success' ? 'executed' : 'failed';
  // Claimed without a recorded result: running now, or crashed mid-execution.
  if (isActionClaimed(approval.id)) return 'unknown';
  if (approval.status === 'rejected') return 'rejected';
  if (approval.status === 'expired') return 'expired';
  if (approval.status !== 'pending' && approval.status !== 'approved') return 'closed';
  if (isApprovalRequestExpired(approval, now)) return 'expired';
  if (currentHash !== approval.accountability?.payloadHash) return 'stale';
  return approval.status;
}

/**
 * Human action requests of the given (already viewer-filtered) views, newest
 * first; only the newest `MAX_SCANNED_PLUGIN_VIEW_ACTION_REQUESTS` sidecars
 * are read. A request is listed only for a view of the same plugin and
 * tenant. `stale` = the plugin or its grant changed since the request, so the
 * approval can no longer be executed. `executable` = approved and the
 * approved copy runs in this process under the approved grant.
 */
export function listPluginViewActionRequests(
  views: readonly LoadedPluginView[],
  options: { now?: number; maxScanned?: number } = {}
): PluginViewActionRequestSummary[] {
  const now = options.now ?? Date.now();
  const byView = new Map(views.map((view) => [`${view.pluginId}/${view.declaration.id}`, view]));
  const summaries: PluginViewActionRequestSummary[] = [];
  const entries = listActionRequestEntries().slice(
    0,
    options.maxScanned ?? MAX_SCANNED_PLUGIN_VIEW_ACTION_REQUESTS
  );
  for (const { entry } of entries) {
    const sidecar = readGovernedArtifactJson<PluginViewActionRequestRecord>(
      `${ACTION_REQUEST_DIR}/${entry}`
    );
    if (!sidecar || !isRecord(sidecar.params)) continue;
    const view = byView.get(`${sidecar.plugin_id}/${sidecar.view_id}`);
    if (!view || (sidecar.tenant_slug ?? null) !== (view.tenantSlug ?? null)) continue;
    const approval = loadActionApproval(sidecar.approval_request_id);
    if (
      !approval ||
      approval.threadTs !== `${view.pluginId}/${view.declaration.id}/${sidecar.action_id}`
    )
      continue;
    let resolved: ResolvedPluginViewAction | null = null;
    try {
      resolved = resolvePluginViewAction(view, sidecar.action_id, sidecar.params);
    } catch {
      resolved = null; // action or schema no longer admits these params
    }
    const status = actionRequestStatus(
      approval,
      resolved ? computePluginViewActionPayloadHash(resolved) : null,
      now
    );
    let unavailableReason: PluginViewErrorCode | undefined;
    if (status === 'approved' && resolved) {
      try {
        activePluginOperation(resolved, { requireApprovedGrant: true });
      } catch (error) {
        unavailableReason =
          error instanceof PluginViewError ? error.code : 'PLUGIN_VIEW_ACTION_UNAVAILABLE';
      }
    }
    summaries.push({
      approvalRequestId: approval.id,
      pluginId: view.pluginId,
      viewId: view.declaration.id,
      actionId: sidecar.action_id,
      params: sidecar.params,
      status,
      requestedAt: approval.requestedAt,
      executable: status === 'approved' && resolved !== null && !unavailableReason,
      ...(unavailableReason ? { unavailableReason } : {}),
    });
  }
  return summaries
    .sort((a, b) => (a.requestedAt < b.requestedAt ? 1 : a.requestedAt > b.requestedAt ? -1 : 0))
    .slice(0, MAX_LISTED_ACTION_REQUESTS);
}
