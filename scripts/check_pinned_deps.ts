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
    let releaseAgeMinutes: number | undefined;
    let strict: boolean | undefined;

    // Check pnpm-workspace.yaml (canonical pnpm workspace settings)
    try {
      const workspaceYaml = readPinnedTextFile(
        pathResolver.rootResolve('pnpm-workspace.yaml'),
        'pnpm-workspace.yaml'
      );
      const wsAge = workspaceYaml.match(/^\s*minimumReleaseAge\s*:\s*(\d+)\s*$/mu);
      if (wsAge) releaseAgeMinutes = Number(wsAge[1]);
      const wsStrict = workspaceYaml.match(/^\s*minimumReleaseAgeStrict\s*:\s*true\s*$/imu);
      if (wsStrict) strict = true;
    } catch {
      // workspace file optional or read error handled below
    }

    // Fall back to .npmrc if not found in workspace file
    if (releaseAgeMinutes === undefined || !strict) {
      try {
        const npmrc = readPinnedTextFile(pathResolver.rootResolve('.npmrc'), '.npmrc');
        const releaseAge = npmrc.match(/^\s*minimum-release-age\s*=\s*(\d+)\s*$/mu);
        if (releaseAge && releaseAgeMinutes === undefined)
          releaseAgeMinutes = Number(releaseAge[1]);
        if (/^\s*minimum-release-age-strict\s*=\s*true\s*$/imu.test(npmrc)) strict = true;
      } catch {
        // handled below
      }
    }

    if (releaseAgeMinutes === undefined) {
      findings.push(
        'pnpm-workspace.yaml or .npmrc must set minimumReleaseAge / minimum-release-age'
      );
    } else if (releaseAgeMinutes < MINIMUM_RELEASE_AGE_MINUTES) {
      findings.push(
        `minimumReleaseAge must be at least ${MINIMUM_RELEASE_AGE_MINUTES} minutes (found ${releaseAgeMinutes})`
      );
    }
    if (!strict) {
      findings.push('pnpm-workspace.yaml or .npmrc must set minimumReleaseAgeStrict=true');
    }
  } catch {
    findings.push('configuration file is required for the dependency release-age policy');
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
