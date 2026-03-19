import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { getChronosAccessRoleOrThrow, guardRequest, requireChronosAccess, roleToMissionRole } from "../../../lib/api-guard";
import { clearSurfaceOutboxMessage, emitChannelSurfaceEvent, listSurfaceOutboxMessages } from "@agent/core/dist/channel-surface.js";
import { emitMissionOrchestrationObservation } from "@agent/core/dist/mission-orchestration-events.js";
import { enqueueMissionOrchestrationEvent, startMissionOrchestrationWorker } from "@agent/core/dist/mission-orchestration-events.js";
import { ledger } from "@agent/core/dist/ledger.js";
import { listAgentRuntimeLeaseSummaries, listAgentRuntimeSnapshots, restartAgentRuntime, stopAgentRuntime } from "@agent/core/dist/agent-runtime-supervisor.js";
import { pathResolver } from "@agent/core/dist/path-resolver.js";
import { safeExistsSync, safeReadFile, safeReaddir } from "@agent/core/dist/secure-io.js";
import { loadSurfaceManifest, loadSurfaceState, normalizeSurfaceDefinition, probeSurfaceHealth } from "@agent/core/dist/surface-runtime.js";

interface MissionSummary {
  missionId: string;
  status: string;
  tier: string;
  missionType?: string;
  planReady: boolean;
  nextTaskCount: number;
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
        missions.push({
          missionId: state.mission_id || item,
          status: state.status,
          tier: state.tier || root.tier,
          missionType: state.mission_type,
          planReady,
          nextTaskCount: Array.isArray(nextTasks) ? nextTasks.length : 0,
        });
      }
    } catch {
      // Skip roots that are unavailable to the current authority role.
    }
  }

  return missions.sort((a, b) => a.missionId.localeCompare(b.missionId));
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

async function collectSurfaceSummaries(): Promise<SurfaceSummary[]> {
  const manifest = loadSurfaceManifest();
  const state = loadSurfaceState();
  const summaries: SurfaceSummary[] = [];

  for (const entry of manifest.surfaces.map(normalizeSurfaceDefinition)) {
    const record = state.surfaces[entry.id];
    const health = await probeSurfaceHealth(entry);
    summaries.push({
      id: entry.id,
      kind: entry.kind,
      startupMode: entry.startupMode,
      enabled: entry.enabled !== false,
      running: Boolean(record),
      pid: record?.pid,
      health: health.status,
      detail: health.detail,
    });
  }

  return summaries;
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
    const runtime = listAgentRuntimeSnapshots();
    const activeMissions = collectActiveMissions();
    const runtimeLeases = listAgentRuntimeLeaseSummaries().slice(0, 12);
    const surfaces = await collectSurfaceSummaries();
    return NextResponse.json({
      activeMissions,
      surfaces,
      accessRole,
      recentEvents: collectRecentEvents(),
      ownerSummaries: collectOwnerSummaries(),
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
      action !== "surface_control"
    ) {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
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
