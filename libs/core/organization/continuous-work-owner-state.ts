/** Mission-owner execution surface. The dot worker executor cannot run these bindings. */
import { currentExecutionScope } from '../foundation/execution-scope.js';
import { assertContinuousDevelopmentApprovalPresentation } from './continuous-development-consent.js';
import type { DotCharter } from '../dot/dot-charter.js';
import { assertDotAccountabilityCharter } from '../dot/dot-authority.js';
import { readDotActionLedgerStrict } from '../dot/dot-action-ledger.js';
import { dotWorkItemInput } from '../dot/dot-work-item.js';
import { dotAdmissionScopeHash } from '../dot/dot-admission-identity.js';
import { recoveryEvidenceHash } from '../surface/front-desk-recovery-receipt.js';
import { loadApprovalRequest, isApprovalRequestExpired } from '../governance/approval-store.js';
import { AUTONOMY_APPROVAL_CHANNEL } from '../governance/approval-decision-card.js';
import { approvalUsabilityRefusal } from '../governance/approval-linked-usability.js';
import {
  claimWorkItem,
  renewWorkItemLease,
  releaseWorkItem,
  updateWorkItem,
} from '../workforce/work-coordination.js';
import type { WorkItem } from '../workforce/work-coordination-types.js';
import { assertScopedCadenceExecution } from './organization-cadence.js';
import {
  parseContinuousWorkPlan,
  type ContinuousWorkPlan,
  type ContinuousWorkMission,
} from './continuous-work-plan.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeReadFileSnapshot } from '../secure-io.js';
import { writeJson } from '../foundation/json.js';
import { parseSafeJsonInput } from '../foundation/safe-json.js';
import * as path from 'node:path';
import { assertSafeRepositoryPath } from '../secure-io.js';
import { storagePartitionSegments } from '../storage-layout.js';

