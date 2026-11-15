import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveExecutionBaseRole, resolveRole } from '@agent/core/authority';
import { safeMkdir } from '@agent/core/secure-io';
import { ensureDir } from './onboarding_apply.js';

vi.mock('@agent/core/secure-io', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@agent/core/secure-io')>()),
  safeMkdir: vi.fn(),
}));

describe('onboarding directory writer context', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('creates a fresh profile directory using the onboarding writer, preserving the selected persona', () => {
    vi.stubEnv('MISSION_ROLE', 'sovereign_concierge');
    vi.stubEnv('KYBERION_BASE_ROLE', 'mission_owner');
    const writes: Array<{ role: string | undefined; persona: string | undefined }> = [];
    vi.mocked(safeMkdir).mockImplementation(() => {
      writes.push({ role: resolveRole(), persona: resolveExecutionBaseRole() });
    });

    ensureDir('knowledge/personal/onboarding/context-regression-missing');

    expect(writes).toEqual([{ role: 'sovereign_concierge', persona: 'sovereign' }]);
    expect(resolveExecutionBaseRole()).toBe('mission_owner');
  });
});
