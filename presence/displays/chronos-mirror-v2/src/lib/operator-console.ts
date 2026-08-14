export interface OperatorMissionSummary {
  missionId: string;
  nextTaskCount: number;
  controlSummary: string;
  controlTone: 'planning' | 'ready' | 'attention' | 'pending';
}

export interface OperatorRuntimeDoctorFinding {
  severity: 'warning' | 'critical';
  agentId: string;
  ownerId: string;
  reason: string;
  recommendedAction: 'stop_runtime' | 'restart_runtime';
}

export interface OperatorSurfaceSummary {
  id: string;
  health: string;
  controlSummary: string;
  controlTone: 'stable' | 'attention' | 'offline' | 'pending';
}

export interface OperatorOutboxMessage {
  message_id: string;
  surface: 'slack' | 'chronos';
  text: string;
}

export interface OperatorSecretApprovalSummary {
  id: string;
  title: string;
  serviceId: string;
  secretKey: string;
  riskLevel: 'low' | 'medium' | 'high' | 'critical';
}

export interface AttentionItem {
  id: string;
  title: string;
  reason: string;
  tone: 'critical' | 'warning' | 'info';
  actionLabel?: string;
  targetType: 'mission' | 'runtime' | 'surface' | 'delivery' | 'approval';
  targetId: string;
  sourceLabel?: string;
  nextStep?: string;
  remediationAction?: 'cleanup_runtime_lease' | 'restart_runtime_lease';
}

export interface SurfaceRole {
  labelKey: string;
  valueKey: string;
  detailKey: string;
}

export interface MissionCycleStep {
  labelKey: string;
  detailKey: string;
}

export interface OperatorViewLink {
  label: string;
  targetId: string;
  detail: string;
}

export interface OperatorScenarioPreset {
  label: string;
  targetId: string;
  detail: string;
  actionLabel: string;
  surface: 'mission-intelligence' | 'focused-operator';
  nextStep: string;
}

export const SURFACE_ROLES: SurfaceRole[] = [
  {
    labelKey: 'chronos_role_request_label',
    valueKey: 'chronos_role_request_value',
    detailKey: 'chronos_role_request_detail',
  },
  {
    labelKey: 'chronos_role_review_label',
    valueKey: 'chronos_role_review_value',
    detailKey: 'chronos_role_review_detail',
  },
  {
    labelKey: 'chronos_role_activity_label',
    valueKey: 'chronos_role_activity_value',
    detailKey: 'chronos_role_activity_detail',
  },
  {
    labelKey: 'chronos_role_detail_label',
    valueKey: 'chronos_role_detail_value',
    detailKey: 'chronos_role_detail_detail',
  },
];

export const MISSION_CYCLE: MissionCycleStep[] = [
  { labelKey: 'chronos_cycle_request', detailKey: 'chronos_cycle_request_detail' },
  { labelKey: 'chronos_cycle_plan', detailKey: 'chronos_cycle_plan_detail' },
  { labelKey: 'chronos_cycle_execute', detailKey: 'chronos_cycle_execute_detail' },
  { labelKey: 'chronos_cycle_explain', detailKey: 'chronos_cycle_explain_detail' },
  { labelKey: 'chronos_cycle_review', detailKey: 'chronos_cycle_review_detail' },
  { labelKey: 'chronos_cycle_record', detailKey: 'chronos_cycle_record_detail' },
];

export const OPERATOR_VIEW_LINKS: OperatorViewLink[] = [
  {
    label: 'Needs Attention',
    targetId: 'needs-attention',
    detail: 'Start with blockers and incidents.',
  },
  {
    label: 'Mission Control',
    targetId: 'mission-control-plane',
    detail: 'Inspect active missions and interventions.',
  },
  {
    label: 'Computer Sessions',
    targetId: 'computer-sessions',
    detail: 'Inspect browser and terminal sessions in one control view.',
  },
  {
    label: 'Runtime Topology',
    targetId: 'runtime-topology-map',
    detail: 'See owners, runtimes, and recent flow.',
  },
  {
    label: 'Runtime Governance',
    targetId: 'runtime-lease-doctor',
    detail: 'Review leases and remediation actions.',
  },
  {
    label: 'Delivery Exceptions',
    targetId: 'recent-surface-outbox',
    detail: 'Check outbox and operator-visible delivery residue.',
  },
  {
    label: 'Secret Approvals',
    targetId: 'secret-approval-queue',
    detail: 'Review pending governed secret changes.',
  },
  {
    label: 'Audit Trail',
    targetId: 'owner-summaries',
    detail: 'Review recent control and ownership history.',
  },
  {
    label: 'Trace Viewer',
    targetId: 'trace-viewer',
    detail: 'Inspect pipeline and actuator execution traces. Download OTel-compatible JSON.',
  },
];

