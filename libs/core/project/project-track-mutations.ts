import { getRegisteredEnvText } from '../foundation/env.js';
import { auditChain } from '../governance/audit-chain.js';
import { safeUnlinkSync } from '../secure-io.js';
import { loadProjectRecord, saveProjectRecord } from './project-registry.js';
import {
  listProjectOperationalStates,
  listProjectOperationalStatePaths,
  saveProjectOperationalState,
} from './project-operational-state-registry.js';
import {
  listProjectTracksForProject,
  loadProjectTrackRecord,
  saveProjectTrackRecord,
  type ProjectTrackRecord,
} from './project-track-registry.js';
import { assertManagedProjectTrackScope } from './project-track-scope.js';
import { ACTIVE_PROJECT_MISSION_STATUSES } from './project-mission-index.js';
import {
  ACTIVE_TASK_SESSION_STATUSES,
  assertProjectLifecycleOwner,
} from './project-lifecycle-guards.js';
import {
  isInProjectScope,
  isMissionInProjectScope,
  isTrackInProjectScope,
  projectMissions,
  projectSessions,
} from './project-view-scope.js';

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

function normalizeId(value: string, label: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) throw new Error(`${label} is required`);
  return normalized;
}

function sortedUnique(values: string[] | undefined): string[] {
  return [...new Set((values || []).map((value) => String(value).trim()).filter(Boolean))].sort();
}

