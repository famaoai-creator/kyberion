import path from 'node:path';
import { getAllFiles } from '@agent/core/fs-utils';
import { pathResolver, safeReadFile } from '@agent/core';

const SOURCE_ROOTS = ['libs', 'scripts', 'presence', 'satellites'];
const SOURCE_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.mjs']);
const JSON_LOADER_RATCHET = 71;
const ENV_RATCHET = 368;

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
  let ajvViolations = 0;
  let envReads = 0;
  let catalogDefinitions = 0;
  let catalogDefinitionsWithoutSchema = 0;

  for (const filePath of files) {
    const source = String(safeReadFile(filePath, { encoding: 'utf8' }) || '');
    jsonLoaderViolations += [...source.matchAll(/JSON\.parse\(\s*safeReadFile\(/gu)].length;
    if (
      !filePath.endsWith(`${path.sep}foundation${path.sep}ajv.ts`) &&
      /new\s+\w*Ajv\w*\s*\(/u.test(source)
    ) {
      ajvViolations += 1;
    }
    envReads += [...source.matchAll(/process\.env\.KYBERION_[A-Z0-9_]+/gu)].length;
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
  if (ajvViolations > 0) failures.push(`Ajv constructor outside foundation: ${ajvViolations}`);
  if (envReads > ENV_RATCHET)
    failures.push(`KYBERION env reads increased: ${envReads} > ${ENV_RATCHET}`);
  if (catalogDefinitionsWithoutSchema > 0) {
    failures.push(
      `defineCatalog calls without schema: ${catalogDefinitionsWithoutSchema}/${catalogDefinitions}`
    );
  }
  return failures;
}

export function main(): void {
  const failures = checkFoundationAdoption();
  if (failures.length > 0) {
    console.error('[check:foundation-adoption] FAILED');
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
    return;
  }
  console.log('[check:foundation-adoption] OK');
}

if (process.argv[1]?.endsWith('check_foundation_adoption.ts')) main();
