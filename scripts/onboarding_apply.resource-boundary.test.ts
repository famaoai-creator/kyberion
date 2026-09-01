import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from '@agent/core/secure-io';
import { readInput, resolveOnboardingInputPath } from './onboarding_apply.js';

const root = pathResolver.sharedTmp(`onboarding-apply-boundary-${process.pid}`);

afterEach(() => {
  safeRmSync(root, { recursive: true, force: true });
});

describe('onboarding_apply resource boundary', () => {
  it('rejects repository-external identity input', async () => {
    expect(() => resolveOnboardingInputPath('/tmp/onboarding-identity.json')).toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
    await expect(readInput('/tmp/onboarding-identity.json')).rejects.toThrow(
      '[RESOURCE_PATH_SCOPE]'
    );
  });

  it('rejects symlinked identity input before JSON read', async () => {
    const target = path.join(root, 'target');
    const link = path.join(root, 'identity.json');
    safeMkdir(target, { recursive: true });
    safeWriteFile(path.join(target, 'identity.json'), '{}\n');
    safeSymlinkSync(path.join(target, 'identity.json'), link);

    await expect(readInput(link)).rejects.toThrow('[RESOURCE_PATH_SYMLINK]');
  });
});
