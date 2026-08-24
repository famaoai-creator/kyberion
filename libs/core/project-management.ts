import * as path from 'node:path';
import { getRegisteredEnv } from './env-validator.js';
import {
  buildProjectBootstrapWorkItems,
  listProjectRecords,
  loadProjectRecord,
  projectRecordPath,
  saveProjectRecord,
  type ProjectBootstrapWorkItem,
  type ProjectRecord,
} from './project-registry.js';
import {
  listProjectOperationalStates,
  listProjectOperationalStatePaths,
  projectOperationalStatePath,
  saveProjectOperationalState,
  type ProjectOperationalState,
} from './project-operational-state-registry.js';
import {
  listProjectTracksForProject,
  loadProjectTrackRecord,
  saveProjectTrackRecord,
  type ProjectTrackRecord,
} from './project-track-registry.js';

function kyberionEnv(name: string): string | undefined {
  return getRegisteredEnv<string>(name) as string | undefined;
}
import { missionSeedRecordPath, saveMissionSeedRecord } from './mission-seed-registry.js';
import {
  createTaskSession,
  loadTaskSession,
  listTaskSessions,
  saveTaskSession,
  taskSessionPath,
  type TaskSession,
} from './task-session.js';
import { listMissionsInSearchDirs, loadState, saveState } from './mission-state.js';
import type { MissionState } from './mission-types.js';
import { auditChain } from './audit-chain.js';
import { pathResolver } from './path-resolver.js';
import { validateWritePermission } from './tier-guard.js';
import {
  removeMissionFromProjectLedger,
  resolveProjectLedgerPath,
  syncProjectLedger,
} from './mission-project-ledger.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeUnlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { projectOperationalMissionLinkPath } from './project-operational-state-links.js';
import { resolveTenant } from './tenant-registry.js';
import {
  loadOrganizationOperationalState,
  saveOrganizationOperationalState,
} from './organization-operating-model.js';

export interface ProjectManagementView {
  project: ProjectRecord;
  tracks: ReturnType<typeof listProjectTracksForProject>;
  tasks: ProjectBootstrapWorkItem[];
  missions: MissionState[];
  task_sessions: TaskSession[];
  operational_states: ProjectOperationalState[];
  lineage: ProjectLineageView;
}

export interface ProjectLineageView {
  project: { project_id: string; name: string; role: 'durable_context' };
  tracks: Array<{ track_id: string; name: string; status: string; role: 'planning_slice' }>;
  tasks: Array<{
    work_id: string;
    title: string;
    status: string;
    task_session_id?: string;
    role: 'work_item';
  }>;
  missions: Array<{
    mission_id: string;
    status: string;
    track_id?: string;
    role: 'governed_ownership';
  }>;
  task_sessions: Array<{ session_id: string; status: string; role: 'resumable_execution_context' }>;
  pipelines: Array<{ pipeline_id: string; role: 'replayable_execution_procedure' }>;
  role_explanations: {
    project: string;
    track: string;
    mission: string;
    task: string;
    task_session: string;
    pipeline: string;
  };
}

export interface ProjectReconciliationIssue {
  kind:
    | 'project_active_missions'
    | 'project_active_tracks'
    | 'project_active_task_sessions'
    | 'operational_state_missions'
    | 'operational_state_tracks'
    | 'operational_state_task_sessions'
    | 'missing_operational_state'
    | 'out_of_scope_task_session'
    | 'out_of_scope_mission'
    | 'out_of_scope_track'
    | 'out_of_scope_operational_state';
  scope?: string;
  expected: string[];
  actual: string[];
}

export interface ProjectReconciliationReport {
  project_id: string;
  status: 'clean' | 'drift' | 'repaired';
  expected: {
    active_missions: string[];
    active_tracks: string[];
    active_task_sessions: string[];
  };
  issues: ProjectReconciliationIssue[];
  repaired_paths: string[];
}

export interface ManagedProjectCreateInput {
  project_id: string;
  name: string;
  summary: string;
  tier: ProjectRecord['tier'];
  organization_id?: string;
  tenant_slug?: string;
  status?: ProjectRecord['status'];
  primary_locale?: string;
  project_path?: string;
  metadata?: Record<string, unknown>;
  pipeline_refs?: string[];
  rootDir?: string;
}

export interface ProjectBootstrapInput extends ManagedProjectCreateInput {
  utterance?: string;
  track_id?: string;
  track_name?: string;
  service_bindings?: string[];
  onCommit?: (result: ProjectBootstrapResult) => void;
  onRollback?: (result: ProjectBootstrapResult, error: unknown) => void;
}

export interface ProjectBootstrapResult {
  project: ProjectRecord;
  kickoff_task_session: TaskSession;
  mission_seed_ids: string[];
  work_items: ProjectBootstrapWorkItem[];
}

export interface ManagedProjectTrackCreateInput {
  track_id: string;
  project_id: string;
  name: string;
  summary: string;
  track_type?: ProjectTrackRecord['track_type'];
  lifecycle_model?: ProjectTrackRecord['lifecycle_model'];
  status?: ProjectTrackRecord['status'];
  tier?: ProjectTrackRecord['tier'];
  primary_locale?: string;
  release_id?: string;
  change_scope?: string;
  gate_profile_id?: string;
  required_artifacts?: string[];
  metadata?: Record<string, unknown>;
}

const ACTIVE_MISSION_STATUSES = new Set([
  'planned',
  'active',
  'validating',
  'distilling',
  'paused',
]);
const ACTIVE_TASK_SESSION_STATUSES = new Set([
  'awaiting_instruction',
  'collecting_requirements',
  'planning',
  'awaiting_confirmation',
  'executing',
  'verifying',
  'blocked',
  'paused',
]);

function normalizeId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

