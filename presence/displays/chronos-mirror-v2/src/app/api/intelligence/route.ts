import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { getChronosAccessRoleOrThrow, guardRequest, requireChronosAccess, roleToMissionRole } from "../../../lib/api-guard";
import { collectA2AHandoffs, collectAgentMessages, type AgentMessageSummary, type A2AHandoffSummary } from "../../../lib/agent-message-feed";
import { collectBrowserConversationSessions, collectBrowserSessions, type BrowserConversationSessionSummary, type BrowserSessionSummary } from "../../../lib/intelligence-observations";
import { extractMissionDependencies, normalizeMissionAssets, parseTaskBoard, summarizeNextTasks } from "../../../lib/mission-progress";
import { applyBrowserSessionControl } from "../../../lib/browser-session-control";
import { buildRuntimeTopology } from "../../../lib/runtime-topology";
import { collectComputerSessions, type ComputerSessionSummary } from "../../../lib/computer-sessions";
import {
  buildExecutionEnv,
  clearSurfaceOutboxMessage,
  createDistillCandidateRecord,
  decideApprovalRequest,
  enqueueSurfaceNotification,
  emitChannelSurfaceEvent,
  emitMissionOrchestrationObservation,
  enqueueMissionOrchestrationEvent,
  ledger,
  listArtifactRecords,
  listApprovalRequests,
  listAgentRuntimeLeaseSummaries,
  loadDistillCandidateRecord,
  listMissionSeedRecords,
  listDistillCandidateRecords,
  listProjectRecords,
  listAgentRuntimeSnapshots,
  listServiceBindingRecords,
  listSurfaceOutboxMessages,
  loadMissionSeedRecord,
  loadProjectRecord,
  loadSurfaceManifest,
  loadSurfaceState,
  normalizeSurfaceDefinition,
  pathResolver,
  probeSurfaceHealth,
  savePromotedMemoryRecord,
  restartAgentRuntime,
  safeExec,
  safeStat,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
  saveDistillCandidateRecord,
  saveMissionSeedRecord,
  saveProjectRecord,
  startMissionOrchestrationWorker,
  stopAgentRuntime,
  updateDistillCandidateRecord,
} from "@agent/core";

interface RuntimeTopologySurfaceInput {
  id: string;
  kind: string;
  running: boolean;
  startupMode?: string;
  pid?: number;
}

interface MissionSummary {
  missionId: string;
  status: string;
  tier: string;
  missionType?: string;
  planReady: boolean;
  nextTaskCount: number;
  controlSummary: string;
  controlTone: "planning" | "ready" | "attention" | "pending";
  controlRequestedBy?: string;
}

interface MissionProgressSummary {
  missionId: string;
  boardStatus: string;
  boardStepsTotal: number;
  boardStepsDone: number;
  boardStepsActive: number;
  boardStepsPending: number;
  nextTasksTotal: number;
  nextTasksPending: number;
  nextTasksCompleted: number;
  dependencies: string[];
  generatedAssets: Array<{
    path: string;
    category: "deliverables" | "artifacts" | "outputs" | "evidence";
    sizeBytes: number;
    updatedAt: string;
  }>;
}

interface RuntimeLeaseSummary {
  agent_id: string;
  owner_id: string;
  owner_type: string;
  metadata?: Record<string, unknown>;
}

interface RuntimeDoctorFinding {
  severity: "warning" | "critical";
  agentId: string;
  ownerId: string;
  reason: string;
  recommendedAction: "stop_runtime" | "restart_runtime";
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
  surface: "slack" | "chronos";
  correlation_id: string;
  channel: string;
  thread_ts: string;
  text: string;
  source: "surface" | "nerve" | "system";
  created_at: string;
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
  controlTone: "stable" | "attention" | "offline" | "pending";
  controlRequestedBy?: string;
}

interface SecretApprovalSummary {
  id: string;
  title: string;
  summary: string;
  storageChannel: string;
  requestedAt: string;
  requestedBy: string;
  serviceId: string;
  secretKey: string;
  mutation: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  requiresStrongAuth: boolean;
  pendingRoles: string[];
  kind?: "secret_mutation" | "computer_action";
}

interface PendingApprovalSummary {
  id: string;
  kind: "channel-approval" | "secret_mutation";
  channel: string;
  storageChannel: string;
  requestedAt: string;
  requestedBy: string;
  title: string;
  summary: string;
  riskLevel: "low" | "medium" | "high" | "critical";
  pendingRoles: string[];
  missionId?: string;
  serviceId?: string;
}

interface BrowserSessionView extends BrowserSessionSummary {}
interface BrowserConversationSessionView extends BrowserConversationSessionSummary {}
interface ComputerSessionView extends ComputerSessionSummary {}

interface A2AHandoffView extends A2AHandoffSummary {}

interface ControlActionSummary {
  event_id?: string;
  ts: string;
  kind: "mission" | "surface";
  target: string;
  operation: string;
  status: "queued" | "completed" | "failed";
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
  why?: string;
  error?: string;
}

