/**
 * Package export-surface ratchet.
 *
 * `@agent/core` publishes one subpath per module, so its `exports` map is the
 * size of the package's public surface. The ratchet keeps that surface from
 * growing silently: a workspace package may not publish more subpaths than its
 * baseline records. New capability belongs in a package outside core (for
 * example `libs/shared-*`), or the baseline is raised in the same change so
 * the growth is visible in review. When a package shrinks, the checker reports
 * the lower count so the baseline can be lowered with `--write-baseline`.
 */
import * as path from 'node:path';
import { withExecutionContext } from '@agent/core/authority';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeReaddir, safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { resolveCiGateBaselinePath } from './lib/ci-gate-baseline.js';
import { readSafeJsonFile } from './lib/json-input.js';

export interface ExportSurfaceBaseline {
  version: 1;
  /** Repository-relative package directory → maximum published subpaths. */
  packages: Record<string, number>;
}

export interface ExportSurfaceReport {
  counts: Record<string, number>;
  violations: string[];
  /** Packages whose count fell below the baseline (the baseline can be lowered). */
  shrunk: string[];
}

const LIBS_DIR = 'libs';

/** Count the subpaths a package.json publishes (`exports` keys; 0 when absent). */
export function countPackageExports(packageJson: unknown): number {
  if (!packageJson || typeof packageJson !== 'object') return 0;
  const exportsValue = (packageJson as Record<string, unknown>).exports;
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) return 0;
  return Object.keys(exportsValue).filter((key) => key === '.' || key.startsWith('./')).length;
}

/** Export counts for every libs/* workspace package that publishes an exports map. */
export function collectExportCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const entry of safeReaddir(pathResolver.rootResolve(LIBS_DIR)).sort()) {
    const manifest = pathResolver.rootResolve(path.posix.join(LIBS_DIR, entry, 'package.json'));
    if (!safeExistsSync(manifest)) continue;
    const count = countPackageExports(readSafeJsonFile<unknown>(manifest, `${entry} package.json`));
    if (count > 0) counts[`${LIBS_DIR}/${entry}`] = count;
  }
  return counts;
}

export function compareExportSurface(
  counts: Record<string, number>,
  baseline: ExportSurfaceBaseline
): ExportSurfaceReport {
  const violations: string[] = [];
  const shrunk: string[] = [];
  for (const [pkg, count] of Object.entries(counts)) {
    const limit = baseline.packages[pkg];
    if (limit === undefined) {
      violations.push(
        `${pkg}: publishes ${count} subpaths but has no baseline entry — add it with --write-baseline`
      );
    } else if (count > limit) {
      violations.push(
        `${pkg}: publishes ${count} subpaths, baseline allows ${limit} (+${count - limit}) — put new modules in a package outside core, or raise the baseline in this change`
      );
    } else if (count < limit) {
      shrunk.push(`${pkg}: ${count} < baseline ${limit}`);
    }
  }
  for (const pkg of Object.keys(baseline.packages)) {
    if (!(pkg in counts)) shrunk.push(`${pkg}: no longer publishes an exports map`);
  }
  return { counts, violations: violations.sort(), shrunk: shrunk.sort() };
}

export const runCheckPackageExportSurface = defineScript({
  name: 'check:package-export-surface',
  flags: [],
  run(context) {
    const baselinePath = resolveCiGateBaselinePath('package-export-surface');
    const counts = collectExportCounts();
    if (context.argv.includes('--write-baseline')) {
      const next: ExportSurfaceBaseline = { version: 1, packages: counts };
      withExecutionContext('ecosystem_architect', () =>
        safeWriteFile(baselinePath, `${JSON.stringify(next, null, 2)}\n`)
      );
      context.print(`[check:package-export-surface] baseline written (${JSON.stringify(counts)})`);
      return { counts, violations: [], shrunk: [] };
    }
    const baseline = readSafeJsonFile<ExportSurfaceBaseline>(
      baselinePath,
      'package export surface baseline'
    );
    const report = compareExportSurface(counts, baseline);
    if (report.violations.length > 0) {
      throw new ScriptExitError(
        1,
        ['export surface grew:', ...report.violations.map((line) => `- ${line}`)].join('\n')
      );
    }
    const core = counts['libs/core'];
    context.print(
      `[check:package-export-surface] OK${core === undefined ? '' : ` (@agent/core ${core} subpaths)`}`
    );
    if (report.shrunk.length > 0) {
      context.print(
        `[check:package-export-surface] surface shrank; lower the baseline with --write-baseline:\n${report.shrunk
          .map((line) => `- ${line}`)
          .join('\n')}`
      );
    }
    return report;
  },
});

if (
  isDirectScript(import.meta.url, 'check_package_export_surface.ts') ||
  isDirectScript(import.meta.url, 'check_package_export_surface.js')
)
  void runCheckPackageExportSurface();
