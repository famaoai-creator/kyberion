import { defineCatalog } from './foundation/governed-catalog.js';
import { pathResolver } from './path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeWriteFile } from './secure-io.js';

const PERSONAL_IDENTITY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/personal-identity.schema.json'
);
const PERSONAL_AGENT_IDENTITY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/personal-agent-identity.schema.json'
);

function personalIdentityCatalogAtPath(filePath: string) {
  return defineCatalog<Record<string, unknown>>({
    id: 'personal-identity',
    path: filePath,
    schema: PERSONAL_IDENTITY_SCHEMA_PATH,
  });
}

function personalAgentIdentityCatalogAtPath(filePath: string) {
  return defineCatalog<Record<string, unknown>>({
    id: 'personal-agent-identity',
    path: filePath,
    schema: PERSONAL_AGENT_IDENTITY_SCHEMA_PATH,
  });
}

function loadIdentityCatalogAtPath(
  filePath: string,
  load: (safePath: string) => Record<string, unknown>
): Record<string, unknown> | null {
  try {
    const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
    if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) return null;
    return load(safePath);
  } catch {
    return null;
  }
}

/** Load an onboarding identity only after repository and regular-file checks. */
export function loadPersonalIdentityAtPath(filePath: string): Record<string, unknown> | null {
  return loadIdentityCatalogAtPath(filePath, (safePath) =>
    personalIdentityCatalogAtPath(safePath).load()
  );
}

/** Load the persisted agent identity only after repository and regular-file checks. */
export function loadPersonalAgentIdentityAtPath(filePath: string): Record<string, unknown> | null {
  return loadIdentityCatalogAtPath(filePath, (safePath) =>
    personalAgentIdentityCatalogAtPath(safePath).load()
  );
}

export function writePersonalIdentityAtPath(
  filePath: string,
  identity: Record<string, unknown>
): string {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = personalIdentityCatalogAtPath(safePath).validate(identity, safePath);
  safeWriteFile(safePath, JSON.stringify(validated, null, 2) + '\n', {
    mkdir: true,
    encoding: 'utf8',
  });
  return safePath;
}

export function writePersonalAgentIdentityAtPath(
  filePath: string,
  identity: Record<string, unknown>
): string {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = personalAgentIdentityCatalogAtPath(safePath).validate(identity, safePath);
  safeWriteFile(safePath, JSON.stringify(validated, null, 2) + '\n', {
    mkdir: true,
    encoding: 'utf8',
  });
  return safePath;
}
