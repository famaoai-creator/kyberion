import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '../path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeRmdirSync,
  safeRmSync,
  safeUnlinkSync,
  safeWriteFile,
} from '../secure-io.js';
import { createTaskSession, saveTaskSession } from '../task/task-session.js';
import {
  bootstrapManagedProject,
  createManagedProjectTrack,
  createManagedProject,
  ensureProjectOsScaffold,
  getProjectManagementView,
  listManagedProjects,
  loadProjectOperatingSystemArtifactMap,
  reconcileProjectOperationalState,
  archiveManagedProject,
  restoreManagedProject,
  updateManagedProject,
  updateManagedProjectTrack,
} from './project-management.js';
import { loadProjectRecord, saveProjectRecord } from './project-registry.js';
import { saveProjectOperationalState } from './project-operational-state-registry.js';
import { saveProjectTrackRecord } from './project-track-registry.js';
import { saveState } from '../mission/mission-state.js';
import { withExecutionContextAsync } from '../authority.js';
import { auditChain } from '../governance/audit-chain.js';
import * as organizationOperatingModel from '../organization/organization-operating-model.js';
import type { MissionState } from '../mission/mission-types.js';
import {
  clearWorkCoordinationNamespace,
  clearWorkCoordinationStore,
  createWorkItem,
  setWorkCoordinationNamespace,
} from '../workforce/work-coordination.js';

const PROJECT_ID = 'PRJ-PMC-TEST-001';
const TRACK_PROJECT_ID = 'PRJ-PMC-TRACK';
const BOOTSTRAP_PROJECT_ID = 'PRJ-PMC-TEST-BOOT';
const CALLBACK_ROOT = pathResolver.sharedTmp('project-management-callback-test');
const PERSISTED_SCOPE_ENV_PATH = pathResolver.sharedTmp('project-management-worker-scope.env');
const ORIGINAL_PERSONA = process.env.KYBERION_PERSONA;
const ORIGINAL_ROLE = process.env.MISSION_ROLE;
const ORIGINAL_TENANT = process.env.KYBERION_TENANT;
const ORIGINAL_PROJECT_ID = process.env.KYBERION_PROJECT_ID;
const ORIGINAL_MISSION_ID = process.env.MISSION_ID;
const ORIGINAL_SCOPE_ENV_PATH = process.env.KYBERION_SCOPE_ENV_PATH;

function cleanupJsonFiles(directory: string, prefix: string): void {
  if (!safeExistsSync(directory)) return;
  for (const entry of safeReaddir(directory)) {
    if (entry.startsWith(prefix) && entry.endsWith('.json')) safeRmSync(`${directory}/${entry}`);
  }
}

