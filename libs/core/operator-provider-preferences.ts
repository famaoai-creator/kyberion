import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';

export interface OperatorProviderPreferences {
  version?: string;
  priority?: string[];
  default_models?: Record<string, string>;
  updated_at?: string;
  source?: string;
  [key: string]: unknown;
}

const OPERATOR_PROVIDER_PREFERENCES_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/operator-provider-preferences.schema.json'
);

/** Load an operator provider overlay only after repository and file checks. */
export function loadOperatorProviderPreferencesAtPath(
  filePath: string
): OperatorProviderPreferences | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return defineCatalog<OperatorProviderPreferences>({
      id: 'operator-provider-preferences',
      path: safePath,
      schema: OPERATOR_PROVIDER_PREFERENCES_SCHEMA_PATH,
    }).load();
  } catch {
    return null;
  }
}

/** Validate and persist provider preferences through the same catalog as reads. */
export function writeOperatorProviderPreferencesAtPath(
  filePath: string,
  preferences: OperatorProviderPreferences
): string {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = defineCatalog<OperatorProviderPreferences>({
    id: 'operator-provider-preferences',
    path: safePath,
    schema: OPERATOR_PROVIDER_PREFERENCES_SCHEMA_PATH,
  }).validate(preferences, safePath);
  safeWriteFile(safePath, JSON.stringify(validated, null, 2), {
    encoding: 'utf8',
    mkdir: true,
  });
  return safePath;
}
