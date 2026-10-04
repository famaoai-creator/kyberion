import { afterEach, describe, expect, it, vi } from 'vitest';
import { resolveExecutionPersona, resolveRole } from '@agent/core/authority';
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
    vi.stubEnv('KYBERION_PERSONA', 'mission_owner');
    const writes: Array<{ role: string | undefined; persona: string | undefined }> = [];
    vi.mocked(safeMkdir).mockImplementation(() => {
      writes.push({ role: resolveRole(), persona: resolveExecutionPersona() });
    });

    ensureDir('knowledge/personal/onboarding/context-regression-missing');

    expect(writes).toEqual([{ role: 'sovereign_concierge', persona: 'sovereign' }]);
    expect(resolveExecutionPersona()).toBe('mission_owner');
  });
});
