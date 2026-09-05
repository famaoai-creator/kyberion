import {
  assertSafeRepositoryPath,
  readJson,
  pathResolver,
  safeExistsSync,
  safeLstat,
  safeWriteFile,
} from './intelligence-primitives';
import { parseBrowserSessionSummary } from './intelligence-observations';
import { nowIso } from '@agent/core/foundation';

type BrowserSessionControlAction = 'close_browser_session' | 'restart_browser_session';

interface BrowserSessionRecord {
  session_id: string;
  active_tab_id: string;
  tab_count: number;
  updated_at: string;
  lease_expires_at?: string;
  lease_status: 'active' | 'released' | 'expired';
  retained: boolean;
  action_trail_count: number;
  recent_actions: Array<{
    op: string;
    kind: 'control' | 'capture' | 'apply';
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

export function applyBrowserSessionControl(
  sessionId: string,
  action: BrowserSessionControlAction
): boolean {
  let filePath: string;
  try {
    filePath = assertSafeRepositoryPath(browserSessionPath(sessionId), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) return false;
  } catch {
    return false;
  }

  let rawRecord: unknown;
  try {
    rawRecord = readJson<unknown>(filePath);
  } catch {
    return false;
  }
  if (!parseBrowserSessionSummary(rawRecord)) return false;
  const record = rawRecord as BrowserSessionRecord;
  const nextStatus = action === 'restart_browser_session' ? 'expired' : 'released';
  const nextRecord: BrowserSessionRecord = {
    ...record,
    updated_at: nowIso(),
    lease_status: nextStatus,
    retained: false,
    lease_expires_at: undefined,
  };
  safeWriteFile(filePath, JSON.stringify(nextRecord, null, 2));
  return true;
}
