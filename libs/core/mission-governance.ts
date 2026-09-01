import { appendJsonLine, readJson } from './foundation/json.js';
/**
 * scripts/refactor/mission-governance.ts
 * Governance, trust, and observability helpers for mission orchestration.
 */

import * as path from 'node:path';
import { auditChain } from './audit-chain.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import {
  evaluateArtifactReviews,
  inferArtifactReviewKind,
  loadArtifactReviewReceipt,
  receiptToArtifactReviewDecision,
} from './artifact-review.js';
import { evaluateDeliverableQuality, inferDeliverableKind } from './deliverable-quality.js';
import * as pathResolver from './path-resolver.js';
import { findMissionPath } from './path-resolver.js';
import { logger } from './core.js';
import {
  assertSafeRepositoryPath,
  safeExec,
  safeExistsSync,
  safeReaddir,
  safeReadFile,
  safeStat,
  safeWriteFile,
} from './secure-io.js';
import {
  sha256,
  validateMarketingCompletionEvidence,
  type MarketingCompletionEvidence,
} from './marketing-workload.js';
import { listArtifactOwnershipRecordsForMission } from './artifact-registry.js';
import { loadArtifactRecord } from './artifact-record.js';
import { trustEngine } from './trust-engine.js';
import { validateOutcomeContractAtCompletion } from './outcome-contract.js';
import { evaluateArtifactBundleGate } from './mission-review-gates.js';
import { loadLatestArtifactBundleForMission } from './artifact-bundle.js';
import { readTextFile } from './foundation/text.js';
import { loadState } from './mission-state.js';
import { loadPersistedTrustLedger } from './trust-engine.js';

const SECURITY_POLICY_QUALITY_CATALOG = defineCatalog<{
  quality_requirements?: Record<string, unknown>;
}>({
  id: 'security-policy-quality-requirements',
  path: pathResolver.knowledge('product/governance/security-policy.json'),
  schema: pathResolver.knowledge('product/schemas/security-policy.schema.json'),
});

function safeMissionRoot(missionPath: string): string {
  return assertSafeRepositoryPath(missionPath, { allowMissingLeaf: true });
}

function safeMissionArtifactPath(missionPath: string, relativePath: string): string {
  return assertSafeRepositoryPath(path.join(safeMissionRoot(missionPath), relativePath), {
    allowMissingLeaf: true,
  });
}