function cleanup(): void {
  const lifecycleWorkspace = pathResolver.projectWorkspaceDir(
    PROJECT_ID,
    'confidential',
    'tenant-pmc-test'
  );
  safeRmSync(lifecycleWorkspace, { recursive: true, force: true });
  const tenantWorkspace = path.dirname(lifecycleWorkspace);
  if (safeExistsSync(tenantWorkspace) && safeReaddir(tenantWorkspace).length === 0)
    safeRmdirSync(tenantWorkspace);
  safeRmSync(PERSISTED_SCOPE_ENV_PATH, { force: true });
  cleanupJsonFiles(pathResolver.shared('runtime/projects'), 'PRJ-PMC-');
  cleanupJsonFiles(pathResolver.shared('runtime/project-tracks'), 'TRK-PMC-');
  cleanupJsonFiles(pathResolver.shared('runtime/task-sessions'), 'TSK-PMC-TEST-');
  cleanupJsonFiles(pathResolver.shared('runtime/mission-seeds'), 'MSD-PMC-TEST-');
  safeRmSync(CALLBACK_ROOT, { recursive: true, force: true });
  const foreignMissionPath = pathResolver.missionDir('MSN-PMC-FOREIGN', 'confidential');
  if (safeExistsSync(foreignMissionPath))
    safeRmSync(foreignMissionPath, { recursive: true, force: true });
  safeRmSync(
    pathResolver.tenantMissionDir('MSN-PMC-LIFECYCLE', 'tenant-pmc-test', 'confidential'),
    { recursive: true, force: true }
  );
  const workerMissionPath = pathResolver.tenantMissionDir(
    'MSN-PMC-WORKER-SCOPE',
    'tenant-pmc-test',
    'confidential'
  );
  if (safeExistsSync(workerMissionPath))
    safeRmSync(workerMissionPath, { recursive: true, force: true });
  const persistedWorkerMissionPath = pathResolver.tenantMissionDir(
    'MSN-PMC-PERSISTED-WORKER',
    'tenant-pmc-test',
    'confidential'
  );
  if (safeExistsSync(persistedWorkerMissionPath))
    safeRmSync(persistedWorkerMissionPath, { recursive: true, force: true });
  for (const tenant of ['tenant-pmc-test', 'other-tenant']) {
    const tenantMissionPath = pathResolver.tenantMissionDir(
      'MSN-PMC-FOREIGN',
      tenant,
      'confidential'
    );
    if (safeExistsSync(tenantMissionPath)) {
      const previousTenant = process.env.KYBERION_TENANT;
      process.env.KYBERION_TENANT = tenant;
      safeRmSync(tenantMissionPath, { recursive: true, force: true });
      if (previousTenant === undefined) delete process.env.KYBERION_TENANT;
      else process.env.KYBERION_TENANT = previousTenant;
    }
  }
  for (const tier of ['personal', 'confidential'] as const) {
    const collisionPath = pathResolver.missionDir('MSN-PMC-TIER-COLLISION', tier);
    if (safeExistsSync(collisionPath)) safeRmSync(collisionPath, { recursive: true, force: true });
  }
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

  const trackProjectWorkspace = pathResolver.projectWorkspaceDir(
    TRACK_PROJECT_ID,
    'confidential',
    'tenant-pmc-test'
  );
  if (safeExistsSync(trackProjectWorkspace)) {
    safeRmSync(trackProjectWorkspace, { recursive: true, force: true });
  }
  const sharedProjectWorkspace = pathResolver.projectWorkspaceDir(
    'PRJ-PMC-SHARED',
    'public',
    'shared'
  );
  if (safeExistsSync(sharedProjectWorkspace)) {
    safeRmSync(sharedProjectWorkspace, { recursive: true, force: true });
  }
}

