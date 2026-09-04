import { isRecord } from '@agent/core/foundation/primitives';
import type {
  OperatorHomeSummary,
  OperatorHomeMissionItem,
  OperatorHomeCostSummary,
} from '@agent/core/operator-home-summary';

export type ClientOperatorHomeSummary = OperatorHomeSummary & {
  /** Kept optional for older projections; the current API derives active missions only. */
  plannedMissions?: OperatorHomeMissionItem[];
};

const DANGEROUS_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const TIERS = new Set(['personal', 'confidential', 'public']);
const HOME_STATUSES = new Set(['ready', 'attention', 'blocked']);
const MISSION_STATUSES = new Set([
  'planned',
  'active',
  'validating',
  'distilling',
  'completed',
  'paused',
  'failed',
  'archived',
]);
const APPROVAL_KINDS = new Set(['channel-approval', 'secret_mutation', 'mission_gate']);
const APPROVAL_STATUSES = new Set([
  'pending',
  'approved',
  'rejected',
  'expired',
  'cancelled',
  'applied',
  'failed',
]);
const INBOX_STATUSES = new Set(['unread', 'read', 'accepted', 'rejected', 'changes_requested']);
const NEXT_ACTION_TYPES = new Set([
  'run_command',
  'repair_surface',
  'bootstrap_environment',
  'request_clarification',
  'inspect_artifact',
  'retry_pipeline',
  'open_docs',
]);

function hasSafeTree(value: unknown): boolean {
  if (Array.isArray(value)) return value.every(hasSafeTree);
  if (!isRecord(value)) return true;
  return Object.entries(value).every(
    ([key, nested]) => !DANGEROUS_KEYS.has(key) && hasSafeTree(nested)
  );
}

function isString(value: unknown): value is string {
  return typeof value === 'string';
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || isString(value);
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every(isString);
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0;
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isMissionItem(value: unknown): value is OperatorHomeMissionItem {
  if (!isRecord(value) || !hasSafeTree(value)) return false;
  return (
    isString(value.missionId) &&
    Boolean(value.missionId.trim()) &&
    isString(value.status) &&
    MISSION_STATUSES.has(value.status) &&
    isString(value.tier) &&
    TIERS.has(value.tier) &&
    isStringArray(value.artifactKinds) &&
    isNonNegativeInteger(value.artifactCount) &&
    [
      'missionType',
      'tenantSlug',
      'tenantId',
      'organizationId',
      'persona',
      'projectId',
      'trackId',
      'trackName',
      'updatedAt',
      'goalSummary',
      'successCondition',
    ].every((field) => isOptionalString(value[field]))
  );
}

function isCostSummary(value: unknown): value is OperatorHomeCostSummary {
  if (!isRecord(value) || !hasSafeTree(value)) return false;
  if (
    !isFiniteNonNegative(value.totalTokens) ||
    !isFiniteNonNegative(value.totalUsd) ||
    !isNonNegativeInteger(value.entryCount) ||
    !isNonNegativeInteger(value.missionCount) ||
    !isOptionalString(value.since) ||
    (value.budgetUsd !== undefined && !isFiniteNonNegative(value.budgetUsd)) ||
    (value.remainingUsd !== undefined &&
      value.remainingUsd !== null &&
      !isFiniteNonNegative(value.remainingUsd)) ||
    typeof value.overBudget !== 'boolean' ||
    !Array.isArray(value.missionBreakdown)
  ) {
    return false;
  }
  return value.missionBreakdown.every(
    (entry) =>
      isRecord(entry) &&
      isString(entry.missionId) &&
      Boolean(entry.missionId.trim()) &&
      isFiniteNonNegative(entry.tokens) &&
      isFiniteNonNegative(entry.usd) &&
      isNonNegativeInteger(entry.entryCount) &&
      isOptionalString(entry.lastSeen)
  );
}

function isApprovalItem(value: unknown): boolean {
  if (!isRecord(value) || !hasSafeTree(value)) return false;
  return (
    isString(value.id) &&
    isString(value.title) &&
    isString(value.summary) &&
    isString(value.kind) &&
    APPROVAL_KINDS.has(value.kind) &&
    isString(value.storageChannel) &&
    isString(value.channel) &&
    isString(value.threadTs) &&
    isString(value.correlationId) &&
    isString(value.requestedBy) &&
    isString(value.requestedAt) &&
    isString(value.status) &&
    APPROVAL_STATUSES.has(value.status)
  );
}

function isInboxEntry(value: unknown): boolean {
  if (!isRecord(value) || !hasSafeTree(value)) return false;
  return (
    isString(value.entry_id) &&
    isString(value.title) &&
    isStringArray(value.artifact_paths) &&
    isString(value.summary) &&
    isString(value.created_at) &&
    isString(value.updated_at) &&
    isString(value.status) &&
    INBOX_STATUSES.has(value.status) &&
    isOptionalString(value.mission_id) &&
    isOptionalString(value.tenant_slug) &&
    isOptionalString(value.kind)
  );
}

function isNextAction(value: unknown): boolean {
  if (!isRecord(value) || !hasSafeTree(value)) return false;
  return (
    isString(value.title) &&
    isString(value.reason) &&
    isString(value.next_action_type) &&
    NEXT_ACTION_TYPES.has(value.next_action_type) &&
    isOptionalString(value.next_action_key) &&
    isOptionalString(value.suggested_command) &&
    isOptionalString(value.suggested_pipeline_path) &&
    isOptionalString(value.suggested_followup_request)
  );
}

function isWorkforceSummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasSafeTree(value) &&
    isNonNegativeInteger(value.activeAssignments) &&
    isNonNegativeInteger(value.humanResources) &&
    isNonNegativeInteger(value.agentResources) &&
    isNonNegativeInteger(value.serviceResources) &&
    isStringArray(value.accountableOwners)
  );
}

