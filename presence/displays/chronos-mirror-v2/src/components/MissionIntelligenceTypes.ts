import type { OrganizationWorkLoopSummary } from '@agent/core';
import type { RuntimeTopologySnapshot } from '../lib/runtime-topology';

export interface MissionSummary {
  missionId: string;
  status: string;
  tier: string;
  missionType?: string;
  projectId?: string;
  projectPath?: string;
  trackId?: string;
  trackName?: string;
  planReady: boolean;
  nextTaskCount: number;
  controlSummary: string;
  controlTone: 'planning' | 'ready' | 'attention' | 'pending';
  controlRequestedBy?: string;
}

export interface CompanySnapshot {
  companyId: string;
  tenantSlug: string;
  name: string;
  sovereign: string | null;
  visionRef: string;
  vision: {
    sourceKind: 'customer' | 'tenant' | 'global';
    sourcePath: string;
    title: string | null;
    soul: string[];
    steering: string[];
    destination: string[];
  };
  organizationProfile: {
    exists: boolean;
    path: string;
    name: string | null;
  };
  orgChart: {
    exists: boolean;
    path: string;
    domainCount: number;
    positionCount: number;
    topLevelRoles: string[];
  };
  financial: {
    exists: boolean;
    path: string;
    sourceKind: string | null;
    periodCount: number;
    latestPeriodId: string | null;
    latestRevenueJpy: number | null;
    latestOperatingCostJpy: number | null;
    latestGrossProfitJpy: number | null;
  };
  financeController: {
    mode: 'growth' | 'monitor' | 'cost_cutting';
    shouldCutCosts: boolean;
    reasons: string[];
    signals: {
      revenueJpy: number | null;
      operatingCostJpy: number | null;
      grossProfitJpy: number | null;
      budgetJpy: number | null;
      budgetUtilization: number | null;
      okrProgressPercent: number | null;
      costReportTotalUsd: number | null;
      costReportTotalTokens: number | null;
    };
    thresholds: {
      budgetUtilizationWarning: number;
      budgetUtilizationCritical: number;
      negativeGrossProfitBudgetMode: boolean;
      lowOkrProgressWarning: number;
      lowOkrProgressCritical: number;
      highTokenUsageWarning: number;
      highTokenUsageCritical: number;
    };
    sources: {
      financialPath: string;
      okrPath: string;
      costReportPath: string | null;
    };
  };
  okr: {
    exists: boolean;
    path: string;
    sourceKind: string | null;
    objectiveCount: number;
    keyResultCount: number;
    progressPercent: number;
    latestObjective: string | null;
  };
  approvalAudit: {
    total: number;
    allowed: number;
    denied: number;
    pending: number;
    recentCount: number;
    latestCorrelationId: string | null;
  };
  approvalAuditDrilldown: {
    total: number;
    allowed: number;
    denied: number;
    pending: number;
    recent: Array<{
      id: string;
      timestamp: string;
      agentId: string;
      operation: string;
      result: string;
      reason: string | null;
      correlationId: string | null;
      intentId: string | null;
      decisionType: string | null;
      decisionRightsSource: string | null;
    }>;
    byDecisionType: Array<{
      decisionType: string;
      total: number;
      allowed: number;
      denied: number;
      pending: number;
      latestCorrelationId: string | null;
      latestTimestamp: string | null;
    }>;
    byCorrelationId: Array<{
      correlationId: string;
      total: number;
      allowed: number;
      denied: number;
      pending: number;
      decisionTypes: string[];
      latestDecisionType: string | null;
      latestOperation: string | null;
      latestTimestamp: string | null;
      recent: Array<{
        id: string;
        timestamp: string;
        agentId: string;
        operation: string;
        result: string;
        reason: string | null;
        correlationId: string | null;
        intentId: string | null;
        decisionType: string | null;
        decisionRightsSource: string | null;
      }>;
    }>;
  };
  decisionRights: {
    exists: boolean;
    path: string;
    sourceKind: string | null;
    ruleCount: number;
    decisionTypes: string[];
  };
}

const MISSION_INTELLIGENCE_PREFS_KEY = 'chronos.mission-intelligence.prefs';