function isPathInside(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative !== '' &&
    relative !== '..' &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

export function syncRoleProcedure(missionId: string, persona: string): void {
  const roleSlug = persona.toLowerCase().replace(/\s+/g, '_');
  let sourcePath: string;
  const targetDir = findMissionPath(missionId);

  if (!targetDir) {
    logger.warn(`⚠️ [Governance] Mission directory not found for ${missionId}.`);
    return;
  }

  try {
    sourcePath = assertSafeRepositoryPath(
      pathResolver.knowledge(`product/roles/${roleSlug}/PROCEDURE.md`),
      { allowMissingLeaf: true }
    );
    const safeTargetDir = safeMissionRoot(targetDir);
    const targetPath = safeMissionArtifactPath(safeTargetDir, 'ROLE_PROCEDURE.md');

    if (safeExistsSync(sourcePath)) {
      const procedure = readTextFile(sourcePath);
      safeWriteFile(targetPath, procedure);
      logger.info(`📋 [Governance] Mirrored procedure for role "${persona}" to mission context.`);
    } else {
      logger.warn(
        `⚠️ [Governance] No specific procedure found for role "${persona}" at ${sourcePath}. Using default.`
      );
    }
  } catch (error) {
    logger.warn(
      `⚠️ [Governance] Refusing unsafe role procedure path for "${persona}": ${error instanceof Error ? error.message : String(error)}`
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
  return loadPersistedTrustLedger() ?? {};
}

export async function validateMissionQuality(
  id: string
): Promise<{ ok: boolean; reason?: string; reviewTaskIds?: string[] }> {
  const state = loadState(id);
  if (!state) return { ok: false, reason: 'Mission state not found.' };

  const missionPathCandidate = findMissionPath(id);
  let missionPath: string | null = missionPathCandidate;
  if (missionPathCandidate) {
    try {
      missionPath = safeMissionRoot(missionPathCandidate);
    } catch (error) {
      return {
        ok: false,
        reason: `Mission path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const artifactReviewGate = validateMissionArtifactReviewGate({
    missionId: id,
    missionPath,
  });
  if (!artifactReviewGate.ok) return artifactReviewGate;

  const policyPath = pathResolver.knowledge('product/governance/security-policy.json');
  if (!safeExistsSync(policyPath)) return { ok: true };

  const policy = SECURITY_POLICY_QUALITY_CATALOG.load();
  const reqs = policy.quality_requirements;
  if (!reqs) return { ok: true };

  const marketingCompletion = validateMarketingMissionCompletionGate({
    missionType: state.mission_type,
    missionPath,
  });
  if (!marketingCompletion.ok) return marketingCompletion;

  if (state.outcome_contract) {
    let evidenceRefs: string[] = [];
    if (missionPath) {
      try {
        const evidenceDir = safeMissionArtifactPath(missionPath, 'evidence');
        evidenceRefs = safeExistsSync(evidenceDir)
          ? safeReaddir(evidenceDir)
              .filter((entry) => entry !== '.gitkeep')
              .map((entry) => safeMissionArtifactPath(missionPath, `evidence/${entry}`))
          : [];
      } catch (error) {
        return {
          ok: false,
          reason: `Mission evidence path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    }
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
  let missionPath: string;
  let taskPath: string;
  try {
    missionPath = safeMissionRoot(input.missionPath);
    taskPath = safeMissionArtifactPath(missionPath, 'NEXT_TASKS.json');
  } catch (error) {
    return {
      ok: false,
      reason: `Artifact review gate could not use mission path: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  if (!safeExistsSync(taskPath)) return { ok: true };

  let tasks: ArtifactReviewPlannedTask[];
  try {
    const raw = readJson<unknown>(taskPath);
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
    const receiptPath = path.resolve(missionPath, receiptReference);
    if (!isPathInside(missionPath, receiptPath)) {
      return {
        ok: false,
        reason: `Artifact review gate failed for ${taskId}: receipt must remain inside the mission directory.`,
        reviewTaskIds: [taskId],
      };
    }

    try {
      const safeReceiptPath = assertSafeRepositoryPath(receiptPath, { allowMissingLeaf: true });
      const receipt = loadArtifactReviewReceipt(safeReceiptPath);
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
      const artifactPath = assertSafeRepositoryPath(
        pathResolver.rootResolve(receipt.artifact.path),
        {
          allowMissingLeaf: true,
        }
      );
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
  let missionPath: string;
  let evidenceRoot: string;
  try {
    missionPath = safeMissionRoot(input.missionPath);
    evidenceRoot = safeMissionArtifactPath(missionPath, 'evidence');
  } catch (error) {
    return {
      ok: false,
      reason: `Marketing mission path is unsafe: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const candidates: string[] = [];
  const visit = (directory: string, depth: number): void => {
    if (depth > 5 || !safeExistsSync(directory)) return;
    for (const entry of safeReaddir(directory)) {
      try {
        const candidate = assertSafeRepositoryPath(path.join(directory, entry), {
          allowMissingLeaf: false,
        });
        const stat = safeStat(candidate);
        if (stat.isDirectory()) visit(candidate, depth + 1);
        else if (entry === 'completion-evidence.json') candidates.push(candidate);
      } catch {
        // Unsafe or symlinked evidence entries are not eligible completion evidence.
      }
    }
  };
  visit(evidenceRoot, 0);
  if (candidates.length === 0) {
    return { ok: false, reason: 'Marketing mission requires completion-evidence.json.' };
  }
  candidates.sort((left, right) => safeStat(right).mtimeMs - safeStat(left).mtimeMs);
  try {
    const evidence = readJson<MarketingCompletionEvidence>(candidates[0]);
    const currentArtifacts = Object.fromEntries(
      Object.entries(evidence.artifact_bindings || {}).map(([name, binding]) => {
        let artifactPath: string;
        try {
          artifactPath = assertSafeRepositoryPath(pathResolver.rootResolve(binding.path), {
            allowMissingLeaf: true,
          });
        } catch {
          return [name, { path: binding.path, sha256: '' }];
        }
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
  const safeEventPath = assertSafeRepositoryPath(agentRuntimeEventPath, { allowMissingLeaf: true });
  const dir = assertSafeRepositoryPath(path.dirname(safeEventPath), { allowMissingLeaf: true });
  if (!safeExistsSync(dir)) safeWriteFile(safeEventPath, '');
  appendJsonLine(safeEventPath, { ts: new Date().toISOString(), ...event });
}
