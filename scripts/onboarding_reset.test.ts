import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core';
import { formatResetSummary, resetOnboardingArtifacts } from './onboarding_reset.js';

const FIXTURE_ROOT = pathResolver.sharedTmp('onboarding-reset-fixture');

function writeFixture(relativePath: string, content = 'fixture'): string {
  const fullPath = path.join(FIXTURE_ROOT, relativePath);
  safeMkdir(path.dirname(fullPath), { recursive: true });
  safeWriteFile(fullPath, content);
  return fullPath;
}

describe('onboarding_reset', () => {
  afterEach(() => {
    safeRmSync(FIXTURE_ROOT, { recursive: true, force: true });
  });

  it('removes onboarding artifacts and leaves unrelated files alone', async () => {
    const profileRoot = path.join(FIXTURE_ROOT, 'personal');
    writeFixture('personal/onboarding/onboarding-state.json', '{"status":"complete"}');
    writeFixture('personal/onboarding/onboarding-summary.md', '# summary');
    writeFixture('personal/onboarding/tutorial-plan.md', '# tutorial');
    writeFixture('personal/my-identity.json', '{"name":"Famao"}');
    writeFixture('personal/my-vision.md', '# vision');
    writeFixture('personal/agent-identity.json', '{"agent_id":"agent-001"}');
    writeFixture('personal/connections/slack.json', '{"service_id":"slack"}');
    writeFixture('personal/tenants/acme.json', '{"tenant_slug":"acme"}');
    writeFixture('personal/notes.txt', 'keep me');

    const result = await resetOnboardingArtifacts({
      profileRoot,
      force: true,
    });

    expect(result.profileRoot).toBe(profileRoot);
    expect(result.removed).toEqual(
      expect.arrayContaining([
        path.join(profileRoot, 'onboarding'),
        path.join(profileRoot, 'my-identity.json'),
        path.join(profileRoot, 'my-vision.md'),
        path.join(profileRoot, 'agent-identity.json'),
      ])
    );
    expect(safeExistsSync(path.join(profileRoot, 'onboarding'))).toBe(false);
    expect(safeExistsSync(path.join(profileRoot, 'my-identity.json'))).toBe(false);
    expect(safeExistsSync(path.join(profileRoot, 'my-vision.md'))).toBe(false);
    expect(safeExistsSync(path.join(profileRoot, 'agent-identity.json'))).toBe(false);
    expect(safeExistsSync(path.join(profileRoot, 'connections'))).toBe(true);
    expect(safeExistsSync(path.join(profileRoot, 'connections/slack.json'))).toBe(true);
    expect(safeExistsSync(path.join(profileRoot, 'tenants'))).toBe(true);
    expect(safeExistsSync(path.join(profileRoot, 'tenants/acme.json'))).toBe(true);
    expect(safeReadFile(path.join(profileRoot, 'notes.txt'), { encoding: 'utf8' })).toBe('keep me');
    expect(formatResetSummary(result)).toContain('Onboarding reset complete.');
  });

  it('returns a no-op summary when there is nothing to reset', async () => {
    const profileRoot = path.join(FIXTURE_ROOT, 'personal');

    const result = await resetOnboardingArtifacts({ profileRoot, force: true });

    expect(result).toEqual({ profileRoot, removed: [] });
    expect(formatResetSummary(result)).toContain('No onboarding artifacts found');
  });
});
