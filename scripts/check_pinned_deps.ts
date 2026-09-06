/** PI-12: reject dependency declarations that bypass the lockfile policy. */
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import { readSafeJsonFile } from './lib/json-input.js';

const MINIMUM_RELEASE_AGE_MINUTES = 1_440;

type PackageManifest = {
  packageManager?: string;
  overrides?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string> };
};

export function readPinnedTextFile(filePath: string, label: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return readTextFile(filePath);
}

export function checkPinnedDependencies(): string[] {
  const manifest = readSafeJsonFile<PackageManifest>(
    pathResolver.rootResolve('package.json'),
    'package manifest'
  );
  const findings: string[] = [];

  if (!/^pnpm@\d+\.\d+\.\d+$/u.test(String(manifest.packageManager || ''))) {
    findings.push('packageManager must pin an exact pnpm version');
  }

  const overrides = { ...(manifest.overrides || {}), ...(manifest.pnpm?.overrides || {}) };
  for (const [name, specifier] of Object.entries(overrides)) {
    if (/^(?:\^|~|[*>|]|latest$|next$)/u.test(String(specifier).trim())) {
      findings.push(`override '${name}' is not exact: ${specifier}`);
    }
  }

  try {
    const lockfile = readPinnedTextFile(
      pathResolver.rootResolve('pnpm-lock.yaml'),
      'pnpm-lock.yaml'
    );
    if (!/^lockfileVersion:\s*['"]?9(?:\.0)?['"]?/mu.test(lockfile)) {
      findings.push('pnpm-lock.yaml must use the governed lockfileVersion 9');
    }
  } catch {
    findings.push('pnpm-lock.yaml is required');
  }

  try {
    const npmrc = readPinnedTextFile(pathResolver.rootResolve('.npmrc'), '.npmrc');
    const releaseAge = npmrc.match(/^\s*minimum-release-age\s*=\s*(\d+)\s*$/mu);
    if (!releaseAge) {
      findings.push('.npmrc must set minimum-release-age');
    } else if (Number(releaseAge[1]) < MINIMUM_RELEASE_AGE_MINUTES) {
      findings.push(
        `.npmrc minimum-release-age must be at least ${MINIMUM_RELEASE_AGE_MINUTES} minutes`
      );
    }
    if (!/^\s*minimum-release-age-strict\s*=\s*true\s*$/imu.test(npmrc)) {
      findings.push('.npmrc must set minimum-release-age-strict=true');
    }
  } catch {
    findings.push('.npmrc is required for the dependency release-age policy');
  }

  return findings;
}

export const runCheckPinnedDeps = defineScript({
  name: 'check:pinned-deps',
  flags: [],
  run(context) {
    const findings = checkPinnedDependencies();
    if (findings.length > 0) {
      context.print('[check:pinned-deps] FAILED');
      for (const finding of findings) context.print(`- ${finding}`);
      throw new ScriptExitError(1);
    }
    context.print('[check:pinned-deps] OK (package manager, overrides, and lockfile pinned)');
    return { findings };
  },
});

if (
  isDirectScript(import.meta.url, 'check_pinned_deps.ts') ||
  isDirectScript(import.meta.url, 'check_pinned_deps.js')
)
  void runCheckPinnedDeps();
