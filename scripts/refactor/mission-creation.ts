/**
 * scripts/refactor/mission-creation.ts
 * Mission creation and activation helpers.
 */

import * as path from 'node:path';
import {
  composeMissionTeamPlan,
  findMissionPath,
  ledger,
  logger,
  missionDir as resolveMissionDir,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  transitionStatus,
  writeMissionTeamPlan,
} from '@agent/core';
import { getCurrentBranch, getGitHash, initMissionRepo } from './mission-git.js';
import { calculateRequiredTier, checkPrerequisites, loadState, normalizeRelationships, saveState } from './mission-state.js';
import { syncRoleProcedure } from './mission-governance.js';
import type { MissionState } from './mission-types.js';

export async function createMission(
  args: {
    id: string;
    tier?: 'personal' | 'confidential' | 'public';
    tenantId?: string;
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
    missionType = 'development',
    visionRef,
    persona = 'Ecosystem Architect',
    relationships = {},
    rootDir,
  } = args;

  const upperId = id.toUpperCase();
  const isEphemeral = process.argv.includes('--ephemeral');
  const normalizedRelationships = normalizeRelationships(relationships);
  const templatePath = pathResolver.knowledge('public/governance/mission-templates.json');
  const templates = JSON.parse(safeReadFile(templatePath, { encoding: 'utf8' }) as string).templates;
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
    priority: 3,
    assigned_persona: persona,
    confidence_score: 1.0,
    git: {
      branch: missionBranch,
      start_commit: missionGitHash,
      latest_commit: missionGitHash,
      checkpoints: [],
    },
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
    missionType = 'development',
    visionRef,
    relationships = {},
    rootDir,
  } = args;

  if (!id) {
    logger.error('Usage: mission_controller start <MISSION_ID> [tier]');
    logger.info('  Tiers: personal | confidential | public (default: confidential)');
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
      if (normalizedRelationships.project) {
        state.relationships = {
          ...(state.relationships || {}),
          project: {
            ...(state.relationships?.project || {}),
            ...normalizedRelationships.project,
          },
        };
      }
      state.status = transitionStatus(state.status, 'active');
      state.history.push({ ts: new Date().toISOString(), event: 'RESUME', note: 'Mission resumed.' });
      await saveState(upperId, state);
    }

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
