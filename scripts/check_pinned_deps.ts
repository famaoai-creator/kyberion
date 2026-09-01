/** PI-12: reject dependency declarations that bypass the lockfile policy. */
import { pathResolver } from '@agent/core/path-resolver';
import { readJson } from '@agent/core/foundation';
import { safeReadFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

type PackageManifest = {
  packageManager?: string;
  overrides?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string> };
};

export function checkPinnedDependencies(): string[] {
  const manifest = readJson<PackageManifest>(pathResolver.rootResolve('package.json'));
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
    const lockfile = String(
      safeReadFile(pathResolver.rootResolve('pnpm-lock.yaml'), { encoding: 'utf8' })
    );
    if (!/^lockfileVersion:\s*['"]?9(?:\.0)?['"]?/mu.test(lockfile)) {
      findings.push('pnpm-lock.yaml must use the governed lockfileVersion 9');
    }
  } catch {
    findings.push('pnpm-lock.yaml is required');
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
