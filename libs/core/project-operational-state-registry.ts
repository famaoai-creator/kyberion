import AjvModule, { type ValidateFunction } from 'ajv';
import * as path from 'node:path';
import { loadProjectRecord } from './project-registry.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeMkdir, safeReadFile, safeReaddir, safeStat, safeWriteFile } from './secure-io.js';

export interface ProjectOperationalStateSource {
  kind: 'mission' | 'track' | 'task_session' | 'artifact' | 'service_binding' | 'surface_event' | 'manual_note' | 'other';
  ref: string;
  summary?: string;
  captured_at?: string;
}

export interface ProjectOperationalState {
  project_id: string;
  name: string;
  summary: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  tier: 'personal' | 'confidential' | 'public';
  tenant_slug?: string;
  project_path?: string;
  current_phase?: 'initiate' | 'define' | 'design' | 'build' | 'validate' | 'transfer_run' | 'run' | 'unknown';
  active_track_ids?: string[];
  active_mission_ids?: string[];
  active_task_session_ids?: string[];
  source_refs?: string[];
  sources?: ProjectOperationalStateSource[];
  distill_targets?: string[];
  knowledge_refs?: string[];
  last_distilled_at?: string;
  updated_at?: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectOperationalStateQuery {
  projectId?: string;
  tier?: 'personal' | 'confidential' | 'public';
  tenantSlug?: string;
}

export interface ProjectOperationalStateMissionContext {
  mission_id: string;
  mission_type?: string;
  tier: 'personal' | 'confidential' | 'public';
  status: string;
  tenant_slug?: string;
  tenant_id?: string;
  relationships?: {
    project?: {
      project_id?: string;
      project_path?: string;
      relationship_type?: string;
      affected_artifacts?: string[];
      gate_impact?: string;
      traceability_refs?: string[];
      note?: string;
    };
    track?: {
      track_id?: string;
      track_name?: string;
      track_type?: string;
      lifecycle_model?: string;
      relationship_type?: string;
      traceability_refs?: string[];
      note?: string;
    };
  };
  assigned_persona?: string;
  context?: {
    last_action?: string;
    next_step?: string;
    associated_projects?: string[];
    routing_decision_summary?: string;
    mission_finish_trace_persisted_path?: string;
    distill_output_path?: string;
  };
  outcome_contract?: {
    outcome_id?: string;
    requested_result?: string;
  };
}

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });
const STATE_SCHEMA_PATH = pathResolver.knowledge('product/schemas/project-operational-state.schema.json');
const STATE_ROOT = pathResolver.active('projects');
const STATE_FILE_NAME = 'project-state.json';
let stateValidateFn: ValidateFunction | null = null;

function ensureValidator(): ValidateFunction {
  if (stateValidateFn) return stateValidateFn;
  const raw = safeReadFile(STATE_SCHEMA_PATH, { encoding: 'utf8' }) as string;
  stateValidateFn = ajv.compile(JSON.parse(raw));
  return stateValidateFn;
}

