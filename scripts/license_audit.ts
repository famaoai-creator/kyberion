#!/usr/bin/env node
/**
 * Third-Party License Audit (Phase A-9)
 *
 * Walks the project's resolved dependency tree and produces:
 *   1. A summary count by SPDX license id.
 *   2. A flat list of (package, version, license) for review.
 *   3. A flag for any package whose license is unknown / missing / restrictive.
 *
 * Output:
 *   - Prints to stdout (human-readable).
 *   - Writes a structured JSON to docs/legal/third-party-licenses.json.
 *
 * Modes:
 *   pnpm license:audit             # check + write report
 *   pnpm license:audit -- --check  # exit 1 if any issue found
 *
 * NOTE: We use pnpm's resolved manifest (node_modules/.pnpm) when available.
 * If not, we fall back to walking node_modules directly.
 */

import * as path from 'node:path';
import {
  pathResolver,
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeStat,
  safeWriteFile,
} from '@agent/core';

interface PackageLicenseInfo {
  name: string;
  version: string;
  license: string;
  licenseSource: 'license_field' | 'licenses_array' | 'license_file' | 'unknown';
  homepage?: string;
  repository?: string;
}

interface AuditReport {
  generated_at: string;
  total_packages: number;
  by_license: Record<string, number>;
  unknown_licenses: PackageLicenseInfo[];
  restrictive_licenses: PackageLicenseInfo[];
  packages: PackageLicenseInfo[];
}

const RESTRICTIVE_LICENSES = new Set([
  'AGPL-3.0',
  'AGPL-3.0-only',
  'AGPL-3.0-or-later',
  'GPL-3.0',
  'GPL-3.0-only',
  'GPL-3.0-or-later',
  'GPL-2.0',
  'GPL-2.0-only',
  'GPL-2.0-or-later',
  'SSPL-1.0',
  'BUSL-1.1',
  'CC-BY-NC-4.0',
  'CC-BY-NC-SA-4.0',
]);

const ROOT = pathResolver.rootDir();
const REPORT_PATH = path.join(ROOT, 'docs', 'legal', 'third-party-licenses.json');

function readPackageJson(p: string): Record<string, unknown> | null {
  try {
    return JSON.parse(safeReadFile(p, { encoding: 'utf8' }) as string);
  } catch {
    return null;
  }
}

function detectLicenseFile(pkgDir: string): string | null {
  const candidates = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'LICENCE', 'COPYING'];
  for (const c of candidates) {
    const licensePath = path.join(pkgDir, c);
    if (safeExistsSync(licensePath)) {
      const content = (safeReadFile(licensePath, { encoding: 'utf8' }) as string).slice(0, 2000);
      if (/MIT License/i.test(content)) return 'MIT';
      if (/Apache License.*Version 2\.0/i.test(content)) return 'Apache-2.0';
      if (/BSD 3-Clause/i.test(content)) return 'BSD-3-Clause';
      if (/BSD 2-Clause/i.test(content)) return 'BSD-2-Clause';
      if (/ISC License/i.test(content)) return 'ISC';
      if (/GNU AFFERO/i.test(content)) return 'AGPL-3.0';
      if (/GNU GENERAL PUBLIC LICENSE.*Version 3/i.test(content)) return 'GPL-3.0';
      if (/GNU GENERAL PUBLIC LICENSE.*Version 2/i.test(content)) return 'GPL-2.0';
      // Found a license file but couldn't classify
      return 'UNKNOWN_FILE';
    }
  }
  return null;
}

function extractLicense(pkg: Record<string, unknown>, pkgDir: string): {
  license: string;
  source: PackageLicenseInfo['licenseSource'];
} {
  if (typeof pkg.license === 'string') {
    return { license: pkg.license, source: 'license_field' };
  }
  if (pkg.license && typeof pkg.license === 'object' && 'type' in pkg.license) {
    return { license: String((pkg.license as { type: unknown }).type), source: 'license_field' };
  }
  if (Array.isArray(pkg.licenses)) {
    const types = pkg.licenses
      .map((l: unknown) => (typeof l === 'object' && l && 'type' in l ? String((l as any).type) : ''))
      .filter(Boolean);
    if (types.length > 0) return { license: types.join(' OR '), source: 'licenses_array' };
  }
  const fromFile = detectLicenseFile(pkgDir);
  if (fromFile) return { license: fromFile, source: 'license_file' };
  return { license: 'UNKNOWN', source: 'unknown' };
}

function* walkPnpmDir(pnpmDir: string): Generator<string> {
  if (!safeExistsSync(pnpmDir)) return;
  const entries = safeReaddir(pnpmDir);
  for (const e of entries) {
    const ePath = path.join(pnpmDir, e);
    if (!safeStat(ePath).isDirectory()) continue;
    if (e === 'node_modules') continue;
    const inner = path.join(ePath, 'node_modules');
    if (!safeExistsSync(inner)) continue;
    const innerEntries = safeReaddir(inner);
    for (const ie of innerEntries) {
      const iePath = path.join(inner, ie);
      if (!safeStat(iePath).isDirectory()) continue;
      if (ie.startsWith('@')) {
        // scoped: walk one level deeper
        const scopedDir = iePath;
        const scopedEntries = safeReaddir(scopedDir);
        for (const se of scopedEntries) {
          const sePath = path.join(scopedDir, se);
          if (safeStat(sePath).isDirectory()) yield sePath;
        }
      } else {
        yield iePath;
      }
    }
  }
}

