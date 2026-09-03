import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { withExecutionContext } from './authority.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { getSlackOnboardingState } from './slack-onboarding.js';

function statePath(channel: string, threadTs: string): string {
  const safeThread = threadTs.replace(/[^a-zA-Z0-9._-]/g, '_');
  return pathResolver.resolve(
    `active/shared/coordination/channels/slack/onboarding/${channel}-${safeThread}.json`
  );
}

const testArtifacts = ['1710000000.000500', 'malformed', 'directory', 'target', 'linked'].map(
  (threadTs) => statePath('C123', threadTs)
);

const validState = (channel = 'C123', threadTs = '1710000000.000500') => ({
  channel,
  threadTs,
  currentField: 'name',
  answers: {},
  completed: false,
  updatedAt: '2026-09-03T00:00:00.000Z',
});

describe('Slack onboarding state loader', () => {
  afterEach(() => {
    withExecutionContext('slack_bridge', () => {
      for (const artifact of testArtifacts) safeRmSync(artifact, { recursive: true, force: true });
    });
  });

  it('loads a state with its channel and thread binding', () => {
    withExecutionContext('slack_bridge', () => {
      const filePath = statePath('C123', '1710000000.000500');
      safeMkdir(path.dirname(filePath), { recursive: true });
      safeWriteFile(filePath, JSON.stringify(validState()));

      expect(getSlackOnboardingState('C123', '1710000000.000500')).toMatchObject({
        channel: 'C123',
        threadTs: '1710000000.000500',
      });
    });
  });

  it('rejects a state whose persisted binding belongs to another thread', () => {
    withExecutionContext('slack_bridge', () => {
      const filePath = statePath('C123', '1710000000.000500');
      safeMkdir(path.dirname(filePath), { recursive: true });
      safeWriteFile(filePath, JSON.stringify(validState('C999', '1710000000.000500')));

      expect(() => getSlackOnboardingState('C123', '1710000000.000500')).toThrow(
        '[SLACK_ONBOARDING_SCOPE_MISMATCH]'
      );
    });
  });

  it('returns no state for malformed, directory, or symlink artifacts', () => {
    withExecutionContext('slack_bridge', () => {
      const malformedPath = statePath('C123', 'malformed');
      const directoryPath = statePath('C123', 'directory');
      const targetPath = statePath('C123', 'target');
      const linkedPath = statePath('C123', 'linked');
      safeMkdir(path.dirname(malformedPath), { recursive: true });
      safeWriteFile(malformedPath, JSON.stringify({ channel: 'C123' }));
      safeMkdir(directoryPath);
      safeWriteFile(targetPath, JSON.stringify(validState('C123', 'target')));
      safeRmSync(linkedPath, { recursive: true, force: true });
      safeSymlinkSync(targetPath, linkedPath);

      expect(() => getSlackOnboardingState('C123', 'malformed')).toThrow(
        /Invalid catalog slack-onboarding-state/
      );
      expect(getSlackOnboardingState('C123', 'directory')).toBeNull();
      expect(() => getSlackOnboardingState('C123', 'linked')).toThrow('[RESOURCE_PATH_SYMLINK]');
    });
  });
});
