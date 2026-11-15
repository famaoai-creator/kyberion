import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir, safeStat } from '@agent/core/secure-io';

const MACHINE_ABS_PATH_RE =
  /(?:\/Users\/|\/home\/[A-Za-z0-9._-]+\/|\/private\/(?:var\/folders|tmp)\/|[A-Za-z]:\\Users\\)/; // governance-allow-abs-path
const ABS_PATH_ALLOW_MARKER = 'governance-allow-abs-path';
// Roots to scan and the extensions that matter in each. Only authored sources are
// scanned: `.json` config and `.ts` code. Generated `.js`/`.d.ts`/`.map` mirrors are
// skipped (they duplicate their `.ts` source), as are gitignored tiers and build output.
const ABS_PATH_SCAN_ROOTS: Array<{ root: string; extensions: string[] }> = [
  { root: 'knowledge', extensions: ['.json'] },
  { root: 'libs', extensions: ['.ts', '.json'] },
  { root: 'scripts', extensions: ['.ts', '.json'] },
];
const ABS_PATH_SKIP_DIRS = new Set([
  'node_modules',
  'dist',
  'build',
  'coverage',
  '.git',
  'personal',
  'confidential', // gitignored knowledge tiers
  'examples', // demonstration scripts legitimately reference a developer's local output paths
]);
// JSON cannot carry an inline allow marker, so documented per-file exemptions live here.
// Each entry must reference a path that is intentionally machine-specific and not a repo path.
const ABS_PATH_ALLOWLIST = new Set<string>([]);
const PRODUCT_JSON_SCAN_ROOTS = [
  'knowledge/product/pipeline-templates',
  'knowledge/product/orchestration',
];
const PRODUCT_JSON_FILE_RE = /\.json$/i;
const PRODUCT_DISALLOWED_PATTERNS: Array<{ id: string; regex: RegExp; message: string }> = [
  {
    id: 'product-no-dot-venv-default',
    regex: /\.venv\/bin\/python3/,
    message:
      'product-tier JSON must not default to .venv/bin/python3; use python3 or a governed runtime override',
  },
  {
    id: 'product-no-ad-hoc-pip-install',
    regex: /\b(?:uv\s+pip\s+install|python(?:3)?\s+-m\s+pip\s+install|pip\s+install)\b/,
    message:
      'product-tier JSON must not embed ad hoc pip/uv install guidance; point to env:bootstrap or a governed runtime policy instead',
  },
  {
    id: 'product-no-playwright-install',
    regex: /\bpnpm\s+exec\s+playwright\s+install\b/,
    message:
      'product-tier JSON must not embed manual Playwright browser install steps; point to env:bootstrap instead',
  },
];

export function readGovernancePathScannerTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

function scanFileForAbsolutePaths(absPath: string, relPath: string, violations: string[]) {
  // Skip test fixtures — they legitimately carry machine-shaped strings and aren't runtime config.
  if (/\.(test|spec)\.[tj]s$/.test(relPath)) return;
  let content: string;
  try {
    content = readGovernancePathScannerTextFile(absPath);
  } catch {
    return;
  }
  if (!MACHINE_ABS_PATH_RE.test(content)) return; // fast path: most files have none
  const lines = content.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line.includes(ABS_PATH_ALLOW_MARKER)) continue;
    if (MACHINE_ABS_PATH_RE.test(line)) {
      violations.push(
        `machine-absolute-path: ${relPath}:${i + 1} embeds a machine-specific path; use a repo-relative path + pathResolver (or mark the line with ${ABS_PATH_ALLOW_MARKER})`
      );
    }
  }
}

export function findMachineAbsolutePathViolations(violations: string[]) {
  // Self-skip by basename: import.meta.url resolves to the compiled dist/.js, so a
  // path-equality check against the on-disk .ts source would miss. Match either form.
  const scannerBase = path.basename(fileURLToPath(import.meta.url)).replace(/\.[tj]s$/, '');
  const walk = (absDir: string, extensions: string[]) => {
    let entries: string[];
    try {
      entries = safeReaddir(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.') || ABS_PATH_SKIP_DIRS.has(entry)) continue;
      const absEntry = path.join(absDir, entry);
      let stat: ReturnType<typeof safeStat>;
      try {
        stat = safeStat(absEntry);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(absEntry, extensions);
      } else if (extensions.some((ext) => entry.endsWith(ext))) {
        const rel = path.relative(pathResolver.rootDir(), absEntry);
        if (path.basename(entry).replace(/\.[tj]s$/, '') === scannerBase) continue; // don't flag the scanner itself
        if (ABS_PATH_ALLOWLIST.has(rel)) continue; // documented per-file exemption
        scanFileForAbsolutePaths(absEntry, rel, violations);
      }
    }
  };
  for (const { root, extensions } of ABS_PATH_SCAN_ROOTS) {
    const absRoot = pathResolver.rootResolve(root);
    if (safeExistsSync(absRoot)) walk(absRoot, extensions);
  }
}

export function scanProductJsonForPlacementDrift(violations: string[]) {
  const walk = (absDir: string) => {
    let entries: string[];
    try {
      entries = safeReaddir(absDir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.startsWith('.')) continue;
      const absEntry = path.join(absDir, entry);
      let stat: ReturnType<typeof safeStat>;
      try {
        stat = safeStat(absEntry);
      } catch {
        continue;
      }
      if (stat.isDirectory()) {
        walk(absEntry);
        continue;
      }
      if (!PRODUCT_JSON_FILE_RE.test(entry)) continue;
      const relPath = path.relative(pathResolver.rootDir(), absEntry);
      let content: string;
      try {
        content = readGovernancePathScannerTextFile(absEntry);
      } catch {
        continue;
      }
      const lines = content.split('\n');
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        for (const pattern of PRODUCT_DISALLOWED_PATTERNS) {
          if (pattern.regex.test(line)) {
            violations.push(`${pattern.id}: ${relPath}:${i + 1} ${pattern.message}`);
          }
        }
      }
    }
  };

  for (const root of PRODUCT_JSON_SCAN_ROOTS) {
    const absRoot = pathResolver.rootResolve(root);
    if (safeExistsSync(absRoot)) walk(absRoot);
  }
}
