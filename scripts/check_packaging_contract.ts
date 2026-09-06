/**
 * check:packaging-contract — machine verification of the ENFORCED clauses in
 * docs/PACKAGING_CONTRACT.md §Distribution contract (QM-08).
 *
 * Pattern from qm's deployment-directory contract: every clause declares an
 * honest status (ENFORCED / VALIDATED-ONLY / RESERVED) and every ENFORCED
 * clause names the verifier that proves it. This script is that verifier for
 * the distribution clauses:
 *
 *  - image.tier-isolation: .dockerignore excludes every data-tier path that
 *    must never be baked into an image.
 *  - config.no-secret-values: env.example documents names, never values —
 *    no uncommented assignment carries a secret-shaped value, and no line
 *    (commented or not) contains a high-confidence credential pattern.
 */

import { parseSafeJsonInput, readTextFile } from '@agent/core/foundation';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';
import path from 'node:path';

interface ClauseFailure {
  clause: string;
  detail: string;
}

interface PackagingSourceEntry {
  path: string;
  source: string;
}

export function readPackagingTextFile(filePath: string, label = filePath): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${label} must be a regular file`);
  }
  return readTextFile(filePath);
}

const failures: ClauseFailure[] = [];

function checkImageTierIsolation(): void {
  const required = [
    'knowledge/personal/',
    'knowledge/confidential/',
    'customer/',
    'work/',
    '.env',
    '.env.*',
    '*.pem',
    '*.key',
  ];
  const raw = readPackagingTextFile(`${pathResolver.rootDir()}/.dockerignore`, '.dockerignore');
  const lines = new Set(
    raw
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith('#'))
  );
  const protectedRoots = ['knowledge/', 'customer/', 'work/', '.env', '*.pem', '*.key'];
  for (const line of lines) {
    if (!line.startsWith('!')) continue;
    const negated = line.slice(1);
    if (
      protectedRoots.some(
        (root) => negated.startsWith(root.replace('*', '')) || negated.includes(root)
      )
    ) {
      failures.push({
        clause: 'image.tier-isolation',
        detail: `.dockerignore negation "${line}" re-includes a protected data-tier path — dockerignore is last-match-wins, so this silently defeats the exclusion.`,
      });
    }
  }
  for (const entry of required) {
    if (!lines.has(entry)) {
      failures.push({
        clause: 'image.tier-isolation',
        detail: `.dockerignore is missing the required exclusion "${entry}" — confidential/personal/customer data must never be baked into an image (OP-03).`,
      });
    }
  }
}

const HIGH_CONFIDENCE_SECRET_PATTERNS: Array<{ name: string; pattern: RegExp }> = [
  { name: 'aws-access-key', pattern: /AKIA[0-9A-Z]{16}/ },
  { name: 'private-key-block', pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'openai-style-key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'github-token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'slack-token', pattern: /\bxox[bapos]-[A-Za-z0-9-]{10,}/ },
  { name: 'google-api-key', pattern: /\bAIza[0-9A-Za-z_-]{30,}/ },
];

const SECRET_NAME_HINT = /(TOKEN|SECRET|KEY|PASSWORD|PASSPHRASE|CREDENTIAL)/;
const PLACEHOLDER_VALUE =
  /^(?:|["']{2}|<[^>]*>|\$\{[^}]*\}|your[-_].*|changeme.*|placeholder.*|xxx+|\.\.\.|0|1|true|false|none|dummy.*|example.*|redacted)$/i;

/**
 * JSON.parse keeps the last value when an object contains duplicate keys.
 * That is particularly dangerous for package exports: a duplicate subpath
 * can make the checked-in manifest and the effective Node resolution differ
 * without producing a syntax error. The package manifest uses one export per
 * indented line, so inspect only the `./...` keys inside its exports object.
 */
export function findDuplicatePackageExportKeys(raw: string): string[] {
  const exportsStart = raw.indexOf('"exports"');
  if (exportsStart < 0) return [];
  const seen = new Set<string>();
  const duplicates = new Set<string>();
  const exportKeyPattern = /^    "(\.\/[^"\\]+)":\s*\{/gmu;
  for (const match of raw.slice(exportsStart).matchAll(exportKeyPattern)) {
    const key = match[1];
    if (!key) continue;
    if (seen.has(key)) duplicates.add(key);
    else seen.add(key);
  }
  return [...duplicates].sort((left, right) => left.localeCompare(right));
}

/** Return conditional package export targets that are absent from the build. */
export function findMissingPackageExportTargets(
  exportsValue: unknown,
  existingTargets: ReadonlySet<string>
): string[] {
  if (!exportsValue || typeof exportsValue !== 'object' || Array.isArray(exportsValue)) return [];
  const missing: string[] = [];
  for (const [subpath, value] of Object.entries(exportsValue)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    for (const field of ['types', 'default']) {
      const target = (value as Record<string, unknown>)[field];
      if (typeof target === 'string' && !existingTargets.has(target)) {
        missing.push(`${subpath}.${field} -> ${target}`);
      }
    }
  }
  return missing.sort((left, right) => left.localeCompare(right));
}

function checkPackageExportKeys(): void {
  const packageJson = readPackagingTextFile(
    pathResolver.rootResolve('libs/core/package.json'),
    'libs/core/package.json'
  );
  for (const key of findDuplicatePackageExportKeys(packageJson)) {
    failures.push({
      clause: 'package-export-keys.unique',
      detail: `libs/core/package.json declares export subpath ${key} more than once; duplicate JSON keys are silently overwritten by the last entry.`,
    });
  }
}

function checkPackageExportTargets(): void {
  const packagePath = pathResolver.rootResolve('libs/core/package.json');
  const packageJson = parseSafeJsonInput(
    readPackagingTextFile(packagePath, 'libs/core/package.json'),
    packagePath
  );
  const exportsValue =
    packageJson && typeof packageJson === 'object' && !Array.isArray(packageJson)
      ? (packageJson as Record<string, unknown>).exports
      : undefined;
  const distPath = pathResolver.rootResolve('libs/core/dist');
  if (!safeExistsSync(distPath) || !safeLstat(distPath).isDirectory()) return;
  const existingTargets = new Set<string>();
  const collect = (directory: string, relative = './dist'): void => {
    for (const name of safeReaddir(directory)) {
      const filePath = path.join(directory, name);
      const stat = safeLstat(filePath);
      if (stat.isDirectory()) collect(filePath, `${relative}/${name}`);
      else existingTargets.add(`${relative}/${name}`);
    }
  };
  collect(distPath);
  for (const target of findMissingPackageExportTargets(exportsValue, existingTargets)) {
    failures.push({
      clause: 'package-export-targets.present',
      detail: `libs/core/package.json exports a target that is absent from the built package (${target}).`,
    });
  }
}

/** Find package subpath imports that are absent from the published exports map. */
export function findUnexportedCoreSubpathImports(
  entries: readonly PackagingSourceEntry[],
  exportedKeys: ReadonlySet<string>
): string[] {
  const imports = new Map<string, Set<string>>();
  const importPattern = /["']@agent\/core\/([^"']+)["']/g;
  for (const entry of entries) {
    for (const match of entry.source.matchAll(importPattern)) {
      const rawSubpath = match[1];
      if (!rawSubpath) continue;
      const subpath = `./${rawSubpath.replace(/\.js$/, '')}`;
      if (exportedKeys.has(subpath)) continue;
      const paths = imports.get(subpath) ?? new Set<string>();
      paths.add(entry.path);
      imports.set(subpath, paths);
    }
  }
  return [...imports.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([subpath, paths]) =>
      [...paths].sort().map((sourcePath) => `${subpath} <- ${sourcePath}`)
    );
}

function collectPackagingSources(
  directory: string,
  root: string,
  output: PackagingSourceEntry[]
): void {
  for (const name of safeReaddir(directory)) {
    const filePath = path.join(directory, name);
    const stat = safeLstat(filePath);
    if (stat.isDirectory()) {
      if (name === 'dist' || name === 'node_modules' || name === '.git') continue;
      collectPackagingSources(filePath, root, output);
      continue;
    }
    if (!/\.(ts|tsx|js|mjs)$/.test(name) || name.includes('.test.')) continue;
    output.push({ path: path.relative(root, filePath), source: readTextFile(filePath) });
  }
}

function checkCoreSubpathExports(): void {
  const root = pathResolver.rootDir();
  const packagePath = pathResolver.rootResolve('libs/core/package.json');
  const packageJson = parseSafeJsonInput(readTextFile(packagePath), packagePath);
  const exportsValue =
    packageJson && typeof packageJson === 'object' && !Array.isArray(packageJson)
      ? (packageJson as Record<string, unknown>).exports
      : undefined;
  const exportedKeys = new Set(
    exportsValue && typeof exportsValue === 'object' && !Array.isArray(exportsValue)
      ? Object.keys(exportsValue)
      : []
  );
  const entries: PackagingSourceEntry[] = [];
  for (const directory of ['libs', 'scripts', 'satellites', 'presence']) {
    collectPackagingSources(path.join(root, directory), root, entries);
  }
  const missing = findUnexportedCoreSubpathImports(entries, exportedKeys);
  for (const item of missing) {
    failures.push({
      clause: 'package-export-keys.published',
      detail: `a production source imports an unpublished @agent/core subpath (${item}); add the subpath to libs/core/package.json exports or use the public facade.`,
    });
  }
}

function checkNoSecretValues(): void {
  const raw = readPackagingTextFile(
    `${pathResolver.rootDir()}/docs/developer/env.example`,
    'docs/developer/env.example'
  );
  raw.split('\n').forEach((line, index) => {
    const location = `docs/developer/env.example:${index + 1}`;
    for (const { name, pattern } of HIGH_CONFIDENCE_SECRET_PATTERNS) {
      if (pattern.test(line)) {
        failures.push({
          clause: 'config.no-secret-values',
          detail: `${location} contains a ${name}-shaped value; env.example documents names and descriptions, never values.`,
        });
      }
    }
    const trimmed = line.trim().replace(/^#\s*/, '');
    if (!trimmed) return;
    const assignment = /^([A-Z][A-Z0-9_]*)=(.*)$/.exec(trimmed);
    if (!assignment) return;
    const [, key, valueRaw] = assignment;
    const value = valueRaw!.trim().replace(/^["']|["']$/g, '');
    if (!SECRET_NAME_HINT.test(key!)) return;
    if (PLACEHOLDER_VALUE.test(value) || value.length <= 8) return;
    failures.push({
      clause: 'config.no-secret-values',
      detail: `${location} assigns a non-placeholder value to secret-shaped key ${key}; use an empty value or a <placeholder>.`,
    });
  });
}

export function checkPackagingContract(): ClauseFailure[] {
  failures.length = 0;
  checkImageTierIsolation();
  checkPackageExportKeys();
  checkPackageExportTargets();
  checkCoreSubpathExports();
  checkNoSecretValues();
  return [...failures];
}

export const runCheckPackagingContract = defineScript({
  name: 'check:packaging-contract',
  flags: [],
  run(context) {
    const violations = checkPackagingContract();
    if (violations.length > 0) {
      throw new ScriptExitError(
        1,
        [
          ...violations.map((failure) => `  ${failure.clause}: ${failure.detail}`),
          `[check:packaging-contract] FAILED — ${violations.length} clause violation(s). See docs/PACKAGING_CONTRACT.md §Distribution contract.`,
        ].join('\n')
      );
    }
    context.print('[check:packaging-contract] OK');
    return { violations };
  },
});

if (
  isDirectScript(import.meta.url, 'check_packaging_contract.ts') ||
  isDirectScript(import.meta.url, 'check_packaging_contract.js')
)
  void runCheckPackagingContract();
