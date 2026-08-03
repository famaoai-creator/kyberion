import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReaddir, safeRmSync } from './secure-io.js';
import {
  bootstrapManagedProject,
  createManagedProject,
  getProjectManagementView,
  reconcileProjectOperationalState,
} from './project-management.js';
import { loadProjectRecord, saveProjectRecord } from './project-registry.js';

const PROJECT_ID = 'PRJ-PMC-TEST-001';
const BOOTSTRAP_PROJECT_ID = 'PRJ-PMC-TEST-BOOT';
const ORIGINAL_PERSONA = process.env.KYBERION_PERSONA;
const ORIGINAL_ROLE = process.env.MISSION_ROLE;

function cleanupJsonFiles(directory: string, prefix: string): void {
  if (!safeExistsSync(directory)) return;
  for (const entry of safeReaddir(directory)) {
    if (entry.startsWith(prefix) && entry.endsWith('.json')) safeRmSync(`${directory}/${entry}`);
  }
}

function cleanup(): void {
  cleanupJsonFiles(pathResolver.shared('runtime/projects'), 'PRJ-PMC-TEST-');
  cleanupJsonFiles(pathResolver.shared('runtime/task-sessions'), 'TSK-PMC-TEST-');
  cleanupJsonFiles(pathResolver.shared('runtime/mission-seeds'), 'MSD-PMC-TEST-');
  const workspace = pathResolver.projectWorkspaceDir(
    BOOTSTRAP_PROJECT_ID,
    'confidential',
    'shared'
  );
  if (safeExistsSync(workspace)) safeRmSync(workspace);
}

describe('project-management facade', () => {
  beforeEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign';
    cleanup();
  });

  afterEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign';
    cleanup();
    process.env.KYBERION_PERSONA = ORIGINAL_PERSONA;
    process.env.MISSION_ROLE = ORIGINAL_ROLE;
  });

  it('creates a managed Project and repairs registry drift', () => {
    createManagedProject({
      project_id: PROJECT_ID,
      name: 'Project Management Test',
      summary: 'Facade reconciliation fixture.',
      tier: 'confidential',
      status: 'active',
      pipeline_refs: ['pipelines/project-management-validation.json'],
    });

    const view = getProjectManagementView(PROJECT_ID);
    expect(view.lineage.pipelines).toEqual([
      {
        pipeline_id: 'pipelines/project-management-validation.json',
        role: 'replayable_execution_procedure',
      },
    ]);
    expect(view.lineage.role_explanations.task_session).toContain('does not own the Task');

    const drifted = {
      ...loadProjectRecord(PROJECT_ID)!,
      active_missions: ['MSN-STALE'],
      active_tracks: ['TRK-STALE'],
      active_task_sessions: ['TSK-STALE'],
    };
    saveProjectRecord(drifted);

    const report = reconcileProjectOperationalState(PROJECT_ID);
    expect(report.status).toBe('drift');
    expect(report.issues.map((issue) => issue.kind)).toEqual(
      expect.arrayContaining([
        'project_active_missions',
        'project_active_tracks',
        'project_active_task_sessions',
      ])
    );

    const repaired = reconcileProjectOperationalState(PROJECT_ID, { apply: true });
    expect(repaired.status).toBe('repaired');
    expect(loadProjectRecord(PROJECT_ID)?.active_missions).toEqual([]);
    expect(loadProjectRecord(PROJECT_ID)?.active_task_sessions).toEqual([]);
  });

  it('bootstraps a Project with a kickoff Task Session and mission seeds', () => {
    const result = bootstrapManagedProject({
      project_id: BOOTSTRAP_PROJECT_ID,
      name: 'Bootstrap Test Project',
      summary: 'Surface-independent bootstrap fixture.',
      tier: 'confidential',
      utterance: '新しいプロジェクトを始める',
      primary_locale: 'ja-JP',
      service_bindings: ['github'],
    });

    expect(result.project.kickoff_task_session_id).toBe(result.kickoff_task_session.session_id);
    expect(result.project.active_task_sessions).toEqual([result.kickoff_task_session.session_id]);
    expect(result.project.project_os_path).toBeTruthy();
    expect(safeExistsSync(`${result.project.project_os_path}/README.md`)).toBe(true);
    expect(result.mission_seed_ids.length).toBeGreaterThan(0);
    expect(result.kickoff_task_session.project_context?.project_id).toBe(BOOTSTRAP_PROJECT_ID);
  });
});
