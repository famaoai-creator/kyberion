/**
 * scripts/refactor/mission-governance.ts
 * Governance, trust, and observability helpers for mission orchestration.
 */

import * as path from 'node:path';
import {
  auditChain,
  evaluateArtifactReviews,
  evaluateDeliverableQuality,
  findMissionPath,
  logger,
  pathResolver,
  inferDeliverableKind,
  inferArtifactReviewKind,
  loadArtifactReviewReceipt,
  safeAppendFileSync,
  safeExec,
  safeExistsSync,
  safeReaddir,
  safeReadFile,
  safeStat,
  safeWriteFile,
  sha256,
  listArtifactOwnershipRecordsForMission,
  loadArtifactRecord,
  trustEngine,
  validateOutcomeContractAtCompletion,
  validateMarketingCompletionEvidence,
  receiptToArtifactReviewDecision,
  type MarketingCompletionEvidence,
  evaluateArtifactBundleGate,
  loadLatestArtifactBundleForMission,
} from '@agent/core';
import { readJsonFile, readTextFile } from './cli-input.js';
import { loadState } from './mission-state.js';

export function syncRoleProcedure(missionId: string, persona: string): void {
  const roleSlug = persona.toLowerCase().replace(/\s+/g, '_');
  const sourcePath = pathResolver.knowledge(`product/roles/${roleSlug}/PROCEDURE.md`);
  const targetDir = findMissionPath(missionId);

  if (!targetDir) {
    logger.warn(`⚠️ [Governance] Mission directory not found for ${missionId}.`);
    return;
  }

  const targetPath = path.join(targetDir, 'ROLE_PROCEDURE.md');

  if (safeExistsSync(sourcePath)) {
    const procedure = readTextFile(sourcePath);
    safeWriteFile(targetPath, procedure);
    logger.info(`📋 [Governance] Mirrored procedure for role "${persona}" to mission context.`);
  } else {
    logger.warn(
      `⚠️ [Governance] No specific procedure found for role "${persona}" at ${sourcePath}. Using default.`
    );
  }
}

export function updateTrustScore(agentId: string, result: 'verified' | 'rejected'): void {
  const oldRecord = trustEngine.getScore(agentId);
  const oldScore = oldRecord?.score ?? 500;

  if (result === 'verified') {
    trustEngine.recordEvent(agentId, 'outputQuality', 10, 'mission verified');
    trustEngine.recordEvent(agentId, 'policyCompliance', 5, 'mission compliant');
  } else {
    trustEngine.recordEvent(agentId, 'outputQuality', -20, 'mission rejected');
  }

  const newRecord = trustEngine.getScore(agentId);
  trustEngine.persist();

  auditChain.recordTrustChange(agentId, oldScore, newRecord?.score ?? 0, `mission ${result}`);
}

export function readTrustLedger(): Record<string, any> {
  const ledgerPath = pathResolver.knowledge('personal/governance/agent-trust-scores.json');
  if (!safeExistsSync(ledgerPath)) return {};
  const raw = readJsonFile<Record<string, unknown>>(ledgerPath);
  return raw?.agents ?? raw ?? {};
}

export async function validateMissionQuality(
  id: string
): Promise<{ ok: boolean; reason?: string; reviewTaskIds?: string[] }> {
  const state = loadState(id);
  if (!state) return { ok: false, reason: 'Mission state not found.' };

  const missionPath = findMissionPath(id);
  const artifactReviewGate = validateMissionArtifactReviewGate({
    missionId: id,
    missionPath,
  });
  if (!artifactReviewGate.ok) return artifactReviewGate;

  const policyPath = pathResolver.knowledge('product/governance/security-policy.json');
  if (!safeExistsSync(policyPath)) return { ok: true };

  const policy = readJsonFile<{ quality_requirements?: Record<string, unknown> }>(policyPath);
  const reqs = policy.quality_requirements;
  if (!reqs) return { ok: true };

  const marketingCompletion = validateMarketingMissionCompletionGate({
    missionType: state.mission_type,
    missionPath,
  });
  if (!marketingCompletion.ok) return marketingCompletion;

  if (state.outcome_contract) {
    const evidenceRefs =
      missionPath && safeExistsSync(path.join(missionPath, 'evidence'))
        ? safeReaddir(path.join(missionPath, 'evidence'))
            .filter((entry) => entry !== '.gitkeep')
            .map((entry) => path.join(missionPath, 'evidence', entry))
        : [];
    const outcomeCheck = validateOutcomeContractAtCompletion(state.outcome_contract, {
      artifactRefs: evidenceRefs,
    });
    if (!outcomeCheck.ok) {
      return { ok: false, reason: outcomeCheck.reason };
    }
  }

  const bundle = loadLatestArtifactBundleForMission(id);
  if (bundle) {
    const bundleGate = evaluateArtifactBundleGate(bundle);
    if (bundleGate.verdict !== 'ready') {
      return {
        ok: false,
        reason: bundleGate.reason || `Artifact bundle gate ${bundleGate.verdict}.`,
      };
    }
  }

  const missionArtifacts = listArtifactOwnershipRecordsForMission(id, { includeTmp: false });
  for (const ownership of missionArtifacts) {
    const artifact = loadArtifactRecord(ownership.artifact_id);
    if (!artifact) continue;
    const kind = inferDeliverableKind(artifact.kind);
    if (!kind) continue;
    const gate = evaluateDeliverableQuality(kind, artifact);
    if (gate.severity === 'poor') {
      return {
        ok: false,
        reason: gate.reason || `Deliverable quality gate blocked ${artifact.artifact_id}.`,
      };
    }
  }

  if (reqs.require_test_success) {
    logger.info('🧪 [QualityCheck] Verification required: require_test_success=true');
    if (
      state.status !== 'distilling' &&
      state.status !== 'validating' &&
      state.status !== 'completed'
    ) {
      return { ok: false, reason: 'Mission must pass validation/verification before finishing.' };
    }
  }

  if (missionPath) {
    const head = safeExec('git', ['rev-parse', 'HEAD'], { cwd: missionPath }).trim();
    if (state.git.latest_commit !== head) {
      return {
        ok: false,
        reason: `Mission state latest_commit (${state.git.latest_commit.slice(0, 8)}) does not match mission repo HEAD (${head.slice(0, 8)}). Record a checkpoint or evidence entry before finishing.`,
      };
    }
  }

  return { ok: true };
}

