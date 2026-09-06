import path from 'node:path';
import { readTextFile } from '@agent/core/foundation';
import { getAllFiles } from '@agent/core/fs-utils';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExistsSync, safeLstat } from '@agent/core/secure-io';
import { defineScript, isDirectScript, ScriptExitError } from './lib/harness.js';

const SOURCE_ROOTS = ['libs', 'scripts', 'presence', 'satellites'];
/**
 * Files that legitimately read `process.env.KYBERION_*` directly because they
 * run on a runtime that cannot import `@agent/core` (Next.js edge middleware).
 * Each entry must keep its truthy-value parsing in sync with
 * `libs/core/foundation/env.ts`.
 */
const EDGE_RUNTIME_ENV_READ_ALLOWLIST: ReadonlyMap<string, ReadonlyMap<string, number>> = new Map([
  ['presence/displays/chronos-mirror-v2/src/middleware.ts', new Map([['KYBERION_TRUST_PROXY', 1]])],
]);
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const JSON_LOADER_RATCHET = 0;
/**
 * A few boundaries intentionally parse external CLI, simulator, wire, or
 * canonical secure-io data after it has crossed into a repository-safe path.
 * Keep those existing boundaries explicit while preventing the pattern from
 * spreading to new source files.
 */
const LEGACY_JSON_BOUNDARY_ALLOWLIST: ReadonlyMap<string, { count: number; reason: string }> =
  new Map([
    [
      'libs/actuators/android-actuator/src/android-runtime-helpers.ts',
      { count: 1, reason: 'ADB session handoff output' },
    ],
    [
      'libs/actuators/ios-actuator/src/ios-runtime-helpers.ts',
      { count: 1, reason: 'simulator session handoff output' },
    ],
    [
      'libs/actuators/network-actuator/src/a2a-transport.ts',
      { count: 1, reason: 'encrypted A2A wire payload after decryption' },
    ],
    ['libs/core/secure-io.ts', { count: 1, reason: 'canonical secure JSON implementation' }],
  ]);
const JSONL_APPEND_RATCHET = 0;
const ENV_RATCHET = 0;
const SIMPLE_ISO_TIMESTAMP_RATCHET = 0;
const SIMPLE_ISO_TIMESTAMP_PATTERN = /new\s+Date\(\)\.toISOString\(\)/gu;

export function readFoundationAdoptionTextFile(filePath: string): string {
  if (!safeExistsSync(filePath) || !safeLstat(filePath).isFile()) {
    throw new Error(`${filePath} must be a regular file`);
  }
  return readTextFile(filePath);
}

