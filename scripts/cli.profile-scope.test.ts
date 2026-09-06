import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync } from '@agent/core/secure-io';
import { resolveAppProfileResourcePath } from './cli.js';

const fixtureDirectory = pathResolver.sharedTmp(`cli-profile-directory-${process.pid}`);

afterEach(() => {
  safeRmSync(fixtureDirectory, { recursive: true, force: true });
});

describe('cli app profile resource boundaries', () => {
  it('rejects profile paths outside the repository', () => {
    expect(() => resolveAppProfileResourcePath('../outside.json')).toThrow('[RESOURCE_PATH_SCOPE]');
    expect(() => resolveAppProfileResourcePath('/tmp/outside.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects an existing profile directory', () => {
    safeMkdir(fixtureDirectory, { recursive: true });
    expect(() =>
      resolveAppProfileResourcePath(pathResolver.toRepoRelative(fixtureDirectory))
    ).toThrow('[APP_PROFILE_RESOURCE_INVALID]');
  });
});