function isNhiLedgerSummary(value: unknown): boolean {
  if (
    !isRecord(value) ||
    !hasSafeTree(value) ||
    !isNonNegativeInteger(value.total) ||
    !isNonNegativeInteger(value.active) ||
    !isNonNegativeInteger(value.suspended) ||
    !isNonNegativeInteger(value.retired) ||
    !isNonNegativeInteger(value.orphanCount) ||
    !Array.isArray(value.orphans)
  ) {
    return false;
  }
  return value.orphans.every(
    (orphan) =>
      isRecord(orphan) &&
      isString(orphan.nhiId) &&
      isString(orphan.accountableHumanId) &&
      isString(orphan.reason) &&
      isString(orphan.missingScopeId)
  );
}

function isActionQueue(value: unknown): boolean {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      isRecord(item) &&
      hasSafeTree(item) &&
      isString(item.actionId) &&
      (item.kind === 'mission' || item.kind === 'approval' || item.kind === 'deliverable') &&
      isString(item.title) &&
      isOptionalString(item.missionId) &&
      isString(item.status) &&
      isFiniteNonNegative(item.priority) &&
      isString(item.nextAction)
  );
}

function isQualitySummary(value: unknown): boolean {
  return (
    isRecord(value) &&
    hasSafeTree(value) &&
    isString(value.reportId) &&
    isString(value.projectId) &&
    isString(value.subjectRef) &&
    (value.recommendation === 'go' ||
      value.recommendation === 'conditional_go' ||
      value.recommendation === 'no_go' ||
      value.recommendation === 'insufficient_evidence') &&
    (value.humanDecision === 'pending' ||
      value.humanDecision === 'approved' ||
      value.humanDecision === 'rejected') &&
    isString(value.accountableHumanId) &&
    isString(value.generatedAt) &&
    isStringArray(value.residualRisks) &&
    isStringArray(value.evidenceRefs)
  );
}

export function parseOperatorHomeSummary(value: unknown): ClientOperatorHomeSummary | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  const counts = value.counts;
  if (
    !isRecord(counts) ||
    ![
      'activeMissions',
      'recentlyActiveMissions',
      'blockedMissions',
      'pendingApprovals',
      'clarificationQuestions',
      'unreadInbox',
      'totalInbox',
      'pendingQualityDecisions',
    ].every((field) => isNonNegativeInteger(counts[field]))
  ) {
    return undefined;
  }

  if (
    !isString(value.generatedAt) ||
    !isString(value.status) ||
    !HOME_STATUSES.has(value.status) ||
    !isString(value.statusLabel) ||
    !isString(value.statusDetail) ||
    !Array.isArray(value.activeMissions) ||
    !value.activeMissions.every(isMissionItem) ||
    !Array.isArray(value.pendingApprovals) ||
    !value.pendingApprovals.every(isApprovalItem) ||
    !Array.isArray(value.inboxEntries) ||
    !value.inboxEntries.every(isInboxEntry) ||
    !isCostSummary(value.costSummary) ||
    !isNextAction(value.nextAction) ||
    (value.workforceSummary !== undefined && !isWorkforceSummary(value.workforceSummary)) ||
    (value.nhiLedger !== undefined && !isNhiLedgerSummary(value.nhiLedger)) ||
    (value.actionQueue !== undefined && !isActionQueue(value.actionQueue)) ||
    (value.qualitySummary !== undefined && !isQualitySummary(value.qualitySummary)) ||
    (value.plannedMissions !== undefined &&
      (!Array.isArray(value.plannedMissions) || !value.plannedMissions.every(isMissionItem)))
  ) {
    return undefined;
  }
  return value as ClientOperatorHomeSummary;
}

export function parseOperatorHomeResponse(
  value: unknown
): { summary: ClientOperatorHomeSummary } | undefined {
  if (!isRecord(value) || !hasSafeTree(value)) return undefined;
  const summary = parseOperatorHomeSummary(value.summary);
  return summary ? { summary } : undefined;
}