function loadMissionIntelligenceSelectedMissionId(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const raw = window.localStorage.getItem(MISSION_INTELLIGENCE_PREFS_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<{ selectedMissionId: string | null }>;
    return typeof parsed.selectedMissionId === 'string' ? parsed.selectedMissionId : null;
  } catch {
    return null;
  }
}

function saveMissionIntelligenceSelectedMissionId(selectedMissionId: string | null): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(
      MISSION_INTELLIGENCE_PREFS_KEY,
      JSON.stringify({ selectedMissionId })
    );
  } catch {
    // localStorage may be denied; ignore.
  }
}

export function resolveMissionThreadHotkeyAction(key: string): 'thread' | 'card' | null {
  const normalized = key.toLowerCase();
  if (normalized === 't') return 'thread';
  if (normalized === 'c') return 'card';
  return null;
}

export function resolveMissionControlFocusId(
  missions: Array<Pick<MissionSummary, 'missionId' | 'controlTone' | 'nextTaskCount'>>,
  selectedMissionId: string | null,
  focusedMissionId: string | null
): string | null {
  return pickDefaultMissionId(missions, focusedMissionId || selectedMissionId);
}

export function pickDefaultMissionId(
  missions: Array<Pick<MissionSummary, 'missionId' | 'controlTone' | 'nextTaskCount'>>,
  selectedMissionId: string | null
): string | null {
  if (selectedMissionId && missions.some((mission) => mission.missionId === selectedMissionId)) {
    return selectedMissionId;
  }

  const tonePriority = (tone: MissionSummary['controlTone']): number => {
    if (tone === 'attention') return 3;
    if (tone === 'pending') return 2;
    if (tone === 'ready') return 1;
    return 0;
  };

  const prioritized = missions.reduce<{ missionId: string; score: number } | null>(
    (best, mission) => {
      const score = tonePriority(mission.controlTone) * 1000 + (mission.nextTaskCount || 0);
      if (!best || score > best.score) {
        return { missionId: mission.missionId, score };
      }
      return best;
    },
    null
  );

  return prioritized?.missionId || missions[0]?.missionId || null;
}

function isEditableHotkeyTarget(target: EventTarget | null): boolean {
  const element = target as HTMLElement | null;
  return Boolean(
    element &&
    (element.tagName === 'INPUT' ||
      element.tagName === 'TEXTAREA' ||
      element.tagName === 'SELECT' ||
      element.isContentEditable)
  );
}

interface OrchestrationEvent {
  ts: string;
  decision: string;
  mission_id?: string;
  why?: string;
}

interface RuntimeSummary {
  total: number;
  ready: number;
  busy: number;
  error: number;
}

interface RuntimeLease {
  agent_id: string;
  owner_id: string;
  owner_type: string;
  metadata?: Record<string, unknown>;
}

interface RuntimeDoctorFinding {
  severity: 'warning' | 'critical';
  agentId: string;
  ownerId: string;
  reason: string;
  recommendedAction: 'stop_runtime' | 'restart_runtime';
}

interface MissionProgressSummary {
  missionId: string;
  generatedAssets: Array<{
    path: string;
    category: 'deliverables' | 'artifacts' | 'outputs' | 'evidence';
    sizeBytes: number;
    updatedAt: string;
  }>;
}

interface OwnerSummary {
  ts: string;
  mission_id: string;
  accepted_count: number;
  reviewed_count: number;
  completed_count: number;
  requested_count: number;
}

interface SurfaceOutboxMessage {
  message_id: string;
  surface: 'slack' | 'chronos';
  correlation_id: string;
  channel: string;
  thread_ts: string;
  text: string;
  source: 'surface' | 'nerve' | 'system';
  created_at: string;
}

interface BrowserSessionSummary {
  session_id: string;
  active_tab_id: string;
  tab_count: number;
  updated_at: string;
  last_trace_path?: string;
  lease_expires_at?: string;
  lease_status: 'active' | 'released' | 'expired';
  retained: boolean;
  action_trail_count: number;
  recent_actions: Array<{
    op: string;
    kind: 'control' | 'capture' | 'apply';
    tab_id?: string;
    ref?: string;
    selector?: string;
    ts: string;
  }>;
}

