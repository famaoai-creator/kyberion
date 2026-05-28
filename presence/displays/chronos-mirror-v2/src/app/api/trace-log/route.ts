import { NextRequest, NextResponse } from "next/server";

import { guardRequest, requireChronosAccess } from "../../../lib/api-guard";
import { isAllowedTraceLogPath } from "../../../lib/trace-log-access";
import { pathResolver } from "@agent/core/path-resolver";
import { safeExistsSync, safeReadFile } from "@agent/core/secure-io";

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;

  const requiresAccess = requireChronosAccess(req, "readonly");
  if (requiresAccess) return requiresAccess;

  const logicalPath = String(req.nextUrl.searchParams.get("path") || "").trim();
  if (!logicalPath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }

  if (!isAllowedTraceLogPath(logicalPath)) {
    return NextResponse.json({ error: `trace log is not accessible: ${logicalPath}` }, { status: 403 });
  }

  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) {
    return NextResponse.json({ error: `trace log not found: ${logicalPath}` }, { status: 404 });
  }

  return new NextResponse(safeReadFile(resolved, { encoding: "utf8" }) as string, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
    },
  });
}
