'use client';

import { useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import {
  Activity,
  AlertTriangle,
  Bot,
  Brain,
  GitBranch,
  Radar,
  Send,
  ShieldAlert,
} from 'lucide-react';
import { buildAttentionItems, type AttentionItem } from '../lib/operator-console';
import type { RuntimeTopologySnapshot } from '../lib/runtime-topology';
import { buildUserFacingError } from '../lib/user-facing-error';
import { chronosSpeechLocale, resolveChronosLocale, uxText, uxTextOr } from '../lib/ux-vocabulary';
import { SurfaceStatusPanel } from './SurfaceStatusPanel';
import type { OrganizationWorkLoopSummary } from '@agent/core';

interface MissionSummary {
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

interface CompanySnapshot {
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
  kind: 'channel-approval' | 'secret_mutation';
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

function buildProjectWorkLoopPreview(project: ProjectRecordSummary): WorkLoopPreview {
  const nextWork = project.bootstrap_work_items?.[0];
  return {
    intent: project.name || 'project_bootstrap',
    context: `${project.project_id} · ${project.tier}`,
    resolution: project.active_missions?.length ? 'project -> missions' : 'project_bootstrap',
    outcome: nextWork?.outcome_id || 'project_created',
    team: nextWork?.specialist_id || 'project-lead',
    authority: 'governed progression',
  };
}

function buildMissionSeedWorkLoopPreview(seed: MissionSeedRecordSummary): WorkLoopPreview {
  if (seed.work_loop) {
    return {
      intent: seed.work_loop.intent?.label || seed.title || 'mission_seed',
      context:
        seed.work_loop.context?.project_name ||
        seed.work_loop.context?.project_id ||
        `${seed.project_id} · ${seed.locale || 'default locale'}`,
      resolution:
        seed.work_loop.resolution?.execution_shape ||
        (seed.promoted_mission_id ? 'mission' : 'mission_seed'),
      outcome:
        seed.work_loop.outcome_design?.labels?.join(' / ') ||
        seed.outcome_id ||
        seed.mission_type_hint ||
        'durable_work',
      team:
        seed.work_loop.teaming?.team_roles?.join(' -> ') || seed.specialist_id || 'mission-lead',
      authority: seed.work_loop.authority?.requires_approval
        ? 'approval required'
        : seed.promoted_mission_id
          ? 'already promoted'
          : 'promotion required',
    };
  }
  return {
    intent: seed.title || 'mission_seed',
    context: `${seed.project_id} · ${seed.locale || 'default locale'}`,
    resolution: seed.promoted_mission_id ? 'mission' : 'mission_seed',
    outcome: seed.outcome_id || seed.mission_type_hint || 'durable_work',
    team: seed.specialist_id || 'mission-lead',
    authority: seed.promoted_mission_id ? 'already promoted' : 'promotion required',
  };
}

function buildDistillCandidateWorkLoopPreview(candidate: DistillCandidateSummary): WorkLoopPreview {
  if (candidate.work_loop) {
    return {
      intent: candidate.work_loop.intent?.label || candidate.title,
      context:
        candidate.work_loop.context?.project_name ||
        candidate.work_loop.context?.project_id ||
        candidate.project_id ||
        'standalone',
      resolution: candidate.work_loop.resolution?.execution_shape || candidate.source_type,
      outcome: candidate.work_loop.outcome_design?.labels?.join(' / ') || candidate.target_kind,
      team:
        candidate.work_loop.teaming?.team_roles?.join(' -> ') ||
        candidate.specialist_id ||
        'memory loop',
      authority: candidate.work_loop.authority?.requires_approval
        ? 'approval required'
        : candidate.status,
    };
  }
  return {
    intent: candidate.title,
    context: candidate.project_id || 'standalone',
    resolution: candidate.source_type,
    outcome: candidate.target_kind,
    team: candidate.specialist_id || 'memory loop',
    authority: candidate.status,
  };
}

function buildApprovalWorkLoopPreview(approval: PendingApprovalSummary): WorkLoopPreview {
  if (approval.work_loop) {
    return {
      intent: approval.work_loop.intent?.label || approval.title || approval.kind,
      context:
        approval.work_loop.context?.project_name ||
        approval.work_loop.context?.project_id ||
        `${approval.channel} · ${approval.storageChannel}`,
      resolution: approval.work_loop.resolution?.execution_shape || 'authority_gate',
      outcome:
        approval.work_loop.outcome_design?.labels?.join(' / ') ||
        approval.summary ||
        'approved action can proceed',
      team:
        approval.work_loop.teaming?.team_roles?.join(' -> ') ||
        approval.pendingRoles.join(' -> ') ||
        'approver',
      authority: approval.work_loop.authority?.requires_approval
        ? 'approval required'
        : approval.riskLevel,
    };
  }
  return {
    intent: approval.title || approval.kind,
    context: `${approval.channel} · ${approval.storageChannel}`,
    resolution: 'authority_gate',
    outcome: approval.summary || 'approved action can proceed',
    team: approval.pendingRoles.length ? approval.pendingRoles.join(' -> ') : 'approver',
    authority: approval.riskLevel,
  };
}

function buildArtifactWorkLoopPreview(artifact: ArtifactRecordSummary): WorkLoopPreview {
  if (artifact.work_loop) {
    return {
      intent:
        artifact.work_loop.intent?.label || artifact.preview_text || artifact.kind || 'artifact',
      context:
        artifact.work_loop.context?.project_name ||
        artifact.work_loop.context?.project_id ||
        `${artifact.project_id || 'standalone'} · ${artifact.storage_class}`,
      resolution:
        artifact.work_loop.resolution?.execution_shape ||
        (artifact.mission_id
          ? 'mission_outcome'
          : artifact.task_session_id
            ? 'task_session_outcome'
            : 'recorded_outcome'),
      outcome: artifact.work_loop.outcome_design?.labels?.join(' / ') || artifact.kind,
      team:
        artifact.work_loop.teaming?.team_roles?.join(' -> ') ||
        (artifact.mission_id
          ? 'mission team'
          : artifact.task_session_id
            ? 'task session team'
            : 'system'),
      authority: artifact.work_loop.authority?.requires_approval
        ? 'approval required'
        : 'recorded evidence',
    };
  }
  return {
    intent: artifact.preview_text || artifact.kind || 'artifact',
    context: `${artifact.project_id || 'standalone'} · ${artifact.storage_class}`,
    resolution: artifact.mission_id
      ? 'mission_outcome'
      : artifact.task_session_id
        ? 'task_session_outcome'
        : 'recorded_outcome',
    outcome: artifact.kind,
    team: artifact.mission_id
      ? 'mission team'
      : artifact.task_session_id
        ? 'task session team'
        : 'system',
    authority: 'recorded evidence',
  };
}

function getLatestMissionControlAction(
  actions: ControlActionSummary[],
  missionId: string
): ControlActionSummary | null {
  return actions.find((action) => action.kind === 'mission' && action.target === missionId) || null;
}

function getLatestSurfaceControlAction(
  actions: ControlActionSummary[],
  surfaceId: string
): ControlActionSummary | null {
  return actions.find((action) => action.kind === 'surface' && action.target === surfaceId) || null;
}

function getGlobalSurfaceControlAction(
  actions: ControlActionSummary[]
): ControlActionSummary | null {
  return (
    actions.find((action) => action.kind === 'surface' && action.target === 'surface-runtime') ||
    null
  );
}

function toDomId(prefix: 'mission' | 'surface', value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

function ActionStatusBadge({ action }: { action: ControlActionSummary }) {
  return (
    <div
      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.22em] ${
        action.status === 'completed'
          ? 'kb-status-positive-surface kb-status-positive'
          : action.status === 'failed'
            ? 'kb-status-negative-surface kb-status-negative'
            : 'kb-status-warning-surface kb-status-warning'
      }`}
    >
      {action.operation} · {action.status}
    </div>
  );
}

function messageToneClass(tone: AgentMessageSummary['tone']): string {
  if (tone === 'request') return 'kb-border-accent kb-surface-accent kb-text-accent';
  if (tone === 'response')
    return 'kb-status-positive-border kb-status-positive-surface kb-status-positive';
  return 'kb-status-warning-border kb-status-warning-surface kb-status-warning';
}

function messageTypeLabel(type: AgentMessageSummary['type']): string {
  if (type === 'handoff') return 'a2a handoff';
  return type;
}

function buildMissionThread(
  missionId: string,
  agentMessages: AgentMessageSummary[],
  a2aHandoffs: A2AHandoffSummary[]
): MissionThreadEntry[] {
  const entries: MissionThreadEntry[] = [];

  for (const handoff of a2aHandoffs) {
    if (handoff.missionId !== missionId) continue;
    entries.push({
      ts: handoff.ts,
      missionId,
      type: 'handoff',
      tone: 'request',
      agentId: handoff.receiver,
      teamRole: handoff.teamRole,
      label: `${handoff.sender} -> ${handoff.receiver}`,
      content: handoff.promptExcerpt || 'A2A handoff dispatched.',
      channel: handoff.channel,
      thread: handoff.thread,
    });
  }

  for (const message of agentMessages) {
    if (message.missionId !== missionId) continue;
    entries.push({
      ts: message.ts,
      missionId,
      type: message.type,
      tone: message.tone,
      agentId: message.agentId,
      teamRole: message.teamRole,
      label: message.agentId,
      content: message.content,
      channel: message.channel,
      thread: message.thread,
    });
  }

  return entries.sort((a, b) => a.ts.localeCompare(b.ts)).slice(-48);
}

function ActionDetailList({
  actionId,
  details,
}: {
  actionId?: string;
  details: Record<string, ControlActionDetail[]>;
}) {
  if (!actionId) return null;
  const entries = details[actionId] || [];
  return (
    <div className="mt-3 space-y-2 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-3">
      {entries.length === 0 ? (
        <div className="text-[10px] kb-text-muted">No detail observations recorded yet.</div>
      ) : (
        entries.map((detail, detailIndex) => (
          <div
            key={`${actionId}-${detail.ts}-${detailIndex}`}
            className="border-l kb-border-subtle pl-3"
          >
            <div className="text-[10px] uppercase tracking-[0.16em] kb-text-muted">
              {detail.decision}
            </div>
            {detail.decision === 'next_action_executed' ||
            detail.decision === 'memory_promote_pending_applied' ? (
              <div className="mt-1 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                <div>
                  operation:{' '}
                  <span className="font-mono kb-text-secondary">{detail.operation || '-'}</span>
                </div>
                <div>
                  target:{' '}
                  <span className="font-mono kb-text-secondary">{detail.resource_id || '-'}</span>
                </div>
                {detail.action_id ? (
                  <div className="col-span-2">
                    action id:{' '}
                    <span className="font-mono kb-text-secondary">{detail.action_id}</span>
                  </div>
                ) : null}
                {detail.outcome ? (
                  <div>
                    outcome: <span className="font-mono kb-text-secondary">{detail.outcome}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            {detail.why && <div className="mt-1 text-[10px] kb-text-secondary">{detail.why}</div>}
            {detail.error && (
              <div className="mt-1 text-[10px] kb-status-negative">{detail.error}</div>
            )}
            <div className="mt-1 text-[9px] font-mono kb-text-muted">
              {new Date(detail.ts).toLocaleString(chronosSpeechLocale())}
            </div>
          </div>
        ))
      )}
    </div>
  );
}

function ActionGuidance({
  latestAction,
  availableActions,
}: {
  latestAction: ControlActionSummary | null;
  availableActions: ControlActionDefinition[];
}) {
  if (!latestAction) return null;
  const currentAction = getActionDefinition(availableActions, latestAction.operation);
  const nextValidActions = availableActions.filter(
    (action) => action.enabled && action.operation !== latestAction.operation
  );
  const shouldShow =
    latestAction.status === 'failed' ||
    Boolean(currentAction?.disabledReason) ||
    nextValidActions.length > 0;

  if (!shouldShow) return null;

  return (
    <div className="mt-3 rounded-lg border kb-border-subtle kb-surface-sunken px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">operator guidance</div>
      {currentAction?.disabledReason && (
        <div className="mt-2 text-[10px] kb-text-muted">
          disabled reason: <span className="kb-text-secondary">{currentAction.disabledReason}</span>
        </div>
      )}
      {nextValidActions.length > 0 && (
        <div className="mt-2 text-[10px] kb-text-muted">
          next valid actions:{' '}
          <span className="kb-text-secondary">
            {nextValidActions.map((action) => action.label).join(', ')}
          </span>
        </div>
      )}
      {latestAction.status === 'failed' &&
        nextValidActions.length === 0 &&
        !currentAction?.enabled && (
          <div className="mt-2 text-[10px] kb-status-warning">
            No immediate retry path is available from the current target state.
          </div>
        )}
    </div>
  );
}

function actionButtonClass(kind: 'safe' | 'risky'): string {
  if (kind === 'risky') {
    return 'rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-status-negative transition hover:kb-status-negative-surface disabled:cursor-not-allowed disabled:opacity-40';
  }
  return 'rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40';
}

export interface DangerousActionPrompt {
  title: string;
  detail: string;
  confirmLabel: string;
  cancelLabel: string;
}

export function buildDangerousActionPrompt(
  subject: string,
  operation: string,
  reversible: boolean
): DangerousActionPrompt {
  return {
    title: `${subject} · ${operation}`,
    detail: reversible
      ? 'This action changes state and can be retried or reverted through the governed control plane.'
      : 'This action changes state and may not be fully reversible.',
    confirmLabel: operation,
    cancelLabel: 'cancel',
  };
}

function missionSummaryBadgeClass(tone: MissionSummary['controlTone']): string {
  if (tone === 'pending') return 'kb-status-info-surface kb-status-info';
  if (tone === 'ready') return 'kb-surface-accent kb-text-accent';
  if (tone === 'attention') return 'kb-status-warning-surface kb-status-warning';
  return 'kb-status-positive-surface kb-status-positive';
}

function buildMissionIntentSummary(data: IntelligencePayload, mission: MissionSummary): string {
  const latestHandoff = data.a2aHandoffs
    .filter((handoff) => handoff.missionId === mission.missionId)
    .sort((a, b) => b.ts.localeCompare(a.ts))[0];
  if (latestHandoff?.promptExcerpt) return latestHandoff.promptExcerpt;
  if (latestHandoff?.intent) return latestHandoff.intent;
  if (mission.missionType) return mission.missionType;
  return 'Durable work item';
}

function surfaceSummaryBadgeClass(tone: SurfaceSummary['controlTone']): string {
  if (tone === 'pending') return 'kb-status-info-surface kb-status-info';
  if (tone === 'stable') return 'kb-status-positive-surface kb-status-positive';
  if (tone === 'offline') return 'kb-surface-raised kb-text-secondary';
  return 'kb-status-warning-surface kb-status-warning';
}

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

function getActionsByRisk(
  actions: ControlActionDefinition[],
  risk: 'safe' | 'risky'
): ControlActionDefinition[] {
  return actions.filter((action) => action.risk === risk);
}

function getSharedDisabledReason(actions: ControlActionDefinition[]): string | null {
  const reasons = actions
    .map((action) => action.disabledReason)
    .filter((reason): reason is string => Boolean(reason));
  return reasons[0] || null;
}

function getAvailableMissionActions(
  data: IntelligencePayload,
  missionId: string
): ControlActionDefinition[] {
  return data.controlActionAvailability.mission[missionId] || data.controlActionCatalog.mission;
}

function getAvailableSurfaceActions(
  data: IntelligencePayload,
  surfaceId: string
): ControlActionDefinition[] {
  return data.controlActionAvailability.surface[surfaceId] || data.controlActionCatalog.surface;
}

function getActionDefinition(
  actions: ControlActionDefinition[],
  operation: string
): ControlActionDefinition | null {
  return actions.find((action) => action.operation === operation) || null;
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

export function MissionIntelligence({
  workspace = 'surface',
  focusedView = null,
  onClearFocus,
  onOpenWorkspace,
  focusedMissionId = null,
  hideSurfaceControl = false,
}: {
  workspace?: MissionIntelligenceWorkspace;
  focusedView?: string | null;
  onClearFocus?: () => void;
  onOpenWorkspace?: (
    workspace: Exclude<MissionIntelligenceWorkspace, 'surface'>,
    panelId: string
  ) => void;
  focusedMissionId?: string | null;
  hideSurfaceControl?: boolean;
}) {
  const locale = resolveChronosLocale();
  const mt = (key: string, fallbackEn: string) => uxTextOr(key, fallbackEn, locale);
  const [mounted, setMounted] = useState(false);
  const [data, setData] = useState<IntelligencePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [remediationTarget, setRemediationTarget] = useState<string | null>(null);
  const [outboxTarget, setOutboxTarget] = useState<string | null>(null);
  const [missionActionTarget, setMissionActionTarget] = useState<string | null>(null);
  const [missionSeedTarget, setMissionSeedTarget] = useState<string | null>(null);
  const [trackSeedTarget, setTrackSeedTarget] = useState<string | null>(null);
  const [approvalTarget, setApprovalTarget] = useState<string | null>(null);
  const [surfaceActionTarget, setSurfaceActionTarget] = useState<string | null>(null);
  const [memoryPromotionTarget, setMemoryPromotionTarget] = useState<'dry-run' | 'promote' | null>(
    null
  );
  const [nextActionTarget, setNextActionTarget] = useState<string | null>(null);
  const [browserSessionTarget, setBrowserSessionTarget] = useState<string | null>(null);
  const [actionResult, setActionResult] = useState<string | null>(null);
  const [distillCandidateTarget, setDistillCandidateTarget] = useState<string | null>(null);
  const [dangerousAction, setDangerousAction] = useState<{
    title: string;
    detail: string;
    confirmLabel: string;
    cancelLabel?: string;
    onConfirm: () => Promise<void> | void;
  } | null>(null);
  const [expandedActionId, setExpandedActionId] = useState<string | null>(null);
  const [expandedMissionCardActionId, setExpandedMissionCardActionId] = useState<string | null>(
    null
  );
  const [expandedSurfaceCardActionId, setExpandedSurfaceCardActionId] = useState<string | null>(
    null
  );
  const [expandedGlobalSurfaceActionId, setExpandedGlobalSurfaceActionId] = useState<string | null>(
    null
  );
  const [messageMissionFilter, setMessageMissionFilter] = useState<string>('all');
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(() =>
    loadMissionIntelligenceSelectedMissionId()
  );
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedReferencePath, setSelectedReferencePath] = useState<string | null>(null);
  const [referenceDetail, setReferenceDetail] = useState<ReferenceDetail | null>(null);
  const missionThreadPanelRef = useRef<HTMLDivElement | null>(null);
  // Render-computed view state for the hoisted mission-control effects. The
  // effects must sit ABOVE the error/mounted/data early returns (hook count
  // must not change between renders), so they read the latest values here.
  const missionControlViewRef = useRef<{
    filteredMissions: MissionSummary[];
    effectiveMissionId: string | null;
  }>({ filteredMissions: [], effectiveMissionId: null });

  useEffect(() => {
    setMounted(true);
  }, []);

  // Risky actions are always routed through a confirmation step before state changes.
  const requestDangerousAction = (
    title: string,
    detail: string,
    confirmLabel: string,
    onConfirm: () => Promise<void> | void
  ) => {
    setDangerousAction({ title, detail, confirmLabel, onConfirm });
  };

  const clearDangerousAction = () => {
    setDangerousAction(null);
  };

  const confirmDangerousAction = async () => {
    if (!dangerousAction) return;
    const action = dangerousAction;
    setDangerousAction(null);
    await action.onConfirm();
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const params = new URLSearchParams(window.location.search);
    const mission = params.get('mission');
    const project = params.get('project');
    const track = params.get('track');
    if (mission) {
      setSelectedMissionId(mission);
      setMessageMissionFilter(mission);
    }
    if (project) setSelectedProjectId(project);
    if (track) setSelectedTrackId(track);
  }, []);

  useEffect(() => {
    saveMissionIntelligenceSelectedMissionId(selectedMissionId);
  }, [selectedMissionId]);

  const jumpToTarget = (action: ControlActionSummary) => {
    const id =
      action.kind === 'mission'
        ? toDomId('mission', action.target)
        : toDomId('surface', action.target);
    const element = document.getElementById(id);
    if (!element) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const refreshData = async () => {
    const refreshed = await fetch('/api/intelligence', { cache: 'no-store' });
    const refreshedBody = await refreshed.json();
    if (!refreshed.ok) {
      throw new Error(refreshedBody.error || 'Failed to refresh mission intelligence');
    }
    setData(refreshedBody);
    setError(null);
  };

  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch('/api/intelligence', { cache: 'no-store' });
        const body = await res.json();
        if (!alive) return;
        if (!res.ok) {
          setError(body.error || 'Failed to load mission intelligence');
          return;
        }
        setData(body);
      } catch (err: any) {
        if (alive) setError(err.message || 'Failed to load mission intelligence');
      }
    };

    load();
    const timer = setInterval(load, 10000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  const focusMissionThread = (missionId: string) => {
    setSelectedMissionId(missionId);
    setMessageMissionFilter(missionId);
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      missionThreadPanelRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  };

  const focusMissionCard = (missionId: string) => {
    setSelectedMissionId(missionId);
    setMessageMissionFilter(missionId);
    if (typeof window === 'undefined') return;
    window.requestAnimationFrame(() => {
      document.getElementById(`mission-card-${missionId}`)?.scrollIntoView({
        behavior: 'smooth',
        block: 'start',
      });
    });
  };

  useEffect(() => {
    const source = new EventSource('/api/intelligence/stream');

    source.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data) as {
          recentEvents?: OrchestrationEvent[];
          agentMessages?: AgentMessageSummary[];
          a2aHandoffs?: A2AHandoffSummary[];
          controlActions?: ControlActionSummary[];
          controlActionDetails?: Record<string, ControlActionDetail[]>;
          ownerSummaries?: OwnerSummary[];
          browserSessions?: BrowserSessionSummary[];
          runtime?: {
            total: number;
            ready: number;
            busy: number;
            error: number;
          };
          runtimeTopology?: IntelligencePayload['runtimeTopology'];
        };
        setData((current) =>
          current
            ? {
                ...current,
                recentEvents: Array.isArray(payload.recentEvents)
                  ? payload.recentEvents
                  : current.recentEvents,
                agentMessages: Array.isArray(payload.agentMessages)
                  ? payload.agentMessages
                  : current.agentMessages,
                a2aHandoffs: Array.isArray(payload.a2aHandoffs)
                  ? payload.a2aHandoffs
                  : current.a2aHandoffs,
                controlActions: Array.isArray(payload.controlActions)
                  ? payload.controlActions
                  : current.controlActions,
                controlActionDetails: payload.controlActionDetails || current.controlActionDetails,
                ownerSummaries: Array.isArray(payload.ownerSummaries)
                  ? payload.ownerSummaries
                  : current.ownerSummaries,
                browserSessions: Array.isArray(payload.browserSessions)
                  ? payload.browserSessions
                  : current.browserSessions,
                runtime: payload.runtime || current.runtime,
                runtimeTopology: payload.runtimeTopology || current.runtimeTopology,
              }
            : current
        );
      } catch {
        // Ignore malformed SSE payloads and keep polling fallback.
      }
    };

    source.onerror = () => {
      source.close();
    };

    return () => {
      source.close();
    };
  }, []);

  useEffect(() => {
    if (!focusedView) return;
    window.requestAnimationFrame(() => {
      document.getElementById(focusedView)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    });
  }, [focusedView]);

  const remediateLease = async (
    agentId: string,
    action: 'cleanup_runtime_lease' | 'restart_runtime_lease'
  ) => {
    try {
      setRemediationTarget(agentId);
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action,
          agentId,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Failed to remediate runtime lease');
      }
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Failed to remediate runtime lease');
    } finally {
      setRemediationTarget(null);
    }
  };

  const clearOutboxMessage = async (surface: 'slack' | 'chronos', messageId: string) => {
    try {
      setOutboxTarget(messageId);
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          action: 'clear_surface_outbox',
          surface,
          messageId,
        }),
      });
      const body = await res.json();
      if (!res.ok) {
        throw new Error(body.error || 'Failed to clear outbox message');
      }
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Failed to clear outbox message');
    } finally {
      setOutboxTarget(null);
    }
  };

  const runMissionControl = async (missionId: string, operation: string) => {
    try {
      setMissionActionTarget(`${missionId}:${operation}`);
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'mission_control',
          missionId,
          operation,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Mission control action failed');
      setActionResult(`${missionId}: ${operation}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Mission control action failed');
    } finally {
      setMissionActionTarget(null);
    }
  };

  const promoteMissionSeed = async (seedId: string) => {
    try {
      setMissionSeedTarget(seedId);
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'promote_mission_seed',
          seedId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Mission seed promotion failed');
      setActionResult(`${seedId}: promoted`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Mission seed promotion failed');
    } finally {
      setMissionSeedTarget(null);
    }
  };

  const createTrackSeed = async (trackId: string, artifactId?: string) => {
    try {
      setTrackSeedTarget(trackId);
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'create_track_seed',
          trackId,
          artifactId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Track seed creation failed');
      setActionResult(`${trackId}: seed ready`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Track seed creation failed');
    } finally {
      setTrackSeedTarget(null);
    }
  };

  const parseReferenceContent = (
    rawText: string,
    logicalPath: string,
    endpoint: string,
    openLabel: string
  ): ReferenceDetail => {
    const lines = String(rawText || '').split(/\r?\n/);
    const detail: ReferenceDetail = {
      path: logicalPath,
      title:
        String(logicalPath || 'reference')
          .split('/')
          .pop() || 'reference',
      summary: '',
      metadata: {},
      sections: [],
      body: '',
      endpoint,
      openLabel,
    };
    let startIndex = 0;
    if (lines[0] === '---') {
      const endIndex = lines.findIndex((line, index) => index > 0 && line === '---');
      if (endIndex > 0) {
        for (const line of lines.slice(1, endIndex)) {
          const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
          if (match) detail.metadata[match[1]] = match[2].trim();
        }
        startIndex = endIndex + 1;
      }
    }
    let currentSection: { title: string; lines: string[] } | null = null;
    const bodyLines: string[] = [];
    for (const line of lines.slice(startIndex)) {
      if (line.startsWith('# ')) {
        detail.title = line.slice(2).trim() || detail.title;
        continue;
      }
      if (line.startsWith('## ')) {
        currentSection = { title: line.slice(3).trim(), lines: [] };
        detail.sections.push(currentSection);
        continue;
      }
      if (currentSection) currentSection.lines.push(line);
      else bodyLines.push(line);
    }
    detail.body = bodyLines.join('\n').trim();
    detail.summary =
      detail.metadata.summary || detail.body.split('\n').find((line) => line.trim()) || '';
    return detail;
  };

  const openRuntimeReference = async (logicalPath: string) => {
    const path = String(logicalPath || '').trim();
    if (!path) return;
    const endpoint = '/api/runtime-file';
    setSelectedReferencePath(path);
    setReferenceDetail({
      path,
      title: path.split('/').pop() || path,
      summary: 'Loading skeleton...',
      metadata: {},
      sections: [],
      body: '',
      endpoint,
      openLabel: 'open raw skeleton',
    });
    try {
      const res = await fetch(`${endpoint}?path=${encodeURIComponent(path)}`);
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      setReferenceDetail(parseReferenceContent(text, path, endpoint, 'open raw skeleton'));
    } catch (err: any) {
      setReferenceDetail({
        path,
        title: path.split('/').pop() || path,
        summary: err.message || 'Failed to load skeleton',
        metadata: {},
        sections: [],
        body: '',
        endpoint,
        openLabel: 'open raw skeleton',
      });
    }
  };

  const openKnowledgeReference = async (logicalPath: string) => {
    const path = String(logicalPath || '').trim();
    if (!path) return;
    const endpoint = '/api/knowledge-ref';
    setSelectedReferencePath(path);
    setReferenceDetail({
      path,
      title: path.split('/').pop() || path,
      summary: 'Loading template...',
      metadata: {},
      sections: [],
      body: '',
      endpoint,
      openLabel: 'open raw template',
    });
    try {
      const res = await fetch(`${endpoint}?path=${encodeURIComponent(path)}`);
      const text = await res.text();
      if (!res.ok) throw new Error(text || `HTTP ${res.status}`);
      setReferenceDetail(parseReferenceContent(text, path, endpoint, 'open raw template'));
    } catch (err: any) {
      setReferenceDetail({
        path,
        title: path.split('/').pop() || path,
        summary: err.message || 'Failed to load template',
        metadata: {},
        sections: [],
        body: '',
        endpoint,
        openLabel: 'open raw template',
      });
    }
  };

  const decideApproval = async (
    approval: PendingApprovalSummary,
    decision: 'approved' | 'rejected'
  ) => {
    try {
      setApprovalTarget(approval.id);
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'approval_decision',
          requestId: approval.id,
          channel: approval.channel,
          storageChannel: approval.storageChannel,
          decision,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Approval decision failed');
      setActionResult(`${approval.id}: ${decision}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Approval decision failed');
    } finally {
      setApprovalTarget(null);
    }
  };

  const decideDistillCandidate = async (
    candidate: DistillCandidateSummary,
    decision: 'promote' | 'archive'
  ) => {
    try {
      setDistillCandidateTarget(candidate.candidate_id);
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'distill_candidate_decision',
          candidateId: candidate.candidate_id,
          decision,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Distill candidate decision failed');
      setActionResult(`${candidate.candidate_id}: ${decision}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Distill candidate decision failed');
    } finally {
      setDistillCandidateTarget(null);
    }
  };

  const runSurfaceControl = async (surfaceId: string | null, operation: string) => {
    try {
      setSurfaceActionTarget(`${surfaceId || 'all'}:${operation}`);
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'surface_control',
          surfaceId,
          operation,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Surface control action failed');
      setActionResult(`${surfaceId || 'surfaces'}: ${operation}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Surface control action failed');
    } finally {
      setSurfaceActionTarget(null);
    }
  };

  const runMemoryPromotion = async (dryRun: boolean) => {
    try {
      setMemoryPromotionTarget(dryRun ? 'dry-run' : 'promote');
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'memory_promote_pending',
          dryRun,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Memory promotion action failed');
      if (dryRun) {
        const pending = Array.isArray(body.pending) ? body.pending.length : 0;
        setActionResult(`memory promotion dry-run: ${pending} candidate(s)`);
      } else {
        setActionResult(
          `memory promoted: ${body.promoted_count || 0} success, ${body.failed_count || 0} failed`
        );
      }
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Memory promotion action failed');
    } finally {
      setMemoryPromotionTarget(null);
    }
  };

  const recordNextActionExecution = async (input: {
    actionId: string;
    operation?: string;
    outcome?: 'completed' | 'failed';
    target?: string;
    detail?: string;
  }) => {
    try {
      await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'next_action_execute',
          actionId: input.actionId,
          operation: input.operation || 'next_action_execute',
          outcome: input.outcome || 'completed',
          target: input.target || 'next-actions',
          detail: input.detail || '',
        }),
      });
    } catch {
      // best-effort audit emission only
    }
  };

  const navigateToPanel = (
    targetWorkspace: Exclude<MissionIntelligenceWorkspace, 'surface'>,
    panelId: string
  ) => {
    if (workspace !== targetWorkspace && onOpenWorkspace) {
      onOpenWorkspace(targetWorkspace, panelId);
      return;
    }
    document.getElementById(panelId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  const runNextAction = async (action: NonNullable<IntelligencePayload['nextActions']>[number]) => {
    try {
      setNextActionTarget(action.action_id);
      if (action.action_id === 'chronos-promote-memory') {
        await runMemoryPromotion(false);
        await recordNextActionExecution({
          actionId: action.action_id,
          operation: 'memory_promote_pending',
          target: 'memory-promotion-queue',
          detail: 'Executed promote approved memory action from next-actions panel.',
        });
        return;
      }
      if (action.action_id === 'chronos-approve-pending' || action.next_action_type === 'approve') {
        navigateToPanel('governance', 'approvals');
        setActionResult(`next action routed: ${action.action_id} -> approvals`);
        await recordNextActionExecution({
          actionId: action.action_id,
          operation: 'route_to_approvals',
          target: 'approvals',
          detail: 'Routed operator to approvals panel from next-actions.',
        });
        return;
      }
      if (
        action.action_id === 'chronos-promote-seed' ||
        action.next_action_type === 'promote_mission_seed'
      ) {
        navigateToPanel('missions', 'mission-seeds');
        setActionResult(`next action routed: ${action.action_id} -> mission seeds`);
        await recordNextActionExecution({
          actionId: action.action_id,
          operation: 'route_to_mission_seeds',
          target: 'mission-seeds',
          detail: 'Routed operator to mission seeds panel from next-actions.',
        });
        return;
      }
      if ((action.suggested_command || '').includes('promote-memory')) {
        await runMemoryPromotion(true);
        await recordNextActionExecution({
          actionId: action.action_id,
          operation: 'memory_promote_pending_dry_run',
          target: 'memory-promotion-queue',
          detail: 'Executed dry-run memory promotion from suggested command hint.',
        });
        return;
      }
      setActionResult(`manual next action: ${action.suggested_command || action.reason}`);
      await recordNextActionExecution({
        actionId: action.action_id,
        operation: 'manual_follow_up',
        target: 'next-actions',
        detail: action.suggested_command || action.reason,
      });
    } catch (err: any) {
      setError(err.message || 'Next action execution failed');
      await recordNextActionExecution({
        actionId: action.action_id,
        operation: 'next_action_execute',
        outcome: 'failed',
        target: 'next-actions',
        detail: err?.message || 'Next action execution failed',
      });
    } finally {
      setNextActionTarget(null);
    }
  };

  const resolveNextActionRoute = (
    action: NonNullable<IntelligencePayload['nextActions']>[number]
  ): { panelId: string; label: string } | null => {
    const panelFromApi = String(action.suggested_surface_action || '').trim();
    if (panelFromApi === 'approvals') return { panelId: 'approvals', label: 'Approvals Panel' };
    if (panelFromApi === 'mission-seeds')
      return { panelId: 'mission-seeds', label: 'Mission Seeds Panel' };
    if (panelFromApi === 'memory-promotion-queue')
      return { panelId: 'memory-promotion-queue', label: 'Memory Promotion Queue' };
    const suggested = String(action.suggested_command || '').toLowerCase();
    if (
      action.action_id === 'chronos-approve-pending' ||
      action.next_action_type === 'approve' ||
      suggested.includes('chronos approvals')
    ) {
      return { panelId: 'approvals', label: 'Approvals Panel' };
    }
    if (
      action.action_id === 'chronos-promote-seed' ||
      action.next_action_type === 'promote_mission_seed' ||
      suggested.includes('mission-seeds')
    ) {
      return { panelId: 'mission-seeds', label: 'Mission Seeds Panel' };
    }
    if (
      action.action_id === 'chronos-promote-memory' ||
      suggested.includes('promote-memory') ||
      suggested.includes('memory-promote')
    ) {
      return { panelId: 'memory-promotion-queue', label: 'Memory Promotion Queue' };
    }
    return null;
  };

  const jumpToNextActionRoute = (
    action: NonNullable<IntelligencePayload['nextActions']>[number]
  ) => {
    const route = resolveNextActionRoute(action);
    if (!route) {
      setActionResult(`next action route unavailable: ${action.action_id}`);
      return;
    }
    const targetWorkspace =
      route.panelId === 'approvals' || route.panelId === 'memory-promotion-queue'
        ? 'governance'
        : 'missions';
    navigateToPanel(targetWorkspace, route.panelId);
    setActionResult(`next action route preview: ${action.action_id} -> ${route.label}`);
  };

  const runBrowserSessionControl = async (
    sessionId: string,
    action: 'close_browser_session' | 'restart_browser_session'
  ) => {
    try {
      setBrowserSessionTarget(`${sessionId}:${action}`);
      const res = await fetch('/api/intelligence', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action,
          sessionId,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error || 'Browser session control action failed');
      setActionResult(`${sessionId}: ${action}`);
      await refreshData();
    } catch (err: any) {
      setError(err.message || 'Browser session control action failed');
    } finally {
      setBrowserSessionTarget(null);
    }
  };

  useEffect(() => {
    if (typeof window === 'undefined') return;
    // pin mission thread selection into the URL so a mission pinned view survives reload/share.
    const url = new URL(window.location.href);
    if (selectedMissionId) {
      url.searchParams.set('mission', selectedMissionId);
    } else {
      url.searchParams.delete('mission');
    }
    if (selectedProjectId) {
      url.searchParams.set('project', selectedProjectId);
    } else {
      url.searchParams.delete('project');
    }
    if (selectedTrackId) {
      url.searchParams.set('track', selectedTrackId);
    } else {
      url.searchParams.delete('track');
    }
    window.history.replaceState({}, '', url.toString());
  }, [selectedMissionId, selectedProjectId, selectedTrackId]);

  useEffect(() => {
    if (focusedView !== 'mission-control-plane') return;
    const missionId = resolveMissionControlFocusId(
      missionControlViewRef.current.filteredMissions,
      selectedMissionId,
      focusedMissionId
    );
    if (!missionId || missionId === selectedMissionId) return;
    setSelectedMissionId(missionId);
    setMessageMissionFilter(missionId);
  }, [data, focusedMissionId, focusedView, selectedMissionId]);

  useEffect(() => {
    if (focusedView !== 'mission-control-plane') return;
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableHotkeyTarget(event.target)) return;
      const action = resolveMissionThreadHotkeyAction(event.key);
      const effectiveMissionId = missionControlViewRef.current.effectiveMissionId;
      if (!action || !effectiveMissionId) return;
      event.preventDefault();
      if (action === 'thread') {
        focusMissionThread(effectiveMissionId);
        return;
      }
      focusMissionCard(effectiveMissionId);
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [focusedView]);

  const missionPinStatusLabel = selectedMissionId ? 'mission pinned' : 'pin mission thread';

  if (error) {
    const safeError = buildUserFacingError(error, { locale, surface: 'chronos' });
    return (
      <div className="flex h-full w-full items-center justify-center">
        <div className="w-full max-w-xl">
          <SurfaceStatusPanel
            eyebrow="Mission Intelligence"
            title={safeError.title}
            detail={`${safeError.body} ${safeError.nextAction}`}
            tone="error"
            meta={safeError.traceLine}
            actionLabel="Retry"
            onAction={() => {
              void refreshData();
            }}
          />
        </div>
      </div>
    );
  }

  if (!mounted) {
    return (
      <SurfaceStatusPanel
        eyebrow="Mission Intelligence"
        title="Loading mission intelligence"
        detail="Chronos is fetching missions, runtime state, and the latest governance signals."
        tone="neutral"
      />
    );
  }

  if (!data) {
    return (
      <SurfaceStatusPanel
        eyebrow="Mission Intelligence"
        title="Waiting for mission data"
        detail={mt('chronos_mission_loading', 'Loading mission intelligence...')}
        tone="neutral"
      />
    );
  }

  const selectedProject = selectedProjectId
    ? data.projects.find((project) => project.project_id === selectedProjectId) || null
    : null;
  const selectedProjectManagement = selectedProject
    ? (data.projectManagement || []).find(
        (item) => item.project.project_id === selectedProject.project_id
      ) || null
    : null;
  const selectedMission = selectedMissionId
    ? data.activeMissions.find((mission) => mission.missionId === selectedMissionId) || null
    : null;
  const availableTracks = selectedProject
    ? data.projectTracks.filter((track) => track.project_id === selectedProject.project_id)
    : data.projectTracks;
  const gateReadinessByTrack = new Map(
    (data.gateReadiness || []).map((item) => [item.track_id, item])
  );
  const hydratedTracks = availableTracks.map((track) => ({
    ...track,
    gate_readiness: track.gate_readiness || gateReadinessByTrack.get(track.track_id),
  }));
  const selectedTrack = selectedTrackId
    ? hydratedTracks.find((track) => track.track_id === selectedTrackId) || null
    : null;
  const selectedProjectMissionIds = new Set(selectedProject?.active_missions || []);
  const selectedProjectBootstrapItems = selectedProject?.bootstrap_work_items || [];
  const projectFilteredMissions = selectedProject
    ? data.activeMissions.filter((mission) => selectedProjectMissionIds.has(mission.missionId))
    : data.activeMissions;
  const filteredMissions = selectedTrack
    ? projectFilteredMissions.filter((mission) => mission.trackId === selectedTrack.track_id)
    : projectFilteredMissions;
  const filteredServiceBindings = selectedProject
    ? data.serviceBindings.filter((binding) =>
        (selectedProject.service_bindings || []).includes(binding.binding_id)
      )
    : data.serviceBindings;
  const filteredMissionSeeds = selectedProject
    ? data.missionSeeds.filter((seed) => seed.project_id === selectedProject.project_id)
    : data.missionSeeds;
  const filteredMissionSeedsByTrack = selectedTrack
    ? filteredMissionSeeds.filter(
        (seed) =>
          seed.track_id === selectedTrack.track_id ||
          seed.work_loop?.context?.track_id === selectedTrack.track_id
      )
    : filteredMissionSeeds;
  const filteredDistillCandidates = selectedProject
    ? data.distillCandidates.filter(
        (candidate) => candidate.project_id === selectedProject.project_id
      )
    : data.distillCandidates;
  const filteredDistillCandidatesByTrack = selectedTrack
    ? filteredDistillCandidates.filter(
        (candidate) =>
          candidate.track_id === selectedTrack.track_id ||
          candidate.work_loop?.context?.track_id === selectedTrack.track_id
      )
    : filteredDistillCandidates;
  const filteredRecentArtifacts = selectedProject
    ? data.recentArtifacts.filter((artifact) => artifact.project_id === selectedProject.project_id)
    : data.recentArtifacts;
  const filteredRecentArtifactsByTrack = selectedTrack
    ? filteredRecentArtifacts.filter(
        (artifact) =>
          artifact.track_id === selectedTrack.track_id ||
          artifact.work_loop?.context?.track_id === selectedTrack.track_id
      )
    : filteredRecentArtifacts;
  const filteredPendingApprovals = selectedProject
    ? data.pendingApprovals.filter(
        (approval) => !approval.missionId || selectedProjectMissionIds.has(approval.missionId)
      )
    : data.pendingApprovals;
  const filteredPendingApprovalsByTrack = selectedTrack
    ? filteredPendingApprovals.filter(
        (approval) =>
          approval.trackId === selectedTrack.track_id ||
          approval.work_loop?.context?.track_id === selectedTrack.track_id
      )
    : filteredPendingApprovals;
  const allMemoryCandidates = Array.isArray(data.memoryCandidates) ? data.memoryCandidates : [];
  const filteredMemoryCandidates = selectedProject
    ? allMemoryCandidates.filter((candidate) => {
        const sourceRef = String(candidate.source_ref || '');
        const missionMatch = sourceRef.match(/^mission:([A-Za-z0-9-]+)/u);
        if (!missionMatch) return true;
        return selectedProjectMissionIds.has(missionMatch[1] || '');
      })
    : allMemoryCandidates;
  const filteredMemoryCandidatesByTrack = selectedTrack
    ? filteredMemoryCandidates.filter((candidate) => {
        const sourceRef = String(candidate.source_ref || '');
        const missionMatch = sourceRef.match(/^mission:([A-Za-z0-9-]+)/u);
        if (!missionMatch) return true;
        const mission = data.activeMissions.find((item) => item.missionId === missionMatch[1]);
        if (!mission) return true;
        return mission.trackId === selectedTrack.track_id;
      })
    : filteredMemoryCandidates;
  const filteredAgentMessages = data.agentMessages.filter((message) => {
    if (selectedProject && message.missionId && !selectedProjectMissionIds.has(message.missionId))
      return false;
    if (messageMissionFilter !== 'all' && message.missionId !== messageMissionFilter) return false;
    return true;
  });
  const filteredA2AHandoffs = data.a2aHandoffs.filter((handoff) => {
    if (selectedProject && !selectedProjectMissionIds.has(handoff.missionId)) return false;
    if (messageMissionFilter !== 'all' && handoff.missionId !== messageMissionFilter) return false;
    return true;
  });
  const learnedProjectRefs = (projectId: string) =>
    filteredDistillCandidatesByTrack
      .filter((candidate) => candidate.project_id === projectId && candidate.promoted_ref)
      .slice(0, 3);
  const learnedMissionSeedRefs = (seedId: string, projectId: string, missionId?: string) =>
    filteredDistillCandidatesByTrack
      .filter((candidate) => {
        if (candidate.project_id !== projectId || !candidate.promoted_ref) return false;
        const evidence = candidate.evidence_refs || [];
        return (
          evidence.includes(`mission_seed:${seedId}`) ||
          (missionId ? candidate.mission_id === missionId : false)
        );
      })
      .slice(0, 3);
  const effectiveMissionId =
    selectedMissionId ||
    (messageMissionFilter !== 'all' ? messageMissionFilter : filteredMissions[0]?.missionId) ||
    null;
  const missionThread =
    effectiveMissionId && (!selectedProject || selectedProjectMissionIds.has(effectiveMissionId))
      ? buildMissionThread(effectiveMissionId, data.agentMessages, data.a2aHandoffs)
      : [];
  missionControlViewRef.current = { filteredMissions, effectiveMissionId };
  const missionExceptions = filteredMissions.filter(
    (mission) => mission.controlTone === 'attention' || mission.controlTone === 'pending'
  );

  const surfaceExceptions = data.surfaces.filter(
    (surface) => surface.controlTone === 'attention' || surface.health === 'unhealthy'
  );
  const deliveryExceptions = data.recentSurfaceOutbox;
  const attentionItems = buildAttentionItems({
    missions: data.activeMissions,
    runtimeDoctor: data.runtimeDoctor,
    surfaces: data.surfaces,
    outbox: data.recentSurfaceOutbox,
  });

  const runAttentionAction = (item: AttentionItem) => {
    if (item.targetType === 'mission') {
      setSelectedMissionId(item.targetId);
      setMessageMissionFilter(item.targetId);
      if (workspace !== 'missions' && onOpenWorkspace) {
        onOpenWorkspace('missions', 'mission-control-plane');
      } else {
        document
          .getElementById(toDomId('mission', item.targetId))
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    if (item.targetType === 'runtime' && item.remediationAction) {
      remediateLease(item.targetId, item.remediationAction);
      return;
    }
    if (item.targetType === 'surface') {
      if (workspace !== 'surface-control' && onOpenWorkspace) {
        onOpenWorkspace('surface-control', 'surface-control');
      } else {
        document
          .getElementById(toDomId('surface', item.targetId))
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
      return;
    }
    navigateToPanel('diagnostics', 'recent-surface-outbox');
  };
  const panelVisible = (panelId: string) => {
    if (workspace === 'surface') {
      if (!focusedView) return false;
      if (focusedView === 'mission-control-plane') {
        return ['mission-control-plane', 'selected-mission-thread', 'a2a-handoff-trail'].includes(
          panelId
        );
      }
      return focusedView === panelId;
    }

    const panelWorkspaces: Record<Exclude<MissionIntelligenceWorkspace, 'surface'>, string[]> = {
      missions: [
        'next-actions',
        'needs-attention',
        'mission-control-plane',
        'projects',
        'tracks',
        'service-bindings',
        'mission-seeds',
        'skeleton-detail',
        'selected-mission-thread',
        'a2a-handoff-trail',
      ],
      deliverables: ['recent-artifacts'],
      operations: [
        'runtime-topology-map',
        'runtime-lease-doctor',
        'runtime-summary',
        'browser-sessions',
        'browser-guidance',
        'browser-conversation-sessions',
        'agent-traffic',
      ],
      governance: ['approvals', 'distill-candidates', 'memory-promotion-queue'],
      diagnostics: [
        'needs-attention',
        'recent-surface-outbox',
        'orchestration-audit',
        'owner-summaries',
      ],
      'surface-control': ['recent-control-actions', 'control-model'],
    };
    return panelWorkspaces[workspace].includes(panelId);
  };
  const focusTitle = focusedView
    ? (
        {
          'needs-attention': 'Needs Attention',
          'mission-control-plane': 'Mission Control',
          'runtime-topology-map': 'Runtime Topology',
          'runtime-lease-doctor': 'Runtime Governance',
          'recent-surface-outbox': 'Delivery Exceptions',
          'owner-summaries': 'Audit Trail',
        } as Record<string, string>
      )[focusedView] || 'Focused View'
    : null;
  const referenceMetadataEntries = Object.entries(referenceDetail?.metadata || {}).filter(
    ([, value]) => String(value || '').trim()
  );
  const referenceSections = Array.isArray(referenceDetail?.sections)
    ? referenceDetail.sections
    : [];
  const selectedReferenceSeed = selectedReferencePath
    ? filteredMissionSeedsByTrack.find(
        (seed) =>
          seed.metadata?.skeleton_path === selectedReferencePath ||
          seed.metadata?.template_ref === selectedReferencePath
      ) || null
    : null;
  const nextAction = data.nextActions?.[0] || null;
  const nextActions = Array.isArray(data.nextActions) ? data.nextActions : [];
  const memoryCandidateCount = (data.memoryCandidates || []).length;
  return (
    <div className="w-full h-full flex flex-col gap-6 overflow-y-auto pr-1">
      {dangerousAction ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center kb-surface-well px-4 py-6"
          onClick={clearDangerousAction}
          role="presentation"
        >
          <div
            className="w-full max-w-lg rounded-2xl border kb-border-subtle bg-[#0b1020] p-5 shadow-2xl shadow-black/40"
            onClick={(event) => event.stopPropagation()}
            role="dialog"
            aria-modal="true"
            aria-labelledby="chronos-dangerous-action-title"
          >
            <div className="text-[10px] uppercase tracking-[0.26em] kb-status-negative">
              risky action confirmation
            </div>
            <div
              id="chronos-dangerous-action-title"
              className="mt-2 text-lg font-semibold tracking-tight kb-text-primary"
            >
              {dangerousAction.title}
            </div>
            <div className="mt-3 text-[12px] leading-6 kb-text-secondary">
              {dangerousAction.detail}
            </div>
            <div className="mt-5 flex flex-wrap gap-2">
              <button
                type="button"
                onClick={clearDangerousAction}
                className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-3 py-2 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
              >
                {dangerousAction.cancelLabel || 'Cancel'}
              </button>
              <button
                type="button"
                onClick={() => void confirmDangerousAction()}
                className={actionButtonClass('risky')}
              >
                {dangerousAction.confirmLabel}
              </button>
            </div>
          </div>
        </div>
      ) : null}
      {/* Command Center: High-Visibility Action Dashboard */}
      {workspace === 'surface' && !selectedProject && !selectedMissionId && (
        <section className="flex flex-col gap-8 py-4">
          <div className="flex flex-col gap-2">
            <div className="text-[12px] uppercase tracking-[0.4em] kb-text-accent font-bold">
              Sovereign Command
            </div>
            <h2 className="text-3xl font-bold tracking-tight kb-text-primary">
              Welcome to the Mirror.
            </h2>
            <p className="text-sm kb-text-muted max-w-2xl leading-relaxed">
              Chronos is your operational管制塔. Use the tiles below to start monitoring or
              intervene in active agent workflows.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <button
              onClick={() =>
                document
                  .getElementById('mission-control-plane')
                  ?.scrollIntoView({ behavior: 'smooth' })
              }
              className="group kyberion-glass p-8 rounded-[32px] text-left hover:kb-border-accent transition-all hover:translate-y-[-4px]"
            >
              <div className="w-14 h-14 rounded-2xl kb-surface-accent flex items-center justify-center kb-text-accent mb-6 group-hover:scale-110 transition-transform">
                <Radar size={28} />
              </div>
              <h3 className="text-xl font-bold kb-text-primary mb-2">Monitor Missions</h3>
              <p className="text-xs kb-text-muted leading-relaxed">
                Observe real-time intent execution and artifact delivery across all active agents.
              </p>
              <div className="mt-6 text-[10px] uppercase tracking-widest kb-text-accent font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                Open Dashboard →
              </div>
            </button>

            <button
              onClick={() =>
                document
                  .getElementById('runtime-lease-doctor')
                  ?.scrollIntoView({ behavior: 'smooth' })
              }
              className="group kyberion-glass p-8 rounded-[32px] text-left hover:kb-status-warning-border transition-all hover:translate-y-[-4px]"
            >
              <div className="w-14 h-14 rounded-2xl kb-status-warning-surface flex items-center justify-center kb-status-warning mb-6 group-hover:scale-110 transition-transform">
                <Activity size={28} />
              </div>
              <h3 className="text-xl font-bold kb-text-primary mb-2">System Health</h3>
              <p className="text-xs kb-text-muted leading-relaxed">
                Inspect runtime leases, remediation findings, and supervisor-level governance.
              </p>
              <div className="mt-6 text-[10px] uppercase tracking-widest kb-status-warning font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                Check Vitals →
              </div>
            </button>

            <button
              onClick={() =>
                document
                  .getElementById('recent-surface-outbox')
                  ?.scrollIntoView({ behavior: 'smooth' })
              }
              className="group kyberion-glass p-8 rounded-[32px] text-left hover:kb-status-negative-border transition-all hover:translate-y-[-4px]"
            >
              <div className="w-14 h-14 rounded-2xl kb-status-negative-surface flex items-center justify-center kb-status-negative mb-6 group-hover:scale-110 transition-transform">
                <ShieldAlert size={28} />
              </div>
              <h3 className="text-xl font-bold kb-text-primary mb-2">Intervention</h3>
              <p className="text-xs kb-text-muted leading-relaxed">
                Resolve blocked deliveries, approve sensitive requests, and manage exceptions.
              </p>
              <div className="mt-6 text-[10px] uppercase tracking-widest kb-status-negative font-bold opacity-0 group-hover:opacity-100 transition-opacity">
                View Outbox →
              </div>
            </button>
          </div>

          <div className="kyberion-glass p-6 rounded-[24px] kb-border-subtle flex items-center justify-between kb-surface-raised">
            <div className="flex items-center gap-4">
              <div className="w-2 h-2 rounded-full kb-surface-accent pulse-animation" />
              <div className="text-[11px] uppercase tracking-[0.2em] kb-text-secondary">
                System Status: <span className="kb-text-accent font-bold">Nominal</span>
              </div>
            </div>
            <div className="text-[10px] kb-text-muted font-mono">
              Ready for operator commands via Sovereign Link or Quick Actions.
            </div>
          </div>
        </section>
      )}

      {workspace === 'surface' && focusedView && (
        <section className="rounded-[24px] border kb-border-accent kb-surface-accent px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.28em] kb-text-accent">
                Focused Operator View
              </div>
              <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                {focusTitle}
              </div>
              <div className="mt-1 text-[11px] leading-5 kb-text-muted">
                The main console is showing one operator view at full width.
              </div>
            </div>
            {onClearFocus && (
              <button
                type="button"
                onClick={onClearFocus}
                className="self-start rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[10px] uppercase tracking-[0.2em] kb-text-secondary transition hover:kb-surface-raised"
              >
                Show Full Console
              </button>
            )}
          </div>
        </section>
      )}
      {workspace === 'surface' ? (
        <section className="rounded-[26px] border kb-status-warning-border bg-gradient-to-br from-[var(--kb-status-warning-surface)] via-[var(--kb-surface-raised)] to-[var(--kb-surface-sunken)] px-5 py-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.3em] kb-status-warning">
                {mt('chronos_operator_console', 'Operator Console')}
              </div>
              <h2 className="mt-2 text-xl font-semibold tracking-tight kb-text-primary">
                {mt(
                  'chronos_mission_hero_title',
                  'Start with exceptions, then intervene only where mission flow or runtime governance needs help.'
                )}
              </h2>
              <p className="mt-2 max-w-3xl text-[12px] leading-6 kb-text-muted">
                {mt(
                  'chronos_mission_hero_description',
                  'Chronos is the operational mirror for Kyberion. Confirm what is active, identify what is blocked, open A2UI drill-downs when you need detail, and keep control actions deliberate and minimal.'
                )}
              </p>
            </div>
            <div className="grid grid-cols-2 gap-3 text-[10px] uppercase tracking-[0.18em] kb-text-muted sm:grid-cols-4">
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div>needs attention</div>
                <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                  {attentionItems.length}
                </div>
              </div>
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div>missions</div>
                <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                  {data.activeMissions.length}
                </div>
              </div>
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div>runtime incidents</div>
                <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                  {data.runtimeDoctor.length}
                </div>
              </div>
              <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div>delivery queue</div>
                <div className="mt-2 text-lg font-semibold tracking-tight kb-text-primary">
                  {data.surfaceOutbox.slack + data.surfaceOutbox.chronos}
                </div>
              </div>
            </div>
          </div>
          {actionResult && (
            <div className="mt-4 rounded-xl border kb-border-accent kb-surface-accent px-3 py-2 text-[11px] kb-text-accent">
              {mt('chronos_last_action', 'last action')}: {actionResult}
            </div>
          )}
          <div className="mt-3 rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2 text-[11px] kb-text-secondary">
            {mt('chronos_access', 'access')}:{' '}
            <span className="font-mono kb-text-primary">{data.accessRole}</span>
            {data.accessRole === 'readonly'
              ? mt(
                  'chronos_control_actions_disabled',
                  ' · control actions are disabled until a localadmin token is provided or localhost auto-admin is enabled.'
                )
              : mt('chronos_control_actions_enabled', ' · control actions enabled.')}
          </div>
          {data.company && (
            <div className="mt-3 rounded-xl border kb-border-accent kb-surface-accent px-3 py-3 text-[11px] kb-text-accent">
              <div className="text-[10px] uppercase tracking-[0.24em] kb-text-accent">
                Company Context
              </div>
              <div className="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] kb-text-primary">
                <span className="font-semibold kb-text-primary">{data.company.name}</span>
                <span className="kb-text-muted">·</span>
                <span className="font-mono kb-text-secondary">{data.company.companyId}</span>
                <span className="kb-text-muted">·</span>
                <span className="kb-text-secondary">
                  sovereign {data.company.sovereign || 'unknown'}
                </span>
              </div>
              <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                vision <span className="font-mono kb-text-primary">{data.company.visionRef}</span>
                <span className="mx-2 kb-text-muted">·</span>
                <span>{data.company.vision.title || data.company.vision.sourcePath}</span>
              </div>
              <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                org chart {data.company.orgChart.positionCount} positions /{' '}
                {data.company.orgChart.domainCount} domains
                {data.company.orgChart.topLevelRoles.length > 0 ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    top roles {data.company.orgChart.topLevelRoles.join(', ')}
                  </>
                ) : null}
              </div>
              <div className="mt-2 text-[11px] leading-5 kb-text-secondary">
                decision rights {data.company.decisionRights.ruleCount} rules
                {data.company.decisionRights.sourceKind ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.decisionRights.sourceKind}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                financial {data.company.financial.exists ? 'available' : 'missing'}
                {data.company.financial.exists ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.financial.periodCount} period
                    {data.company.financial.periodCount === 1 ? '' : 's'}
                    {data.company.financial.latestPeriodId ? (
                      <>
                        <span className="mx-2 kb-text-muted">·</span>
                        latest {data.company.financial.latestPeriodId}
                      </>
                    ) : null}
                    {typeof data.company.financial.latestGrossProfitJpy === 'number' ? (
                      <>
                        <span className="mx-2 kb-text-muted">·</span>
                        gross profit ¥
                        {data.company.financial.latestGrossProfitJpy.toLocaleString(
                          chronosSpeechLocale()
                        )}
                      </>
                    ) : null}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                finance controller {data.company.financeController.mode}
                {data.company.financeController.shouldCutCosts ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    cost cutting
                  </>
                ) : null}
                {data.company.financeController.reasons.length > 0 ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.financeController.reasons.length} reason
                    {data.company.financeController.reasons.length === 1 ? '' : 's'}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                OKR {data.company.okr.exists ? 'available' : 'missing'}
                {data.company.okr.exists ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.okr.objectiveCount} objective
                    {data.company.okr.objectiveCount === 1 ? '' : 's'}
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.okr.keyResultCount} KR
                    <span className="mx-2 kb-text-muted">·</span>
                    {data.company.okr.progressPercent}% progress
                    {data.company.okr.latestObjective ? (
                      <>
                        <span className="mx-2 kb-text-muted">·</span>
                        latest {data.company.okr.latestObjective}
                      </>
                    ) : null}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                audit {data.company.approvalAudit.total}
                <span className="mx-2 kb-text-muted">·</span>
                allowed {data.company.approvalAudit.allowed}
                <span className="mx-2 kb-text-muted">·</span>
                denied {data.company.approvalAudit.denied}
                {data.company.approvalAudit.latestCorrelationId ? (
                  <>
                    <span className="mx-2 kb-text-muted">·</span>
                    latest {data.company.approvalAudit.latestCorrelationId}
                  </>
                ) : null}
                <span className="mx-2 kb-text-muted">·</span>
                audit drilldown {data.company.approvalAuditDrilldown.byDecisionType.length} types /{' '}
                {data.company.approvalAuditDrilldown.byCorrelationId.length} chains
              </div>
            </div>
          )}
          {selectedProject && (
            <div className="mt-3 rounded-xl border kb-border-accent kb-surface-accent px-3 py-3 text-[11px] kb-text-accent">
              project focus:{' '}
              <span className="font-semibold kb-text-primary">{selectedProject.name}</span>
              <span className="mx-2 kb-text-muted">·</span>
              <span className="font-mono kb-text-secondary">{selectedProject.project_id}</span>
              {selectedProjectManagement ? (
                <>
                  <span className="mx-2 kb-text-muted">·</span>
                  <span className="kb-text-primary">
                    {selectedProjectManagement.lineage.tasks.length} tasks /{' '}
                    {selectedProjectManagement.lineage.task_sessions.length} task sessions
                  </span>
                </>
              ) : null}
              <button
                type="button"
                onClick={() => setSelectedProjectId(null)}
                className="ml-3 rounded-lg border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
              >
                clear focus
              </button>
            </div>
          )}
          {selectedMission && (
            <div className="mt-3 rounded-xl border kb-border-accent kb-surface-accent px-3 py-3 text-[11px] kb-text-accent">
              mission focus:{' '}
              <span className="font-semibold kb-text-primary">{selectedMission.missionId}</span>
              <span className="mx-2 kb-text-muted">·</span>
              <span className="kb-text-primary">
                {buildMissionIntentSummary(data, selectedMission)}
              </span>
              <button
                type="button"
                onClick={() => setSelectedMissionId(null)}
                className="ml-3 rounded-lg border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
              >
                clear focus
              </button>
            </div>
          )}
          {selectedTrack && (
            <div className="mt-3 rounded-xl border kb-border-accent kb-surface-accent px-3 py-3 text-[11px] kb-text-accent">
              track focus:{' '}
              <span className="font-semibold kb-text-primary">{selectedTrack.name}</span>
              <span className="mx-2 kb-text-muted">·</span>
              <span className="font-mono kb-text-secondary">{selectedTrack.track_id}</span>
              <button
                type="button"
                onClick={() => setSelectedTrackId(null)}
                className="ml-3 rounded-lg border kb-border-subtle kb-surface-sunken px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
              >
                clear focus
              </button>
            </div>
          )}
          <div className="mt-3 rounded-xl border kb-status-warning-border kb-surface-raised-subtle px-3 py-3 text-[11px] leading-5 kb-text-secondary">
            Surfaces are the explainable boundary between people and agent execution. Chronos is the
            control surface: it should clarify mission flow, runtime risk, and intervention points
            before it offers controls.
          </div>
        </section>
      ) : null}

      {workspace === 'surface' ? (
        <div className="grid gap-4 md:grid-cols-4">
          <MetricCard
            icon={<ShieldAlert size={14} />}
            label={mt('chronos_attention_queue', 'Needs Attention')}
            value={String(attentionItems.length)}
            detail={mt(
              'chronos_attention_queue_detail',
              'Mission blockers, runtime incidents, and delivery exceptions'
            )}
          />
          <MetricCard
            icon={<Bot size={14} />}
            label="Runtime Governance"
            value={`${data.runtimeDoctor.length}/${data.runtimeLeases.length}`}
            detail={`ready=${data.runtime.ready} busy=${data.runtime.busy} error=${data.runtime.error}`}
          />
          <MetricCard
            icon={<Send size={14} />}
            label={mt('chronos_delivery_exceptions', 'Delivery Exceptions')}
            value={String(data.surfaceOutbox.slack + data.surfaceOutbox.chronos)}
            detail={mt(
              'chronos_delivery_exceptions_detail',
              'Outbox entries awaiting operator attention'
            )}
          />
          <MetricCard
            icon={<Brain size={14} />}
            label="Memory Promotion"
            value={String(memoryCandidateCount)}
            detail={
              nextAction ? `next: ${nextAction.reason}` : 'No immediate memory action recommended'
            }
          />
        </div>
      ) : null}

      {workspace === 'surface' && !focusedView ? (
        <SurfaceStatusPanel
          eyebrow="Active Surface"
          title="Select a mission or task to open its focused surface"
          detail="Active Surface is intentionally limited to the current task context. Use Missions, Work Items, or Operations to choose what to inspect."
          tone="info"
        />
      ) : null}

      <section className="grid gap-4">
        <Panel
          id="next-actions"
          visible={panelVisible('next-actions')}
          title="Recommended Next Actions"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            These actions are generated from current control-plane state. Execute only what is
            necessary to unblock mission flow.
          </div>
          <div className="mb-4 rounded-xl border kb-border-accent kb-surface-accent px-4 py-3 text-[10px] leading-5 kb-text-accent">
            mission seed assessment: eligible{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.eligible ?? 0}
            </span>
            {' · '}
            flagged{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.flagged ?? 0}
            </span>
            {' · '}
            promotable{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.promotable ?? 0}
            </span>
          </div>
          <div className="space-y-3">
            {nextActions.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                No immediate next actions recommended.
              </div>
            ) : (
              nextActions.map((action) => (
                <div
                  key={action.action_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                      {action.action_id}
                    </div>
                    <div className="rounded-full kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-accent">
                      {action.next_action_type}
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] kb-text-secondary">{action.reason}</div>
                  <div className="mt-2 text-[10px] kb-text-muted">
                    risk: <span className="font-mono kb-text-secondary">{action.risk}</span>
                    <span className="mx-2 kb-text-muted">·</span>
                    approval required:{' '}
                    <span className="font-mono kb-text-secondary">
                      {action.approval_required ? 'yes' : 'no'}
                    </span>
                  </div>
                  {resolveNextActionRoute(action) ? (
                    <div className="mt-1 text-[10px] kb-text-muted">
                      route:{' '}
                      <span className="font-mono kb-text-secondary">
                        {resolveNextActionRoute(action)?.label}
                      </span>
                    </div>
                  ) : null}
                  {action.suggested_command ? (
                    <div className="mt-1 text-[10px] kb-text-muted">
                      command:{' '}
                      <span className="font-mono kb-text-secondary">
                        {action.suggested_command}
                      </span>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {resolveNextActionRoute(action) ? (
                      <button
                        type="button"
                        onClick={() => jumpToNextActionRoute(action)}
                        className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
                      >
                        jump
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => runNextAction(action)}
                      disabled={nextActionTarget === action.action_id}
                      className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {nextActionTarget === action.action_id
                        ? mt('chronos_processing', 'processing')
                        : 'execute'}
                    </button>
                    {action.action_id === 'chronos-promote-memory' ? (
                      <button
                        type="button"
                        onClick={() => runMemoryPromotion(true)}
                        disabled={memoryPromotionTarget !== null}
                        className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {memoryPromotionTarget === 'dry-run'
                          ? mt('chronos_processing', 'processing')
                          : 'dry-run'}
                      </button>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="needs-attention"
          visible={panelVisible('needs-attention')}
          title="Needs Attention"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Start here. These are the items most likely to block mission progress or degrade
            operator trust. Use the action only when the control plane does not self-heal.
          </div>
          <div className="grid gap-3 lg:grid-cols-[1.15fr,0.85fr]">
            <div className="space-y-3">
              {attentionItems.length === 0 ? (
                <div className="rounded-xl border kb-status-positive-border kb-status-positive-surface px-4 py-3 text-[11px] kb-status-positive">
                  No immediate operator intervention is recommended. Stay in observe mode and use
                  A2UI drill-downs for detail.
                </div>
              ) : (
                attentionItems.map((item) => (
                  <div
                    key={item.id}
                    className={`rounded-xl border px-4 py-3 ${
                      item.tone === 'critical'
                        ? 'kb-status-negative-border kb-status-negative-surface'
                        : item.tone === 'warning'
                          ? 'kb-status-warning-border kb-status-warning-surface'
                          : 'kb-border-accent kb-surface-accent'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                        {item.tone === 'critical'
                          ? 'critical'
                          : item.tone === 'warning'
                            ? 'warning'
                            : 'info'}
                      </div>
                      <div className="text-[10px] font-mono kb-text-muted">{item.title}</div>
                    </div>
                    <div className="mt-2 text-[11px] kb-text-secondary">{item.reason}</div>
                    {item.actionLabel && (
                      <button
                        type="button"
                        onClick={() => runAttentionAction(item)}
                        className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
                      >
                        {item.actionLabel}
                      </button>
                    )}
                  </div>
                ))
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-1">
              <MiniSummaryCard
                icon={<GitBranch size={13} />}
                label="Work needing attention"
                value={missionExceptions.length}
                detail="Requests or missions that need operator attention"
              />
              <MiniSummaryCard
                icon={<Bot size={13} />}
                label="Runtime incidents"
                value={data.runtimeDoctor.length}
                detail="Leases or runtimes flagged by doctor"
              />
              <MiniSummaryCard
                icon={<Radar size={13} />}
                label="Surface incidents"
                value={surfaceExceptions.length}
                detail="Managed surfaces needing review"
              />
              <MiniSummaryCard
                icon={<Send size={13} />}
                label="Delivery exceptions"
                value={deliveryExceptions.length}
                detail="Outbox entries or delivery residue"
              />
            </div>
          </div>
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.25fr,1fr,1fr]">
        <Panel
          id="mission-control-plane"
          visible={panelVisible('mission-control-plane')}
          title="Mission Control"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_mission_control_description',
              'Confirm which durable work items are active, which ones are blocked, and what the next safe intervention is. Pinning a mission narrows the unified thread below without leaving the operator console.'
            )}
          </div>
          {selectedProject &&
          filteredMissions.length === 0 &&
          selectedProjectBootstrapItems.length > 0 ? (
            <div className="mb-4 rounded-xl border kb-border-accent kb-surface-accent px-4 py-3 text-[11px] leading-5 kb-text-accent">
              {mt(
                'chronos_project_bootstrap_notice',
                'This project does not have active missions yet. Current bootstrap work:'
              )}
              <div className="mt-2 text-[10px] kb-text-accent">
                {selectedProjectBootstrapItems
                  .slice(0, 4)
                  .map((item) => `${item.title} [${item.status}]`)
                  .join(' -> ')}
              </div>
            </div>
          ) : null}
          <div className="space-y-3">
            {filteredMissions.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">No active missions.</div>
            ) : (
              filteredMissions.map((mission) => {
                const progress = data.missionProgress.find(
                  (entry) => entry.missionId === mission.missionId
                );
                const latestAsset = progress?.generatedAssets?.[0];
                const missionIntent = buildMissionIntentSummary(data, mission);
                const missionActions = getAvailableMissionActions(data, mission.missionId);
                const safeMissionActions = getActionsByRisk(missionActions, 'safe');
                const riskyMissionActions = getActionsByRisk(missionActions, 'risky');
                const safeDisabledReason = getSharedDisabledReason(safeMissionActions);
                const riskyDisabledReason = getSharedDisabledReason(riskyMissionActions);
                return (
                  <div
                    id={toDomId('mission', mission.missionId)}
                    key={mission.missionId}
                    className={`rounded-xl border kb-surface-sunken px-4 py-3 ${effectiveMissionId === mission.missionId ? 'kb-border-accent shadow-[0_0_0_1px_rgba(34,211,238,0.08)]' : 'kb-border-subtle'}`}
                  >
                    {(() => {
                      const latestAction = getLatestMissionControlAction(
                        data.controlActions,
                        mission.missionId
                      );
                      return latestAction ? (
                        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2">
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            latest intervention
                          </div>
                          <ActionStatusBadge action={latestAction} />
                        </div>
                      ) : null;
                    })()}
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[12px] font-semibold tracking-[0.03em] kb-text-primary">
                          {missionIntent}
                        </div>
                        <div className="mt-1 text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                          {mission.missionType || 'development'} · {mission.tier} ·{' '}
                          {mission.missionId}
                        </div>
                        {mission.projectId || mission.trackId ? (
                          <div className="mt-1 text-[10px] kb-text-muted">
                            {mission.projectId ? `project ${mission.projectId}` : null}
                            {mission.projectId && mission.trackId ? ' · ' : null}
                            {mission.trackId
                              ? `track ${mission.trackName || mission.trackId}`
                              : null}
                          </div>
                        ) : null}
                      </div>
                      <div
                        className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                          mission.planReady
                            ? 'kb-status-positive-surface kb-status-positive'
                            : 'kb-status-warning-surface kb-status-warning'
                        }`}
                      >
                        {mission.planReady ? 'plan ready' : mission.status}
                      </div>
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <div
                        className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${missionSummaryBadgeClass(mission.controlTone)}`}
                      >
                        {mission.controlSummary}
                      </div>
                      <div className="text-[10px] kb-text-muted">current state</div>
                      {mission.controlRequestedBy && (
                        <div className="text-[10px] kb-text-muted">
                          requested by{' '}
                          <span className="font-mono kb-text-secondary">
                            {mission.controlRequestedBy}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="mt-3 grid gap-2 text-[10px] kb-text-muted">
                      <div>
                        intent: <span className="kb-text-primary">{missionIntent}</span>
                      </div>
                      <div>
                        plan:{' '}
                        <span className="kb-text-primary">
                          {mission.planReady
                            ? 'ready to execute or continue'
                            : 'still being aligned'}
                        </span>
                      </div>
                      <div>
                        result:{' '}
                        <span className="kb-text-primary">
                          {latestAsset ? latestAsset.path.split('/').pop() : 'No artifact yet'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                      <div>
                        open work:{' '}
                        <span className="font-mono kb-text-primary">{mission.nextTaskCount}</span>
                      </div>
                      <div>
                        plan:{' '}
                        <span className="font-mono kb-text-primary">
                          {mission.planReady ? 'ready' : 'pending'}
                        </span>
                      </div>
                      <div>
                        results:{' '}
                        <span className="font-mono kb-text-primary">
                          {progress?.generatedAssets?.length ?? 0}
                        </span>
                      </div>
                      <div>
                        latest artifact:{' '}
                        <span className="font-mono kb-text-primary">
                          {latestAsset ? latestAsset.path.split('/').pop() : 'none'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => focusMissionThread(mission.missionId)}
                        className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                      >
                        <span className="inline-flex items-center gap-2">
                          <span>Thread</span>
                          <span className="rounded-full border kb-border-accent kb-surface-accent px-1.5 py-0.5 text-[8px] tracking-[0.18em] kb-text-accent">
                            T
                          </span>
                        </span>
                      </button>
                      <button
                        type="button"
                        onClick={() => focusMissionCard(mission.missionId)}
                        className="ml-2 rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised"
                      >
                        <span className="inline-flex items-center gap-2">
                          <span>Card</span>
                          <span className="rounded-full border kb-border-subtle kb-surface-raised/8 px-1.5 py-0.5 text-[8px] tracking-[0.18em] kb-text-secondary">
                            C
                          </span>
                        </span>
                      </button>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {(() => {
                        const latestAction = getLatestMissionControlAction(
                          data.controlActions,
                          mission.missionId
                        );
                        const retryAction = latestAction
                          ? getActionDefinition(missionActions, latestAction.operation)
                          : null;
                        if (!latestAction?.event_id) return null;
                        return (
                          <>
                            <button
                              type="button"
                              onClick={() =>
                                setExpandedMissionCardActionId((current) =>
                                  current === latestAction.event_id
                                    ? null
                                    : latestAction.event_id || null
                                )
                              }
                              className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                            >
                              {expandedMissionCardActionId === latestAction.event_id
                                ? 'hide latest action'
                                : 'show latest action'}
                            </button>
                            {latestAction.status === 'failed' && (
                              <button
                                type="button"
                                onClick={() =>
                                  runMissionControl(mission.missionId, latestAction.operation)
                                }
                                disabled={
                                  !retryAction?.enabled ||
                                  missionActionTarget ===
                                    `${mission.missionId}:${latestAction.operation}`
                                }
                                title={retryAction?.disabledReason}
                                className="rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-status-negative transition hover:kb-status-negative-surface disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {missionActionTarget ===
                                `${mission.missionId}:${latestAction.operation}`
                                  ? 'retrying'
                                  : 'retry latest action'}
                              </button>
                            )}
                          </>
                        );
                      })()}
                      <div className="flex flex-wrap gap-2 rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-2">
                        <div className="w-full text-[9px] uppercase tracking-[0.18em] kb-status-positive">
                          safe actions
                        </div>
                        {safeMissionActions.map((action) => (
                          <button
                            key={action.operation}
                            type="button"
                            onClick={() => runMissionControl(mission.missionId, action.operation)}
                            disabled={
                              !action.enabled ||
                              missionActionTarget === `${mission.missionId}:${action.operation}`
                            }
                            title={action.disabledReason}
                            className={actionButtonClass('safe')}
                          >
                            {missionActionTarget === `${mission.missionId}:${action.operation}`
                              ? 'working'
                              : action.label}
                          </button>
                        ))}
                        {safeDisabledReason && (
                          <div className="w-full text-[10px] kb-text-muted">
                            {safeDisabledReason}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-2">
                        <div className="w-full text-[9px] uppercase tracking-[0.18em] kb-status-negative">
                          risky actions · approval required
                        </div>
                        {riskyMissionActions.map((action) => (
                          <button
                            key={action.operation}
                            type="button"
                            onClick={() => {
                              const prompt = buildDangerousActionPrompt(
                                `mission ${mission.missionId}`,
                                action.label,
                                false
                              );
                              requestDangerousAction(
                                prompt.title,
                                prompt.detail,
                                prompt.confirmLabel,
                                () => runMissionControl(mission.missionId, action.operation)
                              );
                            }}
                            disabled={
                              !action.enabled ||
                              missionActionTarget === `${mission.missionId}:${action.operation}`
                            }
                            title={action.disabledReason}
                            className={actionButtonClass('risky')}
                          >
                            {missionActionTarget === `${mission.missionId}:${action.operation}`
                              ? 'working'
                              : action.label}
                          </button>
                        ))}
                        {riskyDisabledReason && (
                          <div className="w-full text-[10px] kb-text-muted">
                            {riskyDisabledReason}
                          </div>
                        )}
                      </div>
                    </div>
                    {(() => {
                      const latestAction = getLatestMissionControlAction(
                        data.controlActions,
                        mission.missionId
                      );
                      return latestAction?.event_id &&
                        expandedMissionCardActionId === latestAction.event_id ? (
                        <>
                          <ActionDetailList
                            actionId={latestAction.event_id}
                            details={data.controlActionDetails}
                          />
                          <ActionGuidance
                            latestAction={latestAction}
                            availableActions={missionActions}
                          />
                        </>
                      ) : null;
                    })()}
                  </div>
                );
              })
            )}
          </div>
        </Panel>

        <Panel
          id="runtime-topology-map"
          visible={panelVisible('runtime-topology-map')}
          title="Runtime Topology Map"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            This map shows what the supervisor daemon is currently holding: who owns each runtime,
            which runtimes are active, and which agent-to-agent or owner-to-agent flows were seen
            recently.
          </div>
          <div className="grid gap-3">
            <div className="grid gap-3 lg:grid-cols-[0.9fr,1.1fr]">
              <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div className="mb-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                  owners
                </div>
                <div className="space-y-2">
                  {data.runtimeTopology.owners.length === 0 ? (
                    <SurfaceStatusPanel
                      eyebrow="Owners"
                      title="No managed owners discovered"
                      detail="Owner records appear once runtimes are bound to a mission or surface."
                      tone="neutral"
                    />
                  ) : (
                    data.runtimeTopology.owners.map((owner) => (
                      <div
                        key={`${owner.type}:${owner.id}`}
                        className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2"
                      >
                        <div className="text-[10px] font-mono kb-text-secondary">{owner.id}</div>
                        <div className="mt-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                          {owner.type} · runtimes {owner.runtimeCount}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {owner.runtimeIds.map((runtimeId) => (
                            <span
                              key={runtimeId}
                              className="rounded-full border kb-border-subtle kb-surface-sunken px-2 py-1 text-[9px] font-mono kb-text-muted"
                            >
                              {runtimeId}
                            </span>
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
              <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
                <div className="mb-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                  managed runtimes
                </div>
                <div className="space-y-2">
                  {data.runtimeTopology.runtimes.length === 0 ? (
                    <SurfaceStatusPanel
                      eyebrow="Managed runtimes"
                      title="No managed runtimes discovered"
                      detail="Runtime records appear after an agent or surface registers with the control plane."
                      tone="neutral"
                    />
                  ) : (
                    data.runtimeTopology.runtimes.map((runtime) => (
                      <div
                        key={runtime.agentId}
                        className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2"
                      >
                        {(() => {
                          const resolution = providerResolutionSummary(runtime.metadata);
                          return (
                            <>
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-[10px] font-mono kb-text-primary">
                                  {runtime.agentId}
                                </div>
                                <div
                                  className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.18em] ${
                                    runtime.status === 'ready'
                                      ? 'kb-status-positive-surface kb-status-positive'
                                      : runtime.status === 'busy'
                                        ? 'kb-status-warning-surface kb-status-warning'
                                        : runtime.status === 'error'
                                          ? 'kb-status-negative-surface kb-status-negative'
                                          : 'kb-surface-raised kb-text-secondary'
                                  }`}
                                >
                                  {runtime.status}
                                </div>
                              </div>
                              <div className="mt-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                                {runtime.provider}
                                {runtime.modelId ? `/${runtime.modelId}` : ''} · {runtime.ownerType}
                                :{runtime.ownerId}
                              </div>
                              {resolution ? (
                                <div className="mt-1 text-[9px] kb-text-muted">
                                  preferred {resolution.preferred} · strategy {resolution.strategy}
                                </div>
                              ) : null}
                              <div className="mt-2 flex flex-wrap gap-2 text-[9px] kb-text-muted">
                                {runtime.leaseKind && <span>lease {runtime.leaseKind}</span>}
                                {runtime.requestedBy && (
                                  <span>requested by {runtime.requestedBy}</span>
                                )}
                                {typeof runtime.pid === 'number' && <span>pid {runtime.pid}</span>}
                                <span>activity {runtime.recentActivityCount}</span>
                              </div>
                            </>
                          );
                        })()}
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
            <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                recent flow
              </div>
              <div className="space-y-2">
                {data.runtimeTopology.flows.length === 0 ? (
                  <div className="text-[10px] kb-text-muted">
                    No recent A2A or agent-message flow observed.
                  </div>
                ) : (
                  data.runtimeTopology.flows.map((flow) => (
                    <div
                      key={flow.id}
                      className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] font-mono kb-text-primary">
                          {flow.from} → {flow.to}
                        </div>
                        <div className="text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                          {flow.kind}
                        </div>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[9px] kb-text-muted">
                        <span>count {flow.count}</span>
                        {flow.channel && <span>channel {flow.channel}</span>}
                        {flow.thread && <span>thread {flow.thread}</span>}
                        <span>
                          {new Date(flow.latestAt).toLocaleTimeString(chronosSpeechLocale())}
                        </span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </Panel>

        <Panel
          id="runtime-lease-doctor"
          visible={panelVisible('runtime-lease-doctor')}
          title="Runtime Governance"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Managed runtimes are part of operations, not a separate playground. Use this section to
            resolve stale leases, errored runtimes, and ownership drift without over-restarting
            healthy agents.
          </div>
          <div className="space-y-3">
            {data.runtimeDoctor.length === 0 ? (
              <div className="text-[11px] italic kb-status-positive">
                No stale or orphaned runtime leases detected.
              </div>
            ) : (
              data.runtimeDoctor.map((finding, index) => (
                <div
                  key={`${finding.agentId}-${index}`}
                  className={`rounded-xl border px-3 py-3 ${
                    finding.severity === 'critical'
                      ? 'kb-status-negative-border kb-status-negative-surface'
                      : 'kb-status-warning-border kb-status-warning-surface'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.18em]">
                    <span
                      className={
                        finding.severity === 'critical' ? 'kb-status-negative' : 'kb-status-warning'
                      }
                    >
                      {finding.severity}
                    </span>
                    <span className="font-mono kb-text-muted">{finding.agentId}</span>
                  </div>
                  <div className="mt-2 text-[10px] kb-text-secondary">owner: {finding.ownerId}</div>
                  <div className="mt-1 text-[10px] kb-text-muted">{finding.reason}</div>
                  <button
                    type="button"
                    onClick={() => {
                      const prompt = buildDangerousActionPrompt(
                        finding.agentId,
                        finding.recommendedAction === 'restart_runtime'
                          ? 'restart runtime'
                          : 'stop runtime',
                        false
                      );
                      requestDangerousAction(prompt.title, prompt.detail, prompt.confirmLabel, () =>
                        remediateLease(
                          finding.agentId,
                          finding.recommendedAction === 'restart_runtime'
                            ? 'restart_runtime_lease'
                            : 'cleanup_runtime_lease'
                        )
                      );
                    }}
                    disabled={remediationTarget === finding.agentId}
                    className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {remediationTarget === finding.agentId
                      ? 'remediating'
                      : finding.recommendedAction === 'restart_runtime'
                        ? 'restart runtime'
                        : 'stop runtime'}
                  </button>
                </div>
              ))
            )}

            <div className="border-t kb-border-subtle pt-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                Managed Runtime Leases
              </div>
              <div className="space-y-2">
                {data.runtimeLeases.slice(0, 6).map((lease) => (
                  <div
                    key={`${lease.agent_id}-${lease.owner_id}`}
                    className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-2"
                  >
                    <div className="text-[10px] font-mono kb-text-secondary">{lease.agent_id}</div>
                    <div className="mt-1 text-[10px] kb-text-muted">
                      {lease.owner_type}: {lease.owner_id}
                    </div>
                    {typeof lease.metadata?.team_role === 'string' && (
                      <div className="mt-1 text-[10px] kb-text-muted">
                        team_role: {lease.metadata.team_role}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>

        <Panel
          id="recent-surface-outbox"
          visible={panelVisible('recent-surface-outbox')}
          title="Delivery Exceptions"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Outbox items are operator-facing delivery residue. Resolve them here only when the
            autonomous path has already stalled or a human-visible queue needs cleanup.
          </div>
          <div className="space-y-3">
            {data.recentSurfaceOutbox.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt(
                  'chronos_no_recent_surface_outbox',
                  'No pending or recent surface outbox messages.'
                )}
              </div>
            ) : (
              data.recentSurfaceOutbox.map((message) => (
                <div
                  key={message.message_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                      {message.surface} · {message.source} · {message.channel}
                    </div>
                    <div className="text-[9px] font-mono kb-text-muted">
                      {new Date(message.created_at).toLocaleString(chronosSpeechLocale())}
                    </div>
                  </div>
                  <div className="mt-2 text-[9px] uppercase tracking-[0.18em] kb-text-muted">
                    {mt('chronos_correlation', 'correlation')}: {message.correlation_id}
                  </div>
                  <div className="mt-2 text-[11px] kb-text-primary">{message.text}</div>
                  <button
                    type="button"
                    onClick={() => {
                      const prompt = buildDangerousActionPrompt(
                        `${message.surface} outbox`,
                        'clear outbox',
                        false
                      );
                      requestDangerousAction(prompt.title, prompt.detail, prompt.confirmLabel, () =>
                        clearOutboxMessage(message.surface, message.message_id)
                      );
                    }}
                    disabled={outboxTarget === message.message_id}
                    className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {outboxTarget === message.message_id
                      ? mt('chronos_clearing', 'clearing')
                      : mt('chronos_clear_outbox', 'clear outbox')}
                  </button>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="projects"
          visible={panelVisible('projects')}
          title={mt('chronos_projects', 'Projects')}
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_projects_description',
              'Projects hold the long-lived intent context. Use this panel to see which durable work, bindings, and results already have a parent container before creating new missions.'
            )}
          </div>
          <div className="space-y-3">
            {data.projects.length === 0 ? (
              <SurfaceStatusPanel
                eyebrow="Projects"
                title="No projects registered yet"
                detail="Create the first project to anchor durable intent, bindings, and bootstrap work."
                tone="warning"
              />
            ) : (
              data.projects.map((project) => (
                <div
                  key={project.project_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  {(() => {
                    const learnedRefs = learnedProjectRefs(project.project_id);
                    const workLoop = buildProjectWorkLoopPreview(project);
                    const management = (data.projectManagement || []).find(
                      (item) => item.project.project_id === project.project_id
                    );
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                              {project.name}
                            </div>
                            <div className="mt-1 text-[10px] kb-text-muted">
                              {project.project_id} · {project.tier}
                            </div>
                          </div>
                          <div
                            className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                              project.status === 'active'
                                ? 'kb-status-positive-surface kb-status-positive'
                                : project.status === 'draft'
                                  ? 'kb-surface-accent kb-text-accent'
                                  : 'kb-surface-raised kb-text-secondary'
                            }`}
                          >
                            {project.status}
                          </div>
                        </div>
                        <div className="mt-3 text-[10px] kb-text-secondary">{project.summary}</div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                          <div>
                            {mt('chronos_missions', 'missions')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {project.active_missions?.length ?? 0}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_bindings', 'bindings')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {project.service_bindings?.length ?? 0}
                            </span>
                          </div>
                        </div>
                        {project.bootstrap_work_items?.length ? (
                          <div className="mt-3 text-[10px] kb-text-muted">
                            {mt('chronos_next_work', 'next work')}:{' '}
                            {project.bootstrap_work_items
                              .slice(0, 3)
                              .map((item) => item.title)
                              .join(' -> ')}
                          </div>
                        ) : null}
                        {project.kickoff_task_session_id ? (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            {mt('chronos_kickoff', 'kickoff')}:{' '}
                            <span className="font-mono kb-text-secondary">
                              {project.kickoff_task_session_id}
                            </span>
                          </div>
                        ) : null}
                        {management ? (
                          <div className="mt-3 rounded-lg border kb-border-accent kb-surface-accent px-3 py-3 text-[10px] kb-text-muted">
                            <div className="text-[10px] uppercase tracking-[0.18em] kb-text-accent">
                              {mt('chronos_project_lineage', 'project lineage')}
                            </div>
                            <div className="mt-2 kb-text-primary">
                              {mt(
                                'chronos_project_hierarchy',
                                'Project → Track → Mission → Task / Task Session'
                              )}
                            </div>
                            <div className="mt-1">
                              {mt('chronos_lineage_counts', 'counts')}:{' '}
                              {management.lineage.tracks.length} {mt('chronos_tracks', 'tracks')} ·{' '}
                              {management.lineage.tasks.length} {mt('chronos_tasks', 'tasks')} ·{' '}
                              {management.lineage.missions.length}{' '}
                              {mt('chronos_missions', 'missions')} ·{' '}
                              {management.lineage.task_sessions.length}{' '}
                              {mt('chronos_task_sessions', 'task sessions')} ·{' '}
                              {management.lineage.pipelines.length}{' '}
                              {mt('chronos_pipelines', 'pipelines')}
                            </div>
                            <div className="mt-1">
                              {mt(
                                'chronos_pipeline_role',
                                'Pipeline is a replayable execution procedure, not a parent container.'
                              )}
                            </div>
                          </div>
                        ) : null}
                        <div className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-3 text-[10px] kb-text-muted">
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="kb-text-primary">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="kb-text-primary">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono kb-text-primary">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="kb-text-primary">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="kb-text-primary">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="kb-text-primary">{workLoop.authority}</span>
                          </div>
                        </div>
                        {learnedRefs.length ? (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            {mt('chronos_learned', 'learned')}:{' '}
                            <span className="kb-text-secondary">
                              {learnedRefs.map((candidate) => candidate.title).join(', ')}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3">
                          <button
                            type="button"
                            onClick={() => {
                              setSelectedProjectId(project.project_id);
                              setSelectedMissionId(
                                (project.active_missions && project.active_missions[0]) || null
                              );
                              setMessageMissionFilter(
                                (project.active_missions && project.active_missions[0]) || 'all'
                              );
                            }}
                            className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                          >
                            {selectedProjectId === project.project_id
                              ? mt('chronos_focused', 'focused')
                              : mt('chronos_focus_project', 'focus project')}
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel id="tracks" visible={panelVisible('tracks')} title={mt('chronos_tracks', 'Tracks')}>
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_tracks_description',
              'Tracks are the SDLC and gating lanes inside a project. Focus a track to review evidence, approvals, and durable work without assuming one project equals one lifecycle.'
            )}
          </div>
          <div className="space-y-3">
            {hydratedTracks.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt('chronos_no_tracks', 'No tracks registered yet.')}
              </div>
            ) : (
              hydratedTracks.map((track) => (
                <div
                  key={track.track_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                        {track.name}
                      </div>
                      <div className="mt-1 text-[10px] kb-text-muted">
                        {track.track_id} · {track.track_type} · {track.lifecycle_model}
                      </div>
                    </div>
                    <div className="rounded-full kb-surface-raised px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-secondary">
                      {track.status}
                    </div>
                  </div>
                  <div className="mt-3 text-[10px] kb-text-secondary">{track.summary}</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                    <div>
                      {mt('chronos_project', 'project')}:{' '}
                      <span className="font-mono kb-text-primary">{track.project_id}</span>
                    </div>
                    <div>
                      {mt('chronos_required_artifacts', 'required artifacts')}:{' '}
                      <span className="font-mono kb-text-primary">
                        {track.required_artifacts?.length ?? 0}
                      </span>
                    </div>
                    {track.gate_readiness ? (
                      <>
                        <div>
                          {mt('chronos_gate_readiness', 'gate readiness')}:{' '}
                          <span className="font-mono kb-text-primary">
                            {track.gate_readiness.ready_gate_count}/
                            {track.gate_readiness.total_gate_count}
                          </span>
                        </div>
                        <div>
                          {mt('chronos_current_gate', 'current gate')}:{' '}
                          <span className="font-mono kb-text-primary">
                            {track.gate_readiness.current_gate_id ||
                              (track.gate_readiness.ready ? 'ready' : '-')}
                          </span>
                        </div>
                      </>
                    ) : null}
                  </div>
                  {track.gate_readiness?.next_required_artifacts?.length ? (
                    <div className="mt-2 text-[10px] kb-text-muted">
                      {mt('chronos_next_required', 'next required')}:{' '}
                      <span className="font-mono kb-text-secondary">
                        {track.gate_readiness.next_required_artifacts
                          .map((artifact) => artifact.artifact_id)
                          .join(', ')}
                      </span>
                    </div>
                  ) : null}
                  {track.release_id ? (
                    <div className="mt-2 text-[10px] kb-text-muted">
                      release:{' '}
                      <span className="font-mono kb-text-secondary">{track.release_id}</span>
                    </div>
                  ) : null}
                  <div className="mt-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedTrackId(track.track_id)}
                        className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                      >
                        {selectedTrackId === track.track_id
                          ? mt('chronos_focused', 'focused')
                          : mt('chronos_focus_track', 'focus track')}
                      </button>
                      <button
                        type="button"
                        onClick={() =>
                          createTrackSeed(
                            track.track_id,
                            track.gate_readiness?.next_required_artifacts?.[0]?.artifact_id
                          )
                        }
                        disabled={
                          !track.gate_readiness?.next_required_artifacts?.length ||
                          trackSeedTarget === track.track_id
                        }
                        className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {trackSeedTarget === track.track_id
                          ? 'seeding'
                          : mt('chronos_seed_next_work', 'seed next work')}
                      </button>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="service-bindings"
          visible={panelVisible('service-bindings')}
          title={mt('chronos_service_bindings', 'Service Bindings')}
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_service_bindings_description',
              'Bindings define where Kyberion can read from or deliver to. This is the governed edge for GitHub, Slack, Drive, search, and other external systems.'
            )}
          </div>
          <div className="space-y-3">
            {filteredServiceBindings.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                No service bindings registered yet.
              </div>
            ) : (
              filteredServiceBindings.slice(0, 8).map((binding) => (
                <div
                  key={binding.binding_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                      {binding.binding_id}
                    </div>
                    <div className="rounded-full kb-surface-raised px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-secondary">
                      {binding.auth_mode || 'none'}
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] kb-text-muted">
                    {binding.service_type} · {binding.scope} · {binding.target}
                  </div>
                  <div className="mt-2 text-[10px] kb-text-muted">
                    actions:{' '}
                    <span className="kb-text-secondary">
                      {binding.allowed_actions.slice(0, 4).join(', ') || 'none'}
                    </span>
                    {binding.allowed_actions.length > 4 ? (
                      <span className="kb-text-muted"> +{binding.allowed_actions.length - 4}</span>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel id="mission-seeds" visible={panelVisible('mission-seeds')} title="Mission Seeds">
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Proposed durable work can stay here before it becomes a full mission. Use this panel to
            confirm bootstrap output is structured and attributable.
          </div>
          <div className="mb-4 rounded-xl border kb-border-accent kb-surface-accent px-4 py-3 text-[10px] leading-5 kb-text-accent">
            assessment: eligible{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.eligible ?? 0}
            </span>
            {' · '}
            flagged{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.flagged ?? 0}
            </span>
            {' · '}
            unassessed{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.unassessed ?? 0}
            </span>
            {' · '}
            promotable{' '}
            <span className="font-mono kb-text-accent">
              {data.missionSeedAssessment?.promotable ?? 0}
            </span>
          </div>
          <div className="space-y-3">
            {filteredMissionSeedsByTrack.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                No mission seeds recorded yet.
              </div>
            ) : (
              filteredMissionSeedsByTrack.slice(0, 8).map((seed) => (
                <div
                  key={seed.seed_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  {(() => {
                    const learnedRefs = learnedMissionSeedRefs(
                      seed.seed_id,
                      seed.project_id,
                      seed.promoted_mission_id
                    );
                    const workLoop = buildMissionSeedWorkLoopPreview(seed);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                            {seed.title}
                          </div>
                          <div className="rounded-full kb-surface-raised px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-secondary">
                            {seed.status}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] kb-text-secondary">{seed.summary}</div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                          <div>
                            project:{' '}
                            <span className="font-mono kb-text-primary">{seed.project_id}</span>
                          </div>
                          <div>
                            specialist:{' '}
                            <span className="font-mono kb-text-primary">{seed.specialist_id}</span>
                          </div>
                          <div>
                            work:{' '}
                            <span className="font-mono kb-text-primary">
                              {seed.source_work_id || '-'}
                            </span>
                          </div>
                          <div>
                            type:{' '}
                            <span className="font-mono kb-text-primary">
                              {seed.mission_type_hint || '-'}
                            </span>
                          </div>
                        </div>
                        {typeof seed.metadata?.template_ref === 'string' ? (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            template:{' '}
                            <button
                              type="button"
                              onClick={() =>
                                openKnowledgeReference(seed.metadata?.template_ref as string)
                              }
                              className="font-mono kb-text-accent transition hover:kb-text-accent"
                            >
                              {seed.metadata.template_ref}
                            </button>
                          </div>
                        ) : null}
                        {typeof seed.metadata?.skeleton_path === 'string' ? (
                          <div className="mt-1 text-[10px] kb-text-muted">
                            skeleton:{' '}
                            <button
                              type="button"
                              onClick={() =>
                                openRuntimeReference(seed.metadata?.skeleton_path as string)
                              }
                              className="font-mono kb-text-accent transition hover:kb-text-accent"
                            >
                              {seed.metadata.skeleton_path}
                            </button>
                          </div>
                        ) : null}
                        {seed.promoted_mission_id ? (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            mission:{' '}
                            <span className="font-mono kb-text-secondary">
                              {seed.promoted_mission_id}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-3 text-[10px] kb-text-muted">
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="kb-text-primary">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="kb-text-primary">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono kb-text-primary">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="kb-text-primary">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="kb-text-primary">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="kb-text-primary">{workLoop.authority}</span>
                          </div>
                        </div>
                        {learnedRefs.length ? (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            {mt('chronos_learned', 'learned')}:{' '}
                            <span className="kb-text-secondary">
                              {learnedRefs.map((candidate) => candidate.title).join(', ')}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => {
                              const prompt = buildDangerousActionPrompt(
                                `seed ${seed.seed_id}`,
                                'promote to mission',
                                false
                              );
                              requestDangerousAction(
                                prompt.title,
                                prompt.detail,
                                prompt.confirmLabel,
                                () => promoteMissionSeed(seed.seed_id)
                              );
                            }}
                            disabled={
                              seed.status === 'promoted' || missionSeedTarget === seed.seed_id
                            }
                            className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {missionSeedTarget === seed.seed_id
                              ? 'promoting'
                              : seed.status === 'promoted'
                                ? 'promoted'
                                : 'promote to mission'}
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="skeleton-detail"
          visible={panelVisible('skeleton-detail')}
          title={mt('chronos_skeleton_detail', 'Skeleton Detail')}
        >
          {!selectedReferencePath || !referenceDetail ? (
            <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
              {mt(
                'chronos_skeleton_detail_empty',
                'Select a track-generated skeleton to inspect its title, metadata, overview, and sections without leaving Chronos.'
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                    {referenceDetail.title || 'reference'}
                  </div>
                  <div className="font-mono text-[10px] kb-text-muted">
                    {selectedReferencePath.split('/').slice(-2).join('/')}
                  </div>
                </div>
                <div className="mt-2 text-[10px] kb-text-secondary">
                  {referenceDetail.summary || mt('chronos_no_summary', 'No summary available yet.')}
                </div>
                <div className="mt-2 text-[10px] kb-text-muted">
                  path: <span className="font-mono kb-text-secondary">{selectedReferencePath}</span>
                </div>
                <div className="mt-2 text-[10px]">
                  <a
                    className="kb-text-accent transition hover:kb-text-accent"
                    href={`${referenceDetail.endpoint}?path=${encodeURIComponent(selectedReferencePath)}`}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {referenceDetail.openLabel ||
                      mt('chronos_open_raw_skeleton', 'open raw skeleton')}
                  </a>
                </div>
                {selectedReferenceSeed ? (
                  <>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                      <div>
                        seed:{' '}
                        <span className="font-mono kb-text-secondary">
                          {selectedReferenceSeed.seed_id}
                        </span>
                      </div>
                      <div>
                        track:{' '}
                        <span className="font-mono kb-text-secondary">
                          {selectedReferenceSeed.track_name ||
                            selectedReferenceSeed.track_id ||
                            '-'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 flex flex-wrap gap-2">
                      {selectedReferenceSeed.track_id ? (
                        <button
                          type="button"
                          onClick={() => setSelectedTrackId(selectedReferenceSeed.track_id || null)}
                          className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                        >
                          {mt('chronos_focus_track', 'focus track')}
                        </button>
                      ) : null}
                      {typeof selectedReferenceSeed.metadata?.template_ref === 'string' &&
                      selectedReferenceSeed.metadata.template_ref !== selectedReferencePath ? (
                        <button
                          type="button"
                          onClick={() =>
                            openKnowledgeReference(
                              selectedReferenceSeed.metadata?.template_ref as string
                            )
                          }
                          className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent"
                        >
                          {mt('chronos_open_template', 'open template')}
                        </button>
                      ) : null}
                      {typeof selectedReferenceSeed.metadata?.skeleton_path === 'string' &&
                      selectedReferenceSeed.metadata.skeleton_path !== selectedReferencePath ? (
                        <button
                          type="button"
                          onClick={() =>
                            openRuntimeReference(
                              selectedReferenceSeed.metadata?.skeleton_path as string
                            )
                          }
                          className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent"
                        >
                          {mt('chronos_open_skeleton', 'open skeleton')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => {
                          const prompt = buildDangerousActionPrompt(
                            `seed ${selectedReferenceSeed.seed_id}`,
                            'promote to mission',
                            false
                          );
                          requestDangerousAction(
                            prompt.title,
                            prompt.detail,
                            prompt.confirmLabel,
                            () => promoteMissionSeed(selectedReferenceSeed.seed_id)
                          );
                        }}
                        disabled={
                          selectedReferenceSeed.status === 'promoted' ||
                          missionSeedTarget === selectedReferenceSeed.seed_id
                        }
                        className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-40"
                      >
                        {missionSeedTarget === selectedReferenceSeed.seed_id
                          ? mt('chronos_processing', 'processing')
                          : selectedReferenceSeed.status === 'promoted'
                            ? mt('chronos_promoted', 'promoted')
                            : mt('chronos_promote_to_mission', 'promote to mission')}
                      </button>
                    </div>
                  </>
                ) : null}
              </div>

              {referenceMetadataEntries.length ? (
                <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                    {mt('chronos_metadata', 'Metadata')}
                  </div>
                  <div className="mt-2 space-y-1">
                    {referenceMetadataEntries.map(([key, value]) => (
                      <div key={key} className="text-[10px] kb-text-muted">
                        <span className="font-mono kb-text-secondary">{key}</span>: {String(value)}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {referenceDetail.body ? (
                <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                    {mt('chronos_overview', 'Overview')}
                  </div>
                  <div className="mt-2 space-y-1">
                    {referenceDetail.body
                      .split('\n')
                      .filter((line) => line.trim())
                      .slice(0, 8)
                      .map((line, index) => (
                        <div key={`${line}-${index}`} className="text-[10px] kb-text-muted">
                          {line}
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}

              {referenceSections.map((section) => (
                <div
                  key={section.title}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                    {section.title || 'Section'}
                  </div>
                  <div className="mt-2 space-y-1">
                    {section.lines
                      .filter((line) => line.trim())
                      .slice(0, 12)
                      .map((line, index) => (
                        <div
                          key={`${section.title}-${index}`}
                          className="text-[10px] kb-text-muted"
                        >
                          {line}
                        </div>
                      ))}
                    {!section.lines.some((line) => line.trim()) ? (
                      <div className="text-[10px] kb-text-muted">
                        {mt('chronos_no_detail', 'No detail.')}
                      </div>
                    ) : null}
                  </div>
                </div>
              ))}
            </div>
          )}
        </Panel>
      </section>

      <section className="grid gap-4">
        <Panel
          id="approvals"
          visible={panelVisible('approvals')}
          title={mt('chronos_approvals', 'Approvals')}
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_approvals_description',
              'Approvals keep authority explicit. Review pending risky actions here before they cross a governed boundary.'
            )}
          </div>
          <div className="space-y-3">
            {filteredPendingApprovalsByTrack.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt('chronos_no_pending_approvals', 'No pending approvals.')}
              </div>
            ) : (
              filteredPendingApprovalsByTrack.map((approval) => (
                <div
                  key={approval.id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  {(() => {
                    const workLoop = buildApprovalWorkLoopPreview(approval);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                            {approval.title}
                          </div>
                          <div className="rounded-full kb-status-negative-surface px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-status-negative">
                            {approval.riskLevel}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] kb-text-secondary">{approval.summary}</div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                          <div>
                            {mt('chronos_channel', 'channel')}:{' '}
                            <span className="font-mono kb-text-primary">{approval.channel}</span>
                          </div>
                          <div>
                            {mt('chronos_kind', 'kind')}:{' '}
                            <span className="font-mono kb-text-primary">{approval.kind}</span>
                          </div>
                          <div>
                            {mt('chronos_service', 'service')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {approval.serviceId || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_mission', 'mission')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {approval.missionId || '-'}
                            </span>
                          </div>
                        </div>
                        {approval.pendingRoles.length > 0 ? (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            pending roles:{' '}
                            <span className="kb-text-secondary">
                              {approval.pendingRoles.join(', ')}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-3 text-[10px] kb-text-muted">
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="kb-text-primary">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="kb-text-primary">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono kb-text-primary">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="kb-text-primary">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="kb-text-primary">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="kb-text-primary">{workLoop.authority}</span>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => decideApproval(approval, 'approved')}
                            disabled={approvalTarget === approval.id}
                            className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {approvalTarget === approval.id
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_approve', 'approve')}
                          </button>
                          <button
                            type="button"
                            onClick={() => decideApproval(approval, 'rejected')}
                            disabled={approvalTarget === approval.id}
                            className="rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-negative transition hover:kb-status-negative-surface disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {approvalTarget === approval.id
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_reject', 'reject')}
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="recent-artifacts"
          visible={panelVisible('recent-artifacts')}
          title="Recent Artifacts"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Outcomes should stay attributable. This panel shows the latest recorded artifacts with
            their project, mission, task, and storage placement.
          </div>
          <div className="space-y-3">
            {filteredRecentArtifactsByTrack.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                No governed artifacts recorded yet.
              </div>
            ) : (
              filteredRecentArtifactsByTrack.map((artifact) => (
                <div
                  key={artifact.artifact_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  {(() => {
                    const workLoop = buildArtifactWorkLoopPreview(artifact);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                            {artifact.artifact_id}
                          </div>
                          <div className="rounded-full kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-accent">
                            {artifact.kind}
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                          <div>
                            project:{' '}
                            <span className="font-mono kb-text-primary">
                              {artifact.project_id || 'standalone'}
                            </span>
                          </div>
                          <div>
                            mission:{' '}
                            <span className="font-mono kb-text-primary">
                              {artifact.mission_id || '-'}
                            </span>
                          </div>
                          <div>
                            task:{' '}
                            <span className="font-mono kb-text-primary">
                              {artifact.task_session_id || '-'}
                            </span>
                          </div>
                          <div>
                            storage:{' '}
                            <span className="font-mono kb-text-primary">
                              {artifact.storage_class}
                            </span>
                          </div>
                        </div>
                        {(artifact.path || artifact.external_ref || artifact.preview_text) && (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            {artifact.preview_text ||
                              artifact.external_ref ||
                              artifact.path?.split('/').pop()}
                          </div>
                        )}
                        <div className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-3 text-[10px] kb-text-muted">
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="kb-text-primary">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="kb-text-primary">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono kb-text-primary">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="kb-text-primary">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="kb-text-primary">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="kb-text-primary">{workLoop.authority}</span>
                          </div>
                        </div>
                      </>
                    );
                  })()}
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="distill-candidates"
          visible={panelVisible('distill-candidates')}
          title={mt('chronos_distill_candidates', 'Distill Candidates')}
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            {mt(
              'chronos_distill_candidates_description',
              'Completed work can become reusable organizational memory. This queue highlights outcome-backed candidates that may be promoted into patterns, SOPs, or governed knowledge later.'
            )}
          </div>
          <div className="space-y-3">
            {filteredDistillCandidatesByTrack.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt('chronos_no_distill_candidates', 'No distill candidates recorded yet.')}
              </div>
            ) : (
              filteredDistillCandidatesByTrack.slice(0, 10).map((candidate) => (
                <div
                  key={candidate.candidate_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  {(() => {
                    const workLoop = buildDistillCandidateWorkLoopPreview(candidate);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                            {candidate.title}
                          </div>
                          <div className="rounded-full kb-status-info-surface px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-status-info">
                            {candidate.target_kind}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] kb-text-secondary">
                          {candidate.summary}
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                          <div>
                            {mt('chronos_source', 'source')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.source_type}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_project', 'project')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.project_id || 'standalone'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_mission', 'mission')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.mission_id || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_task', 'task')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.task_session_id || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_status', 'status')}:{' '}
                            <span className="font-mono kb-text-primary">{candidate.status}</span>
                          </div>
                          <div>
                            {mt('chronos_specialist', 'specialist')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.specialist_id || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_tier', 'tier')}:{' '}
                            <span className="font-mono kb-text-primary">
                              {candidate.tier || 'confidential'}
                            </span>
                          </div>
                        </div>
                        {candidate.artifact_ids && candidate.artifact_ids.length ? (
                          <div className="mt-2 text-[10px] kb-text-muted">
                            artifacts:{' '}
                            <span className="kb-text-secondary">
                              {candidate.artifact_ids.join(', ')}
                            </span>
                          </div>
                        ) : null}
                        {candidate.evidence_refs && candidate.evidence_refs.length ? (
                          <div className="mt-1 text-[10px] kb-text-muted">
                            evidence:{' '}
                            <span className="kb-text-secondary">
                              {candidate.evidence_refs.join(', ')}
                            </span>
                          </div>
                        ) : null}
                        {candidate.promoted_ref ? (
                          <div className="mt-1 text-[10px] kb-text-muted">
                            promoted ref:{' '}
                            <span className="font-mono kb-text-secondary">
                              {candidate.promoted_ref}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-3 text-[10px] kb-text-muted">
                          <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="kb-text-primary">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="kb-text-primary">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono kb-text-primary">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="kb-text-primary">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="kb-text-primary">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="kb-text-primary">{workLoop.authority}</span>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => decideDistillCandidate(candidate, 'promote')}
                            disabled={
                              candidate.status !== 'proposed' ||
                              distillCandidateTarget === candidate.candidate_id
                            }
                            className="rounded-lg border kb-status-info-border kb-status-info-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-info transition hover:kb-status-info-surface disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {distillCandidateTarget === candidate.candidate_id
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_promote', 'promote')}
                          </button>
                          <button
                            type="button"
                            onClick={() => decideDistillCandidate(candidate, 'archive')}
                            disabled={
                              candidate.status !== 'proposed' ||
                              distillCandidateTarget === candidate.candidate_id
                            }
                            className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {distillCandidateTarget === candidate.candidate_id
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_archive', 'archive')}
                          </button>
                        </div>
                      </>
                    );
                  })()}
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="memory-promotion-queue"
          visible={panelVisible('memory-promotion-queue')}
          title="Memory Promotion Queue"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Approved memory candidates can be promoted into governed knowledge in bulk. Run a
            dry-run first to inspect queue scope, then execute promotion.
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => runMemoryPromotion(true)}
              disabled={memoryPromotionTarget !== null}
              className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
            >
              {memoryPromotionTarget === 'dry-run'
                ? mt('chronos_processing', 'processing')
                : 'dry-run'}
            </button>
            <button
              type="button"
              onClick={() => runMemoryPromotion(false)}
              disabled={memoryPromotionTarget !== null}
              className="rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-status-positive transition hover:kb-status-positive-surface disabled:cursor-not-allowed disabled:opacity-40"
            >
              {memoryPromotionTarget === 'promote'
                ? mt('chronos_processing', 'processing')
                : 'promote approved'}
            </button>
          </div>
          <div className="space-y-3">
            {filteredMemoryCandidatesByTrack.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                No memory candidates queued.
              </div>
            ) : (
              filteredMemoryCandidatesByTrack.slice(0, 12).map((candidate) => (
                <div
                  key={candidate.candidate_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                      {candidate.candidate_id}
                    </div>
                    <div className="rounded-full kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.25em] kb-text-accent">
                      {candidate.status}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                    <div>
                      kind:{' '}
                      <span className="font-mono kb-text-primary">
                        {candidate.proposed_memory_kind}
                      </span>
                    </div>
                    <div>
                      tier:{' '}
                      <span className="font-mono kb-text-primary">
                        {candidate.sensitivity_tier}
                      </span>
                    </div>
                    <div className="col-span-2">
                      source:{' '}
                      <span className="font-mono kb-text-primary">{candidate.source_ref}</span>
                    </div>
                    <div className="col-span-2">
                      evidence:{' '}
                      <span className="kb-text-secondary">
                        {candidate.evidence_refs?.join(', ') || '-'}
                      </span>
                    </div>
                  </div>
                  {candidate.promoted_ref ? (
                    <div className="mt-2 text-[10px] kb-text-muted">
                      promoted ref:{' '}
                      <span className="font-mono kb-text-secondary">{candidate.promoted_ref}</span>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>

      <section className="grid gap-4">
        <Panel
          id="recent-control-actions"
          visible={panelVisible('recent-control-actions')}
          title="Recent Control Actions"
        >
          <div className="space-y-3">
            {data.controlActions.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                No recent mission or surface control actions.
              </div>
            ) : (
              data.controlActions.map((action, index) => (
                <div
                  key={`${action.event_id || action.ts}-${index}`}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                      {action.kind} · {action.operation}
                    </div>
                    <ActionStatusBadge action={action} />
                  </div>
                  <div className="mt-2 text-[11px] kb-text-primary">{action.target}</div>
                  <div className="mt-1 text-[10px] kb-text-muted">
                    requested_by:{' '}
                    <span className="font-mono kb-text-secondary">{action.requested_by}</span>
                  </div>
                  {action.event_id && (
                    <div className="mt-3 flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedActionId((current) =>
                            current === action.event_id ? null : action.event_id || null
                          )
                        }
                        className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-secondary transition hover:kb-surface-raised"
                      >
                        {expandedActionId === action.event_id ? 'hide details' : 'show details'}
                      </button>
                      {action.target !== 'surface-runtime' && (
                        <button
                          type="button"
                          onClick={() => jumpToTarget(action)}
                          className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.18em] kb-text-accent transition hover:kb-surface-accent"
                        >
                          jump to target
                        </button>
                      )}
                    </div>
                  )}
                  {action.event_id && expandedActionId === action.event_id && (
                    <ActionDetailList
                      actionId={action.event_id}
                      details={data.controlActionDetails}
                    />
                  )}
                  {action.error && (
                    <div className="mt-2 text-[10px] kb-status-negative">{action.error}</div>
                  )}
                  <div className="mt-2 text-[9px] font-mono kb-text-muted">
                    {new Date(action.ts).toLocaleString(chronosSpeechLocale())}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>
      <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
        <Panel
          id="orchestration-audit"
          visible={panelVisible('orchestration-audit')}
          title="Orchestration Audit"
        >
          <div className="space-y-3">
            {data.recentEvents.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                No orchestration events yet.
              </div>
            ) : (
              data.recentEvents.map((event, index) => (
                <div
                  key={`${event.ts}-${index}`}
                  className="border-l kb-status-warning-border pl-3"
                >
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                    <Activity size={10} />
                    <span>{event.decision}</span>
                  </div>
                  <div className="mt-1 text-[11px] kb-text-primary">
                    {event.mission_id || 'system'}
                  </div>
                  {event.why && <div className="mt-1 text-[10px] kb-text-muted">{event.why}</div>}
                  <div className="mt-1 text-[9px] font-mono kb-text-muted">
                    {new Date(event.ts).toLocaleString(chronosSpeechLocale())}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
        <Panel
          id="owner-summaries"
          visible={panelVisible('owner-summaries')}
          title="Owner Summaries"
        >
          <div className="space-y-3">
            {data.ownerSummaries.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">No owner summaries yet.</div>
            ) : (
              data.ownerSummaries.map((summary, index) => (
                <div
                  key={`${summary.mission_id}-${summary.ts}-${index}`}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                      {summary.mission_id}
                    </div>
                    <div className="text-[9px] font-mono kb-text-muted">
                      {new Date(summary.ts).toLocaleString(chronosSpeechLocale())}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-secondary">
                    <div>
                      accepted:{' '}
                      <span className="font-mono kb-text-primary">{summary.accepted_count}</span>
                    </div>
                    <div>
                      reviewed:{' '}
                      <span className="font-mono kb-text-primary">{summary.reviewed_count}</span>
                    </div>
                    <div>
                      completed:{' '}
                      <span className="font-mono kb-text-primary">{summary.completed_count}</span>
                    </div>
                    <div>
                      requested:{' '}
                      <span className="font-mono kb-text-primary">{summary.requested_count}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="runtime-summary"
          visible={panelVisible('runtime-summary')}
          title="Operator Summary"
        >
          <div className="mb-4 rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Keep the operator loop narrow: look at exceptions first, then mission readiness, then
            runtime and delivery counters. When these stay green, use quick actions to open governed
            A2UI drill-downs rather than adding more controls here.
          </div>
          <div className="grid grid-cols-2 gap-3">
            <RuntimeCell label="ready" value={data.runtime.ready} accent="emerald" />
            <RuntimeCell label="busy" value={data.runtime.busy} accent="gold" />
            <RuntimeCell label="error" value={data.runtime.error} accent="red" />
            <RuntimeCell label="leases" value={data.runtimeLeases.length} accent="cyan" />
            <RuntimeCell label="slack outbox" value={data.surfaceOutbox.slack} accent="gold" />
            <RuntimeCell label="chronos outbox" value={data.surfaceOutbox.chronos} accent="cyan" />
          </div>
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.15fr,0.85fr]">
        <Panel
          id="browser-sessions"
          visible={panelVisible('browser-sessions')}
          title="Browser Session Oversight"
        >
          <div className="space-y-3">
            {data.browserSessions.length === 0 ? (
              <SurfaceStatusPanel
                eyebrow="Browser Session Oversight"
                title="No browser sessions recorded yet"
                detail="Open a browser task or capture a session to populate the registry."
                tone="neutral"
              />
            ) : (
              data.browserSessions.map((session) => (
                <div
                  key={session.session_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                        {session.session_id}
                      </div>
                      <div className="mt-1 text-[10px] kb-text-muted">
                        active tab:{' '}
                        <span className="font-mono kb-text-secondary">{session.active_tab_id}</span>{' '}
                        · tabs:{' '}
                        <span className="font-mono kb-text-secondary">{session.tab_count}</span>
                      </div>
                    </div>
                    <div
                      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                        session.lease_status === 'active'
                          ? 'kb-surface-accent kb-text-accent'
                          : session.lease_status === 'expired'
                            ? 'kb-status-warning-surface kb-status-warning'
                            : 'kb-surface-raised kb-text-secondary'
                      }`}
                    >
                      {session.lease_status}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                    <div>
                      retained:{' '}
                      <span className="font-mono kb-text-primary">{String(session.retained)}</span>
                    </div>
                    <div>
                      trail:{' '}
                      <span className="font-mono kb-text-primary">
                        {session.action_trail_count}
                      </span>
                    </div>
                    <div>
                      updated:{' '}
                      <span className="font-mono kb-text-primary">
                        {new Date(session.updated_at).toLocaleTimeString(chronosSpeechLocale())}
                      </span>
                    </div>
                    <div>
                      lease expires:{' '}
                      <span className="font-mono kb-text-primary">
                        {session.lease_expires_at
                          ? new Date(session.lease_expires_at).toLocaleTimeString(
                              chronosSpeechLocale()
                            )
                          : 'n/a'}
                      </span>
                    </div>
                  </div>
                  {session.last_trace_path && (
                    <div className="mt-2 text-[10px] kb-text-muted">
                      trace:{' '}
                      <span className="font-mono kb-text-secondary">{session.last_trace_path}</span>
                    </div>
                  )}
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button
                      type="button"
                      onClick={() =>
                        runBrowserSessionControl(session.session_id, 'close_browser_session')
                      }
                      disabled={
                        browserSessionTarget === `${session.session_id}:close_browser_session` ||
                        session.lease_status !== 'active'
                      }
                      className="rounded-lg border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-secondary transition hover:kb-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {browserSessionTarget === `${session.session_id}:close_browser_session`
                        ? 'closing'
                        : 'close session'}
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        runBrowserSessionControl(session.session_id, 'restart_browser_session')
                      }
                      disabled={
                        browserSessionTarget === `${session.session_id}:restart_browser_session`
                      }
                      className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {browserSessionTarget === `${session.session_id}:restart_browser_session`
                        ? 'restarting'
                        : 'restart session'}
                    </button>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                      recent browser trail
                    </div>
                    {session.recent_actions.length === 0 ? (
                      <div className="text-[10px] kb-text-muted">No recorded browser actions.</div>
                    ) : (
                      session.recent_actions.map((action, index) => (
                        <div
                          key={`${session.session_id}-${action.ts}-${index}`}
                          className="rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                              {action.kind} · {action.op}
                            </div>
                            <div className="text-[9px] font-mono kb-text-muted">
                              {new Date(action.ts).toLocaleTimeString(chronosSpeechLocale())}
                            </div>
                          </div>
                          <div className="mt-1 text-[10px] kb-text-muted">
                            {action.tab_id && (
                              <span className="mr-2">
                                tab:{' '}
                                <span className="font-mono kb-text-secondary">{action.tab_id}</span>
                              </span>
                            )}
                            {action.ref && (
                              <span className="mr-2">
                                ref:{' '}
                                <span className="font-mono kb-text-secondary">{action.ref}</span>
                              </span>
                            )}
                            {action.selector && (
                              <span>
                                selector:{' '}
                                <span className="font-mono kb-text-muted">{action.selector}</span>
                              </span>
                            )}
                          </div>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel
          id="browser-guidance"
          visible={panelVisible('browser-guidance')}
          title="Browser Guidance"
        >
          <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3 text-[11px] leading-5 kb-text-muted">
            Browser sessions stay fast only while they are leased. Prefer `snapshot + ref`, then
            export recorded trails as Playwright specs in either strict or hint mode.
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3">
            <RuntimeCell
              label="browser sessions"
              value={data.browserSessions.length}
              accent="cyan"
            />
            <RuntimeCell
              label="active leases"
              value={
                data.browserSessions.filter((session) => session.lease_status === 'active').length
              }
              accent="emerald"
            />
            <RuntimeCell
              label="retained"
              value={data.browserSessions.filter((session) => session.retained).length}
              accent="gold"
            />
            <RuntimeCell
              label="expired"
              value={
                data.browserSessions.filter((session) => session.lease_status === 'expired').length
              }
              accent="red"
            />
          </div>
        </Panel>
        <Panel
          id="browser-conversation-sessions"
          visible={panelVisible('browser-conversation-sessions')}
          title="Browser Tasks"
        >
          <div className="space-y-3">
            {data.browserConversationSessions.length === 0 ? (
              <SurfaceStatusPanel
                eyebrow="Browser Tasks"
                title="No browser tasks recorded yet"
                detail="Start a task from the browser surface to capture guided confirmations and result state."
                tone="neutral"
              />
            ) : (
              data.browserConversationSessions.map((session) => (
                <div
                  key={session.session_id}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                        {session.session_id}
                      </div>
                      <div className="mt-1 text-[10px] kb-text-muted">
                        surface:{' '}
                        <span className="font-mono kb-text-secondary">{session.surface}</span> ·
                        mode: <span className="font-mono kb-text-secondary">{session.mode}</span>
                      </div>
                    </div>
                    <div
                      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                        session.status === 'completed'
                          ? 'kb-status-positive-surface kb-status-positive'
                          : session.status === 'awaiting_confirmation'
                            ? 'kb-status-warning-surface kb-status-warning'
                            : session.status === 'failed'
                              ? 'kb-status-negative-surface kb-status-negative'
                              : 'kb-surface-accent kb-text-accent'
                      }`}
                    >
                      {session.status}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] kb-text-muted">
                    <div>
                      intent:{' '}
                      <span className="kb-text-primary">{session.goal_summary || 'n/a'}</span>
                    </div>
                    <div>
                      current step:{' '}
                      <span className="kb-text-primary">{session.active_step || 'n/a'}</span>
                    </div>
                    <div>
                      waiting for confirmation:{' '}
                      <span className="font-mono kb-text-primary">
                        {String(session.pending_confirmation)}
                      </span>
                    </div>
                    <div>
                      available actions:{' '}
                      <span className="font-mono kb-text-primary">
                        {session.candidate_target_count}
                      </span>
                    </div>
                    <div>
                      updated:{' '}
                      <span className="font-mono kb-text-primary">
                        {new Date(session.updated_at).toLocaleTimeString(chronosSpeechLocale())}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>

      {!hideSurfaceControl || panelVisible('control-model') ? (
        <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
          {!hideSurfaceControl ? (
            <Panel
              id="surface-control"
              visible={panelVisible('surface-control')}
              title="Surface Control"
            >
              <div className="mb-3 flex flex-wrap gap-2">
                {(() => {
                  const latestAction = getGlobalSurfaceControlAction(data.controlActions);
                  const retryAction = latestAction
                    ? getActionDefinition(
                        data.controlActionAvailability.globalSurface,
                        latestAction.operation
                      )
                    : null;
                  return latestAction ? (
                    <>
                      <div className="mr-2 flex items-center rounded-lg border kb-border-subtle kb-surface-raised px-3 py-1.5 text-[10px] kb-text-muted">
                        {mt('chronos_surfaces', 'surfaces')}
                        <span className="ml-2">{latestAction.operation}</span>
                        <span className="ml-2">
                          <ActionStatusBadge action={latestAction} />
                        </span>
                      </div>
                      {latestAction.event_id && (
                        <button
                          type="button"
                          onClick={() =>
                            setExpandedGlobalSurfaceActionId((current) =>
                              current === latestAction.event_id
                                ? null
                                : latestAction.event_id || null
                            )
                          }
                          className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                        >
                          {expandedGlobalSurfaceActionId === latestAction.event_id
                            ? mt('chronos_hide_latest_action', 'hide latest action')
                            : mt('chronos_show_latest_action', 'show latest action')}
                        </button>
                      )}
                      {latestAction.status === 'failed' && (
                        <button
                          type="button"
                          onClick={() => runSurfaceControl(null, latestAction.operation)}
                          disabled={
                            !retryAction?.enabled ||
                            surfaceActionTarget === `all:${latestAction.operation}`
                          }
                          title={retryAction?.disabledReason}
                          className="rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-status-negative transition hover:kb-status-negative-surface disabled:cursor-not-allowed disabled:opacity-40"
                        >
                          {surfaceActionTarget === `all:${latestAction.operation}`
                            ? mt('chronos_retrying', 'retrying')
                            : mt('chronos_retry_latest_action', 'retry latest action')}
                        </button>
                      )}
                    </>
                  ) : null;
                })()}
                {data.controlActionAvailability.globalSurface.map((action) => (
                  <button
                    key={action.operation}
                    type="button"
                    onClick={() => runSurfaceControl(null, action.operation)}
                    disabled={!action.enabled || surfaceActionTarget === `all:${action.operation}`}
                    title={action.disabledReason}
                    className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    {surfaceActionTarget === `all:${action.operation}` ? 'working' : action.label}
                  </button>
                ))}
                {getSharedDisabledReason(data.controlActionAvailability.globalSurface) && (
                  <div className="w-full text-[10px] kb-text-muted">
                    {getSharedDisabledReason(data.controlActionAvailability.globalSurface)}
                  </div>
                )}
              </div>
              {(() => {
                const latestAction = getGlobalSurfaceControlAction(data.controlActions);
                return latestAction?.event_id &&
                  expandedGlobalSurfaceActionId === latestAction.event_id ? (
                  <div className="mb-3">
                    <ActionDetailList
                      actionId={latestAction.event_id}
                      details={data.controlActionDetails}
                    />
                    <ActionGuidance
                      latestAction={latestAction}
                      availableActions={data.controlActionAvailability.globalSurface}
                    />
                  </div>
                ) : null;
              })()}
              <div className="space-y-3">
                {data.surfaces.length === 0 ? (
                  <div className="text-[11px] italic kb-status-warning">
                    {mt('chronos_no_managed_surfaces', 'No managed surfaces.')}
                  </div>
                ) : (
                  data.surfaces.map((surface) => {
                    const surfaceActions = getAvailableSurfaceActions(data, surface.id);
                    const safeSurfaceActions = getActionsByRisk(surfaceActions, 'safe');
                    const riskySurfaceActions = getActionsByRisk(surfaceActions, 'risky');
                    const safeDisabledReason = getSharedDisabledReason(safeSurfaceActions);
                    const riskyDisabledReason = getSharedDisabledReason(riskySurfaceActions);
                    return (
                      <div
                        id={toDomId('surface', surface.id)}
                        key={surface.id}
                        className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                      >
                        {(() => {
                          const latestAction = getLatestSurfaceControlAction(
                            data.controlActions,
                            surface.id
                          );
                          return latestAction ? (
                            <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border kb-border-subtle kb-surface-raised px-3 py-2">
                              <div className="text-[10px] uppercase tracking-[0.18em] kb-text-muted">
                                {mt('chronos_last_control_action', 'last control action')}
                              </div>
                              <ActionStatusBadge action={latestAction} />
                            </div>
                          ) : null;
                        })()}
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-semibold tracking-[0.08em] kb-text-primary">
                              {surface.id}
                            </div>
                            <div className="mt-1 text-[10px] uppercase tracking-[0.2em] kb-text-muted">
                              {surface.kind} ·{' '}
                              {surface.startupMode || mt('chronos_background', 'background')} ·{' '}
                              {surface.running
                                ? mt('chronos_running', 'running')
                                : mt('chronos_stopped', 'stopped')}
                            </div>
                          </div>
                          <div
                            className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                              surface.health === 'healthy'
                                ? 'kb-status-positive-surface kb-status-positive'
                                : surface.health === 'unhealthy'
                                  ? 'kb-status-negative-surface kb-status-negative'
                                  : 'kb-status-warning-surface kb-status-warning'
                            }`}
                          >
                            {surface.health}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] kb-text-muted">
                          pid:{' '}
                          <span className="font-mono kb-text-secondary">{surface.pid ?? '-'}</span>
                          {surface.detail ? (
                            <>
                              {' '}
                              · {mt('chronos_detail', 'detail')}:{' '}
                              <span className="font-mono kb-text-secondary">{surface.detail}</span>
                            </>
                          ) : null}
                        </div>
                        <div className="mt-3 flex items-center gap-2">
                          <div
                            className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${surfaceSummaryBadgeClass(surface.controlTone)}`}
                          >
                            {surface.controlSummary}
                          </div>
                          <div className="text-[10px] kb-text-muted">
                            {mt('chronos_control_summary', 'control summary')}
                          </div>
                          {surface.controlRequestedBy && (
                            <div className="text-[10px] kb-text-muted">
                              {mt('chronos_requested_by', 'requested by')}{' '}
                              <span className="font-mono kb-text-secondary">
                                {surface.controlRequestedBy}
                              </span>
                            </div>
                          )}
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          {(() => {
                            const latestAction = getLatestSurfaceControlAction(
                              data.controlActions,
                              surface.id
                            );
                            const retryAction = latestAction
                              ? getActionDefinition(surfaceActions, latestAction.operation)
                              : null;
                            if (!latestAction?.event_id) return null;
                            return (
                              <>
                                <button
                                  type="button"
                                  onClick={() =>
                                    setExpandedSurfaceCardActionId((current) =>
                                      current === latestAction.event_id
                                        ? null
                                        : latestAction.event_id || null
                                    )
                                  }
                                  className="rounded-lg border kb-border-accent kb-surface-accent px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                                >
                                  {expandedSurfaceCardActionId === latestAction.event_id
                                    ? mt('chronos_hide_latest_action', 'hide latest action')
                                    : mt('chronos_show_latest_action', 'show latest action')}
                                </button>
                                {latestAction.status === 'failed' && (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      runSurfaceControl(surface.id, latestAction.operation)
                                    }
                                    disabled={
                                      !retryAction?.enabled ||
                                      surfaceActionTarget ===
                                        `${surface.id}:${latestAction.operation}`
                                    }
                                    title={retryAction?.disabledReason}
                                    className="rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-1 text-[10px] uppercase tracking-[0.16em] kb-status-negative transition hover:kb-status-negative-surface disabled:cursor-not-allowed disabled:opacity-40"
                                  >
                                    {surfaceActionTarget ===
                                    `${surface.id}:${latestAction.operation}`
                                      ? mt('chronos_retrying', 'retrying')
                                      : mt('chronos_retry_latest_action', 'retry latest action')}
                                  </button>
                                )}
                              </>
                            );
                          })()}
                          <div className="flex flex-wrap gap-2 rounded-lg border kb-status-positive-border kb-status-positive-surface px-2 py-2">
                            <div className="w-full text-[9px] uppercase tracking-[0.18em] kb-status-positive">
                              {mt('chronos_safe_actions', 'safe actions')}
                            </div>
                            {safeSurfaceActions.map((action) => (
                              <button
                                key={action.operation}
                                type="button"
                                onClick={() => runSurfaceControl(surface.id, action.operation)}
                                disabled={
                                  !action.enabled ||
                                  surfaceActionTarget === `${surface.id}:${action.operation}`
                                }
                                title={action.disabledReason}
                                className={actionButtonClass('safe')}
                              >
                                {surfaceActionTarget === `${surface.id}:${action.operation}`
                                  ? mt('chronos_working', 'working')
                                  : action.label}
                              </button>
                            ))}
                            {safeDisabledReason && (
                              <div className="w-full text-[10px] kb-text-muted">
                                {safeDisabledReason}
                              </div>
                            )}
                          </div>
                          <div className="flex flex-wrap gap-2 rounded-lg border kb-status-negative-border kb-status-negative-surface px-2 py-2">
                            <div className="w-full text-[9px] uppercase tracking-[0.18em] kb-status-negative">
                              {mt(
                                'chronos_risky_actions_approval_required',
                                'risky actions · approval required'
                              )}
                            </div>
                            {riskySurfaceActions.map((action) => (
                              <button
                                key={action.operation}
                                type="button"
                                onClick={() => {
                                  const prompt = buildDangerousActionPrompt(
                                    `surface ${surface.id}`,
                                    action.label,
                                    false
                                  );
                                  requestDangerousAction(
                                    prompt.title,
                                    prompt.detail,
                                    prompt.confirmLabel,
                                    () => runSurfaceControl(surface.id, action.operation)
                                  );
                                }}
                                disabled={
                                  !action.enabled ||
                                  surfaceActionTarget === `${surface.id}:${action.operation}`
                                }
                                title={action.disabledReason}
                                className={actionButtonClass('risky')}
                              >
                                {surfaceActionTarget === `${surface.id}:${action.operation}`
                                  ? mt('chronos_working', 'working')
                                  : action.label}
                              </button>
                            ))}
                            {riskyDisabledReason && (
                              <div className="w-full text-[10px] kb-text-muted">
                                {riskyDisabledReason}
                              </div>
                            )}
                          </div>
                        </div>
                        {(() => {
                          const latestAction = getLatestSurfaceControlAction(
                            data.controlActions,
                            surface.id
                          );
                          return latestAction?.event_id &&
                            expandedSurfaceCardActionId === latestAction.event_id ? (
                            <>
                              <ActionDetailList
                                actionId={latestAction.event_id}
                                details={data.controlActionDetails}
                              />
                              <ActionGuidance
                                latestAction={latestAction}
                                availableActions={surfaceActions}
                              />
                            </>
                          ) : null;
                        })()}
                      </div>
                    );
                  })
                )}
              </div>
            </Panel>
          ) : null}

          <Panel
            id="control-model"
            visible={panelVisible('control-model')}
            title={mt('chronos_control_model', 'Control Model')}
          >
            <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-4 text-[11px] leading-6 kb-text-muted">
              {mt(
                'chronos_control_model_description',
                'Chronos is a control surface. It does not mutate mission or runtime state directly. Each button issues a deterministic backend action through mission_controller, agent-runtime-supervisor, or surface_runtime, then refreshes the control-plane view.'
              )}
            </div>
          </Panel>
        </section>
      ) : null}

      <section className="grid gap-4">
        <Panel
          id="agent-traffic"
          visible={panelVisible('agent-traffic')}
          title={mt('chronos_live_agent_conversation', 'Agent Traffic')}
        >
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setMessageMissionFilter('all');
                setSelectedMissionId(null);
              }}
              className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em] transition ${
                messageMissionFilter === 'all'
                  ? 'kb-border-accent kb-surface-accent kb-text-accent'
                  : 'kb-border-subtle kb-surface-raised/5 kb-text-muted hover:kb-surface-raised'
              }`}
            >
              {mt('chronos_all_missions', 'all missions')}
            </button>
            {filteredMissions.map((mission) => (
              <button
                key={mission.missionId}
                type="button"
                onClick={() => {
                  setMessageMissionFilter(mission.missionId);
                  setSelectedMissionId(mission.missionId);
                }}
                className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em] transition ${
                  messageMissionFilter === mission.missionId
                    ? 'kb-border-accent kb-surface-accent kb-text-accent'
                    : 'kb-border-subtle kb-surface-raised/5 kb-text-muted hover:kb-surface-raised'
                }`}
              >
                {mission.missionId}
              </button>
            ))}
          </div>
          <div className="space-y-3">
            {filteredAgentMessages.length === 0 ? (
              <div className="text-[11px] italic kb-status-warning">
                {mt(
                  'chronos_no_mission_scoped_messages',
                  'No mission-scoped agent messages observed yet.'
                )}
              </div>
            ) : (
              filteredAgentMessages.map((message, index) => (
                <div
                  key={`${message.agentId}-${message.ts}-${index}`}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.2em] ${messageToneClass(message.tone)}`}
                    >
                      {messageTypeLabel(message.type)}
                    </div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] kb-text-secondary">
                      {message.agentId}
                    </div>
                    {message.teamRole && (
                      <div className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                        {message.teamRole}
                      </div>
                    )}
                    {message.missionId && (
                      <div className="text-[10px] kb-text-muted">{message.missionId}</div>
                    )}
                    <div className="ml-auto text-[9px] font-mono kb-text-muted">
                      {new Date(message.ts).toLocaleString(chronosSpeechLocale())}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] leading-6 kb-text-primary">
                    {message.content}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                    <span>
                      {mt('chronos_owner', 'owner')}: {message.ownerType}/{message.ownerId}
                    </span>
                    {message.channel && (
                      <span>
                        {mt('chronos_channel', 'channel')}: {message.channel}
                      </span>
                    )}
                    {message.thread && (
                      <span>
                        {mt('chronos_thread', 'thread')}: {message.thread}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <div ref={missionThreadPanelRef}>
          <Panel
            id="selected-mission-thread"
            visible={panelVisible('selected-mission-thread')}
            title={mt('chronos_selected_mission_thread', 'Selected Mission Thread')}
          >
            <div className="mb-3 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.18em] kb-text-muted">
              <span>
                {effectiveMissionId
                  ? `thread · ${effectiveMissionId}`
                  : mt(
                      'chronos_select_mission_to_inspect_thread',
                      'select a mission to inspect the thread'
                    )}
              </span>
              <span className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[9px] tracking-[0.16em] kb-text-muted">
                {missionPinStatusLabel}
              </span>
              {effectiveMissionId ? (
                <button
                  type="button"
                  onClick={() => focusMissionCard(effectiveMissionId)}
                  className="rounded-full border kb-border-accent kb-surface-accent px-2 py-1 text-[9px] tracking-[0.16em] kb-text-accent transition hover:kb-surface-accent"
                >
                  <span className="inline-flex items-center gap-2">
                    <span>Card</span>
                    <span className="rounded-full border kb-border-accent kb-surface-accent px-1.5 py-0.5 text-[8px] tracking-[0.18em] kb-text-accent">
                      C
                    </span>
                  </span>
                </button>
              ) : null}
            </div>
            <div className="space-y-3">
              {!effectiveMissionId || missionThread.length === 0 ? (
                <SurfaceStatusPanel
                  eyebrow="Selected Mission Thread"
                  title="No thread yet"
                  detail="Select a mission to inspect its unified message thread and handoffs."
                  tone="info"
                />
              ) : (
                missionThread.map((entry, index) => (
                  <div
                    key={`${entry.type}-${entry.agentId}-${entry.ts}-${index}`}
                    className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                  >
                    <div className="flex flex-wrap items-center gap-2">
                      <div
                        className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.2em] ${messageToneClass(entry.tone)}`}
                      >
                        {messageTypeLabel(entry.type)}
                      </div>
                      <div className="text-[10px] font-semibold uppercase tracking-[0.18em] kb-text-secondary">
                        {entry.label}
                      </div>
                      {entry.teamRole && (
                        <div className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                          {entry.teamRole}
                        </div>
                      )}
                      <div className="ml-auto text-[9px] font-mono kb-text-muted">
                        {new Date(entry.ts).toLocaleString(chronosSpeechLocale())}
                      </div>
                    </div>
                    <div className="mt-2 text-[11px] leading-6 kb-text-primary">
                      {entry.content}
                    </div>
                    <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                      {entry.channel && (
                        <span>
                          {mt('chronos_channel', 'channel')}: {entry.channel}
                        </span>
                      )}
                      {entry.thread && (
                        <span>
                          {mt('chronos_thread', 'thread')}: {entry.thread}
                        </span>
                      )}
                    </div>
                  </div>
                ))
              )}
            </div>
          </Panel>
        </div>

        <Panel
          id="a2a-handoff-trail"
          visible={panelVisible('a2a-handoff-trail')}
          title={mt('chronos_a2a_handoff_trail', 'A2A Handoff Trail')}
        >
          <div className="space-y-3">
            {filteredA2AHandoffs.length === 0 ? (
              <SurfaceStatusPanel
                eyebrow="A2A handoff trail"
                title="No A2A handoffs observed for the current mission filter"
                detail="Handoffs appear here once the selected mission exchanges prompts, tasks, or acknowledgements."
                tone="neutral"
              />
            ) : (
              filteredA2AHandoffs.map((handoff, index) => (
                <div
                  key={`${handoff.sender}-${handoff.receiver}-${handoff.ts}-${index}`}
                  className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="rounded-full border kb-border-accent kb-surface-accent px-2 py-1 text-[9px] uppercase tracking-[0.2em] kb-text-accent">
                      a2a handoff
                    </div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] kb-text-secondary">
                      {handoff.sender} → {handoff.receiver}
                    </div>
                    {handoff.teamRole && (
                      <div className="rounded-full border kb-border-subtle kb-surface-raised/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                        {handoff.teamRole}
                      </div>
                    )}
                    <div className="ml-auto text-[9px] font-mono kb-text-muted">
                      {new Date(handoff.ts).toLocaleString(chronosSpeechLocale())}
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] uppercase tracking-[0.16em] kb-text-muted">
                    {mt('chronos_mission', 'mission')}: {handoff.missionId}
                    {handoff.intent
                      ? ` · ${mt('chronos_intent', 'intent')}: ${handoff.intent}`
                      : ''}
                    {handoff.performative ? ` · ${handoff.performative}` : ''}
                  </div>
                  {handoff.promptExcerpt && (
                    <div className="mt-2 text-[11px] leading-6 kb-text-primary">
                      {handoff.promptExcerpt}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] kb-text-muted">
                    {handoff.channel && (
                      <span>
                        {mt('chronos_channel', 'channel')}: {handoff.channel}
                      </span>
                    )}
                    {handoff.thread && (
                      <span>
                        {mt('chronos_thread', 'thread')}: {handoff.thread}
                      </span>
                    )}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>
    </div>
  );
}

function MetricCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: string;
  detail: string;
}) {
  return (
    <div className="rounded-2xl border kb-border-subtle kb-surface-sunken px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] kb-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight kb-text-primary">{value}</div>
      <div className="mt-1 text-[10px] kb-text-muted">{detail}</div>
    </div>
  );
}

function MiniSummaryCard({
  icon,
  label,
  value,
  detail,
}: {
  icon: ReactNode;
  label: string;
  value: number;
  detail: string;
}) {
  return (
    <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-4 py-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] kb-text-muted">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight kb-text-primary">{value}</div>
      <div className="mt-1 text-[10px] kb-text-muted">{detail}</div>
    </div>
  );
}

function Panel({
  id,
  title,
  children,
  visible = true,
}: {
  id?: string;
  title: string;
  children: ReactNode;
  visible?: boolean;
}) {
  if (!visible) return null;
  return (
    <div id={id} className="rounded-2xl border kb-border-subtle kb-surface-sunken p-4 scroll-mt-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.3em] kb-status-warning">{title}</div>
      </div>
      {children}
    </div>
  );
}

function RuntimeCell({
  label,
  value,
  accent,
}: {
  label: string;
  value: number;
  accent: 'emerald' | 'gold' | 'red' | 'cyan';
}) {
  const accentClass = {
    emerald: 'kb-status-positive',
    gold: 'kb-status-warning',
    red: 'kb-status-negative',
    cyan: 'kb-text-accent',
  }[accent];

  return (
    <div className="rounded-xl border kb-border-subtle kb-surface-sunken px-3 py-3">
      <div className="text-[9px] uppercase tracking-[0.22em] kb-text-muted">{label}</div>
      <div className={`mt-2 text-lg font-semibold ${accentClass}`}>{value}</div>
    </div>
  );
}

function providerResolutionSummary(
  metadata?: Record<string, unknown>
): { preferred: string; strategy: string } | null {
  const resolution = metadata?.provider_resolution;
  if (!resolution || typeof resolution !== 'object') return null;
  const record = resolution as Record<string, unknown>;
  const preferredProvider =
    typeof record.preferredProvider === 'string' ? record.preferredProvider : '';
  const preferredModelId =
    typeof record.preferredModelId === 'string' ? record.preferredModelId : '';
  const strategy = typeof record.strategy === 'string' ? record.strategy : 'preferred';
  if (!preferredProvider) return null;
  return {
    preferred: `${preferredProvider}${preferredModelId ? `/${preferredModelId}` : ''}`,
    strategy,
  };
}
