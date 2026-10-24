/**
 * CD-10: bolt reviews at mission boundaries (plan
 * docs/developer/improvement-plans-2026-10/CUSTOMER_DECISION_HEARING_PLAN_2026-10-24.ja.md
 * "CD-10 の実装設計").
 *
 *   - start:  the next bolt passes the `bolt-after:<MISSION>` milestone of the
 *             case's open bolt-review agendas for other, completed missions
 *             (their override window closes; the start never waits for the
 *             customer). Narrow milestone store role, short case-lock wait;
 *             a failure warns and never blocks the start;
 *   - finish: the operator's next step — draft the bolt review — when the
 *             mission has a decision case (a command, no data);
 *   - routing (after `customer-decision respond` / `status`): a
 *             `request_changes` answer files one backlog WorkItem, a `reject`
 *             answer notifies the operator (notification + inbox entry).
 *
 * Tier boundary: the WorkItem store and the inbox are not tenant-partitioned,
 * so the WorkItem, the inbox entry and the notification carry ids only; the
 * customer's comment stays in the confidential case.
 */
import { withExecutionContext } from '../authority.js';
import { logger } from '../core.js';
import {
  CUSTOMER_DECISION_MILESTONE_STORE_ROLE,
  customerDecisionMilestoneCapability,
  type CustomerDecisionMilestoneAccess,
} from '../foundation/customer-decision-milestone-capability.js';
import { DELIVERABLE_INBOX_WRITER_ROLE } from '../foundation/deliverable-inbox-writer-capability.js';
import { runInResourceAccessScope } from '../foundation/resource-access-scope.js';
import { nowIso } from '../foundation/time.js';
import { pathResolver } from '../path-resolver.js';
import { ledgerDir } from '../decision-ledger/ledger.js';
import {
  boltMilestone,
  boltRejectInboxEntryId,
  boltReworkWorkItemId,
} from '../customer-decision/bolt-review.js';
import type { DecisionAgenda } from '../customer-decision/model.js';
import {
  listAgendaIds,
  markAgendaMilestonePassed,
  readAgenda,
  withCustomerDecisionCaseLock,
} from '../customer-decision/store.js';
import { addInboxEntry } from '../deliverable-inbox.js';
import { notifyOperatorWithReceiptSync } from '../surface/operator-notifications.js';
import { t } from '../t.js';
import { WorkCoordinationError } from '../workforce/work-coordination-error.js';
import { createWorkItemIfAbsent, getWorkItem } from '../workforce/work-coordination.js';
import {
  loadDecisionCaseMissionState,
  resolveMissionDecisionCase,
  SWEEP_LOCK_TIMEOUT_MS,
  type MissionDecisionCase,
  type MissionDecisionLockOptions,
} from './mission-decision-lock.js';
import { SATISFIED_PREREQUISITE_STATUSES } from './mission-state.js';

/** Reads exactly `knowledge/personal/tenants/<tenant>.json` (shared core role). */
const TENANT_REGISTRY_READER_ROLE = 'workspace_tenant_registry_reader';
/** Writes only the deliverable inbox and its lock (narrow shared core role). */
const INBOX_WRITER_ROLE = DELIVERABLE_INBOX_WRITER_ROLE;

function diagnosticCode(error: unknown): string {
  if (error instanceof WorkCoordinationError) return error.code;
  const message = error instanceof Error ? error.message : String(error);
  return /\[([A-Z0-9_]+)\]/u.exec(message)?.[1] ?? 'error';
}

/** Run `fn` as the narrow milestone store role inside its exact case capability. */
function asMilestoneStore<T>(
  decisionCase: MissionDecisionCase,
  access: CustomerDecisionMilestoneAccess,
  fn: () => T
): T {
  const caseDir = pathResolver.toRepoRelative(ledgerDir(decisionCase.location));
  return runInResourceAccessScope(
    customerDecisionMilestoneCapability(decisionCase.tenantSlug, caseDir, access),
    () =>
      withExecutionContext(
        CUSTOMER_DECISION_MILESTONE_STORE_ROLE,
        fn,
        undefined,
        decisionCase.tenantSlug
      )
  );
}

export interface BoltMilestoneResult {
  case_id: string;
  milestone: string;
  /** Agendas whose milestone this start passed (ids only). */
  passed_agenda_ids: string[];
}

