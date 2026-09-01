import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';

import {
  collectBrowserConversationSessions,
  collectBrowserSessions,
} from './intelligence-observations';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';

const root = pathResolver.sharedTmp(`intelligence-observations-boundary-${process.pid}`);

afterEach(() => safeRmSync(root, { recursive: true, force: true }));

describe('intelligence observation resource boundary', () => {
  it('projects regular browser files but ignores symlinked browser metadata', () => {
    const browserDir = path.join(root, 'browser');
    const conversationDir = path.join(root, 'conversation');
    const externalBrowser = path.join(root, 'external-browser.json');
    const externalConversation = path.join(root, 'external-conversation.json');
    safeMkdir(browserDir, { recursive: true });
    safeMkdir(conversationDir, { recursive: true });
    safeWriteFile(
      path.join(browserDir, 'safe.json'),
      JSON.stringify({
        session_id: 'safe-browser-session',
        updated_at: '2099-01-01T00:00:00.000Z',
        lease_status: 'active',
      })
    );
    safeWriteFile(
      externalBrowser,
      JSON.stringify({
        session_id: 'external-browser-session',
        updated_at: '2099-01-01T00:00:00.000Z',
        lease_status: 'active',
      })
    );
    safeWriteFile(
      externalConversation,
      JSON.stringify({
        session_id: 'external-conversation-session',
        updated_at: '2099-01-01T00:00:00.000Z',
      })
    );
    safeSymlinkSync(externalBrowser, path.join(browserDir, 'linked.json'));
    safeSymlinkSync(externalConversation, path.join(conversationDir, 'linked.json'));

    const browserSessions = collectBrowserSessions({ browserSessionsDir: browserDir });
    const conversationSessions = collectBrowserConversationSessions({
      browserConversationSessionsDir: conversationDir,
    });

    expect(browserSessions.map((session) => session.session_id)).toContain('safe-browser-session');
    expect(browserSessions.map((session) => session.session_id)).not.toContain(
      'external-browser-session'
    );
    expect(conversationSessions.map((session) => session.session_id)).not.toContain(
      'external-conversation-session'
    );
  });
});
