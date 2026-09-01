import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { applyBrowserSessionControl } from './browser-session-control';

const suffix = `boundary-${process.pid}-${Date.now()}`;
const sessionDir = pathResolver.shared('runtime/browser/sessions');
const sessionPath = path.join(sessionDir, `${suffix}.json`);
const targetPath = pathResolver.sharedTmp(`browser-session-control-${suffix}.json`);

afterEach(() => {
  safeRmSync(sessionPath, { force: true });
  safeRmSync(targetPath, { force: true });
});

describe('browser session control resource boundary', () => {
  it('does not read or write a symlinked session record', () => {
    safeMkdir(sessionDir, { recursive: true });
    safeWriteFile(
      targetPath,
      JSON.stringify({
        session_id: suffix,
        active_tab_id: 'tab-1',
        tab_count: 1,
        updated_at: '2026-09-01T00:00:00.000Z',
        lease_status: 'active',
        retained: true,
        action_trail_count: 0,
        recent_actions: [],
      })
    );
    safeSymlinkSync(targetPath, sessionPath);

    expect(applyBrowserSessionControl(suffix, 'close_browser_session')).toBe(false);
  });
});
