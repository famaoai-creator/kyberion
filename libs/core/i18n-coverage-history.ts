import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';

export interface I18nCoverageHistorySnapshot {
  recorded_at: string;
  locales: Record<string, number>;
}

const I18N_COVERAGE_HISTORY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/i18n-coverage-history.schema.json'
);

function i18nCoverageHistoryCatalogAtPath(filePath: string) {
  return defineCatalog<I18nCoverageHistorySnapshot>({
    id: 'i18n-coverage-history',
    path: filePath,
    schema: I18N_COVERAGE_HISTORY_SCHEMA_PATH,
  });
}

/** Load an i18n coverage snapshot through the shared schema and path boundary. */
export function loadI18nCoverageHistoryAtPath(
  filePath: string
): I18nCoverageHistorySnapshot | null {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  if (!safeExistsSync(safePath)) return null;
  if (!safeLstat(safePath).isFile()) {
    throw new Error(`[I18N_COVERAGE_HISTORY] history must be a regular file: ${filePath}`);
  }
  return i18nCoverageHistoryCatalogAtPath(safePath).load();
}

/** Validate and persist an i18n coverage snapshot using the same contract as the reader. */
export function writeI18nCoverageHistoryAtPath(
  filePath: string,
  snapshot: I18nCoverageHistorySnapshot
): I18nCoverageHistorySnapshot {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = i18nCoverageHistoryCatalogAtPath(safePath).validate(snapshot, safePath);
  safeWriteFile(safePath, `${JSON.stringify(validated, null, 2)}\n`, { encoding: 'utf8' });
  return validated;
}
