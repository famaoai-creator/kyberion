/**
 * Internal synchronous, exact-file ceiling for the admitted allocation broker
 * (secret/credential-allocations.ts only; import boundary test
 * tests/credential-material-capability-boundary.test.ts).
 *
 * G2: the live grant is itself the authority for the read it covers
 * (`credentialMaterialGrantAllows`, asked by tier-guard's store-grant table);
 * there is no credential material reader role.
 */
import {
  createSynchronousResourceGrantIssuer,
  currentResourceAccessScope,
  decideResourceAccess,
  type ResourceAccessOperation,
  type ResourceAccessScope,
} from './resource-access-scope.js';

/**
 * Issuance right of the credential material grant (G2). The former shared core role of this name
 * is gone; the name stays only in role-assumption-policy `shared_core_roles`, which decides which
 * processes may issue the grant (authority.ts assertStoreGrantIssuanceAllowed). It is not an
 * assumable authority role.
 */
export const CREDENTIAL_MATERIAL_GRANT_ISSUANCE_RIGHT = 'credential_material_reader';
const CONNECTIONS = 'knowledge/personal/connections';
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

/**
 * Does the live grant authorize this I/O? Only inside its exact ceiling (one connection file read,
 * the metadata of it and its ancestors, product reads) and only where the former
 * `credential_material_reader` policy grant reached: reads under the connections directory, and
 * the metadata of its ancestors (the role-policy metadata rule for a scoped role). Product reads
 * stay with the caller's own policy (they are public).
 */
export function credentialMaterialGrantAllows(
  target: string,
  operation: ResourceAccessOperation
): boolean {
  const scope = currentResourceAccessScope();
  if (!isCredentialMaterialCapability(scope)) return false;
  if (operation !== 'read' && operation !== 'metadata') return false;
  const under = target === CONNECTIONS || target.startsWith(CONNECTIONS + '/');
  const ancestor = operation === 'metadata' && CONNECTIONS.startsWith(target + '/');
  if (!under && !ancestor) return false;
  return decideResourceAccess(scope!, target, operation).allowed;
}
