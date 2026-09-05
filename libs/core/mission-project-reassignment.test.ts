import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { loadProjectRecord, saveProjectRecord } from './project-registry.js';
import { saveProjectTrackRecord } from './project-track-registry.js';
import { saveState, loadState } from './mission-state.js';
import { reassignMissionToProject } from './project-management.js';
import { resolveProjectLedgerPath, syncProjectLedger } from './mission-project-ledger.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeUnlinkSync,
} from './secure-io.js';
import type { MissionState } from './mission-types.js';

const MISSION_ID = 'MSN-PM-TEST-REASSIGN';
const SOURCE_PROJECT_ID = 'PRJ-PM-TEST-SOURCE';
const TARGET_PROJECT_ID = 'PRJ-PM-TEST-TARGET';
const TARGET_TRACK_ID = 'TRK-PM-TEST-TARGET';
const TEST_TENANT = 'tenant-reassignment';
const SOURCE_PATH = `active/projects/confidential/${TEST_TENANT}/${SOURCE_PROJECT_ID}`;
const TARGET_PATH = `active/projects/confidential/${TEST_TENANT}/${TARGET_PROJECT_ID}`;
const ORIGINAL_PERSONA = process.env.KYBERION_PERSONA;
const ORIGINAL_ROLE = process.env.MISSION_ROLE;
const ORIGINAL_TENANT = process.env.KYBERION_TENANT;

