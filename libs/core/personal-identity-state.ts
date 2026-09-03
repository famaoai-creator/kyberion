import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat } from './secure-io.js';

const PERSONAL_IDENTITY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/personal-identity.schema.json'
);

function personalIdentityCatalogAtPath(filePath: string) {
  return defineCatalog<Record<string, unknown>>({
    id: 'personal-identity',
    path: filePath,
    schema: PERSONAL_IDENTITY_SCHEMA_PATH,
  });
}

/** Load an onboarding identity only after repository and regular-file checks. */
export function loadPersonalIdentityAtPath(filePath: string): Record<string, unknown> | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return personalIdentityCatalogAtPath(safePath).load();
  } catch {
    return null;
  }
}
