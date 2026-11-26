import { describe, expect, it, vi } from 'vitest';

// The location-derived scope is stubbed: this suite checks the runner wiring
// (derive → narrow against the active envelope → fail before any effect), not
// the attribution itself (libs/core/pipeline/run-scope.test.ts).
vi.mock('@agent/core/pipeline/run-manifest', async (importOriginal) => {
  const original = await importOriginal<typeof import('@agent/core/pipeline/run-manifest')>();
  return {
    ...original,
    deriveRunScope: vi.fn((inputPath: string) => ({
      input_path: inputPath,
      tier: 'confidential',
      tenant_slug: 'tenant-b',
      source: 'location',
    })),
  };
});

const { executePipelineFile, isPipelineNotStartedError } = await import(
  new URL('../run_pipeline.js', import.meta.url).href
);
const { mintScopeEnvelope, withScopeEnvelope } = await import('@agent/core/scope-envelope');

describe('pipeline run scope wiring', () => {
  it('rejects a nested run whose file belongs to another tenant before it starts', async () => {
    const parent = mintScopeEnvelope({
      identity: { tier: 'confidential', tenant_slug: 'tenant-a', session_id: 'parent-run' },
      policy: { purpose: 'parent pipeline' },
      env: {},
    });
    let failure: unknown;
    try {
      await withScopeEnvelope(parent, () =>
        executePipelineFile('pipelines/vital-check.json', { quiet: true, trustResolved: true })
      );
    } catch (error) {
      failure = error;
    }
    expect(String(failure)).toMatch(
      /\[RUN_SCOPE_MISMATCH\] nested pipeline pipelines\/vital-check\.json belongs to tenant 'tenant-b' but the running scope is tenant 'tenant-a'/u
    );
    expect(isPipelineNotStartedError(failure)).toBe(true);
  });
});
