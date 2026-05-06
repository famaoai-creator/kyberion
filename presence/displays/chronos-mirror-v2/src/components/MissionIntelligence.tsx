'use client';

import { useEffect, useState } from 'react';
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
import { resolveChronosLocale, uxText } from '../lib/ux-vocabulary';

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
    | 'delivery'
    | 'change'
    | 'release'
    | 'incident'
    | 'compliance'
    | 'operations'
    | 'research';
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
  work_loop?: ArtifactRecordSummary['work_loop'];
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
  work_loop?: ArtifactRecordSummary['work_loop'];
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
  work_loop?: ArtifactRecordSummary['work_loop'];
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
          ? 'bg-green-500/15 text-green-300'
          : action.status === 'failed'
            ? 'bg-red-500/15 text-red-300'
            : 'bg-yellow-500/10 text-yellow-200'
      }`}
    >
      {action.operation} · {action.status}
    </div>
  );
}

function messageToneClass(tone: AgentMessageSummary['tone']): string {
  if (tone === 'request') return 'border-cyan-300/15 bg-cyan-400/8 text-cyan-100/80';
  if (tone === 'response') return 'border-emerald-300/15 bg-emerald-400/8 text-emerald-100/80';
  return 'border-amber-300/15 bg-amber-400/8 text-amber-100/80';
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
    <div className="mt-3 space-y-2 rounded-lg border border-white/6 bg-black/25 px-3 py-3">
      {entries.length === 0 ? (
        <div className="text-[10px] text-white/40">No detail observations recorded yet.</div>
      ) : (
        entries.map((detail, detailIndex) => (
          <div
            key={`${actionId}-${detail.ts}-${detailIndex}`}
            className="border-l border-white/10 pl-3"
          >
            <div className="text-[10px] uppercase tracking-[0.16em] text-white/45">
              {detail.decision}
            </div>
            {detail.decision === 'next_action_executed' ||
            detail.decision === 'memory_promote_pending_applied' ? (
              <div className="mt-1 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                <div>
                  operation:{' '}
                  <span className="font-mono text-white/75">{detail.operation || '-'}</span>
                </div>
                <div>
                  target:{' '}
                  <span className="font-mono text-white/75">{detail.resource_id || '-'}</span>
                </div>
                {detail.action_id ? (
                  <div className="col-span-2">
                    action id: <span className="font-mono text-white/75">{detail.action_id}</span>
                  </div>
                ) : null}
                {detail.outcome ? (
                  <div>
                    outcome: <span className="font-mono text-white/75">{detail.outcome}</span>
                  </div>
                ) : null}
              </div>
            ) : null}
            {detail.why && <div className="mt-1 text-[10px] text-white/60">{detail.why}</div>}
            {detail.error && <div className="mt-1 text-[10px] text-red-200/70">{detail.error}</div>}
            <div className="mt-1 text-[9px] font-mono text-white/25">
              {new Date(detail.ts).toLocaleString()}
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
    <div className="mt-3 rounded-lg border border-white/6 bg-black/25 px-3 py-3">
      <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">operator guidance</div>
      {currentAction?.disabledReason && (
        <div className="mt-2 text-[10px] text-white/55">
          disabled reason: <span className="text-white/75">{currentAction.disabledReason}</span>
        </div>
      )}
      {nextValidActions.length > 0 && (
        <div className="mt-2 text-[10px] text-white/55">
          next valid actions:{' '}
          <span className="text-white/75">
            {nextValidActions.map((action) => action.label).join(', ')}
          </span>
        </div>
      )}
      {latestAction.status === 'failed' &&
        nextValidActions.length === 0 &&
        !currentAction?.enabled && (
          <div className="mt-2 text-[10px] text-amber-200/75">
            No immediate retry path is available from the current target state.
          </div>
        )}
    </div>
  );
}

function actionButtonClass(kind: 'safe' | 'risky'): string {
  if (kind === 'risky') {
    return 'rounded-lg border border-red-300/15 bg-red-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-red-100/80 transition hover:bg-red-400/12 disabled:cursor-not-allowed disabled:opacity-40';
  }
  return 'rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40';
}

function missionSummaryBadgeClass(tone: MissionSummary['controlTone']): string {
  if (tone === 'pending') return 'bg-violet-500/15 text-violet-200';
  if (tone === 'ready') return 'bg-cyan-500/15 text-cyan-200';
  if (tone === 'attention') return 'bg-yellow-500/10 text-yellow-200';
  return 'bg-green-500/15 text-green-300';
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
  if (tone === 'pending') return 'bg-violet-500/15 text-violet-200';
  if (tone === 'stable') return 'bg-green-500/15 text-green-300';
  if (tone === 'offline') return 'bg-white/10 text-white/65';
  return 'bg-yellow-500/10 text-yellow-200';
}

interface IntelligencePayload {
  accessRole: 'readonly' | 'localadmin';
  activeMissions: MissionSummary[];
  projects: ProjectRecordSummary[];
  projectTracks: ProjectTrackRecordSummary[];
  gateReadiness?: Array<{
    track_id: string;
    ready_gate_count: number;
    total_gate_count: number;
    current_gate_id?: string;
    current_phase?: string;
    ready: boolean;
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
      | 'approvals'
      | 'mission-seeds'
      | 'memory-promotion-queue'
      | 'next-actions';
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

export function MissionIntelligence({
  focusedView = null,
  onClearFocus,
}: {
  focusedView?: string | null;
  onClearFocus?: () => void;
}) {
  const locale = resolveChronosLocale();
  const mt = (key: string, fallbackEn: string) => uxText(key, fallbackEn, locale);
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
  const [selectedMissionId, setSelectedMissionId] = useState<string | null>(null);
  const [selectedProjectId, setSelectedProjectId] = useState<string | null>(null);
  const [selectedTrackId, setSelectedTrackId] = useState<string | null>(null);
  const [selectedReferencePath, setSelectedReferencePath] = useState<string | null>(null);
  const [referenceDetail, setReferenceDetail] = useState<ReferenceDetail | null>(null);

  useEffect(() => {
    setMounted(true);
  }, []);

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
          runtimeTopology?: MissionIntelligenceProps['data']['runtimeTopology'];
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
        document
          .getElementById('approvals')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
        document
          .getElementById('mission-seeds')
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
    document.getElementById(route.panelId)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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

  const missionPinStatusLabel = selectedMissionId ? 'mission pinned' : 'pin mission thread';

  if (error) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="rounded-2xl border border-red-500/20 bg-red-950/10 px-6 py-5 text-center">
          <div className="text-[11px] uppercase tracking-[0.25em] text-red-300/70">
            Mission Intelligence
          </div>
          <div className="mt-2 text-sm text-red-200/80">{error}</div>
        </div>
      </div>
    );
  }

  if (!mounted) {
    return (
      <div className="rounded-[24px] border border-white/8 bg-black/20 px-5 py-5 text-[11px] uppercase tracking-[0.22em] text-white/40">
        Loading mission intelligence...
      </div>
    );
  }

  if (!data) {
    return (
      <div className="h-full w-full flex items-center justify-center">
        <div className="text-[11px] uppercase tracking-[0.25em] text-kyberion-gold/40">
          {mt('chronos_mission_loading', 'Loading mission intelligence...')}
        </div>
      </div>
    );
  }

  const selectedProject = selectedProjectId
    ? data.projects.find((project) => project.project_id === selectedProjectId) || null
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
      document
        .getElementById(toDomId('mission', item.targetId))
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    if (item.targetType === 'runtime' && item.remediationAction) {
      remediateLease(item.targetId, item.remediationAction);
      return;
    }
    if (item.targetType === 'surface') {
      document
        .getElementById(toDomId('surface', item.targetId))
        ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      return;
    }
    document
      .getElementById('recent-surface-outbox')
      ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };
  const showAllViews = focusedView == null;
  const isVisible = (sectionId: string) => showAllViews || focusedView === sectionId;
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
      {/* Command Center: High-Visibility Action Dashboard */}
      {!selectedProject && !selectedMissionId && (
        <section className="flex flex-col gap-8 py-4">
          <div className="flex flex-col gap-2">
            <div className="text-[12px] uppercase tracking-[0.4em] text-cyan-400 font-bold">Sovereign Command</div>
            <h2 className="text-3xl font-bold tracking-tight text-white/90">Welcome to the Mirror.</h2>
            <p className="text-sm text-white/50 max-w-2xl leading-relaxed">
              Chronos is your operational管制塔. 
              Use the tiles below to start monitoring or intervene in active agent workflows.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
            <button 
              onClick={() => document.getElementById('mission-control-plane')?.scrollIntoView({ behavior: 'smooth' })}
              className="group kyberion-glass p-8 rounded-[32px] text-left hover:border-cyan-400/50 transition-all hover:translate-y-[-4px]"
            >
              <div className="w-14 h-14 rounded-2xl bg-cyan-400/10 flex items-center justify-center text-cyan-400 mb-6 group-hover:scale-110 transition-transform">
                <Radar size={28} />
              </div>
              <h3 className="text-xl font-bold text-white mb-2">Monitor Missions</h3>
              <p className="text-xs text-white/40 leading-relaxed">Observe real-time intent execution and artifact delivery across all active agents.</p>
              <div className="mt-6 text-[10px] uppercase tracking-widest text-cyan-400 font-bold opacity-0 group-hover:opacity-100 transition-opacity">Open Dashboard →</div>
            </button>

            <button 
              onClick={() => document.getElementById('runtime-lease-doctor')?.scrollIntoView({ behavior: 'smooth' })}
              className="group kyberion-glass p-8 rounded-[32px] text-left hover:border-amber-400/50 transition-all hover:translate-y-[-4px]"
            >
              <div className="w-14 h-14 rounded-2xl bg-amber-400/10 flex items-center justify-center text-amber-400 mb-6 group-hover:scale-110 transition-transform">
                <Activity size={28} />
              </div>
              <h3 className="text-xl font-bold text-white mb-2">System Health</h3>
              <p className="text-xs text-white/40 leading-relaxed">Inspect runtime leases, remediation findings, and supervisor-level governance.</p>
              <div className="mt-6 text-[10px] uppercase tracking-widest text-amber-400 font-bold opacity-0 group-hover:opacity-100 transition-opacity">Check Vitals →</div>
            </button>

            <button 
              onClick={() => document.getElementById('recent-surface-outbox')?.scrollIntoView({ behavior: 'smooth' })}
              className="group kyberion-glass p-8 rounded-[32px] text-left hover:border-rose-400/50 transition-all hover:translate-y-[-4px]"
            >
              <div className="w-14 h-14 rounded-2xl bg-rose-400/10 flex items-center justify-center text-rose-400 mb-6 group-hover:scale-110 transition-transform">
                <ShieldAlert size={28} />
              </div>
              <h3 className="text-xl font-bold text-white mb-2">Intervention</h3>
              <p className="text-xs text-white/40 leading-relaxed">Resolve blocked deliveries, approve sensitive requests, and manage exceptions.</p>
              <div className="mt-6 text-[10px] uppercase tracking-widest text-rose-400 font-bold opacity-0 group-hover:opacity-100 transition-opacity">View Outbox →</div>
            </button>
          </div>

          <div className="kyberion-glass p-6 rounded-[24px] border-white/5 flex items-center justify-between bg-white/[0.02]">
            <div className="flex items-center gap-4">
              <div className="w-2 h-2 rounded-full bg-cyan-400 pulse-animation" />
              <div className="text-[11px] uppercase tracking-[0.2em] text-white/60">
                System Status: <span className="text-cyan-400 font-bold">Nominal</span>
              </div>
            </div>
            <div className="text-[10px] text-white/30 font-mono">
              Ready for operator commands via Sovereign Link or Quick Actions.
            </div>
          </div>
        </section>
      )}

      {focusedView && (
        <section className="rounded-[24px] border border-cyan-300/12 bg-cyan-400/[0.06] px-5 py-4">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
            <div>
              <div className="text-[10px] uppercase tracking-[0.28em] text-cyan-100/58">
                Focused Operator View
              </div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/90">
                {focusTitle}
              </div>
              <div className="mt-1 text-[11px] leading-5 text-white/58">
                The main console is showing one operator view at full width.
              </div>
            </div>
            {onClearFocus && (
              <button
                type="button"
                onClick={onClearFocus}
                className="self-start rounded-xl border border-white/10 bg-black/20 px-3 py-2 text-[10px] uppercase tracking-[0.2em] text-white/75 transition hover:bg-white/10"
              >
                Show Full Console
              </button>
            )}
          </div>
        </section>
      )}
      <section className="rounded-[26px] border border-kyberion-gold/15 bg-gradient-to-br from-kyberion-gold/10 via-black/10 to-cyan-950/20 px-5 py-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <div className="text-[10px] uppercase tracking-[0.3em] text-kyberion-gold/45">
              {mt('chronos_operator_console', 'Operator Console')}
            </div>
            <h2 className="mt-2 text-xl font-semibold tracking-tight text-white/90">
              {mt(
                'chronos_mission_hero_title',
                'Start with exceptions, then intervene only where mission flow or runtime governance needs help.'
              )}
            </h2>
            <p className="mt-2 max-w-3xl text-[12px] leading-6 text-white/52">
              {mt(
                'chronos_mission_hero_description',
                'Chronos is the operational mirror for Kyberion. Confirm what is active, identify what is blocked, open A2UI drill-downs when you need detail, and keep control actions deliberate and minimal.'
              )}
            </p>
          </div>
          <div className="grid grid-cols-2 gap-3 text-[10px] uppercase tracking-[0.18em] text-white/48 sm:grid-cols-4">
            <div className="rounded-2xl border border-white/8 bg-black/25 px-3 py-3">
              <div>needs attention</div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/88">
                {attentionItems.length}
              </div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/25 px-3 py-3">
              <div>missions</div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/88">
                {data.activeMissions.length}
              </div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/25 px-3 py-3">
              <div>runtime incidents</div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/88">
                {data.runtimeDoctor.length}
              </div>
            </div>
            <div className="rounded-2xl border border-white/8 bg-black/25 px-3 py-3">
              <div>delivery queue</div>
              <div className="mt-2 text-lg font-semibold tracking-tight text-white/88">
                {data.surfaceOutbox.slack + data.surfaceOutbox.chronos}
              </div>
            </div>
          </div>
        </div>
        {actionResult && (
          <div className="mt-4 rounded-xl border border-cyan-300/15 bg-cyan-400/8 px-3 py-2 text-[11px] text-cyan-100/80">
            {mt('chronos_last_action', 'last action')}: {actionResult}
          </div>
        )}
        <div className="mt-3 rounded-xl border border-white/8 bg-black/20 px-3 py-2 text-[11px] text-white/60">
          {mt('chronos_access', 'access')}:{' '}
          <span className="font-mono text-white/85">{data.accessRole}</span>
          {data.accessRole === 'readonly'
            ? mt(
                'chronos_control_actions_disabled',
                ' · control actions are disabled until a localadmin token is provided or localhost auto-admin is enabled.'
              )
            : mt('chronos_control_actions_enabled', ' · control actions enabled.')}
        </div>
        {selectedProject && (
          <div className="mt-3 rounded-xl border border-cyan-300/12 bg-cyan-400/[0.06] px-3 py-3 text-[11px] text-cyan-100/80">
            project focus:{' '}
            <span className="font-semibold text-white/90">{selectedProject.name}</span>
            <span className="mx-2 text-white/40">·</span>
            <span className="font-mono text-white/70">{selectedProject.project_id}</span>
            <button
              type="button"
              onClick={() => setSelectedProjectId(null)}
              className="ml-3 rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 transition hover:bg-white/10"
            >
              clear focus
            </button>
          </div>
        )}
        {selectedTrack && (
          <div className="mt-3 rounded-xl border border-cyan-300/12 bg-cyan-400/[0.06] px-3 py-3 text-[11px] text-cyan-100/80">
            track focus: <span className="font-semibold text-white/90">{selectedTrack.name}</span>
            <span className="mx-2 text-white/40">·</span>
            <span className="font-mono text-white/70">{selectedTrack.track_id}</span>
            <button
              type="button"
              onClick={() => setSelectedTrackId(null)}
              className="ml-3 rounded-lg border border-white/10 bg-black/20 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 transition hover:bg-white/10"
            >
              clear focus
            </button>
          </div>
        )}
        <div className="mt-3 rounded-xl border border-amber-200/10 bg-stone-100/[0.035] px-3 py-3 text-[11px] leading-5 text-stone-100/68">
          Surfaces are the explainable boundary between people and agent execution. Chronos is the
          control surface: it should clarify mission flow, runtime risk, and intervention points
          before it offers controls.
        </div>
      </section>

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

      <section className="grid gap-4">
        <Panel id="next-actions" title="Recommended Next Actions">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            These actions are generated from current control-plane state. Execute only what is
            necessary to unblock mission flow.
          </div>
          <div className="mb-4 rounded-xl border border-cyan-300/10 bg-cyan-400/[0.04] px-4 py-3 text-[10px] leading-5 text-cyan-50/75">
            mission seed assessment: eligible{' '}
            <span className="font-mono text-cyan-100">
              {data.missionSeedAssessment?.eligible ?? 0}
            </span>
            {' · '}
            flagged{' '}
            <span className="font-mono text-cyan-100">
              {data.missionSeedAssessment?.flagged ?? 0}
            </span>
            {' · '}
            promotable{' '}
            <span className="font-mono text-cyan-100">
              {data.missionSeedAssessment?.promotable ?? 0}
            </span>
          </div>
          <div className="space-y-3">
            {nextActions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No immediate next actions recommended.
              </div>
            ) : (
              nextActions.map((action) => (
                <div
                  key={action.action_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                      {action.action_id}
                    </div>
                    <div className="rounded-full bg-cyan-500/15 px-2 py-1 text-[9px] uppercase tracking-[0.25em] text-cyan-200">
                      {action.next_action_type}
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] text-white/70">{action.reason}</div>
                  <div className="mt-2 text-[10px] text-white/50">
                    risk: <span className="font-mono text-white/75">{action.risk}</span>
                    <span className="mx-2 text-white/35">·</span>
                    approval required:{' '}
                    <span className="font-mono text-white/75">
                      {action.approval_required ? 'yes' : 'no'}
                    </span>
                  </div>
                  {resolveNextActionRoute(action) ? (
                    <div className="mt-1 text-[10px] text-white/45">
                      route:{' '}
                      <span className="font-mono text-white/70">
                        {resolveNextActionRoute(action)?.label}
                      </span>
                    </div>
                  ) : null}
                  {action.suggested_command ? (
                    <div className="mt-1 text-[10px] text-white/45">
                      command:{' '}
                      <span className="font-mono text-white/70">{action.suggested_command}</span>
                    </div>
                  ) : null}
                  <div className="mt-3 flex flex-wrap gap-2">
                    {resolveNextActionRoute(action) ? (
                      <button
                        type="button"
                        onClick={() => jumpToNextActionRoute(action)}
                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/75 transition hover:bg-white/10"
                      >
                        jump
                      </button>
                    ) : null}
                    <button
                      type="button"
                      onClick={() => runNextAction(action)}
                      disabled={nextActionTarget === action.action_id}
                      className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-100/80 transition hover:bg-cyan-400/12 disabled:cursor-not-allowed disabled:opacity-40"
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
                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/75 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
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

        <Panel id="needs-attention" title="Needs Attention">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Start here. These are the items most likely to block mission progress or degrade
            operator trust. Use the action only when the control plane does not self-heal.
          </div>
          <div className="grid gap-3 lg:grid-cols-[1.15fr,0.85fr]">
            <div className="space-y-3">
              {attentionItems.length === 0 ? (
                <div className="rounded-xl border border-emerald-300/10 bg-emerald-400/[0.04] px-4 py-3 text-[11px] text-emerald-100/70">
                  No immediate operator intervention is recommended. Stay in observe mode and use
                  A2UI drill-downs for detail.
                </div>
              ) : (
                attentionItems.map((item) => (
                  <div
                    key={item.id}
                    className={`rounded-xl border px-4 py-3 ${
                      item.tone === 'critical'
                        ? 'border-red-400/20 bg-red-950/12'
                        : item.tone === 'warning'
                          ? 'border-amber-300/18 bg-amber-400/[0.06]'
                          : 'border-cyan-300/16 bg-cyan-400/[0.06]'
                    }`}
                  >
                    <div className="flex items-center justify-between gap-3">
                      <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                        {item.tone === 'critical'
                          ? 'critical'
                          : item.tone === 'warning'
                            ? 'warning'
                            : 'info'}
                      </div>
                      <div className="text-[10px] font-mono text-white/40">{item.title}</div>
                    </div>
                    <div className="mt-2 text-[11px] text-white/78">{item.reason}</div>
                    {item.actionLabel && (
                      <button
                        type="button"
                        onClick={() => runAttentionAction(item)}
                        className="mt-3 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/75 transition hover:bg-white/10"
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
        <Panel id="mission-control-plane" title="Mission Control">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            {mt(
              'chronos_mission_control_description',
              'Confirm which durable work items are active, which ones are blocked, and what the next safe intervention is. Pinning a mission narrows the unified thread below without leaving the operator console.'
            )}
          </div>
          {selectedProject &&
          filteredMissions.length === 0 &&
          selectedProjectBootstrapItems.length > 0 ? (
            <div className="mb-4 rounded-xl border border-cyan-300/10 bg-cyan-400/5 px-4 py-3 text-[11px] leading-5 text-cyan-100/75">
              {mt(
                'chronos_project_bootstrap_notice',
                'This project does not have active missions yet. Current bootstrap work:'
              )}
              <div className="mt-2 text-[10px] text-cyan-100/70">
                {selectedProjectBootstrapItems
                  .slice(0, 4)
                  .map((item) => `${item.title} [${item.status}]`)
                  .join(' -> ')}
              </div>
            </div>
          ) : null}
          <div className="space-y-3">
            {filteredMissions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">No active missions.</div>
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
                    className={`rounded-xl border bg-black/20 px-4 py-3 ${effectiveMissionId === mission.missionId ? 'border-cyan-300/20 shadow-[0_0_0_1px_rgba(34,211,238,0.08)]' : 'border-white/5'}`}
                  >
                    {(() => {
                      const latestAction = getLatestMissionControlAction(
                        data.controlActions,
                        mission.missionId
                      );
                      return latestAction ? (
                        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                            latest intervention
                          </div>
                          <ActionStatusBadge action={latestAction} />
                        </div>
                      ) : null;
                    })()}
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[12px] font-semibold tracking-[0.03em] text-white/90">
                          {missionIntent}
                        </div>
                        <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-white/35">
                          {mission.missionType || 'development'} · {mission.tier} ·{' '}
                          {mission.missionId}
                        </div>
                        {mission.projectId || mission.trackId ? (
                          <div className="mt-1 text-[10px] text-white/42">
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
                            ? 'bg-green-500/15 text-green-300'
                            : 'bg-yellow-500/10 text-yellow-200'
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
                      <div className="text-[10px] text-white/45">current state</div>
                      {mission.controlRequestedBy && (
                        <div className="text-[10px] text-white/35">
                          requested by{' '}
                          <span className="font-mono text-white/60">
                            {mission.controlRequestedBy}
                          </span>
                        </div>
                      )}
                    </div>
                    <div className="mt-3 grid gap-2 text-[10px] text-white/55">
                      <div>
                        intent: <span className="text-white/80">{missionIntent}</span>
                      </div>
                      <div>
                        plan:{' '}
                        <span className="text-white/80">
                          {mission.planReady
                            ? 'ready to execute or continue'
                            : 'still being aligned'}
                        </span>
                      </div>
                      <div>
                        result:{' '}
                        <span className="text-white/80">
                          {latestAsset ? latestAsset.path.split('/').pop() : 'No artifact yet'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                      <div>
                        open work:{' '}
                        <span className="font-mono text-white/80">{mission.nextTaskCount}</span>
                      </div>
                      <div>
                        plan:{' '}
                        <span className="font-mono text-white/80">
                          {mission.planReady ? 'ready' : 'pending'}
                        </span>
                      </div>
                      <div>
                        results:{' '}
                        <span className="font-mono text-white/80">
                          {progress?.generatedAssets?.length ?? 0}
                        </span>
                      </div>
                      <div>
                        latest artifact:{' '}
                        <span className="font-mono text-white/80">
                          {latestAsset ? latestAsset.path.split('/').pop() : 'none'}
                        </span>
                      </div>
                    </div>
                    <div className="mt-3">
                      <button
                        type="button"
                        onClick={() => {
                          setSelectedMissionId(mission.missionId);
                          setMessageMissionFilter(mission.missionId);
                        }}
                        className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
                      >
                        {effectiveMissionId === mission.missionId ? 'focused' : 'focus thread'}
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
                              className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
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
                                className="rounded-lg border border-red-300/15 bg-red-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-red-100/80 transition hover:bg-red-400/12 disabled:cursor-not-allowed disabled:opacity-40"
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
                      <div className="flex flex-wrap gap-2 rounded-lg border border-emerald-300/10 bg-emerald-400/[0.04] px-2 py-2">
                        <div className="w-full text-[9px] uppercase tracking-[0.18em] text-emerald-200/50">
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
                          <div className="w-full text-[10px] text-white/40">
                            {safeDisabledReason}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 rounded-lg border border-red-300/10 bg-red-400/[0.04] px-2 py-2">
                        <div className="w-full text-[9px] uppercase tracking-[0.18em] text-red-200/50">
                          risky actions · approval required
                        </div>
                        {riskyMissionActions.map((action) => (
                          <button
                            key={action.operation}
                            type="button"
                            onClick={() => runMissionControl(mission.missionId, action.operation)}
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
                          <div className="w-full text-[10px] text-white/40">
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

        <Panel id="runtime-topology-map" title="Runtime Topology Map">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            This map shows what the supervisor daemon is currently holding: who owns each runtime,
            which runtimes are active, and which agent-to-agent or owner-to-agent flows were seen
            recently.
          </div>
          <div className="grid gap-3">
            <div className="grid gap-3 lg:grid-cols-[0.9fr,1.1fr]">
              <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-3">
                <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/40">
                  owners
                </div>
                <div className="space-y-2">
                  {data.runtimeTopology.owners.length === 0 ? (
                    <div className="text-[10px] text-white/35">No managed owners discovered.</div>
                  ) : (
                    data.runtimeTopology.owners.map((owner) => (
                      <div
                        key={`${owner.type}:${owner.id}`}
                        className="rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2"
                      >
                        <div className="text-[10px] font-mono text-white/78">{owner.id}</div>
                        <div className="mt-1 text-[9px] uppercase tracking-[0.16em] text-white/38">
                          {owner.type} · runtimes {owner.runtimeCount}
                        </div>
                        <div className="mt-2 flex flex-wrap gap-1">
                          {owner.runtimeIds.map((runtimeId) => (
                            <span
                              key={runtimeId}
                              className="rounded-full border border-white/8 bg-black/20 px-2 py-1 text-[9px] font-mono text-white/58"
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
              <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-3">
                <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/40">
                  managed runtimes
                </div>
                <div className="space-y-2">
                  {data.runtimeTopology.runtimes.length === 0 ? (
                    <div className="text-[10px] text-white/35">No managed runtimes discovered.</div>
                  ) : (
                    data.runtimeTopology.runtimes.map((runtime) => (
                      <div
                        key={runtime.agentId}
                        className="rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2"
                      >
                        {(() => {
                          const resolution = providerResolutionSummary(runtime.metadata);
                          return (
                            <>
                              <div className="flex items-center justify-between gap-3">
                                <div className="text-[10px] font-mono text-white/82">
                                  {runtime.agentId}
                                </div>
                                <div
                                  className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.18em] ${
                                    runtime.status === 'ready'
                                      ? 'bg-green-500/15 text-green-300'
                                      : runtime.status === 'busy'
                                        ? 'bg-amber-400/12 text-amber-100'
                                        : runtime.status === 'error'
                                          ? 'bg-red-500/15 text-red-300'
                                          : 'bg-white/10 text-white/65'
                                  }`}
                                >
                                  {runtime.status}
                                </div>
                              </div>
                              <div className="mt-1 text-[9px] uppercase tracking-[0.16em] text-white/38">
                                {runtime.provider}
                                {runtime.modelId ? `/${runtime.modelId}` : ''} · {runtime.ownerType}
                                :{runtime.ownerId}
                              </div>
                              {resolution ? (
                                <div className="mt-1 text-[9px] text-white/45">
                                  preferred {resolution.preferred} · strategy {resolution.strategy}
                                </div>
                              ) : null}
                              <div className="mt-2 flex flex-wrap gap-2 text-[9px] text-white/42">
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
            <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/40">
                recent flow
              </div>
              <div className="space-y-2">
                {data.runtimeTopology.flows.length === 0 ? (
                  <div className="text-[10px] text-white/35">
                    No recent A2A or agent-message flow observed.
                  </div>
                ) : (
                  data.runtimeTopology.flows.map((flow) => (
                    <div
                      key={flow.id}
                      className="rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2"
                    >
                      <div className="flex items-center justify-between gap-3">
                        <div className="text-[10px] font-mono text-white/80">
                          {flow.from} → {flow.to}
                        </div>
                        <div className="text-[9px] uppercase tracking-[0.16em] text-white/38">
                          {flow.kind}
                        </div>
                      </div>
                      <div className="mt-1 flex flex-wrap gap-2 text-[9px] text-white/42">
                        <span>count {flow.count}</span>
                        {flow.channel && <span>channel {flow.channel}</span>}
                        {flow.thread && <span>thread {flow.thread}</span>}
                        <span>{new Date(flow.latestAt).toLocaleTimeString()}</span>
                      </div>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </Panel>

        <Panel id="runtime-lease-doctor" title="Runtime Governance">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Managed runtimes are part of operations, not a separate playground. Use this section to
            resolve stale leases, errored runtimes, and ownership drift without over-restarting
            healthy agents.
          </div>
          <div className="space-y-3">
            {data.runtimeDoctor.length === 0 ? (
              <div className="text-[11px] italic text-emerald-300/40">
                No stale or orphaned runtime leases detected.
              </div>
            ) : (
              data.runtimeDoctor.map((finding, index) => (
                <div
                  key={`${finding.agentId}-${index}`}
                  className={`rounded-xl border px-3 py-3 ${
                    finding.severity === 'critical'
                      ? 'border-red-500/20 bg-red-950/10'
                      : 'border-yellow-500/20 bg-yellow-950/10'
                  }`}
                >
                  <div className="flex items-center justify-between gap-2 text-[10px] uppercase tracking-[0.18em]">
                    <span
                      className={
                        finding.severity === 'critical' ? 'text-red-300/80' : 'text-yellow-200/80'
                      }
                    >
                      {finding.severity}
                    </span>
                    <span className="font-mono text-white/45">{finding.agentId}</span>
                  </div>
                  <div className="mt-2 text-[10px] text-white/65">owner: {finding.ownerId}</div>
                  <div className="mt-1 text-[10px] text-white/55">{finding.reason}</div>
                  <button
                    type="button"
                    onClick={() =>
                      remediateLease(
                        finding.agentId,
                        finding.recommendedAction === 'restart_runtime'
                          ? 'restart_runtime_lease'
                          : 'cleanup_runtime_lease'
                      )
                    }
                    disabled={remediationTarget === finding.agentId}
                    className="mt-3 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
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

            <div className="border-t border-white/5 pt-3">
              <div className="mb-2 text-[10px] uppercase tracking-[0.18em] text-white/35">
                Managed Runtime Leases
              </div>
              <div className="space-y-2">
                {data.runtimeLeases.slice(0, 6).map((lease) => (
                  <div
                    key={`${lease.agent_id}-${lease.owner_id}`}
                    className="rounded-xl border border-white/5 bg-black/20 px-3 py-2"
                  >
                    <div className="text-[10px] font-mono text-white/75">{lease.agent_id}</div>
                    <div className="mt-1 text-[10px] text-white/45">
                      {lease.owner_type}: {lease.owner_id}
                    </div>
                    {typeof lease.metadata?.team_role === 'string' && (
                      <div className="mt-1 text-[10px] text-white/35">
                        team_role: {lease.metadata.team_role}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>
          </div>
        </Panel>

        <Panel id="recent-surface-outbox" title="Delivery Exceptions">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Outbox items are operator-facing delivery residue. Resolve them here only when the
            autonomous path has already stalled or a human-visible queue needs cleanup.
          </div>
          <div className="space-y-3">
            {data.recentSurfaceOutbox.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                {mt(
                  'chronos_no_recent_surface_outbox',
                  'No pending or recent surface outbox messages.'
                )}
              </div>
            ) : (
              data.recentSurfaceOutbox.map((message) => (
                <div
                  key={message.message_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                      {message.surface} · {message.source} · {message.channel}
                    </div>
                    <div className="text-[9px] font-mono text-white/30">
                      {new Date(message.created_at).toLocaleString()}
                    </div>
                  </div>
                  <div className="mt-2 text-[9px] uppercase tracking-[0.18em] text-white/28">
                    {mt('chronos_correlation', 'correlation')}: {message.correlation_id}
                  </div>
                  <div className="mt-2 text-[11px] text-white/80">{message.text}</div>
                  <button
                    type="button"
                    onClick={() => clearOutboxMessage(message.surface, message.message_id)}
                    disabled={outboxTarget === message.message_id}
                    className="mt-3 rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
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

        <Panel title={mt('chronos_projects', 'Projects')}>
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            {mt(
              'chronos_projects_description',
              'Projects hold the long-lived intent context. Use this panel to see which durable work, bindings, and results already have a parent container before creating new missions.'
            )}
          </div>
          <div className="space-y-3">
            {data.projects.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                {mt('chronos_no_projects', 'No projects registered yet.')}
              </div>
            ) : (
              data.projects.map((project) => (
                <div
                  key={project.project_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  {(() => {
                    const learnedRefs = learnedProjectRefs(project.project_id);
                    const workLoop = buildProjectWorkLoopPreview(project);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div>
                            <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                              {project.name}
                            </div>
                            <div className="mt-1 text-[10px] text-white/45">
                              {project.project_id} · {project.tier}
                            </div>
                          </div>
                          <div
                            className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                              project.status === 'active'
                                ? 'bg-green-500/15 text-green-300'
                                : project.status === 'draft'
                                  ? 'bg-cyan-500/15 text-cyan-200'
                                  : 'bg-white/10 text-white/65'
                            }`}
                          >
                            {project.status}
                          </div>
                        </div>
                        <div className="mt-3 text-[10px] text-white/70">{project.summary}</div>
                        <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                          <div>
                            {mt('chronos_missions', 'missions')}:{' '}
                            <span className="font-mono text-white/80">
                              {project.active_missions?.length ?? 0}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_bindings', 'bindings')}:{' '}
                            <span className="font-mono text-white/80">
                              {project.service_bindings?.length ?? 0}
                            </span>
                          </div>
                        </div>
                        {project.bootstrap_work_items?.length ? (
                          <div className="mt-3 text-[10px] text-white/58">
                            {mt('chronos_next_work', 'next work')}:{' '}
                            {project.bootstrap_work_items
                              .slice(0, 3)
                              .map((item) => item.title)
                              .join(' -> ')}
                          </div>
                        ) : null}
                        {project.kickoff_task_session_id ? (
                          <div className="mt-2 text-[10px] text-white/45">
                            {mt('chronos_kickoff', 'kickoff')}:{' '}
                            <span className="font-mono text-white/70">
                              {project.kickoff_task_session_id}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3 rounded-lg border border-white/6 bg-white/[0.03] px-3 py-3 text-[10px] text-white/55">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="text-white/80">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="text-white/80">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono text-white/80">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="text-white/80">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="text-white/80">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="text-white/80">{workLoop.authority}</span>
                          </div>
                        </div>
                        {learnedRefs.length ? (
                          <div className="mt-2 text-[10px] text-white/45">
                            {mt('chronos_learned', 'learned')}:{' '}
                            <span className="text-white/70">
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
                            className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
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

        <Panel title={mt('chronos_tracks', 'Tracks')}>
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            {mt(
              'chronos_tracks_description',
              'Tracks are the SDLC and gating lanes inside a project. Focus a track to review evidence, approvals, and durable work without assuming one project equals one lifecycle.'
            )}
          </div>
          <div className="space-y-3">
            {hydratedTracks.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                {mt('chronos_no_tracks', 'No tracks registered yet.')}
              </div>
            ) : (
              hydratedTracks.map((track) => (
                <div
                  key={track.track_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                        {track.name}
                      </div>
                      <div className="mt-1 text-[10px] text-white/45">
                        {track.track_id} · {track.track_type} · {track.lifecycle_model}
                      </div>
                    </div>
                    <div className="rounded-full bg-white/10 px-2 py-1 text-[9px] uppercase tracking-[0.25em] text-white/65">
                      {track.status}
                    </div>
                  </div>
                  <div className="mt-3 text-[10px] text-white/70">{track.summary}</div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                    <div>
                      {mt('chronos_project', 'project')}:{' '}
                      <span className="font-mono text-white/80">{track.project_id}</span>
                    </div>
                    <div>
                      {mt('chronos_required_artifacts', 'required artifacts')}:{' '}
                      <span className="font-mono text-white/80">
                        {track.required_artifacts?.length ?? 0}
                      </span>
                    </div>
                    {track.gate_readiness ? (
                      <>
                        <div>
                          {mt('chronos_gate_readiness', 'gate readiness')}:{' '}
                          <span className="font-mono text-white/80">
                            {track.gate_readiness.ready_gate_count}/
                            {track.gate_readiness.total_gate_count}
                          </span>
                        </div>
                        <div>
                          {mt('chronos_current_gate', 'current gate')}:{' '}
                          <span className="font-mono text-white/80">
                            {track.gate_readiness.current_gate_id ||
                              (track.gate_readiness.ready ? 'ready' : '-')}
                          </span>
                        </div>
                      </>
                    ) : null}
                  </div>
                  {track.gate_readiness?.next_required_artifacts?.length ? (
                    <div className="mt-2 text-[10px] text-white/45">
                      {mt('chronos_next_required', 'next required')}:{' '}
                      <span className="font-mono text-white/75">
                        {track.gate_readiness.next_required_artifacts
                          .map((artifact) => artifact.artifact_id)
                          .join(', ')}
                      </span>
                    </div>
                  ) : null}
                  {track.release_id ? (
                    <div className="mt-2 text-[10px] text-white/45">
                      release: <span className="font-mono text-white/70">{track.release_id}</span>
                    </div>
                  ) : null}
                  <div className="mt-3">
                    <div className="flex flex-wrap gap-2">
                      <button
                        type="button"
                        onClick={() => setSelectedTrackId(track.track_id)}
                        className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
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
                        className="rounded-lg border border-emerald-300/15 bg-emerald-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-emerald-100/80 transition hover:bg-emerald-400/12 disabled:cursor-not-allowed disabled:opacity-40"
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

        <Panel title={mt('chronos_service_bindings', 'Service Bindings')}>
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            {mt(
              'chronos_service_bindings_description',
              'Bindings define where Kyberion can read from or deliver to. This is the governed edge for GitHub, Slack, Drive, search, and other external systems.'
            )}
          </div>
          <div className="space-y-3">
            {filteredServiceBindings.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No service bindings registered yet.
              </div>
            ) : (
              filteredServiceBindings.slice(0, 8).map((binding) => (
                <div
                  key={binding.binding_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                      {binding.binding_id}
                    </div>
                    <div className="rounded-full bg-white/10 px-2 py-1 text-[9px] uppercase tracking-[0.25em] text-white/65">
                      {binding.auth_mode || 'none'}
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] text-white/55">
                    {binding.service_type} · {binding.scope} · {binding.target}
                  </div>
                  <div className="mt-2 text-[10px] text-white/45">
                    actions:{' '}
                    <span className="text-white/70">
                      {binding.allowed_actions.slice(0, 4).join(', ') || 'none'}
                    </span>
                    {binding.allowed_actions.length > 4 ? (
                      <span className="text-white/45"> +{binding.allowed_actions.length - 4}</span>
                    ) : null}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel id="mission-seeds" title="Mission Seeds">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Proposed durable work can stay here before it becomes a full mission. Use this panel to
            confirm bootstrap output is structured and attributable.
          </div>
          <div className="mb-4 rounded-xl border border-cyan-300/10 bg-cyan-400/[0.04] px-4 py-3 text-[10px] leading-5 text-cyan-50/75">
            assessment: eligible{' '}
            <span className="font-mono text-cyan-100">
              {data.missionSeedAssessment?.eligible ?? 0}
            </span>
            {' · '}
            flagged{' '}
            <span className="font-mono text-cyan-100">
              {data.missionSeedAssessment?.flagged ?? 0}
            </span>
            {' · '}
            unassessed{' '}
            <span className="font-mono text-cyan-100">
              {data.missionSeedAssessment?.unassessed ?? 0}
            </span>
            {' · '}
            promotable{' '}
            <span className="font-mono text-cyan-100">
              {data.missionSeedAssessment?.promotable ?? 0}
            </span>
          </div>
          <div className="space-y-3">
            {filteredMissionSeedsByTrack.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No mission seeds recorded yet.
              </div>
            ) : (
              filteredMissionSeedsByTrack.slice(0, 8).map((seed) => (
                <div
                  key={seed.seed_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
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
                          <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                            {seed.title}
                          </div>
                          <div className="rounded-full bg-white/10 px-2 py-1 text-[9px] uppercase tracking-[0.25em] text-white/65">
                            {seed.status}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] text-white/70">{seed.summary}</div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                          <div>
                            project:{' '}
                            <span className="font-mono text-white/80">{seed.project_id}</span>
                          </div>
                          <div>
                            specialist:{' '}
                            <span className="font-mono text-white/80">{seed.specialist_id}</span>
                          </div>
                          <div>
                            work:{' '}
                            <span className="font-mono text-white/80">
                              {seed.source_work_id || '-'}
                            </span>
                          </div>
                          <div>
                            type:{' '}
                            <span className="font-mono text-white/80">
                              {seed.mission_type_hint || '-'}
                            </span>
                          </div>
                        </div>
                        {typeof seed.metadata?.template_ref === 'string' ? (
                          <div className="mt-2 text-[10px] text-white/45">
                            template:{' '}
                            <button
                              type="button"
                              onClick={() =>
                                openKnowledgeReference(seed.metadata?.template_ref as string)
                              }
                              className="font-mono text-cyan-200/80 transition hover:text-cyan-100"
                            >
                              {seed.metadata.template_ref}
                            </button>
                          </div>
                        ) : null}
                        {typeof seed.metadata?.skeleton_path === 'string' ? (
                          <div className="mt-1 text-[10px] text-white/45">
                            skeleton:{' '}
                            <button
                              type="button"
                              onClick={() =>
                                openRuntimeReference(seed.metadata?.skeleton_path as string)
                              }
                              className="font-mono text-cyan-200/80 transition hover:text-cyan-100"
                            >
                              {seed.metadata.skeleton_path}
                            </button>
                          </div>
                        ) : null}
                        {seed.promoted_mission_id ? (
                          <div className="mt-2 text-[10px] text-white/45">
                            mission:{' '}
                            <span className="font-mono text-white/75">
                              {seed.promoted_mission_id}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3 rounded-lg border border-white/6 bg-white/[0.03] px-3 py-3 text-[10px] text-white/55">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="text-white/80">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="text-white/80">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono text-white/80">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="text-white/80">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="text-white/80">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="text-white/80">{workLoop.authority}</span>
                          </div>
                        </div>
                        {learnedRefs.length ? (
                          <div className="mt-2 text-[10px] text-white/45">
                            {mt('chronos_learned', 'learned')}:{' '}
                            <span className="text-white/70">
                              {learnedRefs.map((candidate) => candidate.title).join(', ')}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => promoteMissionSeed(seed.seed_id)}
                            disabled={
                              seed.status === 'promoted' || missionSeedTarget === seed.seed_id
                            }
                            className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-100/80 transition hover:bg-cyan-400/12 disabled:cursor-not-allowed disabled:opacity-40"
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

        <Panel title={mt('chronos_skeleton_detail', 'Skeleton Detail')}>
          {!selectedReferencePath || !referenceDetail ? (
            <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
              {mt(
                'chronos_skeleton_detail_empty',
                'Select a track-generated skeleton to inspect its title, metadata, overview, and sections without leaving Chronos.'
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                    {referenceDetail.title || 'reference'}
                  </div>
                  <div className="font-mono text-[10px] text-white/45">
                    {selectedReferencePath.split('/').slice(-2).join('/')}
                  </div>
                </div>
                <div className="mt-2 text-[10px] text-white/70">
                  {referenceDetail.summary || mt('chronos_no_summary', 'No summary available yet.')}
                </div>
                <div className="mt-2 text-[10px] text-white/45">
                  path: <span className="font-mono text-white/70">{selectedReferencePath}</span>
                </div>
                <div className="mt-2 text-[10px]">
                  <a
                    className="text-cyan-200/80 transition hover:text-cyan-100"
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
                    <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/45">
                      <div>
                        seed:{' '}
                        <span className="font-mono text-white/75">
                          {selectedReferenceSeed.seed_id}
                        </span>
                      </div>
                      <div>
                        track:{' '}
                        <span className="font-mono text-white/75">
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
                          className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/10"
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
                          className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-100/80 transition hover:bg-cyan-400/12"
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
                          className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-100/80 transition hover:bg-cyan-400/12"
                        >
                          {mt('chronos_open_skeleton', 'open skeleton')}
                        </button>
                      ) : null}
                      <button
                        type="button"
                        onClick={() => promoteMissionSeed(selectedReferenceSeed.seed_id)}
                        disabled={
                          selectedReferenceSeed.status === 'promoted' ||
                          missionSeedTarget === selectedReferenceSeed.seed_id
                        }
                        className="rounded-lg border border-emerald-300/15 bg-emerald-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-emerald-100/80 transition hover:bg-emerald-400/12 disabled:cursor-not-allowed disabled:opacity-40"
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
                <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                    {mt('chronos_metadata', 'Metadata')}
                  </div>
                  <div className="mt-2 space-y-1">
                    {referenceMetadataEntries.map(([key, value]) => (
                      <div key={key} className="text-[10px] text-white/55">
                        <span className="font-mono text-white/70">{key}</span>: {String(value)}
                      </div>
                    ))}
                  </div>
                </div>
              ) : null}

              {referenceDetail.body ? (
                <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                    {mt('chronos_overview', 'Overview')}
                  </div>
                  <div className="mt-2 space-y-1">
                    {referenceDetail.body
                      .split('\n')
                      .filter((line) => line.trim())
                      .slice(0, 8)
                      .map((line, index) => (
                        <div key={`${line}-${index}`} className="text-[10px] text-white/55">
                          {line}
                        </div>
                      ))}
                  </div>
                </div>
              ) : null}

              {referenceSections.map((section) => (
                <div
                  key={section.title}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                    {section.title || 'Section'}
                  </div>
                  <div className="mt-2 space-y-1">
                    {section.lines
                      .filter((line) => line.trim())
                      .slice(0, 12)
                      .map((line, index) => (
                        <div
                          key={`${section.title}-${index}`}
                          className="text-[10px] text-white/55"
                        >
                          {line}
                        </div>
                      ))}
                    {!section.lines.some((line) => line.trim()) ? (
                      <div className="text-[10px] text-white/45">
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
        <Panel id="approvals" title={mt('chronos_approvals', 'Approvals')}>
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            {mt(
              'chronos_approvals_description',
              'Approvals keep authority explicit. Review pending risky actions here before they cross a governed boundary.'
            )}
          </div>
          <div className="space-y-3">
            {filteredPendingApprovalsByTrack.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                {mt('chronos_no_pending_approvals', 'No pending approvals.')}
              </div>
            ) : (
              filteredPendingApprovalsByTrack.map((approval) => (
                <div
                  key={approval.id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  {(() => {
                    const workLoop = buildApprovalWorkLoopPreview(approval);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                            {approval.title}
                          </div>
                          <div className="rounded-full bg-red-500/12 px-2 py-1 text-[9px] uppercase tracking-[0.25em] text-red-200">
                            {approval.riskLevel}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] text-white/70">{approval.summary}</div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                          <div>
                            {mt('chronos_channel', 'channel')}:{' '}
                            <span className="font-mono text-white/80">{approval.channel}</span>
                          </div>
                          <div>
                            {mt('chronos_kind', 'kind')}:{' '}
                            <span className="font-mono text-white/80">{approval.kind}</span>
                          </div>
                          <div>
                            {mt('chronos_service', 'service')}:{' '}
                            <span className="font-mono text-white/80">
                              {approval.serviceId || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_mission', 'mission')}:{' '}
                            <span className="font-mono text-white/80">
                              {approval.missionId || '-'}
                            </span>
                          </div>
                        </div>
                        {approval.pendingRoles.length > 0 ? (
                          <div className="mt-2 text-[10px] text-white/45">
                            pending roles:{' '}
                            <span className="text-white/70">
                              {approval.pendingRoles.join(', ')}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3 rounded-lg border border-white/6 bg-white/[0.03] px-3 py-3 text-[10px] text-white/55">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="text-white/80">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="text-white/80">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono text-white/80">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="text-white/80">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="text-white/80">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="text-white/80">{workLoop.authority}</span>
                          </div>
                        </div>
                        <div className="mt-3 flex flex-wrap gap-2">
                          <button
                            type="button"
                            onClick={() => decideApproval(approval, 'approved')}
                            disabled={approvalTarget === approval.id}
                            className="rounded-lg border border-emerald-300/15 bg-emerald-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-emerald-100/80 transition hover:bg-emerald-400/12 disabled:cursor-not-allowed disabled:opacity-40"
                          >
                            {approvalTarget === approval.id
                              ? mt('chronos_processing', 'processing')
                              : mt('chronos_approve', 'approve')}
                          </button>
                          <button
                            type="button"
                            onClick={() => decideApproval(approval, 'rejected')}
                            disabled={approvalTarget === approval.id}
                            className="rounded-lg border border-red-300/15 bg-red-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-red-100/80 transition hover:bg-red-400/12 disabled:cursor-not-allowed disabled:opacity-40"
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

        <Panel title="Recent Artifacts">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Outcomes should stay attributable. This panel shows the latest recorded artifacts with
            their project, mission, task, and storage placement.
          </div>
          <div className="space-y-3">
            {filteredRecentArtifactsByTrack.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No governed artifacts recorded yet.
              </div>
            ) : (
              filteredRecentArtifactsByTrack.map((artifact) => (
                <div
                  key={artifact.artifact_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  {(() => {
                    const workLoop = buildArtifactWorkLoopPreview(artifact);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                            {artifact.artifact_id}
                          </div>
                          <div className="rounded-full bg-cyan-500/15 px-2 py-1 text-[9px] uppercase tracking-[0.25em] text-cyan-200">
                            {artifact.kind}
                          </div>
                        </div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                          <div>
                            project:{' '}
                            <span className="font-mono text-white/80">
                              {artifact.project_id || 'standalone'}
                            </span>
                          </div>
                          <div>
                            mission:{' '}
                            <span className="font-mono text-white/80">
                              {artifact.mission_id || '-'}
                            </span>
                          </div>
                          <div>
                            task:{' '}
                            <span className="font-mono text-white/80">
                              {artifact.task_session_id || '-'}
                            </span>
                          </div>
                          <div>
                            storage:{' '}
                            <span className="font-mono text-white/80">
                              {artifact.storage_class}
                            </span>
                          </div>
                        </div>
                        {(artifact.path || artifact.external_ref || artifact.preview_text) && (
                          <div className="mt-2 text-[10px] text-white/45">
                            {artifact.preview_text ||
                              artifact.external_ref ||
                              artifact.path?.split('/').pop()}
                          </div>
                        )}
                        <div className="mt-3 rounded-lg border border-white/6 bg-white/[0.03] px-3 py-3 text-[10px] text-white/55">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="text-white/80">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="text-white/80">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono text-white/80">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="text-white/80">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="text-white/80">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="text-white/80">{workLoop.authority}</span>
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

        <Panel title={mt('chronos_distill_candidates', 'Distill Candidates')}>
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            {mt(
              'chronos_distill_candidates_description',
              'Completed work can become reusable organizational memory. This queue highlights outcome-backed candidates that may be promoted into patterns, SOPs, or governed knowledge later.'
            )}
          </div>
          <div className="space-y-3">
            {filteredDistillCandidatesByTrack.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                {mt('chronos_no_distill_candidates', 'No distill candidates recorded yet.')}
              </div>
            ) : (
              filteredDistillCandidatesByTrack.slice(0, 10).map((candidate) => (
                <div
                  key={candidate.candidate_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  {(() => {
                    const workLoop = buildDistillCandidateWorkLoopPreview(candidate);
                    return (
                      <>
                        <div className="flex items-center justify-between gap-3">
                          <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                            {candidate.title}
                          </div>
                          <div className="rounded-full bg-violet-500/15 px-2 py-1 text-[9px] uppercase tracking-[0.25em] text-violet-200">
                            {candidate.target_kind}
                          </div>
                        </div>
                        <div className="mt-2 text-[10px] text-white/70">{candidate.summary}</div>
                        <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                          <div>
                            {mt('chronos_source', 'source')}:{' '}
                            <span className="font-mono text-white/80">{candidate.source_type}</span>
                          </div>
                          <div>
                            {mt('chronos_project', 'project')}:{' '}
                            <span className="font-mono text-white/80">
                              {candidate.project_id || 'standalone'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_mission', 'mission')}:{' '}
                            <span className="font-mono text-white/80">
                              {candidate.mission_id || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_task', 'task')}:{' '}
                            <span className="font-mono text-white/80">
                              {candidate.task_session_id || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_status', 'status')}:{' '}
                            <span className="font-mono text-white/80">{candidate.status}</span>
                          </div>
                          <div>
                            {mt('chronos_specialist', 'specialist')}:{' '}
                            <span className="font-mono text-white/80">
                              {candidate.specialist_id || '-'}
                            </span>
                          </div>
                          <div>
                            {mt('chronos_tier', 'tier')}:{' '}
                            <span className="font-mono text-white/80">
                              {candidate.tier || 'confidential'}
                            </span>
                          </div>
                        </div>
                        {candidate.artifact_ids && candidate.artifact_ids.length ? (
                          <div className="mt-2 text-[10px] text-white/45">
                            artifacts:{' '}
                            <span className="text-white/70">
                              {candidate.artifact_ids.join(', ')}
                            </span>
                          </div>
                        ) : null}
                        {candidate.evidence_refs && candidate.evidence_refs.length ? (
                          <div className="mt-1 text-[10px] text-white/45">
                            evidence:{' '}
                            <span className="text-white/70">
                              {candidate.evidence_refs.join(', ')}
                            </span>
                          </div>
                        ) : null}
                        {candidate.promoted_ref ? (
                          <div className="mt-1 text-[10px] text-white/45">
                            promoted ref:{' '}
                            <span className="font-mono text-white/70">
                              {candidate.promoted_ref}
                            </span>
                          </div>
                        ) : null}
                        <div className="mt-3 rounded-lg border border-white/6 bg-white/[0.03] px-3 py-3 text-[10px] text-white/55">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                            work loop
                          </div>
                          <div className="mt-2">
                            {mt('chronos_intent', 'intent')}:{' '}
                            <span className="text-white/80">{workLoop.intent}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_context', 'context')}:{' '}
                            <span className="text-white/80">{workLoop.context}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_resolution', 'resolution')}:{' '}
                            <span className="font-mono text-white/80">{workLoop.resolution}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_outcome', 'outcome')}:{' '}
                            <span className="text-white/80">{workLoop.outcome}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_team', 'team')}:{' '}
                            <span className="text-white/80">{workLoop.team}</span>
                          </div>
                          <div className="mt-1">
                            {mt('chronos_authority', 'authority')}:{' '}
                            <span className="text-white/80">{workLoop.authority}</span>
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
                            className="rounded-lg border border-violet-300/15 bg-violet-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-violet-100/80 transition hover:bg-violet-400/12 disabled:cursor-not-allowed disabled:opacity-40"
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
                            className="rounded-lg border border-white/15 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/75 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
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

        <Panel id="memory-promotion-queue" title="Memory Promotion Queue">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/52">
            Approved memory candidates can be promoted into governed knowledge in bulk. Run a
            dry-run first to inspect queue scope, then execute promotion.
          </div>
          <div className="mb-4 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => runMemoryPromotion(true)}
              disabled={memoryPromotionTarget !== null}
              className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-100/80 transition hover:bg-cyan-400/12 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {memoryPromotionTarget === 'dry-run'
                ? mt('chronos_processing', 'processing')
                : 'dry-run'}
            </button>
            <button
              type="button"
              onClick={() => runMemoryPromotion(false)}
              disabled={memoryPromotionTarget !== null}
              className="rounded-lg border border-emerald-300/15 bg-emerald-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-emerald-100/80 transition hover:bg-emerald-400/12 disabled:cursor-not-allowed disabled:opacity-40"
            >
              {memoryPromotionTarget === 'promote'
                ? mt('chronos_processing', 'processing')
                : 'promote approved'}
            </button>
          </div>
          <div className="space-y-3">
            {filteredMemoryCandidatesByTrack.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No memory candidates queued.
              </div>
            ) : (
              filteredMemoryCandidatesByTrack.slice(0, 12).map((candidate) => (
                <div
                  key={candidate.candidate_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                      {candidate.candidate_id}
                    </div>
                    <div className="rounded-full bg-cyan-500/15 px-2 py-1 text-[9px] uppercase tracking-[0.25em] text-cyan-200">
                      {candidate.status}
                    </div>
                  </div>
                  <div className="mt-2 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                    <div>
                      kind:{' '}
                      <span className="font-mono text-white/80">
                        {candidate.proposed_memory_kind}
                      </span>
                    </div>
                    <div>
                      tier:{' '}
                      <span className="font-mono text-white/80">{candidate.sensitivity_tier}</span>
                    </div>
                    <div className="col-span-2">
                      source:{' '}
                      <span className="font-mono text-white/80">{candidate.source_ref}</span>
                    </div>
                    <div className="col-span-2">
                      evidence:{' '}
                      <span className="text-white/70">
                        {candidate.evidence_refs?.join(', ') || '-'}
                      </span>
                    </div>
                  </div>
                  {candidate.promoted_ref ? (
                    <div className="mt-2 text-[10px] text-white/45">
                      promoted ref:{' '}
                      <span className="font-mono text-white/70">{candidate.promoted_ref}</span>
                    </div>
                  ) : null}
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>

      <section className="grid gap-4">
        <Panel title="Recent Control Actions">
          <div className="space-y-3">
            {data.controlActions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No recent mission or surface control actions.
              </div>
            ) : (
              data.controlActions.map((action, index) => (
                <div
                  key={`${action.event_id || action.ts}-${index}`}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                      {action.kind} · {action.operation}
                    </div>
                    <ActionStatusBadge action={action} />
                  </div>
                  <div className="mt-2 text-[11px] text-white/80">{action.target}</div>
                  <div className="mt-1 text-[10px] text-white/45">
                    requested_by:{' '}
                    <span className="font-mono text-white/70">{action.requested_by}</span>
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
                        className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-white/70 transition hover:bg-white/10"
                      >
                        {expandedActionId === action.event_id ? 'hide details' : 'show details'}
                      </button>
                      {action.target !== 'surface-runtime' && (
                        <button
                          type="button"
                          onClick={() => jumpToTarget(action)}
                          className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.18em] text-cyan-100/80 transition hover:bg-cyan-400/12"
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
                    <div className="mt-2 text-[10px] text-red-200/70">{action.error}</div>
                  )}
                  <div className="mt-2 text-[9px] font-mono text-white/25">
                    {new Date(action.ts).toLocaleString()}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>
      <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
        <Panel title="Orchestration Audit">
          <div className="space-y-3">
            {data.recentEvents.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No orchestration events yet.
              </div>
            ) : (
              data.recentEvents.map((event, index) => (
                <div key={`${event.ts}-${index}`} className="border-l border-kyberion-gold/20 pl-3">
                  <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.18em] text-white/45">
                    <Activity size={10} />
                    <span>{event.decision}</span>
                  </div>
                  <div className="mt-1 text-[11px] text-white/80">
                    {event.mission_id || 'system'}
                  </div>
                  {event.why && <div className="mt-1 text-[10px] text-white/45">{event.why}</div>}
                  <div className="mt-1 text-[9px] font-mono text-white/25">
                    {new Date(event.ts).toLocaleString()}
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
        <Panel id="owner-summaries" title="Owner Summaries">
          <div className="space-y-3">
            {data.ownerSummaries.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No owner summaries yet.
              </div>
            ) : (
              data.ownerSummaries.map((summary, index) => (
                <div
                  key={`${summary.mission_id}-${summary.ts}-${index}`}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-2">
                    <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                      {summary.mission_id}
                    </div>
                    <div className="text-[9px] font-mono text-white/30">
                      {new Date(summary.ts).toLocaleString()}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/60">
                    <div>
                      accepted:{' '}
                      <span className="font-mono text-white/80">{summary.accepted_count}</span>
                    </div>
                    <div>
                      reviewed:{' '}
                      <span className="font-mono text-white/80">{summary.reviewed_count}</span>
                    </div>
                    <div>
                      completed:{' '}
                      <span className="font-mono text-white/80">{summary.completed_count}</span>
                    </div>
                    <div>
                      requested:{' '}
                      <span className="font-mono text-white/80">{summary.requested_count}</span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>

        <Panel id="runtime-summary" title="Operator Summary">
          <div className="mb-4 rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/48">
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
        <Panel id="browser-sessions" title="Browser Session Oversight">
          <div className="space-y-3">
            {data.browserSessions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No browser sessions recorded yet.
              </div>
            ) : (
              data.browserSessions.map((session) => (
                <div
                  key={session.session_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                        {session.session_id}
                      </div>
                      <div className="mt-1 text-[10px] text-white/45">
                        active tab:{' '}
                        <span className="font-mono text-white/70">{session.active_tab_id}</span> ·
                        tabs: <span className="font-mono text-white/70">{session.tab_count}</span>
                      </div>
                    </div>
                    <div
                      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                        session.lease_status === 'active'
                          ? 'bg-cyan-500/15 text-cyan-200'
                          : session.lease_status === 'expired'
                            ? 'bg-yellow-500/10 text-yellow-200'
                            : 'bg-white/10 text-white/65'
                      }`}
                    >
                      {session.lease_status}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                    <div>
                      retained:{' '}
                      <span className="font-mono text-white/80">{String(session.retained)}</span>
                    </div>
                    <div>
                      trail:{' '}
                      <span className="font-mono text-white/80">{session.action_trail_count}</span>
                    </div>
                    <div>
                      updated:{' '}
                      <span className="font-mono text-white/80">
                        {new Date(session.updated_at).toLocaleTimeString()}
                      </span>
                    </div>
                    <div>
                      lease expires:{' '}
                      <span className="font-mono text-white/80">
                        {session.lease_expires_at
                          ? new Date(session.lease_expires_at).toLocaleTimeString()
                          : 'n/a'}
                      </span>
                    </div>
                  </div>
                  {session.last_trace_path && (
                    <div className="mt-2 text-[10px] text-white/40">
                      trace:{' '}
                      <span className="font-mono text-white/60">{session.last_trace_path}</span>
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
                      className="rounded-lg border border-white/10 bg-white/5 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-white/70 transition hover:bg-white/10 disabled:cursor-not-allowed disabled:opacity-40"
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
                      className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12 disabled:cursor-not-allowed disabled:opacity-40"
                    >
                      {browserSessionTarget === `${session.session_id}:restart_browser_session`
                        ? 'restarting'
                        : 'restart session'}
                    </button>
                  </div>
                  <div className="mt-3 space-y-2">
                    <div className="text-[10px] uppercase tracking-[0.18em] text-white/35">
                      recent browser trail
                    </div>
                    {session.recent_actions.length === 0 ? (
                      <div className="text-[10px] text-white/35">No recorded browser actions.</div>
                    ) : (
                      session.recent_actions.map((action, index) => (
                        <div
                          key={`${session.session_id}-${action.ts}-${index}`}
                          className="rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2"
                        >
                          <div className="flex items-center justify-between gap-3">
                            <div className="text-[10px] uppercase tracking-[0.16em] text-white/55">
                              {action.kind} · {action.op}
                            </div>
                            <div className="text-[9px] font-mono text-white/30">
                              {new Date(action.ts).toLocaleTimeString()}
                            </div>
                          </div>
                          <div className="mt-1 text-[10px] text-white/45">
                            {action.tab_id && (
                              <span className="mr-2">
                                tab:{' '}
                                <span className="font-mono text-white/65">{action.tab_id}</span>
                              </span>
                            )}
                            {action.ref && (
                              <span className="mr-2">
                                ref: <span className="font-mono text-white/65">{action.ref}</span>
                              </span>
                            )}
                            {action.selector && (
                              <span>
                                selector:{' '}
                                <span className="font-mono text-white/55">{action.selector}</span>
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

        <Panel title="Browser Guidance">
          <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3 text-[11px] leading-5 text-white/50">
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
        <Panel id="browser-conversation-sessions" title="Browser Tasks">
          <div className="space-y-3">
            {data.browserConversationSessions.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                No browser tasks recorded yet.
              </div>
            ) : (
              data.browserConversationSessions.map((session) => (
                <div
                  key={session.session_id}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                        {session.session_id}
                      </div>
                      <div className="mt-1 text-[10px] text-white/45">
                        surface: <span className="font-mono text-white/70">{session.surface}</span>{' '}
                        · mode: <span className="font-mono text-white/70">{session.mode}</span>
                      </div>
                    </div>
                    <div
                      className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${
                        session.status === 'completed'
                          ? 'bg-green-500/15 text-green-300'
                          : session.status === 'awaiting_confirmation'
                            ? 'bg-yellow-500/10 text-yellow-200'
                            : session.status === 'failed'
                              ? 'bg-red-500/15 text-red-200'
                              : 'bg-cyan-500/15 text-cyan-200'
                      }`}
                    >
                      {session.status}
                    </div>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2 text-[10px] text-white/55">
                    <div>
                      intent: <span className="text-white/80">{session.goal_summary || 'n/a'}</span>
                    </div>
                    <div>
                      current step:{' '}
                      <span className="text-white/80">{session.active_step || 'n/a'}</span>
                    </div>
                    <div>
                      waiting for confirmation:{' '}
                      <span className="font-mono text-white/80">
                        {String(session.pending_confirmation)}
                      </span>
                    </div>
                    <div>
                      available actions:{' '}
                      <span className="font-mono text-white/80">
                        {session.candidate_target_count}
                      </span>
                    </div>
                    <div>
                      updated:{' '}
                      <span className="font-mono text-white/80">
                        {new Date(session.updated_at).toLocaleTimeString()}
                      </span>
                    </div>
                  </div>
                </div>
              ))
            )}
          </div>
        </Panel>
      </section>

      <section className="grid gap-4 lg:grid-cols-[1.1fr,0.9fr]">
        <Panel id="surface-control" title="Surface Control">
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
                  <div className="mr-2 flex items-center rounded-lg border border-white/6 bg-white/[0.03] px-3 py-1.5 text-[10px] text-white/55">
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
                          current === latestAction.event_id ? null : latestAction.event_id || null
                        )
                      }
                      className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
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
                      className="rounded-lg border border-red-300/15 bg-red-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-red-100/80 transition hover:bg-red-400/12 disabled:cursor-not-allowed disabled:opacity-40"
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
                className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12 disabled:cursor-not-allowed disabled:opacity-40"
              >
                {surfaceActionTarget === `all:${action.operation}` ? 'working' : action.label}
              </button>
            ))}
            {getSharedDisabledReason(data.controlActionAvailability.globalSurface) && (
              <div className="w-full text-[10px] text-white/40">
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
              <div className="text-[11px] italic text-kyberion-gold/30">
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
                    className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                  >
                    {(() => {
                      const latestAction = getLatestSurfaceControlAction(
                        data.controlActions,
                        surface.id
                      );
                      return latestAction ? (
                        <div className="mb-3 flex items-center justify-between gap-3 rounded-lg border border-white/6 bg-white/[0.03] px-3 py-2">
                          <div className="text-[10px] uppercase tracking-[0.18em] text-white/45">
                            {mt('chronos_last_control_action', 'last control action')}
                          </div>
                          <ActionStatusBadge action={latestAction} />
                        </div>
                      ) : null;
                    })()}
                    <div className="flex items-center justify-between gap-3">
                      <div>
                        <div className="text-[11px] font-semibold tracking-[0.08em] text-white/90">
                          {surface.id}
                        </div>
                        <div className="mt-1 text-[10px] uppercase tracking-[0.2em] text-white/35">
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
                            ? 'bg-green-500/15 text-green-300'
                            : surface.health === 'unhealthy'
                              ? 'bg-red-500/15 text-red-300'
                              : 'bg-yellow-500/10 text-yellow-200'
                        }`}
                      >
                        {surface.health}
                      </div>
                    </div>
                    <div className="mt-2 text-[10px] text-white/50">
                      pid: <span className="font-mono text-white/75">{surface.pid ?? '-'}</span>
                      {surface.detail ? (
                        <>
                          {' '}
                          · {mt('chronos_detail', 'detail')}:{' '}
                          <span className="font-mono text-white/75">{surface.detail}</span>
                        </>
                      ) : null}
                    </div>
                    <div className="mt-3 flex items-center gap-2">
                      <div
                        className={`rounded-full px-2 py-1 text-[9px] uppercase tracking-[0.25em] ${surfaceSummaryBadgeClass(surface.controlTone)}`}
                      >
                        {surface.controlSummary}
                      </div>
                      <div className="text-[10px] text-white/45">
                        {mt('chronos_control_summary', 'control summary')}
                      </div>
                      {surface.controlRequestedBy && (
                        <div className="text-[10px] text-white/35">
                          {mt('chronos_requested_by', 'requested by')}{' '}
                          <span className="font-mono text-white/60">
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
                              className="rounded-lg border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-cyan-100/80 transition hover:bg-cyan-400/12"
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
                                  surfaceActionTarget === `${surface.id}:${latestAction.operation}`
                                }
                                title={retryAction?.disabledReason}
                                className="rounded-lg border border-red-300/15 bg-red-400/8 px-2 py-1 text-[10px] uppercase tracking-[0.16em] text-red-100/80 transition hover:bg-red-400/12 disabled:cursor-not-allowed disabled:opacity-40"
                              >
                                {surfaceActionTarget === `${surface.id}:${latestAction.operation}`
                                  ? mt('chronos_retrying', 'retrying')
                                  : mt('chronos_retry_latest_action', 'retry latest action')}
                              </button>
                            )}
                          </>
                        );
                      })()}
                      <div className="flex flex-wrap gap-2 rounded-lg border border-emerald-300/10 bg-emerald-400/[0.04] px-2 py-2">
                        <div className="w-full text-[9px] uppercase tracking-[0.18em] text-emerald-200/50">
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
                          <div className="w-full text-[10px] text-white/40">
                            {safeDisabledReason}
                          </div>
                        )}
                      </div>
                      <div className="flex flex-wrap gap-2 rounded-lg border border-red-300/10 bg-red-400/[0.04] px-2 py-2">
                        <div className="w-full text-[9px] uppercase tracking-[0.18em] text-red-200/50">
                          {mt(
                            'chronos_risky_actions_approval_required',
                            'risky actions · approval required'
                          )}
                        </div>
                        {riskySurfaceActions.map((action) => (
                          <button
                            key={action.operation}
                            type="button"
                            onClick={() => runSurfaceControl(surface.id, action.operation)}
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
                          <div className="w-full text-[10px] text-white/40">
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

        <Panel title={mt('chronos_control_model', 'Control Model')}>
          <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-4 text-[11px] leading-6 text-white/55">
            {mt(
              'chronos_control_model_description',
              'Chronos is a control surface. It does not mutate mission or runtime state directly. Each button issues a deterministic backend action through mission_controller, agent-runtime-supervisor, or surface_runtime, then refreshes the control-plane view.'
            )}
          </div>
        </Panel>
      </section>

      <section className="grid gap-4">
        <Panel title={mt('chronos_live_agent_conversation', 'Agent Traffic')}>
          <div className="mb-3 flex flex-wrap gap-2">
            <button
              type="button"
              onClick={() => {
                setMessageMissionFilter('all');
                setSelectedMissionId(null);
              }}
              className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.18em] transition ${
                messageMissionFilter === 'all'
                  ? 'border-cyan-300/20 bg-cyan-400/10 text-cyan-100/85'
                  : 'border-white/10 bg-white/5 text-white/45 hover:bg-white/10'
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
                    ? 'border-cyan-300/20 bg-cyan-400/10 text-cyan-100/85'
                    : 'border-white/10 bg-white/5 text-white/45 hover:bg-white/10'
                }`}
              >
                {mission.missionId}
              </button>
            ))}
          </div>
          <div className="space-y-3">
            {filteredAgentMessages.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                {mt(
                  'chronos_no_mission_scoped_messages',
                  'No mission-scoped agent messages observed yet.'
                )}
              </div>
            ) : (
              filteredAgentMessages.map((message, index) => (
                <div
                  key={`${message.agentId}-${message.ts}-${index}`}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.2em] ${messageToneClass(message.tone)}`}
                    >
                      {messageTypeLabel(message.type)}
                    </div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">
                      {message.agentId}
                    </div>
                    {message.teamRole && (
                      <div className="rounded-full border border-white/8 bg-white/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] text-white/45">
                        {message.teamRole}
                      </div>
                    )}
                    {message.missionId && (
                      <div className="text-[10px] text-white/35">{message.missionId}</div>
                    )}
                    <div className="ml-auto text-[9px] font-mono text-white/30">
                      {new Date(message.ts).toLocaleString()}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] leading-6 text-white/82">{message.content}</div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] text-white/28">
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

        <Panel title={mt('chronos_selected_mission_thread', 'Selected Mission Thread')}>
          <div className="mb-3 flex flex-wrap items-center gap-3 text-[10px] uppercase tracking-[0.18em] text-white/45">
            <span>
              {effectiveMissionId
                ? `thread view · ${effectiveMissionId}`
                : mt(
                    'chronos_select_mission_to_inspect_thread',
                    'select a mission to inspect a unified thread'
                  )}
            </span>
            <span className="rounded-full border border-white/8 bg-white/5 px-2 py-1 text-[9px] tracking-[0.16em] text-white/55">
              {missionPinStatusLabel}
            </span>
          </div>
          <div className="space-y-3">
            {!effectiveMissionId || missionThread.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                {mt(
                  'chronos_no_unified_mission_thread',
                  'No unified mission thread is available yet.'
                )}
              </div>
            ) : (
              missionThread.map((entry, index) => (
                <div
                  key={`${entry.type}-${entry.agentId}-${entry.ts}-${index}`}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div
                      className={`rounded-full border px-2 py-1 text-[9px] uppercase tracking-[0.2em] ${messageToneClass(entry.tone)}`}
                    >
                      {messageTypeLabel(entry.type)}
                    </div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">
                      {entry.label}
                    </div>
                    {entry.teamRole && (
                      <div className="rounded-full border border-white/8 bg-white/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] text-white/45">
                        {entry.teamRole}
                      </div>
                    )}
                    <div className="ml-auto text-[9px] font-mono text-white/30">
                      {new Date(entry.ts).toLocaleString()}
                    </div>
                  </div>
                  <div className="mt-2 text-[11px] leading-6 text-white/82">{entry.content}</div>
                  <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] text-white/28">
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

        <Panel title={mt('chronos_a2a_handoff_trail', 'A2A Handoff Trail')}>
          <div className="space-y-3">
            {filteredA2AHandoffs.length === 0 ? (
              <div className="text-[11px] italic text-kyberion-gold/30">
                {mt(
                  'chronos_no_a2a_handoffs_for_filter',
                  'No A2A handoffs observed for the current mission filter.'
                )}
              </div>
            ) : (
              filteredA2AHandoffs.map((handoff, index) => (
                <div
                  key={`${handoff.sender}-${handoff.receiver}-${handoff.ts}-${index}`}
                  className="rounded-xl border border-white/5 bg-black/20 px-4 py-3"
                >
                  <div className="flex flex-wrap items-center gap-2">
                    <div className="rounded-full border border-cyan-300/15 bg-cyan-400/8 px-2 py-1 text-[9px] uppercase tracking-[0.2em] text-cyan-100/80">
                      a2a handoff
                    </div>
                    <div className="text-[10px] font-semibold uppercase tracking-[0.18em] text-white/70">
                      {handoff.sender} → {handoff.receiver}
                    </div>
                    {handoff.teamRole && (
                      <div className="rounded-full border border-white/8 bg-white/5 px-2 py-1 text-[9px] uppercase tracking-[0.16em] text-white/45">
                        {handoff.teamRole}
                      </div>
                    )}
                    <div className="ml-auto text-[9px] font-mono text-white/30">
                      {new Date(handoff.ts).toLocaleString()}
                    </div>
                  </div>
                  <div className="mt-2 text-[10px] uppercase tracking-[0.16em] text-white/35">
                    {mt('chronos_mission', 'mission')}: {handoff.missionId}
                    {handoff.intent
                      ? ` · ${mt('chronos_intent', 'intent')}: ${handoff.intent}`
                      : ''}
                    {handoff.performative ? ` · ${handoff.performative}` : ''}
                  </div>
                  {handoff.promptExcerpt && (
                    <div className="mt-2 text-[11px] leading-6 text-white/80">
                      {handoff.promptExcerpt}
                    </div>
                  )}
                  <div className="mt-2 flex flex-wrap gap-3 text-[9px] uppercase tracking-[0.16em] text-white/28">
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
    <div className="rounded-2xl border border-white/5 bg-black/25 px-4 py-4">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.25em] text-white/40">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-3 text-3xl font-semibold tracking-tight text-white/90">{value}</div>
      <div className="mt-1 text-[10px] text-white/35">{detail}</div>
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
    <div className="rounded-xl border border-white/5 bg-black/20 px-4 py-3">
      <div className="flex items-center gap-2 text-[10px] uppercase tracking-[0.22em] text-white/42">
        {icon}
        <span>{label}</span>
      </div>
      <div className="mt-2 text-2xl font-semibold tracking-tight text-white/88">{value}</div>
      <div className="mt-1 text-[10px] text-white/38">{detail}</div>
    </div>
  );
}

function Panel({ id, title, children }: { id?: string; title: string; children: ReactNode }) {
  return (
    <div id={id} className="rounded-2xl border border-white/5 bg-black/25 p-4 scroll-mt-6">
      <div className="mb-4 flex items-center justify-between gap-3">
        <div className="text-[10px] uppercase tracking-[0.3em] text-kyberion-gold/45">{title}</div>
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
    emerald: 'text-emerald-300/80',
    gold: 'text-kyberion-gold/80',
    red: 'text-red-300/80',
    cyan: 'text-cyan-300/80',
  }[accent];

  return (
    <div className="rounded-xl border border-white/5 bg-black/20 px-3 py-3">
      <div className="text-[9px] uppercase tracking-[0.22em] text-white/35">{label}</div>
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
