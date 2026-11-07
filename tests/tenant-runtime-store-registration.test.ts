import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core/secure-io';
import { getAllFiles } from '@agent/core/fs-utils';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '@agent/core/storage-layout';
import {
  PHYSICAL_LEGACY_TENANT_STATE_ROOTS,
  PHYSICAL_PRESENCE_ROOT,
  PHYSICAL_SCHEDULE_ROOT,
  PHYSICAL_TENANT_LEARNING_ROOTS,
} from '@agent/core/scope-offboarding';

/**
 * Tenant-partitioned runtime store registration gate.
 *
 * Two layouts coexist under active/shared/runtime/:
 * - registered roots (`PARTITIONED_RUNTIME_STATE_ROOTS`): `<root>/<tier>/<tenant>/`,
 *   seen by tier-guard's tenant check, backup/restore and tenant offboarding
 *   through TENANT_RUNTIME_PARTITION_ROOTS;
 * - `physicalScopedPath(base, scope)`: `<base>/tenants/<slug>/`, invisible to
 *   all three unless `base` is hand-listed in scope-offboarding.ts
 *   (PHYSICAL_SCHEDULE_ROOT, PHYSICAL_PRESENCE_ROOT,
 *   PHYSICAL_TENANT_LEARNING_ROOTS, PHYSICAL_LEGACY_TENANT_STATE_ROOTS).
 *
 * Every physicalScopedPath base that resolves under active/shared/runtime/
 * must be one of those offboarding bases. A registered root is NOT enough:
 * `<root>/tenants/<slug>` is not a `<tier>/<tenant>` partition, so the
 * registry walk never sees it. Dynamic bases the scan cannot evaluate, and
 * bases deliberately left in place, are listed with a reason in
 * `tests/fixtures/tenant-runtime-store-allowlist.json`. New tenant state
 * should use the registered layout (`partitionedScopedPath`) instead.
 */
const rootDir = process.cwd();
const SCAN_ROOTS = ['libs', 'scripts', 'presence', 'satellites', 'plugins'];
const RUNTIME = 'active/shared/runtime';
const allowlistPath = path.join(
  rootDir,
  'tests',
  'fixtures',
  'tenant-runtime-store-allowlist.json'
);

interface Allowlist {
  unresolved: Array<{ file: string; expression: string; reason: string }>;
  bases: Array<{ file: string; base: string; reason: string }>;
}

interface CallSite {
  file: string;
  expression: string;
  base?: string;
}

const OFFBOARDED_BASES = new Set<string>([
  PHYSICAL_SCHEDULE_ROOT,
  PHYSICAL_PRESENCE_ROOT,
  ...PHYSICAL_TENANT_LEARNING_ROOTS,
  ...PHYSICAL_LEGACY_TENANT_STATE_ROOTS,
]);

function read(filePath: string): string {
  return safeReadFile(filePath, { encoding: 'utf8' }) as string;
}

/** The first top-level argument of the call whose `(` is at `open`. */
function firstArgument(source: string, open: number): string {
  let depth = 0;
  for (let i = open; i < source.length; i += 1) {
    const ch = source[i]!;
    if (ch === "'" || ch === '"' || ch === '`') {
      for (i += 1; i < source.length && source[i] !== ch; i += 1) {
        if (source[i] === '\\') i += 1;
      }
      continue;
    }
    if ('([{'.includes(ch)) depth += 1;
    else if (')]}'.includes(ch)) {
      depth -= 1;
      if (depth === 0) return source.slice(open + 1, i).trim();
    } else if (ch === ',' && depth === 1) return source.slice(open + 1, i).trim();
  }
  return '';
}