function* walkClassicNodeModules(nmDir: string): Generator<string> {
  if (!safeExistsSync(nmDir)) return;
  const entries = safeReaddir(nmDir);
  for (const e of entries) {
    const ePath = path.join(nmDir, e);
    if (!safeStat(ePath).isDirectory()) continue;
    if (e === '.bin' || e === '.cache' || e === '.pnpm') continue;
    if (e.startsWith('@')) {
      const scopedDir = ePath;
      const scopedEntries = safeReaddir(scopedDir);
      for (const se of scopedEntries) {
        const sePath = path.join(scopedDir, se);
        if (safeStat(sePath).isDirectory()) yield sePath;
      }
    } else {
      yield ePath;
    }
  }
}

function gatherPackages(): PackageLicenseInfo[] {
  const pnpmDir = path.join(ROOT, 'node_modules', '.pnpm');
  const seen = new Map<string, PackageLicenseInfo>();
  let walker: Generator<string>;

  if (safeExistsSync(pnpmDir)) {
    walker = walkPnpmDir(pnpmDir);
  } else {
    walker = walkClassicNodeModules(path.join(ROOT, 'node_modules'));
  }

  for (const pkgDir of walker) {
    const pkgJson = readPackageJson(path.join(pkgDir, 'package.json'));
    if (!pkgJson) continue;
    const name = String(pkgJson.name ?? path.basename(pkgDir));
    const version = String(pkgJson.version ?? '0.0.0');
    if (name.startsWith('@agent/') || name === 'kyberion') continue; // skip workspace packages
    const key = `${name}@${version}`;
    if (seen.has(key)) continue;
    const { license, source } = extractLicense(pkgJson, pkgDir);
    seen.set(key, {
      name,
      version,
      license,
      licenseSource: source,
      homepage: typeof pkgJson.homepage === 'string' ? pkgJson.homepage : undefined,
      repository:
        typeof pkgJson.repository === 'string'
          ? pkgJson.repository
          : pkgJson.repository && typeof pkgJson.repository === 'object' && 'url' in pkgJson.repository
            ? String((pkgJson.repository as { url: unknown }).url)
            : undefined,
    });
  }
  return [...seen.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version));
}

function buildReport(packages: PackageLicenseInfo[]): AuditReport {
  const byLicense: Record<string, number> = {};
  const unknown: PackageLicenseInfo[] = [];
  const restrictive: PackageLicenseInfo[] = [];

  for (const p of packages) {
    byLicense[p.license] = (byLicense[p.license] || 0) + 1;
    if (p.license === 'UNKNOWN' || p.license === 'UNKNOWN_FILE') unknown.push(p);
    // Detect restrictive licenses (handle "MIT OR GPL-3.0" forms — restrictive only when *all* options are restrictive)
    const parts = p.license.split(/\s+OR\s+|\s+\/\s+/i).map(s => s.trim());
    const allRestrictive =
      parts.length > 0 &&
      parts.every(part => RESTRICTIVE_LICENSES.has(part));
    if (allRestrictive) restrictive.push(p);
  }

  return {
    generated_at: new Date().toISOString(),
    total_packages: packages.length,
    by_license: Object.fromEntries(Object.entries(byLicense).sort((a, b) => b[1] - a[1])),
    unknown_licenses: unknown,
    restrictive_licenses: restrictive,
    packages,
  };
}

function writeReport(report: AuditReport): void {
  const dir = path.dirname(REPORT_PATH);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(REPORT_PATH, JSON.stringify(report, null, 2) + '\n', { encoding: 'utf8' });
}

function main(): void {
  const args = process.argv.slice(2);
  const checkMode = args.includes('--check');

  console.log('🔍 Scanning third-party licenses...');
  const packages = gatherPackages();
  if (packages.length === 0) {
    console.error('❌ No packages found. Run `pnpm install` first.');
    process.exit(1);
  }

  const report = buildReport(packages);
  writeReport(report);

  console.log(`\n📊 Total packages: ${report.total_packages}`);
  console.log('\nLicense breakdown (top 15):');
  Object.entries(report.by_license)
    .slice(0, 15)
    .forEach(([lic, count]) => {
      console.log(`  ${String(count).padStart(5)}  ${lic}`);
    });

  if (report.unknown_licenses.length > 0) {
    console.log(`\n⚠️  ${report.unknown_licenses.length} packages with unknown license:`);
    for (const p of report.unknown_licenses.slice(0, 10)) {
      console.log(`     - ${p.name}@${p.version}`);
    }
    if (report.unknown_licenses.length > 10) {
      console.log(`     ...and ${report.unknown_licenses.length - 10} more (see report).`);
    }
  }

  if (report.restrictive_licenses.length > 0) {
    console.log(`\n🚨 ${report.restrictive_licenses.length} packages with restrictive licenses:`);
    for (const p of report.restrictive_licenses.slice(0, 10)) {
      console.log(`     - ${p.name}@${p.version}  (${p.license})`);
    }
  }

  console.log(`\n📝 Full report: ${path.relative(ROOT, REPORT_PATH)}`);

  if (checkMode) {
    if (report.unknown_licenses.length > 0 || report.restrictive_licenses.length > 0) {
      console.error('\n❌ License audit found issues (see above).');
      process.exit(1);
    }
    console.log('\n✅ License audit passed.');
  }
}

main();
