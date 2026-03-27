/**
 * scripts/refactor/mission-state.ts
 * State management and prerequisite validation for missions.
 */

import * as path from 'node:path';
import {
  findMissionPath,
  logger,
  missionDir as resolveMissionDir,
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
  withLock,
} from '@agent/core';
import { hasAuthority, detectTier } from '@agent/core/governance';
import { type MissionState, type MissionRelationships, ACTIVE_TIERS } from './mission-types.js';

export function assertCanGrantMissionAuthority(): void {
  if (!hasAuthority('SUDO')) {
    throw new Error('Sudo authority is required to grant mission access.');
  }
}

export function normalizeRelationships(
  input: any = {},
  overlays: Partial<MissionRelationships> = {}
): MissionRelationships {
  const relationships: MissionRelationships = { ...(input || {}) };

  if (overlays.project) {
    relationships.project = {
      relationship_type: overlays.project.relationship_type || relationships.project?.relationship_type || 'independent',
      project_id: overlays.project.project_id || relationships.project?.project_id,
      project_path: overlays.project.project_path || relationships.project?.project_path,
      affected_artifacts: overlays.project.affected_artifacts || relationships.project?.affected_artifacts || [],
      gate_impact: overlays.project.gate_impact || relationships.project?.gate_impact || 'none',
      traceability_refs: overlays.project.traceability_refs || relationships.project?.traceability_refs || [],
      note: overlays.project.note || relationships.project?.note,
    };
  }

  return relationships;
}

export function readFocusedMissionId(missionFocusPath: string): string | null {
  if (!safeExistsSync(missionFocusPath)) return null;
  try {
    const raw = safeReadFile(missionFocusPath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw);
    return typeof parsed?.mission_id === 'string' ? parsed.mission_id.toUpperCase() : null;
  } catch (_) {
    return null;
  }
}

export function writeFocusedMissionId(missionFocusPath: string, missionId: string): void {
  safeWriteFile(missionFocusPath, JSON.stringify({
    mission_id: missionId.toUpperCase(),
    ts: new Date().toISOString(),
  }, null, 2));
}

export function checkPrerequisites(): void {
  logger.info('🛡️ Validating Sovereign Prerequisites...');

  const identityPath = pathResolver.knowledge('personal/my-identity.json');
  if (!safeExistsSync(identityPath)) {
    throw new Error('CRITICAL: Sovereign Identity missing. Please run "pnpm onboard" first to establish your identity.');
  }

  const tiers = [
    'knowledge/personal/missions',
    'active/missions/confidential',
    'active/missions/public'
  ];
  tiers.forEach(tier => {
    const fullPath = pathResolver.rootResolve(tier);
    if (!safeExistsSync(fullPath)) {
      logger.warn(`Creating missing tier directory: ${tier}`);
      safeMkdir(fullPath, { recursive: true });
    }
  });

  if (!safeExistsSync(pathResolver.rootResolve('node_modules'))) {
    throw new Error("Missing dependencies. Run 'pnpm install' first.");
  }

  logger.success('✅ Prerequisites satisfied.');
}

export function calculateRequiredTier(
  injections: string[] = [],
  requestedTier?: string
): 'personal' | 'confidential' | 'public' {
  const tierWeight: Record<string, number> = {
    'public': 1,
    'confidential': 3,
    'personal': 4
  };

  let maxWeight = requestedTier ? tierWeight[requestedTier] || 1 : 1;
  let currentTier: 'personal' | 'confidential' | 'public' = (requestedTier as any) || 'public';

  for (const filePath of injections) {
    const tier = detectTier(filePath);
    if (tierWeight[tier] > (maxWeight || 0)) {
      maxWeight = tierWeight[tier];
      currentTier = tier as any;
    }
  }

  return currentTier;
}

export function loadState(id: string): MissionState | null {
  const missionPath = findMissionPath(id);
  if (!missionPath) return null;
  const statePath = path.join(missionPath, 'mission-state.json');
  if (!safeExistsSync(statePath)) return null;
  try {
    const content = safeReadFile(statePath, { encoding: 'utf8' }) as string;
    return JSON.parse(content);
  } catch (_) { return null; }
}

export async function saveState(
  id: string,
  state: MissionState,
  { alreadyLocked = false } = {}
): Promise<void> {
  const dir = findMissionPath(id) || resolveMissionDir(id, state.tier);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });

  const doWrite = async () => {
    safeWriteFile(path.join(dir, 'mission-state.json'), JSON.stringify(state, null, 2));
  };

  if (alreadyLocked) {
    await doWrite();
  } else {
    await withLock(`mission-${id}`, doWrite);
  }
}

export function checkDependencies(missionId: string): { ok: boolean; missing: string[] } {
  const state = loadState(missionId);
  if (!state || !state.relationships?.prerequisites) return { ok: true, missing: [] };

  const missing: string[] = [];
  for (const pre of state.relationships.prerequisites) {
    const preState = loadState(pre);
    if (!preState || preState.status !== 'completed') {
      missing.push(pre);
    }
  }

  return { ok: missing.length === 0, missing };
}

export function getActiveMissionSearchDirs(): string[] {
  const configPath = pathResolver.knowledge('public/governance/mission-management-config.json');
  if (safeExistsSync(configPath)) {
    try {
      const config = JSON.parse(safeReadFile(configPath, { encoding: 'utf8' }) as string);
      const dirs = config.directories || {};
      return ACTIVE_TIERS
        .map(tier => dirs[tier])
        .filter((d): d is string => !!d)
        .map(d => pathResolver.rootResolve(d));
    } catch (_) {}
  }
  return [pathResolver.active('missions')];
}

export function readJsonFileSafe(filePath: string): any | null {
  if (!safeExistsSync(filePath)) return null;
  try {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
  } catch (_) {
    return null;
  }
}