interface ProjectRecordSummary {
  project_id: string;
  name: string;
  summary: string;
  status: 'draft' | 'active' | 'paused' | 'archived';
  tier: 'personal' | 'confidential' | 'public';
  primary_locale?: string;
  service_bindings?: string[];
  active_missions?: string[];
  bootstrap_work_items?: Array<{
    work_id: string;
    kind: 'mission_seed' | 'task_session';
    title: string;
    summary: string;
    status: 'planned' | 'active' | 'completed';
    specialist_id: string;
    outcome_id?: string;
  }>;
  kickoff_task_session_id?: string;
}

interface ProjectTrackRecordSummary {
  track_id: string;
  project_id: string;
  name: string;
  summary: string;
  status: 'planned' | 'active' | 'paused' | 'completed' | 'archived';
  track_type:
    'delivery' | 'change' | 'release' | 'incident' | 'compliance' | 'operations' | 'research';
  lifecycle_model:
    | 'sdlc'
    | 'continuous_delivery'
    | 'incident_response'
    | 'continuous_operations'
    | 'research_cycle';
  tier: 'personal' | 'confidential' | 'public';
  primary_locale?: string;
  release_id?: string;
  change_scope?: string;
  gate_profile_id?: string;
  active_missions?: string[];
  required_artifacts?: string[];
  gate_readiness?: {
    ready_gate_count: number;
    total_gate_count: number;
    current_gate_id?: string;
    current_phase?: string;
    ready: boolean;
    next_required_artifacts?: Array<{
      artifact_id: string;
      template_ref?: string;
    }>;
  };
}

interface ProjectManagementSummary {
  project: { project_id: string; name: string };
  lineage: {
    tracks: Array<{ track_id: string; name: string; status: string }>;
    tasks: Array<{ work_id: string; title: string; status: string }>;
    missions: Array<{ mission_id: string; status: string; track_id?: string }>;
    task_sessions: Array<{ session_id: string; status: string }>;
    pipelines: Array<{ pipeline_id: string }>;
    role_explanations: {
      project: string;
      track: string;
      mission: string;
      task: string;
      task_session: string;
      pipeline: string;
    };
  };
}

interface ServiceBindingRecordSummary {
  binding_id: string;
  service_type: string;
  scope: string;
  target: string;
  allowed_actions: string[];
  auth_mode?: 'none' | 'secret-guard' | 'session';
  metadata?: Record<string, unknown>;
}

interface MissionSeedRecordSummary {
  seed_id: string;
  project_id: string;
  track_id?: string;
  track_name?: string;
  source_task_session_id?: string;
  source_work_id?: string;
  title: string;
  summary: string;
  status: 'proposed' | 'ready' | 'promoted' | 'archived';
  specialist_id: string;
  outcome_id?: string;
  mission_type_hint?: string;
  locale?: string;
  work_loop?: OrganizationWorkLoopSummary;
  metadata?: Record<string, unknown>;
  promoted_mission_id?: string;
}

interface ArtifactRecordSummary {
  artifact_id: string;
  project_id?: string;
  track_id?: string;
  track_name?: string;
  mission_id?: string;
  task_session_id?: string;
  kind: string;
  storage_class: 'repo' | 'artifact_store' | 'vault' | 'tmp' | 'external_ref';
  path?: string;
  external_ref?: string;
  preview_text?: string;
  work_loop?: {
    intent?: { label?: string };
    context?: {
      project_id?: string;
      project_name?: string;
      track_id?: string;
      track_name?: string;
      tier?: string;
      locale?: string;
      service_bindings?: string[];
    };
    resolution?: { execution_shape?: string; task_type?: string };
    outcome_design?: { outcome_ids?: string[]; labels?: string[] };
    teaming?: {
      specialist_id?: string;
      specialist_label?: string;
      conversation_agent?: string;
      team_roles?: string[];
    };
    authority?: { requires_approval?: boolean };
    learning?: { reusable_refs?: string[] };
  };
}

