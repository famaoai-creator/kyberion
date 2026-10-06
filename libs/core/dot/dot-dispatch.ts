import {
  DOT_ACTION_LEDGER_PATH,
  appendActionRecord,
  currentDotActions,
  dotProposalHash,
  type DotActionRecord,
  type DotActionStatus,
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
 * Every proposal goes through, in order:
 *   1. charter bounds — `authority.allowed_work_shapes`, handoff acceptance,
 *      `authority.max_concurrent_delegations` (open WorkItems + parked actions);
 *   2. decision — autonomous-ops-gate, raised (never lowered) to the strictest
 *      of the charter `decisions.default_decision`, the floor learned from
 *      operator rejections, and the dot's own requested decision. The single
 *      exception is {@link dotNotifyToAutoExceptionApplies} (L4 notify → auto
 *      for a policy `autonomy.relaxable_actions` action);
 *   2b. disposition — a {@link DotDispositionOverride} may turn the proposal
 *      into a record-only `shadow` row (L0: no card, no WorkItem);
 *   3. routing — `routeAutonomousDecision` (decision card, veto window,
 *      digest notice) delivered to the charter's route;
 *   4. outcome — proceed → WorkItem (or a handoff to another dot); parked →
 *      settled on a later sweep by {@link settleDotParkedActions}.
 *
 * Identity: every effect carries the dot actor id `dot:<dot_id>` — WorkItem
 * metadata, approval requester, audit-chain entries, and notification titles —
 * so "which dot did this" is answerable from any record.
 *
 * State: `active/shared/runtime/dot-action-ledger.jsonl`, append-only; the
 * latest row per `action_ref` is the action's state.
 */

import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { withFrontDeskDispatchLock } from '../surface/front-desk-dispatch-lock.js';
import { inspectFrontDeskPendingRequest as inspectPendingRequest } from '../surface/front-desk-conversation-persistence.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { matchesCron, getZonedDateParts } from '../pipeline/cron-utils.js';
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
import {
  expireApprovalRequest,
  isApprovalRequestExpired,
  loadApprovalRequest,
  type ApprovalRequestRecord,
} from '../governance/approval-store.js';
import { auditChain } from '../governance/audit-chain.js';
import {
  createWorkItem,
  createWorkItemIfAbsent,
  listWorkItems,
} from '../workforce/work-coordination.js';

import {
  getFrontDeskExecutionMapping,
  type FrontDeskExecutionBinding,
} from '../surface/front-desk-execution-contract.js';
import type { EventScopeInput } from '../event-scope.js';
import type { CreateWorkItemInput, WorkItem } from '../workforce/work-coordination-types.js';
import {
  notifyOperatorSync,
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
  dotGoalRefLabel,
  listDotCharters,
  type DotCharter,
} from './dot-charter.js';
import { resolveTenant } from '../organization/tenant-registry.js';
import {
  DOT_ACTION_IDS,
  DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE,
  type DotDecisionLevel,
  type DotProposal,
  type DotWorkShape,
} from './dot-proposals.js';
import {
  dotSignalStatusLines,
  hasDotFeedbackFor,
  learnedDotDecisionFloor,
  measureDotSuccessSignals,
  recordDotFeedback,
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
export const DEFAULT_DOT_MAX_CONCURRENT_DELEGATIONS = 3;
/** The same proposal is not re-dispatched or re-asked within this window. */
export const DOT_PROPOSAL_DEDUPE_WINDOW_MS = 24 * 60 * 60 * 1000;
/** How long a proposal may wait on the operator when the charter sets no decision_expiry_minutes. */
export const DEFAULT_DOT_DECISION_EXPIRY_MINUTES = 24 * 60;
/** libs/core governed stores (approvals, WorkItems) write under this shared role. */
const GOVERNED_STORE_ROLE = 'infrastructure_sentinel';

const DECISION_RANK: Record<DotDecisionLevel, number> = { auto: 0, notify: 1, approve: 2 };
const OPEN_WORK_ITEM_STATUSES = ['backlog', 'ready', 'in_progress', 'blocked', 'review'] as const;

export interface DotDispatchDeps {
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
        'action_id' | 'work_shape' | 'handoff_to' | 'pipeline_ref' | 'front_desk_execution'
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

function defaultCountOpenWorkItems(dotId: string, rootDir?: string): number {
  return listWorkItems({ status: [...OPEN_WORK_ITEM_STATUSES] }, rootDir ? { rootDir } : {}).filter(
    (item) => item.metadata?.dot_id === dotId
  ).length;
}

function openDelegations(charter: DotCharter, deps: DotDispatchDeps): number {
  const parked = currentDotActions(charter.dot_id, deps).filter(
    (row) => row.status === 'parked'
  ).length;
  const count =
    deps.countOpenWorkItems ?? ((dotId: string) => defaultCountOpenWorkItems(dotId, deps.rootDir));
  return count(charter.dot_id) + parked;
}

/**
 * The charter bounds, phrased for the wake prompt, so the dot proposes inside
 * them instead of spending proposals on refusals. Same sources as enforcement.
 */
export function dotBoundsPromptLines(charter: DotCharter, deps: DotDispatchDeps = {}): string[] {
  const shapes = effectiveDotWorkShapes(charter, deps);
  const pipelines = charter.authority.allowed_pipelines ?? [];
  const cap =
    charter.authority.max_concurrent_delegations ?? DEFAULT_DOT_MAX_CONCURRENT_DELEGATIONS;
  const free = Math.max(0, cap - openDelegations(charter, deps));
  const partners = (deps.listCharters?.() ?? defaultListCharters(deps))
    .filter(
      (other) =>
        other.dot_id !== charter.dot_id &&
        other.status === 'active' &&
        sameDotHandoffScope(charter, other) &&
        (other.team?.accepts_handoffs_from ?? []).includes(charter.dot_id)
    )
    .map((other) => other.dot_id);
  return [
    shapes.length
      ? `Allowed work_shape values: ${shapes.join(', ')}. Any other shape is refused.`
      : 'No work_shape is available to you now; propose nothing and report status instead.',
    ...(shapes.includes('pipeline')
      ? [
          pipelines.length
            ? `Allowed pipeline_ref values: ${pipelines.join(', ')}.`
            : 'No pipeline is allowed by your charter; do not propose pipeline work.',
        ]
      : []),
    ...(!shapes.includes('task_session') &&
    (charter.authority.allowed_work_shapes ?? []).includes('task_session')
      ? [DOT_TASK_SESSION_UNAVAILABLE_GUIDANCE]
      : []),
    free > 0
      ? `Delegation slots free: ${free} of ${cap}. Propose at most ${free}, most important first; extra proposals are refused.`
      : `Delegation slots free: 0 of ${cap} (open work or decisions waiting on the operator). Propose nothing new; report status instead.`,
    partners.length
      ? `Dots that accept your handoffs (handoff_to): ${partners.join(', ')}.`
      : 'No dot accepts handoffs from you; do not use handoff_to.',
  ];
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

export type DotBoundsVerdict = { ok: true } | { ok: false; reason: string };

/**
 * A handoff never crosses a tenant: same tenant_slug (both untenanted counts
 * as the same), and the same organization_id when both declare one.
 */
function sameDotHandoffScope(from: DotCharter, to: DotCharter): boolean {
  if ((from.scope.tenant_slug ?? '') !== (to.scope.tenant_slug ?? '')) return false;
  const fromOrg = from.scope.organization_id;
  const toOrg = to.scope.organization_id;
  return !fromOrg || !toOrg || fromOrg === toOrg;
}

/** What the proposal may be at all: action, shape, handoff target. Re-checked at settlement. */
function checkDotProposalScope(
  charter: DotCharter,
  proposal: Pick<
    DotProposal,
    'action_id' | 'work_shape' | 'handoff_to' | 'pipeline_ref' | 'front_desk_execution'
  >,
  deps: DotDispatchDeps
): DotBoundsVerdict {
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
  const cap =
    charter.authority.max_concurrent_delegations ?? DEFAULT_DOT_MAX_CONCURRENT_DELEGATIONS;
  const open = openDelegations(charter, deps);
  if (open >= cap) {
    return {
      ok: false,
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
    charter.decisions?.default_decision,
    proposal.requested_decision,
    ...DOT_FLOOR_CONTRIBUTORS.map((contributor) => {
      try {
        return contributor.floor(charter, proposal, ctx);
      } catch (error) {
        extensionFailure('floor contributor', contributor.id, charter.dot_id, error);
        return undefined;
      }
    })
  );
  const learned = learnedDotDecisionFloor(charter.dot_id, {
    rootDir: deps.rootDir,
    now: deps.now,
  });
  let floor = strictest(hardFloor, learned);
  const runGate = (requested: DotDecisionLevel | undefined) =>
    (deps.gate ?? evaluateAutonomousOpsAction)({
      actionId: proposal.action_id,
      ...(charter.scope.tenant_slug ? { tenantSlug: charter.scope.tenant_slug } : {}),
      ...(proposal.changed_paths ? { changedPaths: proposal.changed_paths } : {}),
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
  logger.warn(
    `[dot-dispatch] ${kind} '${id}' failed for ${dotId} — ${error instanceof Error ? error.message : String(error)} | next: governance continues without it | evidence: libs/core/dot/dot-extension-bootstrap.ts`
  );
}

/** First override that turns the proposal into a record-only shadow row; throwing ones are skipped. */
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
 * A throwing check is skipped, never a refusal.
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
      continue;
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

function workItemDescription(charter: DotCharter, record: DotActionRecord): string {
  return [
    record.objective,
    record.rationale ? `\nRationale: ${record.rationale}` : '',
    `\nProposed by ${dotActorId(charter.dot_id)} (${charter.title}) under role ${charter.authority.authority_role}; requested shape: ${record.work_shape}; decision: ${record.decision ?? 'n/a'}.`,
    dotGoalRefLabel(charter) ? `Contributes to: ${dotGoalRefLabel(charter)}` : '',
  ]
    .filter(Boolean)
    .join('\n');
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
  if (!binding) return executeDotActionUnlocked(charter, record, deps, options);
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
    item =
      existing ??
      (
        deps.createWorkItem ??
        (record.front_desk_execution ? createWorkItemIfAbsent : createWorkItem)
      )({
        ...(record.front_desk_execution
          ? {
              itemId: record.front_desk_execution.work_item_id,
              sourceRef: record.front_desk_execution.request_digest,
            }
          : {}),
        title: record.title,
        description: workItemDescription(charter, record),
        status: 'ready',
        priority: record.priority ?? 'normal',
        ...(charter.scope.project_id ? { projectId: charter.scope.project_id } : {}),
        context: {
          ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
          ...(charter.scope.organization_id
            ? { organization_id: charter.scope.organization_id }
            : {}),
          ...(charter.scope.project_id ? { project_id: charter.scope.project_id } : {}),
          work_shape: 'routine_operation',
        },
        metadata: {
          ...(record.front_desk_execution
            ? { front_desk_execution: record.front_desk_execution }
            : {}),
          dot_id: charter.dot_id,
          actor_id: actor,
          action_ref: record.action_ref,
          action_id: record.action_id,
          requested_work_shape: record.work_shape,
          authority_role: charter.authority.authority_role,
          ...(record.decision ? { decision: record.decision } : {}),
          ...(record.request_id ? { approval_request_id: record.request_id } : {}),
          ...(record.handoff_to ? { handoff_to: record.handoff_to } : {}),
          ...(dotGoalRefLabel(charter) ? { goal_ref: dotGoalRefLabel(charter) } : {}),
          ...(record.pipeline_ref ? { pipeline_ref: record.pipeline_ref } : {}),
          ...(record.expected_effect ? { expected_effect: record.expected_effect } : {}),
          ...(record.target ? { target: record.target } : {}),
          ...(record.intent ? { intent: record.intent } : {}),
        },
      });
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
      { ...record, status: 'refused', reason, at: nowOf(deps).toISOString() },
      deps
    );
  }
  if (record.handoff_to) {
    try {
      (deps.appendInbox ?? ((input) => void appendDotInboxEntry(input, { rootDir: deps.rootDir })))(
        {
          dot_id: record.handoff_to,
          channel: 'inbox',
          text: `Handoff from ${actor}: ${record.title}`,
          payload: {
            handoff_from: charter.dot_id,
            work_item_id: item.item_id,
            action_ref: record.action_ref,
          },
          source: 'dot-handoff',
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
  if (!proposals.some((proposal) => proposal.front_desk_execution))
    return dispatchDotProposalsUnlocked(charter, proposals, deps);
  const result: DotDispatchResult = { records: [], duplicates: [] };
  for (const proposal of proposals) {
    const dispatch = () => {
      if (proposal.front_desk_execution) {
        const admission = inspectPendingRequest(proposal.front_desk_execution, charter, deps);
        if (!admission.ok) return;
        const prior = currentDotActions(charter.dot_id, deps).find(
          (row) => row.action_ref === 'frontdesk-' + proposal.front_desk_execution!.work_item_id
        );
        if (prior) {
          result.duplicates.push(prior.action_ref);
          return;
        }
      }
      const next = dispatchDotProposalsUnlocked(charter, [proposal], deps);
      result.records.push(...next.records);
      result.duplicates.push(...next.duplicates);
    };
    if (proposal.front_desk_execution)
      withFrontDeskDispatchLock(proposal.front_desk_execution, dispatch);
    else dispatch();
  }
  return result;
}

function dispatchDotProposalsUnlocked(
  charter: DotCharter,
  proposals: readonly DotProposal[],
  deps: DotDispatchDeps = {}
): DotDispatchResult {
  const records: DotActionRecord[] = [];
  const duplicates: string[] = [];
  const actor = dotActorId(charter.dot_id);
  for (const [index, proposal] of proposals.entries()) {
    const now = nowOf(deps);
    const hash = dotProposalHash(charter.dot_id, proposal);
    // A declined proposal is not re-asked inside the window (no card spam);
    // an override-shadowed one is not re-recorded (no digest spam).
    const recent = currentDotActions(charter.dot_id, deps).find(
      (row) =>
        row.proposal_hash === hash &&
        (row.status === 'parked' ||
          row.status === 'dispatched' ||
          row.status === 'declined' ||
          (row.status === 'shadow' && Boolean(row.disposition_by))) &&
        now.getTime() - Date.parse(row.at) < DOT_PROPOSAL_DEDUPE_WINDOW_MS
    );
    if (recent) {
      duplicates.push(recent.action_ref);
      continue;
    }
    const base: DotActionRecord = {
      action_ref: proposal.front_desk_execution
        ? `frontdesk-${proposal.front_desk_execution.work_item_id}`
        : `dact-${charter.dot_id}-${hash}-${now.getTime().toString(36)}-${index}`,
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
      ...(proposal.expected_effect ? { expected_effect: proposal.expected_effect } : {}),
      ...(proposal.target ? { target: proposal.target } : {}),
      ...(proposal.intent ? { intent: proposal.intent } : {}),
      at: now.toISOString(),
    };
    try {
      const admissionScope = proposal.front_desk_execution
        ? frontDeskDispatchScope(proposal.front_desk_execution, charter)
        : undefined;
      // Server-bound requests never lower the human-approval floor.
      if (proposal.front_desk_execution && proposal.requested_decision !== 'approve')
        throw new Error('front-desk request requires explicit human approval');
      const bounds = checkDotProposalBounds(charter, proposal, deps);
      if (bounds.ok === false) {
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
      let accountability: RouteAutonomousDecisionInput['accountability'];
      if (
        isFrontDeskDiagnosticDot(charter) ||
        hasFirstJobDiagnosticProvenance(proposal.front_desk_execution)
      ) {
        if (!proposal.front_desk_execution) throw new Error('diagnostic request binding required');
        const effect = firstJobApprovalEffect(charter, proposal.front_desk_execution);
        accountability = { payloadHash: effect.payloadHash, effectBinding: effect.effectBinding };
      }
      const question = `${charter.title} proposes: ${proposal.title} — ${proposal.objective.slice(0, 500)}`;
      const routed = (deps.route ?? routeAutonomousDecision)({
        role: GOVERNED_STORE_ROLE,
        gate,
        title: `[${actor}] ${proposal.title}`,
        question: escalation ? `${question}\n\n${escalation.card_context}` : question,
        recommendation: proposal.rationale ?? proposal.objective,
        requestedBy: actor,
        source: { agentId: actor },
        ...(accountability ? { accountability } : {}),
        dedupeKey: `${charter.dot_id}-${hash}`,
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
        now: now.getTime(),
      });
      const decided: DotActionRecord = {
        ...base,
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
      records.push(appendActionRecord({ ...base, reason }, deps));
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
      let approval: ApprovalRequestRecord | null;
      try {
        approval = load(row.request_id);
      } catch (error) {
        logger.warn(
          `[dot-dispatch] approval ${row.request_id} unreadable for ${charter.dot_id} — ${error instanceof Error ? error.message : error} | next: retried on the next sweep`
        );
        return;
      }
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
      const outcome = approval ? SETTLED_STATUS[approval.status] : 'cancelled';
      if (!outcome) return;
      const decidedBy = approval?.decidedBy;
      if (!hasDotFeedbackFor(charter.dot_id, row.action_ref, feedbackDeps)) {
        recordDotFeedback(
          {
            dot_id: charter.dot_id,
            action_id: row.action_id,
            action_ref: row.action_ref,
            outcome,
            title: row.title,
            ...(decidedBy ? { decided_by: decidedBy } : {}),
            ...(approval?.decidedByType ? { decided_by_type: approval.decidedByType } : {}),
            ...(approval?.changeRequest
              ? { note: JSON.stringify(approval.changeRequest).slice(0, 300) }
              : {}),
          },
          feedbackDeps
        );
      }
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
      settled.push(
        executeDotAction(
          charter,
          { ...row, reason: `approved by ${decidedBy ?? 'operator'}` },
          deps,
          {
            reuseExisting: true,
          }
        )
      );
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
    result.settled = settleDotParkedActions(charter, deps);
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

export const DOT_DIGEST_LEDGER_PATH = 'active/shared/runtime/dot-digest-ledger.jsonl';

interface DotDigestRow {
  dot_id: string;
  key: string;
  sent_at: string;
  delivered: boolean;
}

/** Charter wall-clock zone: quiet hours first, then its first cron trigger. */
export function dotCharterTimezone(charter: DotCharter): string | undefined {
  if (charter.notification.quiet_hours?.timezone) return charter.notification.quiet_hours.timezone;
  for (const trigger of charter.attention.triggers) {
    if (trigger.kind === 'cron' && trigger.timezone) return trigger.timezone;
  }
  return undefined;
}

function digestMinuteKey(charter: DotCharter, now: Date): string {
  const p = getZonedDateParts(now, dotCharterTimezone(charter));
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${charter.notification.digest_cron}@${p.year}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}`;
}

/** Compose the digest text: actions since the last digest, open decisions, signals. */
export function composeDotDigest(
  charter: DotCharter,
  since: Date | undefined,
  deps: DotDispatchDeps = {}
): string {
  const actions = currentDotActions(charter.dot_id, deps);
  const recent = actions.filter((row) => !since || Date.parse(row.at) >= since.getTime());
  const count = (status: DotActionStatus) => recent.filter((row) => row.status === status).length;
  const waiting = actions.filter((row) => row.status === 'parked');
  const signals = dotSignalStatusLines(charter, { rootDir: deps.rootDir });
  return [
    `${charter.title}${dotGoalRefLabel(charter) ? ` — ${dotGoalRefLabel(charter)}` : ''}`,
    `Since last digest: dispatched ${count('dispatched')}, waiting ${waiting.length}, declined ${count('declined')}, refused ${count('refused')}.`,
    ...recent
      .filter((row) => row.status === 'dispatched')
      .slice(-5)
      .map((row) => `- done: ${row.title}${row.work_item_id ? ` (${row.work_item_id})` : ''}`),
    ...waiting.slice(0, 5).map((row) => `- waiting on you: ${row.title}`),
    ...(signals.length ? ['Signals:', ...signals] : []),
    ...dotDigestSectionLines(charter, since, deps),
  ].join('\n');
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

/** Send the charter digest when `digest_cron` is due (once per cron minute). */
export function maybeSendDotDigest(charter: DotCharter, deps: DotDispatchDeps = {}): boolean {
  const cron = charter.notification.digest_cron;
  if (!cron) return false;
  const now = nowOf(deps);
  if (!matchesCron(cron, now, dotCharterTimezone(charter))) return false;
  const file = path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_DIGEST_LEDGER_PATH);
  const rows = readJsonLines<DotDigestRow>(file, { onMalformed: 'skip' }).filter(
    (row) => row?.dot_id === charter.dot_id
  );
  const key = digestMinuteKey(charter, now);
  if (rows.some((row) => row.key === key)) return false;
  const last = rows.filter((row) => row.delivered).at(-1);
  const text = composeDotDigest(charter, last ? new Date(last.sent_at) : undefined, deps);
  const delivered = notifyDot(
    charter,
    'decision_digest',
    { title: 'digest', body: text, correlation_id: `dot-digest:${charter.dot_id}:${key}` },
    deps
  );
  safeMkdir(path.dirname(file), { recursive: true });
  appendJsonLine(file, {
    dot_id: charter.dot_id,
    key,
    sent_at: now.toISOString(),
    delivered,
  } satisfies DotDigestRow);
  return delivered;
}
