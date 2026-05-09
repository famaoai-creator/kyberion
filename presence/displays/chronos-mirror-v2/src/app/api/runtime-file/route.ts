import { NextRequest, NextResponse } from "next/server";
import path from "node:path";
import { guardRequest, requireChronosAccess } from "../../../lib/api-guard";
import { pathResolver } from "@agent/core/path-resolver";
import { safeExistsSync, safeReadFile } from "@agent/core/secure-io";

function isAllowedRuntimeRefPath(logicalPath: string): boolean {
  const normalized = String(logicalPath || "").replace(/^\/+/, "");
  if (!/^active\/projects\/.+\.(md|json)$/i.test(normalized)) {
    return false;
  }
  const resolved = path.resolve(pathResolver.resolve(normalized));
  const allowedRoot = path.resolve(pathResolver.active("projects"));
  return resolved === allowedRoot || resolved.startsWith(`${allowedRoot}${path.sep}`);
}

export async function GET(req: NextRequest) {
  const denied = guardRequest(req);
  if (denied) return denied;
  const requiresAccess = requireChronosAccess(req, "readonly");
  if (requiresAccess) return requiresAccess;
  const logicalPath = String(req.nextUrl.searchParams.get("path") || "").trim();
  if (!logicalPath) {
    return NextResponse.json({ error: "path is required" }, { status: 400 });
  }
  if (!isAllowedRuntimeRefPath(logicalPath)) {
    return NextResponse.json({ error: `runtime ref is not accessible: ${logicalPath}` }, { status: 403 });
  }
  const resolved = pathResolver.resolve(logicalPath);
  if (!safeExistsSync(resolved)) {
    return NextResponse.json({ error: `runtime ref not found: ${logicalPath}` }, { status: 404 });
  }
  return new NextResponse(safeReadFile(resolved, { encoding: "utf8" }) as string, {
    headers: {
      "Content-Type": logicalPath.endsWith(".json") ? "application/json" : "text/markdown; charset=utf-8",
    },
  });
}
