export interface OperatorMissionSummary {
  missionId: string;
  nextTaskCount: number;
  controlSummary: string;
  controlTone: "planning" | "ready" | "attention" | "pending";
}

export interface OperatorRuntimeDoctorFinding {
  severity: "warning" | "critical";
  agentId: string;
  ownerId: string;
  reason: string;
  recommendedAction: "stop_runtime" | "restart_runtime";
}

export interface OperatorSurfaceSummary {
  id: string;
  health: string;
  controlSummary: string;
  controlTone: "stable" | "attention" | "offline" | "pending";
}

export interface OperatorOutboxMessage {
  message_id: string;
  surface: "slack" | "chronos";
  text: string;
}

export interface OperatorSecretApprovalSummary {
  id: string;
  title: string;
  serviceId: string;
  secretKey: string;
  riskLevel: "low" | "medium" | "high" | "critical";
}

export interface AttentionItem {
  id: string;
  title: string;
  reason: string;
  tone: "critical" | "warning" | "info";
  actionLabel?: string;
  targetType: "mission" | "runtime" | "surface" | "delivery" | "approval";
  targetId: string;
  remediationAction?: "cleanup_runtime_lease" | "restart_runtime_lease";
}

export interface SurfaceRole {
  label: string;
  value: string;
  detail: string;
}

export interface MissionCycleStep {
  label: string;
  detail: string;
}

export interface OperatorViewLink {
  label: string;
  targetId: string;
  detail: string;
}

export const SURFACE_ROLES: SurfaceRole[] = [
  {
    label: "Command Surface",
    value: "Intent",
    detail: "Human requests enter the system here and become missions.",
  },
  {
    label: "Control Surface",
    value: "Intervention",
    detail: "Chronos explains risk, flow, and when a human should step in.",
  },
  {
    label: "Performance Surface",
    value: "Presence",
    detail: "Live expressive output connects agent behavior back to people.",
  },
  {
    label: "Work Surface",
    value: "Drill-down",
    detail: "A2UI renders focused operational views without redefining the shell.",
  },
];

export const MISSION_CYCLE: MissionCycleStep[] = [
  { label: "Intent", detail: "A human request starts the loop." },
  { label: "Mission", detail: "The request becomes a durable, inspectable contract." },
  { label: "Execution", detail: "Agents and actuators perform governed work." },
  { label: "Explanation", detail: "Surfaces make state and reasoning legible." },
  { label: "Inspection", detail: "Outcomes, actions, and anomalies remain reviewable." },
  { label: "Distillation", detail: "Knowledge is captured to improve the next mission." },
];

export const OPERATOR_VIEW_LINKS: OperatorViewLink[] = [
  {
    label: "Needs Attention",
    targetId: "needs-attention",
    detail: "Start with blockers and incidents.",
  },
  {
    label: "Mission Control",
    targetId: "mission-control-plane",
    detail: "Inspect active missions and interventions.",
  },
  {
    label: "Computer Sessions",
    targetId: "computer-sessions",
    detail: "Inspect browser and terminal sessions in one control view.",
  },
  {
    label: "Runtime Topology",
    targetId: "runtime-topology-map",
    detail: "See owners, runtimes, and recent flow.",
  },
  {
    label: "Runtime Governance",
    targetId: "runtime-lease-doctor",
    detail: "Review leases and remediation actions.",
  },
  {
    label: "Delivery Exceptions",
    targetId: "recent-surface-outbox",
    detail: "Check outbox and operator-visible delivery residue.",
  },
  {
    label: "Secret Approvals",
    targetId: "secret-approval-queue",
    detail: "Review pending governed secret changes.",
  },
  {
    label: "Audit Trail",
    targetId: "owner-summaries",
    detail: "Review recent control and ownership history.",
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
    .filter((mission) => mission.controlTone === "attention" || mission.controlTone === "pending")
    .slice(0, 2)
    .map((mission): AttentionItem => ({
      id: `mission-${mission.missionId}`,
      title: mission.missionId,
      reason: `${mission.controlSummary} · next tasks ${mission.nextTaskCount}`,
      tone: mission.controlTone === "attention" ? "critical" : "warning",
      actionLabel: "focus mission",
      targetType: "mission",
      targetId: mission.missionId,
    }));

  const runtimeExceptions = input.runtimeDoctor
    .slice(0, 2)
    .map((finding): AttentionItem => ({
      id: `runtime-${finding.agentId}`,
      title: finding.agentId,
      reason: finding.reason,
      tone: finding.severity === "critical" ? "critical" : "warning",
      actionLabel: finding.recommendedAction === "restart_runtime" ? "restart runtime" : "clean up lease",
      targetType: "runtime",
      targetId: finding.agentId,
      remediationAction: finding.recommendedAction === "restart_runtime" ? "restart_runtime_lease" : "cleanup_runtime_lease",
    }));

  const surfaceExceptions = input.surfaces
    .filter((surface) => surface.controlTone === "attention" || surface.health === "unhealthy")
    .slice(0, 1)
    .map((surface): AttentionItem => ({
      id: `surface-${surface.id}`,
      title: surface.id,
      reason: `${surface.health} · ${surface.controlSummary}`,
      tone: "warning",
      actionLabel: "review surface",
      targetType: "surface",
      targetId: surface.id,
    }));

  const deliveryExceptions = input.outbox
    .slice(0, 1)
    .map((message): AttentionItem => ({
      id: `delivery-${message.message_id}`,
      title: `${message.surface} outbox`,
      reason: message.text,
      tone: "info",
      actionLabel: "open delivery",
      targetType: "delivery",
      targetId: message.message_id,
    }));

  const secretApprovals = (input.secretApprovals || [])
    .slice(0, 1)
    .map((request): AttentionItem => ({
      id: `secret-${request.id}`,
      title: `${request.serviceId} secret approval`,
      reason: `${request.title} · ${request.secretKey} · ${request.riskLevel}`,
      tone: request.riskLevel === "critical" || request.riskLevel === "high" ? "warning" : "info",
      actionLabel: "review approval",
      targetType: "approval",
      targetId: request.id,
    }));

  return [
    ...missionExceptions,
    ...runtimeExceptions,
    ...surfaceExceptions,
    ...deliveryExceptions,
    ...secretApprovals,
  ].slice(0, 6);
}
