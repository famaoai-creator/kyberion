import { NextResponse } from "next/server";
import path from "node:path";
import { agentLifecycle } from "@agent/core/agent-lifecycle";
import { pathResolver, safeExistsSync, safeReadFile, safeReaddir } from "@agent/core";

interface MissionSummary {
  missionId: string;
  status: string;
  tier: string;
  missionType?: string;
  planReady: boolean;
  nextTaskCount: number;
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

export async function GET() {
  try {
    process.env.MISSION_ROLE ||= "chronos_operator";
    const runtime = agentLifecycle.listSnapshots();
    return NextResponse.json({
      activeMissions: collectActiveMissions(),
      recentEvents: collectRecentEvents(),
      runtime: {
        total: runtime.length,
        ready: runtime.filter((entry) => entry.agent.status === "ready").length,
        busy: runtime.filter((entry) => entry.agent.status === "busy").length,
        error: runtime.filter((entry) => entry.agent.status === "error").length,
      },
      timestamp: new Date().toISOString(),
    });
  } catch (err: any) {
    return NextResponse.json({ error: err.message || "Failed to load mission intelligence" }, { status: 500 });
  }
}