export function createManagedProjectTrack(
  input: ManagedProjectTrackCreateInput
): ProjectTrackRecord {
  const projectId = normalizeId(input.project_id, 'project_id');
  const trackId = normalizeId(input.track_id, 'track_id');
  const name = normalizeId(input.name, 'name');
  const summary = normalizeId(input.summary, 'summary');
  const project = loadProjectRecord(projectId);
  if (!project) throw new Error(`Project not found: ${projectId}`);
  if (loadProjectTrackRecord(trackId)) throw new Error(`Project track already exists: ${trackId}`);
  const tier = input.tier || project.tier;
  if (tier !== project.tier) {
    throw new Error(
      `Project track tier '${tier}' must match project tier '${project.tier}' (${projectId}).`
    );
  }
  const record: ProjectTrackRecord = {
    track_id: trackId,
    project_id: projectId,
    name,
    summary,
    status: input.status || 'active',
    track_type: input.track_type || 'release',
    lifecycle_model: input.lifecycle_model || 'continuous_delivery',
    tier,
    ...(project.tenant_slug ? { tenant_slug: project.tenant_slug } : {}),
    ...(input.primary_locale || project.primary_locale
      ? { primary_locale: input.primary_locale || project.primary_locale }
      : {}),
    ...(input.release_id ? { release_id: input.release_id } : {}),
    ...(input.change_scope ? { change_scope: input.change_scope } : {}),
    ...(input.gate_profile_id ? { gate_profile_id: input.gate_profile_id } : {}),
    ...(input.required_artifacts ? { required_artifacts: [...input.required_artifacts] } : {}),
    ...(input.metadata ? { metadata: { ...input.metadata } } : {}),
  };
  const currentDefaultTrack = project.default_track_id
    ? loadProjectTrackRecord(project.default_track_id)
    : null;
  const hasUsableDefaultTrack = Boolean(
    currentDefaultTrack &&
    currentDefaultTrack.status === 'active' &&
    isTrackInProjectScope(currentDefaultTrack, project)
  );
  const previousStatePaths = listProjectOperationalStatePaths({ projectId });
  const previousStates = listProjectOperationalStates({ projectId });
  const trackPath = saveProjectTrackRecord(record);
  try {
    saveProjectRecord({
      ...project,
      ...(hasUsableDefaultTrack || record.status !== 'active' ? {} : { default_track_id: trackId }),
      active_tracks:
        record.status === 'active'
          ? sortedUnique([...(project.active_tracks || []), trackId])
          : sortedUnique(project.active_tracks),
    });
    reconcileProjectOperationalState(projectId, { apply: true });
    auditChain.record({
      agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
      action: 'project.track_created',
      operation: `create:${trackId}`,
      result: 'completed',
      metadata: { project_id: projectId, track_id: trackId, tier },
    });
  } catch (error) {
    safeUnlinkSync(trackPath);
    try {
      saveProjectRecord(project);
      for (const statePath of listProjectOperationalStatePaths({ projectId })) {
        if (!previousStatePaths.includes(statePath)) safeUnlinkSync(statePath);
      }
      for (const state of previousStates) saveProjectOperationalState(state);
    } catch {
      // Preserve the original failure; the next governed reconcile reports any residue.
    }
    throw error;
  }
  return record;
}

export function updateManagedProjectTrack(
  trackId: string,
  patch: Pick<ProjectTrackRecord, 'tenant_slug'>
): ProjectTrackRecord {
  const current = loadProjectTrackRecord(normalizeId(trackId, 'track_id'));
  if (!current) throw new Error(`Project track not found: ${trackId}`);
  const project = loadProjectRecord(current.project_id);
  if (!project) throw new Error(`Project not found: ${current.project_id}`);
  if (patch.tenant_slug && patch.tenant_slug !== project.tenant_slug) {
    throw new Error(
      `Project track tenant '${patch.tenant_slug}' must match project tenant '${project.tenant_slug || 'shared'}'.`
    );
  }
  const next = {
    ...current,
    ...(patch.tenant_slug ? { tenant_slug: patch.tenant_slug } : {}),
  };
  const previousStatePaths = listProjectOperationalStatePaths({ projectId: current.project_id });
  const previousStates = listProjectOperationalStates({ projectId: current.project_id });
  saveProjectTrackRecord(next);
  try {
    reconcileProjectOperationalState(current.project_id, { apply: true });
    auditChain.record({
      agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
      action: 'project.track_updated',
      operation: `update:${current.track_id}`,
      result: 'completed',
      metadata: { project_id: current.project_id, track_id: current.track_id },
    });
  } catch (error) {
    try {
      saveProjectTrackRecord(current);
      saveProjectRecord(project);
      for (const statePath of listProjectOperationalStatePaths({ projectId: current.project_id })) {
        if (!previousStatePaths.includes(statePath)) safeUnlinkSync(statePath);
      }
      for (const state of previousStates) saveProjectOperationalState(state);
    } catch {
      // Preserve the original failure; the next governed reconcile reports any residue.
    }
    throw error;
  }
  return next;
}

export function assertManagedProjectId(value: string): string {
  const normalized = normalizeId(value, 'project_id');
  if (!/^PRJ-[A-Z0-9][A-Z0-9._-]*$/.test(normalized)) {
    throw new Error(
      `Invalid project_id '${value}'. Managed projects must use PRJ-<UPPER_SNAKE_OR_DASH_ID>.`
    );
  }
  return normalized;
}

export function assertManagedProjectTrackScope(
  project: ProjectRecord,
  track: ProjectTrackRecord
): void {
  const projectTenant = project.tenant_slug || 'shared';
  const trackTenant = track.tenant_slug || projectTenant;
  if (track.project_id !== project.project_id) {
    throw new Error(`Track ${track.track_id} does not belong to project ${project.project_id}`);
  }
  if (track.tier !== project.tier || (project.tier === 'confidential' && !track.tenant_slug)) {
    throw new Error(
      `Track ${track.track_id} scope (${track.tier}:${track.tenant_slug || 'unknown'}) must match project scope (${project.tier}:${projectTenant}).`
    );
  }
  if (trackTenant !== projectTenant) {
    throw new Error(
      `Track ${track.track_id} scope (${track.tier}:${track.tenant_slug || 'shared'}) must match project scope (${project.tier}:${projectTenant}).`
    );
  }
}

function projectMissions(projectId: string, rootDir = pathResolver.rootDir()): MissionState[] {
  const project = loadProjectRecord(projectId, { rootDir });
  const missionDirectories = project
    ? [
        project.tier === 'personal'
          ? path.join(rootDir, 'knowledge/personal/missions')
          : project.tier === 'confidential'
            ? path.join(rootDir, 'active/missions/confidential')
            : path.join(rootDir, 'active/missions/public'),
      ]
    : undefined;
  const missionOptions = {
    rootDir,
    ...(missionDirectories ? { directories: missionDirectories } : {}),
  };
  return listMissionsInSearchDirs(missionOptions)
    .map(({ missionId }) => loadState(missionId, missionOptions))
    .filter((state): state is MissionState => Boolean(state))
    .filter((state) => state.relationships?.project?.project_id === projectId);
}

function projectSessions(projectId: string, rootDir = pathResolver.rootDir()): TaskSession[] {
  return listTaskSessions(undefined, { rootDir }).filter(
    (session) => session.project_context?.project_id === projectId
  );
}