function normalizeSegment(value: string, fallback = 'shared'): string {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^a-zA-Z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function projectStateWorkspaceDir(projectId: string, tier: ProjectOperationalState['tier'], tenantSlug?: string): string {
  return pathResolver.projectWorkspaceDir(projectId, tier, tenantSlug || 'shared');
}

function missionStatusToPhase(status: string): NonNullable<ProjectOperationalState['current_phase']> {
  switch (status) {
    case 'planned':
      return 'initiate';
    case 'active':
      return 'build';
    case 'validating':
    case 'distilling':
      return 'validate';
    case 'completed':
    case 'archived':
      return 'transfer_run';
    case 'paused':
      return 'run';
    case 'failed':
      return 'validate';
    default:
      return 'unknown';
  }
}

export function projectOperationalStateDir(projectId: string, tier: ProjectOperationalState['tier'], tenantSlug?: string): string {
  return path.join(projectStateWorkspaceDir(projectId, tier, tenantSlug), 'state');
}

export function projectOperationalStatePath(projectId: string, tier: ProjectOperationalState['tier'], tenantSlug?: string): string {
  return path.join(projectOperationalStateDir(projectId, tier, tenantSlug), STATE_FILE_NAME);
}

export function projectOperationalMissionLinkPath(projectId: string, tier: ProjectOperationalState['tier'], tenantSlug: string | undefined, missionId: string): string {
  return path.join(projectStateWorkspaceDir(projectId, tier, tenantSlug), 'state', 'missions', normalizeSegment(missionId), 'mission-link.json');
}

export function projectOperationalTrackStatePath(projectId: string, tier: ProjectOperationalState['tier'], tenantSlug: string | undefined, trackId: string): string {
  return path.join(projectStateWorkspaceDir(projectId, tier, tenantSlug), 'state', 'tracks', normalizeSegment(trackId), 'track-state.json');
}

export function validateProjectOperationalState(value: unknown): value is ProjectOperationalState {
  return Boolean(ensureValidator()(value));
}

function normalizeProjectOperationalState(record: ProjectOperationalState): ProjectOperationalState {
  return {
    ...record,
    tenant_slug: record.tenant_slug?.trim() || undefined,
    active_track_ids: record.active_track_ids || [],
    active_mission_ids: record.active_mission_ids || [],
    active_task_session_ids: record.active_task_session_ids || [],
    source_refs: record.source_refs || [],
    sources: record.sources || [],
    distill_targets: record.distill_targets || [],
    knowledge_refs: record.knowledge_refs || [],
    updated_at: record.updated_at || new Date().toISOString(),
  };
}

function stateRecordMatchesQuery(record: ProjectOperationalState, query: ProjectOperationalStateQuery): boolean {
  if (query.projectId && record.project_id !== query.projectId) return false;
  if (query.tier && record.tier !== query.tier) return false;
  if (query.tenantSlug && (record.tenant_slug || 'shared') !== query.tenantSlug) return false;
  return true;
}

function recursiveProjectStateFiles(dir: string): string[] {
  if (!safeExistsSync(dir)) return [];
  const entries = safeReaddir(dir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dir, entry);
    if (!safeExistsSync(fullPath)) continue;
    const stat = safeStat(fullPath);
    if (stat.isDirectory()) {
      files.push(...recursiveProjectStateFiles(fullPath));
      continue;
    }
    if (entry === STATE_FILE_NAME) files.push(fullPath);
  }
  return files;
}

function projectStateFilesForQuery(query: ProjectOperationalStateQuery = {}): string[] {
  if (query.projectId && query.tier) {
    const pathHint = projectOperationalStatePath(query.projectId, query.tier, query.tenantSlug);
    if (safeExistsSync(pathHint)) return [pathHint];
  }
  if (query.projectId && query.tenantSlug && !query.tier) {
    const tiers: Array<ProjectOperationalState['tier']> = ['personal', 'confidential', 'public'];
    const direct = tiers
      .map((tier) => projectOperationalStatePath(query.projectId!, tier, query.tenantSlug))
      .filter((candidate) => safeExistsSync(candidate));
    if (direct.length > 0) return direct;
  }
  return recursiveProjectStateFiles(STATE_ROOT);
}

export function saveProjectOperationalState(record: ProjectOperationalState): string {
  const normalized = normalizeProjectOperationalState(record);
  if (!validateProjectOperationalState(normalized)) {
    const errors = (ensureValidator().errors || []).map((error) => `${error.instancePath || '/'} ${error.message || 'schema violation'}`);
    throw new Error(`Invalid project operational state: ${errors.join('; ')}`);
  }
  const filePath = projectOperationalStatePath(normalized.project_id, normalized.tier, normalized.tenant_slug);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify(normalized, null, 2));
  return filePath;
}

