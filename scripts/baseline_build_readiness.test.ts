import { describe, expect, it, vi } from 'vitest';
import { withCompilerOutputs } from '@agent/core/build-coordination';
import { inspectBaselineBuildReadiness } from './baseline_build_readiness.js';
import type { StaleDistTarget } from './check_stale_dist.js';

// Exercise the real inter-process mutex under a fixture key, so a developer's
// live build and another test worker never share this test's resource.
vi.mock('@agent/core/foundation/lock-utils', async (original) => {
  const io = await original<typeof import('@agent/core/foundation/lock-utils')>();
  const key = `baseline-readiness-test-${process.pid}`;
  return {
    ...io,
    acquireLock: (_key: string, timeout?: number) => io.acquireLock(key, timeout),
    releaseLock: () => io.releaseLock(key),
  };
});

function ports() {
  return {
    exists: vi.fn(() => true),
    imports: vi.fn(async () => [] as string[]),
    stale: vi.fn(async () => ({ checked: 1, stale: [] as StaleDistTarget[] })),
  };
}

describe('baseline compiler readiness', () => {
  it('does not inspect a compiler tree while a build owns it', async () => {
    const io = ports();
    await withCompilerOutputs(async () => {
      expect(await inspectBaselineBuildReadiness(io)).toMatchObject({
        passed: false,
        deferred: true,
        reason: 'compiler_build_in_progress',
      });
      expect(io.exists).not.toHaveBeenCalled();
      expect(io.imports).not.toHaveBeenCalled();
      expect(io.stale).not.toHaveBeenCalled();
    });
    expect(await inspectBaselineBuildReadiness(io)).toMatchObject({ passed: true });
  });

  it('retains precise source/output provenance and a stable failure fingerprint', async () => {
    const io = ports();
    const finding: StaleDistTarget = {
      target: 'libs/core',
      source_file: 'libs/core/example.ts',
      source_mtime_ms: 20,
      dist_file: 'libs/core/dist/example.js',
      dist_mtime_ms: 10,
      reason: 'source_changed_since_build',
      detail: 'source hash changed',
    };
    io.stale.mockResolvedValue({ checked: 1, stale: [finding] });
    const first = await inspectBaselineBuildReadiness(io);
    expect(first).toMatchObject({ passed: false, stale_targets: [finding] });
    expect(JSON.parse(first.evidence![0])).toEqual(finding);
    expect((await inspectBaselineBuildReadiness(io)).fingerprint).toBe(first.fingerprint);
    io.stale.mockResolvedValue({
      checked: 1,
      stale: [{ ...finding, detail: 'another source hash' }],
    });
    expect((await inspectBaselineBuildReadiness(io)).fingerprint).not.toBe(first.fingerprint);
  });

  it('reports missing build outputs and scan failures without losing their cause', async () => {
    const io = ports();
    io.exists.mockReturnValue(false);
    expect(await inspectBaselineBuildReadiness(io)).toMatchObject({
      passed: false,
      import_violations: ['missing compiler entry directory: dist/scripts'],
    });
    expect(io.imports).not.toHaveBeenCalled();
    io.exists.mockReturnValue(true);
    io.imports.mockRejectedValue(new Error('invalid package manifest'));
    io.stale.mockRejectedValue(new Error('metadata unreadable'));
    expect(await inspectBaselineBuildReadiness(io)).toMatchObject({
      passed: false,
      import_violations: ['scan failed: invalid package manifest'],
      stale_targets: [{ reason: 'scan_failed', detail: 'metadata unreadable' }],
    });
  });
});
