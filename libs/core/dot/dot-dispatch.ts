import { dotDigestActionEvidence } from './dot-digest-evidence.js';
import { dotDelegationCapacity, resumeDotCapacityActions } from './dot-admission-capacity.js';
import { composeDotBoundsPrompt, sameDotHandoffScope } from './dot-bounds-prompt.js';
export { dotDelegationCapacity } from './dot-admission-capacity.js';
import {
  CONTINUOUS_MANAGED_WORK_PIPELINE,
  parseContinuousWorkPlan,
} from '../organization/continuous-work-plan.js';
import { reconcileAdmittedDotAction } from './dot-admission-reconciliation.js';
import { composeDotDigestText, dotCharterTimezone } from './dot-digest-composition.js';
import { dotWorkItemInput, assertDotExistingWorkItem } from './dot-work-item.js';
import {
  dotJudgmentApprovalRouteFields,
  dotJudgmentApprovalFeedbackReady,
  requireCurrentDotJudgmentApproval,
  recordDotApprovalFeedback,
  recordDeferredDotJudgmentApprovalFeedback,
} from './dot-judgment-approval.js';
import { assertDotAccountabilityCharter } from './dot-authority.js';
import { isDotIntakeAdmission, loadDotExecutionPolicy } from './dot-execution-policy.js';
import { dotMissionAdmissionRefusal } from './dot-mission-admission-bounds.js';
import { sendDueDotDigest } from './dot-digest-delivery.js';
export { DOT_DIGEST_LEDGER_PATH } from './dot-digest-delivery.js';
import type { DotWorkResultRow } from './dot-state-paths.js';
import {
  admissionForDotRecord,
  assertDotJudgmentProposalCharter,
  dotAdmissionItemId,
  dotAdmissionScopeHash,
  dotRecordAdmissionMatches,
  genericDotActionIdentity,
  withDotAdmissionLock,
} from './dot-admission-identity.js';
import {
  DOT_ACTION_LEDGER_PATH,
  appendActionRecord,
  currentDotActions,
  dotProposalHash,
  type DotActionRecord,
} from './dot-action-ledger.js';
export {
  DOT_ACTION_LEDGER_PATH,
  readDotActionLedger,
  readDotActionLedgerStrict,
  dotActionRecordHash,
  declineRecoveredDotAction,
  currentDotActions,
  latestDotActions,
  dotProposalHash,
  type DotActionStatus,
  type DotActionRecord,
} from './dot-action-ledger.js';
import { assertBuiltinOnlyWorkerEventStream } from '../workforce/worker-event-stream.js';
import {
  firstJobApprovalEffect,
  hasFirstJobDiagnosticProvenance,
  hasVerifiedFirstJobDecision,
} from '../surface/first-job-approval-proof.js';
/**
 * Dot dispatch — the single enforcement point between a dot's proposals and
 * the world.
 *
 * Proposals pass charter bounds, strict decision floors and disposition overrides,
 * then governed routing, durable admission and deterministic WorkItem creation.
 * Parked approvals settle on later sweeps; admitted creations reconcile after crashes.
 *
 * Identity: every effect carries the dot actor id `dot:<dot_id>` — WorkItem
 * metadata, approval requester, audit-chain entries, and notification titles —
 * so "which dot did this" is answerable from any record.
 *
 * State: `active/shared/runtime/dot-action-ledger.jsonl`, append-only; the
 * latest row per `action_ref` is the action's state.
 */

