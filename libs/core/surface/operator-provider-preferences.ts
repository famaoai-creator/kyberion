import * as path from 'node:path';
import { withExecutionContext } from '../authority.js';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { pathResolver } from '../path-resolver.js';
import { resolveActiveProfileRoot } from '../profile-root.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeWriteFile,
} from '../secure-io.js';

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

/**
 * Operator overlay for provider priority and default models, read from the
 * active profile's onboarding directory. This lives in the leaf so provider
 * resolution (and every reasoning-backend consumer behind it) reads the
 * overlay without loading the browser onboarding surface.
 */
export function loadOperatorProviderPreferences(): {
  priority: string[];
  default_models: Record<string, string>;
} | null {
  return withExecutionContext(
    'sovereign_concierge',
    () => {
      const profileRoot = assertSafeRepositoryPath(resolveActiveProfileRoot(), {
        allowMissingLeaf: true,
      });
      const value = loadOperatorProviderPreferencesAtPath(
        assertSafeRepositoryPath(
          path.join(profileRoot, 'onboarding', 'provider-preferences.json'),
          {
            allowMissingLeaf: true,
          }
        )
      );
      if (!value?.priority?.length) return null;
      return { priority: value.priority, default_models: value.default_models || {} };
    },
    'ecosystem_architect'
  );
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