interface ControlActionDefinition {
  operation: string;
  label: string;
  risk: "safe" | "risky";
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

function inferMissionSeedPromotionTargetKind(seed: {
  mission_type_hint?: string;
  specialist_id?: string;
}): "pattern" | "sop_candidate" | "knowledge_hint" {
  const hint = String(seed.mission_type_hint || "").toLowerCase();
  if (hint === "verification" || seed.specialist_id === "service-operator") {
    return "sop_candidate";
  }
  if (hint === "architecture" || hint === "implementation") {
    return "pattern";
  }
  return "knowledge_hint";
}

function buildMissionSeedPromotionMetadata(seed: {
  seed_id: string;
  title: string;
  summary: string;
  specialist_id: string;
  mission_type_hint?: string;
  source_task_session_id?: string;
}, project: {
  project_id: string;
  name: string;
  kickoff_brief?: string;
}): Record<string, unknown> {
  const targetKind = inferMissionSeedPromotionTargetKind(seed);
  if (targetKind === "pattern") {
    return {
      promotion_source: "mission_seed",
      applicability: [
        "durable mission promotion",
        project.name,
        seed.mission_type_hint || "general",
      ],
      reusable_steps: [
        "Review the project kickoff and current durable work candidates.",
        "Select the mission seed with the clearest specialist and outcome fit.",
        "Promote the seed into a governed mission and capture the resulting mission id.",
      ],
      expected_outcome: `${seed.title} is promoted into a durable mission with explicit project ownership.`,
      recommended_refs: [
        `project:${project.project_id}`,
        `mission_seed:${seed.seed_id}`,
      ],
    };
  }
  if (targetKind === "sop_candidate") {
    return {
      promotion_source: "mission_seed",
      procedure_steps: [
        "Review the seed and confirm the project context is ready for durable execution.",
        "Start the governed mission with the appropriate mission type and project relationship.",
        "Record the promoted mission id and notify the surface.",
      ],
      safety_notes: [
        "Promote durable work only from an approved control plane action.",
        "Keep the project relationship and evidence trail attached to the promoted mission.",
      ],
      escalation_conditions: [
        "The parent project record is missing.",
        "mission_controller fails to start the durable mission.",
        "The promoted mission id cannot be written back to the seed or project.",
      ],
    };
  }
  return {
    promotion_source: "mission_seed",
    hint_scope: "mission promotion",
    hint_triggers: [
      seed.title,
      project.name,
      seed.mission_type_hint || "durable work",
    ],
    recommended_refs: [
      `project:${project.project_id}`,
      `mission_seed:${seed.seed_id}`,
      ...(seed.source_task_session_id ? [`task_session:${seed.source_task_session_id}`] : []),
    ],
    kickoff_brief: project.kickoff_brief || "",
  };
}

function buildLearnedNotificationText(input: {
  projectId?: string;
  language?: "ja" | "en";
}): string {
  if (!input.projectId) return "";
  const titles = listDistillCandidateRecords()
    .filter((candidate) => candidate.project_id === input.projectId && candidate.promoted_ref)
    .map((candidate) => candidate.title)
    .filter(Boolean)
    .filter((value, index, array) => array.indexOf(value) === index)
    .slice(0, 2);
  if (titles.length === 0) return "";
  if (input.language === "ja") {
    return ` 過去の learned pattern（${titles.join("、")}）も参照できます。`;
  }
  return ` Learned patterns such as ${titles.join(", ")} are also available.`;
}

function inferProjectIdForApproval(input: {
  missionId?: string;
  serviceId?: string;
}): string | undefined {
  const projects = listProjectRecords();
  if (input.missionId) {
    const byMission = projects.find((project) => (project.active_missions || []).includes(input.missionId || ""));
    if (byMission) return byMission.project_id;
  }
  if (input.serviceId) {
    const byService = projects.find((project) => (project.service_bindings || []).some((bindingId) => bindingId.includes(input.serviceId || "")));
    if (byService) return byService.project_id;
  }
  return undefined;
}

function buildApprovalDecisionText(input: {
  title: string;
  decision: "approved" | "rejected";
  missionId?: string;
  serviceId?: string;
}): string {
  const projectId = inferProjectIdForApproval({ missionId: input.missionId, serviceId: input.serviceId });
  const learnedText = buildLearnedNotificationText({ projectId, language: "en" });
  if (input.decision === "approved") {
    return `${input.title} was approved. The requested work can proceed now.${learnedText}`;
  }
  return `${input.title} was rejected. The requested work will stay blocked until it is revised.`;
}

function readJson<T = any>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  return JSON.parse(safeReadFile(filePath, { encoding: "utf8" }) as string) as T;
}

function collectActiveMissions(): MissionSummary[] {
  const missionRoots = [
    { dir: pathResolver.active("missions/public"), tier: "public" },
    { dir: pathResolver.active("missions/confidential"), tier: "confidential" },
  ];
  const missions: MissionSummary[] = [];

  for (const root of missionRoots) {
    try {
      if (!safeExistsSync(root.dir)) continue;
      for (const item of safeReaddir(root.dir)) {
        const missionPath = path.join(root.dir, item);
        const state = readJson<any>(path.join(missionPath, "mission-state.json"));
        if (!state || state.status !== "active") continue;
        const nextTasks = readJson<any[]>(path.join(missionPath, "NEXT_TASKS.json")) || [];
        const planReady = safeExistsSync(path.join(missionPath, "PLAN.md"));
        const nextTaskCount = Array.isArray(nextTasks) ? nextTasks.length : 0;
        const controlSummary = planReady
          ? nextTaskCount > 0
            ? "execution ready"
            : "plan ready"
          : "planning pending";
        const controlTone: MissionSummary["controlTone"] = planReady
          ? nextTaskCount > 0
            ? "ready"
            : "planning"
          : "attention";
        missions.push({
          missionId: state.mission_id || item,
          status: state.status,
          tier: state.tier || root.tier,
          missionType: state.mission_type,
          planReady,
          nextTaskCount,
          controlSummary,
          controlTone,
        });
      }
    } catch {
      // Skip roots that are unavailable to the current authority role.
    }
  }

  return missions.sort((a, b) => a.missionId.localeCompare(b.missionId));
}

function collectMissionProgress(activeMissions: MissionSummary[]): MissionProgressSummary[] {
  const missionRoots = [
    pathResolver.active("missions/public"),
    pathResolver.active("missions/confidential"),
  ];
  const summaries: MissionProgressSummary[] = [];

  for (const mission of activeMissions) {
    const missionPath = missionRoots
      .map((root) => path.join(root, mission.missionId))
      .find((candidate) => safeExistsSync(candidate));
    if (!missionPath) continue;

    const taskBoardPath = path.join(missionPath, "TASK_BOARD.md");
    const nextTasksPath = path.join(missionPath, "NEXT_TASKS.json");
    const statePath = path.join(missionPath, "mission-state.json");
    const taskBoard = safeExistsSync(taskBoardPath)
      ? String(safeReadFile(taskBoardPath, { encoding: "utf8" }) || "")
      : "";
    const nextTasks = readJson<Array<{ status?: string }>>(nextTasksPath) || [];
    const missionState = readJson<Record<string, unknown>>(statePath) || {};
    const board = parseTaskBoard(taskBoard);
    const nextTaskSummary = summarizeNextTasks(nextTasks);
    const generatedAssets: MissionProgressSummary["generatedAssets"] = [];
    for (const dirName of ["deliverables", "artifacts", "outputs", "evidence"] as const) {
      const dirPath = path.join(missionPath, dirName);
      if (!safeExistsSync(dirPath)) continue;
      for (const entry of safeReaddir(dirPath)) {
        const fullPath = path.join(dirPath, entry);
        try {
          const stats = safeStat(fullPath);
          if (stats.isFile()) {
            generatedAssets.push({
              path: `${dirName}/${entry}`,
              category: dirName,
              sizeBytes: stats.size,
              updatedAt: stats.mtime.toISOString(),
            });
          }
        } catch {
          // Ignore unreadable entries.
        }
      }
    }

    summaries.push({
      missionId: mission.missionId,
      ...board,
      ...nextTaskSummary,
      dependencies: extractMissionDependencies(missionState.relationships as Record<string, unknown> | undefined),
      generatedAssets: normalizeMissionAssets(generatedAssets),
    });
  }

  return summaries.sort((a, b) => a.missionId.localeCompare(b.missionId));
}

