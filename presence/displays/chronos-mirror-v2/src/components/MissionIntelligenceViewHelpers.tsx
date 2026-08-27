import { buildAttentionItems, type AttentionItem } from '../lib/operator-console';
import { chronosSpeechLocale, resolveChronosLocale, uxMessage, uxText } from '../lib/ux-vocabulary';
import type {
  A2AHandoffSummary,
  AgentMessageSummary,
  ArtifactRecordSummary,
  ControlActionDefinition,
  ControlActionDetail,
  ControlActionSummary,
  DistillCandidateSummary,
  MissionSeedRecordSummary,
  MissionSummary,
  MissionThreadEntry,
  PendingApprovalSummary,
  ProjectRecordSummary,
  SurfaceSummary,
  WorkLoopPreview,
} from './MissionIntelligenceTypes';

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
      return !best || score > best.score ? { missionId: mission.missionId, score } : best;
    },
    null
  );
  return prioritized?.missionId || missions[0]?.missionId || null;
}

function surfaceStateLabel(value: string, locale: string): string {
  const keyByValue: Record<string, string> = {
    running: 'chronos_surface_running',
    stopped: 'chronos_surface_stopped',
    healthy: 'chronos_surface_healthy',
    unhealthy: 'chronos_surface_unhealthy',
    degraded: 'chronos_surface_degraded',
    unknown: 'chronos_surface_unknown',
  };
  const key = keyByValue[value.toLowerCase()];
  return key ? uxText(key, locale) : value;
}

export function getActionDefinition(
  actions: ControlActionDefinition[],
  operation: string
): ControlActionDefinition | null {
  return actions.find((action) => action.operation === operation) || null;
}

