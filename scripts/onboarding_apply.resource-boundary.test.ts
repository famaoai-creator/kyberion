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

  it('rejects schema-invalid identity input through the canonical loader', async () => {
    const file = path.join(root, 'identity.json');
    safeMkdir(root, { recursive: true });
    safeWriteFile(
      file,
      JSON.stringify({
        identity: {
          name: 'Famao',
          language: 'ja',
          interaction_style: 'Minimalist',
          primary_domain: 'operations',
          vision: 'Validate first.',
          agent_id: 'agent-001',
        },
        unexpected: true,
      })
    );

    await expect(readInput(file)).rejects.toThrow(/Invalid catalog onboarding-apply-input/u);
  });
});
