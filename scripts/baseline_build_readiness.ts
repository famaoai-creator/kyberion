import { createHash } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { tryInspectCompilerOutputs } from '@agent/core/build-coordination';
import {
  hasBuildReadinessInspector,
  registerBuildReadinessInspector,
  type BuildReadinessInspection,
  type BuildReadinessFinding,
} from '@agent/core/build-readiness';
import { readBuildGenerationIdentity } from '@agent/core/build-generation';
import type { LayerObservation } from '@agent/core/pfc/PfcController';
import type { StaleDistScan, StaleDistTarget } from './check_stale_dist.js';

export interface BuildReadiness extends LayerObservation {
  import_violations: string[];
  stale_targets: StaleDistTarget[];
}

interface BuildReadinessPorts {
  exists: () => boolean;
  imports: () => Promise<string[]>;
  stale: () => Promise<StaleDistScan>;
  /** Compiler-input fingerprint used to bracket the scan (stability check). */
  fingerprint?: () => Promise<{ hash: string } | null>;
}

const ports: BuildReadinessPorts = {
  exists: () => safeExistsSync(pathResolver.rootResolve('dist/scripts')),
  imports: async () =>
    (await import('./check_dist_workspace_imports.js')).checkDistWorkspaceImports(),
  stale: async () => (await import('./check_stale_dist.js')).findStaleDistTargets(),
  fingerprint: async () => (await import('./check_stale_dist.js')).fingerprintBuildInputs(),
};

/**
 * The raw observations one locked inspection produced: the normalized
 * `BuildReadinessInspection` for the shared core judgment, plus the original
 * stale-target / import-violation records in their check_stale_dist shape so
 * the L2 `BuildReadiness` contract keeps its exact evidence.
 */
export interface BaselineBuildInspection {
  inspection: BuildReadinessInspection;
  staleTargets: StaleDistTarget[];
  importViolations: string[];
}

function targetToFinding(target: StaleDistTarget): BuildReadinessFinding {
  return {
    target: target.target,
    code: target.reason,
    ...(target.detail ? { detail: target.detail } : {}),
    sourceFile: target.source_file,
    distFile: target.dist_file,
  };
}

/** Inspect one stable compiler generation; busy builds are observations, never repairs. */
export async function collectBaselineBuildInspection(
  io: BuildReadinessPorts = ports
): Promise<BaselineBuildInspection> {
  const inspected = await tryInspectCompilerOutputs(async (): Promise<BaselineBuildInspection> => {
    // `importViolations` keeps the L2 contract's raw evidence strings;
    // `realImportViolations` carries only genuine resolution failures so a
    // scan error is judged `unknown`, never mislabeled `stale`.
    const importViolations: string[] = [];
    const realImportViolations: string[] = [];
    const staleFindings: BuildReadinessFinding[] = [];
    const scanFailures: BuildReadinessFinding[] = [];
    let staleTargets: StaleDistTarget[] = [];

    const fingerprint = async (): Promise<{ hash: string } | null> => {
      if (!io.fingerprint) return null;
      try {
        return await io.fingerprint();
      } catch (error) {
        scanFailures.push({
          target: 'compiler-inputs',
          code: 'scan_failed',
          detail: `input fingerprint failed: ${error instanceof Error ? error.message : String(error)}`,
        });
        return null;
      }
    };

    const before = await fingerprint();
    const entrypointPresent = io.exists();
    if (!entrypointPresent) {
      importViolations.push('missing compiler entry directory: dist/scripts');
    } else {
      try {
        const violations = await io.imports();
        importViolations.push(...violations);
        realImportViolations.push(...violations);
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        importViolations.push(`scan failed: ${detail}`);
        scanFailures.push({ target: 'dist-imports', code: 'scan_failed', detail });
      }
      try {
        staleTargets = (await io.stale()).stale;
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        staleTargets = [
          {
            target: 'compiler-outputs',
            source_file: null,
            source_mtime_ms: null,
            dist_file: null,
            dist_mtime_ms: null,
            reason: 'scan_failed',
            detail,
          },
        ];
      }
      for (const target of staleTargets) {
        // A target the scan could not judge is uncertainty, not staleness —
        // the shared judge keeps the two buckets apart.
        if (target.reason === 'scan_failed') scanFailures.push(targetToFinding(target));
        else staleFindings.push(targetToFinding(target));
      }
    }
    const after = await fingerprint();
    const inspection: BuildReadinessInspection = {
      deferred: false,
      entrypointPresent,
      importViolations: realImportViolations,
      staleFindings,
      scanFailures,
      ...(before?.hash !== undefined ? { inputFingerprintBefore: before.hash } : {}),
      ...(after?.hash !== undefined ? { inputFingerprintAfter: after.hash } : {}),
      generation: readBuildGenerationIdentity(),
    };
    return { inspection, staleTargets, importViolations };
  });
  if (inspected.deferred === true) {
    return {
      inspection: {
        deferred: true,
        entrypointPresent: false,
        importViolations: [],
        staleFindings: [],
        scanFailures: [],
        generation: { provenance: 'none' },
      },
      staleTargets: [],
      importViolations: [],
    };
  }
  return inspected.value;
}

/** L2 layer observation — same evidence the sentinel has always recorded. */
export async function inspectBaselineBuildReadiness(
  io: BuildReadinessPorts = ports
): Promise<BuildReadiness> {
  const { inspection, staleTargets, importViolations } = await collectBaselineBuildInspection(io);
  if (inspection.deferred) {
    return {
      passed: false,
      deferred: true,
      reason: 'compiler_build_in_progress',
      import_violations: [],
      stale_targets: [],
    };
  }
  const evidence = [...importViolations, ...staleTargets.map((entry) => JSON.stringify(entry))];
  const passed = evidence.length === 0;
  return {
    passed,
    reason: passed ? 'compiler_outputs_ready' : 'compiler_outputs_invalid',
    fingerprint: createHash('sha256')
      .update(JSON.stringify({ import_violations: importViolations, stale_targets: staleTargets }))
      .digest('hex'),
    evidence,
    import_violations: importViolations,
    stale_targets: staleTargets,
  };
}

/**
 * Install this canonical inspection as the `build.readiness-inspector` seam
 * provider so core surfaces (the `repo-build.receipt` doctor probe) judge on
 * the same facts the L2 layer and `check:stale-dist` use. Idempotent.
 */
export function installBaselineBuildReadinessInspector(): void {
  if (hasBuildReadinessInspector()) return;
  registerBuildReadinessInspector(async () => (await collectBaselineBuildInspection()).inspection);
}
