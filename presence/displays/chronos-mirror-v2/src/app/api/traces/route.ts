import { NextRequest, NextResponse } from "next/server";

import { guardRequest, requireChronosAccess } from "../../../lib/api-guard";
import { collectTraceDetail, collectTraceFeed, resolveTraceFeedDirs } from "../../../lib/trace-feed";

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const requiresAccess = requireChronosAccess(req, "readonly");
  if (requiresAccess) return requiresAccess;

  const limit = Number(req.nextUrl.searchParams.get("limit") || 24);
  const status = req.nextUrl.searchParams.get("status") || "";
  const missionId = req.nextUrl.searchParams.get("missionId") || "";
  const pipelineId = req.nextUrl.searchParams.get("pipelineId") || "";
  const actuator = req.nextUrl.searchParams.get("actuator") || "";
  const query = req.nextUrl.searchParams.get("query") || "";
  const traceId = req.nextUrl.searchParams.get("traceId") || "";
  if (traceId) {
    const trace = collectTraceDetail(traceId, {
      limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 24,
    });

    return NextResponse.json({
      trace,
      traceDir: resolveTraceFeedDirs()[0] || "active/shared/logs/traces",
    });
  }

  const traces = collectTraceFeed({
    limit: Number.isFinite(limit) ? Math.min(100, Math.max(1, Math.floor(limit))) : 24,
    status: status === "ok" || status === "error" || status === "in_progress" ? status : undefined,
    missionId: missionId || undefined,
    pipelineId: pipelineId || undefined,
    actuator: actuator || undefined,
    query: query || undefined,
  });

  return NextResponse.json({
    traces,
    traceDir: resolveTraceFeedDirs()[0] || "active/shared/logs/traces",
  });
}
