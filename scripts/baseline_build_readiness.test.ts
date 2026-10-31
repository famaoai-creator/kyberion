import { describe, expect, it, vi } from 'vitest';
import { withCompilerOutputs } from '@agent/core/build-coordination';
import {
  collectBaselineBuildInspection,
  inspectBaselineBuildReadiness,
} from './baseline_build_readiness.js';
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

describe('collectBaselineBuildInspection (shared build-readiness basis)', () => {
  it('separates real staleness from scan failures for the shared judge', async () => {
    const io = ports();
    const staleFinding: StaleDistTarget = {
      target: 'libs/core',
      source_file: 'libs/core/example.ts',
      source_mtime_ms: 20,
      dist_file: 'libs/core/dist/example.js',
      dist_mtime_ms: 10,
      reason: 'emit_missing',
    };
    const undecidable: StaleDistTarget = {
      target: 'root:scripts',
      source_file: null,
      source_mtime_ms: null,
      dist_file: null,
      dist_mtime_ms: null,
      reason: 'scan_failed',
      detail: 'metadata unreadable',
    };
    io.stale.mockResolvedValue({ checked: 2, stale: [staleFinding, undecidable] });

    const { inspection, staleTargets } = await collectBaselineBuildInspection(io);
    expect(inspection.staleFindings).toEqual([
      expect.objectContaining({ target: 'libs/core', code: 'emit_missing' }),
    ]);
    expect(inspection.scanFailures).toEqual([
      expect.objectContaining({ target: 'root:scripts', code: 'scan_failed' }),
    ]);
    // The L2 contract keeps the raw records untouched.
    expect(staleTargets).toEqual([staleFinding, undecidable]);
  });

  it('treats an imports-scan exception as uncertainty, not a violation', async () => {
    const io = ports();
    io.imports.mockRejectedValue(new Error('invalid package manifest'));
    const { inspection } = await collectBaselineBuildInspection(io);
    expect(inspection.importViolations).toEqual([]);
    expect(inspection.scanFailures).toEqual([
      expect.objectContaining({ target: 'dist-imports', code: 'scan_failed' }),
    ]);
  });

  it('brackets the scan with input fingerprints for change detection', async () => {
    const io = {
      ...ports(),
      fingerprint: vi
        .fn<() => Promise<{ hash: string } | null>>()
        .mockResolvedValueOnce({ hash: 'before' })
        .mockResolvedValueOnce({ hash: 'before' }),
    };
    const stable = await collectBaselineBuildInspection(io);
    expect(stable.inspection).toMatchObject({
      inputFingerprintBefore: 'before',
      inputFingerprintAfter: 'before',
    });
    expect(io.fingerprint).toHaveBeenCalledTimes(2);

    io.fingerprint
      .mockReset()
      .mockResolvedValueOnce({ hash: 'a' })
      .mockResolvedValueOnce({ hash: 'b' });
    const moved = await collectBaselineBuildInspection(io);
    expect(moved.inspection).toMatchObject({
      inputFingerprintBefore: 'a',
      inputFingerprintAfter: 'b',
    });
  });

  it('defers the whole inspection while a build owns the lock', async () => {
    const io = { ...ports(), fingerprint: vi.fn(async () => ({ hash: 'x' })) };
    await withCompilerOutputs(async () => {
      const { inspection } = await collectBaselineBuildInspection(io);
      expect(inspection.deferred).toBe(true);
      expect(io.fingerprint).not.toHaveBeenCalled();
      expect(io.exists).not.toHaveBeenCalled();
    });
  });
});