import { withFrontDeskDispatchLock } from '../surface/front-desk-dispatch-lock.js';
import { inspectFrontDeskPendingRequest as inspectPendingRequest } from '../surface/front-desk-conversation-persistence.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import { validateServerDotJudgmentProposal } from './dot-judgment-binding.js';
import {
  evaluateAutonomousOpsAction,
  getAutonomousOpsPolicy,
  type AutonomousOpsGateInput,
  type AutonomousOpsGateResult,
} from '../governance/autonomous-ops-gate.js';
import {
  routeAutonomousDecision,
  type RouteAutonomousDecisionInput,
  type RoutedDecision,
} from '../governance/approval-decision-routing.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import { approvalUsabilityRefusal } from '../governance/approval-linked-usability.js';
import {
  expireApprovalRequest,
  isApprovalRequestExpired,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { auditChain } from '../governance/audit-chain.js';
import { createWorkItemIfAbsent, listWorkItems } from '../workforce/work-coordination.js';

import {
  getFrontDeskExecutionMapping,
  type FrontDeskExecutionBinding,
} from '../surface/front-desk-execution-contract.js';
import type { EventScopeInput } from '../event-scope.js';
import type { CreateWorkItemInput, WorkItem } from '../workforce/work-coordination-types.js';
import {
  notifyOperatorSync,
  notifyOperatorWithReceiptSync,
  type OperatorNotificationReceipt,
  type NotificationChannelTarget,
  type NotificationQuietHours,
  type OperatorEvent,
  type OperatorNotificationOptions,
  type OperatorNotificationPayload,
} from '../surface/operator-notifications.js';
import { appendDotInboxEntry, type DotInboxEntryInput } from './dot-inbox.js';
import {
  isFrontDeskDiagnosticDot,
  requireCurrentFrontDeskDiagnosticDot,
  listDotCharters,
  type DotCharter,
} from './dot-charter.js';
import { resolveTenant } from '../organization/tenant-registry.js';
import {
  DOT_ACTION_IDS,
  DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE,
  proposalActionIdentity,
  type DotDecisionLevel,
  type DotProposal,
  type DotWorkShape,
} from './dot-proposals.js';
import {
  learnedDotDecisionFloor,
  measureDotSuccessSignals,
  type DotFeedbackDeps,
  type DotFeedbackOutcome,
} from './dot-feedback.js';
import { createLogger } from '../logger.js';
import {
  DOT_DECISION_RELAXERS,
  DOT_DIGEST_SECTIONS,
  DOT_DISPOSITION_OVERRIDES,
  DOT_FLOOR_CONTRIBUTORS,
  DOT_PRE_GATE_CHECKS,
} from './dot-extension-registry.js';
import {
  DOT_L4_NOTIFY_TO_AUTO_EXCEPTION,
  type DotDecisionRelaxer,
  type DotExtCtx,
} from './dot-extensions.js';

const logger = createLogger('dot-dispatch');

/**
 * Shapes a charter may dispatch when it declares no `allowed_work_shapes`.
 * `task_session` is not a default: no governed task-session executor exists,
 * so a charter may only opt in explicitly and dispatch still refuses it unless
 * {@link DotDispatchDeps.taskSessionExecutorAvailable} says one is configured.
 */
export const DEFAULT_DOT_WORK_SHAPES: readonly DotWorkShape[] = ['direct_reply'];
/** Concurrency cap when a charter declares no `max_concurrent_delegations`. */
export { DEFAULT_DOT_MAX_CONCURRENT_DELEGATIONS } from './dot-charter.js';
/** The same proposal is not re-dispatched or re-asked within this window. */
export const DOT_PROPOSAL_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a proposal may wait on the operator when the charter sets no decision_expiry_minutes. */
export const DEFAULT_DOT_DECISION_EXPIRY_MINUTES = 24 * 60;
/** libs/core governed stores (approvals, WorkItems) write under this shared role. */
const GOVERNED_STORE_ROLE = 'infrastructure_sentinel';

const DECISION_RANK: Record<DotDecisionLevel, number> = { auto: 0, notify: 1, approve: 2 };

export interface DotDispatchDeps {
  /** Stable identity of the originating wake; reuse on retries, change for intentional new work. */
  operationKey?: string;
  readWorkResults?: (charter: DotCharter) => DotWorkResultRow[];
  notifyReceipt?: (
    event: OperatorEvent,
    payload: OperatorNotificationPayload,
    options: OperatorNotificationOptions
  ) => OperatorNotificationReceipt;
  rootDir?: string;
  now?: () => Date;
  gate?: (input: AutonomousOpsGateInput) => AutonomousOpsGateResult;
  route?: (input: RouteAutonomousDecisionInput) => RoutedDecision;
  createWorkItem?: (input: CreateWorkItemInput) => WorkItem;
  /** Open (non-terminal) WorkItems this dot created. */
  countOpenWorkItems?: (dotId: string) => number;
  /** WorkItem already created for this action_ref (makes execution idempotent across a crash). */
  findWorkItemByActionRef?: (actionRef: string) => WorkItem | undefined;
  listCharters?: () => DotCharter[];
  /** Throws when the tenant cannot take tenant-bound work (unregistered or not operational). */
  assertTenant?: (
    tenantSlug: string,
    diagnostic?: {
      charter: DotCharter;
      proposal: Pick<
        DotProposal,
        | 'action_id'
        | 'work_shape'
        | 'handoff_to'
        | 'pipeline_ref'
        | 'front_desk_execution'
        | 'continuous_work'
      >;
    }
  ) => void;
  appendInbox?: (input: DotInboxEntryInput) => void;
  notify?: (
    event: OperatorEvent,
    payload: OperatorNotificationPayload,
    options: OperatorNotificationOptions
  ) => boolean;
  audit?: (entry: Parameters<typeof auditChain.record>[0]) => void;
  loadApproval?: (requestId: string) => ApprovalRequestRecord | null;
  /** Mark a pending request expired in the approval store; returns the updated record. */
  expireApproval?: (record: ApprovalRequestRecord) => ApprovalRequestRecord;
  feedback?: Omit<DotFeedbackDeps, 'rootDir' | 'now'>;
  /** Policy `autonomy.relaxable_actions`; defaults to the autonomous-ops policy. */
  relaxableActions?: readonly string[];
  /**
   * True only when a governed task-session executor is configured. Defaults to
   * false: `task_session` proposals are refused before any gate or operator ask.
   */
  taskSessionExecutorAvailable?: boolean;
}

/** The charter's declared (or default) shapes, minus capabilities this runtime lacks. */
export function effectiveDotWorkShapes(
  charter: DotCharter,
  deps: Pick<DotDispatchDeps, 'taskSessionExecutorAvailable'> = {}
): DotWorkShape[] {
  const declared = charter.authority.allowed_work_shapes ?? DEFAULT_DOT_WORK_SHAPES;
  return declared.filter((shape) => shape !== 'task_session' || deps.taskSessionExecutorAvailable);
}

export function dotActorId(dotId: string): string {
  return `dot:${dotId}`;
}

function nowOf(deps: DotDispatchDeps): Date {
  return deps.now?.() ?? new Date();
}

function strictest(...levels: Array<DotDecisionLevel | undefined>): DotDecisionLevel | undefined {
  let result: DotDecisionLevel | undefined;
  for (const level of levels) {
    if (level && (!result || DECISION_RANK[level] > DECISION_RANK[result])) result = level;
  }
  return result;
}

/** Charter route: local inbox unless the charter explicitly opts into live delivery. */
export function dotNotificationRoute(charter: DotCharter): NotificationChannelTarget {
  const target = charter.notification.deliver_to;
  if (charter.notification.delivery_mode !== 'live' || target.surface === 'surface') {
    return { surface: 'inbox', target: dotActorId(charter.dot_id) };
  }
  return { surface: target.surface, target: target.channel };
}

export function dotQuietHours(charter: DotCharter): NotificationQuietHours | undefined {
  const quiet = charter.notification.quiet_hours;
  if (!quiet?.start || !quiet.end) return undefined;
  return {
    start: quiet.start,
    end: quiet.end,
    timezone: dotCharterTimezone(charter) ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  };
}

/**
 * The charter bounds, phrased for the wake prompt, so the dot proposes inside
 * them instead of spending proposals on refusals. Same sources as enforcement.
 */
export function dotBoundsPromptLines(charter: DotCharter, deps: DotDispatchDeps = {}): string[] {
  return composeDotBoundsPrompt(charter, effectiveDotWorkShapes(charter, deps), deps);
}

function defaultFindWorkItemByActionRef(
  actionRef: string,
  rootDir: string | undefined
): WorkItem | undefined {
  return listWorkItems({}, rootDir ? { rootDir } : {}).find(
    (item) => item.metadata?.action_ref === actionRef
  );
}

function defaultListCharters(deps: DotDispatchDeps): DotCharter[] {
  return listDotCharters(deps.rootDir, { errors: [] }).map((loaded) => loaded.charter);
}

function recordAudit(
  charter: DotCharter,
  operation: string,
  result: 'allowed' | 'denied' | 'completed' | 'failed',
  metadata: Record<string, unknown>,
  deps: DotDispatchDeps
): void {
  const entry = {
    agentId: dotActorId(charter.dot_id),
    actor: { kind: 'agent' as const, id: dotActorId(charter.dot_id), display_name: charter.title },
    action: 'dot_action',
    operation,
    result,
    metadata: {
      dot_id: charter.dot_id,
      authority_role: charter.authority.authority_role,
      ...metadata,
    },
    ...(charter.scope.tenant_slug ? { tenantSlug: charter.scope.tenant_slug } : {}),
  };
  try {
    (deps.audit ?? ((value) => auditChain.record(value)))(entry);
  } catch (error) {
    logger.warn(
      `[dot-dispatch] audit write failed for ${charter.dot_id} — ${error instanceof Error ? error.message : error} | next: the action ledger still records ${operation}`
    );
  }
}

export type DotBoundsVerdict = { ok: true } | { ok: false; reason: string; capacity?: true };

/** What the proposal may be at all: action, shape, handoff target. Re-checked at settlement. */
function checkDotProposalScope(
  charter: DotCharter,
  proposal: Pick<
    DotProposal,
    | 'action_id'
    | 'work_shape'
    | 'handoff_to'
    | 'pipeline_ref'
    | 'front_desk_execution'
    | 'continuous_work'
    | 'mission_admission'
  >,
  deps: DotDispatchDeps
): DotBoundsVerdict {
  try {
    assertDotAccountabilityCharter(charter, deps);
  } catch (error) {
    return { ok: false, reason: `accountability authority refused: ${String(error)}` };
  }
  const missionRefusal = dotMissionAdmissionRefusal(charter, proposal, deps.now?.());
  if (missionRefusal) return { ok: false, reason: missionRefusal };
  if (proposal.continuous_work) {
    try {
      parseContinuousWorkPlan(proposal.continuous_work);
    } catch (error) {
      return { ok: false, reason: String(error) };
    }
    if (
      !charter.scope.organization_id ||
      proposal.work_shape !== 'pipeline' ||
      proposal.pipeline_ref !== CONTINUOUS_MANAGED_WORK_PIPELINE ||
      !(charter.authority.allowed_pipelines ?? []).includes(CONTINUOUS_MANAGED_WORK_PIPELINE) ||
      proposal.handoff_to ||
      proposal.front_desk_execution
    ) {
      return {
        ok: false,
        reason:
          'Continuous managed work requires an organization and the explicitly allowed owner pipeline without handoff',
      };
    }
  }
  if (!DOT_ACTION_IDS.includes(proposal.action_id)) {
    return { ok: false, reason: `action '${proposal.action_id}' is not a dot action` };
  }
  const shapes = effectiveDotWorkShapes(charter, deps);
  if (proposal.work_shape === 'task_session' && !deps.taskSessionExecutorAvailable) {
    return { ok: false, reason: DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE };
  }
  if (!shapes.includes(proposal.work_shape)) {
    return {
      ok: false,
      reason: `work_shape '${proposal.work_shape}' is outside allowed_work_shapes (${shapes.join(', ')})`,
    };
  }
  const tenantSlug = charter.scope.tenant_slug;
  if (tenantSlug) {
    try {
      if (deps.assertTenant) {
        deps.assertTenant(
          tenantSlug,
          charter.runtime.execution_mode === 'front_desk_diagnostic'
            ? { charter, proposal }
            : undefined
        );
      } else {
        resolveTenant(tenantSlug, { rootDir: deps.rootDir });
      }
    } catch (error) {
      return {
        ok: false,
        reason: `tenant '${tenantSlug}' cannot take work: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  if (proposal.handoff_to) {
    if (proposal.handoff_to === charter.dot_id) {
      return { ok: false, reason: 'a dot cannot hand work to itself' };
    }
    const target = (deps.listCharters?.() ?? defaultListCharters(deps)).find(
      (other) => other.dot_id === proposal.handoff_to
    );
    if (!target || target.status !== 'active') {
      return { ok: false, reason: `handoff target '${proposal.handoff_to}' is not an active dot` };
    }
    if (!sameDotHandoffScope(charter, target)) {
      return {
        ok: false,
        reason: `cross-tenant handoff denied: '${charter.dot_id}' and '${proposal.handoff_to}' are in different tenant scopes`,
      };
    }
    if (!(target.team?.accepts_handoffs_from ?? []).includes(charter.dot_id)) {
      return {
        ok: false,
        reason: `dot '${proposal.handoff_to}' does not accept handoffs from '${charter.dot_id}'`,
      };
    }
  }
  return { ok: true };
}

/** Charter bounds that never depend on the gate: action, shape, handoff acceptance, concurrency. */
export function checkDotProposalBounds(
  charter: DotCharter,
  proposal: DotProposal,
  deps: DotDispatchDeps = {}
): DotBoundsVerdict {
  const scope = checkDotProposalScope(charter, proposal, deps);
  if (scope.ok === false) return scope;
  const { cap, open } = dotDelegationCapacity(charter, deps);
  if (open >= cap) {
    return {
      ok: false,
      capacity: true,
      reason: `max_concurrent_delegations ${cap} reached (${open} open or awaiting a decision)`,
    };
  }
  return { ok: true };
}

/** Gate verdict raised to the charter floor, learned floor, and requested decision. */
export function evaluateDotProposalGate(
  charter: DotCharter,
  proposal: DotProposal,
  deps: DotDispatchDeps = {}
): { gate: AutonomousOpsGateResult; floor?: DotDecisionLevel; relaxed_by?: string } {
  const ctx = dotDispatchExtCtx(deps);
  // Floors that can never be relaxed: charter default, the dot's own request,
  // and every registered floor contributor.
  const hardFloor = strictest(
    proposal.continuous_work ? 'approve' : undefined,
    charter.decisions?.default_decision,
    proposal.requested_decision,
    ...DOT_FLOOR_CONTRIBUTORS.map((contributor) => {
      try {
        return contributor.floor(charter, proposal, ctx);
      } catch (error) {
        extensionFailure('floor contributor', contributor.id, charter.dot_id, error);
        // Authorization contributors are load-bearing; an unavailable limit
        // must never disappear from the strictest floor.
        return 'approve' as const;
      }
    })
  );
  const learned = learnedDotDecisionFloor(charter.dot_id, {
    rootDir: deps.rootDir,
    now: deps.now,
  });
  let floor = strictest(hardFloor, learned);
  const intake = isDotIntakeAdmission(charter, proposal);
  const runGate = (requested: DotDecisionLevel | undefined) =>
    (deps.gate ?? evaluateAutonomousOpsAction)({
      actionId: intake ? loadDotExecutionPolicy().intake.action_id : proposal.action_id,
      ...(charter.scope.tenant_slug ? { tenantSlug: charter.scope.tenant_slug } : {}),
      ...(!intake && proposal.changed_paths ? { changedPaths: proposal.changed_paths } : {}),
      ...(requested ? { requestedDecision: requested } : {}),
    });
  let gate = runGate(floor);
  let relaxedBy: string | undefined;
  // Relaxers may only lower what the learned floor added: the result is
  // clamped to the policy gate's own decision (without the learned floor) and
  // to the charter default / hard floor. The one exception is the policy-listed
  // L4 notify → auto, re-verified here by dotNotifyToAutoExceptionApplies.
  if (DOT_DECISION_RELAXERS.length > 0 && ((floor && learned) || gate.decision === 'notify')) {
    let policyGate: AutonomousOpsGateResult | undefined;
    for (const relaxer of DOT_DECISION_RELAXERS) {
      let relaxed: ReturnType<DotDecisionRelaxer['relax']>;
      try {
        relaxed = relaxer.relax(charter, proposal, gate, floor, ctx);
      } catch (error) {
        extensionFailure('decision relaxer', relaxer.id, charter.dot_id, error);
        continue;
      }
      if (!relaxed) continue;
      policyGate ??= runGate(hardFloor);
      const relaxableActions = deps.relaxableActions ?? policyRelaxableActions();
      if (
        dotNotifyToAutoExceptionApplies({
          proposal,
          relaxed,
          policyGate,
          hardFloor,
          relaxableActions,
        })
      ) {
        floor = 'auto';
        gate = {
          ...policyGate,
          decision: 'auto',
          allowed: true,
          vetoWindowMinutes: undefined,
          reason: `${policyGate.reason}; ${DOT_L4_NOTIFY_TO_AUTO_EXCEPTION} by ${relaxer.id}: ${relaxed.reason}`,
        };
        relaxedBy = relaxer.id;
        break;
      }
      const clamped = strictest(relaxed.decision, policyGate.decision, hardFloor) ?? gate.decision;
      if (DECISION_RANK[clamped] < DECISION_RANK[gate.decision]) {
        floor = clamped;
        gate = runGate(floor);
        gate = { ...gate, reason: `${gate.reason}; relaxed by ${relaxer.id}: ${relaxed.reason}` };
        relaxedBy = relaxer.id;
      }
      break;
    }
  }
  // The charter may lengthen a veto window, never shorten the policy's (an
  // auto decision has no veto window to lengthen).
  const charterVeto = charter.decisions?.veto_window_minutes;
  const vetoWindowMinutes =
    gate.decision === 'auto'
      ? undefined
      : charterVeto !== undefined
        ? Math.max(charterVeto, gate.vetoWindowMinutes ?? 0)
        : gate.vetoWindowMinutes;
  const { vetoWindowMinutes: _veto, ...gateRest } = gate;
  return {
    gate: {
      ...gateRest,
      ...(vetoWindowMinutes !== undefined ? { vetoWindowMinutes } : {}),
    },
    ...(floor ? { floor } : {}),
    ...(relaxedBy ? { relaxed_by: relaxedBy } : {}),
  };
}

/**
 * Policy `autonomy.relaxable_actions`, read straight from the policy (not via
 * dot-autonomy, which imports this module). Fails closed: no section, no
 * exception.
 */
function policyRelaxableActions(): readonly string[] {
  try {
    const autonomy = (getAutonomousOpsPolicy() as { autonomy?: { relaxable_actions?: unknown } })
      .autonomy;
    const list = autonomy?.relaxable_actions;
    return Array.isArray(list) ? list.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

/** Gate escalations the L4 exception never undercuts. */
const DOT_NON_RELAXABLE_ESCALATIONS = new Set([
  'never_auto',
  'high_risk_path',
  'axis_max',
  'budget',
]);

/**
 * The single permitted decision below the policy gate (DL-10): a relaxer that
 * claims {@link DOT_L4_NOTIFY_TO_AUTO_EXCEPTION} may turn `notify` into `auto`
 * only when, on the policy side,
 *   - the action is in policy `autonomy.relaxable_actions`;
 *   - the policy gate (with the hard floor, without the learned floor) says
 *     exactly `notify` — never `approve`;
 *   - no hard floor (charter default, the dot's own request, floor
 *     contributors such as budget) is `notify` or stricter;
 *   - no never_auto / high-risk-path / axis-max / budget escalation, no
 *     high-risk path match, the action is not a policy shadow, and its
 *     reversibility axis is below 2.
 * The relaxer owns the dot side (L4, learned floor released, outcome success).
 */
export function dotNotifyToAutoExceptionApplies(input: {
  proposal: Pick<DotProposal, 'action_id'>;
  relaxed: { decision: DotDecisionLevel; exception?: string };
  policyGate: AutonomousOpsGateResult;
  hardFloor: DotDecisionLevel | undefined;
  relaxableActions: readonly string[];
}): boolean {
  const { proposal, relaxed, policyGate, hardFloor } = input;
  if (relaxed.exception !== DOT_L4_NOTIFY_TO_AUTO_EXCEPTION || relaxed.decision !== 'auto') {
    return false;
  }
  if (!input.relaxableActions.includes(proposal.action_id)) return false;
  if (policyGate.decision !== 'notify' || policyGate.shadow) return false;
  if (hardFloor && DECISION_RANK[hardFloor] >= DECISION_RANK.notify) return false;
  if ((policyGate.escalations ?? []).some((rule) => DOT_NON_RELAXABLE_ESCALATIONS.has(rule))) {
    return false;
  }
  if ((policyGate.highRiskPathMatches ?? []).length > 0) return false;
  return (policyGate.axes?.reversibility ?? 3) < 2;
}

function dotDispatchExtCtx(deps: DotDispatchDeps): DotExtCtx {
  return { rootDir: deps.rootDir, now: deps.now ?? (() => new Date()) };
}

function extensionFailure(kind: string, id: string, dotId: string, error: unknown): void {
  const authority = ['floor contributor', 'pre-gate check', 'disposition override'].includes(kind);
  logger.warn(
    `[dot-dispatch] ${kind} '${id}' failed for ${dotId} — ${error instanceof Error ? error.message : String(error)} | next: ${authority ? 'hold or require approval; repair the authorization extension' : 'optional observation continues without this section'} | evidence: libs/core/dot/dot-extension-bootstrap.ts`
  );
}

/** An unavailable authorization disposition keeps the proposal record-only. */
function runDotDispositionOverrides(
  charter: DotCharter,
  proposal: DotProposal,
  info: { action_ref: string; gate: AutonomousOpsGateResult; floor?: DotDecisionLevel },
  deps: DotDispatchDeps
): { id: string; reason: string } | undefined {
  const ctx = dotDispatchExtCtx(deps);
  for (const override of DOT_DISPOSITION_OVERRIDES) {
    try {
      const verdict = override.dispose(charter, proposal, info, ctx);
      if (verdict?.disposition === 'shadow') return { id: override.id, reason: verdict.reason };
    } catch (error) {
      extensionFailure('disposition override', override.id, charter.dot_id, error);
      return { id: override.id, reason: `authorization disposition unavailable: ${String(error)}` };
    }
  }
  return undefined;
}

type DotPreGateVerdict =
  | { ok: true }
  | { ok: false; reason: string; check_id: string }
  | {
      ok: 'escalate';
      reason: string;
      card_context: string;
      check_id: string;
      link?: { action_ref: string; dot_id: string };
      /** Every linked conflict when several escalations merged onto one card. */
      links?: Array<{ action_ref: string; dot_id: string }>;
    };

/**
 * Registered pre-gate checks in order. The first refusal wins; escalations
 * are merged (one forced operator decision carrying every check's context).
 * An unavailable authorization check refuses admission.
 */
function runDotPreGateChecks(
  charter: DotCharter,
  proposal: DotProposal,
  deps: DotDispatchDeps
): DotPreGateVerdict {
  const ctx = dotDispatchExtCtx(deps);
  let escalation: Extract<DotPreGateVerdict, { ok: 'escalate' }> | undefined;
  for (const check of DOT_PRE_GATE_CHECKS) {
    let verdict: ReturnType<typeof check.check>;
    try {
      verdict = check.check(charter, proposal, ctx);
    } catch (error) {
      extensionFailure('pre-gate check', check.id, charter.dot_id, error);
      return {
        ok: false,
        reason: `authorization check unavailable: ${String(error)}`,
        check_id: check.id,
      };
    }
    if (verdict.ok === false) return { ok: false, reason: verdict.reason, check_id: check.id };
    if (verdict.ok === 'escalate') {
      const links = [...(escalation?.links ?? []), ...(verdict.link ? [verdict.link] : [])];
      escalation = escalation
        ? {
            ...escalation,
            reason: `${escalation.reason}; ${verdict.reason}`,
            card_context: `${escalation.card_context}\n${verdict.card_context}`,
            ...(escalation.link ? {} : verdict.link ? { link: verdict.link } : {}),
          }
        : { ...verdict, check_id: check.id };
      if (links.length) escalation.links = links;
    }
  }
  if (escalation && (escalation.links?.length ?? 0) > 1 && escalation.link) {
    // Approval settles the primary link only; say so on the card.
    escalation.card_context = `${escalation.card_context}\nOn approve only ${escalation.link.action_ref} (${dotActorId(escalation.link.dot_id)}) is superseded; the other listed conflicts continue unless decided separately.`;
  }
  return escalation ?? { ok: true };
}

function notifyDot(
  charter: DotCharter,
  event: OperatorEvent,
  payload: OperatorNotificationPayload,
  deps: DotDispatchDeps
): boolean {
  const options: OperatorNotificationOptions = {
    route: dotNotificationRoute(charter),
    quietHours: dotQuietHours(charter),
  };
  return (deps.notify ?? notifyOperatorSync)(
    event,
    { ...payload, title: `[${dotActorId(charter.dot_id)}] ${payload.title}` },
    options
  );
}

/** Admission and the executor own request revisions. Dispatch retains only references,
 * and rechecks current mapping/charter scope before creating or settling an approval. */
function frontDeskDispatchScope(
  binding: FrontDeskExecutionBinding,
  charter: DotCharter
): EventScopeInput {
  const mapping = getFrontDeskExecutionMapping(binding);
  if (!mapping || mapping.dotId !== charter.dot_id || charter.status !== 'active')
    throw new Error('front-desk configuration changed');
  const viewer = mapping.viewer;
  const tenant = viewer.tenantSlugs === 'all' ? undefined : viewer.tenantSlugs[0];
  const organization = viewer.organizationIds === 'all' ? undefined : viewer.organizationIds[0];
  const project = viewer.projectIds === 'all' ? undefined : viewer.projectIds[0];
  const tier = viewer.tierAccess.includes('confidential') ? 'confidential' : 'public';
  if (
    !tenant ||
    charter.scope.tenant_slug !== tenant ||
    charter.scope.organization_id !== organization ||
    charter.scope.project_id !== project ||
    charter.scope.tier !== tier
  )
    throw new Error('front-desk mapping scope changed');
  return {
    scope_kind: project ? 'project' : organization ? 'organization' : 'tenant',
    tier,
    tenant_slug: tenant,
    viewer_principal: viewer.principalId,
    ...(organization ? { organization_id: organization } : {}),
    ...(project ? { project_id: project } : {}),
  };
}

/** Perform an allowed action: WorkItem (+ inbox wake for a handoff), audit, ledger. */
function executeDotAction(
  charter: DotCharter,
  record: DotActionRecord,
  deps: DotDispatchDeps,
  options: { reuseExisting?: boolean } = {}
): DotActionRecord {
  const binding = record.front_desk_execution;
  if (!binding)
    return withDotAdmissionLock(charter, deps.rootDir, () => {
      const latest = currentDotActions(charter.dot_id, deps).find(
        (row) => row.action_ref === record.action_ref
      );
      if (latest?.status === 'dispatched' || latest?.status === 'declined') return latest;
      try {
        requireCurrentDotJudgmentApproval(
          charter,
          latest?.status === 'admitted' ? latest : record,
          deps
        );
      } catch {
        return latest ?? record;
      }
      const admitted =
        latest?.status === 'admitted'
          ? latest
          : appendActionRecord(
              {
                ...record,
                status: 'admitted',
                admission: admissionForDotRecord(charter, record),
                work_item_id: dotAdmissionItemId(record.action_ref),
              },
              deps
            );
      return executeDotActionUnlocked(charter, admitted, deps, { reuseExisting: true });
    });
  return withFrontDeskDispatchLock(binding, () => {
    const latest = currentDotActions(charter.dot_id, deps).find(
      (row) => row.action_ref === record.action_ref
    );
    if (latest && latest.status !== 'parked') return latest;
    if (
      options.reuseExisting &&
      (!latest ||
        latest.request_id !== record.request_id ||
        latest.proposal_hash !== record.proposal_hash ||
        recoveryEvidenceHash(latest.front_desk_execution) !== recoveryEvidenceHash(binding))
    )
      return latest ?? record;
    const admission = inspectPendingRequest(binding, charter, deps);
    if (!admission.ok) return latest ?? record;
    const approval = record.request_id
      ? (deps.loadApproval ?? ((id: string) => loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, id)))(
          record.request_id
        )
      : null;
    if (isFrontDeskDiagnosticDot(charter) || hasFirstJobDiagnosticProvenance(binding, approval)) {
      if (
        !deps.assertTenant ||
        !isFrontDeskDiagnosticDot(charter) ||
        !approval ||
        !hasVerifiedFirstJobDecision(approval, charter, binding, Date.now())
      )
        return latest ?? record;
      requireCurrentFrontDeskDiagnosticDot(charter, deps.rootDir);
      assertBuiltinOnlyWorkerEventStream();
    }
    return executeDotActionUnlocked(charter, record, deps, options);
  });
}

function executeDotActionUnlocked(
  charter: DotCharter,
  record: DotActionRecord,
  deps: DotDispatchDeps,
  options: { reuseExisting?: boolean } = {}
): DotActionRecord {
  const actor = dotActorId(charter.dot_id);
  let item: WorkItem;
  try {
    if (record.front_desk_execution) frontDeskDispatchScope(record.front_desk_execution, charter);
    const find =
      deps.findWorkItemByActionRef ??
      (deps.createWorkItem
        ? undefined
        : (ref: string) => defaultFindWorkItemByActionRef(ref, deps.rootDir));
    const existing = options.reuseExisting ? find?.(record.action_ref) : undefined;
    const input = dotWorkItemInput(charter, record, deps.rootDir, existing);
    assertDotExistingWorkItem(record, existing, input, Boolean(deps.createWorkItem));
    requireCurrentDotJudgmentApproval(charter, record, deps);
    item =
      (deps.createWorkItem && existing) || (deps.createWorkItem ?? createWorkItemIfAbsent)(input);
  } catch (error) {
    const reason = `WorkItem creation failed: ${error instanceof Error ? error.message : String(error)}`;
    recordAudit(
      charter,
      record.action_id,
      'failed',
      { action_ref: record.action_ref, reason },
      deps
    );
    return appendActionRecord(
      {
        ...record,
        status: record.status === 'admitted' ? 'admitted' : 'refused',
        reason,
        at: nowOf(deps).toISOString(),
      },
      deps
    );
  }
  if (record.handoff_to) {
    try {
      (deps.appendInbox ?? ((input) => void appendDotInboxEntry(input, { rootDir: deps.rootDir })))(
        {
          dot_id: record.handoff_to,
          scope: charter.scope,
          channel: 'inbox',
          text: `Handoff from ${actor}: ${record.title}`,
          payload: {
            handoff_from: charter.dot_id,
            work_item_id: item.item_id,
            action_ref: record.action_ref,
          },
          source: 'dot-handoff',
          idempotency_key: record.action_ref,
        }
      );
    } catch (error) {
      logger.warn(
        `[dot-dispatch] handoff wake failed for ${record.handoff_to} — ${error instanceof Error ? error.message : error} | next: WorkItem ${item.item_id} is still in the ready pool`
      );
    }
  }
  recordAudit(
    charter,
    record.action_id,
    'completed',
    {
      action_ref: record.action_ref,
      work_item_id: item.item_id,
      decision: record.decision,
      ...(record.handoff_to ? { handoff_to: record.handoff_to } : {}),
      ...(record.request_id ? { approval_request_id: record.request_id } : {}),
    },
    deps
  );
  return appendActionRecord(
    { ...record, status: 'dispatched', work_item_id: item.item_id, at: nowOf(deps).toISOString() },
    deps
  );
}

function reconcileDotAdmission(
  charter: DotCharter,
  record: DotActionRecord,
  deps: DotDispatchDeps
): DotActionRecord {
  return reconcileAdmittedDotAction(charter, record, deps, {
    find:
      deps.findWorkItemByActionRef ?? ((ref) => defaultFindWorkItemByActionRef(ref, deps.rootDir)),
    scope: (proposal) => checkDotProposalScope(charter, proposal, deps),
    preGate: (proposal) => runDotPreGateChecks(charter, proposal, deps),
    gate: (proposal) => evaluateDotProposalGate(charter, proposal, deps).gate,
    shadow: (proposal, action_ref, gate) =>
      Boolean(runDotDispositionOverrides(charter, proposal, { action_ref, gate }, deps)),
    execute: (latest) => executeDotActionUnlocked(charter, latest, deps, { reuseExisting: true }),
  });
}

export function reconcileDotAdmissions(
  charter: DotCharter,
  deps: DotDispatchDeps = {}
): DotActionRecord[] {
  return currentDotActions(charter.dot_id, deps)
    .filter((row) => row.status === 'admitted' && !row.front_desk_execution)
    .map((row) => reconcileDotAdmission(charter, row, deps));
}

export interface DotDispatchResult {
  records: DotActionRecord[];
  duplicates: string[];
}

/** Govern every proposal from one wake. Never throws for a single bad proposal. */
export function dispatchDotProposals(
  charter: DotCharter,
  proposals: readonly DotProposal[],
  deps: DotDispatchDeps = {}
): DotDispatchResult {
  return withDotAdmissionLock(charter, deps.rootDir, () => {
    const result: DotDispatchResult = { records: [], duplicates: [] };
    for (const [ordinal, proposal] of proposals.entries()) {
      const dispatch = () => {
        if (proposal.front_desk_execution) {
          const admission = inspectPendingRequest(proposal.front_desk_execution, charter, deps);
          if (!admission.ok) return;
          const prior = currentDotActions(charter.dot_id, deps).find(
            (row) => row.action_ref === 'frontdesk-' + proposal.front_desk_execution!.work_item_id
          );
          if (prior && prior.status !== 'waiting_capacity') {
            result.duplicates.push(prior.action_ref);
            return;
          }
          if (
            prior?.status === 'waiting_capacity' &&
            dotDelegationCapacity(charter, deps).free === 0
          ) {
            result.records.push(prior);
            return;
          }
        }
        const next = dispatchDotProposalsUnlocked(charter, [proposal], deps, ordinal);
        result.records.push(...next.records);
        result.duplicates.push(...next.duplicates);
      };
      if (proposal.front_desk_execution)
        withFrontDeskDispatchLock(proposal.front_desk_execution, dispatch);
      else dispatch();
    }
    return result;
  });
}

function dispatchDotProposalsUnlocked(
  charter: DotCharter,
  proposals: readonly DotProposal[],
  deps: DotDispatchDeps = {},
  ordinalOffset = 0,
  retryIdentity?: Pick<DotActionRecord, 'action_ref' | 'admission'>
): DotDispatchResult {
  const records: DotActionRecord[] = [];
  const duplicates: string[] = [];
  const actor = dotActorId(charter.dot_id);
  for (const [index, proposal] of proposals.entries()) {
    const judgment = validateServerDotJudgmentProposal(proposal);
    assertDotJudgmentProposalCharter(charter, proposal);
    const now = nowOf(deps);
    const hash = dotProposalHash(charter.dot_id, proposal);
    const identity = proposal.front_desk_execution
      ? undefined
      : (retryIdentity ??
        genericDotActionIdentity(charter, proposal, ordinalOffset + index, deps.operationKey));
    const priorOperation =
      identity && (deps.operationKey || retryIdentity)
        ? currentDotActions(charter.dot_id, deps).find(
            (row) => row.action_ref === identity.action_ref
          )
        : undefined;
    if (priorOperation) {
      if (priorOperation.admission?.semantic_hash !== identity?.admission?.semantic_hash) {
        records.push({
          ...priorOperation,
          reason: 'operation identity conflict: proposal changed; original admission retained',
        });
      } else if (priorOperation.status === 'admitted') {
        records.push(reconcileDotAdmission(charter, priorOperation, deps));
      } else if (priorOperation.status !== 'waiting_capacity') {
        duplicates.push(priorOperation.action_ref);
      } else {
        // Capacity waiting has no executable reservation. Retry the same
        // immutable operation through every current gate when a slot opens.
        if (priorOperation.admission?.authority_role !== charter.authority.authority_role) {
          duplicates.push(priorOperation.action_ref);
          continue;
        }
      }
      if (
        priorOperation.status !== 'waiting_capacity' ||
        priorOperation.admission?.semantic_hash !== identity?.admission?.semantic_hash
      )
        continue;
    }
    const recent = currentDotActions(charter.dot_id, deps).find(
      (row) =>
        row.proposal_hash === hash &&
        (!row.admission || row.admission.scope_hash === dotAdmissionScopeHash(charter)) &&
        row.action_ref !==
          (priorOperation?.action_ref ??
            (proposal.front_desk_execution
              ? 'frontdesk-' + proposal.front_desk_execution.work_item_id
              : undefined)) &&
        (row.status === 'waiting_capacity' ||
          row.status === 'admitted' ||
          (row.status === 'dispatched' &&
            dotDigestActionEvidence(charter, row, deps).status !== 'done') ||
          ((row.status === 'parked' ||
            (!deps.operationKey && row.status === 'dispatched') ||
            row.status === 'declined' ||
            (row.status === 'shadow' && Boolean(row.disposition_by))) &&
            now.getTime() - Date.parse(row.at) < DOT_PROPOSAL_DEDUPE_WINDOW_MS))
    );
    if (recent) {
      if (recent.status === 'admitted') records.push(reconcileDotAdmission(charter, recent, deps));
      else duplicates.push(recent.action_ref);
      continue;
    }
    const base: DotActionRecord = {
      ...(judgment ? { semantic_judgment: judgment } : {}),
      scope: charter.scope,
      action_ref: proposal.front_desk_execution
        ? `frontdesk-${proposal.front_desk_execution.work_item_id}`
        : identity!.action_ref,
      ...(identity?.admission ? { admission: identity.admission } : {}),
      ...(proposal.front_desk_execution
        ? { front_desk_execution: proposal.front_desk_execution }
        : {}),
      dot_id: charter.dot_id,
      actor_id: actor,
      action_id: proposal.action_id,
      title: proposal.title,
      objective: proposal.objective,
      work_shape: proposal.work_shape,
      status: 'refused',
      proposal_hash: hash,
      ...(proposal.handoff_to ? { handoff_to: proposal.handoff_to } : {}),
      ...(proposal.priority ? { priority: proposal.priority } : {}),
      ...(proposal.rationale ? { rationale: proposal.rationale } : {}),
      ...(proposal.pipeline_ref ? { pipeline_ref: proposal.pipeline_ref } : {}),
      ...(proposal.continuous_work ? { continuous_work: proposal.continuous_work } : {}),
      ...(proposal.mission_admission ? { mission_admission: proposal.mission_admission } : {}),
      ...(proposal.expected_effect ? { expected_effect: proposal.expected_effect } : {}),
      ...(proposal.target ? { target: proposal.target } : {}),
      ...(proposal.intent ? { intent: proposal.intent } : {}),
      at: now.toISOString(),
    };
    try {
      if (ordinalOffset + index >= loadDotExecutionPolicy().intake.max_proposals_per_wake) {
        const reason = 'bounded intake fanout limit reached';
        recordAudit(charter, proposal.action_id, 'denied', { reason }, deps);
        records.push(appendActionRecord({ ...base, reason }, deps));
        continue;
      }
      const admissionScope = proposal.front_desk_execution
        ? frontDeskDispatchScope(proposal.front_desk_execution, charter)
        : undefined;
      // Server-bound requests never lower the human-approval floor.
      if (proposal.front_desk_execution && proposal.requested_decision !== 'approve')
        throw new Error('front-desk request requires explicit human approval');
      const bounds = checkDotProposalBounds(charter, proposal, deps);
      if (bounds.ok === false) {
        if (bounds.capacity) {
          // Repeated sweeps while full do not append errors or ask humans
          // again. No WorkItem, approval or effect is created in this state.
          records.push(
            priorOperation?.status === 'waiting_capacity'
              ? priorOperation
              : appendActionRecord(
                  { ...base, status: 'waiting_capacity', reason: bounds.reason },
                  deps
                )
          );
          continue;
        }
        recordAudit(charter, proposal.action_id, 'denied', { reason: bounds.reason }, deps);
        records.push(appendActionRecord({ ...base, reason: bounds.reason }, deps));
        continue;
      }
      const preGate = runDotPreGateChecks(charter, proposal, deps);
      if (preGate.ok === false) {
        const reason = `${preGate.check_id}: ${preGate.reason}`;
        recordAudit(charter, proposal.action_id, 'denied', { reason }, deps);
        records.push(appendActionRecord({ ...base, reason }, deps));
        continue;
      }
      const escalation = preGate.ok === 'escalate' ? preGate : undefined;
      // An escalation forces an operator decision: the proposal is gated as
      // if the dot itself had asked for approval.
      const { gate, floor } = evaluateDotProposalGate(
        charter,
        escalation ? { ...proposal, requested_decision: 'approve' } : proposal,
        deps
      );
      if (isDotIntakeAdmission(charter, proposal)) {
        recordAudit(
          charter,
          proposal.action_id,
          gate.allowed ? 'allowed' : 'denied',
          {
            phase: 'admission',
            admission_only: true,
            action_ref: base.action_ref,
            gate_action_id: gate.actionId,
            decision: gate.decision,
            reason: `bounded internal enqueue; wake tools are proposal/memory/followup only; concrete effects require execution governance; ${gate.reason}`,
          },
          deps
        );
      }
      const disposition = runDotDispositionOverrides(
        charter,
        proposal,
        { action_ref: base.action_ref, gate, ...(floor ? { floor } : {}) },
        deps
      );
      if (disposition) {
        // Record only: no decision card, no notification, no WorkItem.
        const reason = `${disposition.id}: ${disposition.reason}`;
        recordAudit(
          charter,
          proposal.action_id,
          'denied',
          { action_ref: base.action_ref, shadow: true, reason },
          deps
        );
        records.push(
          appendActionRecord(
            {
              ...base,
              status: 'shadow',
              decision: gate.decision,
              gate_decision: gate.decision,
              ...(floor ? { floor } : {}),
              disposition_by: disposition.id,
              reason,
            },
            deps
          )
        );
        continue;
      }
      const judgedRoute = dotJudgmentApprovalRouteFields(charter, base);
      let accountability: RouteAutonomousDecisionInput['accountability'] =
        judgedRoute.accountability;
      if (proposal.continuous_work) {
        accountability = {
          payloadHash: identity!.admission!.semantic_hash,
          effectBinding: `continuous-work:${base.action_ref}`,
        };
      }
      if (
        isFrontDeskDiagnosticDot(charter) ||
        hasFirstJobDiagnosticProvenance(proposal.front_desk_execution)
      ) {
        if (!proposal.front_desk_execution) throw new Error('diagnostic request binding required');
        const effect = firstJobApprovalEffect(charter, proposal.front_desk_execution);
        accountability = { payloadHash: effect.payloadHash, effectBinding: effect.effectBinding };
      }
      const question = `${charter.title} proposes: ${proposal.title} — ${proposal.continuous_work ? proposal.objective : proposal.objective.slice(0, 500)}`;
      const routed = (deps.route ?? routeAutonomousDecision)({
        role: GOVERNED_STORE_ROLE,
        gate,
        title: `[${actor}] ${proposal.title}`,
        question: escalation ? `${question}\n\n${escalation.card_context}` : question,
        recommendation: proposal.rationale ?? proposal.objective,
        requestedBy: actor,
        ...(charter.work_binding
          ? {
              operationBinding: {
                operation_id: charter.work_binding.operation_id,
                actor_role: charter.authority.authority_role,
              },
            }
          : {}),
        // actionId = action class + stable target, so same-signal re-proposals
        // supersede while different asks keep their own pending request.
        source: { agentId: actor, actionId: proposalActionIdentity(proposal) },
        ...(accountability ? { accountability } : {}),
        dedupeKey: `${charter.dot_id}-${hash}${charter.work_binding ? '-' + dotAdmissionScopeHash(charter) : ''}${proposal.continuous_work ? '-' + base.action_ref : ''}`,
        notificationRoute: dotNotificationRoute(charter),
        quietHours: dotQuietHours(charter),
        ...(charter.scope.tenant_slug
          ? {
              scope: {
                tenant_slug: charter.scope.tenant_slug,
                ...(charter.scope.organization_id
                  ? { organization_id: charter.scope.organization_id }
                  : {}),
              },
            }
          : {}),
        ...(admissionScope ? { scope: admissionScope } : {}),
        ...judgedRoute,
        now: now.getTime(),
      });
      const decided: DotActionRecord = {
        ...base,
        ...(isDotIntakeAdmission(charter, proposal)
          ? { admission_only: true, gate_action_id: gate.actionId }
          : {}),
        decision: gate.decision,
        gate_decision: gate.decision,
        ...(floor ? { floor } : {}),
        ...(routed.requestId ? { request_id: routed.requestId } : {}),
        ...(escalation
          ? {
              escalation: {
                check_id: escalation.check_id,
                reason: escalation.reason,
                ...(escalation.link ? { link: escalation.link } : {}),
                ...((escalation.links?.length ?? 0) > 1 ? { links: escalation.links } : {}),
              },
            }
          : {}),
      };
      if (routed.proceed) {
        const executed = executeDotAction(charter, decided, deps);
        if (executed.status === 'dispatched' && routed.level === 'fyi') {
          notifyDot(
            charter,
            'deliverable_ready',
            {
              title: `started: ${proposal.title}`,
              body: `${proposal.objective.slice(0, 500)}\nWorkItem ${executed.work_item_id}`,
              correlation_id: executed.action_ref,
            },
            deps
          );
        }
        records.push(executed);
      } else if (routed.parked) {
        recordAudit(
          charter,
          proposal.action_id,
          'allowed',
          {
            action_ref: base.action_ref,
            parked: true,
            level: routed.level,
            request_id: routed.requestId,
          },
          deps
        );
        records.push(
          appendActionRecord(
            { ...decided, status: 'parked', reason: `awaiting operator (${routed.level})` },
            deps
          )
        );
      } else {
        const reason = routed.shadow ? 'shadow action: recorded only' : gate.reason;
        recordAudit(charter, proposal.action_id, 'denied', { reason }, deps);
        records.push(
          appendActionRecord(
            { ...decided, status: routed.shadow ? 'shadow' : 'refused', reason },
            deps
          )
        );
      }
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      logger.warn(
        `[dot-dispatch] proposal failed for ${charter.dot_id} — ${reason} | next: the dot re-proposes on its next wake`
      );
      const admitted = currentDotActions(charter.dot_id, deps).find(
        (row) =>
          row.action_ref === base.action_ref &&
          (row.status === 'admitted' || row.status === 'dispatched')
      );
      records.push(admitted ?? appendActionRecord({ ...base, reason }, deps));
    }
  }
  return { records, duplicates };
}

const SETTLED_STATUS: Partial<Record<ApprovalRequestRecord['status'], DotFeedbackOutcome>> = {
  approved: 'approved',
  applied: 'approved',
  rejected: 'rejected',
  expired: 'expired',
  cancelled: 'cancelled',
};

/**
 * A decision that waited longer than the charter allows (or past the
 * request's own expiry) is expired, so an unattended inbox cannot hold the
 * dot's delegation slots forever.
 */
function dotDecisionExpired(
  charter: DotCharter,
  row: DotActionRecord,
  approval: ApprovalRequestRecord,
  deps: DotDispatchDeps
): boolean {
  const now = nowOf(deps).getTime();
  if (isApprovalRequestExpired(approval, now)) return true;
  // A live veto window may still approve by silence; only a card that fell
  // back to a human decision (or never had a window) waits on the operator.
  if (approval.veto && !approval.veto.fallback) return false;
  const maxWaitMs =
    (charter.decisions?.decision_expiry_minutes ?? DEFAULT_DOT_DECISION_EXPIRY_MINUTES) * 60_000;
  const parkedAt = Date.parse(row.at);
  return !Number.isFinite(parkedAt) || now - parkedAt >= maxWaitMs;
}

function expirePendingDecision(
  approval: ApprovalRequestRecord,
  deps: DotDispatchDeps,
  reason = 'dot_decision_expired'
): ApprovalRequestRecord | null {
  try {
    return (
      deps.expireApproval ??
      ((record: ApprovalRequestRecord) =>
        expireApprovalRequest(GOVERNED_STORE_ROLE, {
          channel: record.channel,
          storageChannel: AUTONOMY_APPROVAL_CHANNEL,
          requestId: record.id,
          reason,
        }))
    )(approval);
  } catch (error) {
    logger.warn(
      `[dot-dispatch] could not expire approval ${approval.id} — ${error instanceof Error ? error.message : error} | next: retried on the next sweep`
    );
    return approval;
  }
}

function declineParked(
  charter: DotCharter,
  row: DotActionRecord,
  reason: string,
  deps: DotDispatchDeps
): DotActionRecord {
  recordAudit(charter, row.action_id, 'denied', { action_ref: row.action_ref, reason }, deps);
  return appendActionRecord(
    { ...row, status: 'declined', reason, at: nowOf(deps).toISOString() },
    deps
  );
}

/** Decline reason for a parked action replaced by another dot's approved action (DL-11). */
export const DOT_SUPERSEDED_REASON = 'superseded';

/**
 * Decline a parked action because another dot's approved action replaced it.
 * Unlike an operator rejection this records NO dot feedback, so it never
 * raises the dot's learned decision floor; its pending card is expired so the
 * operator is not asked twice. Returns undefined when the action is not parked,
 * or when its card was already approved (audited `supersede_skipped`; the
 * operator's approval is never overturned silently).
 */
export function supersedeDotParkedAction(
  charter: DotCharter,
  actionRef: string,
  supersededBy: { dot_id: string; action_ref: string },
  deps: DotDispatchDeps = {}
): DotActionRecord | undefined {
  const candidate = currentDotActions(charter.dot_id, deps).find(
    (row) => row.action_ref === actionRef
  );
  if (!candidate?.front_desk_execution)
    return supersedeDotParkedActionUnlocked(charter, actionRef, supersededBy, deps);
  return withFrontDeskDispatchLock(candidate.front_desk_execution, () => {
    if (!inspectPendingRequest(candidate.front_desk_execution!, charter, deps).ok) return undefined;
    return supersedeDotParkedActionUnlocked(charter, actionRef, supersededBy, deps);
  });
}

function supersedeDotParkedActionUnlocked(
  charter: DotCharter,
  actionRef: string,
  supersededBy: { dot_id: string; action_ref: string },
  deps: DotDispatchDeps = {}
): DotActionRecord | undefined {
  const row = currentDotActions(charter.dot_id, deps).find(
    (candidate) => candidate.action_ref === actionRef
  );
  if (!row || row.status !== 'parked') return undefined;
  if (row.request_id) {
    const load =
      deps.loadApproval ??
      ((requestId: string) => loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId));
    try {
      const approval = load(row.request_id);
      if (approval && (approval.status === 'approved' || approval.status === 'applied')) {
        // An operator already said yes to this card: never overturn it
        // silently. It stays parked (settled normally) and the skip is audited.
        const reason = `not superseded: ${row.request_id} already ${approval.status} by ${approval.decidedBy ?? 'operator'}; superseding action ${supersededBy.action_ref} (${dotActorId(supersededBy.dot_id)}) needs a separate operator decision`;
        recordAudit(
          charter,
          'supersede_skipped',
          'denied',
          { action_ref: row.action_ref, reason, superseded_by: supersededBy },
          deps
        );
        logger.warn(
          `[dot-dispatch] ${reason} | next: resolve the conflict by hand | evidence: ${DOT_ACTION_LEDGER_PATH}`
        );
        return undefined;
      }
      if (approval?.status === 'pending') expirePendingDecision(approval, deps, 'dot_superseded');
    } catch (error) {
      logger.warn(
        `[dot-dispatch] approval ${row.request_id} unreadable while superseding ${actionRef} — ${error instanceof Error ? error.message : error} | next: the action is still declined; the stale card can be dismissed`
      );
    }
  }
  return declineParked(
    charter,
    { ...row, superseded_by: supersededBy },
    DOT_SUPERSEDED_REASON,
    deps
  );
}

/** Resume capacity waits only when slots are free; original identities remain pinned. */
export function settleDotCapacityActions(
  charter: DotCharter,
  deps: DotDispatchDeps = {}
): DotActionRecord[] {
  return resumeDotCapacityActions(charter, deps, (row) => {
    const admission = row.admission!;
    return dispatchDotProposalsUnlocked(
      charter,
      [admission.proposal],
      { ...deps, operationKey: admission.operation_key },
      admission.ordinal,
      row
    ).records;
  });
}

/**
 * Advance this dot's parked actions: approved → execute (after re-checking
 * the charter scope, which may have narrowed while it waited), anything else
 * terminal → declined. Every settlement is recorded once as feedback; silence
 * that elapsed a veto window is feedback from the policy, not the operator.
 * A transient load failure leaves the action parked for the next sweep.
 */
export function settleDotParkedActions(
  charter: DotCharter,
  deps: DotDispatchDeps = {}
): DotActionRecord[] {
  const settled: DotActionRecord[] = [];
  const load =
    deps.loadApproval ??
    ((requestId: string) => loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, requestId));
  const feedbackDeps = { rootDir: deps.rootDir, now: deps.now, ...(deps.feedback ?? {}) };
  for (const candidate of currentDotActions(charter.dot_id, deps)) {
    const settle = () => {
      const row = currentDotActions(charter.dot_id, deps).find(
        (value) => value.action_ref === candidate.action_ref
      );
      if (!row) return;
      if (
        row.front_desk_execution &&
        !inspectPendingRequest(row.front_desk_execution, charter, deps).ok
      )
        return;
      if (row.status !== 'parked' || !row.request_id) return;
      // Scope/binding changes never consume an old decision, including removal
      // of an operation binding. Keep the original row parked for reconciliation.
      if (!dotRecordAdmissionMatches(charter, row)) return;
      let approval: ApprovalRequestRecord | null;
      try {
        approval = load(row.request_id);
      } catch (error) {
        logger.warn(
          `[dot-dispatch] approval ${row.request_id} unreadable for ${charter.dot_id} — ${error instanceof Error ? error.message : error} | next: retried on the next sweep`
        );
        return;
      }
      if (!dotJudgmentApprovalFeedbackReady(charter, row, approval, () => nowOf(deps).getTime()))
        return;
      const diagnostic =
        isFrontDeskDiagnosticDot(charter) ||
        hasFirstJobDiagnosticProvenance(row.front_desk_execution, approval);
      if (diagnostic) {
        if (!deps.assertTenant || !isFrontDeskDiagnosticDot(charter)) return;
        try {
          requireCurrentFrontDeskDiagnosticDot(charter, deps.rootDir);
        } catch {
          return;
        }
        assertBuiltinOnlyWorkerEventStream();
      }
      // Preserve old/forged approved evidence without treating it as authority.
      if (
        approval &&
        (approval.status === 'approved' || approval.status === 'applied') &&
        diagnostic &&
        (!row.front_desk_execution ||
          !hasVerifiedFirstJobDecision(approval, charter, row.front_desk_execution, Date.now()))
      )
        return;
      if (approval?.status === 'pending' && dotDecisionExpired(charter, row, approval, deps)) {
        approval = expirePendingDecision(approval, deps);
      }
      if (!dotJudgmentApprovalFeedbackReady(charter, row, approval, () => nowOf(deps).getTime()))
        return;
      const outcome = approval ? SETTLED_STATUS[approval.status] : 'cancelled';
      if (!outcome) return;
      const decidedBy = approval?.decidedBy;
      const deferred = Boolean(row.semantic_judgment) && outcome === 'approved';
      if (!deferred) recordDotApprovalFeedback(charter, row, approval, outcome, feedbackDeps);
      if (outcome !== 'approved') {
        settled.push(
          declineParked(
            charter,
            row,
            approval ? `approval ${approval.status}` : 'approval request missing',
            deps
          )
        );
        return;
      }
      const scope = checkDotProposalScope(charter, row, deps);
      if (scope.ok === false) {
        settled.push(
          declineParked(charter, row, `approved but no longer in scope: ${scope.reason}`, deps)
        );
        return;
      }
      const sodRefusal = approvalUsabilityRefusal(approval, 'dot_dispatch'); // separation of duties
      if (sodRefusal) return void settled.push(declineParked(charter, row, sodRefusal, deps));
      const executed = executeDotAction(
        charter,
        { ...row, reason: `approved by ${decidedBy ?? 'operator'}` },
        deps,
        {
          reuseExisting: true,
        }
      );
      settled.push(executed);
      if (deferred) recordDeferredDotJudgmentApprovalFeedback(charter, row, executed, deps);
    };
    if (candidate.front_desk_execution)
      withFrontDeskDispatchLock(candidate.front_desk_execution, settle);
    else settle();
  }
  return settled;
}

export interface DotHousekeepingResult {
  settled: DotActionRecord[];
  signals: number;
  digest: boolean;
  errors: string[];
}

/**
 * Per-sweep upkeep that costs no tokens, so it runs even for a token-capped
 * dot: settle parked decisions, measure success signals, send a due digest.
 * Each step is isolated — one failing step never starves the others.
 */
export async function runDotHousekeeping(
  charter: DotCharter,
  deps: DotDispatchDeps & {
    serviceCall?: Parameters<typeof measureDotSuccessSignals>[1]['serviceCall'];
  } = {}
): Promise<DotHousekeepingResult> {
  const result: DotHousekeepingResult = { settled: [], signals: 0, digest: false, errors: [] };
  // The general supervisor cannot consume a CLI-only diagnostic request.
  // Leave its pending decisions untouched until the explicit bounded tick.
  if (charter.runtime.execution_mode === 'front_desk_diagnostic' && !deps.assertTenant) {
    result.errors.push('diagnostic_requires_bounded_first_job_tick');
    return result;
  }
  const fail = (step: string, error: unknown) =>
    result.errors.push(`${step}: ${error instanceof Error ? error.message : String(error)}`);
  try {
    result.settled = [
      ...reconcileDotAdmissions(charter, deps),
      ...settleDotParkedActions(charter, deps),
      ...settleDotCapacityActions(charter, deps),
    ];
  } catch (error) {
    fail('settle', error);
  }
  try {
    result.signals = (
      await measureDotSuccessSignals(charter, {
        rootDir: deps.rootDir,
        now: deps.now,
        serviceCall: deps.serviceCall,
      })
    ).length;
  } catch (error) {
    fail('signals', error);
  }
  try {
    result.digest = maybeSendDotDigest(charter, deps);
  } catch (error) {
    fail('digest', error);
  }
  return result;
}

// ---------------------------------------------------------------------------
// digest
// ---------------------------------------------------------------------------

export { dotCharterTimezone } from './dot-digest-composition.js';
export function composeDotDigest(
  charter: DotCharter,
  since: Date | undefined,
  deps: DotDispatchDeps = {}
): string {
  return composeDotDigestText(charter, since, deps, dotDigestSectionLines(charter, since, deps));
}

function dotDigestSectionLines(
  charter: DotCharter,
  since: Date | undefined,
  deps: DotDispatchDeps
): string[] {
  const ctx = dotDispatchExtCtx(deps);
  const lines: string[] = [];
  for (const section of DOT_DIGEST_SECTIONS) {
    try {
      lines.push(...section.lines(charter, since, ctx));
    } catch (error) {
      extensionFailure('digest section', section.id, charter.dot_id, error);
    }
  }
  return lines;
}

/** Durable bounded catch-up and retries; accepted is enqueue evidence, not remote delivery. */
export function maybeSendDotDigest(charter: DotCharter, deps: DotDispatchDeps = {}): boolean {
  return sendDueDotDigest(charter, dotCharterTimezone(charter), {
    rootDir: deps.rootDir,
    now: deps.now,
    compose: (since) => composeDotDigest(charter, since, deps),
    notify: (text, key) => {
      const payload = {
        title: '[' + dotActorId(charter.dot_id) + '] digest',
        body: text,
        correlation_id: key,
      };
      const options = {
        route: dotNotificationRoute(charter),
        quietHours: dotQuietHours(charter),
        deduplicationKey: key,
      };
      if (deps.notifyReceipt) return deps.notifyReceipt('decision_digest', payload, options);
      if (deps.notify)
        return {
          status: deps.notify('decision_digest', payload, options) ? 'accepted' : 'retryable',
          reason: 'injected_notification_port',
        };
      return notifyOperatorWithReceiptSync('decision_digest', payload, options);
    },
  });
}
