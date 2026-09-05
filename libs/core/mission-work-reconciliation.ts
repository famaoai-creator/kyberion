/**
 * Adopt work completed outside dispatch-workitems without weakening the mission exit gate.
 */

import * as nodePath from 'node:path';
import { appendMissionExecutionLedgerEntry } from './mission-team-binding.js';
import {
  evaluateArtifactReviews,
  inferArtifactReviewKind,
  loadArtifactReviewReceipt,
  receiptToArtifactReviewDecision,
  type ArtifactReviewReceipt,
} from './artifact-review.js';
import { auditChain } from './audit-chain.js';
import { getRegisteredEnvText } from './foundation/env.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import { detectTier } from './tier-guard.js';
import * as pathResolver from './path-resolver.js';
import { findMissionPath } from './path-resolver.js';
import { getWorkItem, updateWorkItem } from './work-coordination.js';
import { logger } from './core.js';
import {
  computeApprovalPayloadHash,
  createApprovalRequest,
  isApprovalRequestExpired,
  listApprovalRequests,
  loadApprovalRequest,
  validateHumanFinalDecision,
  type ApprovalRequestRecord,
} from './approval-store.js';
import {
  resolveArtifactReviewerProfile,
  type ArtifactReviewerProfile,
} from './mission-review-gates.js';
import { hasAuthority, resolveIdentityContext } from './authority.js';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import { sha256 } from './marketing-workload.js';
import { withLock } from './src/lock-utils.js';
import { loadState, saveState } from './mission-state.js';
import { readCanonicalWorkGraphTasks } from './work-graph-projection.js';
import { writeDispatchArtifact } from './mission-dispatch-lifecycle.js';

const TERMINAL_TASK_STATUSES = new Set(['done', 'completed', 'accepted', 'reviewed']);
const ADOPTABLE_TASK_STATUSES = new Set([
  'planned',
  'backlog',
  'ready',
  'in_progress',
  'blocked',
  'rework',
  'review',
]);
const TIER_WEIGHT = { public: 1, confidential: 3, personal: 4 } as const;
export const MISSION_RECONCILIATION_APPROVAL_CHANNEL = 'mission-reconciliation';

export interface MissionWorkReconciliationEvidence {
  path: string;
  sha256: string;
  kind: 'artifact' | 'test_report' | 'review' | 'trace' | 'receipt';
}

export interface MissionWorkReconciliationTask {
  task_id: string;
  evidence: MissionWorkReconciliationEvidence[];
  criteria: Array<{ criterion: string; evidence_refs: string[] }>;
  verification: {
    command: string;
    status: 'passed';
    exit_code: 0;
    evidence_refs: string[];
  };
}

export interface MissionWorkReconciliationManifest {
  kind: 'mission-work-reconciliation';
  version: '1.0.0';
  mission_id: string;
  source: {
    repository: string;
    branch: string;
    commit: string;
  };
  adopted_by: string;
  reason: string;
  tasks: MissionWorkReconciliationTask[];
}

export interface MissionWorkReconciliationResult {
  status: 'dry_run_ready' | 'applied';
  mission_id: string;
  manifest_path: string;
  manifest_sha256: string;
  source_commit: string;
  reconciled_task_ids: string[];
  already_reconciled_task_ids: string[];
  auto_completed_repair_task_ids: string[];
  work_item_ids_updated: string[];
  approval_request_id?: string;
  receipt_path?: string;
}

export interface MissionWorkReconciliationScaffold {
  kind: 'mission-work-reconciliation-scaffold';
  version: '1.0.0';
  mission_id: string;
  generated_at: string;
  source: {
    repository: string;
    branch: string;
    commit: string;
  };
  adopted_by: string;
  reason: string;
  tasks: Array<{
    task_id: string;
    description?: string;
    acceptance_criteria: string[];
    evidence: string[];
    verification_command: string;
  }>;
  next_steps: string[];
}

interface PlannedTask extends Record<string, unknown> {
  task_id?: string;
  status?: string;
  description?: string;
  deliverable?: string;
  acceptance_criteria?: string[];
  dependencies?: string[];
  review_target?: string;
  risk?: string;
  assigned_to?: { role?: string; agent_id?: string };
  artifact_review_profile?: ArtifactReviewerProfile & {
    artifact_path?: string;
    artifact_sha256?: string;
    implementer_agent_ids: string[];
  };
  artifact_review_receipt?: string;
  ticket_dispatch?: { work_item_id?: string };
  work_item_id?: string;
  reconciliation?: Record<string, unknown>;
}

interface ReconciledArtifactReview {
  profile: NonNullable<PlannedTask['artifact_review_profile']>;
  receipt: ArtifactReviewReceipt;
}

const MISSION_RECONCILIATION_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-work-reconciliation.schema.json'
);

function assertMissionControllerAuthority(): void {
  const identity = resolveIdentityContext();
  if (identity.role !== 'mission_controller' && !hasAuthority('SUDO')) {
    throw new Error('Mission controller authority is required to reconcile existing work.');
  }
}

function isInside(parent: string, candidate: string): boolean {
  const relative = nodePath.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !nodePath.isAbsolute(relative));
}

function resolveInsideRoot(
  rawPath: string,
  label: string,
  options: { allowMissingLeaf?: boolean; allowRoot?: boolean } = {}
): string {
  const root = nodePath.resolve(pathResolver.rootDir());
  const resolved = nodePath.resolve(root, rawPath);
  if (!isInside(root, resolved)) {
    throw new Error(`${label} must remain inside the Kyberion repository: ${rawPath}`);
  }
  if (resolved === root) {
    if (options.allowRoot) return resolved;
    throw new Error(`${label} must identify a repository resource below the repository root.`);
  }
  return assertSafeRepositoryPath(resolved, { allowMissingLeaf: options.allowMissingLeaf });
}

