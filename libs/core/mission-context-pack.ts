import AjvModule, { type ValidateFunction } from 'ajv';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { compileSchemaFromPath } from './schema-loader.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeWriteFile,
} from './secure-io.js';
import { findRelevantDistilledKnowledge, type DistilledKnowledgeEntry } from './distill-knowledge-injector.js';
import {
  findReusableArtifactOwnershipRecord,
  listArtifactOwnershipRecordsForProject,
  type ArtifactOwnershipRecord,
} from './artifact-registry.js';
import { findMissionPath, pathResolver } from './path-resolver.js';
import {
  loadProjectOperationalState,
  projectOperationalStatePath,
  type ProjectOperationalState,
} from './project-operational-state-registry.js';
import {
  loadProjectTrackRecord,
  type ProjectTrackRecord,
} from './project-track-registry.js';
import {
  getMissionTeamPlanPath,
  loadMissionTeamPlan,
  resolveMissionTeamPlan,
  type MissionTeamAssignment,
} from './mission-team-plan-composer.js';
import {
  getWorkItem,
  type WorkItem,
} from './work-coordination.js';
import {
  loadTaskSession,
  validateTaskSession,
  type TaskSession,
} from './task-session.js';

const Ajv = (AjvModule as any).default ?? AjvModule;
const ajv = new Ajv({ allErrors: true });

const MISSION_STATE_SCHEMA_PATH = pathResolver.rootResolve('schemas/mission-state.schema.json');
const MISSION_CONTEXT_PACK_SCHEMA_PATH = pathResolver.knowledge('product/schemas/mission-context-pack.schema.json');

type MissionTier = 'personal' | 'confidential' | 'public';
type MissionStatus = 'planned' | 'active' | 'validating' | 'distilling' | 'completed' | 'paused' | 'failed' | 'archived';
type MissionContextRecipientKind = 'agent' | 'subagent' | 'reviewer' | 'operator' | 'planner' | 'tester';
type MissionContextDeliveryMode = 'prompt' | 'artifact';

export interface MissionStateSummary {
  mission_id: string;
  mission_type?: string;
  tenant_id?: string;
  tenant_slug?: string;
  vision_ref?: string;
  tier: MissionTier;
  status: MissionStatus | string;
  execution_mode?: string;
  assigned_persona: string;
  priority?: number;
  confidence_score?: number;
  git: {
    branch: string;
    start_commit: string;
    latest_commit: string;
    checkpoints: Array<{ task_id: string; commit_hash: string; ts: string }>;
  };
  history: Array<{ ts: string; event: string; from?: string; to?: string; note: string }>;
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
  context?: {
    last_action?: string;
    next_step?: string;
    routing_decision_summary?: string;
    mission_finish_trace_persisted_path?: string;
    distill_output_path?: string;
  };
  outcome_contract?: {
    outcome_id?: string;
    requested_result?: string;
    deliverable_kind?: string;
    success_criteria?: string[];
    evidence_required?: boolean;
  };
}

export interface MissionContextPackSource {
  kind:
    | 'mission_state'
    | 'mission_team'
    | 'project_state'
    | 'project_track'
    | 'task_session'
    | 'work_item'
    | 'knowledge_hint'
    | 'other';
  ref: string;
  path?: string;
  summary?: string;
  captured_at?: string;
  tier?: MissionTier;
  tenant_slug?: string;
}

export interface MissionContextPackRecipient {
  kind: MissionContextRecipientKind;
  team_role?: string;
  agent_id?: string;
  authority_role?: string;
  provider?: string | null;
  modelId?: string | null;
  delegation_contract?: MissionTeamAssignment['delegation_contract'];
  required_capabilities?: string[];
  notes?: string;
}

export interface MissionContextPackScope {
  tier: MissionTier;
  mission_id: string;
  tenant_slug?: string;
  project_id?: string;
  track_id?: string;
  task_session_id?: string;
  work_item_id?: string;
}

export interface MissionContextPackKnowledgeHint {
  path: string;
  title: string;
  excerpt: string;
  tags: string[];
  score?: number;
  category?: string;
  source_mission?: string;
  last_updated?: string;
}

export interface MissionContextPackArtifactHint {
  artifact_id: string;
  kind: string;
  storage_class: ArtifactOwnershipRecord['storage_class'];
  project_id?: string;
  mission_id?: string;
  task_session_id?: string;
  path?: string;
  external_ref?: string;
  created_at?: string;
  evidence_refs?: string[];
  reuse_reason: string;
}

export interface MissionContextPackMissionSummary {
  mission_id: string;
  mission_type?: string;
  tier: MissionTier;
  status: MissionStatus | string;
  assigned_persona: string;
  tenant_id?: string;
  tenant_slug?: string;
  vision_ref?: string;
  execution_mode?: string;
  priority?: number;
  confidence_score?: number;
  relationships?: MissionStateSummary['relationships'];
  context?: MissionStateSummary['context'];
  outcome_contract?: MissionStateSummary['outcome_contract'];
}