export function countSimpleIsoTimestampViolations(source: string): number {
  return [...source.matchAll(SIMPLE_ISO_TIMESTAMP_PATTERN)].length;
}
const LEGACY_JSON_BOUNDARY_PATTERN =
  /safeReadFile\s*\([\s\S]{0,220}?\)[\s\S]{0,220}?parseSafeJsonInput\s*\(/gu;

export function countLegacyJsonBoundaryViolations(source: string): number {
  return [...source.matchAll(LEGACY_JSON_BOUNDARY_PATTERN)].length;
}
const JSONL_APPEND_PATTERN = new RegExp(
  [
    'safeAppendFile',
    '(?:Sync)?',
    '\\(',
    '[\\s\\S]{0,280}?',
    'JSON\\.stringify',
    '[\\s\\S]{0,120}?',
    '\\\\n',
  ].join(''),
  'gu'
);

function sourceFiles(): string[] {
  return SOURCE_ROOTS.flatMap((relativeRoot) => {
    const root = pathResolver.rootResolve(relativeRoot);
    return getAllFiles(root).filter((filePath) => {
      if (!SOURCE_EXTENSIONS.has(path.extname(filePath))) return false;
      return (
        !/(?:\.test|\.spec)\.[cm]?[jt]sx?$/.test(filePath) &&
        !filePath.includes(`${path.sep}dist${path.sep}`)
      );
    });
  });
}

export function checkFoundationAdoption(files = sourceFiles()): string[] {
  const failures: string[] = [];
  let jsonLoaderViolations = 0;
  let legacyJsonBoundaryViolations = 0;
  let jsonlAppendViolations = 0;
  let ajvViolations = 0;
  let envReads = 0;
  let simpleIsoTimestampViolations = 0;
  let catalogDefinitions = 0;
  let catalogDefinitionsWithoutSchema = 0;

  for (const filePath of files) {
    const source = readFoundationAdoptionTextFile(filePath);
    const relativePath = path
      .relative(pathResolver.rootResolve('.'), filePath)
      .split(path.sep)
      .join('/');
    jsonLoaderViolations += [
      ...source.matchAll(/JSON\.parse\s*\(\s*(?:String\s*\(\s*)?safeReadFile\s*\(/gu),
    ].length;
    const legacyJsonBoundaryCount = countLegacyJsonBoundaryViolations(source);
    const allowedLegacyJsonBoundaries =
      LEGACY_JSON_BOUNDARY_ALLOWLIST.get(relativePath)?.count ?? 0;
    legacyJsonBoundaryViolations += Math.max(
      0,
      legacyJsonBoundaryCount - allowedLegacyJsonBoundaries
    );
    if (relativePath.startsWith('scripts/')) {
      simpleIsoTimestampViolations += countSimpleIsoTimestampViolations(source);
    }
    if (
      !filePath.endsWith(`${path.sep}foundation${path.sep}json.ts`) &&
      path.basename(filePath) !== 'check_foundation_adoption.ts'
    ) {
      jsonlAppendViolations += [...source.matchAll(JSONL_APPEND_PATTERN)].length;
    }
    if (
      !filePath.endsWith(`${path.sep}foundation${path.sep}ajv.ts`) &&
      /new\s+\w*Ajv\w*\s*\(/u.test(source)
    ) {
      ajvViolations += 1;
    }
    const allowedReads = EDGE_RUNTIME_ENV_READ_ALLOWLIST.get(relativePath);
    for (const match of source.matchAll(/process\.env\.(KYBERION_[A-Z0-9_]+)/gu)) {
      const remaining = allowedReads?.get(match[1]) ?? 0;
      if (remaining > 0) {
        (allowedReads as Map<string, number>).set(match[1], remaining - 1);
        continue;
      }
      envReads += 1;
    }
    for (const match of source.matchAll(/defineCatalog(?:<[^>]+>)?\(\{/gu)) {
      catalogDefinitions += 1;
      const suffix = source.slice(match.index ?? 0, (match.index ?? 0) + 1200);
      if (!/\bschema\s*:/u.test(suffix)) catalogDefinitionsWithoutSchema += 1;
    }
  }

  if (jsonLoaderViolations > JSON_LOADER_RATCHET) {
    failures.push(
      `shared JSON loader pattern increased: ${jsonLoaderViolations} > ${JSON_LOADER_RATCHET}`
    );
  }
  if (legacyJsonBoundaryViolations > 0) {
    failures.push(
      `legacy JSON boundary pattern increased: ${legacyJsonBoundaryViolations}; use foundation readJson/readJsonLines or document an existing external boundary`
    );
  }
  if (jsonlAppendViolations > JSONL_APPEND_RATCHET) {
    failures.push(
      `shared JSONL append pattern increased: ${jsonlAppendViolations} > ${JSONL_APPEND_RATCHET}`
    );
  }
  if (ajvViolations > 0) failures.push(`Ajv constructor outside foundation: ${ajvViolations}`);
  if (envReads > ENV_RATCHET)
    failures.push(`KYBERION env reads increased: ${envReads} > ${ENV_RATCHET}`);
  if (simpleIsoTimestampViolations > SIMPLE_ISO_TIMESTAMP_RATCHET) {
    failures.push(
      `simple ISO timestamp construction increased: ${simpleIsoTimestampViolations} > ${SIMPLE_ISO_TIMESTAMP_RATCHET}; use foundation nowIso()`
    );
  }
  if (catalogDefinitionsWithoutSchema > 0) {
    failures.push(
      `defineCatalog calls without schema: ${catalogDefinitionsWithoutSchema}/${catalogDefinitions}`
    );
  }
  return failures;
}

export const runCheckFoundationAdoption = defineScript({
  name: 'check:foundation-adoption',
  flags: [],
  run(context) {
    const failures = checkFoundationAdoption();
    if (failures.length > 0) {
      throw new ScriptExitError(
        1,
        ['FAILED', ...failures.map((failure) => `- ${failure}`)].join('\n')
      );
    }
    context.print('[check:foundation-adoption] OK');
    return { failures };
  },
});

if (
  isDirectScript(import.meta.url, 'check_foundation_adoption.ts') ||
  isDirectScript(import.meta.url, 'check_foundation_adoption.js')
)
  void runCheckFoundationAdoption();
