/** PI-12: reject dependency declarations that bypass the lockfile policy. */
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile } from '@agent/core/secure-io';

type PackageManifest = {
  packageManager?: string;
  overrides?: Record<string, string>;
  pnpm?: { overrides?: Record<string, string> };
};

const manifest = JSON.parse(
  String(safeReadFile(pathResolver.rootResolve('package.json'), { encoding: 'utf8' }))
) as PackageManifest;
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

if (findings.length > 0) {
  console.error('[check:pinned-deps] FAILED');
  for (const finding of findings) console.error(`- ${finding}`);
  process.exitCode = 1;
} else {
  console.log('[check:pinned-deps] OK (package manager, overrides, and lockfile pinned)');
}