export interface MissionContextPackProjectSummary {
  project_id: string;
  name: string;
  summary: string;
  status: ProjectOperationalState['status'];
  tier: ProjectOperationalState['tier'];
  tenant_slug?: string;
  project_path?: string;
  current_phase?: ProjectOperationalState['current_phase'];
  active_track_ids?: string[];
  active_mission_ids?: string[];
  active_task_session_ids?: string[];
  source_refs?: string[];
  distill_targets?: string[];
  knowledge_refs?: string[];
  last_distilled_at?: string;
}

export interface MissionContextPackTrackSummary {
  track_id: string;
  project_id: string;
  name: string;
  summary: string;
  status: ProjectTrackRecord['status'];
  track_type: ProjectTrackRecord['track_type'];
  lifecycle_model: ProjectTrackRecord['lifecycle_model'];
  tier: ProjectTrackRecord['tier'];
  primary_locale?: string;
  release_id?: string;
  change_scope?: string;
  gate_profile_id?: string;
  active_mission_ids?: string[];
  required_artifacts?: string[];
}

export interface MissionContextPackTaskSessionSummary {
  session_id: string;
  surface: TaskSession['surface'];
  task_type: TaskSession['task_type'];
  status: TaskSession['status'];
  mode: TaskSession['mode'];
  goal: TaskSession['goal'];
  project_context?: TaskSession['project_context'];
  requirements?: TaskSession['requirements'];
  artifact?: TaskSession['artifact'];
  control?: TaskSession['control'];
  outcome_contract?: TaskSession['outcome_contract'];
  updated_at: string;
}

export interface MissionContextPackWorkItemSummary {
  item_id: string;
  title: string;
  description: string;
  status: WorkItem['status'];
  priority: WorkItem['priority'];
  source: WorkItem['source'];
  source_ref: string;
  project_id: string;
  assignee_peer_id?: string;
  assignee_user_id?: string;
  labels: string[];
  dependencies: string[];
  metadata?: Record<string, unknown>;
}

export interface MissionContextPack {
  context_pack_id: string;
  version: '1';
  generated_at: string;
  summary: string;
  scope: MissionContextPackScope;
  recipient: MissionContextPackRecipient;
  mission: MissionContextPackMissionSummary;
  project?: MissionContextPackProjectSummary;
  track?: MissionContextPackTrackSummary;
  task_session?: MissionContextPackTaskSessionSummary;
  work_item?: MissionContextPackWorkItemSummary;
  knowledge_hints?: MissionContextPackKnowledgeHint[];
  artifact_hints?: MissionContextPackArtifactHint[];
  sources: MissionContextPackSource[];
  redactions: string[];
  delivery: {
    mode: MissionContextDeliveryMode;
    summary: string;
  };
  context_pack_path?: string;
}

export interface BuildMissionContextPackInput {
  missionState: MissionStateSummary;
  missionPath?: string;
  recipientKind?: MissionContextRecipientKind;
  teamRole?: string;
  assigneePeerId?: string;
  workItem?: WorkItem | null;
  taskSession?: TaskSession | null;
  projectState?: ProjectOperationalState | null;
  trackRecord?: ProjectTrackRecord | null;
  missionTeamAssignment?: MissionTeamAssignment | null;
  knowledgeHints?: MissionContextPackKnowledgeHint[];
  contextPackId?: string;
}

export interface ResolveMissionContextPackInput {
  missionId: string;
  tier?: MissionTier;
  tenantSlug?: string;
  recipientKind?: MissionContextRecipientKind;
  teamRole?: string;
  assigneePeerId?: string;
  workItemId?: string;
  taskSessionId?: string;
  projectId?: string;
  trackId?: string;
  includeKnowledgeHints?: boolean;
  missionState?: MissionStateSummary | null;
  workItem?: WorkItem | null;
  taskSession?: TaskSession | null;
  projectState?: ProjectOperationalState | null;
  trackRecord?: ProjectTrackRecord | null;
  contextPackId?: string;
}

let missionStateValidateFn: ValidateFunction | null = null;
let missionContextPackValidateFn: ValidateFunction | null = null;

function ensureMissionStateValidator(): ValidateFunction {
  if (missionStateValidateFn) return missionStateValidateFn;
  missionStateValidateFn = compileSchemaFromPath(ajv, MISSION_STATE_SCHEMA_PATH);
  return missionStateValidateFn;
}

function ensureMissionContextPackValidator(): ValidateFunction {
  if (missionContextPackValidateFn) return missionContextPackValidateFn;
  missionContextPackValidateFn = compileSchemaFromPath(ajv, MISSION_CONTEXT_PACK_SCHEMA_PATH);
  return missionContextPackValidateFn;
}

function validationErrors(validate: ValidateFunction): string[] {
  return (validate.errors || []).map((error) =>
    `${error.instancePath || '/'} ${error.message || 'schema violation'}`.trim()
  );
}