function projectSessionScope(
  session: TaskSession,
  project: ProjectRecord
): { tier: ProjectRecord['tier']; tenant?: string } {
  const tier = session.project_context?.tier || project.tier;
  const tenant =
    session.project_context?.tenant_slug ||
    (tier === 'confidential' ? undefined : project.tenant_slug || 'shared');
  return { tier, tenant };
}

function projectMissionScope(mission: MissionState): {
  tier: ProjectRecord['tier'];
  tenant?: string;
} {
  const tier = mission.tier;
  const tenant =
    mission.tenant_slug || mission.tenant_id || (tier === 'confidential' ? undefined : 'shared');
  return { tier, tenant };
}

function isMissionInProjectScope(mission: MissionState, project: ProjectRecord): boolean {
  const scope = projectMissionScope(mission);
  return scope.tier === project.tier && scope.tenant === (project.tenant_slug || 'shared');
}

function isTrackInProjectScope(track: ProjectTrackRecord, project: ProjectRecord): boolean {
  if (track.project_id !== project.project_id || track.tier !== project.tier) return false;
  if (project.tier === 'confidential' && !track.tenant_slug) return false;
  return (
    (track.tenant_slug || project.tenant_slug || 'shared') === (project.tenant_slug || 'shared')
  );
}

function isOperationalStateInProjectScope(
  state: ProjectOperationalState,
  project: ProjectRecord
): boolean {
  return (
    state.project_id === project.project_id &&
    state.tier === project.tier &&
    (state.tenant_slug || 'shared') === (project.tenant_slug || 'shared')
  );
}

function isInProjectScope(session: TaskSession, project: ProjectRecord): boolean {
  const scope = projectSessionScope(session, project);
  return scope.tier === project.tier && scope.tenant === (project.tenant_slug || 'shared');
}

function scopeKey(tier: ProjectRecord['tier'], tenantSlug?: string): string {
  return `${tier}:${tenantSlug || 'shared'}`;
}

function expectedForScope(
  projectId: string,
  tier: ProjectRecord['tier'],
  tenantSlug?: string
): { missions: string[]; tracks: string[]; sessions: string[] } {
  const tenant = tenantSlug || 'shared';
  const project = loadProjectRecord(projectId);
  const projectTenant = project?.tenant_slug || 'shared';
  const missions = project
    ? projectMissions(projectId).filter(
        (mission) =>
          isMissionInProjectScope(mission, project) &&
          mission.tier === tier &&
          (projectMissionScope(mission).tenant || 'shared') === tenant &&
          ACTIVE_MISSION_STATUSES.has(mission.status)
      )
    : [];
  const sessions = projectSessions(projectId).filter((session) => {
    if (!project) return false;
    const scope = projectSessionScope(session, project);
    return (
      scope.tier === tier &&
      scope.tenant === tenant &&
      ACTIVE_TASK_SESSION_STATUSES.has(session.status)
    );
  });
  const tracks = project
    ? listProjectTracksForProject(projectId).filter(
        (track) =>
          isTrackInProjectScope(track, project) &&
          track.tier === tier &&
          track.status === 'active' &&
          (track.tenant_slug || projectTenant) === tenant
      )
    : [];
  const scopedTrackIds = new Set(
    (project
      ? listProjectTracksForProject(projectId).filter((track) =>
          isTrackInProjectScope(track, project)
        )
      : []
    ).map((track) => track.track_id)
  );
  return {
    missions: missions.map((mission) => mission.mission_id).sort(),
    tracks: [
      ...tracks.map((track) => track.track_id),
      ...missions
        .map((mission) => mission.relationships?.track?.track_id)
        .filter((trackId): trackId is string => Boolean(trackId) && scopedTrackIds.has(trackId)),
    ]
      .sort()
      .filter((trackId, index, values) => values.indexOf(trackId) === index),
    sessions: sessions.map((session) => session.session_id).sort(),
  };
}