interface PendingApprovalSummary {
  id: string;
  kind: 'channel-approval' | 'secret_mutation' | 'mission_gate';
  channel: string;
  storageChannel: string;
  requestedAt: string;
  requestedBy: string;
  title: string;
  summary: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
  pendingRoles: string[];
  missionId?: string;
  trackId?: string;
  serviceId?: string;
  work_loop?: OrganizationWorkLoopSummary;
}

interface DistillCandidateSummary {
  candidate_id: string;
  source_type: 'task_session' | 'mission' | 'artifact';
  tier?: 'personal' | 'confidential' | 'public';
  project_id?: string;
  track_id?: string;
  track_name?: string;
  mission_id?: string;
  task_session_id?: string;
  artifact_ids?: string[];
  title: string;
  summary: string;
  status: 'proposed' | 'promoted' | 'archived';
  target_kind: 'pattern' | 'sop_candidate' | 'knowledge_hint' | 'report_template';
  specialist_id?: string;
  locale?: string;
  work_loop?: OrganizationWorkLoopSummary;
  promoted_ref?: string;
  evidence_refs?: string[];
}

interface AgentMessageSummary {
  ts: string;
  missionId?: string;
  agentId: string;
  teamRole?: string;
  ownerId: string;
  ownerType: string;
  channel?: string;
  thread?: string;
  type: 'handoff' | 'prompt' | 'agent' | 'stderr';
  tone: 'request' | 'response' | 'runtime';
  content: string;
}

interface A2AHandoffSummary {
  ts: string;
  missionId: string;
  sender: string;
  receiver: string;
  teamRole?: string;
  channel?: string;
  thread?: string;
  performative?: string;
  intent?: string;
  promptExcerpt?: string;
}

interface MissionThreadEntry {
  ts: string;
  missionId: string;
  type: 'handoff' | 'prompt' | 'agent' | 'stderr';
  tone: 'request' | 'response' | 'runtime';
  agentId: string;
  teamRole?: string;
  label: string;
  content: string;
  channel?: string;
  thread?: string;
}

interface ControlActionSummary {
  event_id?: string;
  ts: string;
  kind: 'mission' | 'surface';
  target: string;
  operation: string;
  status: 'queued' | 'completed' | 'failed';
  requested_by: string;
  error?: string;
}

interface ControlActionDetail {
  ts: string;
  decision: string;
  event_type?: string;
  mission_id?: string;
  resource_id?: string;
  operation?: string;
  action_id?: string;
  outcome?: string;
  why?: string;
  error?: string;
}

interface ControlActionDefinition {
  operation: string;
  label: string;
  risk: 'safe' | 'risky';
  approvalRequired: boolean;
  enabled: boolean;
  disabledReason?: string;
}

interface ControlActionCatalog {
  mission: ControlActionDefinition[];
  surface: ControlActionDefinition[];
  globalSurface: ControlActionDefinition[];
}

interface ControlActionAvailability {
  mission: Record<string, ControlActionDefinition[]>;
  surface: Record<string, ControlActionDefinition[]>;
  globalSurface: ControlActionDefinition[];
}

