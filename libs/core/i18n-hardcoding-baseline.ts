import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeMkdir,
  safeWriteFile,
} from './secure-io.js';

export interface I18nHardcodingBaseline {
  version: number;
  generated_at: string;
  scan_roots: string[];
  files: Record<string, number>;
}

const I18N_BASELINE_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/i18n-baseline.schema.json'
);

function baselineCatalogAtPath(filePath: string) {
  return defineCatalog<I18nHardcodingBaseline>({
    id: 'i18n-hardcoding-baseline',
    path: filePath,
    schema: I18N_BASELINE_SCHEMA_PATH,
  });
}

/** Load an i18n baseline only after repository and regular-file checks. */
export function loadI18nHardcodingBaselineAtPath(filePath: string): I18nHardcodingBaseline | null {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) return null;
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[I18N_BASELINE] baseline must be a regular file: ${filePath}`);
  }
  return baselineCatalogAtPath(safePath).load();
}

/** Validate and persist an i18n baseline using the same contract as the reader. */
export function writeI18nHardcodingBaselineAtPath(
  filePath: string,
  baseline: I18nHardcodingBaseline
): I18nHardcodingBaseline {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (safeExistsSync(safePath) && !safeLstat(safePath).isFile()) {
    throw new Error(`[I18N_BASELINE] baseline must be a regular file: ${filePath}`);
  }
  const validated = baselineCatalogAtPath(safePath).validate(baseline, safePath);
  safeMkdir(path.dirname(safePath), { recursive: true });
  safeWriteFile(
    safePath,
    `${JSON.stringify({ $schema: '../schemas/i18n-baseline.schema.json', ...validated }, null, 2)}\n`,
    { encoding: 'utf8' }
  );
  return validated;
}
