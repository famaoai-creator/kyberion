import { createHash } from 'node:crypto';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync } from '@agent/core/secure-io';
import { tryInspectCompilerOutputs } from '@agent/core/build-coordination';
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
}

const ports: BuildReadinessPorts = {
  exists: () => safeExistsSync(pathResolver.rootResolve('dist/scripts')),
  imports: async () =>
    (await import('./check_dist_workspace_imports.js')).checkDistWorkspaceImports(),
  stale: async () => (await import('./check_stale_dist.js')).findStaleDistTargets(),
};

/** Inspect one stable compiler generation; busy builds are observations, never repairs. */
export async function inspectBaselineBuildReadiness(
  io: BuildReadinessPorts = ports
): Promise<BuildReadiness> {
  const inspected = await tryInspectCompilerOutputs(async (): Promise<BuildReadiness> => {
    const import_violations: string[] = [];
    let stale_targets: StaleDistTarget[] = [];
    if (!io.exists()) import_violations.push('missing compiler entry directory: dist/scripts');
    else {
      try {
        import_violations.push(...(await io.imports()));
      } catch (error) {
        import_violations.push(
          `scan failed: ${error instanceof Error ? error.message : String(error)}`
        );
      }
      try {
        stale_targets = (await io.stale()).stale;
      } catch (error) {
        stale_targets = [
          {
            target: 'compiler-outputs',
            source_file: null,
            source_mtime_ms: null,
            dist_file: null,
            dist_mtime_ms: null,
            reason: 'scan_failed',
            detail: error instanceof Error ? error.message : String(error),
          },
        ];
      }
    }
    const evidence = [...import_violations, ...stale_targets.map((entry) => JSON.stringify(entry))];
    const passed = evidence.length === 0;
    return {
      passed,
      reason: passed ? 'compiler_outputs_ready' : 'compiler_outputs_invalid',
      fingerprint: createHash('sha256')
        .update(JSON.stringify({ import_violations, stale_targets }))
        .digest('hex'),
      evidence,
      import_violations,
      stale_targets,
    };
  });
  if (inspected.deferred === true)
    return {
      passed: false,
      deferred: true,
      reason: 'compiler_build_in_progress',
      import_violations: [],
      stale_targets: [],
    };
  return inspected.value;
}