export function loadProjectOperationalState(projectId: string, query: Omit<ProjectOperationalStateQuery, 'projectId'> = {}): ProjectOperationalState | null {
  const files = projectStateFilesForQuery({ projectId, ...query });
  for (const filePath of files) {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as ProjectOperationalState;
    if (validateProjectOperationalState(parsed) && parsed.project_id === projectId && stateRecordMatchesQuery(parsed, { projectId, ...query })) {
      return parsed;
    }
  }
  return null;
}

export function listProjectOperationalStates(query: ProjectOperationalStateQuery = {}): ProjectOperationalState[] {
  const files = projectStateFilesForQuery(query);
  const states: ProjectOperationalState[] = [];
  for (const filePath of files) {
    try {
      const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(raw) as ProjectOperationalState;
      if (validateProjectOperationalState(parsed) && stateRecordMatchesQuery(parsed, query)) {
        states.push(parsed);
      }
    } catch (_) {
      continue;
    }
  }
  return states.sort((a, b) => {
    const aKey = `${a.tier}:${a.tenant_slug || 'shared'}:${a.project_id}`;
    const bKey = `${b.tier}:${b.tenant_slug || 'shared'}:${b.project_id}`;
    return aKey.localeCompare(bKey);
  });
}

export function listProjectOperationalStatePaths(query: ProjectOperationalStateQuery = {}): string[] {
  return projectStateFilesForQuery(query).sort();
}

export function saveProjectMissionLink(input: {
  project_id: string;
  tier: ProjectOperationalState['tier'];
  mission_id: string;
  tenant_slug?: string;
  relationship_type: string;
  summary: string;
  status: string;
  evidence_refs?: string[];
  updated_at?: string;
}): string {
  const filePath = projectOperationalMissionLinkPath(input.project_id, input.tier, input.tenant_slug, input.mission_id);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify({
    ...input,
    updated_at: input.updated_at || new Date().toISOString(),
  }, null, 2));
  return filePath;
}

export function saveProjectTrackState(input: {
  project_id: string;
  tier: ProjectOperationalState['tier'];
  track_id: string;
  tenant_slug?: string;
  name: string;
  summary: string;
  status: string;
  lifecycle_model?: string;
  required_artifacts?: string[];
  active_mission_ids?: string[];
  updated_at?: string;
}): string {
  const filePath = projectOperationalTrackStatePath(input.project_id, input.tier, input.tenant_slug, input.track_id);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(filePath, JSON.stringify({
    ...input,
    tenant_slug: input.tenant_slug?.trim() || undefined,
    active_mission_ids: input.active_mission_ids || [],
    updated_at: input.updated_at || new Date().toISOString(),
  }, null, 2));
  return filePath;
}

function readProjectStateIfExists(projectId: string, tier: ProjectOperationalState['tier'], tenantSlug?: string): ProjectOperationalState | null {
  const statePath = projectOperationalStatePath(projectId, tier, tenantSlug);
  if (!safeExistsSync(statePath)) return null;
  try {
    const raw = safeReadFile(statePath, { encoding: 'utf8' }) as string;
    const parsed = JSON.parse(raw) as ProjectOperationalState;
    return validateProjectOperationalState(parsed) ? parsed : null;
  } catch (_) {
    return null;
  }
}

function listProjectStateFiles(rootDir: string): string[] {
  if (!safeExistsSync(rootDir)) return [];
  const entries = safeReaddir(rootDir);
  const files: string[] = [];
  for (const entry of entries) {
    const fullPath = path.join(rootDir, entry);
    if (!safeExistsSync(fullPath)) continue;
    const stat = safeStat(fullPath);
    if (stat.isDirectory()) {
      files.push(...listProjectStateFiles(fullPath));
      continue;
    }
    if (entry === STATE_FILE_NAME) files.push(fullPath);
  }
  return files;
}

function loadAllProjectStateRecords(projectId: string): Array<{ tier: ProjectOperationalState['tier']; tenant_slug?: string; record: ProjectOperationalState }> {
  const files = listProjectStateFiles(STATE_ROOT);
  const records: Array<{ tier: ProjectOperationalState['tier']; tenant_slug?: string; record: ProjectOperationalState }> = [];
  for (const filePath of files) {
    try {
      const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
      const parsed = JSON.parse(raw) as ProjectOperationalState;
      if (!validateProjectOperationalState(parsed) || parsed.project_id !== projectId) continue;
      records.push({ tier: parsed.tier, tenant_slug: parsed.tenant_slug, record: parsed });
    } catch (_) {
      continue;
    }
  }
  return records;
}

