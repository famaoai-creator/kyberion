/**
 * scripts/refactor/mission-governance.ts
 * Governance, trust, and observability helpers for mission orchestration.
 */

import * as path from 'node:path';
import {
  auditChain,
  evaluateDeliverableQuality,
  findMissionPath,
  logger,
  pathResolver,
  inferDeliverableKind,
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
  type MarketingCompletionEvidence,
  evaluateArtifactBundleGate,
  loadLatestArtifactBundleForMission,
} from '@agent/core';
import { readJsonFile, readTextFile } from './cli-input.js';
import { loadState } from './mission-state.js';

export function syncRoleProcedure(missionId: string, persona: string): void {
  const roleSlug = persona.toLowerCase().replace(/\s+/g, '_');
  const sourcePath = pathResolver.knowledge(`public/roles/${roleSlug}/PROCEDURE.md`);
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
): Promise<{ ok: boolean; reason?: string }> {
  const policyPath = pathResolver.knowledge('product/governance/security-policy.json');
  if (!safeExistsSync(policyPath)) return { ok: true };

  const policy = readJsonFile<{ quality_requirements?: Record<string, unknown> }>(policyPath);
  const reqs = policy.quality_requirements;
  if (!reqs) return { ok: true };

  const state = loadState(id);
  if (!state) return { ok: false, reason: 'Mission state not found.' };

  const marketingCompletion = validateMarketingMissionCompletionGate({
    missionType: state.mission_type,
    missionPath: findMissionPath(id),
  });
  if (!marketingCompletion.ok) return marketingCompletion;

  if (state.outcome_contract) {
    const missionPath = findMissionPath(id);
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

  const missionPath = findMissionPath(id);
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
