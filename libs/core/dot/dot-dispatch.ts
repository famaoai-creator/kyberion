/**
 * Dot dispatch — the single enforcement point between a dot's proposals and
 * the world.
 *
 * Every proposal goes through, in order:
 *   1. charter bounds — `authority.allowed_work_shapes`, handoff acceptance,
 *      `authority.max_concurrent_delegations` (open WorkItems + parked actions);
 *   2. decision — autonomous-ops-gate, raised (never lowered) to the strictest
 *      of the charter `decisions.default_decision`, the floor learned from
 *      operator rejections, and the dot's own requested decision;
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
import { createHash } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
import { appendJsonLine, readJsonLines } from '../foundation/json.js';
import { matchesCron, getZonedDateParts } from '../pipeline/cron-utils.js';
import {
  evaluateAutonomousOpsAction,
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
import { createWorkItem, listWorkItems } from '../workforce/work-coordination.js';
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
import { dotGoalRefLabel, listDotCharters, type DotCharter } from './dot-charter.js';
import { resolveTenant } from '../organization/tenant-registry.js';
import {
  DOT_ACTION_IDS,
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

const logger = createLogger('dot-dispatch');

export const DOT_ACTION_LEDGER_PATH = 'active/shared/runtime/dot-action-ledger.jsonl';
/** Shapes a charter may dispatch when it declares no `allowed_work_shapes`. */
export const DEFAULT_DOT_WORK_SHAPES: readonly DotWorkShape[] = ['task_session', 'direct_reply'];
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

export type DotActionStatus = 'dispatched' | 'parked' | 'refused' | 'shadow' | 'declined';

export interface DotActionRecord {
  action_ref: string;
  dot_id: string;
  actor_id: string;
  action_id: string;
  title: string;
  objective: string;
  work_shape: DotWorkShape;
  status: DotActionStatus;
  proposal_hash: string;
  decision?: DotDecisionLevel;
  gate_decision?: DotDecisionLevel;
  floor?: DotDecisionLevel;
  handoff_to?: string;
  priority?: DotProposal['priority'];
  rationale?: string;
  request_id?: string;
  work_item_id?: string;
  reason?: string;
  at: string;
}

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
  assertTenant?: (tenantSlug: string) => void;
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
}

export function dotActorId(dotId: string): string {
  return `dot:${dotId}`;
}

function nowOf(deps: DotDispatchDeps): Date {
  return deps.now?.() ?? new Date();
}

function ledgerFile(deps: DotDispatchDeps): string {
  return path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_ACTION_LEDGER_PATH);
}

export function readDotActionLedger(deps: DotDispatchDeps = {}): DotActionRecord[] {
  return readJsonLines<DotActionRecord>(ledgerFile(deps), { onMalformed: 'skip' }).filter(
    (row) => typeof row?.action_ref === 'string' && typeof row.dot_id === 'string'
  );
}

function appendActionRecord(record: DotActionRecord, deps: DotDispatchDeps): DotActionRecord {
  const filePath = ledgerFile(deps);
  safeMkdir(path.dirname(filePath), { recursive: true });
  appendJsonLine(filePath, record);
  return record;
}

/** Latest state per action_ref for one dot (insertion order preserved). */
export function currentDotActions(dotId: string, deps: DotDispatchDeps = {}): DotActionRecord[] {
  const latest = new Map<string, DotActionRecord>();
  for (const row of readDotActionLedger(deps)) {
    if (row.dot_id === dotId) latest.set(row.action_ref, row);
  }
  return [...latest.values()];
}