function reconciliationEffectBinding(missionId: string): string {
  return `mission-work-reconciliation:${missionId.toUpperCase()}`;
}

function reconciliationApprovalPayload(
  missionId: string,
  manifestHash: string,
  sourceCommit: string
): Record<string, string> {
  return {
    mission_id: missionId.toUpperCase(),
    manifest_sha256: manifestHash,
    source_commit: sourceCommit,
    effect: reconciliationEffectBinding(missionId),
  };
}

function assertReconciliationApproval(
  approvalRequestId: string,
  missionId: string,
  manifestHash: string,
  sourceCommit: string
): ApprovalRequestRecord {
  const approval = loadApprovalRequest(MISSION_RECONCILIATION_APPROVAL_CHANNEL, approvalRequestId);
  const humanApproval = approval?.workflow?.approvals?.find(
    (entry) =>
      entry.status === 'approved' && entry.decidedByType === 'human' && entry.authenticated === true
  );
  if (!approval || approval.kind !== 'mission_gate' || approval.status !== 'approved') {
    throw new Error(
      `[POLICY_VIOLATION] reconcile-work requires an approved mission_gate request: ${approvalRequestId}`
    );
  }
  if (isApprovalRequestExpired(approval)) {
    throw new Error(`[POLICY_VIOLATION] reconciliation approval has expired: ${approval.id}`);
  }
  if (approval.source?.missionId?.toUpperCase() !== missionId.toUpperCase()) {
    throw new Error('[POLICY_VIOLATION] reconciliation approval is bound to a different mission');
  }
  const effectBinding = reconciliationEffectBinding(missionId);
  if (approval.accountability?.effectBinding !== effectBinding) {
    throw new Error('[POLICY_VIOLATION] reconciliation approval is bound to a different effect');
  }
  const payloadHash = computeApprovalPayloadHash(
    reconciliationApprovalPayload(missionId, manifestHash, sourceCommit)
  );
  if (approval.accountability?.payloadHash !== payloadHash) {
    throw new Error(
      '[POLICY_VIOLATION] reconciliation approval is bound to a different manifest or source commit'
    );
  }
  if (!humanApproval) {
    throw new Error('[POLICY_VIOLATION] reconcile-work requires an authenticated human approval');
  }
  validateHumanFinalDecision({
    accountability: approval.accountability,
    decidedByType: humanApproval.decidedByType,
    authenticated: humanApproval.authenticated,
    authMethod: humanApproval.authMethod,
    payloadHash: humanApproval.payloadHash,
    effectBinding: humanApproval.effectBinding,
  });
  return approval;
}

