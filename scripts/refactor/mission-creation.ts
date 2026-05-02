/**
 * scripts/refactor/mission-creation.ts
 * Mission creation and activation helpers.
 */

import * as path from 'node:path';
import {
  composeMissionTeamPlan,
  findMissionPath,
  initializeMissionTeamBindings,
  ledger,
  logger,
  missionDir as resolveMissionDir,
  pathResolver,
  inferMissionOutcomeContract,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  transitionStatus,
  writeMissionTeamPlan,
} from '@agent/core';
import { readJsonFile } from './cli-input.js';
import { getCurrentBranch, getGitHash, initMissionRepo } from './mission-git.js';
import { calculateRequiredTier, checkPrerequisites, loadState, normalizeRelationships, saveState } from './mission-state.js';
import { syncRoleProcedure } from './mission-governance.js';
import { emitMissionLifecycleIntentSnapshot } from './mission-intent-delta.js';
import type { MissionState } from './mission-types.js';

const TENANT_SLUG_RE = /^[a-z][a-z0-9-]{1,30}$/;

function normalizeTenantSlug(value: string | undefined | null): string | undefined {
  if (!value) return undefined;
  const trimmed = String(value).trim();
  if (!trimmed) return undefined;
  return TENANT_SLUG_RE.test(trimmed) ? trimmed : undefined;
}

export async function createMission(
  args: {
    id: string;
    tier?: 'personal' | 'confidential' | 'public';
    tenantId?: string;
    /**
     * Tenant slug for multi-tenant deployments. When set (and matches the
     * `^[a-z][a-z0-9-]{1,30}$` pattern), the resulting mission-state.json
     * will carry `tenant_slug` so tier-guard and audit-chain enforce
     * cross-tenant isolation.
     */
    tenantSlug?: string;
    missionType?: string;
    visionRef?: string;
    persona?: string;
    relationships?: any;
    rootDir: string;
  },
): Promise<void> {
  const {
    id,
    tier = 'confidential',
    tenantId = 'default',
    tenantSlug: rawTenantSlug,
    missionType = 'development',
    visionRef,
    persona = 'Ecosystem Architect',
    relationships = {},
    rootDir,
  } = args;
  const tenantSlug = normalizeTenantSlug(rawTenantSlug);
  if (rawTenantSlug && !tenantSlug) {
    throw new Error(
      `[mission-creation] invalid tenant slug '${rawTenantSlug}'; must match ^[a-z][a-z0-9-]{1,30}$`,
    );
  }

  const upperId = id.toUpperCase();
  const isEphemeral = process.argv.includes('--ephemeral');
  const normalizedRelationships = normalizeRelationships(relationships);
  const templatePath = pathResolver.knowledge('public/governance/mission-templates.json');
  const templates = readJsonFile<{
    templates: Array<{
      name?: string;
      knowledge_injections?: string[];
      files: Array<{ content_template: string; path: string }>;
    }>;
  }>(templatePath).templates;
  const template = templates.find((entry: any) => entry.name === missionType) || templates[0];

  const finalTier = calculateRequiredTier(template.knowledge_injections || [], tier);
  const missionBaseDir = isEphemeral ? pathResolver.active('missions/ephemeral') : resolveMissionDir(upperId, finalTier);
  const missionDir = isEphemeral ? path.join(missionBaseDir, upperId) : missionBaseDir;

  if (!safeExistsSync(missionDir)) safeMkdir(missionDir, { recursive: true });
  if (safeExistsSync(path.join(missionDir, 'mission-state.json'))) {
    logger.info(`Mission ${upperId} already exists at ${missionDir}.`);
    return;
  }

  const gitBranch = getCurrentBranch(rootDir);
  const gitHash = getGitHash(rootDir);
  const now = new Date().toISOString();
  const owner = process.env.USER || 'famao';
  const resolvedVision = visionRef || '/knowledge/personal/my-vision.md';

  for (const file of template.files) {
    const content = file.content_template
      .replace(/{MISSION_ID}/g, upperId)
      .replace(/{TENANT_ID}/g, tenantId)
      .replace(/{TYPE}/g, missionType)
      .replace(/{VISION_REF}/g, resolvedVision)
      .replace(/{PERSONA}/g, persona)
      .replace(/{OWNER}/g, owner)
      .replace(/{BRANCH}/g, gitBranch)
      .replace(/{HASH}/g, gitHash)
      .replace(/{NOW}/g, now);
    safeWriteFile(path.join(missionDir, file.path), content);
  }

  const teamPlan = composeMissionTeamPlan({
    missionId: upperId,
    missionType,
    tier: finalTier,
    assignedPersona: persona,
  });
  writeMissionTeamPlan(missionDir, teamPlan);
  initializeMissionTeamBindings(missionDir, teamPlan);

  const evidenceDir = path.join(missionDir, 'evidence');
  if (!safeExistsSync(evidenceDir)) {
    safeMkdir(evidenceDir, { recursive: true });
    safeWriteFile(path.join(evidenceDir, '.gitkeep'), '');
    logger.info(`📁 [Architecture] Created evidence directory for mission ${upperId}.`);
  }

  if (!isEphemeral) {
    initMissionRepo(missionDir, upperId);
  }

  const missionGitHash = !isEphemeral ? getGitHash(missionDir) : 'ephemeral';
  const missionBranch = !isEphemeral ? getCurrentBranch(missionDir) : 'ephemeral';
  const initialState: MissionState & { is_ephemeral?: boolean } = {
    mission_id: upperId,
    mission_type: missionType,
    tier: finalTier,
    status: 'planned',
    execution_mode: 'local',
    is_ephemeral: isEphemeral,
    relationships: normalizedRelationships,
    ...(tenantSlug ? { tenant_slug: tenantSlug } : {}),
    priority: 3,
    assigned_persona: persona,
    confidence_score: 1.0,
    git: {
      branch: missionBranch,
      start_commit: missionGitHash,
      latest_commit: missionGitHash,
      checkpoints: [],
    },
    outcome_contract: inferMissionOutcomeContract({
      missionId: upperId,
      missionType,
      visionRef: resolvedVision,
    }),
    history: [{ ts: now, event: 'CREATE', note: `Mission created in ${finalTier} tier ${isEphemeral ? '(Ephemeral Mode)' : '(Independent Micro-Repo)'}.` }],
  };
  await saveState(upperId, initialState);

  ledger.record('MISSION_CREATE', {
    mission_id: upperId,
    tier: finalTier,
    type: missionType,
    persona,
    owner,
    is_ephemeral: isEphemeral,
  });

  logger.success(`🚀 Mission ${upperId} initialized in ${finalTier} tier from template "${template.name}" (ADF-driven${isEphemeral ? ', Ephemeral' : ''}).`);
}