export function dotProposalHash(dotId: string, proposal: DotProposal): string {
  return createHash('sha256')
    .update(
      JSON.stringify([
        dotId,
        proposal.action_id,
        proposal.title,
        proposal.objective,
        proposal.handoff_to ?? '',
      ])
    )
    .digest('hex')
    .slice(0, 16);
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
  const shapes = charter.authority.allowed_work_shapes ?? DEFAULT_DOT_WORK_SHAPES;
  const cap =
    charter.authority.max_concurrent_delegations ?? DEFAULT_DOT_MAX_CONCURRENT_DELEGATIONS;
  const free = Math.max(0, cap - openDelegations(charter, deps));
  const partners = (deps.listCharters?.() ?? defaultListCharters(deps))
    .filter(
      (other) =>
        other.dot_id !== charter.dot_id &&
        other.status === 'active' &&
        (other.team?.accepts_handoffs_from ?? []).includes(charter.dot_id)
    )
    .map((other) => other.dot_id);
  return [
    `Allowed work_shape values: ${shapes.join(', ')}. Any other shape is refused.`,
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

/** What the proposal may be at all: action, shape, handoff target. Re-checked at settlement. */
function checkDotProposalScope(
  charter: DotCharter,
  proposal: Pick<DotProposal, 'action_id' | 'work_shape' | 'handoff_to'>,
  deps: DotDispatchDeps
): DotBoundsVerdict {
  if (!DOT_ACTION_IDS.includes(proposal.action_id)) {
    return { ok: false, reason: `action '${proposal.action_id}' is not a dot action` };
  }
  const shapes = charter.authority.allowed_work_shapes ?? DEFAULT_DOT_WORK_SHAPES;
  if (!shapes.includes(proposal.work_shape)) {
    return {
      ok: false,
      reason: `work_shape '${proposal.work_shape}' is outside allowed_work_shapes (${shapes.join(', ')})`,
    };
  }
  const tenantSlug = charter.scope.tenant_slug;
  if (tenantSlug) {
    try {
      (deps.assertTenant ?? ((slug) => void resolveTenant(slug, { rootDir: deps.rootDir })))(
        tenantSlug
      );
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
): { gate: AutonomousOpsGateResult; floor?: DotDecisionLevel } {
  const floor = strictest(
    charter.decisions?.default_decision,
    learnedDotDecisionFloor(charter.dot_id, { rootDir: deps.rootDir, now: deps.now }),
    proposal.requested_decision
  );
  const gate = (deps.gate ?? evaluateAutonomousOpsAction)({
    actionId: proposal.action_id,
    ...(charter.scope.tenant_slug ? { tenantSlug: charter.scope.tenant_slug } : {}),
    ...(proposal.changed_paths ? { changedPaths: proposal.changed_paths } : {}),
    ...(floor ? { requestedDecision: floor } : {}),
  });
  // The charter may lengthen a veto window, never shorten the policy's.
  const charterVeto = charter.decisions?.veto_window_minutes;
  const vetoWindowMinutes =
    charterVeto !== undefined
      ? Math.max(charterVeto, gate.vetoWindowMinutes ?? 0)
      : gate.vetoWindowMinutes;
  return {
    gate: {
      ...gate,
      ...(vetoWindowMinutes !== undefined ? { vetoWindowMinutes } : {}),
    },
    ...(floor ? { floor } : {}),
  };
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

/** Perform an allowed action: WorkItem (+ inbox wake for a handoff), audit, ledger. */
function executeDotAction(
  charter: DotCharter,
  record: DotActionRecord,
  deps: DotDispatchDeps,
  options: { reuseExisting?: boolean } = {}
): DotActionRecord {
  const actor = dotActorId(charter.dot_id);
  let item: WorkItem;
  try {
    const find =
      deps.findWorkItemByActionRef ??
      (deps.createWorkItem
        ? undefined
        : (ref: string) => defaultFindWorkItemByActionRef(ref, deps.rootDir));
    const existing = options.reuseExisting ? find?.(record.action_ref) : undefined;
    item =
      existing ??
      (deps.createWorkItem ?? createWorkItem)({
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
  const records: DotActionRecord[] = [];
  const duplicates: string[] = [];
  const actor = dotActorId(charter.dot_id);
  for (const [index, proposal] of proposals.entries()) {
    const now = nowOf(deps);
    const hash = dotProposalHash(charter.dot_id, proposal);
    // A declined proposal is not re-asked inside the window (no card spam).
    const recent = currentDotActions(charter.dot_id, deps).find(
      (row) =>
        row.proposal_hash === hash &&
        (row.status === 'parked' || row.status === 'dispatched' || row.status === 'declined') &&
        now.getTime() - Date.parse(row.at) < DOT_PROPOSAL_DEDUPE_WINDOW_MS
    );
    if (recent) {
      duplicates.push(recent.action_ref);
      continue;
    }
    const base: DotActionRecord = {
      action_ref: `dact-${charter.dot_id}-${hash}-${now.getTime().toString(36)}-${index}`,
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
      at: now.toISOString(),
    };
    try {
      const bounds = checkDotProposalBounds(charter, proposal, deps);
      if (bounds.ok === false) {
        recordAudit(charter, proposal.action_id, 'denied', { reason: bounds.reason }, deps);
        records.push(appendActionRecord({ ...base, reason: bounds.reason }, deps));
        continue;
      }
      const { gate, floor } = evaluateDotProposalGate(charter, proposal, deps);
      const routed = (deps.route ?? routeAutonomousDecision)({
        role: GOVERNED_STORE_ROLE,
        gate,
        title: `[${actor}] ${proposal.title}`,
        question: `${charter.title} proposes: ${proposal.title} — ${proposal.objective.slice(0, 500)}`,
        recommendation: proposal.rationale ?? proposal.objective,
        requestedBy: actor,
        source: { agentId: actor },
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
        now: now.getTime(),
      });
      const decided: DotActionRecord = {
        ...base,
        decision: gate.decision,
        gate_decision: gate.decision,
        ...(floor ? { floor } : {}),
        ...(routed.requestId ? { request_id: routed.requestId } : {}),
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
  deps: DotDispatchDeps
): ApprovalRequestRecord | null {
  try {
    return (
      deps.expireApproval ??
      ((record: ApprovalRequestRecord) =>
        expireApprovalRequest(GOVERNED_STORE_ROLE, {
          channel: record.channel,
          storageChannel: AUTONOMY_APPROVAL_CHANNEL,
          requestId: record.id,
          reason: 'dot_decision_expired',
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
  for (const row of currentDotActions(charter.dot_id, deps)) {
    if (row.status !== 'parked' || !row.request_id) continue;
    let approval: ApprovalRequestRecord | null;
    try {
      approval = load(row.request_id);
    } catch (error) {
      logger.warn(
        `[dot-dispatch] approval ${row.request_id} unreadable for ${charter.dot_id} — ${error instanceof Error ? error.message : error} | next: retried on the next sweep`
      );
      continue;
    }
    if (approval?.status === 'pending' && dotDecisionExpired(charter, row, approval, deps)) {
      approval = expirePendingDecision(approval, deps);
    }
    const outcome = approval ? SETTLED_STATUS[approval.status] : 'cancelled';
    if (!outcome) continue;
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
      continue;
    }
    const scope = checkDotProposalScope(charter, row, deps);
    if (scope.ok === false) {
      settled.push(
        declineParked(charter, row, `approved but no longer in scope: ${scope.reason}`, deps)
      );
      continue;
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
  ].join('\n');
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