describe('project-management facade', () => {
  function lifecycleProject() {
    return createManagedProject({
      project_id: PROJECT_ID,
      name: 'Lifecycle',
      summary: 'Lifecycle fixture',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
  }
  beforeEach(() => {
    setWorkCoordinationNamespace('project-management-facade-test');
    clearWorkCoordinationStore();
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign';
    process.env.KYBERION_TENANT = 'tenant-pmc-test';
    cleanup();
  });

  afterEach(() => {
    process.env.KYBERION_PERSONA = 'sovereign';
    process.env.MISSION_ROLE = 'sovereign';
    process.env.KYBERION_TENANT = 'tenant-pmc-test';
    clearWorkCoordinationStore();
    clearWorkCoordinationNamespace();
    cleanup();
    process.env.KYBERION_PERSONA = ORIGINAL_PERSONA;
    process.env.MISSION_ROLE = ORIGINAL_ROLE;
    if (ORIGINAL_TENANT === undefined) delete process.env.KYBERION_TENANT;
    else process.env.KYBERION_TENANT = ORIGINAL_TENANT;
    if (ORIGINAL_PROJECT_ID === undefined) delete process.env.KYBERION_PROJECT_ID;
    else process.env.KYBERION_PROJECT_ID = ORIGINAL_PROJECT_ID;
    if (ORIGINAL_MISSION_ID === undefined) delete process.env.MISSION_ID;
    else process.env.MISSION_ID = ORIGINAL_MISSION_ID;
    if (ORIGINAL_SCOPE_ENV_PATH === undefined) delete process.env.KYBERION_SCOPE_ENV_PATH;
    else process.env.KYBERION_SCOPE_ENV_PATH = ORIGINAL_SCOPE_ENV_PATH;
  });

  it('uses the same archive guard for dedicated and generic updates', () => {
    lifecycleProject();
    createManagedProjectTrack({
      project_id: PROJECT_ID,
      track_id: 'TRK-PMC-LIFECYCLE',
      name: 'Track',
      summary: 'Delivery',
    });
    expect(() => archiveManagedProject(PROJECT_ID)).toThrow(
      'Complete or archive project tracks first'
    );
    expect(() =>
      updateManagedProject(PROJECT_ID, { status: 'archived', name: 'Rejected' })
    ).toThrow('Complete or archive project tracks first');
    expect(loadProjectRecord(PROJECT_ID)?.name).toBe('Lifecycle');
  });

  it('edits archived metadata and restores explicitly with synchronized state', () => {
    lifecycleProject();
    saveProjectOperationalState({
      project_id: PROJECT_ID,
      name: 'Lifecycle',
      summary: 'Lifecycle fixture',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    archiveManagedProject(PROJECT_ID);
    expect(updateManagedProject(PROJECT_ID, { metadata: { note: 'Retained' } }).status).toBe(
      'archived'
    );
    expect(() => updateManagedProject(PROJECT_ID, { status: 'active' })).toThrow(
      'explicit lifecycle operation'
    );
    expect(restoreManagedProject(PROJECT_ID).status).toBe('active');
    const view = getProjectManagementView(PROJECT_ID);
    expect(view.project.metadata?.note).toBe('Retained');
    expect(view.operational_states.every((state) => state.status === 'active')).toBe(true);
    expect(() => restoreManagedProject(PROJECT_ID)).toThrow('not archived');
  });

  it('keeps live task sessions reachable through project and track lifecycle guards', () => {
    lifecycleProject();
    const trackId = 'TRK-PMC-LIFECYCLE';
    createManagedProjectTrack({
      project_id: PROJECT_ID,
      track_id: trackId,
      name: 'Track',
      summary: 'Delivery',
    });
    saveTaskSession(
      createTaskSession({
        sessionId: 'TSK-PMC-TEST-LIFECYCLE',
        surface: 'project-controller',
        taskType: 'analysis',
        status: 'paused',
        goal: { summary: 'Paused delivery', success_condition: 'Delivery resumed' },
        projectContext: {
          project_id: PROJECT_ID,
          track_id: trackId,
          tenant_slug: 'tenant-pmc-test',
          tier: 'confidential',
        },
      })
    );
    expect(() => archiveManagedProject(PROJECT_ID)).toThrow('active task sessions');
    expect(() => updateManagedProject(PROJECT_ID, { status: 'archived' })).toThrow(
      'active task sessions'
    );
    expect(() => updateManagedProjectTrack(trackId, { status: 'completed' })).toThrow(
      'active task sessions'
    );
    expect(loadProjectRecord(PROJECT_ID)?.status).toBe('active');
  });

  it('blocks both archive paths with a live mission and denies worker lifecycle writes', async () => {
    lifecycleProject();
    const mission: MissionState = {
      mission_id: 'MSN-PMC-LIFECYCLE',
      mission_type: 'development',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'worker',
      confidence_score: 1,
      relationships: { project: { project_id: PROJECT_ID } },
      git: {
        branch: 'mission/lifecycle',
        start_commit: 'fixture',
        latest_commit: 'fixture',
        checkpoints: [],
      },
      history: [],
    };
    await saveState(mission.mission_id, mission);
    expect(() => archiveManagedProject(PROJECT_ID)).toThrow('active missions');
    expect(() => updateManagedProject(PROJECT_ID, { status: 'archived' })).toThrow(
      'active missions'
    );
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'worker';
    process.env.KYBERION_PROJECT_ID = PROJECT_ID;
    process.env.MISSION_ID = mission.mission_id;
    expect(() => updateManagedProject(PROJECT_ID, { status: 'archived' })).toThrow('mission owner');
    expect(() =>
      createManagedProjectTrack({
        project_id: PROJECT_ID,
        track_id: 'TRK-PMC-LIFECYCLE',
        name: 'Denied',
        summary: 'Denied',
      })
    ).toThrow('mission owner');
  });

  it('rolls back project and operational state if lifecycle audit fails', () => {
    lifecycleProject();
    saveProjectOperationalState({
      project_id: PROJECT_ID,
      name: 'Lifecycle',
      summary: 'Lifecycle fixture',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    const failAudit = vi.spyOn(auditChain, 'record').mockImplementation(() => {
      throw new Error('audit unavailable');
    });
    try {
      expect(() => archiveManagedProject(PROJECT_ID)).toThrow('audit unavailable');
      expect(loadProjectRecord(PROJECT_ID)?.status).toBe('active');
      expect(
        getProjectManagementView(PROJECT_ID).operational_states.every(
          (state) => state.status === 'active'
        )
      ).toBe(true);
    } finally {
      failAudit.mockRestore();
    }
  });

  it('requires an active scoped organization before restoring its project', () => {
    const project = lifecycleProject();
    saveProjectRecord({ ...project, organization_id: 'ORG-PMC-TEST', status: 'archived' });
    const organization = vi
      .spyOn(organizationOperatingModel, 'loadOrganizationOperationalState')
      .mockReturnValue({ status: 'paused' } as never);
    try {
      expect(() => restoreManagedProject(PROJECT_ID)).toThrow('Activate organization');
      expect(organization).toHaveBeenCalledWith('ORG-PMC-TEST', {
        tier: 'confidential',
        tenantSlug: 'tenant-pmc-test',
      });
      expect(loadProjectRecord(PROJECT_ID)?.status).toBe('archived');
    } finally {
      organization.mockRestore();
    }
  });

  it('updates track requirements and reconciles lifecycle and default references', () => {
    lifecycleProject();
    const trackId = 'TRK-PMC-LIFECYCLE';
    createManagedProjectTrack({
      project_id: PROJECT_ID,
      track_id: trackId,
      name: 'Track',
      summary: 'Delivery',
    });
    updateManagedProjectTrack(trackId, { name: 'Revised', required_artifacts: ['report'] });
    expect(getProjectManagementView(PROJECT_ID).tracks[0].required_artifacts).toEqual(['report']);
    updateManagedProjectTrack(trackId, { status: 'paused' });
    expect(loadProjectRecord(PROJECT_ID)?.default_track_id).toBeUndefined();
    expect(loadProjectRecord(PROJECT_ID)?.active_tracks).toEqual([]);
    updateManagedProjectTrack(trackId, { status: 'active' });
    expect(loadProjectRecord(PROJECT_ID)?.default_track_id).toBe(trackId);
    updateManagedProjectTrack(trackId, { status: 'completed' });
    expect(() => updateManagedProjectTrack(trackId, { status: 'active' })).toThrow(
      'Invalid track transition'
    );
    updateManagedProjectTrack(trackId, { status: 'archived' });
    expect(archiveManagedProject(PROJECT_ID).status).toBe('archived');
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

  it('repairs a shared-scope public project without serializing tenant_slug "shared"', () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-SHARED',
      name: 'Shared Scope Project',
      summary: 'Tenantless public project fixture.',
      tier: 'public',
      status: 'active',
    });
    createManagedProjectTrack({
      track_id: 'TRK-PMC-SHARED',
      project_id: project.project_id,
      name: 'Shared Track',
      summary: 'Active track fixture in the shared scope.',
    });
    saveProjectRecord({
      ...loadProjectRecord(project.project_id)!,
      active_missions: ['MSN-STALE'],
    });

    const repaired = reconcileProjectOperationalState(project.project_id, { apply: true });
    expect(repaired.status).toBe('repaired');
    const view = getProjectManagementView(project.project_id);
    const sharedState = view.operational_states.find(
      (state) => (state.tenant_slug || 'shared') === 'shared'
    );
    expect(sharedState).toBeTruthy();
    expect(sharedState?.tenant_slug).not.toBe('shared');
  });

  it('projects tenant-scoped canonical WorkItems and their live status into the Project view', () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-CANONICAL-WORK',
      name: 'Canonical Work Project',
      summary: 'Project view follows canonical WorkItem state.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    const workItem = createWorkItem({
      itemId: 'work-pmc-canonical',
      title: 'Canonical task status',
      description: 'The status is maintained by the canonical WorkItem.',
      projectId: project.project_id,
      status: 'in_progress',
      context: {
        tenant_slug: 'tenant-pmc-test',
        project_id: project.project_id,
        task_id: 'TASK-PMC-CANONICAL',
      },
    });
    process.env.KYBERION_TENANT = 'other-tenant';
    try {
      createWorkItem({
        itemId: 'work-pmc-foreign-tenant',
        title: 'Foreign tenant task',
        description: 'Same project id in another tenant must not appear.',
        projectId: project.project_id,
        context: {
          tenant_slug: 'other-tenant',
          project_id: project.project_id,
          task_id: 'TASK-PMC-FOREIGN',
        },
      });
    } finally {
      process.env.KYBERION_TENANT = 'tenant-pmc-test';
    }

    const view = getProjectManagementView(project.project_id);

    expect(view.work_items.map((item) => item.item_id)).toEqual([workItem.item_id]);
    expect(view.lineage.tasks).toEqual([
      expect.objectContaining({
        work_id: 'TASK-PMC-CANONICAL',
        title: 'Canonical task status',
        status: 'in_progress',
        role: 'work_item',
      }),
    ]);
  });

  it('limits worker project and mission views to the bound project, tenant, and mission', async () => {
    const ownProject = createManagedProject({
      project_id: 'PRJ-PMC-WORKER-OWN',
      name: 'Worker Own Project',
      summary: 'Worker has one explicit project scope.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    const otherProject = createManagedProject({
      project_id: 'PRJ-PMC-WORKER-OTHER',
      name: 'Other Worker Project',
      summary: 'Another project must remain outside worker scope.',
      tier: 'confidential',
      tenant_slug: 'other-tenant',
      status: 'active',
    });
    const mission: MissionState = {
      mission_id: 'MSN-PMC-WORKER-SCOPE',
      mission_type: 'development',
      tier: 'confidential',
      status: 'active',
      tenant_slug: 'tenant-pmc-test',
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'worker',
      confidence_score: 1,
      relationships: { project: { project_id: ownProject.project_id } },
      git: {
        branch: 'mission/worker-scope',
        start_commit: 'fixture',
        latest_commit: 'fixture',
        checkpoints: [],
      },
      history: [{ ts: new Date().toISOString(), event: 'CREATE', note: 'fixture' }],
    };
    await saveState(mission.mission_id, mission);
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'worker';
    process.env.KYBERION_TENANT = 'tenant-pmc-test';
    process.env.KYBERION_PROJECT_ID = ownProject.project_id;
    process.env.MISSION_ID = mission.mission_id;

    expect(listManagedProjects().map((view) => view.project.project_id)).toEqual([
      ownProject.project_id,
    ]);
    expect(getProjectManagementView(ownProject.project_id).project.project_id).toBe(
      ownProject.project_id
    );
    expect(getProjectManagementView(ownProject.project_id).missions).toEqual([
      expect.objectContaining({ mission_id: mission.mission_id }),
    ]);
    expect(() => getProjectManagementView(otherProject.project_id)).toThrow(
      '[PROJECT_SCOPE_VIOLATION]'
    );
  });

  it('resolves worker project, tenant, and mission access from the governed persisted scope', async () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-WORKER-PERSISTED',
      name: 'Persisted Scope Project',
      summary: 'Worker scope can be persisted by pnpm scope use.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    const mission: MissionState = {
      mission_id: 'MSN-PMC-PERSISTED-WORKER',
      mission_type: 'development',
      tier: 'confidential',
      status: 'active',
      tenant_slug: 'tenant-pmc-test',
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'worker',
      confidence_score: 1,
      relationships: { project: { project_id: project.project_id } },
      git: {
        branch: 'mission/persisted-worker-scope',
        start_commit: 'fixture',
        latest_commit: 'fixture',
        checkpoints: [],
      },
      history: [{ ts: new Date().toISOString(), event: 'CREATE', note: 'fixture' }],
    };
    await saveState(mission.mission_id, mission);
    process.env.KYBERION_SCOPE_ENV_PATH = PERSISTED_SCOPE_ENV_PATH;
    delete process.env.KYBERION_PROJECT_ID;
    delete process.env.MISSION_ID;
    safeWriteFile(
      PERSISTED_SCOPE_ENV_PATH,
      `KYBERION_PROJECT_ID=${project.project_id}\nKYBERION_TENANT=tenant-pmc-test\nMISSION_ID=${mission.mission_id}\n`
    );
    delete process.env.KYBERION_TENANT;

    await withExecutionContextAsync(
      'mission_controller',
      async () => {
        expect(listManagedProjects().map((view) => view.project.project_id)).toEqual([
          project.project_id,
        ]);
        expect(getProjectManagementView(project.project_id).missions).toEqual([
          expect.objectContaining({ mission_id: mission.mission_id }),
        ]);
        expect(() => getProjectManagementView('PRJ-PMC-WORKER-OTHER')).toThrow(
          '[PROJECT_SCOPE_VIOLATION]'
        );
      },
      'worker'
    );
  });

  it('denies workers access to a matching personal project scope', () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-WORKER-PERSONAL',
      name: 'Personal Project Boundary',
      summary: 'Personal projects are outside worker project scope.',
      tier: 'personal',
      status: 'active',
    });
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'worker';
    process.env.KYBERION_PROJECT_ID = project.project_id;

    expect(() => getProjectManagementView(project.project_id)).toThrow('[PROJECT_SCOPE_VIOLATION]');
    expect(() => listManagedProjects()).toThrow('[PROJECT_SCOPE_VIOLATION]');
  });

  it('rejects a directory used as a project OS blueprint', () => {
    const knowledgeRoot = pathResolver.sharedTmp('project-os-blueprint-test');
    const scaffoldRoot = pathResolver.sharedTmp('project-os-scaffold-test');
    const firstArtifact = loadProjectOperatingSystemArtifactMap().lifecycle.find(
      (phase) => phase.required.length > 0
    )?.required[0];
    if (!firstArtifact) throw new Error('expected a project OS blueprint fixture');
    const blueprintPath = path.join(
      knowledgeRoot,
      'public',
      'templates',
      'blueprints',
      firstArtifact + '.md'
    );
    const knowledgeSpy = vi
      .spyOn(pathResolver, 'knowledge')
      .mockImplementation((subPath = '') => path.join(knowledgeRoot, subPath));
    safeMkdir(blueprintPath, { recursive: true });

    try {
      expect(() =>
        ensureProjectOsScaffold(
          'PRJ-PMC-BLUEPRINT',
          'Blueprint Boundary Test',
          'public',
          'shared',
          scaffoldRoot
        )
      ).toThrow('project OS blueprint must be a regular file');
    } finally {
      safeRmSync(knowledgeRoot, { recursive: true, force: true });
      safeRmSync(scaffoldRoot, { recursive: true, force: true });
      knowledgeSpy.mockRestore();
    }
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

  it('loads project missions from the project tier when mission ids collide across tiers', () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-TIER-SCOPE',
      name: 'Tier Scoped Mission Project',
      summary: 'The project view must not fall back to another tier.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    const mission: MissionState = {
      mission_id: 'MSN-PMC-TIER-COLLISION',
      mission_type: 'development',
      tier: 'confidential',
      status: 'active',
      tenant_slug: 'tenant-pmc-test',
      execution_mode: 'local',
      priority: 1,
      assigned_persona: 'worker',
      confidence_score: 1,
      relationships: { project: { project_id: project.project_id } },
      git: {
        branch: 'mission/tier-collision',
        start_commit: 'fixture',
        latest_commit: 'fixture',
        checkpoints: [],
      },
      history: [{ ts: new Date().toISOString(), event: 'CREATE', note: 'fixture' }],
    };
    const personalPath = pathResolver.missionDir(mission.mission_id, 'personal');
    const confidentialPath = pathResolver.missionDir(mission.mission_id, 'confidential');
    safeMkdir(personalPath, { recursive: true });
    safeMkdir(confidentialPath, { recursive: true });
    safeWriteFile(
      `${personalPath}/mission-state.json`,
      JSON.stringify({ ...mission, tier: 'personal', tenant_slug: undefined })
    );
    safeWriteFile(`${confidentialPath}/mission-state.json`, JSON.stringify(mission));

    const view = getProjectManagementView(project.project_id);
    expect(view.lineage.missions).toEqual(
      expect.arrayContaining([expect.objectContaining({ mission_id: mission.mission_id })])
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
    process.env.KYBERION_TENANT = 'other-tenant';
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

  it('denies worker reconciliation outside the bound project and tenant', () => {
    const project = createManagedProject({
      project_id: 'PRJ-PMC-WORKER-RECONCILE',
      name: 'Worker Reconciliation Scope',
      summary: 'Reconciliation respects the worker project and tenant bindings.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    process.env.KYBERION_PERSONA = 'worker';
    process.env.MISSION_ROLE = 'worker';
    process.env.KYBERION_PROJECT_ID = 'PRJ-PMC-OTHER-PROJECT';

    expect(() => reconcileProjectOperationalState(project.project_id, { apply: true })).toThrow(
      /PROJECT_SCOPE_VIOLATION/
    );

    process.env.KYBERION_PROJECT_ID = project.project_id;
    process.env.KYBERION_TENANT = 'other-tenant';
    expect(() => reconcileProjectOperationalState(project.project_id, { apply: true })).toThrow(
      /worker tenant 'other-tenant' cannot access project tenant 'tenant-pmc-test'/
    );
  });

  it('audits sovereign cross-scope diagnostics for mismatched project state records', () => {
    const projectId = 'PRJ-PMC-FOREIGN-STATE';
    const project = createManagedProject({
      project_id: projectId,
      name: 'Foreign State Project',
      summary: 'Cross-scope diagnostics detect mismatched operational state.',
      tier: 'confidential',
      tenant_slug: 'tenant-pmc-test',
      status: 'active',
    });
    const mismatchedWorkspaces = [
      pathResolver.projectWorkspaceDir(projectId, 'public', 'tenant-pmc-test'),
      pathResolver.projectWorkspaceDir(projectId, 'personal', 'tenant-pmc-test'),
    ];

    try {
      saveProjectOperationalState({
        project_id: projectId,
        name: project.name,
        summary: 'Mismatched tier state fixture.',
        status: 'active',
        tier: 'public',
        tenant_slug: 'tenant-pmc-test',
      });
      saveProjectOperationalState({
        project_id: projectId,
        name: project.name,
        summary: 'Personal tenant partition state fixture.',
        status: 'active',
        tier: 'personal',
        tenant_slug: 'tenant-pmc-test',
      });

      const scopedReport = reconcileProjectOperationalState(projectId);
      expect(scopedReport.issues).not.toContainEqual(
        expect.objectContaining({ kind: 'out_of_scope_operational_state' })
      );

      const diagnosticReport = reconcileProjectOperationalState(projectId, {
        includeCrossScopeDiagnostics: true,
      });
      expect(diagnosticReport.issues).toContainEqual(
        expect.objectContaining({
          kind: 'out_of_scope_operational_state',
          actual: ['personal:tenant-pmc-test', 'public:tenant-pmc-test'],
        })
      );

      process.env.KYBERION_PERSONA = 'worker';
      process.env.KYBERION_PROJECT_ID = projectId;
      expect(() =>
        reconcileProjectOperationalState(projectId, { includeCrossScopeDiagnostics: true })
      ).toThrow(/requires the sovereign persona/);
    } finally {
      const previousPersona = process.env.KYBERION_PERSONA;
      const previousRole = process.env.MISSION_ROLE;
      const previousTenant = process.env.KYBERION_TENANT;
      process.env.KYBERION_PERSONA = 'sovereign';
      process.env.MISSION_ROLE = 'sovereign';
      process.env.KYBERION_TENANT = 'tenant-pmc-test';
      try {
        for (const workspace of mismatchedWorkspaces) {
          safeRmSync(workspace, { recursive: true, force: true });
        }
      } finally {
        if (previousPersona === undefined) delete process.env.KYBERION_PERSONA;
        else process.env.KYBERION_PERSONA = previousPersona;
        if (previousRole === undefined) delete process.env.MISSION_ROLE;
        else process.env.MISSION_ROLE = previousRole;
        if (previousTenant === undefined) delete process.env.KYBERION_TENANT;
        else process.env.KYBERION_TENANT = previousTenant;
      }
    }
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
