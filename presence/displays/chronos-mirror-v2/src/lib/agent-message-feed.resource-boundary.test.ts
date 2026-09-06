import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { collectA2AHandoffs } from './agent-message-feed';

const fixtureRoot = pathResolver.sharedTmp('agent-message-feed-boundary-test');

afterEach(() => {
  safeRmSync(fixtureRoot, { recursive: true, force: true });
});

describe('agent message feed resource boundaries', () => {
  it('does not project an orchestration event log reached through a symlink', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const targetPath = path.join(fixtureRoot, 'target.jsonl');
    const linkedPath = path.join(fixtureRoot, 'linked.jsonl');
    safeWriteFile(
      targetPath,
      JSON.stringify({
        event_type: 'a2a_message_routed',
        mission_id: 'MSN-LINKED',
        sender: 'sender',
        receiver: 'receiver',
      })
    );
    safeSymlinkSync(targetPath, linkedPath);

    expect(collectA2AHandoffs({ observationPath: linkedPath })).toEqual([]);
  });

  it('ignores primitive and array records while retaining a valid handoff', () => {
    safeMkdir(fixtureRoot, { recursive: true });
    const observationPath = path.join(fixtureRoot, 'events.jsonl');
    safeWriteFile(
      observationPath,
      [
        '{',
        'null',
        JSON.stringify(['a2a_message_routed']),
        JSON.stringify({ event_type: 'a2a_message_routed', mission_id: 'MSN-VALID' }),
      ].join('\n')
    );

    expect(collectA2AHandoffs({ observationPath })).toEqual([
      expect.objectContaining({ missionId: 'MSN-VALID', sender: 'unknown', receiver: 'unknown' }),
    ]);
  });
});