/** Is this agenda an open review of another bolt that has completed? */
function awaitsNextBolt(
  agenda: DecisionAgenda,
  missionId: string,
  isCompleted: (missionId: string) => boolean
): boolean {
  const bolt = agenda.bolt_mission_id;
  if (!bolt || bolt === missionId) return false;
  if (agenda.status === 'closed' || agenda.status === 'withdrawn') return false;
  if ((agenda.milestones_passed ?? []).includes(boltMilestone(bolt))) return false;
  return isCompleted(bolt);
}

/**
 * Mission start: pass `bolt-after:<bolt>` on every open bolt-review agenda of
 * the mission's decision case whose bolt is a different, completed mission.
 * Null when the mission has no case (one existence check, no lock) or on
 * failure (logged; the start goes on). Never throws.
 */
export function passBoltReviewMilestones(
  missionId: string,
  options: MissionDecisionLockOptions = {}
): BoltMilestoneResult | null {
  const upper = missionId.toUpperCase();
  try {
    const decisionCase = resolveMissionDecisionCase(upper, options);
    if (!decisionCase) return null;
    const now = options.now ?? nowIso();
    // A finished bolt is archived by `finish`: read the archive too (bound to
    // the case's tenant), and accept the statuses that satisfy a prerequisite
    // (completed, archived).
    const load =
      options.loadMissionState ??
      ((id: string) => loadDecisionCaseMissionState(id, decisionCase.tenantSlug));
    const isCompleted = (id: string) =>
      SATISFIED_PREREQUISITE_STATUSES.has(load(id.toUpperCase())?.status ?? '');
    return withCustomerDecisionCaseLock(
      decisionCase.location,
      () => {
        const ids = asMilestoneStore(decisionCase, { read: ['agendas'] }, () =>
          listAgendaIds(decisionCase.location)
        );
        const passed: string[] = [];
        // One agenda that cannot be read or written never skips the others.
        for (const id of ids) {
          const file = `agendas/${id}.json`;
          try {
            const agenda = asMilestoneStore(decisionCase, { read: [file] }, () =>
              readAgenda(decisionCase.location, id)
            );
            if (!agenda || !awaitsNextBolt(agenda, upper, isCompleted)) continue;
            const milestone = boltMilestone(agenda.bolt_mission_id as string);
            const written = asMilestoneStore(decisionCase, { read: [], write: file }, () =>
              markAgendaMilestonePassed(decisionCase.location, id, milestone, now)
            );
            if (written) passed.push(id);
          } catch (error) {
            logger.warn(
              `bolt review milestone skipped for one agenda — ${diagnosticCode(error)} | the mission starts anyway; check the agenda with customer-decision status | mission=${upper} agenda=${id}`
            );
          }
        }
        return {
          case_id: decisionCase.caseId,
          milestone: boltMilestone(upper),
          passed_agenda_ids: passed,
        };
      },
      options.lockTimeoutMs ?? SWEEP_LOCK_TIMEOUT_MS
    );
  } catch (error) {
    logger.warn(
      `bolt review milestone skipped — ${diagnosticCode(error)} | the mission starts anyway; run customer-decision status on the case to see open bolt reviews | mission=${upper}`
    );
    return null;
  }
}

/**
 * Mission finish: the operator's next step when the mission has a decision
 * case — draft the bolt review (the operator picks what the customer sees).
 * Null without a case or when the case cannot be found (logged at debug).
 */
export function boltReviewNextStep(
  missionId: string,
  options: MissionDecisionLockOptions = {}
): string | null {
  const upper = missionId.toUpperCase();
  try {
    const decisionCase = resolveMissionDecisionCase(upper, options);
    if (!decisionCase) return null;
    return `pnpm kyberion customer-decision bolt-review --tenant ${decisionCase.tenantSlug} --case ${decisionCase.caseId} --mission ${upper} --customer <customer> --summary-file <path> [--attach <png|jpeg|webp>]... [--preview-url <https URL>]`;
  } catch (error) {
    logger.debug(`bolt review next step skipped — ${diagnosticCode(error)} | mission=${upper}`);
    return null;
  }
}

