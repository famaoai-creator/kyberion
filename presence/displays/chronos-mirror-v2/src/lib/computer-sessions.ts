import { pathResolver, ptyEngine, safeExistsSync, safeReadFile, safeReaddir } from "@agent/core";
import path from "node:path";

export interface ComputerSessionSummary {
  id: string;
  kind: "browser" | "terminal" | "system";
  status: string;
  updatedAt: string;
  pid?: number;
  target?: string;
  detail?: string;
  actionCount?: number;
  metadata?: Record<string, unknown>;
}

export function collectComputerSessions(): ComputerSessionSummary[] {
  const sessions = new Map<string, ComputerSessionSummary>();

  const governedSessionDir = pathResolver.resolve("active/shared/runtime/computer/sessions");
  if (safeExistsSync(governedSessionDir)) {
    for (const file of safeReaddir(governedSessionDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = safeReadFile(path.join(governedSessionDir, file), { encoding: "utf8" }) as string;
        const parsed = JSON.parse(raw) as any;
        const id = parsed.id || file.replace(/\.json$/, "");
        sessions.set(id, {
          id,
          kind: parsed.executor || "system",
          status: parsed.status || "unknown",
          updatedAt: parsed.updatedAt || new Date(0).toISOString(),
          target: parsed.target,
          detail: parsed.detail || parsed.latestAction || "",
          actionCount: parsed.actionCount || 0,
          metadata: parsed.metadata || {},
        });
      } catch {
        // ignore malformed computer session metadata
      }
    }
  }

  const browserSessionDir = pathResolver.resolve("active/shared/runtime/browser/sessions");
  if (safeExistsSync(browserSessionDir)) {
    for (const file of safeReaddir(browserSessionDir)) {
      if (!file.endsWith(".json")) continue;
      try {
        const raw = safeReadFile(path.join(browserSessionDir, file), { encoding: "utf8" }) as string;
        const parsed = JSON.parse(raw) as any;
        const id = parsed.session_id || file.replace(/\.json$/, "");
        if (sessions.has(id)) continue;
        sessions.set(id, {
          id,
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
    if (sessions.has(sessionId)) continue;
    const session = ptyEngine.get(sessionId);
    sessions.set(sessionId, {
      id: sessionId,
      kind: "terminal",
      status: session?.status || "unknown",
      updatedAt: new Date(session?.lastUpdated || Date.now()).toISOString(),
      pid: session?.adapter.pid,
      detail: session?.status === "running" ? "interactive shell" : "terminal session",
    });
  }

  return Array.from(sessions.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}