function collectRecentEvents() {
  const files = [
    pathResolver.shared("observability/channels/slack/missions.jsonl"),
    pathResolver.shared("observability/mission-control/orchestration-events.jsonl"),
  ];
  const lines: Array<{ ts: string; decision: string; mission_id?: string; why?: string }> = [];
  for (const file of files) {
    if (!safeExistsSync(file)) continue;
    const raw = safeReadFile(file, { encoding: "utf8" }) as string;
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as any;
        lines.push({
          ts: event.ts || new Date().toISOString(),
          decision: event.decision || event.event_type || "event",
          mission_id: event.mission_id || event.resource_id,
          why: event.why,
        });
      } catch {
        // Ignore malformed lines.
      }
    }
  }
  return lines
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 8);
}

function collectControlActions(): ControlActionSummary[] {
  const file = pathResolver.shared("observability/mission-control/orchestration-events.jsonl");
  if (!safeExistsSync(file)) return [];

  const lifecycle = new Map<string, ControlActionSummary>();
  const raw = safeReadFile(file, { encoding: "utf8" }) as string;

  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as any;
      const decision = event.decision || event.event_type;
      const eventId = typeof event.event_id === "string" ? event.event_id : undefined;

      if (
        decision === "mission_orchestration_event_enqueued" &&
        (event.event_type === "mission_control_requested" || event.event_type === "surface_control_requested") &&
        eventId
      ) {
        const queuedTarget = event.event_type === "surface_control_requested"
          ? event.payload?.surfaceId || "surface-runtime"
          : event.mission_id || "system";
        lifecycle.set(eventId, {
          event_id: eventId,
          ts: event.ts || new Date().toISOString(),
          kind: event.event_type === "mission_control_requested" ? "mission" : "surface",
          target: queuedTarget,
          operation: typeof event.payload?.operation === "string" ? event.payload.operation : event.event_type,
          status: "queued",
          requested_by: event.requested_by || "unknown",
        });
        continue;
      }

      if (
        (decision === "mission_control_action_applied" || decision === "surface_control_action_applied") &&
        typeof event.operation === "string"
      ) {
        const syntheticId = `${decision}:${event.mission_id || event.resource_id || "system"}:${event.operation}:${event.ts || ""}`;
        lifecycle.set(syntheticId, {
          event_id: eventId,
          ts: event.ts || new Date().toISOString(),
          kind: decision === "mission_control_action_applied" ? "mission" : "surface",
          target: event.mission_id || event.resource_id || "system",
          operation: event.operation,
          status: "completed",
          requested_by: event.requested_by || "unknown",
        });
        continue;
      }

      if (
        decision === "mission_orchestration_event_failed" &&
        (event.event_type === "mission_control_requested" || event.event_type === "surface_control_requested") &&
        eventId
      ) {
        const failedTarget = event.event_type === "surface_control_requested"
          ? event.payload?.surfaceId || "surface-runtime"
          : event.mission_id || "system";
        lifecycle.set(eventId, {
          event_id: eventId,
          ts: event.ts || new Date().toISOString(),
          kind: event.event_type === "mission_control_requested" ? "mission" : "surface",
          target: failedTarget,
          operation: typeof event.payload?.operation === "string" ? event.payload.operation : event.event_type,
          status: "failed",
          requested_by: event.requested_by || "unknown",
          error: typeof event.error === "string" ? event.error : undefined,
        });
      }
    } catch {
      // Ignore malformed lines.
    }
  }

  return Array.from(lifecycle.values())
    .sort((a, b) => b.ts.localeCompare(a.ts))
    .slice(0, 10);
}

function applyPendingActionSummaries(
  activeMissions: MissionSummary[],
  surfaces: SurfaceSummary[],
  controlActions: ControlActionSummary[],
): {
  activeMissions: MissionSummary[];
  surfaces: SurfaceSummary[];
} {
  const pendingMissionTargets = new Map(
    controlActions
      .filter((action) => action.kind === "mission" && action.status === "queued")
      .map((action) => [action.target, { operation: action.operation, requestedBy: action.requested_by }]),
  );
  const pendingSurfaceTargets = new Map(
    controlActions
      .filter((action) => action.kind === "surface" && action.status === "queued")
      .map((action) => [action.target, { operation: action.operation, requestedBy: action.requested_by }]),
  );

  return {
    activeMissions: activeMissions.map((mission) => (
      pendingMissionTargets.has(mission.missionId)
        ? {
            ...mission,
            controlSummary: `${pendingMissionTargets.get(mission.missionId)?.operation} pending`,
            controlTone: "pending",
            controlRequestedBy: pendingMissionTargets.get(mission.missionId)?.requestedBy,
          }
        : mission
    )),
    surfaces: surfaces.map((surface) => (
      pendingSurfaceTargets.has(surface.id) || pendingSurfaceTargets.has("surface-runtime")
        ? {
            ...surface,
            controlSummary: `${pendingSurfaceTargets.get(surface.id)?.operation || pendingSurfaceTargets.get("surface-runtime")?.operation} pending`,
            controlTone: "pending",
            controlRequestedBy: pendingSurfaceTargets.get(surface.id)?.requestedBy || pendingSurfaceTargets.get("surface-runtime")?.requestedBy,
          }
        : surface
    )),
  };
}