/** Track writes receive owner reconciliation without importing the management facade. */
export function createProjectTrackMutations(dependencies: {
  reconcile: (projectId: string) => void;
}) {
  const ACTIVE_MISSION_STATUSES = ACTIVE_PROJECT_MISSION_STATUSES;
  const kyberionEnv = getRegisteredEnvText;
  function createManagedProjectTrack(input: ManagedProjectTrackCreateInput): ProjectTrackRecord {
    assertProjectLifecycleOwner();
    const projectId = normalizeId(input.project_id, 'project_id');
    const trackId = normalizeId(input.track_id, 'track_id');
    const name = normalizeId(input.name, 'name');
    const summary = normalizeId(input.summary, 'summary');
    const project = loadProjectRecord(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);
    if (project.status === 'archived')
      throw new Error(`Restore project before creating tracks: ${projectId}`);
    if (loadProjectTrackRecord(trackId))
      throw new Error(`Project track already exists: ${trackId}`);
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
    const stateQuery = {
      projectId,
      tier: project.tier,
      tenantSlug: project.tenant_slug,
    };
    const previousStatePaths = listProjectOperationalStatePaths(stateQuery);
    const previousStates = listProjectOperationalStates(stateQuery);
    const trackPath = saveProjectTrackRecord(record);
    try {
      saveProjectRecord({
        ...project,
        ...(hasUsableDefaultTrack || record.status !== 'active'
          ? {}
          : { default_track_id: trackId }),
        active_tracks:
          record.status === 'active'
            ? sortedUnique([...(project.active_tracks || []), trackId])
            : sortedUnique(project.active_tracks),
      });
      dependencies.reconcile(projectId);
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
        for (const statePath of listProjectOperationalStatePaths(stateQuery)) {
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

  function updateManagedProjectTrack(
    trackId: string,
    patch: Partial<
      Pick<
        ProjectTrackRecord,
        | 'tenant_slug'
        | 'name'
        | 'summary'
        | 'status'
        | 'track_type'
        | 'lifecycle_model'
        | 'primary_locale'
        | 'release_id'
        | 'change_scope'
        | 'gate_profile_id'
        | 'required_artifacts'
        | 'metadata'
      >
    >
  ): ProjectTrackRecord {
    assertProjectLifecycleOwner();
    const current = loadProjectTrackRecord(normalizeId(trackId, 'track_id'));
    if (!current) throw new Error(`Project track not found: ${trackId}`);
    const project = loadProjectRecord(current.project_id);
    if (!project) throw new Error(`Project not found: ${current.project_id}`);
    const nextStatus = patch.status;
    const statusChanged = nextStatus !== undefined && nextStatus !== current.status;
    if (statusChanged) {
      const transitions: Record<ProjectTrackRecord['status'], ProjectTrackRecord['status'][]> = {
        planned: ['active', 'completed', 'archived'],
        active: ['paused', 'completed', 'archived'],
        paused: ['active', 'completed', 'archived'],
        completed: ['archived'],
        archived: [],
      };
      if (!transitions[current.status].includes(nextStatus)) {
        throw new Error(`Invalid track transition: ${current.status} -> ${nextStatus}`);
      }
      if (project.status === 'archived')
        throw new Error(`Restore project before changing track status: ${project.project_id}`);
      const activeMissions = projectMissions(project.project_id).filter(
        (mission) =>
          isMissionInProjectScope(mission, project) &&
          mission.relationships?.track?.track_id === current.track_id &&
          ACTIVE_MISSION_STATUSES.has(mission.status)
      );
      if (nextStatus !== 'active' && activeMissions.length) {
        throw new Error(
          `Cannot ${nextStatus} track with active missions: ${activeMissions.map((mission) => mission.mission_id).join(', ')}`
        );
      }
      const activeSessions = projectSessions(project.project_id).filter(
        (session) =>
          isInProjectScope(session, project) &&
          session.project_context?.track_id === current.track_id &&
          ACTIVE_TASK_SESSION_STATUSES.has(session.status)
      );
      if (nextStatus !== 'active' && activeSessions.length) {
        throw new Error(
          `Cannot ${nextStatus} track with active task sessions: ${activeSessions.map((session) => session.session_id).join(', ')}`
        );
      }
    }
    if (patch.tenant_slug && patch.tenant_slug !== project.tenant_slug) {
      throw new Error(
        `Project track tenant '${patch.tenant_slug}' must match project tenant '${project.tenant_slug || 'shared'}'.`
      );
    }
    const next = {
      ...current,
      ...patch,
      ...(patch.name !== undefined ? { name: normalizeId(patch.name, 'name') } : {}),
      ...(patch.summary !== undefined ? { summary: normalizeId(patch.summary, 'summary') } : {}),
      ...(patch.metadata ? { metadata: { ...current.metadata, ...patch.metadata } } : {}),
      ...(patch.required_artifacts
        ? { required_artifacts: sortedUnique(patch.required_artifacts) }
        : {}),
      ...(patch.tenant_slug ? { tenant_slug: patch.tenant_slug } : {}),
    };
    assertManagedProjectTrackScope(project, next);
    const stateQuery = {
      projectId: current.project_id,
      tier: project.tier,
      tenantSlug: project.tenant_slug,
    };
    const previousStatePaths = listProjectOperationalStatePaths(stateQuery);
    const previousStates = listProjectOperationalStates(stateQuery);
    saveProjectTrackRecord(next);
    try {
      if (statusChanged) {
        const activeTracks = listProjectTracksForProject(project.project_id).filter(
          (track) => isTrackInProjectScope(track, project) && track.status === 'active'
        );
        const nextProject = { ...project };
        if (!activeTracks.some((track) => track.track_id === project.default_track_id)) {
          if (activeTracks.length) nextProject.default_track_id = activeTracks[0].track_id;
          else delete nextProject.default_track_id;
        }
        if (nextProject.default_track_id !== project.default_track_id)
          saveProjectRecord(nextProject);
      }
      dependencies.reconcile(current.project_id);
      auditChain.record({
        agentId: kyberionEnv('KYBERION_PERSONA') || 'project_controller',
        action: 'project.track_updated',
        operation: `update:${current.track_id}`,
        result: 'completed',
        metadata: {
          project_id: current.project_id,
          track_id: current.track_id,
          fields: Object.keys(patch),
          previous_status: current.status,
          status: next.status,
        },
      });
    } catch (error) {
      try {
        saveProjectTrackRecord(current);
        saveProjectRecord(project);
        for (const statePath of listProjectOperationalStatePaths(stateQuery)) {
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
  return { createManagedProjectTrack, updateManagedProjectTrack };
}
