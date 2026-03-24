import { pathResolver, ptyEngine, safeExistsSync, safeReadFile, safeReaddir } from "@agent/core";
import path from "node:path";

export interface ComputerSessionSummary {
  id: string;
  kind: "browser" | "terminal";
  status: string;
  updatedAt: string;
  pid?: number;
  target?: string;
  detail?: string;
  actionCount?: number;
}

export function collectComputerSessions(): ComputerSessionSummary[] {
  const sessions: ComputerSessionSummary[] = [];

  const browserSessionDir = pathResolver.resolve("active/shared/runtime/browser/sessions");
  if (safeExistsSync(browserSessionDir)) {
    for (const file of safeReaddir(browserSessionDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = safeReadFile(path.join(browserSessionDir, file), { encoding: "utf8" }) as string;
        const parsed = JSON.parse(raw) as any;
        sessions.push({
          id: parsed.session_id || file.replace(/\.json$/, ""),
          kind: "browser",
          status: parsed.lease_status || "unknown",
          updatedAt: parsed.updated_at || new Date(0).toISOString(),
          pid: parsed.pid,
          target: parsed.active_tab_id,
          detail: `${parsed.tab_count || 0} tabs`,
          actionCount: parsed.action_trail_count || 0,
        });
      } catch {
        // ignore malformed browser session metadata
      }
    }
  }

  for (const sessionId of ptyEngine.list()) {
    const session = ptyEngine.get(sessionId);
    sessions.push({
      id: sessionId,
      kind: "terminal",
      status: session?.status || "unknown",
      updatedAt: new Date(session?.lastUpdated || Date.now()).toISOString(),
      pid: session?.adapter.pid,
      detail: session?.status === "running" ? "interactive shell" : "terminal session",
    });
  }

  return sessions.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