function createControlActionDefinition(input: {
  operation: string;
  label: string;
  risk: "safe" | "risky";
  enabled: boolean;
  disabledReason?: string;
  approvalRequired?: boolean;
}): ControlActionDefinition {
  return {
    operation: input.operation,
    label: input.label,
    risk: input.risk,
    approvalRequired: input.approvalRequired === true,
    enabled: input.enabled,
    disabledReason: input.disabledReason,
  };
}

function collectControlActionCatalog(accessRole: "readonly" | "localadmin"): ControlActionCatalog {
  const controlEnabled = accessRole === "localadmin";
  const disabledReason = controlEnabled
    ? undefined
    : "Requires localadmin access. Readonly mode can observe but cannot execute control actions.";
  return {
    mission: [
      createControlActionDefinition({ operation: "refresh_team", label: "refresh team", risk: "safe", enabled: controlEnabled, disabledReason }),
      createControlActionDefinition({ operation: "prewarm_team", label: "prewarm", risk: "safe", enabled: controlEnabled, disabledReason }),
      createControlActionDefinition({ operation: "staff_team", label: "staff", risk: "safe", enabled: controlEnabled, disabledReason }),
      createControlActionDefinition({ operation: "resume", label: "resume", risk: "safe", enabled: controlEnabled, disabledReason }),
      createControlActionDefinition({ operation: "finish", label: "finish", risk: "risky", approvalRequired: true, enabled: controlEnabled, disabledReason }),
    ],
    surface: [
      createControlActionDefinition({ operation: "start", label: "start", risk: "safe", enabled: controlEnabled, disabledReason }),
      createControlActionDefinition({ operation: "stop", label: "stop", risk: "risky", approvalRequired: true, enabled: controlEnabled, disabledReason }),
    ],
    globalSurface: [
      createControlActionDefinition({ operation: "reconcile", label: "reconcile surfaces", risk: "safe", enabled: controlEnabled, disabledReason }),
      createControlActionDefinition({ operation: "status", label: "status refresh", risk: "safe", enabled: controlEnabled, disabledReason }),
    ],
  };
}

function collectControlActionAvailability(
  accessRole: "readonly" | "localadmin",
  activeMissions: MissionSummary[],
  surfaces: SurfaceSummary[],
): ControlActionAvailability {
  const baseCatalog = collectControlActionCatalog(accessRole);
  const mission: Record<string, ControlActionDefinition[]> = {};
  const surface: Record<string, ControlActionDefinition[]> = {};

  for (const item of activeMissions) {
    mission[item.missionId] = baseCatalog.mission.map((action) => {
      if (accessRole !== "localadmin") return action;
      if (action.operation === "resume") {
        return createControlActionDefinition({
          ...action,
          enabled: false,
          disabledReason: "Mission is already active.",
        });
      }
      return action;
    });
  }

  for (const item of surfaces) {
    surface[item.id] = baseCatalog.surface.map((action) => {
      if (accessRole !== "localadmin") return action;
      if (action.operation === "start" && item.running) {
        return createControlActionDefinition({
          ...action,
          enabled: false,
          disabledReason: "Surface is already running.",
        });
      }
      if (action.operation === "stop" && !item.running) {
        return createControlActionDefinition({
          ...action,
          enabled: false,
          disabledReason: "Surface is already stopped.",
        });
      }
      return action;
    });
  }

  const globalSurface = baseCatalog.globalSurface.map((action) => {
    if (accessRole !== "localadmin") return action;
    if (surfaces.length === 0) {
      return createControlActionDefinition({
        ...action,
        enabled: false,
        disabledReason: "No managed surfaces are registered.",
      });
    }
    return action;
  });

  return { mission, surface, globalSurface };
}

function collectControlActionDetails(): Record<string, ControlActionDetail[]> {
  const file = pathResolver.shared("observability/mission-control/orchestration-events.jsonl");
  if (!safeExistsSync(file)) return {};

  const details: Record<string, ControlActionDetail[]> = {};
  const raw = safeReadFile(file, { encoding: "utf8" }) as string;

  for (const line of raw.trim().split("\n")) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line) as any;
      const eventId = typeof event.event_id === "string" ? event.event_id : undefined;
      if (!eventId) continue;
      if (
        event.event_type !== "mission_control_requested" &&
        event.event_type !== "surface_control_requested" &&
        event.decision !== "mission_control_action_applied" &&
        event.decision !== "surface_control_action_applied" &&
        event.decision !== "mission_orchestration_event_started" &&
        event.decision !== "mission_orchestration_event_completed" &&
        event.decision !== "mission_orchestration_event_failed"
      ) {
        continue;
      }

      if (!details[eventId]) {
        details[eventId] = [];
      }
      details[eventId].push({
        ts: event.ts || new Date().toISOString(),
        decision: event.decision || "event",
        event_type: event.event_type,
        mission_id: event.mission_id,
        resource_id: event.resource_id,
        operation: event.operation,
        why: event.why,
        error: event.error,
      });
    } catch {
      // Ignore malformed lines.
    }
  }

  for (const key of Object.keys(details)) {
    details[key] = details[key]
      .sort((a, b) => b.ts.localeCompare(a.ts))
      .slice(0, 8);
  }

  return details;
}

function collectOwnerSummaries(): OwnerSummary[] {
  const summaries: OwnerSummary[] = [];
  const files = [
    pathResolver.shared("observability/channels/slack/missions.jsonl"),
    pathResolver.shared("observability/mission-control/orchestration-events.jsonl"),
  ];

  for (const file of files) {
    if (!safeExistsSync(file)) continue;
    const raw = safeReadFile(file, { encoding: "utf8" }) as string;
    for (const line of raw.trim().split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as any;
        if ((event.decision || event.event_type) !== "mission_owner_notified") continue;
        summaries.push({
          ts: event.ts || new Date().toISOString(),
          mission_id: event.mission_id || "unknown",
          accepted_count: Number(event.accepted_count || 0),
          reviewed_count: Number(event.reviewed_count || 0),
          completed_count: Number(event.completed_count || 0),
          requested_count: Number(event.requested_count || 0),
        });
      } catch {
        // Ignore malformed lines.
      }
    }
  }
  return summaries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6);
}

function collectRecentSurfaceOutbox(): SurfaceOutboxMessage[] {
  return [
    ...listSurfaceOutboxMessages("slack"),
    ...listSurfaceOutboxMessages("chronos"),
  ]
    .sort((a, b) => b.created_at.localeCompare(a.created_at))
    .slice(0, 8);
}

