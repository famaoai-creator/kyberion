/**
 * scripts/refactor/mission-state.ts
 * State management and prerequisite validation for missions.
 */

import * as path from 'node:path';
import { compileSchema } from './foundation/ajv.js';
import { readJson, readJsonIfPresent } from './foundation/json.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { nowIso } from './foundation/time.js';
import * as pathResolver from './path-resolver.js';
import {
  findMissionPath,
  missionDir as resolveMissionDir,
  tenantMissionDir,
} from './path-resolver.js';
import { logger } from './core.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import { withLock } from './src/lock-utils.js';
import { withFencedWriterLease, writerLeaseResourceId } from './writer-lease.js';
import { resolveActiveProfileRoot } from './profile-root.js';
import { hasAuthority } from './governance.js';
import { type MissionState, type MissionRelationships, ACTIVE_TIERS } from './mission-types.js';
import { loadMissionManagementConfig } from './mission-management-config.js';
import { loadMissionStateAtPath, writeMissionStateAtPath } from './mission-state-reader.js';
let missionStateValidate: ReturnType<typeof compileSchema> | undefined;
const MISSION_FOCUS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/mission-focus.schema.json'
);

function missionFocusCatalog(filePath: string) {
  return defineCatalog<{ mission_id?: string; ts?: string }>({
    id: 'mission-focus',
    path: filePath,
    schema: MISSION_FOCUS_SCHEMA_PATH,
  });
}

function getMissionStateValidator() {
  return (missionStateValidate ??= compileSchema(
    pathResolver.rootResolve('knowledge/product/schemas/mission-state.schema.json')
  ));
}

function assertMissionStateSchema(state: MissionState): void {
  const validate = getMissionStateValidator();
  if (validate(state)) return;
  const errors = Array.isArray(validate.errors)
    ? validate.errors
        .map((entry: any) => `${entry.instancePath || '/'} ${entry.message || 'invalid'}`)
        .join('; ')
    : 'unknown schema error';
  throw new Error(`[MISSION_STATE_SCHEMA] Invalid mission state: ${errors}`);
}

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
      relationship_type:
        overlays.project.relationship_type ||
        relationships.project?.relationship_type ||
        'independent',
      project_id: overlays.project.project_id || relationships.project?.project_id,
      project_path: overlays.project.project_path || relationships.project?.project_path,
      affected_artifacts:
        overlays.project.affected_artifacts || relationships.project?.affected_artifacts || [],
      gate_impact: overlays.project.gate_impact || relationships.project?.gate_impact || 'none',
      traceability_refs:
        overlays.project.traceability_refs || relationships.project?.traceability_refs || [],
      note: overlays.project.note || relationships.project?.note,
    };
  }

  if (overlays.track) {
    relationships.track = {
      relationship_type:
        overlays.track.relationship_type || relationships.track?.relationship_type || 'belongs_to',
      track_id: overlays.track.track_id || relationships.track?.track_id,
      track_name: overlays.track.track_name || relationships.track?.track_name,
      track_type: overlays.track.track_type || relationships.track?.track_type,
      lifecycle_model: overlays.track.lifecycle_model || relationships.track?.lifecycle_model,
      traceability_refs:
        overlays.track.traceability_refs || relationships.track?.traceability_refs || [],
      note: overlays.track.note || relationships.track?.note,
    };
  }

  return relationships;
}

export function readFocusedMissionId(missionFocusPath: string): string | null {
  if (!safeExistsSync(missionFocusPath)) return null;
  try {
    const safePath = assertSafeRepositoryPath(missionFocusPath);
    const parsed = missionFocusCatalog(safePath).load();
    return typeof parsed?.mission_id === 'string' ? parsed.mission_id.toUpperCase() : null;
  } catch (_) {
    return null;
  }
}

export function writeFocusedMissionId(missionFocusPath: string, missionId: string): void {
  const safePath = assertSafeRepositoryPath(missionFocusPath, { allowMissingLeaf: true });
  const value = { mission_id: missionId.toUpperCase(), ts: nowIso() };
  const validated = missionFocusCatalog(safePath).validate(value, safePath);
  safeWriteFile(safePath, JSON.stringify(validated, null, 2));
}