function sortedUnique(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

function sameIds(left: string[] | undefined, right: string[]): boolean {
  return JSON.stringify(sortedUnique(left)) === JSON.stringify(sortedUnique(right));
}

const PROJECT_OS_PHASE_DIRS: Record<string, string> = {
  initiate: '01_initiate',
  define: '02_define',
  design: '03_design',
  build: '04_control',
  validate: '05_validate',
  transfer_run: '06_transfer_run',
};

export function ensureProjectOsScaffold(
  projectId: string,
  projectName: string,
  tier: ProjectRecord['tier'],
  tenantSlug = 'shared',
  rootDir = pathResolver.rootDir()
): string {
  const targetDir = pathResolver.projectOsDir(projectId, tier, tenantSlug, rootDir);
  const artifactMap = JSON.parse(
    safeReadFile(
      pathResolver.knowledge('product/orchestration/project-operating-system-artifact-map.json'),
      { encoding: 'utf8' }
    ) as string
  ) as { lifecycle?: Array<{ phase: string; required?: string[] }> };
  const blueprintsRoot = pathResolver.knowledge('public/templates/blueprints');
  for (const phase of artifactMap.lifecycle || []) {
    const phaseDir = path.join(targetDir, PROJECT_OS_PHASE_DIRS[phase.phase] || phase.phase);
    safeMkdir(phaseDir, { recursive: true });
    for (const artifact of phase.required || []) {
      const sourcePath = path.join(blueprintsRoot, `${artifact}.md`);
      const targetPath = path.join(phaseDir, `${artifact}.md`);
      if (!safeExistsSync(sourcePath) || safeExistsSync(targetPath)) continue;
      const content = safeReadFile(sourcePath, { encoding: 'utf8' }) as string;
      safeWriteFile(
        targetPath,
        `<!-- Generated by project-management bootstrap for ${projectName} -->\n<!-- Source blueprint: ${sourcePath} -->\n\n> Project: ${projectName}\n\n${content.trimEnd()}\n`
      );
    }
  }
  const readmePath = path.join(targetDir, 'README.md');
  if (!safeExistsSync(readmePath)) {
    safeWriteFile(
      readmePath,
      `# ${projectName} Project Operating System\n\nProject: ${projectId}\n\nThis scaffold is the document face of the Project. Live state is maintained under the sibling \`state/\` directory.\n`
    );
  }
  return targetDir;
}

export function buildManagedProjectRecord(input: ManagedProjectCreateInput): ProjectRecord {
  const projectId = assertManagedProjectId(input.project_id);
  if (input.tier === 'confidential' && !input.tenant_slug?.trim()) {
    throw new Error(`tenant_slug is required for confidential project records (${projectId}).`);
  }
  if (input.tier === 'confidential' && input.tenant_slug === 'shared') {
    throw new Error(
      `tenant_slug 'shared' is not a tenant for confidential project records (${projectId}).`
    );
  }
  if (
    input.tier === 'confidential' &&
    input.tenant_slug &&
    (kyberionEnv('KYBERION_ENTITY_GOVERNANCE') === 'enforce' || !process.env.VITEST)
  ) {
    resolveTenant(input.tenant_slug, { rootDir: input.rootDir });
  }
  return {
    project_id: projectId,
    name: normalizeId(input.name, 'name'),
    summary: normalizeId(input.summary, 'summary'),
    status: input.status || 'draft',
    tier: input.tier,
    ...(input.organization_id ? { organization_id: input.organization_id } : {}),
    ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
    ...(input.primary_locale ? { primary_locale: input.primary_locale } : {}),
    ...(input.project_path
      ? {
          repositories: [
            {
              repo_id: `REPO-${projectId.replace(/^PRJ-/, '')}`,
              kind: 'project-root',
              root_path: input.project_path,
            },
          ],
        }
      : {}),
    ...(input.metadata ? { metadata: input.metadata } : {}),
    ...(input.pipeline_refs ? { pipeline_refs: sortedUnique(input.pipeline_refs) } : {}),
  };
}

export function createManagedProject(input: ManagedProjectCreateInput): ProjectRecord {
  return createManagedProjectInternal(input, false);
}

function createManagedProjectInternal(
  input: ManagedProjectCreateInput,
  deferAudit: boolean
): ProjectRecord {
  const projectId = assertManagedProjectId(input.project_id);
  if (loadProjectRecord(projectId, { rootDir: input.rootDir }))
    throw new Error(`Project already exists: ${projectId}`);
  const record = buildManagedProjectRecord(input);
  const enforceEntityGovernance =
    kyberionEnv('KYBERION_ENTITY_GOVERNANCE') === 'enforce' || !process.env.VITEST;
  const organizationState =
    enforceEntityGovernance && input.organization_id
      ? loadOrganizationOperationalState(input.organization_id, {
          tier: input.tier,
          tenantSlug: input.tenant_slug,
          rootDir: input.rootDir,
        })
      : null;
  if (input.organization_id && enforceEntityGovernance && !organizationState) {
    throw new Error(`Organization not found for project '${projectId}': ${input.organization_id}`);
  }
  if (organizationState && organizationState.status !== 'active' && record.status !== 'archived') {
    throw new Error(
      `Organization '${input.organization_id}' is ${organizationState.status}; project creation is denied.`
    );
  }
  if (
    organizationState &&
    input.tenant_slug &&
    organizationState.tenant_slug &&
    input.tenant_slug !== organizationState.tenant_slug
  ) {
    throw new Error(
      `Project '${projectId}' and organization '${input.organization_id}' belong to different tenants.`
    );
  }
  const projectPath = saveProjectRecord(record, { rootDir: input.rootDir });
  if (organizationState) {
    try {
      saveOrganizationOperationalState(
        {
          ...organizationState,
          active_project_ids: [
            ...new Set([...(organizationState.active_project_ids || []), projectId]),
          ].sort(),
          updated_at: new Date().toISOString(),
        },
        { rootDir: input.rootDir }
      );
    } catch (error) {
      safeUnlinkSync(projectPath);
      throw error;
    }
  }
  if (!deferAudit) {
    auditChain.record({
      agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
      action: 'project.created',
      operation: `create:${projectId}`,
      result: 'completed',
      metadata: {
        project_id: projectId,
        tier: record.tier,
        ...(input.organization_id ? { organization_id: input.organization_id } : {}),
      },
    });
  }
  return record;
}

export function updateManagedProject(
  projectId: string,
  patch: Partial<
    Pick<
      ProjectRecord,
      'name' | 'summary' | 'status' | 'primary_locale' | 'metadata' | 'pipeline_refs'
    >
  >
): ProjectRecord {
  const current = loadProjectRecord(normalizeId(projectId, 'project_id'));
  if (!current) throw new Error(`Project not found: ${projectId}`);
  if (current.status === 'archived' && patch.status !== 'archived') {
    throw new Error(
      `Archived project must be restored through an explicit lifecycle operation: ${projectId}`
    );
  }
  const next = {
    ...current,
    ...patch,
    ...(patch.metadata ? { metadata: { ...(current.metadata || {}), ...patch.metadata } } : {}),
  } satisfies ProjectRecord;
  saveProjectRecord(next);
  auditChain.record({
    agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
    action: 'project.updated',
    operation: `update:${current.project_id}`,
    result: 'completed',
    metadata: { project_id: current.project_id, fields: Object.keys(patch) },
  });
  return next;
}

export function archiveManagedProject(
  projectId: string,
  reason = 'Project archived'
): ProjectRecord {
  const current = loadProjectRecord(normalizeId(projectId, 'project_id'));
  if (!current) throw new Error(`Project not found: ${projectId}`);
  const activeMissions = projectMissions(current.project_id).filter((mission) =>
    ACTIVE_MISSION_STATUSES.has(mission.status)
  );
  if (activeMissions.length > 0) {
    throw new Error(
      `Cannot archive project with active missions: ${activeMissions.map((mission) => mission.mission_id).join(', ')}`
    );
  }
  const archived = updateManagedProject(current.project_id, {
    status: 'archived',
    metadata: { lifecycle_reason: reason, archived_at: new Date().toISOString() },
  });
  const closed = { ...archived, active_missions: [], active_tracks: [], active_task_sessions: [] };
  saveProjectRecord(closed);
  return closed;
}

export function getProjectManagementView(
  projectId: string,
  rootDir = pathResolver.rootDir()
): ProjectManagementView {
  const project = loadProjectRecord(normalizeId(projectId, 'project_id'), { rootDir });
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const tracks = listProjectTracksForProject(project.project_id, { rootDir }).filter((track) =>
    isTrackInProjectScope(track, project)
  );
  const tasks = project.bootstrap_work_items || [];
  const missions = projectMissions(project.project_id, rootDir).filter((mission) =>
    isMissionInProjectScope(mission, project)
  );
  const taskSessions = projectSessions(project.project_id, rootDir).filter((session) =>
    isInProjectScope(session, project)
  );
  const projectTrackIds = new Set(tracks.map((track) => track.track_id));
  const pipelineRefs = Array.isArray(project.pipeline_refs)
    ? project.pipeline_refs
    : Array.isArray(project.metadata?.pipeline_refs)
      ? project.metadata.pipeline_refs.filter((value): value is string => typeof value === 'string')
      : [];
  return {
    project,
    tracks,
    tasks,
    missions,
    task_sessions: taskSessions,
    operational_states: listProjectOperationalStates({
      projectId: project.project_id,
      rootDir,
    }).filter(
      (state) =>
        state.tier === project.tier &&
        (state.tenant_slug || 'shared') === (project.tenant_slug || 'shared')
    ),
    lineage: {
      project: { project_id: project.project_id, name: project.name, role: 'durable_context' },
      tracks: tracks.map((track) => ({
        track_id: track.track_id,
        name: track.name,
        status: track.status,
        role: 'planning_slice',
      })),
      tasks: tasks.map((task) => ({
        work_id: task.work_id,
        title: task.title,
        status: task.status,
        ...(task.kind === 'task_session' && project.kickoff_task_session_id
          ? { task_session_id: project.kickoff_task_session_id }
          : {}),
        role: 'work_item',
      })),
      missions: missions.map((mission) => ({
        mission_id: mission.mission_id,
        status: mission.status,
        ...(mission.relationships?.track?.track_id &&
        projectTrackIds.has(mission.relationships.track.track_id)
          ? { track_id: mission.relationships.track.track_id }
          : {}),
        role: 'governed_ownership',
      })),
      task_sessions: taskSessions.map((session) => ({
        session_id: session.session_id,
        status: session.status,
        role: 'resumable_execution_context',
      })),
      pipelines: sortedUnique(pipelineRefs).map((pipeline_id) => ({
        pipeline_id,
        role: 'replayable_execution_procedure',
      })),
      role_explanations: {
        project: 'Durable purpose, identity, service bindings, and long-lived context.',
        track: 'A planning and delivery slice inside a Project.',
        mission: 'Governed ownership and lifecycle boundary for work.',
        task: 'A bounded work item or requested unit of work.',
        task_session: 'A resumable execution context; it does not own the Task.',
        pipeline: 'A replayable execution procedure; it is not a parent container.',
      },
    },
  };
}

export function reconcileProjectOperationalState(
  projectId: string,
  options: { apply?: boolean } = {}
): ProjectReconciliationReport {
  const project = loadProjectRecord(normalizeId(projectId, 'project_id'));
  if (!project) throw new Error(`Project not found: ${projectId}`);
  const allMissions = projectMissions(project.project_id);
  const allTracks = listProjectTracksForProject(project.project_id);
  const allSessions = projectSessions(project.project_id);
  const allStateRecords = listProjectOperationalStates({ projectId: project.project_id });
  const scopedMissions = allMissions.filter((mission) => isMissionInProjectScope(mission, project));
  const scopedTracks = allTracks.filter((track) => isTrackInProjectScope(track, project));
  const scopedStateRecords = allStateRecords.filter((state) =>
    isOperationalStateInProjectScope(state, project)
  );
  const outOfScopeMissions = allMissions.filter(
    (mission) => !isMissionInProjectScope(mission, project)
  );
  const outOfScopeTracks = allTracks.filter((track) => !isTrackInProjectScope(track, project));
  const outOfScopeStateRecords = allStateRecords.filter(
    (state) => !isOperationalStateInProjectScope(state, project)
  );
  const outOfScopeSessions = allSessions.filter((session) => !isInProjectScope(session, project));
  const scopedSessions = allSessions.filter((session) => isInProjectScope(session, project));
  const expected = {
    active_missions: scopedMissions
      .filter((mission) => ACTIVE_MISSION_STATUSES.has(mission.status))
      .map((mission) => mission.mission_id)
      .sort(),
    active_tracks: [
      ...scopedTracks.filter((track) => track.status === 'active').map((track) => track.track_id),
      ...scopedMissions
        .filter((mission) => ACTIVE_MISSION_STATUSES.has(mission.status))
        .map((mission) => mission.relationships?.track?.track_id)
        .filter(
          (trackId): trackId is string =>
            Boolean(trackId) && scopedTracks.some((track) => track.track_id === trackId)
        ),
    ]
      .sort()
      .filter((trackId, index, values) => values.indexOf(trackId) === index),
    active_task_sessions: scopedSessions
      .filter((session) => ACTIVE_TASK_SESSION_STATUSES.has(session.status))
      .map((session) => session.session_id)
      .sort(),
  };
  const issues: ProjectReconciliationIssue[] = [];
  if (outOfScopeMissions.length > 0) {
    issues.push({
      kind: 'out_of_scope_mission',
      scope: scopeKey(project.tier, project.tenant_slug),
      expected: [],
      actual: outOfScopeMissions.map((mission) => mission.mission_id).sort(),
    });
  }
  if (outOfScopeTracks.length > 0) {
    issues.push({
      kind: 'out_of_scope_track',
      scope: scopeKey(project.tier, project.tenant_slug),
      expected: [],
      actual: outOfScopeTracks.map((track) => track.track_id).sort(),
    });
  }
  if (outOfScopeStateRecords.length > 0) {
    issues.push({
      kind: 'out_of_scope_operational_state',
      scope: scopeKey(project.tier, project.tenant_slug),
      expected: [],
      actual: outOfScopeStateRecords
        .map((state) => `${state.tier}:${state.tenant_slug || 'shared'}`)
        .sort(),
    });
  }
  if (outOfScopeSessions.length > 0) {
    issues.push({
      kind: 'out_of_scope_task_session',
      scope: scopeKey(project.tier, project.tenant_slug),
      expected: [],
      actual: outOfScopeSessions.map((session) => session.session_id).sort(),
    });
  }
  if (!sameIds(project.active_missions, expected.active_missions)) {
    issues.push({
      kind: 'project_active_missions',
      expected: expected.active_missions,
      actual: sortedUnique(project.active_missions),
    });
  }
  if (!sameIds(project.active_tracks, expected.active_tracks)) {
    issues.push({
      kind: 'project_active_tracks',
      expected: expected.active_tracks,
      actual: sortedUnique(project.active_tracks),
    });
  }
  if (!sameIds(project.active_task_sessions, expected.active_task_sessions)) {
    issues.push({
      kind: 'project_active_task_sessions',
      expected: expected.active_task_sessions,
      actual: sortedUnique(project.active_task_sessions),
    });
  }

  const stateRecords = scopedStateRecords;
  const scopes = new Map<string, { tier: ProjectRecord['tier']; tenant?: string }>();
  for (const mission of scopedMissions) {
    const { tier, tenant } = projectMissionScope(mission);
    scopes.set(scopeKey(tier, tenant), { tier, tenant });
  }
  for (const session of allSessions) {
    if (!isInProjectScope(session, project)) continue;
    const { tier, tenant } = projectSessionScope(session, project);
    scopes.set(scopeKey(tier, tenant), { tier, tenant });
  }
  for (const track of scopedTracks.filter((item) => item.status === 'active')) {
    const tenant = track.tenant_slug || project.tenant_slug || 'shared';
    scopes.set(scopeKey(track.tier, tenant), { tier: track.tier, tenant });
  }
  for (const state of stateRecords) {
    scopes.set(scopeKey(state.tier, state.tenant_slug), {
      tier: state.tier,
      tenant: state.tenant_slug || 'shared',
    });
    const scoped = expectedForScope(project.project_id, state.tier, state.tenant_slug);
    if (!sameIds(state.active_mission_ids, scoped.missions)) {
      issues.push({
        kind: 'operational_state_missions',
        scope: scopeKey(state.tier, state.tenant_slug),
        expected: scoped.missions,
        actual: sortedUnique(state.active_mission_ids),
      });
    }
    if (!sameIds(state.active_track_ids, scoped.tracks)) {
      issues.push({
        kind: 'operational_state_tracks',
        scope: scopeKey(state.tier, state.tenant_slug),
        expected: scoped.tracks,
        actual: sortedUnique(state.active_track_ids),
      });
    }
    if (!sameIds(state.active_task_session_ids, scoped.sessions)) {
      issues.push({
        kind: 'operational_state_task_sessions',
        scope: scopeKey(state.tier, state.tenant_slug),
        expected: scoped.sessions,
        actual: sortedUnique(state.active_task_session_ids),
      });
    }
  }
  for (const scope of scopes.values()) {
    if (
      !stateRecords.some(
        (state) =>
          state.tier === scope.tier &&
          (state.tenant_slug || 'shared') === (scope.tenant || 'shared')
      )
    ) {
      issues.push({
        kind: 'missing_operational_state',
        scope: scopeKey(scope.tier, scope.tenant),
        expected: expectedForScope(project.project_id, scope.tier, scope.tenant).missions,
        actual: [],
      });
    }
  }

  const repairedPaths: string[] = [];
  if (options.apply && issues.length > 0) {
    const nextProject = {
      ...project,
      active_missions: expected.active_missions,
      active_tracks: expected.active_tracks,
      active_task_sessions: expected.active_task_sessions,
    };
    saveProjectRecord(nextProject);
    repairedPaths.push('project-registry');
    for (const scope of scopes.values()) {
      const scoped = expectedForScope(project.project_id, scope.tier, scope.tenant);
      const existing = listProjectOperationalStates({ projectId: project.project_id }).find(
        (state) =>
          state.tier === scope.tier &&
          (state.tenant_slug || 'shared') === (scope.tenant || 'shared')
      );
      const nextState: ProjectOperationalState = {
        ...(existing || {
          project_id: project.project_id,
          name: project.name,
          summary: project.summary,
          status: project.status,
          tier: scope.tier,
          tenant_slug: scope.tenant,
          source_refs: [],
          sources: [],
          distill_targets: [
            `knowledge/product/evolution/projects/${project.project_id}/project-state.md`,
          ],
          knowledge_refs: [],
        }),
        name: project.name,
        summary: project.summary,
        status: scoped.missions.length > 0 ? 'active' : project.status,
        active_mission_ids: scoped.missions,
        active_track_ids: scoped.tracks,
        active_task_session_ids: scoped.sessions,
        updated_at: new Date().toISOString(),
      };
      repairedPaths.push(saveProjectOperationalState(nextState));
    }
    auditChain.record({
      agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
      action: 'project.state_reconciled',
      operation: `reconcile:${project.project_id}`,
      result: 'completed',
      metadata: {
        project_id: project.project_id,
        issue_count: issues.length,
        repaired_paths: repairedPaths,
      },
    });
  }
  return {
    project_id: project.project_id,
    status: options.apply && issues.length > 0 ? 'repaired' : issues.length > 0 ? 'drift' : 'clean',
    expected,
    issues,
    repaired_paths: repairedPaths,
  };
}

export async function reassignMissionToProject(input: {
  mission_id: string;
  project_id: string;
  project_path?: string;
  tier?: ProjectRecord['tier'];
  track_id?: string;
  track_name?: string;
  relationship_type?: 'belongs_to' | 'supports' | 'governs' | 'independent';
  note?: string;
  force?: boolean;
  dry_run?: boolean;
}): Promise<{
  mission_id: string;
  from_project_id?: string;
  to_project_id: string;
  dry_run: boolean;
}> {
  const missionId = normalizeId(input.mission_id, 'mission_id').toUpperCase();
  const state = loadState(missionId);
  if (!state) throw new Error(`Mission not found: ${missionId}`);
  const targetProjectId = normalizeId(input.project_id, 'project_id');
  const targetProject = loadProjectRecord(targetProjectId);
  if (!targetProject) throw new Error(`Project not found: ${targetProjectId}`);
  const oldProject = state.relationships?.project;
  const oldProjectId = oldProject?.project_id;
  const targetPath =
    input.project_path ||
    targetProject.repositories?.find((repo) => repo.kind === 'project-root')?.root_path ||
    targetProject.repositories?.find((repo) => Boolean(repo.root_path))?.root_path;
  if (!targetPath) throw new Error(`Target project has no project root path: ${targetProjectId}`);
  if (!input.force && !['planned', 'paused', 'failed'].includes(state.status)) {
    throw new Error(
      `Mission must be paused before Project reassignment (current status: ${state.status})`
    );
  }
  const targetLedger = resolveProjectLedgerPath(targetPath);
  const targetGuard = validateWritePermission(targetLedger);
  if (!input.dry_run && !targetGuard.allowed)
    throw new Error(`Target project path is not writable: ${targetGuard.reason || targetPath}`);
  if (oldProject?.project_path && !input.dry_run) {
    const oldGuard = validateWritePermission(resolveProjectLedgerPath(oldProject.project_path));
    if (!oldGuard.allowed)
      throw new Error(
        `Source project path is not writable: ${oldGuard.reason || oldProject.project_path}`
      );
  }
  const targetTrack = input.track_id ? loadProjectTrackRecord(input.track_id) : null;
  if (input.track_id && (!targetTrack || targetTrack.project_id !== targetProjectId)) {
    throw new Error(`Track ${input.track_id} does not belong to project ${targetProjectId}`);
  }
  const missionTenant = state.tenant_slug || state.tenant_id || 'shared';
  const targetTenant = targetProject.tenant_slug || 'shared';
  if (targetTrack) assertManagedProjectTrackScope(targetProject, targetTrack);
  if (state.tier !== targetProject.tier || missionTenant !== targetTenant) {
    throw new Error(
      `Mission scope (${state.tier}:${missionTenant}) must match target project scope (${targetProject.tier}:${targetTenant}); cross-tier or cross-tenant reassignment is denied.`
    );
  }
  if (input.dry_run)
    return {
      mission_id: missionId,
      from_project_id: oldProjectId,
      to_project_id: targetProjectId,
      dry_run: true,
    };

  const { track: _previousTrack, ...relationshipsWithoutTrack } = state.relationships || {};
  const inheritedTraceabilityRefs =
    oldProjectId === targetProjectId
      ? (oldProject?.traceability_refs || []).filter(
          (ref) => ref !== `previous_project:${targetProjectId}`
        )
      : oldProject?.traceability_refs || [];
  const nextState: MissionState = {
    ...state,
    relationships: {
      ...relationshipsWithoutTrack,
      project: {
        relationship_type: input.relationship_type || 'belongs_to',
        project_id: targetProjectId,
        project_path: targetPath,
        affected_artifacts: oldProject?.affected_artifacts || [],
        gate_impact: oldProject?.gate_impact || 'informational',
        traceability_refs: [
          ...inheritedTraceabilityRefs,
          ...(oldProjectId && oldProjectId !== targetProjectId
            ? [`previous_project:${oldProjectId}`]
            : []),
        ],
        note: input.note || `Mission reassigned to ${targetProjectId}`,
      },
      ...(input.track_id
        ? {
            track: {
              relationship_type: 'belongs_to' as const,
              track_id: input.track_id,
              track_name: input.track_name || targetTrack?.name,
              track_type: targetTrack?.track_type,
              lifecycle_model: targetTrack?.lifecycle_model,
              traceability_refs: [],
              note: input.note,
            },
          }
        : {}),
    },
    history: [
      ...(state.history || []),
      {
        ts: new Date().toISOString(),
        event: 'PROJECT_REASSIGNED',
        from: oldProjectId || 'independent',
        to: targetProjectId,
        note: input.note || `Mission reassigned to ${targetProjectId}`,
      },
    ],
  };
  await saveState(missionId, nextState);

  if (oldProjectId && oldProjectId !== targetProjectId && oldProject?.project_path) {
    removeMissionFromProjectLedger(oldProject.project_path, missionId);
    const oldRecord = loadProjectRecord(oldProjectId);
    if (oldRecord) {
      saveProjectRecord({
        ...oldRecord,
        active_missions: sortedUnique(oldRecord.active_missions).filter((id) => id !== missionId),
      });
    }
    safeUnlinkSync(
      projectOperationalMissionLinkPath(
        oldProjectId,
        state.tier,
        state.tenant_slug || state.tenant_id || 'shared',
        missionId
      )
    );
    reconcileProjectOperationalState(oldProjectId, { apply: true });
  }
  saveProjectRecord({
    ...targetProject,
    active_missions: sortedUnique([...(targetProject.active_missions || []), missionId]),
    active_tracks: sortedUnique([
      ...(targetProject.active_tracks || []),
      ...(input.track_id ? [input.track_id] : []),
    ]),
  });
  await syncProjectLedger(missionId, pathResolver.rootDir());
  reconcileProjectOperationalState(targetProjectId, { apply: true });
  auditChain.record({
    agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
    action: 'mission.project_reassigned',
    operation: `reassign:${missionId}`,
    result: 'completed',
    metadata: {
      mission_id: missionId,
      from_project_id: oldProjectId,
      to_project_id: targetProjectId,
      track_id: input.track_id,
    },
  });
  return {
    mission_id: missionId,
    from_project_id: oldProjectId,
    to_project_id: targetProjectId,
    dry_run: false,
  };
}

export function bootstrapManagedProject(input: ProjectBootstrapInput): ProjectBootstrapResult {
  const projectId = normalizeId(input.project_id, 'project_id');
  const rootDir = input.rootDir || pathResolver.rootDir();
  if (loadProjectRecord(projectId, { rootDir }))
    throw new Error(`Project already exists: ${projectId}`);
  const previousOrganizationState = input.organization_id
    ? loadOrganizationOperationalState(input.organization_id, {
        tier: input.tier,
        tenantSlug: input.tenant_slug,
        rootDir,
      })
    : null;
  const candidateProjectOsPath = pathResolver.projectOsDir(
    projectId,
    input.tier,
    input.tenant_slug,
    rootDir
  );
  const projectOsExisted = safeExistsSync(candidateProjectOsPath);
  let projectOsPath: string | undefined;
  let kickoffId: string | undefined;
  let kickoffExisted = false;
  let missionSeedIds: string[] = [];
  const existingSeedPaths = new Set<string>();
  const projectStatePath = projectOperationalStatePath(
    projectId,
    input.tier,
    input.tenant_slug,
    rootDir
  );
  const projectStateExisted = safeExistsSync(projectStatePath);
  let committedResult: ProjectBootstrapResult | undefined;
  let commitCallbackStarted = false;
  let commitCompleted = false;
  try {
    projectOsPath = ensureProjectOsScaffold(
      projectId,
      input.name,
      input.tier,
      input.tenant_slug,
      rootDir
    );
    const workItems = buildProjectBootstrapWorkItems({
      projectId,
      projectName: input.name,
      utterance: input.utterance,
    });
    const kickoffWork = workItems.find((item) => item.kind === 'task_session');
    if (!kickoffWork)
      throw new Error('Project bootstrap requires a kickoff task session work item');
    kickoffId = `TSK-${kickoffWork.work_id.replace(/^WRK-/, '')}`;
    kickoffExisted = safeExistsSync(taskSessionPath(kickoffId, rootDir));
    if (loadTaskSession(kickoffId, { rootDir }))
      throw new Error(`Kickoff task session already exists: ${kickoffId}`);
    const kickoff = createTaskSession({
      sessionId: kickoffId,
      surface: 'project-controller',
      taskType: 'analysis',
      status: 'collecting_requirements',
      mode: 'interactive',
      intentId: 'bootstrap-project',
      shape: 'project_bootstrap',
      goal: { summary: kickoffWork.title, success_condition: kickoffWork.summary },
      projectContext: {
        project_id: projectId,
        project_name: input.name,
        ...(input.track_id ? { track_id: input.track_id } : {}),
        ...(input.track_name ? { track_name: input.track_name } : {}),
        ...(input.tenant_slug ? { tenant_slug: input.tenant_slug } : {}),
        tier: input.tier,
        ...(input.primary_locale ? { locale: input.primary_locale } : {}),
        ...(input.service_bindings ? { service_bindings: input.service_bindings } : {}),
      },
      requirements: { missing: ['project_brief'], collected: {} },
      payload: {
        bootstrap_kind: 'project_bootstrap',
        bootstrap_work_ids: workItems.map((item) => item.work_id),
      },
    });
    saveTaskSession(kickoff, { rootDir });
    missionSeedIds = workItems
      .filter((item) => item.kind === 'mission_seed')
      .map((item) => `MSD-${item.work_id.replace(/^WRK-/, '')}`);
    for (const seedId of missionSeedIds) {
      const seedPath = missionSeedRecordPath(seedId, rootDir);
      if (safeExistsSync(seedPath)) existingSeedPaths.add(seedPath);
    }
    const project = createManagedProjectInternal(
      {
        ...input,
        rootDir,
        status: input.status || 'active',
        metadata: { ...(input.metadata || {}), created_from: 'project-management-facade' },
      },
      true
    );
    const nextProject: ProjectRecord = {
      ...project,
      ...(input.track_id
        ? { default_track_id: input.track_id, active_tracks: [input.track_id] }
        : {}),
      ...(input.service_bindings ? { service_bindings: input.service_bindings } : {}),
      ...(input.pipeline_refs ? { pipeline_refs: sortedUnique(input.pipeline_refs) } : {}),
      project_os_path: projectOsPath,
      active_missions: [],
      active_task_sessions: [kickoff.session_id],
      bootstrap_work_items: workItems,
      kickoff_task_session_id: kickoff.session_id,
      proposed_mission_ids: missionSeedIds,
    };
    saveProjectRecord(nextProject, { rootDir });
    const now = new Date().toISOString();
    for (const item of workItems.filter((candidate) => candidate.kind === 'mission_seed')) {
      const seedId = `MSD-${item.work_id.replace(/^WRK-/, '')}`;
      saveMissionSeedRecord(
        {
          seed_id: seedId,
          project_id: projectId,
          ...(input.track_id ? { track_id: input.track_id } : {}),
          ...(input.track_name ? { track_name: input.track_name } : {}),
          source_task_session_id: kickoff.session_id,
          source_work_id: item.work_id,
          title: item.title,
          summary: item.summary,
          status: 'ready',
          specialist_id: item.specialist_id,
          ...(item.outcome_id ? { outcome_id: item.outcome_id } : {}),
          mission_type_hint: 'general',
          ...(input.primary_locale ? { locale: input.primary_locale } : {}),
          created_at: now,
          updated_at: now,
          metadata: { bootstrap_source: 'project-management-facade' },
        },
        { rootDir }
      );
    }
    saveProjectOperationalState(
      {
        project_id: projectId,
        name: nextProject.name,
        summary: nextProject.summary,
        status: nextProject.status,
        tier: nextProject.tier,
        // EG-14: the state file is partitioned by tier AND tenant. Omitting the
        // slug made saveProjectOperationalState fall back to `shared`, so a
        // confidential project's state landed in the shared partition — outside
        // the tenant boundary that was supposed to contain it, and invisible to
        // any tenant-scoped query.
        ...(nextProject.tenant_slug ? { tenant_slug: nextProject.tenant_slug } : {}),
        ...(input.project_path ? { project_path: input.project_path } : {}),
        active_track_ids: input.track_id ? [input.track_id] : [],
        active_mission_ids: [],
        active_task_session_ids: [kickoff.session_id],
        source_refs: [`project:${projectId}`, `task_session:${kickoff.session_id}`],
        sources: [
          {
            kind: 'task_session',
            ref: `task_session:${kickoff.session_id}`,
            summary: kickoffWork.title,
            captured_at: now,
          },
        ],
        distill_targets: [`knowledge/product/evolution/projects/${projectId}/project-state.md`],
        knowledge_refs: [],
        updated_at: now,
      },
      { rootDir }
    );
    const result = {
      project: nextProject,
      kickoff_task_session: kickoff,
      mission_seed_ids: missionSeedIds,
      work_items: workItems,
    };
    committedResult = result;
    if (input.onCommit) {
      commitCallbackStarted = true;
      input.onCommit(result);
    }
    commitCompleted = true;
    auditChain.record({
      agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
      action: 'project.created',
      operation: `create:${projectId}`,
      result: 'completed',
      metadata: {
        project_id: projectId,
        tier: project.tier,
        ...(project.organization_id ? { organization_id: project.organization_id } : {}),
      },
    });
    auditChain.record({
      agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
      action: 'project.bootstrap_created',
      operation: `bootstrap:${projectId}`,
      result: 'completed',
      metadata: {
        project_id: projectId,
        kickoff_task_session_id: kickoff.session_id,
        mission_seed_ids: missionSeedIds,
      },
    });
    return result;
  } catch (error) {
    safeUnlinkSync(projectRecordPath(projectId, rootDir));
    if (kickoffId && !kickoffExisted) safeUnlinkSync(taskSessionPath(kickoffId, rootDir));
    for (const seedId of missionSeedIds) {
      const seedPath = missionSeedRecordPath(seedId, rootDir);
      if (!existingSeedPaths.has(seedPath)) safeUnlinkSync(seedPath);
    }
    if (!projectStateExisted) safeUnlinkSync(projectStatePath);
    if (projectOsPath && !projectOsExisted)
      safeRmSync(projectOsPath, { recursive: true, force: true });
    if (previousOrganizationState) {
      saveOrganizationOperationalState(previousOrganizationState, { rootDir });
    }
    if (commitCallbackStarted || commitCompleted) {
      try {
        if (committedResult) input.onRollback?.(committedResult, error);
      } catch {
        // Preserve the original bootstrap failure after best-effort commit compensation.
      }
    }
    try {
      auditChain.record({
        agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
        action: 'project.bootstrap_rollback',
        operation: `rollback:${projectId}`,
        result: 'completed',
        metadata: { project_id: projectId, reason: String(error) },
      });
    } catch {
      // Audit failure must not hide the original bootstrap failure.
    }
    throw error;
  }
}

export function listManagedProjects(rootDir = pathResolver.rootDir()): ProjectManagementView[] {
  return listProjectRecords(rootDir).map((project) =>
    getProjectManagementView(project.project_id, rootDir)
  );
}
