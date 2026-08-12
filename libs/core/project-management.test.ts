import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeReaddir,
  safeRmSync,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { createTaskSession, saveTaskSession } from './task-session.js';
import {
  bootstrapManagedProject,
  createManagedProjectTrack,
  createManagedProject,
  getProjectManagementView,
  reconcileProjectOperationalState,
} from './project-management.js';
import { loadProjectRecord, saveProjectRecord } from './project-registry.js';
import { saveProjectTrackRecord } from './project-track-registry.js';
import { saveState } from './mission-state.js';
import type { MissionState } from './mission-types.js';

const PROJECT_ID = 'PRJ-PMC-TEST-001';
const BOOTSTRAP_PROJECT_ID = 'PRJ-PMC-TEST-BOOT';
const CALLBACK_ROOT = pathResolver.sharedTmp('project-management-callback-test');
const ORIGINAL_PERSONA = process.env.KYBERION_PERSONA;
const ORIGINAL_ROLE = process.env.MISSION_ROLE;

function cleanupJsonFiles(directory: string, prefix: string): void {
  if (!safeExistsSync(directory)) return;
  for (const entry of safeReaddir(directory)) {
    if (entry.startsWith(prefix) && entry.endsWith('.json')) safeRmSync(`${directory}/${entry}`);
  }
}

