import type { ArtifactOwnershipRecord } from './artifact-registry.js';
import type { ContextFragmentRejection, ContextSecurityScope } from './context-security-scope.js';
import type { FacetRequest } from './facet-registry.js';
import type { MissionTeamAssignment } from './mission-team-plan-composer.js';
import type { ProjectOperationalState } from './project-operational-state-registry.js';
import type { ProjectTrackRecord } from './project-track-registry.js';
import type { SkillResourceDescriptor } from './skill-resource-loader.js';
import type { TaskSession } from './task-session.js';
import type { WorkItem } from './work-coordination.js';

export type MissionTier = 'personal' | 'confidential' | 'public';
export type MissionStatus =
  | 'planned'
  | 'active'
  | 'validating'
  | 'distilling'
  | 'completed'
  | 'paused'
  | 'failed'
  | 'archived';
export type MissionContextRecipientKind =
  'agent' | 'subagent' | 'reviewer' | 'operator' | 'planner' | 'tester';
export type MissionContextDeliveryMode = 'prompt' | 'artifact';

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
      organization_id?: string;
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
    vision_ref?: {
      raw: string;
      kind: 'company' | 'vision' | 'legacy';
      tenant_slug: string | null;
      path: string | null;
      query: string | null;
    } | null;
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
    | 'skill_resource'
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
  organization_id?: string;
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

export interface MissionContextPackTaskGuidance {
  model_tier: 'fast' | 'standard' | 'deep';
  acceptance_criteria: string[];
  output_contract: string;
  verification: string[];
  seed?: string[];
}

export interface MissionContextPackFacets {
  persona?: { name: string; source: string; content: string };
  policies: Array<{ name: string; source: string; content: string }>;
  instructions: Array<{ name: string; source: string; content: string }>;
  output_contract?: { name: string; source: string; content: string };
}

export interface MissionContextPackPruningSummary {
  budget_chars: number;
  estimated_chars: number;
  kept_sections: string[];
  pruned_sections: string[];
  rollup_path?: string;
  rollup_summary: string;
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
  security_scope: ContextSecurityScope;
  /** Present only when candidate fragments were rejected by the scope gate. */
  scope_audit?: {
    effective_scope: ContextSecurityScope;
    rejected: ContextFragmentRejection[];
  };
  recipient: MissionContextPackRecipient;
  mission: MissionContextPackMissionSummary;
  project?: MissionContextPackProjectSummary;
  track?: MissionContextPackTrackSummary;
  task_session?: MissionContextPackTaskSessionSummary;
  work_item?: MissionContextPackWorkItemSummary;
  knowledge_hints?: MissionContextPackKnowledgeHint[];
  /** PI-09: metadata-only skill descriptors; bodies are never part of a pack. */
  skill_resources?: SkillResourceDescriptor[];
  artifact_hints?: MissionContextPackArtifactHint[];
  task_guidance?: MissionContextPackTaskGuidance;
  facets?: MissionContextPackFacets;
  sources: MissionContextPackSource[];
  redactions: string[];
  pruning?: MissionContextPackPruningSummary;
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
  /** Preloaded descriptors for a governed caller; bodies are not accepted. */
  skillResources?: SkillResourceDescriptor[];
  /** Explicit skill resources to expose as a metadata-only progressive index. */
  skillPaths?: string[];
  /** Set false for pre-trust callers; project-local skills are not inspected. */
  trustResolved?: boolean;
  contextPackId?: string;
  contextBudgetChars?: number;
  /**
   * KP-04: when `contextBudgetChars` is not explicitly supplied, the prune
   * budget is derived from `SCOPE_KNOWLEDGE_BUDGETS[estimatedScope]`. Omitted
   * = `M` (pre-KP-04 default of 6000), so existing callers are unaffected.
   */
  estimatedScope?: 'S' | 'M' | 'L';
  facets?: FacetRequest;
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
  /** Explicit skill resources to expose as a metadata-only progressive index. */
  skillPaths?: string[];
  /** Set false for pre-trust callers; project-local skills are not inspected. */
  trustResolved?: boolean;
  missionState?: MissionStateSummary | null;
  workItem?: WorkItem | null;
  taskSession?: TaskSession | null;
  projectState?: ProjectOperationalState | null;
  trackRecord?: ProjectTrackRecord | null;
  contextPackId?: string;
  contextBudgetChars?: number;
  /**
   * KP-04: scales both the knowledge hint count and (absent an explicit
   * `contextBudgetChars`) the prune budget via `SCOPE_KNOWLEDGE_BUDGETS`.
   * Omitted = `M`, matching pre-KP-04 behavior byte-for-byte.
   */
  estimatedScope?: 'S' | 'M' | 'L';
  facets?: FacetRequest;
  /**
   * DA-07 test seam, forwarded to `loadKnowledgeHintsIfPossible`: repo root
   * containing fixture `knowledge/`, `customer/`, and tenant profile
   * directories for tenant-scoped retrieval. Defaults to the real repo root.
   */
  tenantKnowledgeRootDir?: string;
}

export interface LoadKnowledgeHintsInput {
  missionState: MissionStateSummary;
  projectState?: ProjectOperationalState | null;
  trackRecord?: ProjectTrackRecord | null;
  teamRole?: string;
  /** Explicit governance phase; omitted values are derived from mission state. */
  phase?: string;
  workItem?: WorkItem | null;
  taskSession?: TaskSession | null;
  /** Test-only override for the knowledge slices manifest path. */
  knowledgeSlicesPath?: string;
  /** KP-04: scales the hint budget. Omitted = `M` (pre-KP-04 default). */
  estimatedScope?: 'S' | 'M' | 'L';
  /** DA-07 test seam for tenant-scoped retrieval fixtures. */
  tenantKnowledgeRootDir?: string;
}