interface ArtifactReviewPlannedTask {
  task_id?: string;
  status?: string;
  assigned_to?: { role?: string };
  review_target?: string;
  artifact_review_receipt?: string;
  artifact_review_profile?: {
    artifact_kind?: 'doc' | 'deck' | 'code' | 'media';
    artifact_path?: string;
    artifact_sha256?: string;
    required_reviewer_roles?: string[];
    independence_required?: boolean;
    implementer_agent_ids?: string[];
  };
}

const TERMINAL_REVIEW_TASK_STATUSES = new Set(['done', 'completed', 'accepted', 'reviewed']);

export function validateMissionArtifactReviewGate(input: {
  missionId: string;
  missionPath: string | null;
}): { ok: boolean; reason?: string; reviewTaskIds?: string[] } {
  if (!input.missionPath) return { ok: true };
  const taskPath = path.join(input.missionPath, 'NEXT_TASKS.json');
  if (!safeExistsSync(taskPath)) return { ok: true };

  let tasks: ArtifactReviewPlannedTask[];
  try {
    const raw = JSON.parse(String(safeReadFile(taskPath, { encoding: 'utf8' }))) as unknown;
    if (!Array.isArray(raw)) return { ok: false, reason: 'NEXT_TASKS.json must contain an array.' };
    tasks = raw.filter((entry): entry is ArtifactReviewPlannedTask =>
      Boolean(entry && typeof entry === 'object')
    );
  } catch (error) {
    return {
      ok: false,
      reason: `Artifact review gate could not read NEXT_TASKS.json: ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  for (const task of tasks) {
    const profile = task.artifact_review_profile;
    if (!profile) continue;
    const taskId = String(task.task_id || '').trim();
    const role = String(task.assigned_to?.role || '')
      .trim()
      .toLowerCase();
    if (role !== 'reviewer' && role !== 'qa') continue;
    if (!TERMINAL_REVIEW_TASK_STATUSES.has(String(task.status || '').toLowerCase())) continue;
    const receiptReference = String(task.artifact_review_receipt || '').trim();
    if (!receiptReference) {
      return {
        ok: false,
        reason: `Artifact review gate failed for ${taskId}: review receipt is missing.`,
        reviewTaskIds: [taskId],
      };
    }
    const receiptPath = path.resolve(input.missionPath, receiptReference);
    const relativeReceiptPath = path.relative(input.missionPath, receiptPath);
    if (relativeReceiptPath.startsWith('..') || path.isAbsolute(relativeReceiptPath)) {
      return {
        ok: false,
        reason: `Artifact review gate failed for ${taskId}: receipt must remain inside the mission directory.`,
        reviewTaskIds: [taskId],
      };
    }

    try {
      const receipt = loadArtifactReviewReceipt(receiptPath);
      const identityReasons: string[] = [];
      if (receipt.mission_id.toUpperCase() !== input.missionId.toUpperCase()) {
        identityReasons.push(`receipt mission_id is ${receipt.mission_id}`);
      }
      if (receipt.review_task_id !== taskId) {
        identityReasons.push(`receipt review_task_id is ${receipt.review_task_id}`);
      }
      if (task.review_target && receipt.review_target_task_id !== task.review_target) {
        identityReasons.push(`receipt review_target_task_id is ${receipt.review_target_task_id}`);
      }
      if (profile.artifact_path && receipt.artifact.path !== profile.artifact_path) {
        identityReasons.push('receipt artifact path does not match the review profile');
      }
      if (profile.artifact_sha256 && receipt.artifact.sha256 !== profile.artifact_sha256) {
        identityReasons.push('receipt artifact hash does not match the review profile');
      }
      const artifactPath = pathResolver.rootResolve(receipt.artifact.path);
      const inferredArtifactKind = inferArtifactReviewKind(receipt.artifact.path);
      if (receipt.artifact.kind !== inferredArtifactKind) {
        identityReasons.push(
          `receipt artifact kind ${receipt.artifact.kind} does not match inferred kind ${inferredArtifactKind}`
        );
      }
      if (profile.artifact_kind && receipt.artifact.kind !== profile.artifact_kind) {
        identityReasons.push('receipt artifact kind does not match the review profile');
      }
      if (!safeExistsSync(artifactPath) || !safeStat(artifactPath).isFile()) {
        identityReasons.push(`reviewed artifact is missing: ${receipt.artifact.path}`);
      }
      if (identityReasons.length > 0) {
        return {
          ok: false,
          reason: `Artifact review gate failed for ${taskId}: ${identityReasons.join('; ')}.`,
          reviewTaskIds: [taskId],
        };
      }
      const currentHash = sha256(safeReadFile(artifactPath) as Buffer);
      const evaluation = evaluateArtifactReviews({
        artifacts: [{ path: receipt.artifact.path, sha256: currentHash }],
        reviews: [receiptToArtifactReviewDecision(receipt)],
        requiredReviewerRoles: profile.required_reviewer_roles || [],
        implementerAgentIds: profile.implementer_agent_ids || [],
        requireIndependence: profile.independence_required === true,
      });
      if (!evaluation.ready) {
        return {
          ok: false,
          reason: `Artifact review gate failed for ${taskId}: ${evaluation.reasons.join('; ')}.`,
          reviewTaskIds: [taskId],
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: `Artifact review gate failed for ${taskId}: ${error instanceof Error ? error.message : String(error)}`,
        reviewTaskIds: [taskId],
      };
    }
  }
  return { ok: true };
}

export function validateMarketingMissionCompletionGate(input: {
  missionType?: string;
  missionPath: string | null;
}): { ok: boolean; reason?: string } {
  if (!/marketing|campaign|publication/i.test(input.missionType || '')) return { ok: true };
  if (!input.missionPath) return { ok: false, reason: 'Marketing mission path not found.' };
  const evidenceRoot = path.join(input.missionPath, 'evidence');
  const candidates: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 5 || !safeExistsSync(directory)) return;
    for (const entry of safeReaddir(directory)) {
      const candidate = path.join(directory, entry);
      const stat = safeStat(candidate);
      if (stat.isDirectory()) visit(candidate, depth + 1);
      else if (entry === 'completion-evidence.json') candidates.push(candidate);
    }
  };
  visit(evidenceRoot, 0);
  if (candidates.length === 0) {
    return { ok: false, reason: 'Marketing mission requires completion-evidence.json.' };
  }
  candidates.sort((left, right) => safeStat(right).mtimeMs - safeStat(left).mtimeMs);
  try {
    const evidence = JSON.parse(
      safeReadFile(candidates[0], { encoding: 'utf8' }) as string
    ) as MarketingCompletionEvidence;
    const currentArtifacts = Object.fromEntries(
      Object.entries(evidence.artifact_bindings || {}).map(([name, binding]) => {
        const artifactPath = path.isAbsolute(binding.path)
          ? binding.path
          : pathResolver.rootResolve(binding.path);
        if (!safeExistsSync(artifactPath)) return [name, { path: binding.path, sha256: '' }];
        return [name, { path: binding.path, sha256: sha256(safeReadFile(artifactPath) as Buffer) }];
      })
    );
    const result = validateMarketingCompletionEvidence({ evidence, currentArtifacts });
    return result.ok
      ? { ok: true }
      : { ok: false, reason: `Marketing completion gate failed: ${result.reasons.join('; ')}` };
  } catch (error) {
    return {
      ok: false,
      reason: `Marketing completion evidence is invalid: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function recordAgentRuntimeEvent(
  agentRuntimeEventPath: string,
  event: Record<string, unknown>
): void {
  const dir = path.dirname(agentRuntimeEventPath);
  if (!safeExistsSync(dir)) safeWriteFile(agentRuntimeEventPath, '');
  safeAppendFileSync(
    agentRuntimeEventPath,
    JSON.stringify({
      ts: new Date().toISOString(),
      ...event,
    }) + '\n'
  );
}