function summarizeText(value: unknown, max = 180): string | undefined {
  const text = String(value || '').trim().replace(/\s+/g, ' ');
  if (!text) return undefined;
  return text.length <= max ? text : `${text.slice(0, Math.max(0, max - 3))}...`;
}

function normalizeTier(tier: unknown, fallback: MissionTier = 'public'): MissionTier {
  return tier === 'personal' || tier === 'confidential' || tier === 'public' ? tier : fallback;
}

function slugifySegment(value: string, fallback = 'shared'): string {
  return String(value || '')
    .trim()
    .replace(/[\\/]+/g, '-')
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '') || fallback;
}

function buildContextPackId(input: { missionId: string; teamRole?: string; recipientKind?: MissionContextRecipientKind; workItemId?: string }): string {
  const parts = ['CPK', slugifySegment(input.missionId.toUpperCase(), 'MISSION')];
  if (input.teamRole) parts.push(slugifySegment(input.teamRole, 'role'));
  else if (input.recipientKind) parts.push(slugifySegment(input.recipientKind, 'recipient'));
  if (input.workItemId) parts.push(slugifySegment(input.workItemId, 'item'));
  parts.push(randomUUID().slice(0, 8).toUpperCase());
  return parts.join('-');
}

function missionStatePath(missionId: string, tier: MissionTier): string {
  const missionPath = findMissionPath(missionId) || pathResolver.missionDir(missionId, tier);
  return path.join(missionPath, 'mission-state.json');
}