export function buildProjectWorkLoopPreview(project: ProjectRecordSummary): WorkLoopPreview {
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

export function buildMissionSeedWorkLoopPreview(seed: MissionSeedRecordSummary): WorkLoopPreview {
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

export function buildDistillCandidateWorkLoopPreview(
  candidate: DistillCandidateSummary
): WorkLoopPreview {
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

export function buildApprovalWorkLoopPreview(approval: PendingApprovalSummary): WorkLoopPreview {
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

export function buildArtifactWorkLoopPreview(artifact: ArtifactRecordSummary): WorkLoopPreview {
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

export function getLatestMissionControlAction(
  actions: ControlActionSummary[],
  missionId: string
): ControlActionSummary | null {
  return actions.find((action) => action.kind === 'mission' && action.target === missionId) || null;
}

export function getLatestSurfaceControlAction(
  actions: ControlActionSummary[],
  surfaceId: string
): ControlActionSummary | null {
  return actions.find((action) => action.kind === 'surface' && action.target === surfaceId) || null;
}

export function getGlobalSurfaceControlAction(
  actions: ControlActionSummary[]
): ControlActionSummary | null {
  return (
    actions.find((action) => action.kind === 'surface' && action.target === 'surface-runtime') ||
    null
  );
}

export function toDomId(prefix: 'mission' | 'surface', value: string): string {
  return `${prefix}-${value.replace(/[^a-zA-Z0-9_-]+/g, '-')}`;
}

export function ActionStatusBadge({ action }: { action: ControlActionSummary }) {
  const locale = resolveChronosLocale();
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
      {surfaceOperationLabel(action.operation, locale)} · {actionStatusLabel(action.status, locale)}
    </div>
  );
}

export function surfaceOperationLabel(operation: string, locale: string) {
  const keyByOperation: Record<string, string> = {
    route_to_approvals: 'chronos_action_route_to_approvals',
    mission_control_requested: 'chronos_action_mission_control_requested',
    resume: 'chronos_action_resume',
  };
  const key = keyByOperation[operation];
  return key ? uxText(key, locale) : operation;
}

export function missionActionLabel(action: ControlActionDefinition, locale: string): string {
  const keyByOperation: Record<string, string> = {
    refresh_team: 'chronos_action_refresh_team',
    prewarm: 'chronos_action_prewarm',
    prewarm_runtime: 'chronos_action_prewarm',
    staff: 'chronos_action_staff',
    assign_staff: 'chronos_action_staff',
    resume: 'chronos_action_resume',
    resume_mission: 'chronos_action_resume',
    pause: 'chronos_action_pause',
    finish: 'chronos_action_finish',
    cancel: 'chronos_action_cancel',
    retry: 'chronos_action_retry',
  };
  const operation = action.operation.toLowerCase();
  const label = action.label.toLowerCase();
  const key =
    keyByOperation[operation] ||
    (operation.includes('prewarm') || label.includes('prewarm')
      ? keyByOperation.prewarm
      : operation.includes('staff') || label.includes('staff')
        ? keyByOperation.staff
        : operation.includes('resume') || label.includes('resume')
          ? keyByOperation.resume
          : operation.includes('pause') || label.includes('pause')
            ? keyByOperation.pause
            : operation.includes('finish') || label.includes('finish')
              ? keyByOperation.finish
              : operation.includes('cancel') || label.includes('cancel')
                ? keyByOperation.cancel
                : undefined);
  return key ? uxText(key, locale) : action.label;
}

export function missionStatusLabel(value: string | undefined, locale: string): string {
  const normalized = (value || '').toLowerCase().replace(/[- ]/g, '_');
  const keyByStatus: Record<string, string> = {
    active: 'chronos_status_active',
    completed: 'chronos_status_completed',
    complete: 'chronos_status_completed',
    paused: 'chronos_status_paused',
    failed: 'chronos_status_failed',
    planned: 'chronos_status_planned',
    planning_pending: 'chronos_status_planning_pending',
    pending: 'chronos_status_planning_pending',
  };
  const key = keyByStatus[normalized];
  return key ? uxText(key, locale) : value || uxText('chronos_unknown', locale);
}

export function attentionSourceLabel(item: AttentionItem, locale: string): string {
  const keyByTargetType: Partial<Record<AttentionItem['targetType'], string>> = {
    mission: 'chronos_mission_control',
    runtime: 'chronos_runtime_incidents',
    surface: 'chronos_surface_control',
    delivery: 'chronos_delivery',
    approval: 'chronos_approvals_title',
  };
  const key = keyByTargetType[item.targetType];
  return key ? uxText(key, locale) : item.sourceLabel || uxText('chronos_control_plane', locale);
}

export function attentionReasonLabel(item: AttentionItem, locale: string): string {
  if (item.targetType === 'mission') {
    const match = /^(.*?) · next tasks (\d+)$/.exec(item.reason);
    if (match) {
      return uxMessage(
        'chronos_attention_mission_reason',
        { status: missionStatusLabel(match[1], locale), count: Number(match[2]) },
        '{status} · {count} next tasks',
        locale
      );
    }
  }
  if (item.targetType === 'surface') {
    const separatorIndex = item.reason.indexOf(' · ');
    if (separatorIndex > 0) {
      return uxMessage(
        'chronos_attention_surface_reason',
        {
          status: surfaceStateLabel(item.reason.slice(0, separatorIndex), locale),
          summary: item.reason.slice(separatorIndex + 3),
        },
        '{status} · {summary}',
        locale
      );
    }
  }
  return item.reason;
}

export function attentionNextStepLabel(item: AttentionItem, locale: string): string {
  const keyByTargetType: Partial<Record<AttentionItem['targetType'], string>> = {
    mission: 'chronos_attention_mission_next_step',
    runtime: 'chronos_runtime_needs_review',
    surface: 'chronos_attention_surface_next_step',
    delivery: 'chronos_delivery_needs_review',
    approval: 'chronos_attention_approval_next_step',
  };
  const key = keyByTargetType[item.targetType];
  return key ? uxText(key, locale) : item.nextStep || '';
}

export function attentionActionLabel(item: AttentionItem, locale: string): string {
  if (item.targetType === 'runtime') {
    return uxText(
      item.remediationAction === 'restart_runtime_lease'
        ? 'chronos_restart_runtime'
        : 'chronos_cleanup_lease',
      locale
    );
  }
  const keyByTargetType: Partial<Record<AttentionItem['targetType'], string>> = {
    mission: 'chronos_focus_mission',
    surface: 'chronos_review_surface',
    delivery: 'chronos_open_delivery',
    approval: 'chronos_review_approval',
  };
  const key = keyByTargetType[item.targetType];
  return key ? uxText(key, locale) : item.actionLabel || '';
}

export function actionStatusLabel(status: string, locale: string) {
  const keyByStatus: Record<string, string> = {
    queued: 'chronos_action_queued',
    completed: 'chronos_action_completed',
    failed: 'chronos_action_failed',
  };
  const key = keyByStatus[status];
  return key ? uxText(key, locale) : status;
}

export function messageToneClass(tone: AgentMessageSummary['tone']): string {
  if (tone === 'request') return 'kb-border-accent kb-surface-accent kb-text-accent';
  if (tone === 'response')
    return 'kb-status-positive-border kb-status-positive-surface kb-status-positive';
  return 'kb-status-warning-border kb-status-warning-surface kb-status-warning';
}

export function messageTypeLabel(type: AgentMessageSummary['type']): string {
  if (type === 'handoff') return 'a2a handoff';
  return type;
}

export function buildMissionThread(
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

export function ActionDetailList({
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

export function ActionGuidance({
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

export function actionButtonClass(kind: 'safe' | 'risky'): string {
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

export function missionSummaryBadgeClass(tone: MissionSummary['controlTone']): string {
  if (tone === 'pending') return 'kb-status-info-surface kb-status-info';
  if (tone === 'ready') return 'kb-surface-accent kb-text-accent';
  if (tone === 'attention') return 'kb-status-warning-surface kb-status-warning';
  return 'kb-status-positive-surface kb-status-positive';
}

export function surfaceSummaryBadgeClass(tone: SurfaceSummary['controlTone']): string {
  if (tone === 'pending') return 'kb-status-info-surface kb-status-info';
  if (tone === 'stable') return 'kb-status-positive-surface kb-status-positive';
  if (tone === 'offline') return 'kb-surface-raised kb-text-secondary';
  return 'kb-status-warning-surface kb-status-warning';
}
