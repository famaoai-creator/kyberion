/**
 * Adopt work completed outside dispatch-workitems without weakening the mission exit gate.
 */

import { Ajv, type ValidateFunction } from 'ajv';
import * as nodePath from 'node:path';
import {
  appendMissionExecutionLedgerEntry,
  evaluateArtifactReviews,
  auditChain,
  compileSchemaFromPath,
  detectTier,
  findMissionPath,
  getWorkItem,
  inferArtifactReviewKind,
  logger,
  loadArtifactReviewReceipt,
  pathResolver,
  receiptToArtifactReviewDecision,
  resolveArtifactReviewerProfile,
  hasAuthority,
  resolveIdentityContext,
  safeExec,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeStat,
  safeWriteFile,
  sha256,
  updateWorkItem,
  withLock,
  type ArtifactReviewReceipt,
  type ArtifactReviewerProfile,
} from '@agent/core';
import { loadState, saveState } from './mission-state.js';

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
  receipt_path?: string;
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
  reconciliation?: Record<string, unknown>;
}

interface ReconciledArtifactReview {
  profile: NonNullable<PlannedTask['artifact_review_profile']>;
  receipt: ArtifactReviewReceipt;
}

let validateManifest: ValidateFunction | null = null;

function getManifestValidator(): ValidateFunction {
  if (validateManifest) return validateManifest;
  const ajv = new Ajv({ allErrors: true, strict: false });
  validateManifest = compileSchemaFromPath(
    ajv,
    pathResolver.knowledge('product/schemas/mission-work-reconciliation.schema.json')
  );
  return validateManifest;
}

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

function resolveInsideRoot(rawPath: string, label: string): string {
  const root = nodePath.resolve(pathResolver.rootDir());
  const resolved = nodePath.resolve(root, rawPath);
  if (!isInside(root, resolved)) {
    throw new Error(`${label} must remain inside the Kyberion repository: ${rawPath}`);
  }
  return resolved;
}

function readJson<T>(filePath: string, label: string): T {
  if (!safeExistsSync(filePath)) throw new Error(`${label} not found: ${filePath}`);
  try {
    return JSON.parse(String(safeReadFile(filePath, { encoding: 'utf8' }))) as T;
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} is not valid JSON: ${message}`);
  }
}

function formatSchemaErrors(validator: ValidateFunction): string {
  return (validator.errors || [])
    .map((error) => `${error.instancePath || '/'} ${error.message || 'is invalid'}`)
    .join('; ');
}

function assertSourceCommit(manifest: MissionWorkReconciliationManifest): string {
  const repository = resolveInsideRoot(manifest.source.repository, 'source.repository');
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
  const reasons: string[] = [];
  if (receipt.artifact.kind !== inferredArtifactKind) {
    reasons.push(
      `receipt artifact kind ${receipt.artifact.kind} does not match inferred kind ${inferredArtifactKind}`
    );
  }
  if (receipt.artifact.sha256 !== currentHash) {
    reasons.push(`review ${receipt.review_id} was invalidated by artifact change`);
  }
  if (declaredProfile?.artifact_path && declaredProfile.artifact_path !== normalizedArtifactPath) {
    reasons.push('reviewed artifact path does not match the declared review profile');
  }
  if (declaredProfile?.artifact_sha256 && declaredProfile.artifact_sha256 !== currentHash) {
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

function updateLinkedWorkItem(task: PlannedTask, receiptPath: string): string | null {
  const itemId = task.ticket_dispatch?.work_item_id;
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
      summary: `Adopted verified existing work for ${task.task_id}`,
    },
  });
  return itemId;
}

function readPlannedTasks(missionPath: string): PlannedTask[] {
  const tasks = readJson<unknown>(nodePath.join(missionPath, 'NEXT_TASKS.json'), 'NEXT_TASKS.json');
  if (!Array.isArray(tasks)) throw new Error('NEXT_TASKS.json must contain an array');
  return tasks.filter((entry): entry is PlannedTask => Boolean(entry && typeof entry === 'object'));
}

export async function reconcileMissionExistingWork(input: {
  missionId: string;
  manifestPath: string;
  dryRun?: boolean;
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
  const manifest = readJson<MissionWorkReconciliationManifest>(manifestPath, 'manifest');
  const validator = getManifestValidator();
  if (!validator(manifest)) {
    throw new Error(`Invalid reconciliation manifest: ${formatSchemaErrors(validator)}`);
  }
  if (manifest.mission_id.toUpperCase() !== missionId) {
    throw new Error(
      `Manifest mission_id ${manifest.mission_id} does not match requested mission ${missionId}`
    );
  }
  const actorId = process.env.KYBERION_PERSONA || process.env.USER || 'mission_controller';
  if (manifest.adopted_by !== actorId) {
    throw new Error(
      `Manifest adopted_by ${manifest.adopted_by} does not match execution actor ${actorId}`
    );
  }

  const sourceRepository = assertSourceCommit(manifest);
  const manifestHash = sha256(manifestRaw);
  const manifestTaskIds = manifest.tasks.map((task) => task.task_id);
  if (new Set(manifestTaskIds).size !== manifestTaskIds.length) {
    throw new Error('Manifest contains duplicate task_id values');
  }

  return withLock(`mission-${missionId}`, async () => {
    const tasks = readPlannedTasks(missionPath);
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
        throw new Error(`Task ${manifestTask.task_id} not found in NEXT_TASKS.json`);
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
    };
    if (input.dryRun) return { status: 'dry_run_ready', ...resultBase };

    const adoptedAt = new Date().toISOString();
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
        safeWriteFile(artifactReviewReceiptPath, JSON.stringify(artifactReview.receipt, null, 2));
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
      const itemId = updateLinkedWorkItem(taskById.get(manifestTask.task_id)!, receiptRelative);
      if (itemId) resultBase.work_item_ids_updated.push(itemId);
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
        },
      });
    }

    if (reconciledTaskIds.length > 0 || resultBase.auto_completed_repair_task_ids.length > 0) {
      safeWriteFile(nodePath.join(missionPath, 'NEXT_TASKS.json'), JSON.stringify(tasks, null, 2));
    }
    const receipt: MissionWorkReconciliationResult & { adopted_at: string; reason: string } = {
      status: 'applied',
      ...resultBase,
      receipt_path: receiptRelative,
      adopted_at: adoptedAt,
      reason: manifest.reason,
    };
    safeWriteFile(receiptPath, JSON.stringify(receipt, null, 2));

    const currentState = loadState(missionId);
    if (!currentState) throw new Error(`Mission ${missionId} state disappeared during reconcile`);
    currentState.context = {
      ...(currentState.context || {}),
      existing_work_reconciliation_summary: {
        manifest_sha256: manifestHash,
        source_commit: manifest.source.commit,
        task_ids: [...reconciledTaskIds, ...alreadyReconciledTaskIds],
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
        receipt_path: receiptRelative,
      },
    });
    logger.success(
      `Reconciled ${reconciledTaskIds.length} existing task result(s) for ${missionId}.`
    );
    return receipt;
  });
}