function cleanup(): void {
  const missionPath = pathResolver.missionDir(MISSION_ID, 'confidential');
  const sourceWorkspace = pathResolver.projectWorkspaceDir(
    SOURCE_PROJECT_ID,
    'confidential',
    TEST_TENANT
  );
  const targetWorkspace = pathResolver.projectWorkspaceDir(
    TARGET_PROJECT_ID,
    'confidential',
    TEST_TENANT
  );
  for (const filePath of [
    `${pathResolver.shared('runtime/projects')}/${SOURCE_PROJECT_ID}.json`,
    `${pathResolver.shared('runtime/projects')}/${TARGET_PROJECT_ID}.json`,
    `${pathResolver.shared('runtime/project-tracks')}/${TARGET_TRACK_ID}.json`,
  ]) {
    if (safeExistsSync(filePath)) safeRmSync(filePath);
  }
  const tenantMissionPaths = [TEST_TENANT, 'other-tenant'].map((tenant) =>
    pathResolver.tenantMissionDir(MISSION_ID, tenant, 'confidential')
  );
  for (const [index, workspace] of [
    missionPath,
    ...tenantMissionPaths,
    sourceWorkspace,
    targetWorkspace,
  ].entries()) {
    const previousTenant = process.env.KYBERION_TENANT;
    if (index === 2) process.env.KYBERION_TENANT = 'other-tenant';
    if (safeExistsSync(workspace)) safeRmSync(workspace);
    if (previousTenant === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = previousTenant;
  }
}

function fixtureMission(): MissionState {
  return {
    mission_id: MISSION_ID,
    mission_type: 'development',
    tier: 'confidential',
    status: 'paused',
    tenant_slug: TEST_TENANT,
    execution_mode: 'local',
    priority: 1,
    assigned_persona: 'worker',
    confidence_score: 1,
    relationships: {
      project: {
        relationship_type: 'belongs_to',
        project_id: SOURCE_PROJECT_ID,
        project_path: SOURCE_PATH,
        affected_artifacts: ['04_control/mission-ledger.md'],
        gate_impact: 'informational',
        traceability_refs: [],
        note: 'source fixture',
      },
    },
    git: {
      branch: `mission/${MISSION_ID.toLowerCase()}`,
      start_commit: 'fixture-start',
      latest_commit: 'fixture-latest',
      checkpoints: [],
    },
    history: [{ ts: new Date().toISOString(), event: 'CREATE', note: 'fixture' }],
  };
}

describe('mission Project reassignment', () => {
  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign';
    process.env.KYBERION_TENANT = TEST_TENANT;
    cleanup();
    saveProjectRecord({
      project_id: SOURCE_PROJECT_ID,
      name: 'Source Project',
      summary: 'Source fixture.',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'tenant-reassignment',
      repositories: [{ repo_id: 'REPO-SOURCE', kind: 'project-root', root_path: SOURCE_PATH }],
    });
    saveProjectRecord({
      project_id: TARGET_PROJECT_ID,
      name: 'Target Project',
      summary: 'Target fixture.',
      status: 'active',
      tier: 'confidential',
      tenant_slug: 'tenant-reassignment',
      repositories: [{ repo_id: 'REPO-TARGET', kind: 'project-root', root_path: TARGET_PATH }],
    });
  });

  afterEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign';
    cleanup();
    process.env.KYBERION_PERSONA = ORIGINAL_PERSONA;
    process.env.MISSION_ROLE = ORIGINAL_ROLE;
    if (ORIGINAL_TENANT === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = ORIGINAL_TENANT;
  });

  it('moves mission state and both project ledgers through one governed operation', async () => {
    await saveState(MISSION_ID, fixtureMission());
    await syncProjectLedger(MISSION_ID, pathResolver.rootDir());

    const result = await reassignMissionToProject({
      mission_id: MISSION_ID,
      project_id: TARGET_PROJECT_ID,
      note: 'Move to the target project.',
    });

    expect(result).toMatchObject({
      mission_id: MISSION_ID,
      from_project_id: SOURCE_PROJECT_ID,
      to_project_id: TARGET_PROJECT_ID,
      dry_run: false,
    });
    expect(loadState(MISSION_ID)?.relationships?.project?.project_id).toBe(TARGET_PROJECT_ID);
    expect(loadState(MISSION_ID)?.history.at(-1)?.event).toBe('PROJECT_REASSIGNED');
    expect(loadProjectRecord(SOURCE_PROJECT_ID)?.active_missions || []).not.toContain(MISSION_ID);
    expect(loadProjectRecord(TARGET_PROJECT_ID)?.active_missions || []).toContain(MISSION_ID);
    expect(
      safeReadFile(resolveProjectLedgerPath(SOURCE_PATH), { encoding: 'utf8' }) as string
    ).not.toContain(MISSION_ID);
    expect(
      safeReadFile(resolveProjectLedgerPath(TARGET_PATH), { encoding: 'utf8' }) as string
    ).toContain(MISSION_ID);
  });

  it('rejects reassignment across tenant scope even when the mission is paused', async () => {
    process.env.KYBERION_TENANT = 'other-tenant';
    await saveState(MISSION_ID, { ...fixtureMission(), tenant_slug: 'other-tenant' });

    await expect(
      reassignMissionToProject({
        mission_id: MISSION_ID,
        project_id: TARGET_PROJECT_ID,
        project_path: TARGET_PATH,
        dry_run: true,
      })
    ).rejects.toThrow('cross-tier or cross-tenant reassignment is denied');
  });

  it('rejects a target track whose scope does not match the target project', async () => {
    await saveState(MISSION_ID, fixtureMission());
    saveProjectTrackRecord({
      track_id: TARGET_TRACK_ID,
      project_id: TARGET_PROJECT_ID,
      name: 'Wrong tenant track',
      summary: 'Scope mismatch fixture.',
      status: 'active',
      track_type: 'release',
      lifecycle_model: 'continuous_delivery',
      tier: 'confidential',
      tenant_slug: 'other-tenant',
    });

    await expect(
      reassignMissionToProject({
        mission_id: MISSION_ID,
        project_id: TARGET_PROJECT_ID,
        project_path: TARGET_PATH,
        track_id: TARGET_TRACK_ID,
        dry_run: true,
      })
    ).rejects.toThrow('must match project scope');
  });

  it('rejects a project ledger path that traverses a symbolic link', () => {
    const targetPath = pathResolver.sharedTmp(`mission-ledger-target-${process.pid}`);
    const linkPath = pathResolver.sharedTmp(`mission-ledger-link-${process.pid}`);
    safeMkdir(targetPath, { recursive: true });
    safeSymlinkSync(targetPath, linkPath, 'dir');
    try {
      expect(() => resolveProjectLedgerPath(linkPath)).toThrow('[RESOURCE_PATH_SYMLINK]');
    } finally {
      safeUnlinkSync(linkPath);
      safeRmSync(targetPath, { force: true, recursive: true });
    }
  });
});