function loadMissionState(missionId: string, tier: MissionTier): MissionStateSummary | null {
  const filePath = missionStatePath(missionId, tier);
  if (!safeExistsSync(filePath)) return null;
  try {
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as MissionStateSummary;
    return ensureMissionStateValidator()(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function missionContextSummary(input: {
  missionId: string;
  teamRole?: string;
  recipientKind?: MissionContextRecipientKind;
  projectId?: string;
  trackId?: string;
  workItemId?: string;
  taskSessionId?: string;
  tenantSlug?: string;
}): string {
  const parts = [`mission=${input.missionId}`];
  if (input.teamRole) parts.push(`role=${input.teamRole}`);
  if (input.recipientKind) parts.push(`recipient=${input.recipientKind}`);
  if (input.projectId) parts.push(`project=${input.projectId}`);
  if (input.trackId) parts.push(`track=${input.trackId}`);
  if (input.workItemId) parts.push(`work_item=${input.workItemId}`);
  if (input.taskSessionId) parts.push(`task_session=${input.taskSessionId}`);
  if (input.tenantSlug) parts.push(`tenant=${input.tenantSlug}`);
  return parts.join(' / ');
}

function defaultRedactions(): string[] {
  return [
    'full Kyberion knowledge corpus',
    'unrelated mission histories',
    'cross-tier data outside the current scope',
    'other team roles and non-selected runtime logs',
  ];
}

function missionSources(input: {
  missionId: string;
  missionPath?: string;
  missionTier: MissionTier;
  tenantSlug?: string;
  teamRole?: string;
  recipientKind?: MissionContextRecipientKind;
  projectId?: string;
  trackId?: string;
  taskSessionId?: string;
  workItemId?: string;
  projectState?: ProjectOperationalState | null;
  trackRecord?: ProjectTrackRecord | null;
  taskSession?: TaskSession | null;
  workItem?: WorkItem | null;
  missionTeamAssignment?: MissionTeamAssignment | null;
  knowledgeHints?: MissionContextPackKnowledgeHint[];
}): MissionContextPackSource[] {
  const sources: MissionContextPackSource[] = [
    {
      kind: 'mission_state',
      ref: `mission:${input.missionId}`,
      path: input.missionPath ? path.join(input.missionPath, 'mission-state.json') : missionStatePath(input.missionId, input.missionTier),
      summary: `Mission state for ${input.missionId}`,
      captured_at: new Date().toISOString(),
    },
  ];

  if (input.teamRole && input.missionTeamAssignment) {
    const teamPlanPath = getMissionTeamPlanPath(input.missionId);
    sources.push({
      kind: 'mission_team',
      ref: `mission-team:${input.missionId}:${input.teamRole}`,
      ...(teamPlanPath ? { path: teamPlanPath } : {}),
      summary: input.missionTeamAssignment.agent_id
        ? `Role ${input.teamRole} assigned to ${input.missionTeamAssignment.agent_id}`
        : `Role ${input.teamRole} is unfilled`,
      captured_at: new Date().toISOString(),
    });
  }

  if (input.projectId && input.projectState) {
    sources.push({
      kind: 'project_state',
      ref: `project:${input.projectId}`,
      path: projectOperationalStatePath(input.projectId, input.missionTier, input.tenantSlug),
      summary: `Project state for ${input.projectId}`,
      captured_at: new Date().toISOString(),
    });
  }

  if (input.trackId && input.trackRecord) {
    sources.push({
      kind: 'project_track',
      ref: `track:${input.trackId}`,
      path: pathResolver.shared(`runtime/project-tracks/${input.trackId}.json`),
      summary: `Project track record for ${input.trackId}`,
      captured_at: new Date().toISOString(),
    });
  }

  if (input.taskSessionId && input.taskSession) {
    sources.push({
      kind: 'task_session',
      ref: `task-session:${input.taskSessionId}`,
      path: pathResolver.shared(`runtime/task-sessions/${input.taskSessionId}.json`),
      summary: `Task session ${input.taskSessionId}`,
      captured_at: new Date().toISOString(),
    });
  }

  if (input.workItemId && input.workItem) {
    sources.push({
      kind: 'work_item',
      ref: `work-item:${input.workItemId}`,
      summary: `Work item ${input.workItemId}`,
      captured_at: new Date().toISOString(),
    });
  }

  for (const hint of input.knowledgeHints || []) {
    sources.push({
      kind: 'knowledge_hint',
      ref: hint.path,
      path: hint.path,
      summary: hint.title,
      captured_at: new Date().toISOString(),
    });
  }

  return sources;
}

function missionAssignmentSummary(assignment: MissionTeamAssignment | null | undefined): MissionContextPackRecipient {
  if (!assignment) {
    return {
      kind: 'subagent',
      notes: 'No mission team assignment was resolved; using subagent context.',
    };
  }
  return {
    kind: 'agent',
    team_role: assignment.team_role,
    agent_id: assignment.agent_id || undefined,
    authority_role: assignment.authority_role || undefined,
    provider: assignment.provider || undefined,
    modelId: assignment.modelId || undefined,
    delegation_contract: assignment.delegation_contract || undefined,
    required_capabilities: assignment.required_capabilities || undefined,
    notes: assignment.notes,
  };
}

function loadTaskSessionIfPossible(taskSessionId?: string | null): TaskSession | null {
  if (!taskSessionId) return null;
  const session = loadTaskSession(taskSessionId);
  if (!session) return null;
  const validation = validateTaskSession(session);
  return validation.valid ? session : null;
}

function loadProjectStateIfPossible(input: {
  projectId?: string;
  missionState: MissionStateSummary;
  workItem?: WorkItem | null;
  tier: MissionTier;
  tenantSlug?: string;
}): ProjectOperationalState | null {
  const candidates = [
    input.projectId,
    input.missionState.relationships?.project?.project_id,
    input.workItem?.project_id,
  ].map((entry) => String(entry || '').trim()).filter(Boolean);
  const projectId = candidates[0];
  if (!projectId) return null;
  const queryTier = normalizeTier(input.missionState.tier, input.tier);
  return loadProjectOperationalState(projectId, {
    tier: queryTier,
    tenantSlug: input.tenantSlug || input.missionState.tenant_slug,
  });
}

function loadTrackStateIfPossible(input: {
  trackId?: string;
  projectState?: ProjectOperationalState | null;
  missionState: MissionStateSummary;
}): ProjectTrackRecord | null {
  const candidate = String(
    input.trackId ||
    input.missionState.relationships?.track?.track_id ||
    input.projectState?.active_track_ids?.[0] ||
    ''
  ).trim();
  if (!candidate) return null;
  return loadProjectTrackRecord(candidate);
}

async function loadKnowledgeHintsIfPossible(input: {
  missionState: MissionStateSummary;
  projectState?: ProjectOperationalState | null;
  trackRecord?: ProjectTrackRecord | null;
  teamRole?: string;
  workItem?: WorkItem | null;
  taskSession?: TaskSession | null;
}): Promise<MissionContextPackKnowledgeHint[]> {
  const topic = [
    input.missionState.mission_type,
    input.teamRole,
    input.projectState?.name,
    input.projectState?.summary,
    input.trackRecord?.name,
    input.workItem?.title,
    input.workItem?.description,
    input.taskSession?.goal?.summary,
  ]
    .map((value) => String(value || '').trim())
    .filter(Boolean)
    .join(' ');
  if (!topic) return [];

  const tags = new Set<string>([
    input.missionState.tier,
    input.missionState.mission_type || '',
    input.teamRole || '',
    input.projectState?.project_id || '',
    input.trackRecord?.track_type || '',
  ].map((value) => String(value || '').trim().toLowerCase()).filter(Boolean));

  const relevant = await findRelevantDistilledKnowledge({
    topic,
    tags: Array.from(tags),
    limit: 3,
    minScore: 0.08,
  });

  return relevant.map((entry: DistilledKnowledgeEntry) => ({
    path: entry.path,
    title: entry.title,
    excerpt: entry.excerpt,
    tags: entry.tags,
    ...(typeof entry.score === 'number' ? { score: entry.score } : {}),
    ...(entry.category ? { category: entry.category } : {}),
    ...(entry.source_mission ? { source_mission: entry.source_mission } : {}),
    ...(entry.last_updated ? { last_updated: entry.last_updated } : {}),
  }));
}

function loadArtifactHintsIfPossible(input: {
  missionState: MissionStateSummary;
  projectState?: ProjectOperationalState | null;
  trackRecord?: ProjectTrackRecord | null;
  taskSession?: TaskSession | null;
  workItem?: WorkItem | null;
}): MissionContextPackArtifactHint[] {
  const projectId = String(
    input.projectState?.project_id ||
    input.missionState.relationships?.project?.project_id ||
    input.workItem?.project_id ||
    ''
  ).trim();
  if (!projectId) return [];

  const preferredKinds = new Set<string>([
    input.missionState.outcome_contract?.deliverable_kind,
    ...(input.trackRecord?.required_artifacts || []),
    input.taskSession?.artifact?.kind,
  ].map((value) => String(value || '').trim()).filter(Boolean));

  const reuseCandidates = Array.from(preferredKinds)
    .map((kind) => findReusableArtifactOwnershipRecord({ projectId, kind }))
    .filter((record): record is ArtifactOwnershipRecord => Boolean(record));

  const allProjectRecords = listArtifactOwnershipRecordsForProject(projectId, { includeTmp: false });
  const projectRecords = preferredKinds.size
    ? allProjectRecords.filter((record) => preferredKinds.has(record.kind))
    : allProjectRecords;
  const fallbackRecords = projectRecords.length > 0 ? projectRecords : allProjectRecords;

  const candidates = [...reuseCandidates, ...fallbackRecords]
    .filter((record, index, all) => all.findIndex((candidate) => candidate.artifact_id === record.artifact_id) === index)
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, 3);

  return candidates.map((record) => ({
    artifact_id: record.artifact_id,
    kind: record.kind,
    storage_class: record.storage_class,
    ...(record.project_id ? { project_id: record.project_id } : {}),
    ...(record.mission_id ? { mission_id: record.mission_id } : {}),
    ...(record.task_session_id ? { task_session_id: record.task_session_id } : {}),
    ...(record.path ? { path: record.path } : {}),
    ...(record.external_ref ? { external_ref: record.external_ref } : {}),
    ...(record.created_at ? { created_at: record.created_at } : {}),
    ...(record.evidence_refs?.length ? { evidence_refs: [...record.evidence_refs] } : {}),
    reuse_reason: preferredKinds.has(record.kind)
      ? 'Reusable project artifact matching the current deliverable or track requirement.'
      : 'Reusable project artifact candidate for this mission context.',
  }));
}

export function buildMissionContextPack(input: BuildMissionContextPackInput): MissionContextPack {
  const missionStateValidate = ensureMissionStateValidator();
  if (!missionStateValidate(input.missionState)) {
    throw new Error(`Invalid mission state for context pack: ${validationErrors(missionStateValidate).join('; ')}`);
  }

  const missionTier = normalizeTier(input.missionState.tier);
  const missionPath = input.missionPath || findMissionPath(input.missionState.mission_id) || pathResolver.missionDir(input.missionState.mission_id, missionTier);
  const projectId = input.projectState?.project_id
    || input.missionState.relationships?.project?.project_id
    || input.workItem?.project_id;
  const trackId = input.trackRecord?.track_id
    || input.missionState.relationships?.track?.track_id
    || input.projectState?.active_track_ids?.[0];
  const taskSessionId = input.taskSession?.session_id || undefined;
  const workItemId = input.workItem?.item_id || undefined;
  const assignment = input.missionTeamAssignment || null;
  const recipient = input.recipientKind
    ? {
        ...missionAssignmentSummary(assignment),
        kind: input.recipientKind,
      }
    : missionAssignmentSummary(assignment);

  const scope: MissionContextPackScope = {
    tier: missionTier,
    mission_id: input.missionState.mission_id,
    ...(input.missionState.tenant_slug ? { tenant_slug: input.missionState.tenant_slug } : {}),
    ...(projectId ? { project_id: projectId } : {}),
    ...(trackId ? { track_id: trackId } : {}),
    ...(taskSessionId ? { task_session_id: taskSessionId } : {}),
    ...(workItemId ? { work_item_id: workItemId } : {}),
  };

  const mission: MissionContextPackMissionSummary = {
    mission_id: input.missionState.mission_id,
    mission_type: input.missionState.mission_type,
    tier: missionTier,
    status: input.missionState.status,
    assigned_persona: input.missionState.assigned_persona,
    ...(input.missionState.tenant_id ? { tenant_id: input.missionState.tenant_id } : {}),
    ...(input.missionState.tenant_slug ? { tenant_slug: input.missionState.tenant_slug } : {}),
    ...(input.missionState.vision_ref ? { vision_ref: input.missionState.vision_ref } : {}),
    ...(input.missionState.execution_mode ? { execution_mode: input.missionState.execution_mode } : {}),
    ...(typeof input.missionState.priority === 'number' ? { priority: input.missionState.priority } : {}),
    ...(typeof input.missionState.confidence_score === 'number' ? { confidence_score: input.missionState.confidence_score } : {}),
    ...(input.missionState.relationships ? { relationships: input.missionState.relationships } : {}),
    ...(input.missionState.context ? { context: input.missionState.context } : {}),
    ...(input.missionState.outcome_contract ? { outcome_contract: input.missionState.outcome_contract } : {}),
  };

  const project = input.projectState
    ? {
        project_id: input.projectState.project_id,
        name: input.projectState.name,
        summary: input.projectState.summary,
        status: input.projectState.status,
        tier: input.projectState.tier,
        ...(input.projectState.tenant_slug ? { tenant_slug: input.projectState.tenant_slug } : {}),
        ...(input.projectState.project_path ? { project_path: input.projectState.project_path } : {}),
        ...(input.projectState.current_phase ? { current_phase: input.projectState.current_phase } : {}),
        ...(input.projectState.active_track_ids ? { active_track_ids: [...input.projectState.active_track_ids] } : {}),
        ...(input.projectState.active_mission_ids ? { active_mission_ids: [...input.projectState.active_mission_ids] } : {}),
        ...(input.projectState.active_task_session_ids ? { active_task_session_ids: [...input.projectState.active_task_session_ids] } : {}),
        ...(input.projectState.source_refs ? { source_refs: [...input.projectState.source_refs] } : {}),
        ...(input.projectState.distill_targets ? { distill_targets: [...input.projectState.distill_targets] } : {}),
        ...(input.projectState.knowledge_refs ? { knowledge_refs: [...input.projectState.knowledge_refs] } : {}),
        ...(input.projectState.last_distilled_at ? { last_distilled_at: input.projectState.last_distilled_at } : {}),
      }
    : undefined;

  const track = input.trackRecord
    ? {
        track_id: input.trackRecord.track_id,
        project_id: input.trackRecord.project_id,
        name: input.trackRecord.name,
        summary: input.trackRecord.summary,
        status: input.trackRecord.status,
        track_type: input.trackRecord.track_type,
        lifecycle_model: input.trackRecord.lifecycle_model,
        tier: input.trackRecord.tier,
        ...(input.trackRecord.primary_locale ? { primary_locale: input.trackRecord.primary_locale } : {}),
        ...(input.trackRecord.release_id ? { release_id: input.trackRecord.release_id } : {}),
        ...(input.trackRecord.change_scope ? { change_scope: input.trackRecord.change_scope } : {}),
        ...(input.trackRecord.gate_profile_id ? { gate_profile_id: input.trackRecord.gate_profile_id } : {}),
        ...(input.trackRecord.active_missions ? { active_missions: [...input.trackRecord.active_missions] } : {}),
        ...(input.trackRecord.required_artifacts ? { required_artifacts: [...input.trackRecord.required_artifacts] } : {}),
      }
    : undefined;

  const taskSession = input.taskSession
    ? {
        session_id: input.taskSession.session_id,
        surface: input.taskSession.surface,
        task_type: input.taskSession.task_type,
        status: input.taskSession.status,
        mode: input.taskSession.mode,
        goal: {
          summary: input.taskSession.goal.summary,
          success_condition: input.taskSession.goal.success_condition,
        },
        ...(input.taskSession.project_context ? { project_context: input.taskSession.project_context } : {}),
        ...(input.taskSession.requirements ? { requirements: input.taskSession.requirements } : {}),
        ...(input.taskSession.artifact ? { artifact: input.taskSession.artifact } : {}),
        ...(input.taskSession.control ? { control: input.taskSession.control } : {}),
        ...(input.taskSession.outcome_contract ? { outcome_contract: input.taskSession.outcome_contract } : {}),
        updated_at: input.taskSession.updated_at,
      }
    : undefined;

  const workItem = input.workItem
    ? {
        item_id: input.workItem.item_id,
        title: input.workItem.title,
        description: input.workItem.description,
        status: input.workItem.status,
        priority: input.workItem.priority,
        source: input.workItem.source,
        source_ref: input.workItem.source_ref,
        project_id: input.workItem.project_id,
        ...(input.workItem.assignee_peer_id ? { assignee_peer_id: input.workItem.assignee_peer_id } : {}),
        ...(input.workItem.assignee_user_id ? { assignee_user_id: input.workItem.assignee_user_id } : {}),
        labels: [...input.workItem.labels],
        dependencies: [...input.workItem.dependencies],
        ...(input.workItem.metadata ? { metadata: { ...input.workItem.metadata } } : {}),
      }
    : undefined;

  const sources = missionSources({
    missionId: input.missionState.mission_id,
    missionPath,
    missionTier,
    tenantSlug: input.missionState.tenant_slug,
    teamRole: input.teamRole,
    recipientKind: recipient.kind,
    projectId,
    trackId,
    taskSessionId,
    workItemId,
    projectState: input.projectState,
    trackRecord: input.trackRecord,
    taskSession: input.taskSession,
    workItem: input.workItem,
    missionTeamAssignment: assignment,
    knowledgeHints: input.knowledgeHints,
  });
  const artifactHints = loadArtifactHintsIfPossible({
    missionState: input.missionState,
    projectState: input.projectState,
    trackRecord: input.trackRecord,
    taskSession: input.taskSession,
    workItem: input.workItem,
  });

  const summary = missionContextSummary({
    missionId: input.missionState.mission_id,
    teamRole: input.teamRole,
    recipientKind: recipient.kind,
    projectId,
    trackId,
    workItemId,
    taskSessionId,
    tenantSlug: input.missionState.tenant_slug,
  });

  const pack: MissionContextPack = {
    context_pack_id: input.contextPackId || buildContextPackId({
      missionId: input.missionState.mission_id,
      teamRole: input.teamRole,
      recipientKind: recipient.kind,
      workItemId,
    }),
    version: '1',
    generated_at: new Date().toISOString(),
    summary,
    scope,
    recipient,
    mission,
    ...(project ? { project } : {}),
    ...(track ? { track } : {}),
    ...(taskSession ? { task_session: taskSession } : {}),
    ...(workItem ? { work_item: workItem } : {}),
    ...(input.knowledgeHints && input.knowledgeHints.length > 0 ? { knowledge_hints: input.knowledgeHints } : {}),
    ...(artifactHints.length > 0 ? { artifact_hints: artifactHints } : {}),
    sources,
    redactions: defaultRedactions(),
    delivery: {
      mode: 'prompt',
      summary: 'Role-scoped mission context pack. Full Kyberion knowledge and unrelated operational state are intentionally omitted.',
    },
  };

  const validate = ensureMissionContextPackValidator();
  if (!validate(pack)) {
    throw new Error(`Invalid mission context pack: ${validationErrors(validate).join('; ')}`);
  }

  return pack;
}

export async function resolveMissionContextPack(input: ResolveMissionContextPackInput): Promise<MissionContextPack | null> {
  const tier = normalizeTier(input.tier, 'public');
  const missionState = input.missionState || loadMissionState(input.missionId, tier);
  if (!missionState) return null;

  const workItem = input.workItem || (input.workItemId ? getWorkItem(input.workItemId) : null);
  const workItemMetadata = (workItem?.metadata || {}) as Record<string, unknown>;
  const derivedTaskSessionId = typeof workItemMetadata.task_session_id === 'string'
    ? workItemMetadata.task_session_id
    : undefined;
  const taskSession = input.taskSession || loadTaskSessionIfPossible(input.taskSessionId || derivedTaskSessionId);
  const projectState = input.projectState || loadProjectStateIfPossible({
    projectId: input.projectId,
    missionState,
    workItem,
    tier,
    tenantSlug: input.tenantSlug,
  });
  const trackRecord = input.trackRecord || loadTrackStateIfPossible({
    trackId: input.trackId,
    projectState,
    missionState,
  });
  const missionTeamPlan = input.teamRole
    ? (loadMissionTeamPlan(input.missionId) || resolveMissionTeamPlan({
        missionId: input.missionId,
        missionType: missionState.mission_type,
        tier,
        assignedPersona: missionState.assigned_persona,
      }))
    : null;
  const missionTeamAssignment = input.teamRole && missionTeamPlan
    ? missionTeamPlan.assignments.find((entry) => entry.team_role === input.teamRole) || null
    : null;
  const knowledgeHints = input.includeKnowledgeHints === false
    ? []
    : await loadKnowledgeHintsIfPossible({
        missionState,
        projectState,
        trackRecord,
        teamRole: input.teamRole,
        workItem,
        taskSession,
      });

  return buildMissionContextPack({
    missionState,
    missionPath: findMissionPath(input.missionId) || pathResolver.missionDir(input.missionId, tier),
    recipientKind: input.recipientKind || (input.assigneePeerId ? 'agent' : 'subagent'),
    teamRole: input.teamRole,
    assigneePeerId: input.assigneePeerId,
    workItem,
    taskSession,
    projectState,
    trackRecord,
    missionTeamAssignment,
    knowledgeHints,
    ...(input.contextPackId ? { contextPackId: input.contextPackId } : {}),
  });
}

export function saveMissionContextPack(missionPath: string, pack: MissionContextPack): string {
  const missionDir = missionPath && safeExistsSync(missionPath)
    ? missionPath
    : path.isAbsolute(missionPath)
      ? missionPath
      : pathResolver.rootResolve(missionPath);
  const targetDir = path.join(missionDir, 'coordination', 'context-packs');
  if (!safeExistsSync(targetDir)) safeMkdir(targetDir, { recursive: true });
  const filePath = path.join(targetDir, `${pack.context_pack_id}.json`);
  const payload = {
    ...pack,
    context_pack_path: filePath,
  };
  const validate = ensureMissionContextPackValidator();
  if (!validate(payload)) {
    throw new Error(`Invalid mission context pack payload: ${validationErrors(validate).join('; ')}`);
  }
  safeWriteFile(filePath, JSON.stringify(payload, null, 2));
  return filePath;
}

export function renderMissionContextPack(pack: MissionContextPack): string {
  const lines: string[] = [
    'Mission context pack (scoped, minimal, role-specific).',
    `- Pack ID: ${pack.context_pack_id}`,
    `- Scope: mission=${pack.scope.mission_id}; tier=${pack.scope.tier}${pack.scope.tenant_slug ? `; tenant=${pack.scope.tenant_slug}` : ''}${pack.scope.project_id ? `; project=${pack.scope.project_id}` : ''}${pack.scope.track_id ? `; track=${pack.scope.track_id}` : ''}${pack.scope.task_session_id ? `; task_session=${pack.scope.task_session_id}` : ''}${pack.scope.work_item_id ? `; work_item=${pack.scope.work_item_id}` : ''}`,
    `- Recipient: ${pack.recipient.kind}${pack.recipient.team_role ? ` / role=${pack.recipient.team_role}` : ''}${pack.recipient.agent_id ? ` / agent=${pack.recipient.agent_id}` : ''}${pack.recipient.authority_role ? ` / authority=${pack.recipient.authority_role}` : ''}`,
    `- Mission: ${pack.mission.mission_id} | ${pack.mission.status}${pack.mission.mission_type ? ` | type=${pack.mission.mission_type}` : ''}${pack.mission.assigned_persona ? ` | persona=${pack.mission.assigned_persona}` : ''}`,
  ];

  if (pack.project) {
    lines.push(
      `- Project: ${pack.project.project_id} | ${pack.project.name} | ${pack.project.status}${pack.project.current_phase ? ` | phase=${pack.project.current_phase}` : ''}`,
      `  - Summary: ${summarizeText(pack.project.summary, 320) || pack.project.summary}`,
    );
  }

  if (pack.track) {
    lines.push(
      `- Track: ${pack.track.track_id} | ${pack.track.name} | ${pack.track.status} | ${pack.track.track_type}/${pack.track.lifecycle_model}`,
      `  - Summary: ${summarizeText(pack.track.summary, 280) || pack.track.summary}`,
    );
  }

  if (pack.task_session) {
    lines.push(
      `- Task session: ${pack.task_session.session_id} | ${pack.task_session.task_type} | ${pack.task_session.status} | ${pack.task_session.mode}`,
      `  - Goal: ${summarizeText(pack.task_session.goal.summary, 240) || pack.task_session.goal.summary}`,
    );
  }

  if (pack.work_item) {
    lines.push(
      `- Work item: ${pack.work_item.item_id} | ${pack.work_item.status} | ${pack.work_item.title}`,
      `  - Description: ${summarizeText(pack.work_item.description, 280) || pack.work_item.description}`,
    );
  }

  if (pack.knowledge_hints && pack.knowledge_hints.length > 0) {
    lines.push('- Knowledge hints:');
    for (const hint of pack.knowledge_hints) {
      lines.push(`  - ${hint.title} (${hint.path})`);
      lines.push(`    ${summarizeText(hint.excerpt, 220) || hint.excerpt}`);
    }
  }

  if (pack.artifact_hints && pack.artifact_hints.length > 0) {
    lines.push('- Reusable artifact hints:');
    for (const hint of pack.artifact_hints) {
      lines.push(`  - ${hint.artifact_id} | ${hint.kind} | ${hint.storage_class}`);
      lines.push(`    ${hint.reuse_reason}`);
      if (hint.path) lines.push(`    path: ${hint.path}`);
      if (hint.project_id || hint.mission_id || hint.task_session_id) {
        lines.push(`    lineage: ${[hint.project_id ? `project=${hint.project_id}` : '', hint.mission_id ? `mission=${hint.mission_id}` : '', hint.task_session_id ? `task_session=${hint.task_session_id}` : ''].filter(Boolean).join(', ')}`);
      }
    }
  }

  lines.push('- Sources:');
  for (const source of pack.sources) {
    const descriptor = [
      `[${source.kind}] ${source.ref}`,
      source.path ? `(${source.path})` : '',
      source.summary ? `- ${summarizeText(source.summary, 200) || source.summary}` : '',
    ].filter(Boolean).join(' ');
    lines.push(`  - ${descriptor}`);
  }

  lines.push(`- Redactions: ${pack.redactions.length > 0 ? pack.redactions.join('; ') : 'none'}`);
  lines.push('', 'Use only the facts in this pack and the task instructions that follow. If a necessary fact is missing, report the gap instead of assuming the full knowledge base.');
  return lines.join('\n');
}
