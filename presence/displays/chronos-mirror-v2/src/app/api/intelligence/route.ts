import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { emitChannelSurfaceEvent, emitMissionOrchestrationObservation, ledger, listAgentRuntimeLeaseSummaries, listAgentRuntimeSnapshots, pathResolver, safeExistsSync, safeReadFile, safeReaddir, stopAgentRuntime, restartAgentRuntime } from "@agent/core";

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

function readJson<T = any>(filePath: string): T | null {
  if (!safeExistsSync(filePath)) return null;
  return JSON.parse(safeReadFile(filePath, { encoding: "utf8" }) as string) as T;
}

function collectActiveMissions(): MissionSummary[] {
  const missionRoots = [
    { dir: pathResolver.active("missions/public"), tier: "public" },
    { dir: pathResolver.active("missions/confidential"), tier: "confidential" },
    { dir: pathResolver.knowledge("personal/missions"), tier: "personal" },
  ];
  const missions: MissionSummary[] = [];

  for (const root of missionRoots) {
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
  const file = pathResolver.shared("observability/channels/slack/missions.jsonl");
  if (!safeExistsSync(file)) return [];
  const raw = safeReadFile(file, { encoding: "utf8" }) as string;
  const summaries: OwnerSummary[] = [];
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
  return summaries.sort((a, b) => b.ts.localeCompare(a.ts)).slice(0, 6);
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
      role: "chronos_operator",
      agent_id: input.agentId,
      remediation_action: input.action,
      owner_type: lease.owner_type,
      metadata: lease.metadata || {},
    });
  }

  const channel = typeof lease.metadata?.channel === "string" ? lease.metadata.channel : undefined;
  if (channel) {
    emitChannelSurfaceEvent("chronos_operator", channel, "runtime-remediation", {
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

export async function GET() {
  try {
    process.env.MISSION_ROLE ||= "chronos_operator";
    const runtime = listAgentRuntimeSnapshots();
    const activeMissions = collectActiveMissions();
    const runtimeLeases = listAgentRuntimeLeaseSummaries().slice(0, 12);
    return NextResponse.json({
      activeMissions,
      recentEvents: collectRecentEvents(),
      ownerSummaries: collectOwnerSummaries(),
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
    process.env.MISSION_ROLE ||= "chronos_operator";
    const body = await req.json();
    const action = body?.action;

    if (action !== "cleanup_runtime_lease" && action !== "restart_runtime_lease") {
      return NextResponse.json({ error: "Unsupported action" }, { status: 400 });
    }

    const agentId = typeof body?.agentId === "string" ? body.agentId : "";
    if (!agentId) {
      return NextResponse.json({ error: "Missing agentId" }, { status: 400 });
    }
    const lease = listAgentRuntimeLeaseSummaries().find((entry) => entry.agent_id === agentId);

    if (action === "cleanup_runtime_lease") {
      await stopAgentRuntime(agentId, "chronos_operator");
    } else {
      await restartAgentRuntime(agentId, "chronos_operator");
    }
    emitMissionOrchestrationObservation({
      decision: "runtime_lease_remediation_applied",
      event_type: "runtime_lease_remediation_applied",
      requested_by: "chronos_operator",
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