function collectSourceRefs(input: ProjectOperationalStateMissionContext): string[] {
  const refs = new Set<string>();
  refs.add(`mission:${input.mission_id}`);
  if (input.relationships?.project?.project_id) refs.add(`project:${input.relationships.project.project_id}`);
  if (input.relationships?.project?.project_path) refs.add(`project_path:${input.relationships.project.project_path}`);
  if (input.relationships?.track?.track_id) refs.add(`track:${input.relationships.track.track_id}`);
  if (input.context?.mission_finish_trace_persisted_path) refs.add(`trace:${input.context.mission_finish_trace_persisted_path}`);
  if (input.context?.distill_output_path) refs.add(`knowledge:${input.context.distill_output_path}`);
  return [...refs];
}

function dedupeSources(sources: ProjectOperationalState['sources'] = []): ProjectOperationalState['sources'] {
  const seen = new Set<string>();
  const next: NonNullable<ProjectOperationalState['sources']> = [];
  for (const source of sources) {
    if (!source?.ref || seen.has(source.ref)) continue;
    seen.add(source.ref);
    next.push(source);
  }
  return next;
}

export function syncProjectOperationalStateFromMission(input: ProjectOperationalStateMissionContext): string | null {
  const projectId = input.relationships?.project?.project_id?.trim();
  if (!projectId) return null;
  const tenantSlug = (input.tenant_slug || input.tenant_id || 'shared').trim() || 'shared';
  const existingProject = loadProjectRecord(projectId);
  const projectPath = input.relationships?.project?.project_path?.trim();

  const projectState = readProjectStateIfExists(projectId, input.tier, tenantSlug) || {
    project_id: projectId,
    name: existingProject?.name || projectId,
    summary: existingProject?.summary || input.relationships?.project?.note || input.outcome_contract?.requested_result || `Operational state for ${projectId}`,
    status: 'active',
    tier: input.tier,
    tenant_slug: tenantSlug,
    project_path: projectPath,
    active_track_ids: [],
    active_mission_ids: [],
    active_task_session_ids: [],
    source_refs: [],
    sources: [],
    distill_targets: [`knowledge/product/evolution/projects/${projectId}/project-state.md`],
    knowledge_refs: [],
    updated_at: new Date().toISOString(),
  } satisfies ProjectOperationalState;

  const missionLinkPath = saveProjectMissionLink({
    project_id: projectId,
    tier: input.tier,
    tenant_slug: tenantSlug,
    mission_id: input.mission_id,
    relationship_type: input.relationships?.project?.relationship_type || 'independent',
    summary: input.relationships?.project?.note || input.outcome_contract?.requested_result || input.mission_type || 'mission',
    status: input.status,
    evidence_refs: input.context?.mission_finish_trace_persisted_path ? [input.context.mission_finish_trace_persisted_path] : [],
  });

  const trackId = input.relationships?.track?.track_id?.trim();
  if (trackId) {
    saveProjectTrackState({
      project_id: projectId,
      tier: input.tier,
      tenant_slug: tenantSlug,
      track_id: trackId,
      name: input.relationships.track?.track_name || trackId,
      summary: input.relationships.track?.note || input.relationships.track?.track_name || trackId,
      status: input.status === 'archived' ? 'archived' : input.status === 'completed' ? 'completed' : input.status === 'paused' ? 'paused' : 'active',
      lifecycle_model: input.relationships.track?.lifecycle_model,
      required_artifacts: [],
      active_mission_ids: input.status === 'archived' ? [] : [input.mission_id],
    });
  }

  const allStates = loadAllProjectStateRecords(projectId).filter((entry) => entry.record.tenant_slug === tenantSlug && entry.tier === input.tier);
  const projectStateDirPath = projectOperationalStateDir(projectId, input.tier, tenantSlug);
  const missionStates: Array<{ record: ProjectOperationalState }> = allStates;
  const activeMissionIds = new Set<string>();
  const activeTrackIds = new Set<string>();
  const sourceRefs = new Set<string>(collectSourceRefs(input));
  for (const entry of missionStates) {
    const record = entry.record;
    if (record.status !== 'archived') {
      if (record.active_mission_ids?.length) {
        for (const missionId of record.active_mission_ids) activeMissionIds.add(missionId);
      }
      if (record.active_track_ids?.length) {
        for (const id of record.active_track_ids) activeTrackIds.add(id);
      }
    }
    for (const ref of record.source_refs || []) sourceRefs.add(ref);
    for (const knowledgeRef of record.knowledge_refs || []) {
      if (knowledgeRef) sourceRefs.add(knowledgeRef);
    }
  }
  if (input.status !== 'archived') activeMissionIds.add(input.mission_id);
  if (trackId) activeTrackIds.add(trackId);

  const knowledgeRefs = new Set<string>(projectState.knowledge_refs || []);
  const distillTarget = `knowledge/product/evolution/projects/${projectId}/project-state.md`;
  const distillTargets = new Set<string>(projectState.distill_targets || [distillTarget]);
  if (input.context?.mission_finish_trace_persisted_path) knowledgeRefs.add(input.context.mission_finish_trace_persisted_path);
  if (input.context?.distill_output_path) knowledgeRefs.add(input.context.distill_output_path);

  const nextStatus: ProjectOperationalState['status'] =
    activeMissionIds.size > 0
      ? 'active'
      : (existingProject?.status || projectState.status || 'paused');

  const nextState: ProjectOperationalState = {
    ...projectState,
    project_path: projectPath || projectState.project_path,
    name: existingProject?.name || projectState.name,
    summary: existingProject?.summary || projectState.summary,
    status: nextStatus,
    tier: input.tier,
    tenant_slug: tenantSlug,
    current_phase: missionStatusToPhase(input.status),
    active_track_ids: [...activeTrackIds].sort(),
    active_mission_ids: [...activeMissionIds].sort(),
    active_task_session_ids: projectState.active_task_session_ids || [],
    source_refs: [...sourceRefs].sort(),
    sources: dedupeSources([
      ...(projectState.sources || []).filter((entry) => entry.ref !== `mission:${input.mission_id}` && entry.ref !== `track:${trackId || ''}`),
      {
        kind: 'mission' as const,
        ref: `mission:${input.mission_id}`,
        summary: input.relationships?.project?.note || input.outcome_contract?.requested_result || input.mission_type || 'mission',
        captured_at: new Date().toISOString(),
      },
      ...(trackId ? [{
        kind: 'track' as const,
        ref: `track:${trackId}`,
        summary: input.relationships?.track?.note || input.relationships?.track?.track_name || trackId,
        captured_at: new Date().toISOString(),
      }] : []),
      ...(input.context?.distill_output_path ? [{
        kind: 'artifact' as const,
        ref: `knowledge:${input.context.distill_output_path}`,
        summary: 'Distilled knowledge output',
        captured_at: new Date().toISOString(),
      }] : []),
    ]),
    distill_targets: [...distillTargets].sort(),
    knowledge_refs: [...knowledgeRefs].sort(),
    last_distilled_at: input.status === 'completed' || input.status === 'archived' ? new Date().toISOString() : projectState.last_distilled_at,
    updated_at: new Date().toISOString(),
    metadata: {
      ...(projectState.metadata || {}),
      mission_link_path: missionLinkPath,
      project_state_dir: projectStateDirPath,
      last_mission_id: input.mission_id,
      last_mission_status: input.status,
      last_mission_type: input.mission_type,
      last_assigned_persona: input.assigned_persona,
    },
  };

  return saveProjectOperationalState(nextState);
}
