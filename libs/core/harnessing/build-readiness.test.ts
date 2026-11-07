import { afterEach, describe, expect, it } from 'vitest';
import {
  inspectBuildReadiness,
  judgeBuildReadiness,
  registerBuildReadinessInspector,
  resetBuildReadinessInspector,
  type BuildReadinessInspection,
} from './build-readiness.js';

function inspection(overrides: Partial<BuildReadinessInspection> = {}): BuildReadinessInspection {
  return {
    deferred: false,
    entrypointPresent: true,
    importViolations: [],
    staleFindings: [],
    scanFailures: [],
    ...overrides,
  };
}

afterEach(() => {
  resetBuildReadinessInspector();
});

describe('judgeBuildReadiness', () => {
  it('judges a clean inspection as fresh and passes the checked generation through', () => {
    const result = judgeBuildReadiness(
      inspection({
        generation: { provenance: 'receipt', receiptId: 'gen-1234', sourceFingerprint: 'abc' },
      })
    );
    expect(result).toMatchObject({
      state: 'fresh',
      code: 'fresh',
      generation: { provenance: 'receipt', receiptId: 'gen-1234' },
    });
  });

  it('defers to building while the compiler-outputs lock is held', () => {
    expect(
      judgeBuildReadiness(inspection({ deferred: true, entrypointPresent: false }))
    ).toMatchObject({ state: 'building', code: 'compiler_build_in_progress' });
  });

  it('judges a missing entry tree as missing, not stale', () => {
    expect(
      judgeBuildReadiness(
        inspection({
          entrypointPresent: false,
          importViolations: ['missing compiler entry directory: dist/scripts'],
        })
      )
    ).toMatchObject({ state: 'missing', code: 'missing_entrypoint', target: 'dist/scripts' });
  });

  it('judges stale findings and import violations as stale with the driving target', () => {
    const result = judgeBuildReadiness(
      inspection({
        staleFindings: [
          { target: 'libs/core', code: 'source_changed_since_build', sourceFile: 'libs/core/x.ts' },
        ],
      })
    );
    expect(result).toMatchObject({
      state: 'stale',
      code: 'source_changed_since_build',
      target: 'libs/core',
    });

    const imports = judgeBuildReadiness(
      inspection({ importViolations: ['dist/scripts/a.js: cannot resolve'] })
    );
    expect(imports).toMatchObject({ state: 'stale', code: 'import_violation' });
  });

  it('keeps scan failures as unknown — never green, never fake-stale', () => {
    expect(
      judgeBuildReadiness(
        inspection({
          scanFailures: [{ target: 'libs/core', code: 'scan_failed', detail: 'permission denied' }],
        })
      )
    ).toMatchObject({ state: 'unknown', code: 'scan_failed' });
    expect(judgeBuildReadiness(inspection({ scanError: 'walk aborted' }))).toMatchObject({
      state: 'unknown',
    });
  });

  it('lets a proven stale finding win over scan uncertainty elsewhere', () => {
    expect(
      judgeBuildReadiness(
        inspection({
          staleFindings: [{ target: 'root:scripts', code: 'emit_missing' }],
          scanFailures: [{ target: 'libs/core', code: 'scan_failed' }],
        })
      )
    ).toMatchObject({ state: 'stale', code: 'emit_missing' });
  });

  it('detects inputs that moved while the scan ran', () => {
    expect(
      judgeBuildReadiness(inspection({ inputFingerprintBefore: 'a', inputFingerprintAfter: 'b' }))
    ).toMatchObject({ state: 'changed_during_scan', code: 'changed_during_scan' });
  });

  it('does not flag a stable observation or a missing fingerprint as changed', () => {
    expect(
      judgeBuildReadiness(inspection({ inputFingerprintBefore: 'a', inputFingerprintAfter: 'a' }))
    ).toMatchObject({ state: 'fresh' });
    expect(judgeBuildReadiness(inspection({ inputFingerprintBefore: 'a' }))).toMatchObject({
      state: 'fresh',
    });
  });
});

describe('inspectBuildReadiness (inspector seam)', () => {
  it('stays unknown — not green — when no inspector is installed', async () => {
    expect(await inspectBuildReadiness()).toMatchObject({
      state: 'unknown',
      code: 'inspector_unavailable',
    });
  });

  it('stays unknown when the inspector throws', async () => {
    registerBuildReadinessInspector(async () => {
      throw new Error('scan exploded');
    });
    expect(await inspectBuildReadiness()).toMatchObject({
      state: 'unknown',
      code: 'inspection_failed',
    });
  });

  it('judges the installed inspector’s observations', async () => {
    registerBuildReadinessInspector(async () =>
      inspection({ staleFindings: [{ target: 'libs/core', code: 'orphaned_emit' }] })
    );
    expect(await inspectBuildReadiness()).toMatchObject({ state: 'stale', code: 'orphaned_emit' });
  });
});