function cleanup(): void {
  cleanupJsonFiles(pathResolver.shared('runtime/projects'), 'PRJ-PMC-');
  cleanupJsonFiles(pathResolver.shared('runtime/project-tracks'), 'TRK-PMC-');
  cleanupJsonFiles(pathResolver.shared('runtime/task-sessions'), 'TSK-PMC-TEST-');
  cleanupJsonFiles(pathResolver.shared('runtime/mission-seeds'), 'MSD-PMC-TEST-');
  safeRmSync(CALLBACK_ROOT, { recursive: true, force: true });
  const foreignMissionPath = pathResolver.missionDir('MSN-PMC-FOREIGN', 'confidential');
  if (safeExistsSync(foreignMissionPath))
    safeRmSync(foreignMissionPath, { recursive: true, force: true });
  const workspace = pathResolver.projectWorkspaceDir(
    BOOTSTRAP_PROJECT_ID,
    'confidential',
    'tenant-pmc-test'
  );
  if (safeExistsSync(workspace)) safeRmSync(workspace);
  const sharedWorkspace = pathResolver.projectWorkspaceDir(
    BOOTSTRAP_PROJECT_ID,
    'confidential',
    'shared'
  );
  if (safeExistsSync(sharedWorkspace)) safeRmSync(sharedWorkspace);
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
      organization_id: 'ORG-PMC-TEST',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
      pipeline_refs: ['pipelines/project-management-validation.json'],
    });

    const view = getProjectManagementView(PROJECT_ID);
    expect(view.project).toMatchObject({
      organization_id: 'ORG-PMC-TEST',
      tenant_slug: 'tenant-pmc-test',
    });
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
      tenant_slug: 'tenant-pmc-test',
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
    expect(result.kickoff_task_session.project_context?.tenant_slug).toBe('tenant-pmc-test');
    expect(
      getProjectManagementView(BOOTSTRAP_PROJECT_ID).operational_states.map(
        (state) => state.tenant_slug || 'shared'
      )
    ).toEqual(['tenant-pmc-test']);
  });

  it('creates a release track through the project facade and makes it the default track', () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-TRACK',
      name: 'Track Test Project',
      summary: 'Project track fixture.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });

    const track = createManagedProjectTrack({
      track_id: 'TRK-PMC-RELEASE',
      project_id: project.project_id,
      name: 'Product Release',
      summary: 'Release delivery slice.',
    });

    expect(track).toMatchObject({
      project_id: project.project_id,
      track_type: 'release',
      lifecycle_model: 'continuous_delivery',
      tier: 'confidential',
      status: 'active',
    });
    expect(loadProjectRecord(project.project_id)).toMatchObject({
      default_track_id: track.track_id,
      active_tracks: [track.track_id],
    });
  });

  it('does not expose or reconcile an unscoped confidential project session', () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-UNSCOPED',
      name: 'Unscoped Session Project',
      summary: 'Rejects ambiguous confidential session scope.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    const session = createTaskSession({
      sessionId: 'TSK-PMC-TEST-UNSCOPED',
      surface: 'project-controller',
      taskType: 'analysis',
      status: 'planning',
      goal: { summary: 'Ambiguous session', success_condition: 'Rejected from tenant scope' },
      projectContext: { project_id: project.project_id, tier: 'confidential' },
    });
    saveTaskSession(session);

    expect(getProjectManagementView(project.project_id).task_sessions).toEqual([]);
    const report = reconcileProjectOperationalState(project.project_id);
    expect(report.expected.active_task_sessions).toEqual([]);
    expect(report.issues).toContainEqual(
      expect.objectContaining({
        kind: 'out_of_scope_task_session',
        actual: [session.session_id],
      })
    );
  });

  it('does not assign a paused track as the project default', () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-PAUSED-TRACK',
      name: 'Paused Track Project',
      summary: 'Paused track fixture.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });

    createManagedProjectTrack({
      track_id: 'TRK-PMC-PAUSED',
      project_id: project.project_id,
      name: 'Paused Release',
      summary: 'Paused release lane.',
      status: 'paused',
    });

    expect(loadProjectRecord(project.project_id)?.default_track_id).toBeUndefined();
  });

  it('excludes foreign project tracks and missions from view and reconciliation', async () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-FOREIGN',
      name: 'Foreign Scope Project',
      summary: 'Foreign scope fixture.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    saveProjectTrackRecord({
      track_id: 'TRK-PMC-FOREIGN',
      project_id: project.project_id,
      name: 'Foreign Track',
      summary: 'Foreign tenant track.',
      status: 'active',
      track_type: 'release',
      lifecycle_model: 'continuous_delivery',
      tier: 'confidential',
      tenant_slug: 'other-tenant',
    });
    const mission: MissionState = {
      mission_id: 'MSN-PMC-FOREIGN',
      mission_type: 'development',
      tier: 'confidential',
      status: 'paused',
      tenant_slug: 'other-tenant',
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'worker',
      confidence_score: 1,
      relationships: {
        project: {
          relationship_type: 'belongs_to',
          project_id: project.project_id,
          project_path: `active/projects/confidential/tenant-pmc-test/${project.project_id}`,
          affected_artifacts: [],
          gate_impact: 'informational',
          traceability_refs: [],
        },
      },
      git: {
        branch: 'mission/msn-pmc-foreign',
        start_commit: 'fixture',
        latest_commit: 'fixture',
        checkpoints: [],
      },
      history: [{ ts: new Date().toISOString(), event: 'CREATE', note: 'fixture' }],
    };
    await saveState(mission.mission_id, mission);

    const view = getProjectManagementView(project.project_id);
    expect(view.tracks).toEqual([]);
    expect(view.missions).toEqual([]);
    const report = reconcileProjectOperationalState(project.project_id);
    expect(report.expected.active_missions).toEqual([]);
    expect(report.expected.active_tracks).toEqual([]);
    expect(report.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'out_of_scope_mission', actual: [mission.mission_id] }),
        expect.objectContaining({ kind: 'out_of_scope_track', actual: ['TRK-PMC-FOREIGN'] }),
      ])
    );
  });

  it('runs the rollback hook when the commit callback fails after a partial write', () => {
    const marker = `${CALLBACK_ROOT}/partial-callback.txt`;
    let rollbackCalled = false;

    expect(() =>
      bootstrapManagedProject({
        project_id: 'PRJ-PMC-TEST-CALLBACK',
        name: 'Callback Rollback Test',
        summary: 'The callback contract must compensate partial writes.',
        tier: 'confidential',
        tenant_slug: 'tenant-pmc-test',
        rootDir: CALLBACK_ROOT,
        onCommit: () => {
          safeWriteFile(marker, 'partial');
          throw new Error('callback failed');
        },
        onRollback: () => {
          rollbackCalled = true;
          safeUnlinkSync(marker);
        },
      })
    ).toThrow('callback failed');

    expect(rollbackCalled).toBe(true);
    expect(safeExistsSync(marker)).toBe(false);
    expect(loadProjectRecord('PRJ-PMC-TEST-CALLBACK', { rootDir: CALLBACK_ROOT })).toBeNull();
  });
});
