import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync } from '@agent/core/secure-io';
import { resolveMeetingResourcePath } from './meeting_orchestrator.js';

const fixtureDir = pathResolver.active(`shared/tmp/meeting-orchestrator-boundary-${process.pid}`);

afterEach(() => safeRmSync(fixtureDir, { recursive: true, force: true }));

describe('meeting orchestrator resource boundaries', () => {
  it('rejects profile and attendee paths outside the repository', () => {
    expect(() => resolveMeetingResourcePath('../outside.json')).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() => resolveMeetingResourcePath('/tmp/outside.json')).toThrow('[RESOURCE_PATH_SCOPE]');
  });

  it('rejects missing resource paths instead of passing them to the JSON reader', () => {
    expect(() => resolveMeetingResourcePath('knowledge/product/missing-profile.json')).toThrow(
      /does not exist/
    );
  });

  it('rejects a directory before passing it to the JSON reader', () => {
    safeMkdir(fixtureDir, { recursive: true });
    const directoryPath = path.join(fixtureDir, 'profile.json');
    safeMkdir(directoryPath, { recursive: true });

    expect(() => resolveMeetingResourcePath(pathResolver.toRepoRelative(directoryPath))).toThrow(
      '[MEETING_RESOURCE_FILE]'
    );
  });
});