export interface BoltRoutingInput {
  tenantSlug: string;
  caseId: string;
  agendaId: string;
  entryId: string;
  /** The ledger decision id, or the change-request receipt id. */
  ref: string;
  /** The reviewed bolt. */
  missionId: string;
  projectId?: string;
}

/**
 * `request_changes` on a bolt review: file (or find) its backlog WorkItem.
 * Deterministic id from agenda × entry × ref, so a re-run finds the same item.
 * Ids only — the customer's comment stays in the case. Throws on store failure.
 */
export function fileBoltReviewWorkItem(
  input: BoltRoutingInput,
  options: Pick<MissionDecisionLockOptions, 'workItemRootDir'> = {}
): string {
  const itemId = boltReworkWorkItemId(input.agendaId, input.entryId, input.ref);
  const rootDir = options.workItemRootDir;
  const scope = rootDir ? { rootDir } : {};
  if (getWorkItem(itemId, scope)) return itemId;
  const params = {
    missionId: input.missionId,
    agendaId: input.agendaId,
    entryId: input.entryId,
    ref: input.ref,
    caseId: input.caseId,
  };
  const create = () =>
    createWorkItemIfAbsent({
      ...scope,
      itemId,
      title: t('customer_decision:bolt_review_work_item_title', params),
      description: t('customer_decision:bolt_review_work_item_description', params),
      status: 'backlog',
      priority: 'normal',
      source: 'local',
      sourceRef: `customer-decision:${input.caseId}:${input.agendaId}:${input.entryId}`,
      ...(input.projectId ? { projectId: input.projectId } : {}),
      context: {
        tenant_slug: input.tenantSlug,
        ...(input.projectId ? { project_id: input.projectId } : {}),
        mission_id: input.missionId,
        work_shape: 'solution_project',
      },
      metadata: {
        kind: 'customer_decision_bolt_changes',
        case_id: input.caseId,
        agenda_id: input.agendaId,
        entry_id: input.entryId,
        ref: input.ref,
        source_mission_id: input.missionId,
      },
    });
  try {
    // Same identity rule as the CD-09 rework item (mission-decision-lock.ts).
    withExecutionContext(TENANT_REGISTRY_READER_ROLE, create, 'worker', input.tenantSlug);
  } catch (error) {
    if (
      error instanceof WorkCoordinationError &&
      error.code === 'idempotency_conflict' &&
      getWorkItem(itemId, scope)
    )
      return itemId;
    throw error;
  }
  return itemId;
}

export interface BoltRejectNotice {
  inbox_entry_id: string;
  /** The push's receipt status (`suppressed` in tests and when muted). */
  push_status: string;
}

/**
 * `reject` on a bolt review: an inbox entry and an operator notification
 * (event `question`: the operator must follow up), both keyed by agenda ×
 * entry × ref so a re-run adds nothing. Ids only. Throws when the inbox entry
 * cannot be added (the caller retries on the next respond / status).
 */
export function notifyBoltReviewRejected(input: BoltRoutingInput): BoltRejectNotice {
  const entryId = boltRejectInboxEntryId(input.agendaId, input.entryId, input.ref);
  const params = {
    missionId: input.missionId,
    agendaId: input.agendaId,
    entryId: input.entryId,
    ref: input.ref,
    caseId: input.caseId,
  };
  const title = t('customer_decision:bolt_review_rejected_title', params);
  const body = t('customer_decision:bolt_review_rejected_body', params);
  // The inbox's own narrow writer: the facade (customer-triggered respond) has
  // no inbox grant, and this role can write nothing else.
  withExecutionContext(INBOX_WRITER_ROLE, () =>
    addInboxEntry({
      entryId,
      ifAbsent: true,
      missionId: input.missionId,
      title,
      summary: body,
      tenantSlug: input.tenantSlug,
      kind: 'customer_decision_bolt_rejected',
    })
  );
  const receipt = notifyOperatorWithReceiptSync(
    'question',
    {
      title,
      body,
      link_hint: `pnpm kyberion customer-decision status --tenant ${input.tenantSlug} --case ${input.caseId} --agenda ${input.agendaId}`,
      correlation_id: entryId,
    },
    { deduplicationKey: entryId }
  );
  return { inbox_entry_id: entryId, push_status: receipt.status };
}
