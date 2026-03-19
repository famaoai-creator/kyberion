import { NextResponse } from "next/server";
import path from "node:path";
import { listAgentRuntimeLeaseSummaries, listAgentRuntimeSnapshots, pathResolver, safeExistsSync, safeReadFile, safeReaddir } from "@agent/core";

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
      });
      continue;
    }

    if (runtime.agent.status === "error") {
      findings.push({
        severity: "warning",
        agentId: lease.agent_id,
        ownerId: lease.owner_id,
        reason: "Runtime lease is attached to an agent in error state.",
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
      });
    }
  }

  return findings.slice(0, 12);
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