function loadManifest(filePath: string, label: string): MissionWorkReconciliationManifest {
  if (!safeExistsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  return defineCatalog<MissionWorkReconciliationManifest>({
    id: 'mission-work-reconciliation',
    path: filePath,
    schema: MISSION_RECONCILIATION_SCHEMA_PATH,
  }).load();
}

/** Open the human approval request required before reconciliation can mutate a mission. */
export function createMissionWorkReconciliationApprovalRequest(input: {
  missionId: string;
  manifestPath: string;
  requestedBy?: string;
}): ApprovalRequestRecord {
  assertMissionControllerAuthority();
  const missionId = input.missionId.toUpperCase();
  if (!findMissionPath(missionId)) throw new Error(`Mission ${missionId} not found`);
  const manifestPath = resolveInsideRoot(input.manifestPath, 'manifest');
  const manifestRaw = safeReadFile(manifestPath) as Buffer;
  const manifest = loadManifest(manifestPath, 'manifest');
  if (manifest.mission_id.toUpperCase() !== missionId) {
    throw new Error(
      `Manifest mission_id ${manifest.mission_id} does not match requested mission ${missionId}`
    );
  }

  const manifestHash = sha256(manifestRaw);
  const effectBinding = reconciliationEffectBinding(missionId);
  const payloadHash = computeApprovalPayloadHash(
    reconciliationApprovalPayload(missionId, manifestHash, manifest.source.commit)
  );
  const existing = listApprovalRequests({
    storageChannels: [MISSION_RECONCILIATION_APPROVAL_CHANNEL],
    kind: 'mission_gate',
    status: ['pending', 'approved'],
  }).find(
    (record) =>
      record.source?.missionId?.toUpperCase() === missionId &&
      record.accountability?.payloadHash === payloadHash &&
      !isApprovalRequestExpired(record)
  );
  if (existing) return existing;

  const requestedBy =
    input.requestedBy?.trim() ||
    getRegisteredEnvText('KYBERION_PERSONA') ||
    getRegisteredEnvText('USER') ||
    'mission_controller';
  return createApprovalRequest('mission_controller', {
    channel: MISSION_RECONCILIATION_APPROVAL_CHANNEL,
    storageChannel: MISSION_RECONCILIATION_APPROVAL_CHANNEL,
    threadTs: missionId,
    correlationId: effectBinding,
    requestedBy,
    kind: 'mission_gate',
    draft: {
      title: `Adopt externally completed work: ${missionId}`,
      summary: 'Approve adoption of hash-bound work completed outside dispatch-workitems.',
      details: `Manifest: ${pathResolver.toRepoRelative(manifestPath)}\nManifest SHA-256: ${manifestHash}\nSource commit: ${manifest.source.commit}\nTasks: ${manifest.tasks.map((task) => task.task_id).join(', ')}`,
      severity: 'high',
    },
    source: { missionId },
    requestedByContext: {
      surface: 'terminal',
      actorId: requestedBy,
      actorRole: 'mission-work-reconciliation',
      missionId,
    },
    justification: {
      reason:
        'Adopting external work mutates canonical mission task state and requires operator approval.',
      requestedEffects: [effectBinding],
    },
    risk: {
      level: 'high',
      restartScope: 'manual',
      requiresStrongAuth: true,
      policyId: 'PI-05',
    },
    workflow: {
      workflowId: `pi-05-reconciliation-${missionId}`,
      mode: 'all_required',
      requiredRoles: ['sovereign'],
      stages: [],
      approvals: [{ role: 'sovereign', status: 'pending' }],
    },
    accountability: {
      finalDecision: 'human_only',
      payloadHash,
      effectBinding,
    },
  });
}

function assertSourceCommit(manifest: MissionWorkReconciliationManifest): string {
  const repository = resolveInsideRoot(manifest.source.repository, 'source.repository', {
    allowRoot: true,
  });
  if (!safeExistsSync(nodePath.join(repository, '.git'))) {
    throw new Error(`source.repository is not a Git repository: ${manifest.source.repository}`);
  }
  safeExec('git', ['cat-file', '-e', `${manifest.source.commit}^{commit}`], { cwd: repository });
  safeExec('git', ['rev-parse', '--verify', `${manifest.source.branch}^{commit}`], {
    cwd: repository,
  });
  safeExec('git', ['merge-base', '--is-ancestor', manifest.source.commit, manifest.source.branch], {
    cwd: repository,
  });
  return repository;
}

function expectedTaskCriteria(task: PlannedTask): string[] {
  const declared = Array.isArray(task.acceptance_criteria)
    ? task.acceptance_criteria.map((entry) => String(entry).trim()).filter(Boolean)
    : [];
  if (declared.length > 0) return declared;
  const fallback = String(task.description || task.deliverable || '').trim();
  return fallback ? [fallback] : [];
}

function validateEvidence(input: {
  task: MissionWorkReconciliationTask;
  sourceRepository: string;
  sourceCommit: string;
  missionTier: 'personal' | 'confidential' | 'public';
}): void {
  const seen = new Set<string>();
  const evidenceKinds = new Map<string, MissionWorkReconciliationEvidence['kind']>();
  for (const evidence of input.task.evidence) {
    if (seen.has(evidence.path)) {
      throw new Error(`Task ${input.task.task_id} repeats evidence path ${evidence.path}`);
    }
    seen.add(evidence.path);
    evidenceKinds.set(evidence.path, evidence.kind);

    const evidencePath = nodePath.resolve(input.sourceRepository, evidence.path);
    if (!isInside(input.sourceRepository, evidencePath)) {
      throw new Error(
        `Task ${input.task.task_id} evidence escapes source.repository: ${evidence.path}`
      );
    }
    if (!safeExistsSync(evidencePath) || !safeStat(evidencePath).isFile()) {
      throw new Error(
        `Task ${input.task.task_id} evidence file not found: ${evidence.path}. ` +
          'Evidence paths must be relative to manifest.source.repository.'
      );
    }
    const repositoryRelativePath = nodePath
      .relative(input.sourceRepository, evidencePath)
      .split(nodePath.sep)
      .join('/');
    try {
      safeExec('git', ['cat-file', '-e', `${input.sourceCommit}:${repositoryRelativePath}`], {
        cwd: input.sourceRepository,
      });
      safeExec('git', ['diff', '--quiet', input.sourceCommit, '--', repositoryRelativePath], {
        cwd: input.sourceRepository,
      });
    } catch {
      throw new Error(
        `Task ${input.task.task_id} evidence is not commit-bound to ${input.sourceCommit}: ${evidence.path}`
      );
    }
    const evidenceTier = detectTier(evidencePath) as keyof typeof TIER_WEIGHT;
    if (TIER_WEIGHT[evidenceTier] > TIER_WEIGHT[input.missionTier]) {
      throw new Error(
        `Task ${input.task.task_id} evidence tier ${evidenceTier} exceeds mission tier ${input.missionTier}: ${evidence.path}`
      );
    }
    const actualHash = sha256(safeReadFile(evidencePath) as Buffer);
    if (actualHash.toLowerCase() !== evidence.sha256.toLowerCase()) {
      throw new Error(
        `Task ${input.task.task_id} evidence hash mismatch for ${evidence.path}: expected ${evidence.sha256}, got ${actualHash}`
      );
    }
  }

  for (const ref of input.task.verification.evidence_refs) {
    const kind = evidenceKinds.get(ref);
    if (!kind) {
      throw new Error(
        `Task ${input.task.task_id} verification references unknown evidence: ${ref}`
      );
    }
    if (kind === 'artifact') {
      throw new Error(
        `Task ${input.task.task_id} verification evidence must be a report, review, trace, or receipt: ${ref}`
      );
    }
  }
}

function validateTaskContract(input: {
  plannedTask: PlannedTask;
  manifestTask: MissionWorkReconciliationTask;
}): void {
  const expectedCriteria = expectedTaskCriteria(input.plannedTask);
  if (expectedCriteria.length === 0) {
    throw new Error(`Task ${input.manifestTask.task_id} has no verifiable acceptance criteria`);
  }
  const evidencePaths = new Set(input.manifestTask.evidence.map((entry) => entry.path));
  const mappedCriteria = new Map(
    input.manifestTask.criteria.map((entry) => [entry.criterion.trim(), entry.evidence_refs])
  );
  for (const criterion of expectedCriteria) {
    const refs = mappedCriteria.get(criterion);
    if (!refs?.length) {
      throw new Error(
        `Task ${input.manifestTask.task_id} does not map acceptance criterion to evidence: ${criterion}`
      );
    }
    for (const ref of refs) {
      if (!evidencePaths.has(ref)) {
        throw new Error(
          `Task ${input.manifestTask.task_id} criterion references unknown evidence: ${ref}`
        );
      }
    }
  }
  for (const criterion of mappedCriteria.keys()) {
    if (!expectedCriteria.includes(criterion)) {
      throw new Error(
        `Task ${input.manifestTask.task_id} maps an undeclared acceptance criterion: ${criterion}`
      );
    }
  }
}

function assertCommitBoundSourceFile(input: {
  taskId: string;
  label: string;
  sourceRepository: string;
  sourceCommit: string;
  absolutePath: string;
}): string {
  if (!isInside(input.sourceRepository, input.absolutePath)) {
    throw new Error(
      `Task ${input.taskId} ${input.label} escapes source.repository: ${input.absolutePath}`
    );
  }
  if (!safeExistsSync(input.absolutePath) || !safeStat(input.absolutePath).isFile()) {
    throw new Error(
      `Task ${input.taskId} ${input.label} file not found: ${input.absolutePath}. ` +
        'Artifact paths in review receipts must be relative to manifest.source.repository.'
    );
  }
  const repositoryRelativePath = nodePath
    .relative(input.sourceRepository, input.absolutePath)
    .split(nodePath.sep)
    .join('/');
  try {
    safeExec('git', ['cat-file', '-e', `${input.sourceCommit}:${repositoryRelativePath}`], {
      cwd: input.sourceRepository,
    });
    safeExec('git', ['diff', '--quiet', input.sourceCommit, '--', repositoryRelativePath], {
      cwd: input.sourceRepository,
    });
  } catch {
    throw new Error(
      `Task ${input.taskId} ${input.label} is not commit-bound to ${input.sourceCommit}: ${repositoryRelativePath}`
    );
  }
  return repositoryRelativePath;
}

function isCommitBoundSourceFile(input: {
  sourceRepository: string;
  sourceCommit: string;
  absolutePath: string;
}): boolean {
  if (!isInside(input.sourceRepository, input.absolutePath)) return false;
  if (!safeExistsSync(input.absolutePath) || !safeStat(input.absolutePath).isFile()) return false;
  const repositoryRelativePath = nodePath
    .relative(input.sourceRepository, input.absolutePath)
    .split(nodePath.sep)
    .join('/');
  try {
    safeExec('git', ['cat-file', '-e', `${input.sourceCommit}:${repositoryRelativePath}`], {
      cwd: input.sourceRepository,
    });
    safeExec('git', ['diff', '--quiet', input.sourceCommit, '--', repositoryRelativePath], {
      cwd: input.sourceRepository,
    });
    return true;
  } catch {
    return false;
  }
}

function validateReconciledArtifactReview(input: {
  missionId: string;
  missionType?: string;
  missionRiskProfile?: string;
  plannedTask: PlannedTask;
  manifestTask: MissionWorkReconciliationTask;
  sourceRepository: string;
  sourceCommit: string;
  taskById: Map<string, PlannedTask>;
}): ReconciledArtifactReview | null {
  const role = String(input.plannedTask.assigned_to?.role || '')
    .trim()
    .toLowerCase();
  const reviewTargetId = String(input.plannedTask.review_target || '').trim();
  const isReviewTask = role === 'reviewer' || role === 'qa' || Boolean(reviewTargetId);
  if (!isReviewTask) return null;
  if (!reviewTargetId) {
    throw new Error(`Task ${input.manifestTask.task_id} is a review task without review_target`);
  }
  const reviewEvidence = input.manifestTask.evidence.filter((entry) => entry.kind === 'review');
  if (reviewEvidence.length !== 1) {
    throw new Error(
      `Task ${input.manifestTask.task_id} must provide exactly one artifact review receipt as review evidence`
    );
  }
  const receiptPath = nodePath.resolve(input.sourceRepository, reviewEvidence[0].path);
  let receipt: ArtifactReviewReceipt;
  try {
    receipt = loadArtifactReviewReceipt(receiptPath);
  } catch (error) {
    throw new Error(
      `Task ${input.manifestTask.task_id} review evidence is not a valid artifact review receipt: ${error instanceof Error ? error.message : String(error)}`
    );
  }
  const identityReasons: string[] = [];
  if (receipt.mission_id.toUpperCase() !== input.missionId.toUpperCase()) {
    identityReasons.push(`receipt mission_id is ${receipt.mission_id}`);
  }
  if (receipt.review_task_id !== input.manifestTask.task_id) {
    identityReasons.push(`receipt review_task_id is ${receipt.review_task_id}`);
  }
  if (receipt.review_target_task_id !== reviewTargetId) {
    identityReasons.push(`receipt review_target_task_id is ${receipt.review_target_task_id}`);
  }
  const targetTask = input.taskById.get(reviewTargetId);
  if (!targetTask) identityReasons.push(`review_target ${reviewTargetId} does not exist`);
  if (identityReasons.length > 0) {
    throw new Error(
      `Task ${input.manifestTask.task_id} artifact review identity mismatch: ${identityReasons.join('; ')}`
    );
  }

  const artifactPath = nodePath.resolve(input.sourceRepository, receipt.artifact.path);
  assertCommitBoundSourceFile({
    taskId: input.manifestTask.task_id,
    label: 'reviewed artifact',
    sourceRepository: input.sourceRepository,
    sourceCommit: input.sourceCommit,
    absolutePath: artifactPath,
  });
  const normalizedArtifactPath = pathResolver.toRepoRelative(artifactPath);
  const currentHash = sha256(safeReadFile(artifactPath) as Buffer);
  const inferredArtifactKind = inferArtifactReviewKind(normalizedArtifactPath);
  const derivedProfile = resolveArtifactReviewerProfile({
    artifactKind: receipt.artifact.kind,
    missionClass: input.missionType,
    riskProfile: input.missionRiskProfile || input.plannedTask.risk || targetTask?.risk,
  });
  const declaredProfile = input.plannedTask.artifact_review_profile;
  const requiredReviewerRoles = Array.from(
    new Set([
      ...derivedProfile.required_reviewer_roles,
      ...(declaredProfile?.required_reviewer_roles || []),
    ])
  );
  const requiredReviewerCapabilities = Array.from(
    new Set([
      ...derivedProfile.required_reviewer_capabilities,
      ...(declaredProfile?.required_reviewer_capabilities || []),
    ])
  );
  const implementerAgentIds = Array.from(
    new Set(
      [...(declaredProfile?.implementer_agent_ids || []), targetTask?.assigned_to?.agent_id].filter(
        (entry): entry is string => Boolean(entry)
      )
    )
  );
  const requireIndependence =
    derivedProfile.independence_required || declaredProfile?.independence_required === true;
  const declaredProfileArtifactPath = declaredProfile?.artifact_path;
  const declaredProfileArtifactIsSourceBound = Boolean(
    declaredProfileArtifactPath &&
    isCommitBoundSourceFile({
      sourceRepository: input.sourceRepository,
      sourceCommit: input.sourceCommit,
      absolutePath: nodePath.isAbsolute(declaredProfileArtifactPath)
        ? declaredProfileArtifactPath
        : nodePath.resolve(input.sourceRepository, declaredProfileArtifactPath),
    })
  );
  const reasons: string[] = [];
  if (receipt.artifact.kind !== inferredArtifactKind) {
    reasons.push(
      `receipt artifact kind ${receipt.artifact.kind} does not match inferred kind ${inferredArtifactKind}`
    );
  }
  if (receipt.artifact.sha256 !== currentHash) {
    reasons.push(`review ${receipt.review_id} was invalidated by artifact change`);
  }
  if (
    declaredProfileArtifactIsSourceBound &&
    declaredProfileArtifactPath !== normalizedArtifactPath
  ) {
    reasons.push('reviewed artifact path does not match the declared review profile');
  }
  if (
    declaredProfileArtifactIsSourceBound &&
    declaredProfile?.artifact_sha256 &&
    declaredProfile.artifact_sha256 !== currentHash
  ) {
    reasons.push('reviewed artifact hash does not match the declared review profile');
  }
  if (requireIndependence && implementerAgentIds.length === 0) {
    reasons.push('implementer identity is missing, so reviewer independence cannot be verified');
  }
  for (const implementerAgentId of implementerAgentIds) {
    if (!receipt.reviewer.independent_from.includes(implementerAgentId)) {
      reasons.push(`review receipt is not bound as independent from ${implementerAgentId}`);
    }
  }
  const normalizedReceipt: ArtifactReviewReceipt = {
    ...receipt,
    artifact: { ...receipt.artifact, path: normalizedArtifactPath },
  };
  const evaluation = evaluateArtifactReviews({
    artifacts: [{ path: normalizedArtifactPath, sha256: currentHash }],
    reviews: [receiptToArtifactReviewDecision(normalizedReceipt)],
    requiredReviewerRoles,
    implementerAgentIds,
    requireIndependence,
  });
  reasons.push(...evaluation.reasons);
  if (reasons.length > 0) {
    throw new Error(
      `Task ${input.manifestTask.task_id} artifact review is not acceptable: ${Array.from(new Set(reasons)).join('; ')}`
    );
  }
  return {
    profile: {
      ...derivedProfile,
      required_reviewer_roles: requiredReviewerRoles,
      required_reviewer_capabilities: requiredReviewerCapabilities,
      independence_required: requireIndependence,
      artifact_path: normalizedArtifactPath,
      artifact_sha256: currentHash,
      implementer_agent_ids: implementerAgentIds,
    },
    receipt: normalizedReceipt,
  };
}

function assertDependenciesResolved(
  plannedTask: PlannedTask,
  taskById: Map<string, PlannedTask>,
  adoptedTaskIds: Set<string>
): void {
  for (const dependency of plannedTask.dependencies || []) {
    if (dependency === plannedTask.task_id) continue;
    const dependencyTask = taskById.get(dependency);
    if (!dependencyTask) {
      throw new Error(`Task ${plannedTask.task_id} has unknown dependency ${dependency}`);
    }
    const dependencyStatus = String(dependencyTask.status || 'planned').toLowerCase();
    if (!TERMINAL_TASK_STATUSES.has(dependencyStatus) && !adoptedTaskIds.has(dependency)) {
      throw new Error(`Task ${plannedTask.task_id} has unresolved dependency ${dependency}`);
    }
  }
}

function updateLinkedWorkItem(
  task: PlannedTask,
  receiptPath: string,
  manifestHash: string
): string | null {
  const itemId = task.ticket_dispatch?.work_item_id || task.work_item_id;
  if (!itemId) return null;
  const workItem = getWorkItem(itemId);
  if (!workItem || ['done', 'archived'].includes(workItem.status)) return null;
  updateWorkItem({
    itemId,
    expectedVersion: workItem.version,
    status: 'done',
    metadata: {
      ...(workItem.metadata || {}),
      completion_source: 'mission_work_reconciliation',
      reconciliation_receipt: receiptPath,
      reconciliation: { manifest_sha256: manifestHash },
      summary: `Adopted verified existing work for ${task.task_id}`,
    },
  });
  return itemId;
}

function readPlannedTasks(missionId: string): PlannedTask[] {
  return readCanonicalWorkGraphTasks(missionId).filter((entry): entry is PlannedTask =>
    Boolean(entry && typeof entry === 'object')
  );
}

/**
 * Create an operator-editable reconciliation scaffold from the current
 * mission tasks and repository git state. The result is intentionally not a
 * valid apply manifest until evidence hashes and verification results are
 * filled in by the operator.
 */
export function generateMissionWorkReconciliationScaffold(input: {
  missionId: string;
  outputPath?: string;
  reason?: string;
}): MissionWorkReconciliationScaffold & { manifest_path: string } {
  assertMissionControllerAuthority();
  const missionId = input.missionId.trim().toUpperCase();
  if (!/^[A-Z0-9][A-Z0-9._-]+$/u.test(missionId)) {
    throw new Error(`Invalid mission ID: ${input.missionId}`);
  }
  const missionPath = findMissionPath(missionId);
  if (!missionPath) throw new Error(`Mission ${missionId} not found`);
  const manifestPath = resolveInsideRoot(
    input.outputPath || `active/shared/tmp/reconciliation-${missionId}.scaffold.json`,
    'output',
    { allowMissingLeaf: true }
  );
  const sharedTmpRoot = nodePath.resolve(pathResolver.rootResolve('active/shared/tmp'));
  if (!isInside(sharedTmpRoot, manifestPath) && !isInside(missionPath, manifestPath)) {
    throw new Error('output must remain under active/shared/tmp or the mission-local directory.');
  }
  const repository = pathResolver.rootDir();
  const branch =
    getRegisteredEnvText('GITHUB_HEAD_REF')?.trim() ||
    getRegisteredEnvText('GITHUB_REF_NAME')?.trim() ||
    (() => {
      try {
        return safeExec('git', ['branch', '--show-current'], { cwd: repository }).trim();
      } catch {
        return '';
      }
    })();
  const commit =
    (() => {
      try {
        return safeExec('git', ['rev-parse', 'HEAD'], { cwd: repository }).trim();
      } catch {
        return '';
      }
    })() ||
    getRegisteredEnvText('GITHUB_SHA')?.trim() ||
    '';
  if (!branch || !commit) throw new Error('Unable to resolve repository branch and commit');
  const tasks = readPlannedTasks(missionId);
  const scaffold: MissionWorkReconciliationScaffold = {
    kind: 'mission-work-reconciliation-scaffold',
    version: '1.0.0',
    mission_id: missionId,
    generated_at: nowIso(),
    source: { repository: '.', branch, commit },
    adopted_by:
      getRegisteredEnvText('KYBERION_PERSONA') ||
      getRegisteredEnvText('USER') ||
      'mission_controller',
    reason: input.reason || `Adopt verified existing work for ${missionId}.`,
    tasks: tasks.map((task) => ({
      task_id: String(task.task_id || ''),
      ...(task.description ? { description: task.description } : {}),
      acceptance_criteria: Array.isArray(task.acceptance_criteria)
        ? task.acceptance_criteria.map(String)
        : [],
      evidence: [],
      verification_command: '',
    })),
    next_steps: [
      'Fill each task evidence path and SHA-256 hash.',
      'Map every acceptance criterion to evidence_refs.',
      'Record a passed verification command and evidence_refs.',
      'Change kind to mission-work-reconciliation and run --dry-run before apply.',
    ],
  };
  safeMkdir(nodePath.dirname(manifestPath), { recursive: true });
  safeWriteFile(manifestPath, JSON.stringify(scaffold, null, 2));
  return { ...scaffold, manifest_path: pathResolver.toRepoRelative(manifestPath) };
}

export async function reconcileMissionExistingWork(input: {
  missionId: string;
  manifestPath: string;
  dryRun?: boolean;
  approvalRequestId?: string;
}): Promise<MissionWorkReconciliationResult> {
  assertMissionControllerAuthority();
  const missionId = input.missionId.toUpperCase();
  const missionPath = findMissionPath(missionId);
  if (!missionPath) throw new Error(`Mission ${missionId} not found`);
  const state = loadState(missionId);
  if (!state) throw new Error(`Mission ${missionId} state not found`);
  if (state.status === 'archived') throw new Error(`Mission ${missionId} is archived`);

  const manifestPath = resolveInsideRoot(input.manifestPath, 'manifest');
  const manifestRaw = safeReadFile(manifestPath) as Buffer;
  const manifest = loadManifest(manifestPath, 'manifest');
  if (manifest.mission_id.toUpperCase() !== missionId) {
    throw new Error(
      `Manifest mission_id ${manifest.mission_id} does not match requested mission ${missionId}`
    );
  }
  const actorId =
    getRegisteredEnvText('KYBERION_PERSONA') ||
    getRegisteredEnvText('USER') ||
    'mission_controller';
  if (manifest.adopted_by !== actorId) {
    throw new Error(
      `Manifest adopted_by ${manifest.adopted_by} does not match execution actor ${actorId}`
    );
  }

  const sourceRepository = assertSourceCommit(manifest);
  const manifestHash = sha256(manifestRaw);
  if (!input.dryRun) {
    if (!input.approvalRequestId?.trim()) {
      throw new Error(
        '[POLICY_VIOLATION] reconcile-work apply requires --approval-request-id for an authenticated human approval'
      );
    }
    assertReconciliationApproval(
      input.approvalRequestId,
      missionId,
      manifestHash,
      manifest.source.commit
    );
  }
  const manifestTaskIds = manifest.tasks.map((task) => task.task_id);
  if (new Set(manifestTaskIds).size !== manifestTaskIds.length) {
    throw new Error('Manifest contains duplicate task_id values');
  }

  return withLock(`mission-${missionId}`, async () => {
    const tasks = readPlannedTasks(missionId);
    const taskById = new Map<string, PlannedTask>();
    for (const task of tasks) {
      const taskId = String(task.task_id || '');
      if (taskId) taskById.set(taskId, task);
    }
    const adoptedTaskIds = new Set(manifestTaskIds);
    const reconciledTaskIds: string[] = [];
    const alreadyReconciledTaskIds: string[] = [];
    const reconciledArtifactReviews = new Map<string, ReconciledArtifactReview>();
    const missionRiskProfile = String(
      ((state as unknown as { classification?: Record<string, unknown> }).classification || {})
        .risk_profile || ''
    ).trim();
    const missionClass = String(
      ((state as unknown as { classification?: Record<string, unknown> }).classification || {})
        .mission_class || ''
    ).trim();

    for (const manifestTask of manifest.tasks) {
      const plannedTask = taskById.get(manifestTask.task_id);
      if (!plannedTask)
        throw new Error(`Task ${manifestTask.task_id} not found in canonical WorkItems`);
      const status = String(plannedTask.status || 'planned').toLowerCase();
      const previousManifestHash = String(plannedTask.reconciliation?.manifest_sha256 || '');
      if (TERMINAL_TASK_STATUSES.has(status)) {
        if (previousManifestHash === manifestHash) {
          alreadyReconciledTaskIds.push(manifestTask.task_id);
          continue;
        }
        throw new Error(
          `Task ${manifestTask.task_id} is already terminal without this reconciliation manifest`
        );
      }
      if (!ADOPTABLE_TASK_STATUSES.has(status)) {
        throw new Error(`Task ${manifestTask.task_id} cannot be reconciled from status ${status}`);
      }
      validateTaskContract({ plannedTask, manifestTask });
      validateEvidence({
        task: manifestTask,
        sourceRepository,
        sourceCommit: manifest.source.commit,
        missionTier: state.tier,
      });
      const artifactReview = validateReconciledArtifactReview({
        missionId,
        missionType: missionClass || state.mission_type,
        missionRiskProfile: missionRiskProfile || undefined,
        plannedTask,
        manifestTask,
        sourceRepository,
        sourceCommit: manifest.source.commit,
        taskById,
      });
      if (artifactReview) reconciledArtifactReviews.set(manifestTask.task_id, artifactReview);
      assertDependenciesResolved(plannedTask, taskById, adoptedTaskIds);
      reconciledTaskIds.push(manifestTask.task_id);
    }

    const resultBase = {
      mission_id: missionId,
      manifest_path: pathResolver.toRepoRelative(manifestPath),
      manifest_sha256: manifestHash,
      source_commit: manifest.source.commit,
      reconciled_task_ids: reconciledTaskIds,
      already_reconciled_task_ids: alreadyReconciledTaskIds,
      auto_completed_repair_task_ids: [] as string[],
      work_item_ids_updated: [] as string[],
      ...(input.approvalRequestId ? { approval_request_id: input.approvalRequestId } : {}),
    };
    if (input.dryRun) return { status: 'dry_run_ready', ...resultBase };

    const adoptedAt = nowIso();
    for (const manifestTask of manifest.tasks) {
      const plannedTask = taskById.get(manifestTask.task_id)!;
      if (alreadyReconciledTaskIds.includes(manifestTask.task_id)) continue;
      plannedTask.status = 'completed';
      const artifactReview = reconciledArtifactReviews.get(manifestTask.task_id);
      if (artifactReview) {
        const reviewDir = nodePath.join(missionPath, 'evidence', 'reviews');
        safeMkdir(reviewDir, { recursive: true });
        const safeReviewId = artifactReview.receipt.review_id.replace(/[^a-zA-Z0-9._-]/g, '-');
        const safeTaskId = manifestTask.task_id.replace(/[^a-zA-Z0-9._-]/g, '-');
        const artifactReviewReceiptPath = nodePath.join(
          reviewDir,
          `reconciled-${safeTaskId}-${safeReviewId}.json`
        );
        writeDispatchArtifact(artifactReviewReceiptPath, artifactReview.receipt, {
          missionId,
          missionPath,
        });
        plannedTask.artifact_review_profile = artifactReview.profile;
        plannedTask.artifact_review_receipt = nodePath
          .relative(missionPath, artifactReviewReceiptPath)
          .split(nodePath.sep)
          .join('/');
      }
      plannedTask.reconciliation = {
        kind: manifest.kind,
        version: manifest.version,
        adopted_at: adoptedAt,
        adopted_by: manifest.adopted_by,
        reason: manifest.reason,
        source: manifest.source,
        manifest_path: resultBase.manifest_path,
        manifest_sha256: manifestHash,
        evidence: manifestTask.evidence,
        criteria: manifestTask.criteria,
        verification: manifestTask.verification,
      };
    }

    const terminalAfterAdoption = new Set(
      tasks
        .filter((task) => TERMINAL_TASK_STATUSES.has(String(task.status || '').toLowerCase()))
        .map((task) => String(task.task_id || ''))
    );
    for (const task of tasks) {
      if (task.task_id !== 'repair-finish-exit') continue;
      if (TERMINAL_TASK_STATUSES.has(String(task.status || '').toLowerCase())) continue;
      const dependencies = (task.dependencies || []).filter(
        (dependency) => dependency !== task.task_id
      );
      if (
        dependencies.length > 0 &&
        dependencies.every((dependency) => terminalAfterAdoption.has(dependency))
      ) {
        task.status = 'completed';
        task.reconciliation = {
          kind: 'mission-work-reconciliation-repair',
          adopted_at: adoptedAt,
          adopted_by: manifest.adopted_by,
          reason: 'All finish-exit repair dependencies were satisfied by reconciled work.',
          manifest_sha256: manifestHash,
        };
        resultBase.auto_completed_repair_task_ids.push(task.task_id);
      }
    }

    const receiptDir = nodePath.join(missionPath, 'evidence', 'work-reconciliation');
    safeMkdir(receiptDir, { recursive: true });
    const receiptPath = nodePath.join(receiptDir, `${manifestHash}.json`);
    const receiptRelative = pathResolver.toRepoRelative(receiptPath);
    for (const manifestTask of manifest.tasks) {
      const itemId = updateLinkedWorkItem(
        taskById.get(manifestTask.task_id)!,
        receiptRelative,
        manifestHash
      );
      if (itemId) resultBase.work_item_ids_updated.push(itemId);
    }
    for (const repairTaskId of resultBase.auto_completed_repair_task_ids) {
      const repairTask = taskById.get(repairTaskId);
      const repairItemId = repairTask?.work_item_id;
      if (!repairItemId) continue;
      const repairItem = getWorkItem(repairItemId);
      if (!repairItem || ['done', 'archived'].includes(repairItem.status)) continue;
      updateWorkItem({
        itemId: repairItemId,
        expectedVersion: repairItem.version,
        status: 'done',
        metadata: {
          ...(repairItem.metadata || {}),
          completion_source: 'mission_work_reconciliation_repair',
          reconciliation: { manifest_sha256: manifestHash },
          summary: 'All finish-exit repair dependencies were satisfied by reconciled work.',
        },
      });
    }

    const hasMutation =
      reconciledTaskIds.length > 0 ||
      resultBase.auto_completed_repair_task_ids.length > 0 ||
      resultBase.work_item_ids_updated.length > 0;
    if (!hasMutation) {
      logger.info(`Mission ${missionId} already reflects reconciliation ${manifestHash}.`);
      return {
        status: 'applied',
        ...resultBase,
        ...(safeExistsSync(receiptPath) ? { receipt_path: receiptRelative } : {}),
      };
    }

    for (const manifestTask of manifest.tasks) {
      if (!reconciledTaskIds.includes(manifestTask.task_id)) continue;
      appendMissionExecutionLedgerEntry({
        mission_id: missionId,
        mission_path_hint: missionPath,
        event_type: 'existing_work_reconciled',
        task_id: manifestTask.task_id,
        actor_id: manifest.adopted_by,
        actor_type: 'human',
        decision: manifest.reason,
        evidence: manifestTask.evidence.map((entry) => entry.path),
        payload: {
          manifest_sha256: manifestHash,
          source_commit: manifest.source.commit,
          ...(input.approvalRequestId ? { approval_request_id: input.approvalRequestId } : {}),
          verification_command: manifestTask.verification.command,
        },
      });
    }
    for (const repairTaskId of resultBase.auto_completed_repair_task_ids) {
      appendMissionExecutionLedgerEntry({
        mission_id: missionId,
        mission_path_hint: missionPath,
        event_type: 'existing_work_reconciliation_repair_completed',
        task_id: repairTaskId,
        actor_id: manifest.adopted_by,
        actor_type: 'human',
        decision: 'All finish-exit repair dependencies are terminal.',
        evidence: manifest.tasks.flatMap((task) => task.evidence.map((entry) => entry.path)),
        payload: {
          manifest_sha256: manifestHash,
          source_commit: manifest.source.commit,
          ...(input.approvalRequestId ? { approval_request_id: input.approvalRequestId } : {}),
        },
      });
    }

    if (reconciledTaskIds.length > 0 || resultBase.auto_completed_repair_task_ids.length > 0) {
      writeDispatchArtifact(nodePath.join(missionPath, 'NEXT_TASKS.json'), tasks, {
        missionId,
        missionPath,
      });
    }
    const receipt: MissionWorkReconciliationResult & { adopted_at: string; reason: string } = {
      status: 'applied',
      ...resultBase,
      receipt_path: receiptRelative,
      adopted_at: adoptedAt,
      reason: manifest.reason,
    };
    writeDispatchArtifact(receiptPath, receipt, { missionId, missionPath });

    const currentState = loadState(missionId);
    if (!currentState) throw new Error(`Mission ${missionId} state disappeared during reconcile`);
    currentState.context = {
      ...(currentState.context || {}),
      existing_work_reconciliation_summary: {
        manifest_sha256: manifestHash,
        source_commit: manifest.source.commit,
        task_ids: [...reconciledTaskIds, ...alreadyReconciledTaskIds],
        ...(input.approvalRequestId ? { approval_request_id: input.approvalRequestId } : {}),
        receipt_path: receiptRelative,
      },
    } as typeof currentState.context;
    try {
      const missionHead = safeExec('git', ['rev-parse', 'HEAD'], { cwd: missionPath }).trim();
      if (missionHead) {
        currentState.git.latest_commit = missionHead;
      }
    } catch (error) {
      logger.warn(
        `[mission-reconciliation] unable to refresh mission HEAD for ${missionId}: ${error instanceof Error ? error.message : String(error)}`
      );
    }
    currentState.history.push({
      ts: adoptedAt,
      event: 'RECONCILE_EXISTING_WORK',
      note: `Adopted ${reconciledTaskIds.length} task(s) from ${manifest.source.commit}: ${manifest.reason}`,
    });
    await saveState(missionId, currentState, { alreadyLocked: true });

    auditChain.record({
      agentId: manifest.adopted_by,
      action: 'mission.existing_work_reconciled',
      operation: `reconcile-work:${missionId}`,
      result: 'completed',
      metadata: {
        mission_id: missionId,
        manifest_sha256: manifestHash,
        source_commit: manifest.source.commit,
        task_ids: reconciledTaskIds,
        ...(input.approvalRequestId ? { approval_request_id: input.approvalRequestId } : {}),
        receipt_path: receiptRelative,
      },
    });
    logger.success(
      `Reconciled ${reconciledTaskIds.length} existing task result(s) for ${missionId}.`
    );
    return receipt;
  });
}
