import {
  pathResolver,
  safeExistsSync,
  safeReadFile,
  safeWriteFile,
} from "@agent/core/intelligence-primitives";

type BrowserSessionControlAction = "close_browser_session" | "restart_browser_session";

interface BrowserSessionRecord {
  session_id: string;
  active_tab_id: string;
  tab_count: number;
  updated_at: string;
  lease_expires_at?: string;
  lease_status: "active" | "released" | "expired";
  retained: boolean;
  action_trail_count: number;
  recent_actions: Array<{
    op: string;
    kind: "control" | "capture" | "apply";
    tab_id?: string;
    ref?: string;
    selector?: string;
    ts: string;
  }>;
  [key: string]: unknown;
}

function browserSessionPath(sessionId: string): string {
  return pathResolver.shared(`runtime/browser/sessions/${sessionId}.json`);
}

export function applyBrowserSessionControl(sessionId: string, action: BrowserSessionControlAction): boolean {
  const filePath = browserSessionPath(sessionId);
  if (!safeExistsSync(filePath)) return false;

  const record = JSON.parse(safeReadFile(filePath, { encoding: "utf8" }) as string) as BrowserSessionRecord;
  const nextStatus = action === "restart_browser_session" ? "expired" : "released";
  const nextRecord: BrowserSessionRecord = {
    ...record,
    updated_at: new Date().toISOString(),
    lease_status: nextStatus,
    retained: false,
    lease_expires_at: undefined,
  };
  safeWriteFile(filePath, JSON.stringify(nextRecord, null, 2));
  return true;
}
