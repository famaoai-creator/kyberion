/** Internal synchronous, exact-file ceiling for the admitted allocation broker. */
import {
  createSynchronousResourceGrantIssuer,
  type ResourceAccessScope,
} from './resource-access-scope.js';
const grants =
  createSynchronousResourceGrantIssuer<Readonly<{ tenant: string; file: string }>>(
    'CREDENTIAL_CAPABILITY'
  );
export function withCredentialMaterialCapability<T>(tenant: string, file: string, run: () => T): T {
  if (!/^knowledge\/personal\/connections\/[a-z0-9][a-z0-9._-]{0,63}\.json$/.test(file))
    throw new Error('[CREDENTIAL_CAPABILITY_INVALID] Exact canonical connection path required');
  return grants.run(
    Object.freeze({ tenant, file }),
    {
      tenantSlug: tenant,
      readExact: [file],
      writeExact: [],
      mkdirExact: [],
      metadataExact: [file, 'knowledge', 'knowledge/personal', 'knowledge/personal/connections'],
      allowProductKnowledgeRead: true,
    },
    run
  );
}

export function isCredentialMaterialCapability(scope: ResourceAccessScope | undefined): boolean {
  return Boolean(grants.resolve(scope));
}