export interface ContinuousWorkOwnerScope {
  tier: 'personal' | 'confidential' | 'public';
  tenant_slug?: string;
  organization_id: string;
}
export interface EnsureContinuousProjectInput {
  assertCurrent: () => void;
  project_id: string;
  name: string;
  summary: string;
  objective_ids?: string[];
  scope: ContinuousWorkOwnerScope;
  operation_key: string;
  signal?: AbortSignal;
}
export interface EnsureContinuousMissionInput {
  assertCurrent: () => void;
  mission_id: string;
  project_id: string;
  key: string;
  title: string;
  goal: string;
  success_condition: string;
  mission_type?: string;
  development?: ContinuousWorkMission['development'];
  prerequisites: string[];
  scope: ContinuousWorkOwnerScope;
  operation_key: string;
  signal?: AbortSignal;
}
export interface AdvanceContinuousMissionInput {
  assertCurrent: () => void;
  mission_id: string;
  project_id: string;
  scope: ContinuousWorkOwnerScope;
  operation_key: string;
  creation_key: string;
  development?: ContinuousWorkMission['development'];
  signal?: AbortSignal;
}
export interface ContinuousMissionProgress {
  status: 'pending_approval' | 'running' | 'completed' | 'blocked' | 'failed';
  evidence_refs: string[];
  approval_request_id?: string;
  reason?: string;
}
export interface ContinuousWorkOwnerPorts {
  ensureProject(input: EnsureContinuousProjectInput): Promise<{ project_id: string }>;
  ensureMission(input: EnsureContinuousMissionInput): Promise<{ mission_id: string }>;
  /** Must observe terminal states first, validate approval, and never retry uncertain dispatch. */
  advanceMission(input: AdvanceContinuousMissionInput): Promise<ContinuousMissionProgress>;
}
export interface OwnerMission extends ContinuousMissionProgress {
  mission_id: string;
  created: boolean;
}
export interface OwnerState {
  version: 1;
  identity: string;
  project_id: string;
  project_created: boolean;
  missions: Record<string, OwnerMission>;
  step: number;
  intent?: string;
  error?: string;
  completed?: boolean;
}
export interface ContinuousWorkOwnerRow {
  work_item_id: string;
  project_id?: string;
  state_path?: string;
  status: 'pending_approval' | 'running' | 'completed' | 'blocked' | 'failed' | 'skipped';
  missions?: Record<string, OwnerMission>;
  reason?: string;
}
export interface ContinuousWorkOwnerOptions {
  rootDir?: string;
  now?: Date;
  limit?: number;
  leaseTtlMs?: number;
}
export interface ContinuousWorkOwnerDeps {
  currentCharter?: (charter: DotCharter, rootDir: string) => DotCharter | undefined;
  authorize?: (charter: DotCharter) => void;
  authorizeItem?: (charter: DotCharter, item: WorkItem, rootDir: string) => void;
  halted?: () => boolean;
  throttled?: (charter: DotCharter) => boolean;
  list?: () => WorkItem[];
  get?: (id: string) => WorkItem | null;
  claim?: typeof claimWorkItem;
  renew?: typeof renewWorkItemLease;
  release?: typeof releaseWorkItem;
  update?: typeof updateWorkItem;
  read?: (file: string) => unknown;
  write?: (file: string, state: unknown) => void;
  lock?: <T>(key: string, fn: () => Promise<T>) => Promise<T>;
}
export const digest = (value: unknown): string => recoveryEvidenceHash(value);
export function continuousWorkTargetIds(
  actionRef: string,
  plan: ContinuousWorkPlan,
  existingProjectId?: string
): { project_id: string; mission_ids: Record<string, string> } {
  const prefix = digest(actionRef).slice(0, 20).toUpperCase();
  const project_id = plan.kind === 'project' ? `PRJ-CONT-${prefix}` : existingProjectId;
  if (!project_id)
    throw new Error(
      'Managed mission work requires charter.scope.project_id; use project kind to create a project'
    );
  return {
    project_id,
    mission_ids: Object.fromEntries(
      plan.missions.map((m) => [
        m.key,
        `MSN-CONT-${digest([actionRef, m.key]).slice(0, 28).toUpperCase()}`,
      ])
    ),
  };
}
export function authorize(charter: DotCharter): void {
  const role = assertScopedCadenceExecution('continuous managed owner', {
    tier: charter.scope.tier,
    tenantSlug: charter.scope.tenant_slug,
    organizationId: charter.scope.organization_id,
  });
  if (
    role !== charter.authority.authority_role ||
    currentExecutionScope()?.organizationId !== charter.scope.organization_id
  )
    throw new Error('Continuous owner requires exact charter role and organization scope');
}
export function authorizeItem(
  charter: DotCharter,
  item: WorkItem,
  rootDir: string,
  currentApproval = true
): void {
  assertDotAccountabilityCharter(charter, { rootDir });
  const record = readDotActionLedgerStrict({ rootDir, dotId: charter.dot_id })
    .filter((row) => row.action_ref === item.metadata?.action_ref)
    .at(-1);
  if (
    !record ||
    record.dot_id !== charter.dot_id ||
    record.status !== 'dispatched' ||
    record.work_item_id !== item.item_id ||
    !record.request_id
  )
    throw new Error('Managed owner requires retained admitted action evidence');
  if (
    !record.admission ||
    record.admission.scope_hash !== dotAdmissionScopeHash(charter) ||
    record.admission.authority_role !== charter.authority.authority_role ||
    record.admission.semantic_hash !== recoveryEvidenceHash(record.admission.proposal) ||
    digest(record.admission.proposal.continuous_work) !== digest(record.continuous_work)
  )
    throw new Error('Managed admission binding changed');
  const expected = dotWorkItemInput(charter, record, rootDir);
  if (
    digest(expected.metadata) !== digest(item.metadata) ||
    digest(expected.context) !== digest(item.context)
  )
    throw new Error('Managed WorkItem differs from its immutable admitted envelope');
  if (!currentApproval) return;
  const approval = loadApprovalRequest(AUTONOMY_APPROVAL_CHANNEL, record.request_id);
  if (
    !approval ||
    approval.status !== 'approved' ||
    approval.decidedByType !== 'human' ||
    !approval.decidedBy ||
    approval.accountability?.payloadHash !== record.admission.semantic_hash ||
    approval.accountability?.effectBinding !== `continuous-work:${record.action_ref}` ||
    isApprovalRequestExpired(approval) ||
    approvalUsabilityRefusal(approval, 'dot_dispatch')
  )
    throw new Error('Managed owner requires a current human approval');
  assertContinuousDevelopmentApprovalPresentation(charter, record, approval, rootDir);
}
export function continuousWorkCheckpoint(
  charter: DotCharter,
  actionRef: string,
  plan: ContinuousWorkPlan,
  rootDir: string
): { ids: ReturnType<typeof continuousWorkTargetIds>; identity: string; statePath: string } {
  const scope = {
    tier: charter.scope.tier,
    ...(charter.scope.tenant_slug ? { tenant_slug: charter.scope.tenant_slug } : {}),
    organization_id: charter.scope.organization_id,
  };
  if (!scope.organization_id) throw new Error('Continuous owner requires organization scope');
  const ids = continuousWorkTargetIds(actionRef, plan, charter.scope.project_id);
  const identity = digest([charter.dot_id, scope, actionRef, plan, ids]);
  const statePath = assertSafeRepositoryPath(
    path.join(
      rootDir,
      'active/shared/runtime',
      ...storagePartitionSegments({ kind: 'tier', tier: scope.tier, tenant: scope.tenant_slug }),
      'continuous-work',
      digest([scope.organization_id, charter.dot_id]),
      `${digest(actionRef)}.json`
    ),
    { rootDir, allowMissingLeaf: true }
  );
  return { ids, identity, statePath };
}
export function validateState(
  value: unknown,
  identity: string,
  ids: ReturnType<typeof continuousWorkTargetIds>
): OwnerState {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid owner checkpoint');
  const state = value as OwnerState;
  if (
    state.version !== 1 ||
    state.identity !== identity ||
    state.project_id !== ids.project_id ||
    typeof state.project_created !== 'boolean' ||
    !Number.isSafeInteger(state.step) ||
    state.step < 0 ||
    (state.completed !== undefined && typeof state.completed !== 'boolean') ||
    ['intent', 'error'].some((key) => {
      const value = state[key as 'intent' | 'error'];
      return value !== undefined && (typeof value !== 'string' || value.length > 8000);
    }) ||
    !state.missions ||
    Object.keys(state.missions).length !== Object.keys(ids.mission_ids).length
  )
    throw new Error('Owner checkpoint identity mismatch');
  for (const [key, missionId] of Object.entries(ids.mission_ids)) {
    const m = state.missions[key];
    if (
      !m ||
      m.mission_id !== missionId ||
      typeof m.created !== 'boolean' ||
      !['pending_approval', 'running', 'completed', 'blocked', 'failed'].includes(m.status) ||
      !Array.isArray(m.evidence_refs) ||
      m.evidence_refs.some((ref) => typeof ref !== 'string') ||
      (m.approval_request_id !== undefined && typeof m.approval_request_id !== 'string') ||
      (m.reason !== undefined && typeof m.reason !== 'string')
    )
      throw new Error('Invalid owner mission checkpoint');
  }
  if (
    state.completed &&
    Object.values(state.missions).some((mission) => mission.status !== 'completed')
  )
    throw new Error('Invalid completed owner checkpoint');
  return state;
}
/**
 * Governed reconcile for an owner checkpoint that stopped mid-effect.
 *
 * `state.intent`/`state.error` mean "an effect may have partially applied;
 * verify before resuming" — previously there was no path to clear it, so one
 * interrupted step (observed: the 100 MB items.jsonl read cap during
 * `advance-mission`) parked the managed work item forever. The verifier runs
 * the caller-supplied effect check (mission exists, marker/brief pins match),
 * records the human's verification on the checkpoint, and only then clears
 * the uncertain markers so the next owner sweep can resume.
 */
