import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeRmSync } from '@agent/core/secure-io';

const PROFILE_DIR = pathResolver.rootResolve('active/shared/tmp/task-smoke');

describe('task_smoke', () => {
  afterEach(() => {
    safeRmSync(PROFILE_DIR, { recursive: true, force: true });
  });

  it('emits the smoke phases through the supplied harness printer', async () => {
    const { main } = await import('./task_smoke.js');
    const print = vi.fn();

    await main(['daily-email-triage'], print);

    expect(print).toHaveBeenCalledWith('TaskScenario smoke: daily-email-triage');
    expect(print).toHaveBeenCalledWith('TaskScenario smoke passed: daily-email-triage');
  });
});