export const OPERATOR_SCENARIO_PRESETS: OperatorScenarioPreset[] = [
  {
    label: 'Review blockers',
    targetId: 'needs-attention',
    detail: 'See blockers.',
    actionLabel: 'Open blockers',
    surface: 'mission-intelligence',
    nextStep: 'Open the top blocker, then branch to mission, runtime, or delivery.',
  },
  {
    label: 'Start a mission',
    targetId: 'mission-control-plane',
    detail: 'Open mission control.',
    actionLabel: 'Open mission control',
    surface: 'mission-intelligence',
    nextStep: 'Check the queue, then open the mission that needs attention.',
  },
  {
    label: 'Check runtime health',
    targetId: 'runtime-lease-doctor',
    detail: 'Check runtimes.',
    actionLabel: 'Review governance',
    surface: 'mission-intelligence',
    nextStep: 'Read the doctor first, then remediate only if needed.',
  },
  {
    label: 'Inspect delivery',
    targetId: 'recent-surface-outbox',
    detail: 'Check delivery.',
    actionLabel: 'Open delivery',
    surface: 'mission-intelligence',
    nextStep: 'Inspect the outbox and clear only what is stuck.',
  },
  {
    label: 'Investigate traces',
    targetId: 'trace-viewer',
    detail: 'Jump to traces.',
    actionLabel: 'Open trace viewer',
    surface: 'focused-operator',
    nextStep: 'Filter by error, then open raw trace if needed.',
  },
  {
    label: 'Review sessions',
    targetId: 'computer-sessions',
    detail: 'Check sessions.',
    actionLabel: 'Open sessions',
    surface: 'focused-operator',
    nextStep: 'Pick the live browser or terminal context before intervening.',
  },
  {
    label: 'Handle approvals',
    targetId: 'secret-approval-queue',
    detail: 'Review approvals.',
    actionLabel: 'Open approvals',
    surface: 'mission-intelligence',
    nextStep: 'Confirm the request, then review the pending roles.',
  },
];

export function buildAttentionItems(input: {
  missions: OperatorMissionSummary[];
  runtimeDoctor: OperatorRuntimeDoctorFinding[];
  surfaces: OperatorSurfaceSummary[];
  outbox: OperatorOutboxMessage[];
  secretApprovals?: OperatorSecretApprovalSummary[];
}): AttentionItem[] {
  const missionExceptions = input.missions
    .filter((mission) => mission.controlTone === 'attention' || mission.controlTone === 'pending')
    .slice(0, 2)
    .map((mission): AttentionItem => ({
      id: `mission-${mission.missionId}`,
      title: mission.missionId,
      reason: `${mission.controlSummary} · next tasks ${mission.nextTaskCount}`,
      tone: mission.controlTone === 'attention' ? 'critical' : 'warning',
      actionLabel: 'focus mission',
      targetType: 'mission',
      targetId: mission.missionId,
      sourceLabel: 'Mission control',
      nextStep: 'Open Mission Control and inspect the control summary and next tasks.',
    }));

  const runtimeExceptions = input.runtimeDoctor.slice(0, 2).map((finding): AttentionItem => ({
    id: `runtime-${finding.agentId}`,
    title: finding.agentId,
    reason: finding.reason,
    tone: finding.severity === 'critical' ? 'critical' : 'warning',
    actionLabel:
      finding.recommendedAction === 'restart_runtime' ? 'restart runtime' : 'clean up lease',
    targetType: 'runtime',
    targetId: finding.agentId,
    sourceLabel: 'Runtime doctor',
    nextStep:
      finding.recommendedAction === 'restart_runtime'
        ? 'Confirm the lease is stale, then restart the runtime.'
        : 'Inspect the owner and clean up the stale lease.',
    remediationAction:
      finding.recommendedAction === 'restart_runtime'
        ? 'restart_runtime_lease'
        : 'cleanup_runtime_lease',
  }));

  const surfaceExceptions = input.surfaces
    .filter((surface) => surface.controlTone === 'attention' || surface.health === 'unhealthy')
    .slice(0, 1)
    .map((surface): AttentionItem => ({
      id: `surface-${surface.id}`,
      title: surface.id,
      reason: `${surface.health} · ${surface.controlSummary}`,
      tone: 'warning',
      actionLabel: 'review surface',
      targetType: 'surface',
      targetId: surface.id,
      sourceLabel: 'Surface health',
      nextStep: 'Open Surface Control and inspect health before changing state.',
    }));

  const deliveryExceptions = input.outbox.slice(0, 1).map((message): AttentionItem => ({
    id: `delivery-${message.message_id}`,
    title: `${message.surface} outbox`,
    reason: message.text,
    tone: 'info',
    actionLabel: 'open delivery',
    targetType: 'delivery',
    targetId: message.message_id,
    sourceLabel: 'Delivery outbox',
    nextStep: 'Open Delivery Exceptions and inspect the undelivered message.',
  }));

  const secretApprovals = (input.secretApprovals || [])
    .slice(0, 1)
    .map((request): AttentionItem => ({
      id: `secret-${request.id}`,
      title: `${request.serviceId} secret approval`,
      reason: `${request.title} · ${request.secretKey} · ${request.riskLevel}`,
      tone: request.riskLevel === 'critical' || request.riskLevel === 'high' ? 'warning' : 'info',
      actionLabel: 'review approval',
      targetType: 'approval',
      targetId: request.id,
      sourceLabel: 'Approval queue',
      nextStep: 'Open Approvals and review the request details before deciding.',
    }));

  return [
    ...missionExceptions,
    ...runtimeExceptions,
    ...surfaceExceptions,
    ...deliveryExceptions,
    ...secretApprovals,
  ].slice(0, 6);
}
