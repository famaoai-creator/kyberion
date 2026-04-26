/**
 * scripts/refactor/mission-governance.ts
 * Governance, trust, and observability helpers for mission orchestration.
 */

import * as path from 'node:path';
import {
  auditChain,
  findMissionPath,
  logger,
  pathResolver,
  safeAppendFileSync,
  safeExec,
  safeExistsSync,
  safeReaddir,
  safeReadFile,
  safeWriteFile,
  trustEngine,
  validateOutcomeContractAtCompletion,
} from '@agent/core';
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
    const procedure = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
    safeWriteFile(targetPath, procedure);
    logger.info(`📋 [Governance] Mirrored procedure for role "${persona}" to mission context.`);
  } else {
    logger.warn(`⚠️ [Governance] No specific procedure found for role "${persona}" at ${sourcePath}. Using default.`);
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
  const raw = JSON.parse(safeReadFile(ledgerPath, { encoding: 'utf8' }) as string);
  return raw?.agents ?? raw ?? {};
}

export async function validateMissionQuality(id: string): Promise<{ ok: boolean; reason?: string }> {
  const policyPath = pathResolver.knowledge('public/governance/security-policy.json');
  if (!safeExistsSync(policyPath)) return { ok: true };

  const policy = JSON.parse(safeReadFile(policyPath, { encoding: 'utf8' }) as string);
  const reqs = policy.quality_requirements;
  if (!reqs) return { ok: true };

  const state = loadState(id);
  if (!state) return { ok: false, reason: 'Mission state not found.' };

  if (state.outcome_contract) {
    const missionPath = findMissionPath(id);
    const evidenceRefs = missionPath && safeExistsSync(path.join(missionPath, 'evidence'))
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

  if (reqs.require_test_success) {
    logger.info('🧪 [QualityCheck] Verification required: require_test_success=true');
    if (state.status !== 'distilling' && state.status !== 'validating' && state.status !== 'completed') {
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

export function recordAgentRuntimeEvent(
  agentRuntimeEventPath: string,
  event: Record<string, unknown>,
): void {
  const dir = path.dirname(agentRuntimeEventPath);
  if (!safeExistsSync(dir)) safeWriteFile(agentRuntimeEventPath, '');
  safeAppendFileSync(agentRuntimeEventPath, JSON.stringify({
    ts: new Date().toISOString(),
    ...event,
  }) + '\n');
}