function collectPendingSecretApprovals(): SecretApprovalSummary[] {
  const secretApprovals = listApprovalRequests({
    kind: 'secret_mutation',
    status: 'pending',
  })
    .map((request) => ({
      id: request.id,
      title: request.title,
      summary: request.summary,
      storageChannel: request.storageChannel,
      requestedAt: request.requestedAt,
      requestedBy: request.requestedBy,
      serviceId: request.target?.serviceId || 'unknown',
      secretKey: request.target?.secretKey || 'unknown',
      mutation: request.target?.mutation || 'set',
      riskLevel: request.risk?.level || 'medium',
      requiresStrongAuth: request.risk?.requiresStrongAuth === true,
      pendingRoles: request.workflow?.approvals
        .filter((approval) => approval.status === 'pending')
        .map((approval) => approval.role) || [],
      kind: 'secret_mutation' as const,
    }));

  const computerApprovals = listApprovalRequests({
    storageChannels: ['computer'],
    kind: 'channel-approval',
    status: 'pending',
  }).map((request) => ({
    id: request.id,
    title: request.title,
    summary: request.summary,
    storageChannel: request.storageChannel,
    requestedAt: request.requestedAt,
    requestedBy: request.requestedBy,
    serviceId: 'computer',
    secretKey: 'n/a',
    mutation: request.justification?.requestedEffects?.[0] || 'computer_action',
    riskLevel: request.risk?.level || 'medium',
    requiresStrongAuth: request.risk?.requiresStrongAuth === true,
    pendingRoles: request.workflow?.approvals
      .filter((approval) => approval.status === 'pending')
      .map((approval) => approval.role) || [],
    kind: 'computer_action' as const,
  }));

  return [...secretApprovals, ...computerApprovals]
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, 20);
}

function collectPendingApprovals(): PendingApprovalSummary[] {
  return listApprovalRequests({ status: 'pending' })
    .map((request) => ({
      id: request.id,
      kind: request.kind,
      channel: request.channel,
      storageChannel: request.storageChannel,
      requestedAt: request.requestedAt,
      requestedBy: request.requestedBy,
      title: request.title,
      summary: request.summary,
      riskLevel: request.risk?.level || 'medium',
      pendingRoles: request.workflow?.approvals
        .filter((approval) => approval.status === 'pending')
        .map((approval) => approval.role) || [],
      missionId: request.requestedByContext?.missionId,
      serviceId: request.target?.serviceId,
    }))
    .sort((a, b) => b.requestedAt.localeCompare(a.requestedAt))
    .slice(0, 24);
}

async function collectSurfaceSummaries(): Promise<SurfaceSummary[]> {
  const manifest = loadSurfaceManifest();
  const state = loadSurfaceState();
  const summaries: SurfaceSummary[] = [];

  for (const entry of manifest.surfaces.map(normalizeSurfaceDefinition)) {
    const record = state.surfaces[entry.id];
    const health = await probeSurfaceHealth(entry);
    const controlSummary = !record
      ? "stopped"
      : health.status === "healthy"
        ? "stable"
        : health.status === "unhealthy"
          ? "needs attention"
          : "needs restart";
    const controlTone: SurfaceSummary["controlTone"] = !record
      ? "offline"
      : health.status === "healthy"
        ? "stable"
        : "attention";
    summaries.push({
      id: entry.id,
      kind: entry.kind,
      startupMode: entry.startupMode,
      enabled: entry.enabled !== false,
      running: Boolean(record),
      pid: record?.pid,
      health: health.status,
      detail: health.detail,
      controlSummary,
      controlTone,
    });
  }

  return summaries;
}

function collectRuntimeTopologySurfaces(surfaces: SurfaceSummary[]): RuntimeTopologySurfaceInput[] {
  return surfaces
    .filter((surface) => surface.enabled)
    .map((surface) => ({
      id: surface.id,
      kind: surface.kind,
      running: surface.running,
      startupMode: surface.startupMode,
      pid: surface.pid,
    }));
}

function buildRuntimeDoctor(
  runtimeLeases: RuntimeLeaseSummary[],
  activeMissions: MissionSummary[],
  runtimeSnapshots: ReturnType<typeof listAgentRuntimeSnapshots>,
): RuntimeDoctorFinding[] {
  const activeMissionIds = new Set(activeMissions.map((mission) => mission.missionId));
  const runtimeByAgent = new Map(runtimeSnapshots.map((snapshot) => [snapshot.agent.agentId, snapshot]));
  const findings: RuntimeDoctorFinding[] = [];

  for (const lease of runtimeLeases) {
    const runtime = runtimeByAgent.get(lease.agent_id);
    if (!runtime) continue;

    if (lease.owner_type === "mission" && !activeMissionIds.has(lease.owner_id)) {
      findings.push({
        severity: "critical",
        agentId: lease.agent_id,
        ownerId: lease.owner_id,
        reason: "Mission-scoped runtime lease without an active mission owner.",
        recommendedAction: "stop_runtime",
      });
      continue;
    }

    if (runtime.agent.status === "error") {
      findings.push({
        severity: "warning",
        agentId: lease.agent_id,
        ownerId: lease.owner_id,
        reason: "Runtime lease is attached to an agent in error state.",
        recommendedAction: "restart_runtime",
      });
      continue;
    }

    const executionMode = typeof lease.metadata?.execution_mode === "string" ? lease.metadata.execution_mode : undefined;
    const channel = typeof lease.metadata?.channel === "string" ? lease.metadata.channel : undefined;
    if (executionMode === "conversation" && channel === "slack" && runtime.runtime?.idleForMs && runtime.runtime.idleForMs > 5 * 60 * 1000) {
      findings.push({
        severity: "warning",
        agentId: lease.agent_id,
        ownerId: lease.owner_id,
        reason: "Conversation-scoped lease appears stale (>5m idle).",
        recommendedAction: "stop_runtime",
      });
    }
  }

  return findings.slice(0, 12);
}