export function checkPrerequisites(): void {
  logger.info('🛡️ Validating Sovereign Prerequisites...');

  const profileRoot = resolveActiveProfileRoot();
  const requiredFiles = ['my-identity.json', 'my-vision.md', 'agent-identity.json'].map((name) =>
    path.join(profileRoot, name)
  );
  const missingFiles = requiredFiles.filter((filePath) => !safeExistsSync(filePath));
  if (missingFiles.length > 0) {
    throw new Error(
      `CRITICAL: Sovereign profile incomplete. Missing: ${missingFiles.map((filePath) => path.basename(filePath)).join(', ')}. ` +
        'Please run "pnpm onboard" (or complete customer onboarding) before creating missions.'
    );
  }

  const tiers = [
    'knowledge/personal/missions',
    'active/missions/confidential',
    'active/missions/public',
  ];
  tiers.forEach((tier) => {
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

export interface KnowledgeInjectionDeclaration {
  tier: 'personal' | 'confidential' | 'public';
  project?: string;
  domains?: string[];
  tags?: string[];
}

/**
 * Mission tier auto-elevation (KC: knowledge-protocol tier inheritance).
 * Each injection declares its own tier directly — no path-sniffing — so the
 * declaration survives knowledge/ directory reorganizations.
 */
export function calculateRequiredTier(
  injections: KnowledgeInjectionDeclaration[] = [],
  requestedTier?: string
): 'personal' | 'confidential' | 'public' {
  const tierWeight: Record<string, number> = {
    public: 1,
    confidential: 3,
    personal: 4,
  };

  let maxWeight = requestedTier ? tierWeight[requestedTier] || 1 : 1;
  let currentTier: 'personal' | 'confidential' | 'public' = (requestedTier as any) || 'public';

  for (const injection of injections) {
    const tier = injection.tier;
    if (tierWeight[tier] > (maxWeight || 0)) {
      maxWeight = tierWeight[tier];
      currentTier = tier;
    }
  }

  return currentTier;
}

function customMissionSearchDirs(rootDir: string): string[] {
  return [
    path.join(rootDir, 'knowledge/personal/missions'),
    path.join(rootDir, 'active/missions/confidential'),
    path.join(rootDir, 'active/missions/public'),
  ];
}

function resolveMissionStatePath(
  id: string,
  options: { rootDir?: string; directories?: string[] } = {}
): string | null {
  const missionPath = options.directories
    ? findMissionPathAtRoot(id, options.rootDir || pathResolver.rootDir(), options.directories)
    : options.rootDir
      ? findMissionPathAtRoot(id, options.rootDir)
      : findMissionPath(id);
  if (!missionPath) return null;
  let statePath: string;
  try {
    statePath = assertSafeRepositoryPath(path.join(missionPath, 'mission-state.json'));
  } catch {
    return null;
  }
  return safeExistsSync(statePath) ? statePath : null;
}

function findMissionPathAtRoot(
  id: string,
  rootDir: string,
  directories = customMissionSearchDirs(rootDir)
): string | null {
  for (const directory of directories) {
    let safeDirectory: string;
    try {
      safeDirectory = assertSafeRepositoryPath(directory, { allowMissingLeaf: true });
    } catch {
      continue;
    }
    const candidate = path.join(safeDirectory, id);
    if (
      safeExistsSync(candidate) &&
      safeLstat(candidate).isDirectory() &&
      safeHistoryPath(candidate)
    )
      return candidate;
    if (!safeExistsSync(safeDirectory) || !safeLstat(safeDirectory).isDirectory()) continue;
    try {
      for (const scopeEntry of safeReaddir(safeDirectory)) {
        const scopedCandidate = path.join(safeDirectory, scopeEntry, id);
        if (
          safeExistsSync(scopedCandidate) &&
          safeLstat(scopedCandidate).isDirectory() &&
          safeHistoryPath(scopedCandidate)
        ) {
          return scopedCandidate;
        }
      }
    } catch (err) {
      logger.warn(`[mission-state] suppressed error in findMissionPathAtRoot: ${err}`);
    }
  }
  return null;
}

function safeHistoryPath(filePath: string): boolean {
  try {
    assertSafeRepositoryPath(filePath);
    return true;
  } catch {
    return false;
  }
}

export function loadState(
  id: string,
  options: { rootDir?: string; directories?: string[] } = {}
): MissionState | null {
  const statePath = resolveMissionStatePath(id, options);
  if (!statePath) return null;
  return loadMissionStateAtPath(statePath);
}

/** Load a mission state from an already resolved repository path. */
export function loadStateAtPath(statePath: string): MissionState | null {
  return loadMissionStateAtPath(statePath);
}

/**
 * Read a legacy state for the explicit repair command. Normal mission
 * callers must use `loadState`, which rejects schema-invalid state before it
 * reaches lifecycle logic.
 */
export function loadStateForRepair(
  id: string,
  options: { rootDir?: string; directories?: string[] } = {}
): MissionState | null {
  const statePath = resolveMissionStatePath(id, options);
  if (!statePath) return null;
  try {
    return readJson<MissionState>(statePath);
  } catch (_) {
    return null;
  }
}

export async function saveState(
  id: string,
  state: MissionState,
  { alreadyLocked = false } = {}
): Promise<void> {
  assertMissionStateSchema(state);
  const tenantDir = state.tenant_slug
    ? tenantMissionDir(id, state.tenant_slug, state.tier)
    : undefined;
  const dir =
    (tenantDir && safeExistsSync(tenantDir) ? tenantDir : undefined) ||
    findMissionPath(id) ||
    tenantDir ||
    resolveMissionDir(id, state.tier);
  const safeDir = assertSafeRepositoryPath(dir, { allowMissingLeaf: true });
  if (!safeExistsSync(safeDir)) safeMkdir(safeDir, { recursive: true });

  const doWrite = async () => {
    const statePath = assertSafeRepositoryPath(path.join(safeDir, 'mission-state.json'), {
      allowMissingLeaf: true,
    });
    writeMissionStateAtPath(statePath, state);
  };

  const leasePath = assertSafeRepositoryPath(
    path.join(safeDir, 'coordination', 'writer-lease.json'),
    {
      allowMissingLeaf: true,
    }
  );
  const doFencedWrite = () =>
    withFencedWriterLease({
      resourceId: writerLeaseResourceId(leasePath),
      ownerId: `process:${process.pid}`,
      leasePath,
      fn: doWrite,
    });

  if (alreadyLocked) {
    await doFencedWrite();
  } else {
    await withLock(`mission-${id}`, doFencedWrite);
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

export function getActiveMissionSearchDirs(rootDir = pathResolver.rootDir()): string[] {
  if (rootDir !== pathResolver.rootDir()) return customMissionSearchDirs(rootDir);
  const config = loadMissionManagementConfig();
  if (config) {
    return ACTIVE_TIERS.map((tier) => config.directories[tier])
      .filter((d): d is string => !!d)
      .map((d) => pathResolver.rootResolve(d));
  }
  return [pathResolver.active('missions')];
}

export function listMissionsInSearchDirs(
  options: { rootDir?: string; directories?: string[] } = {}
): Array<{ missionId: string; missionPath: string }> {
  const missions: Array<{ missionId: string; missionPath: string }> = [];
  const scan = (directory: string, depth: number): void => {
    let safeDirectory: string;
    try {
      safeDirectory = assertSafeRepositoryPath(directory, { allowMissingLeaf: true });
    } catch {
      return;
    }
    if (!safeExistsSync(safeDirectory) || !safeLstat(safeDirectory).isDirectory()) return;
    try {
      if (safeExistsSync(path.join(safeDirectory, 'mission-state.json'))) {
        missions.push({
          missionId: path.basename(safeDirectory),
          missionPath: safeDirectory,
        });
        return;
      }
      if (depth >= 2) return;
      for (const entry of safeReaddir(safeDirectory)) {
        try {
          const candidate = path.join(safeDirectory, entry);
          if (safeLstat(candidate).isDirectory() && safeHistoryPath(candidate)) {
            scan(candidate, depth + 1);
          }
        } catch (err) {
          logger.warn(`[mission-state] suppressed error in listMissionsInSearchDirs: ${err}`);
        }
      }
    } catch (err) {
      logger.warn(`[mission-state] suppressed error in listMissionsInSearchDirs: ${err}`);
    }
  };
  for (const dir of options.directories || getActiveMissionSearchDirs(options.rootDir)) {
    scan(dir, 0);
  }
  return missions;
}

export function listActiveMissions(
  options: { rootDir?: string } = {}
): Array<{ missionId: string; missionPath: string }> {
  return listMissionsInSearchDirs(options).filter(
    ({ missionId }) => loadState(missionId, options)?.status === 'active'
  );
}

export function readJsonFileSafe(filePath: string): any | null {
  try {
    return readJsonIfPresent(assertSafeRepositoryPath(filePath));
  } catch (_) {
    return null;
  }
}