export async function startMission(
  args: {
    id: string;
    tier?: 'personal' | 'confidential' | 'public';
    persona?: string;
    tenantId?: string;
    tenantSlug?: string;
    missionType?: string;
    visionRef?: string;
    relationships?: any;
    rootDir: string;
  },
): Promise<void> {
  const {
    id,
    tier = 'confidential',
    persona = 'Ecosystem Architect',
    tenantId = 'default',
    tenantSlug,
    missionType = 'development',
    visionRef,
    relationships = {},
    rootDir,
  } = args;

  if (!id) {
    logger.error('Usage: mission_controller start <MISSION_ID> [--tier <personal|confidential|public>]');
    logger.info('  Preferred: use named options for tier, persona, type, vision, relationships, and --dry-run.');
    return;
  }

  checkPrerequisites();
  const upperId = id.toUpperCase();
  const normalizedRelationships = normalizeRelationships(relationships);

  let state = loadState(upperId);
  const finalTier = state ? state.tier : tier;

  const force = process.argv.includes('--force');
  if (!force) {
    const prereqs = state?.relationships?.prerequisites || normalizedRelationships?.prerequisites;
    if (prereqs) {
      const missing = prereqs.filter((pre) => {
        const preState = loadState(pre);
        return !preState || preState.status !== 'completed';
      });
      if (missing.length > 0) {
        logger.error(`🚨 Cannot start mission ${upperId}. Prerequisites not met: ${missing.join(', ')}`);
        logger.info('Use --force to bypass this check.');
        return;
      }
    }
  }

  logger.info(`🚀 Activating Mission: ${upperId} (Tier: ${finalTier})...`);

  try {
    if (!state) {
      await createMission({
        id: upperId,
        tier: finalTier,
        tenantId,
        ...(tenantSlug ? { tenantSlug } : {}),
        missionType,
        visionRef,
        persona,
        relationships: normalizedRelationships,
        rootDir,
      });
      state = loadState(upperId);
      if (state) {
        state.status = transitionStatus(state.status, 'active');
        state.history.push({ ts: new Date().toISOString(), event: 'ACTIVATE', note: 'Mission activated.' });
        await saveState(upperId, state);
      }
    } else {
      if (!state.outcome_contract) {
        state.outcome_contract = inferMissionOutcomeContract({
          missionId: upperId,
          missionType: state.mission_type,
          visionRef: state.vision_ref,
        });
      }
      if (normalizedRelationships.project) {
        state.relationships = {
          ...(state.relationships || {}),
          project: {
            ...(state.relationships?.project || {}),
            ...normalizedRelationships.project,
          },
        };
      }
      if (normalizedRelationships.track) {
        state.relationships = {
          ...(state.relationships || {}),
          track: {
            ...(state.relationships?.track || {}),
            ...normalizedRelationships.track,
          },
        };
      }
      state.status = transitionStatus(state.status, 'active');
      state.history.push({ ts: new Date().toISOString(), event: 'RESUME', note: 'Mission resumed.' });
      await saveState(upperId, state);
    }

    await emitMissionLifecycleIntentSnapshot({
      missionId: upperId,
      stage: 'intake',
      text: visionRef || `Start mission ${upperId} (${missionType})`,
      source: 'mission_state',
    });

    const missionPath = findMissionPath(upperId);
    if (missionPath) {
      initMissionRepo(missionPath);
    }

    syncRoleProcedure(upperId, persona);

    ledger.record('MISSION_ACTIVATE', {
      mission_id: upperId,
      branch: state?.git.branch || 'main',
      persona,
    });

    logger.success(`✅ Mission ${upperId} is now ACTIVE (Independent History).`);
  } catch (err: any) {
    logger.error(`Failed to start mission: ${err.message}`);
  }
}