function recordRuntimeRemediationArtifacts(input: {
  action: "cleanup_runtime_lease" | "restart_runtime_lease";
  agentId: string;
  lease?: RuntimeLeaseSummary;
}) {
  const lease = input.lease;
  if (!lease) return;

  if (lease.owner_type === "mission") {
    ledger.record("MISSION_RUNTIME_REMEDIATION", {
      mission_id: lease.owner_id,
      role: "chronos_localadmin",
      agent_id: input.agentId,
      remediation_action: input.action,
      owner_type: lease.owner_type,
      metadata: lease.metadata || {},
    });
  }

  const channel = typeof lease.metadata?.channel === "string" ? lease.metadata.channel : undefined;
  if (channel) {
    emitChannelSurfaceEvent("chronos_localadmin", channel, "runtime-remediation", {
      correlation_id: typeof lease.metadata?.thread === "string" ? lease.metadata.thread : input.agentId,
      decision: "runtime_lease_remediation_applied",
      why: "Chronos operator applied runtime remediation to a leased agent runtime.",
      policy_used: "mission_orchestration_control_plane_v1",
      mission_id: lease.owner_type === "mission" ? lease.owner_id : undefined,
      agent_id: input.agentId,
      resource_id: input.agentId,
      action: input.action,
      owner_type: lease.owner_type,
      owner_id: lease.owner_id,
      thread: typeof lease.metadata?.thread === "string" ? lease.metadata.thread : undefined,
    });
  }
}

export async function GET(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);
    const runtimeSupervisorClient = await import("@agent/core/agent-runtime-supervisor-client");
    const runtime = listAgentRuntimeSnapshots();
    const rawActiveMissions = collectActiveMissions();
    const runtimeLeases = listAgentRuntimeLeaseSummaries().slice(0, 12);
    const rawSurfaces = await collectSurfaceSummaries();
    const controlActions = collectControlActions();
    const { activeMissions, surfaces } = applyPendingActionSummaries(rawActiveMissions, rawSurfaces, controlActions);
    const missionProgress = collectMissionProgress(activeMissions);
    const agentMessages = collectAgentMessages();
    const a2aHandoffs = collectA2AHandoffs();
    let managedRuntimes: Array<{
      agentId: string;
      provider: string;
      modelId?: string;
      status: string;
      ownerId: string;
      ownerType: string;
      requestedBy?: string;
      leaseKind?: string;
      pid?: number;
      metadata?: Record<string, unknown>;
    }> = [];
    try {
      const daemonRuntimes = await runtimeSupervisorClient.listAgentRuntimesViaDaemon();
      managedRuntimes = daemonRuntimes.map((entry) => ({
        agentId: entry.agent_id,
        provider: entry.provider || "unknown",
        modelId: entry.model_id || undefined,
        status: entry.status || "unknown",
        ownerId: entry.owner_id || "unowned",
        ownerType: entry.owner_type || "unknown",
        requestedBy: typeof entry.metadata?.requestedBy === "string" ? entry.metadata.requestedBy : undefined,
        leaseKind: typeof entry.metadata?.lease_kind === "string" ? entry.metadata.lease_kind : undefined,
        pid: entry.pid,
        metadata: entry.metadata || undefined,
      }));
    } catch {
      managedRuntimes = runtimeLeases.map((lease) => {
        const snapshot = runtime.find((entry) => entry.agent.agentId === lease.agent_id);
        return {
          agentId: lease.agent_id,
          provider: snapshot?.agent.provider || "unknown",
          modelId: snapshot?.agent.modelId,
          status: snapshot?.agent.status || "unknown",
          ownerId: lease.owner_id,
          ownerType: lease.owner_type,
          requestedBy: typeof lease.metadata?.requestedBy === "string" ? lease.metadata.requestedBy : undefined,
          leaseKind: typeof lease.metadata?.execution_mode === "string" ? lease.metadata.execution_mode : undefined,
          pid: snapshot?.runtime?.pid,
          metadata: lease.metadata,
        };
      });
    }
    const controlActionCatalog = collectControlActionCatalog(accessRole);
    const controlActionAvailability = collectControlActionAvailability(accessRole, activeMissions, surfaces);
    const secretApprovals = collectPendingSecretApprovals();
    const pendingApprovals = collectPendingApprovals();
    const projects = listProjectRecords();
    const missionSeeds = listMissionSeedRecords();
    const distillCandidates = listDistillCandidateRecords();
    const serviceBindings = listServiceBindingRecords();
    const recentArtifacts = listArtifactRecords().slice(-8).reverse();
    return NextResponse.json({
      activeMissions,
      missionProgress,
      projects,
      missionSeeds,
      distillCandidates,
      serviceBindings,
      recentArtifacts,
      pendingApprovals,
      secretApprovals,
      surfaces,
      accessRole,
      recentEvents: collectRecentEvents(),
      agentMessages,
      a2aHandoffs,
      controlActionCatalog,
      controlActionAvailability,
      controlActions,
      controlActionDetails: collectControlActionDetails(),
      ownerSummaries: collectOwnerSummaries(),
      browserSessions: collectBrowserSessions(),
      browserConversationSessions: collectBrowserConversationSessions(),
      computerSessions: collectComputerSessions(),
      surfaceOutbox: {
        slack: listSurfaceOutboxMessages("slack").length,
        chronos: listSurfaceOutboxMessages("chronos").length,
      },
      recentSurfaceOutbox: collectRecentSurfaceOutbox(),
      runtime: {
        total: runtime.length,
        ready: runtime.filter((entry) => entry.agent.status === "ready").length,
        busy: runtime.filter((entry) => entry.agent.status === "busy").length,
        error: runtime.filter((entry) => entry.agent.status === "error").length,
      },
      runtimeLeases,
      runtimeDoctor: buildRuntimeDoctor(runtimeLeases, activeMissions, runtime),
      runtimeTopology: buildRuntimeTopology({
        surfaces: collectRuntimeTopologySurfaces(surfaces),
        runtimes: managedRuntimes,
        handoffs: a2aHandoffs,
        messages: agentMessages,
      }),
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to load mission intelligence" }, { status: 500 });
  }
}