/** Statically evaluate a base expression; undefined when it is dynamic. */
function resolveBase(expression: string, source: string, depth = 0): string | undefined {
  if (depth > 4) return undefined;
  const expr = expression.trim();
  const literal = expr.match(/^(['"])([^'"]*)\1$/u) ?? expr.match(/^`([^`$]*)`$/u);
  if (literal) return (literal[2] ?? literal[1])!.replace(/\/+$/u, '');
  const shared = expr.match(/^pathResolver\.shared\((['"])([^'"]+)\1\)$/u);
  if (shared) return `active/shared/${shared[2]}`.replace(/\/+$/u, '');
  const rootResolve = expr.match(/^pathResolver\.rootResolve\((['"])([^'"]+)\1\)$/u);
  if (rootResolve) return rootResolve[2]!.replace(/\/+$/u, '');
  const registered = expr.match(/^PARTITIONED_RUNTIME_STATE_ROOTS\.(\w+)$/u);
  if (registered) {
    return (PARTITIONED_RUNTIME_STATE_ROOTS as Record<string, string>)[registered[1]!];
  }
  if (/^\w+$/u.test(expr)) {
    const declaration = source.match(
      new RegExp(`(?:^|\\n)\\s*(?:export\\s+)?const\\s+${expr}\\s*(?::[^=]+)?=\\s*([^;]+);`, 'u')
    );
    if (declaration) return resolveBase(declaration[1]!, source, depth + 1);
  }
  return undefined;
}

function scanCallSites(): CallSite[] {
  const files = SCAN_ROOTS.flatMap((root) => getAllFiles(path.join(rootDir, root)))
    .map((filePath) => path.relative(rootDir, filePath).split(path.sep).join('/'))
    .filter((relPath) => /\.(ts|tsx|mts)$/u.test(relPath))
    .filter((relPath) => !/\.(test|spec)\.tsx?$/u.test(relPath) && !relPath.endsWith('.d.ts'))
    .filter((relPath) => !/(^|\/)(node_modules|dist|\.next|__tests__)\//u.test(relPath))
    .filter((relPath) => relPath !== 'libs/core/storage/physical-namespace.ts');
  const sites: CallSite[] = [];
  for (const file of files) {
    const source = read(path.join(rootDir, file));
    if (!source.includes('physicalScopedPath(')) continue;
    for (const match of source.matchAll(/\bphysicalScopedPath\s*\(/gu)) {
      if (/function\s+$/u.test(source.slice(Math.max(0, match.index! - 12), match.index!))) {
        continue;
      }
      const expression = firstArgument(source, match.index! + match[0].length - 1);
      sites.push({ file, expression, base: resolveBase(expression, source) });
    }
  }
  return sites;
}

const underRuntime = (base: string) => base === RUNTIME || base.startsWith(`${RUNTIME}/`);

describe('tenant-partitioned runtime store registration', () => {
  const allowlist = JSON.parse(read(allowlistPath)) as Allowlist;
  const sites = scanCallSites();
  const unresolvedKey = (entry: { file: string; expression: string }) =>
    `${entry.file}::${entry.expression}`;
  const baseKey = (entry: { file: string; base: string }) => `${entry.file}::${entry.base}`;

  it('finds the known physicalScopedPath stores (scanner sanity)', () => {
    const resolved = sites.map((site) => site.base);
    expect(resolved).toContain(PHYSICAL_SCHEDULE_ROOT);
    expect(resolved).toContain('active/shared/runtime/feedback-loop');
    expect(resolved).toContain(PARTITIONED_RUNTIME_STATE_ROOTS.dot);
  });

  it('attributes every runtime physicalScopedPath base to a tenant-offboarding base', () => {
    const allowedBases = new Set(allowlist.bases.map(baseKey));
    const uncovered = sites
      .filter((site) => site.base !== undefined && underRuntime(site.base))
      .filter((site) => !OFFBOARDED_BASES.has(site.base!))
      .filter((site) => !allowedBases.has(baseKey({ file: site.file, base: site.base! })))
      .map((site) => `${site.file} -> ${site.base}/tenants/<slug>`);
    expect(
      [...new Set(uncovered)].sort(),
      [
        'tenant-runtime-store — these stores keep per-tenant data at <base>/tenants/<slug>/ under active/shared/runtime/,',
        'which tier-guard, backup and tenant offboarding cannot see (a contract ending leaves the data behind)',
        '| next: store it in a registered PARTITIONED_RUNTIME_STATE_ROOTS root via partitionedScopedPath (<root>/<tier>/<tenant>/),',
        'or add the base to PHYSICAL_TENANT_LEARNING_ROOTS / PHYSICAL_LEGACY_TENANT_STATE_ROOTS in libs/core/storage/scope-offboarding.ts;',
        'only a deliberate exception goes in tests/fixtures/tenant-runtime-store-allowlist.json "bases" with a reason',
      ].join(' ')
    ).toEqual([]);
  });

  it('requires a documented reason for every base expression the scan cannot evaluate', () => {
    const allowed = new Set(allowlist.unresolved.map(unresolvedKey));
    const unexplained = sites
      .filter((site) => site.base === undefined && !allowed.has(unresolvedKey(site)))
      .map(unresolvedKey);
    expect(
      [...new Set(unexplained)].sort(),
      'tenant-runtime-store — physicalScopedPath bases the static scan cannot evaluate | next: pass a literal or a const the scan can resolve, or add {file, expression, reason} to tests/fixtures/tenant-runtime-store-allowlist.json "unresolved" saying what the base resolves to and which offboarding base covers it'
    ).toEqual([]);
  });

  it('keeps the allowlist honest (reasons present, entries still matching a call site)', () => {
    const unresolvedSites = new Set(
      sites.filter((site) => site.base === undefined).map(unresolvedKey)
    );
    const baseSites = new Set(
      sites
        .filter((site) => site.base !== undefined)
        .map((site) => baseKey({ file: site.file, base: site.base! }))
    );
    const stale = [
      ...allowlist.unresolved
        .filter((entry) => !entry.reason?.trim() || !unresolvedSites.has(unresolvedKey(entry)))
        .map(unresolvedKey),
      ...allowlist.bases
        .filter(
          (entry) =>
            !entry.reason?.trim() ||
            !baseSites.has(baseKey(entry)) ||
            OFFBOARDED_BASES.has(entry.base)
        )
        .map(baseKey),
    ];
    expect(
      stale,
      'tenant-runtime-store allowlist — entries without a reason, with no matching call site, or already covered by an offboarding base | next: remove or fix them in tests/fixtures/tenant-runtime-store-allowlist.json'
    ).toEqual([]);
  });

  it('offboards the legacy dot/tenants/<slug> copies without a gate exception', () => {
    // Owner decision 2026-11-05: an offboarded tenant's pre-partition dot state
    // is removed automatically; live migration stays `pnpm kyberion dot migrate-state`.
    expect(OFFBOARDED_BASES).toContain(PARTITIONED_RUNTIME_STATE_ROOTS.dot);
    expect(allowlist.bases.map((entry) => entry.base)).not.toContain(
      PARTITIONED_RUNTIME_STATE_ROOTS.dot
    );
  });

  it('covers the hand-joined tenant memory root and never lists a base twice', () => {
    // RUNTIME_STATE_PATHS['memory.tenantRoot'] is `<runtime>/tenants`: its base must be offboarded.
    // (Read statically: runtime-state-roots is not a public @agent/core subpath.)
    const memoryTenantRoot = read(
      path.join(rootDir, 'libs', 'core', 'foundation', 'runtime-state-roots.ts')
    ).match(/'memory\.tenantRoot':\s*'([^']+)'/u)?.[1];
    expect(memoryTenantRoot, 'memory.tenantRoot declaration not found').toBeDefined();
    expect(OFFBOARDED_BASES).toContain(path.posix.dirname(memoryTenantRoot!));
    const all = [
      PHYSICAL_SCHEDULE_ROOT,
      PHYSICAL_PRESENCE_ROOT,
      ...PHYSICAL_TENANT_LEARNING_ROOTS,
      ...PHYSICAL_LEGACY_TENANT_STATE_ROOTS,
    ];
    expect(all.length, 'an offboarding base is listed twice').toBe(new Set(all).size);
    // A base is the directory ABOVE `tenants/` — never `…/tenants` itself.
    expect(all.filter((base) => base.endsWith('/tenants'))).toEqual([]);
  });
});