export function resolveUncertainContinuousOwnerState(
  charter: DotCharter,
  item: WorkItem,
  input: {
    verifiedBy: string;
    note: string;
    approvalRequestId?: string;
  },
  options: { rootDir?: string } = {},
  deps: Pick<ContinuousWorkOwnerDeps, 'authorize' | 'authorizeItem' | 'write'> & {
    verifyEffects?: (state: OwnerState) => void;
    now?: () => string;
  } = {}
): { resolved: boolean; state_path: string; reason?: string } {
  (deps.authorize ?? authorize)(charter);
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  (deps.authorizeItem ?? ((c, i, r) => authorizeItem(c, i, r, false)))(charter, item, rootDir);
  const plan = parseContinuousWorkPlan(item.metadata?.continuous_work);
  const actionRef = item.metadata?.action_ref;
  if (typeof actionRef !== 'string' || !actionRef)
    throw new Error('Managed reconcile requires admitted action identity');
  const { ids, identity, statePath } = continuousWorkCheckpoint(charter, actionRef, plan, rootDir);
  const stored = safeExistsSync(statePath)
    ? parseSafeJsonInput(
        safeReadFileSnapshot(statePath, 4 * 1024 * 1024).toString('utf8'),
        'continuous work owner checkpoint'
      )
    : undefined;
  if (stored === undefined)
    return { resolved: false, state_path: statePath, reason: 'no checkpoint' };
  const state = validateState(stored, identity, ids);
  if (!state.intent && !state.error)
    return { resolved: false, state_path: statePath, reason: 'checkpoint is not uncertain' };
  (deps.verifyEffects ?? (() => {}))(state);
  const cleared = { ...state };
  delete cleared.intent;
  delete cleared.error;
  (deps.write ?? ((file: string, value: unknown) => writeJson(file, value)))(statePath, {
    ...cleared,
    reconciled: {
      at: (deps.now ?? (() => new Date().toISOString()))(),
      verified_by: input.verifiedBy,
      note: input.note,
      ...(input.approvalRequestId ? { approval_request_id: input.approvalRequestId } : {}),
      cleared_intent: state.intent,
      cleared_error: state.error,
    },
  });
  return { resolved: true, state_path: statePath };
}

