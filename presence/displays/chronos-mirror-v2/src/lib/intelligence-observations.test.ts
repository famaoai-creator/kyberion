import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  collectBrowserConversationSessions,
  collectBrowserSessions,
} from './intelligence-observations';

const browserSessionsDir = pathResolver.shared('runtime/browser/sessions');
const browserConversationSessionsDir = pathResolver.shared('runtime/browser/conversation-sessions');
const browserSessionFile = path.join(browserSessionsDir, 'chronos-intelligence-observations-test.json');
const browserConversationSessionFile = path.join(
  browserConversationSessionsDir,
  'chronos-intelligence-observations-test.json',
);

afterEach(() => {
  for (const file of [browserSessionFile, browserConversationSessionFile]) {
    try {
      if (file) safeRmSync(file);
    } catch {
      // Ignore cleanup failures in tests.
    }
  }
});

describe('intelligence observations', () => {
  it('collects browser sessions from the runtime directory', () => {
    safeMkdir(browserSessionsDir, { recursive: true });
    safeWriteFile(
      browserSessionFile,
      JSON.stringify({
        session_id: 'chronos-intelligence-observations-test',
        active_tab_id: 'tab-1',
        tab_count: 2,
        updated_at: '2099-01-01T00:00:00.000Z',
        lease_status: 'active',
        retained: true,
        action_trail_count: 1,
        recent_actions: [],
      }, null, 2),
    );

    expect(collectBrowserSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: 'chronos-intelligence-observations-test',
        }),
      ]),
    );
  });

  it('collects browser conversation sessions from the runtime directory', () => {
    safeMkdir(browserConversationSessionsDir, { recursive: true });
    safeWriteFile(
      browserConversationSessionFile,
      JSON.stringify({
        session_id: 'chronos-intelligence-observations-test',
        surface: 'chronos',
        status: 'active',
        mode: 'interactive',
        updated_at: '2099-01-01T00:00:00.000Z',
        goal: { summary: 'test goal' },
        candidate_targets: ['a'],
        conversation_context: { pending_confirmation: true },
        active_step: { description: 'step' },
      }, null, 2),
    );

    expect(collectBrowserConversationSessions()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          session_id: 'chronos-intelligence-observations-test',
          surface: 'chronos',
        }),
      ]),
    );
  });
});
