import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { loadProjectRecord, saveProjectRecord } from './project-registry.js';
import { saveState, loadState } from './mission-state.js';
import { reassignMissionToProject } from './project-management.js';
import { resolveProjectLedgerPath, syncProjectLedger } from './mission-project-ledger.js';
import { safeExistsSync, safeReadFile, safeRmSync } from './secure-io.js';
import type { MissionState } from './mission-types.js';

const MISSION_ID = 'MSN-PM-TEST-REASSIGN';
const SOURCE_PROJECT_ID = 'PRJ-PM-TEST-SOURCE';
const TARGET_PROJECT_ID = 'PRJ-PM-TEST-TARGET';
const SOURCE_PATH = `active/projects/confidential/shared/${SOURCE_PROJECT_ID}`;
const TARGET_PATH = `active/projects/confidential/shared/${TARGET_PROJECT_ID}`;
const ORIGINAL_PERSONA = process.env.KYBERION_PERSONA;
const ORIGINAL_ROLE = process.env.MISSION_ROLE;

function cleanup(): void {
  const missionPath = pathResolver.missionDir(MISSION_ID, 'confidential');
  const sourceWorkspace = pathResolver.projectWorkspaceDir(
    SOURCE_PROJECT_ID,
    'confidential',
    'shared'
  );
  const targetWorkspace = pathResolver.projectWorkspaceDir(
    TARGET_PROJECT_ID,
    'confidential',
    'shared'
  );
  for (const filePath of [
    `${pathResolver.shared('runtime/projects')}/${SOURCE_PROJECT_ID}.json`,
    `${pathResolver.shared('runtime/projects')}/${TARGET_PROJECT_ID}.json`,
  ]) {
    if (safeExistsSync(filePath)) safeRmSync(filePath);
  }
  for (const workspace of [missionPath, sourceWorkspace, targetWorkspace]) {
    if (safeExistsSync(workspace)) safeRmSync(workspace);
  }
}

function fixtureMission(): MissionState {
  return {
    mission_id: MISSION_ID,
    mission_type: 'development',
    tier: 'confidential',
    status: 'paused',
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
    cleanup();
    saveProjectRecord({
      project_id: SOURCE_PROJECT_ID,
      name: 'Source Project',
      summary: 'Source fixture.',
      status: 'active',
      tier: 'confidential',
      repositories: [{ repo_id: 'REPO-SOURCE', kind: 'project-root', root_path: SOURCE_PATH }],
    });
    saveProjectRecord({
      project_id: TARGET_PROJECT_ID,
      name: 'Target Project',
      summary: 'Target fixture.',
      status: 'active',
      tier: 'confidential',
      repositories: [{ repo_id: 'REPO-TARGET', kind: 'project-root', root_path: TARGET_PATH }],
    });
  });

  afterEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign';
    cleanup();
    process.env.KYBERION_PERSONA = ORIGINAL_PERSONA;
    process.env.MISSION_ROLE = ORIGINAL_ROLE;
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
});