/** Read retained progress without claiming work or interpreting an expired approval as execution authority. */
export function readContinuousWorkOwnerProgress(
  charter: DotCharter,
  item: WorkItem,
  options: { rootDir?: string } = {},
  deps: Pick<ContinuousWorkOwnerDeps, 'authorize' | 'authorizeItem' | 'read'> = {}
): ContinuousWorkOwnerRow | undefined {
  (deps.authorize ?? authorize)(charter);
  const rootDir = options.rootDir ?? pathResolver.rootDir();
  if (
    item.metadata?.dot_id !== charter.dot_id ||
    (item.context?.tenant_slug ?? '') !== (charter.scope.tenant_slug ?? '') ||
    item.context?.organization_id !== charter.scope.organization_id ||
    (item.context?.project_id ?? '') !== (charter.scope.project_id ?? '')
  )
    throw new Error('Managed progress requires exact item scope');
  if (deps.authorizeItem) deps.authorizeItem(charter, item, rootDir);
  else authorizeItem(charter, item, rootDir, false);
  const plan = parseContinuousWorkPlan(item.metadata?.continuous_work);
  const actionRef = item.metadata?.action_ref;
  if (typeof actionRef !== 'string' || !actionRef)
    throw new Error('Managed progress requires admitted action identity');
  const { ids, identity, statePath } = continuousWorkCheckpoint(charter, actionRef, plan, rootDir);
  const stored = deps.read
    ? deps.read(statePath)
    : safeExistsSync(statePath)
      ? parseSafeJsonInput(
          safeReadFileSnapshot(statePath, 4 * 1024 * 1024).toString('utf8'),
          'continuous work owner checkpoint'
        )
      : undefined;
  if (stored === undefined) return undefined;
  const state = validateState(stored, identity, ids);
  const missions = Object.values(state.missions);
  const status =
    state.error || state.intent
      ? 'blocked'
      : state.completed
        ? 'completed'
        : missions.some((m) => m.status === 'failed')
          ? 'failed'
          : missions.some((m) => m.status === 'blocked')
            ? 'blocked'
            : missions.some((m) => m.status === 'running')
              ? 'running'
              : 'pending_approval';
  return {
    work_item_id: item.item_id,
    project_id: state.project_id,
    state_path: statePath,
    status,
    missions: state.missions,
    ...(state.error || state.intent
      ? { reason: state.error ?? `Uncertain operation: ${state.intent}` }
      : {}),
  };
}
