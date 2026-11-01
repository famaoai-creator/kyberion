/** Internal synchronous, exact-file ceiling for the admitted allocation broker. */
import { runInResourceAccessScope, type ResourceAccessScope } from './resource-access-scope.js';
const active = new WeakMap<object, { tenant: string; file: string }>();
export function withCredentialMaterialCapability<T>(tenant: string, file: string, run: () => T): T {
  if (!/^knowledge\/personal\/connections\/[a-z0-9][a-z0-9._-]{0,63}\.json$/.test(file))
    throw new Error('[CREDENTIAL_CAPABILITY_INVALID] Exact canonical connection path required');
  const token = Object.freeze({});
  active.set(token, { tenant, file });
  try {
    return runInResourceAccessScope(
      {
        tenantSlug: tenant,
        readExact: [file],
        writeExact: [],
        mkdirExact: [],
        metadataExact: [file, 'knowledge', 'knowledge/personal', 'knowledge/personal/connections'],
        allowProductKnowledgeRead: true,
        opaqueStoreToken: token,
      },
      run
    );
  } finally {
    active.delete(token);
  }
}
export function isCredentialMaterialCapability(scope: ResourceAccessScope | undefined): boolean {
  const entry = scope?.opaqueStoreToken && active.get(scope.opaqueStoreToken);
  return Boolean(
    entry &&
    scope &&
    entry.tenant === scope.tenantSlug &&
    scope.readExact.length === 1 &&
    scope.readExact[0] === entry.file &&
    !scope.writeExact.length &&
    !scope.mkdirExact.length &&
    !scope.appendExact?.length
  );
}