export async function POST(req: NextRequest) {
  try {
    const denied = guardRequest(req);
    if (denied) return denied;
    const requiresAdmin = requireChronosAccess(req, "localadmin");
    if (requiresAdmin) return requiresAdmin;
    const accessRole = getChronosAccessRoleOrThrow(req);
    process.env.MISSION_ROLE = roleToMissionRole(accessRole);
    const body = await req.json();
    const action = body?.action;

    if (
      action !== "cleanup_runtime_lease" &&
      action !== "restart_runtime_lease" &&
      action !== "clear_surface_outbox" &&
      action !== "mission_control" &&
      action !== "surface_control" &&
      action !== "promote_mission_seed" &&
      action !== "distill_candidate_decision" &&
      action !== "approval_decision" &&
      action !== "close_browser_session" &&
      action !== "restart_browser_session"
    ) {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }

    if (action === "approval_decision") {
      const requestId = typeof body?.requestId === "string" ? body.requestId : "";
      const storageChannel = typeof body?.storageChannel === "string" ? body.storageChannel : "";
      const channel = typeof body?.channel === "string" ? body.channel : "";
      const decision = body?.decision === "approved" || body?.decision === "rejected" ? body.decision : null;
      if (!requestId || !storageChannel || !channel || !decision) {
        return NextResponse.json({ error: "Missing approval decision payload" }, { status: 400 });
      }
      const updated = decideApprovalRequest(roleToMissionRole(accessRole), {
        channel,
        storageChannel,
        requestId,
        decision,
        decidedBy: "chronos-localadmin",
        decidedByRole: "sovereign",
        authMethod: "surface_session",
        note: "Decision captured from Chronos approval panel.",
      });
      enqueueSurfaceNotification({
        surface: "presence",
        requestId: updated.correlationId || updated.id,
        title: `Approval ${decision}`,
        text: buildApprovalDecisionText({
          title: updated.title,
          decision,
          missionId: updated.requestedByContext?.missionId,
          serviceId: updated.target?.serviceId,
        }),
        status: decision === "approved" ? "completed" : "attention",
        metadata: {
          approval_id: updated.id,
          channel: updated.channel,
        },
      });
      return NextResponse.json({ ok: true, approval: updated });
    }

    if (action === "distill_candidate_decision") {
      const candidateId = typeof body?.candidateId === "string" ? body.candidateId : "";
      const decision = body?.decision === "promote" || body?.decision === "archive" ? body.decision : null;
      if (!candidateId || !decision) {
        return NextResponse.json({ error: "Missing distill candidate decision payload" }, { status: 400 });
      }
      const candidate = loadDistillCandidateRecord(candidateId);
      if (!candidate) {
        return NextResponse.json({ error: "Distill candidate not found" }, { status: 404 });
      }
      let updated = candidate;
      if (decision === "archive") {
        updated = updateDistillCandidateRecord(candidateId, { status: "archived" }) || candidate;
      } else {
        const saved = savePromotedMemoryRecord(candidate, { executionRole: "chronos_gateway" });
        updated = updateDistillCandidateRecord(candidateId, {
          status: "promoted",
          promoted_ref: saved.logicalPath,
        }) || candidate;
      }
      enqueueSurfaceNotification({
        surface: "presence",
        requestId: updated.candidate_id,
        title: decision === "promote" ? "Memory promoted" : "Memory archived",
        text: decision === "promote"
          ? `${updated.title} was promoted for reuse.${buildLearnedNotificationText({ projectId: updated.project_id, language: "en" })}`
          : `${updated.title} was archived from the memory queue.`,
        status: "completed",
        metadata: {
          candidate_id: updated.candidate_id,
          promoted_ref: updated.promoted_ref,
        },
      });
      return NextResponse.json({ ok: true, candidate: updated });
    }

    if (action === "close_browser_session" || action === "restart_browser_session") {
      const sessionId = typeof body?.sessionId === "string" ? body.sessionId : "";
      if (!sessionId) {
        return NextResponse.json({ error: "Missing sessionId" }, { status: 400 });
      }
      const ok = applyBrowserSessionControl(sessionId, action);
      if (!ok) {
        return NextResponse.json({ error: "Browser session not found" }, { status: 404 });
      }
      emitMissionOrchestrationObservation({
        decision: "browser_session_control_applied",
        event_type: "browser_session_control_applied",
        requested_by: "chronos_localadmin",
        resource_id: sessionId,
        action,
        why: "Chronos operator applied browser session control from the browser session panel.",
      });
      return NextResponse.json({
        status: "ok",
        action,
        sessionId,
        ts: new Date().toISOString(),
      });
    }

    if (action === "promote_mission_seed") {
      const seedId = typeof body?.seedId === "string" ? body.seedId : "";
      if (!seedId) {
        return NextResponse.json({ error: "Missing seedId" }, { status: 400 });
      }
      const seed = loadMissionSeedRecord(seedId);
      if (!seed) {
        return NextResponse.json({ error: "Mission seed not found" }, { status: 404 });
      }
      const project = loadProjectRecord(seed.project_id);
      if (!project) {
        return NextResponse.json({ error: "Parent project not found" }, { status: 404 });
      }
      const missionId = `MSN-${seed.seed_id.replace(/^MSD-/, "")}`.toUpperCase();
      const persona = seed.specialist_id === "service-operator" ? "Reliability Engineer" : "Ecosystem Architect";
      const missionType = seed.mission_type_hint || "development";
      const env = buildExecutionEnv(process.env, "mission_controller");
      const startOutput = safeExec(
        "node",
        [
          "dist/scripts/mission_controller.js",
          "start",
          missionId,
          project.tier,
          persona,
          "default",
          missionType,
          "--project-id",
          project.project_id,
          "--project-relationship",
          "belongs_to",
          "--project-note",
          `Promoted from mission seed ${seed.seed_id}`,
        ],
        { env, cwd: pathResolver.rootDir(), timeoutMs: 120_000 },
      );
      saveMissionSeedRecord({
        ...seed,
        status: "promoted",
        promoted_mission_id: missionId,
        updated_at: new Date().toISOString(),
        metadata: {
          ...(seed.metadata || {}),
          start_output: startOutput,
        },
      });
      const activeMissions = new Set(project.active_missions || []);
      activeMissions.add(missionId);
      saveProjectRecord({
        ...project,
        active_missions: Array.from(activeMissions),
        metadata: {
          ...(project.metadata || {}),
          last_promoted_seed_id: seed.seed_id,
        },
      });
      saveDistillCandidateRecord(createDistillCandidateRecord({
        source_type: "mission",
        tier: project.tier,
        project_id: project.project_id,
        mission_id: missionId,
        task_session_id: seed.source_task_session_id,
        title: `Promote durable mission orchestration for ${seed.title}`,
        summary: `${seed.title} was promoted from a project mission seed into durable mission ${missionId}. This transition may be reusable as governed organizational memory.`,
        status: "proposed",
        target_kind: inferMissionSeedPromotionTargetKind(seed),
        specialist_id: seed.specialist_id,
        locale: seed.locale || project.primary_locale,
        evidence_refs: [
          `project:${project.project_id}`,
          `mission_seed:${seed.seed_id}`,
          `mission:${missionId}`,
          ...(seed.source_task_session_id ? [`task_session:${seed.source_task_session_id}`] : []),
        ],
        metadata: buildMissionSeedPromotionMetadata(seed, project),
      }));
      emitMissionOrchestrationObservation({
        decision: "mission_seed_promoted",
        event_type: "mission_seed_promoted",
        requested_by: "chronos_localadmin",
        mission_id: missionId,
        resource_id: seed.seed_id,
        why: "Chronos promoted a project mission seed into a durable mission through mission_controller.",
      });
      enqueueSurfaceNotification({
        surface: "presence",
        channel: "voice",
        threadTs: seed.source_task_session_id || seed.seed_id,
        sourceAgentId: "chronos_localadmin",
        title: `Mission promoted: ${seed.title}`,
        text: `${project.name} の mission seed 「${seed.title}」を durable mission ${missionId} として開始しました。${buildLearnedNotificationText({ projectId: project.project_id, language: "ja" })}`,
        metadata: {
          project_id: project.project_id,
          seed_id: seed.seed_id,
          mission_id: missionId,
        },
      });
      return NextResponse.json({
        status: "ok",
        action,
        seedId,
        missionId,
        ts: new Date().toISOString(),
      });
    }

    if (action === "mission_control") {
      const missionId = typeof body?.missionId === "string" ? body.missionId.toUpperCase() : "";
      const operation = typeof body?.operation === "string" ? body.operation : "";
      if (!missionId || !operation) {
        return NextResponse.json({ error: "Missing missionId or operation" }, { status: 400 });
      }
      if (!["resume", "refresh_team", "prewarm_team", "staff_team", "finish"].includes(operation)) {
        return NextResponse.json({ error: "Unsupported mission operation" }, { status: 400 });
      }

      const event = enqueueMissionOrchestrationEvent({
        eventType: "mission_control_requested",
        missionId,
        requestedBy: "chronos_localadmin",
        payload: {
          operation,
          requested_by_surface: "chronos",
        },
      });
      startMissionOrchestrationWorker(event);

      return NextResponse.json({
        status: "queued",
        action,
        missionId,
        operation,
        eventId: event.event_id,
        ts: new Date().toISOString(),
      });
    }

    if (action === "surface_control") {
      const surfaceId = typeof body?.surfaceId === "string" ? body.surfaceId : "";
      const operation = typeof body?.operation === "string" ? body.operation : "";
      if (!operation) {
        return NextResponse.json({ error: "Missing surface operation" }, { status: 400 });
      }

      if (!(operation === "reconcile" || operation === "status" || ((operation === "start" || operation === "stop") && surfaceId))) {
        return NextResponse.json({ error: "Unsupported surface operation" }, { status: 400 });
      }
      const event = enqueueMissionOrchestrationEvent({
        eventType: "surface_control_requested",
        missionId: "MSN-CHRONOS-SURFACE-CONTROL",
        requestedBy: "chronos_localadmin",
        payload: {
          operation,
          surfaceId: surfaceId || undefined,
          requested_by_surface: "chronos",
        },
      });
      startMissionOrchestrationWorker(event);

      return NextResponse.json({
        status: "queued",
        action,
        surfaceId,
        operation,
        eventId: event.event_id,
        ts: new Date().toISOString(),
      });
    }

    if (action === "clear_surface_outbox") {
      const surface = body?.surface === "chronos" ? "chronos" : body?.surface === "slack" ? "slack" : "";
      const messageId = typeof body?.messageId === "string" ? body.messageId : "";
      if (!surface || !messageId) {
        return NextResponse.json({ error: "Missing surface or messageId" }, { status: 400 });
      }
      const message = listSurfaceOutboxMessages(surface).find((entry) => entry.message_id === messageId);
      clearSurfaceOutboxMessage(surface, messageId);
      emitMissionOrchestrationObservation({
        decision: "surface_outbox_cleared",
        event_type: "surface_outbox_cleared",
        requested_by: "chronos_localadmin",
        resource_id: messageId,
        surface,
        why: "Chronos operator cleared a surface outbox message.",
      });
      emitChannelSurfaceEvent("chronos_localadmin", surface, "outbox", {
        correlation_id: message?.correlation_id || messageId,
        decision: "surface_outbox_cleared",
        why: "Chronos operator cleared a surface outbox message from the shared outbox contract.",
        policy_used: "mission_orchestration_control_plane_v1",
        mission_id: typeof message?.correlation_id === "string" && message.correlation_id.startsWith("MSN-")
          ? message.correlation_id
          : undefined,
        resource_id: messageId,
        surface,
        thread: message?.thread_ts,
        channel: message?.channel,
      });
      return NextResponse.json({
        status: "ok",
        action,
        surface,
        messageId,
        ts: new Date().toISOString(),
      });
    }

    const agentId = typeof body?.agentId === "string" ? body.agentId : "";
    if (!agentId) {
      return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
    }
    const lease = listAgentRuntimeLeaseSummaries().find((entry) => entry.agent_id === agentId);

    if (action === "cleanup_runtime_lease") {
      await stopAgentRuntime(agentId, "chronos_localadmin");
    } else {
      await restartAgentRuntime(agentId, "chronos_localadmin");
    }
    emitMissionOrchestrationObservation({
      decision: "runtime_lease_remediation_applied",
      event_type: "runtime_lease_remediation_applied",
      requested_by: "chronos_localadmin",
      resource_id: agentId,
      action,
      why: "Chronos operator applied runtime lease remediation from the doctor view.",
    });
    recordRuntimeRemediationArtifacts({ action, agentId, lease });
    return NextResponse.json({
      status: "ok",
      action,
      agentId,
      ts: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to apply runtime remediation" }, { status: 500 });
  }
}