interface WorkLoopPreview {
  intent: string;
  context: string;
  resolution: string;
  outcome: string;
  team: string;
  authority: string;
}
export type {
  MissionSummary,
  CompanySnapshot,
  OrchestrationEvent,
  RuntimeSummary,
  RuntimeLease,
  RuntimeDoctorFinding,
  MissionProgressSummary,
  OwnerSummary,
  SurfaceOutboxMessage,
  BrowserSessionSummary,
  ProjectRecordSummary,
  ProjectTrackRecordSummary,
  ProjectManagementSummary,
  ServiceBindingRecordSummary,
  MissionSeedRecordSummary,
  ArtifactRecordSummary,
  PendingApprovalSummary,
  DistillCandidateSummary,
  AgentMessageSummary,
  A2AHandoffSummary,
  MissionThreadEntry,
  ControlActionSummary,
  ControlActionDetail,
  ControlActionDefinition,
  ControlActionCatalog,
  ControlActionAvailability,
  WorkLoopPreview,
};
interface IntelligencePayload {
  accessRole: 'readonly' | 'localadmin';
  company?: CompanySnapshot;
  activeMissions: MissionSummary[];
  projects: ProjectRecordSummary[];
  projectManagement?: ProjectManagementSummary[];
  projectTracks: ProjectTrackRecordSummary[];
  gateReadiness?: Array<{
    track_id: string;
    ready_gate_count: number;
    total_gate_count: number;
    current_gate_id?: string;
    current_phase?: string;
    ready: boolean;
    next_required_artifacts?: Array<{
      artifact_id: string;
      template_ref?: string;
    }>;
  }>;
  missionSeeds: MissionSeedRecordSummary[];
  missionSeedAssessment?: {
    total: number;
    eligible: number;
    flagged: number;
    unassessed: number;
    promotable: number;
    flagged_seed_ids: string[];
    eligible_seed_ids: string[];
    promoted_seed_ids: string[];
  };
  distillCandidates: DistillCandidateSummary[];
  memoryCandidates?: Array<{
    candidate_id: string;
    status: 'queued' | 'approved' | 'rejected' | 'promoted';
    proposed_memory_kind: string;
    sensitivity_tier: 'public' | 'confidential' | 'personal';
    source_ref: string;
    evidence_refs: string[];
    promoted_ref?: string;
  }>;
  nextActions?: Array<{
    action_id: string;
    next_action_type:
      | 'request_clarification'
      | 'approve'
      | 'inspect_evidence'
      | 'retry_delivery'
      | 'promote_mission_seed'
      | 'resume_mission';
    reason: string;
    risk: 'low' | 'medium' | 'high';
    suggested_command?: string;
    suggested_surface_action?:
      'approvals' | 'mission-seeds' | 'memory-promotion-queue' | 'next-actions';
    approval_required: boolean;
  }>;
  serviceBindings: ServiceBindingRecordSummary[];
  recentArtifacts: ArtifactRecordSummary[];
  pendingApprovals: PendingApprovalSummary[];
  surfaces: SurfaceSummary[];
  recentEvents: OrchestrationEvent[];
  agentMessages: AgentMessageSummary[];
  a2aHandoffs: A2AHandoffSummary[];
  controlActionCatalog: ControlActionCatalog;
  controlActionAvailability: ControlActionAvailability;
  controlActions: ControlActionSummary[];
  controlActionDetails: Record<string, ControlActionDetail[]>;
  ownerSummaries: OwnerSummary[];
  missionProgress: MissionProgressSummary[];
  browserSessions: BrowserSessionSummary[];
  browserConversationSessions: Array<{
    session_id: string;
    surface: string;
    status: string;
    mode: string;
    updated_at: string;
    goal_summary: string;
    active_step?: string;
    pending_confirmation: boolean;
    candidate_target_count: number;
  }>;
  surfaceOutbox: {
    slack: number;
    chronos: number;
  };
  recentSurfaceOutbox: SurfaceOutboxMessage[];
  runtime: RuntimeSummary;
  runtimeLeases: RuntimeLease[];
  runtimeDoctor: RuntimeDoctorFinding[];
  runtimeTopology: RuntimeTopologySnapshot;
}

interface SurfaceSummary {
  id: string;
  kind: string;
  startupMode?: string;
  enabled: boolean;
  running: boolean;
  pid?: number;
  health: string;
  detail?: string;
  controlSummary: string;
  controlTone: 'stable' | 'attention' | 'offline' | 'pending';
  controlRequestedBy?: string;
}

interface ReferenceDetail {
  path: string;
  title: string;
  summary: string;
  metadata: Record<string, string>;
  sections: Array<{ title: string; lines: string[] }>;
  body: string;
  endpoint: string;
  openLabel: string;
}

export type MissionIntelligenceWorkspace =
  | 'surface'
  | 'missions'
  | 'deliverables'
  | 'operations'
  | 'governance'
  | 'diagnostics'
  | 'surface-control';

export type { IntelligencePayload, SurfaceSummary, ReferenceDetail, MissionIntelligenceWorkspace };
