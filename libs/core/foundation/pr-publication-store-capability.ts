/**
 * PR publication store grant (G2 of the store-catalog guard design).
 *
 * Two module-private AsyncLocalStorage scopes, issued only by
 * governance/pr-publication-runtime.ts (import boundary test
 * tests/pr-publication-store-capability-boundary.test.ts):
 *   - the publication binding (scope, invocation hash, typed VCS operation) of
 *     one VCS host run; it may span awaits and confers no I/O by itself;
 *   - the store grant of one synchronous store access inside that binding: the
 *     exact files read and written for one of five kinds (charter read, charter
 *     ledger append, review artifact, PR body stage, external-operation
 *     reservation). It ends when the callback returns, a thenable result is
 *     refused, and a captured continuation finds no grant.
 *
 * Both live in this module instance only: a second instance of @agent/core
 * neither sees nor honours them (scripts/check_core_single_instance.ts keeps a
 * production process on one instance), and there is no registry to plant.
 *
 * G2: the live grant is itself the authority (there is no store role). While it
 * is current every I/O is narrowed to its ceiling (`prPublicationResourceAllowed`,
 * applied by tier-guard), and inside that ceiling it authorizes what the former
 * role's policy grant covered (`prPublicationGrantAuthorizes`); the rest of the
 * ceiling (ancestors above those roots) stays with the caller's own policy.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { CharterScope } from '../governance/accountability-charter.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS, STORAGE_FLOOR_ROOTS } from './runtime-state-roots.js';
import { isValidTenantSlug } from './scope.js';
import { registerStoreGrant } from './store-grant-registry.js';

export type VcsPublicationOperation = 'vcs:pr_create' | 'vcs:push' | 'vcs:pr_merge';
export type PrPublicationStoreKind =
  'charter-read' | 'charter-ledger-write' | 'review-write' | 'reservation-write' | 'body-stage';
export type PrPublicationOperation = 'read' | 'write' | 'append' | 'mkdir' | 'metadata';

/**
 * Issuance right of the PR publication store grant (G2). The former shared core role of this
 * name is gone; the name stays only in role-assumption-policy `shared_core_roles`, which decides
 * which processes may issue the grant (authority.ts assertStoreGrantIssuanceAllowed). It is not
 * an assumable authority role.
 */
export const PR_PUBLICATION_GRANT_ISSUANCE_RIGHT = 'pr_publication_store';

interface PublicationBinding {
  readonly scope: CharterScope;
  readonly invocationId: string;
  readonly operationId: VcsPublicationOperation;
}
interface StoreGrant {
  readonly binding: PublicationBinding;
  readonly kind: PrPublicationStoreKind;
  readonly read: readonly string[];
  readonly write: readonly string[];
  /** False in an installation that has not registered the issuance right: narrowing only. */
  readonly authorizes: boolean;
}

const OPERATIONS: readonly VcsPublicationOperation[] = [
  'vcs:pr_create',
  'vcs:push',
  'vcs:pr_merge',
];
const runtime = new AsyncLocalStorage<PublicationBinding>();
const access = new AsyncLocalStorage<StoreGrant>();
const issuedBindings = new WeakSet<PublicationBinding>();
const issuedGrants = new WeakSet<StoreGrant>();

function thenable(value: unknown): boolean {
  return (
    Boolean(value) &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in (value as object)
  );
}

function currentBinding(): PublicationBinding | undefined {
  const binding = runtime.getStore();
  return binding && issuedBindings.has(binding) ? binding : undefined;
}

/** The live grant of this instance, inside the binding that issued it; else undefined. */
function currentGrant(): StoreGrant | undefined {
  const grant = access.getStore();
  if (!grant || !issuedGrants.has(grant)) return undefined;
  return currentBinding() === grant.binding ? grant : undefined;
}

/**
 * Internal issuer of the publication binding, import-restricted to
 * governance/pr-publication-runtime.ts (withPrPublicationRuntime).
 */
export function withPrPublicationBinding<T>(
  scope: CharterScope,
  invocationId: string,
  operationId: VcsPublicationOperation,
  action: () => T
): T {
  if (typeof invocationId !== 'string' || !/^[a-f0-9]{64}$/.test(invocationId))
    throw new Error('[PR_PUBLICATION_SCOPE] Stable invocation hash required');
  if (
    scope?.kind !== 'person' &&
    (scope?.kind !== 'organization' || !isValidTenantSlug(scope.tenant_slug))
  )
    throw new Error('[PR_PUBLICATION_SCOPE] Valid publication scope required');
  if (!OPERATIONS.includes(operationId))
    throw new Error('[PR_PUBLICATION_SCOPE] Typed VCS mutation required');
  const frozen: CharterScope =
    scope.kind === 'person'
      ? Object.freeze({ kind: 'person' as const })
      : Object.freeze({ kind: 'organization' as const, tenant_slug: scope.tenant_slug });
  const binding: PublicationBinding = Object.freeze({ scope: frozen, invocationId, operationId });
  issuedBindings.add(binding);
  // The binding may span awaits (approval request, VCS transport); it ends when
  // the run settles, so a captured continuation after that finds no binding.
  let settled = false;
  const end = () => {
    if (!settled) issuedBindings.delete(binding);
    settled = true;
  };
  try {
    const result = runtime.run(binding, action);
    if (thenable(result)) {
      return Promise.resolve(result as unknown as Promise<unknown>).finally(end) as unknown as T;
    }
    end();
    return result;
  } catch (error) {
    end();
    throw error;
  }
}

/** Snapshot of the live publication binding; mutation of it changes nothing. */
export function currentPrPublicationBinding():
  { scope: CharterScope; invocationId: string; operationId: VcsPublicationOperation } | undefined {
  const binding = currentBinding();
  return binding
    ? {
        scope: structuredClone(binding.scope) as CharterScope,
        invocationId: binding.invocationId,
        operationId: binding.operationId,
      }
    : undefined;
}

/** The binding's tenant (organization scope), or undefined for a person publication. */
export function prPublicationGrantTenant(): string | undefined {
  const grant = currentGrant();
  return grant?.binding.scope.kind === 'organization' ? grant.binding.scope.tenant_slug : undefined;
}

/** Is a live store grant of this instance current? */
export function prPublicationStoreGrantActive(): boolean {
  return Boolean(currentGrant());
}

function ceilingAllows(
  binding: PublicationBinding,
  kind: PrPublicationStoreKind,
  value: string,
  writing: boolean
): boolean {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    value.includes('\0') ||
    value.split('/').includes('..') ||
    value.startsWith('/')
  )
    return false;
  const tenant = binding.scope.kind === 'organization' ? binding.scope.tenant_slug : undefined;
  const charter = tenant
    ? `knowledge/confidential/${tenant}/charters`
    : 'knowledge/personal/charters';
  const floor = tenant ? `confidential/${tenant}` : 'personal/shared';
  const artifact = `active/shared/artifacts/${floor}`;
  const publicArtifact = 'active/shared/artifacts/public/shared';
  if (kind === 'charter-read')
    return (
      !writing &&
      (value === charter ||
        (value.startsWith(charter + '/') &&
          /^[a-z0-9-]+(?:\.ledger\.jsonl|\.json)$/.test(value.slice(charter.length + 1))))
    );
  if (kind === 'charter-ledger-write')
    return (
      Boolean(tenant) &&
      value.startsWith(charter + '/') &&
      /^[a-z0-9-]+\.ledger\.jsonl$/.test(value.slice(charter.length + 1))
    );
  if (kind === 'review-write')
    return (
      value === `${artifact}/artifacts-index.jsonl` ||
      (value.startsWith(
        `${artifact}/evidence/${binding.operationId === 'vcs:pr_create' ? 'pr-publication' : 'vcs-publication'}/${binding.invocationId}/`
      ) &&
        /^[a-f0-9]{64}\.json$/.test(value.split('/').at(-1)!))
    );
  if (kind === 'body-stage')
    return (
      value === `${publicArtifact}/artifacts-index.jsonl` ||
      (value.startsWith(`${publicArtifact}/evidence/pr-publication/${binding.invocationId}/`) &&
        /^body-[a-f0-9]{64}\.md$/.test(value.split('/').at(-1)!))
    );
  if (kind === 'reservation-write')
    return new RegExp(
      `^active/shared/(?:runtime/external-operations/${floor}|tmp/${floor}/vitest-external-operations/[\\w-]+/[\\w-]+)/[a-f0-9]{64}\\.json$`
    ).test(value);
  return false;
}

/**
 * Internal synchronous issuer of one store grant, import-restricted to
 * governance/pr-publication-runtime.ts (withPrPublicationStoreAccess). The
 * exact files must fit the kind's ceiling for the live binding.
 */
export function withPrPublicationStoreGrant<T>(
  kind: PrPublicationStoreKind,
  read: readonly string[],
  write: readonly string[],
  authorizes: boolean,
  action: () => T
): T {
  const binding = currentBinding();
  if (!binding) throw new Error('[PR_PUBLICATION_SCOPE] Trusted publication host required');
  if (
    !Array.isArray(read) ||
    !Array.isArray(write) ||
    !read.every((file) => ceilingAllows(binding, kind, file, false)) ||
    !write.every((file) => ceilingAllows(binding, kind, file, true))
  )
    throw new Error('[PR_PUBLICATION_SCOPE] Resource is outside publication store');
  const grant: StoreGrant = Object.freeze({
    binding,
    kind,
    read: Object.freeze([...read]),
    write: Object.freeze([...write]),
    authorizes: authorizes === true,
  });
  issuedGrants.add(grant);
  try {
    return access.run(grant, () => {
      const result = action();
      if (thenable(result)) {
        void Promise.resolve(result).catch(() => undefined);
        throw new Error('[PR_PUBLICATION_SCOPE] Publication store access is synchronous only');
      }
      return result;
    });
  } finally {
    issuedGrants.delete(grant);
  }
}

/**
 * Deny-only ceiling of the live grant: the exact files read (and written), any
 * ancestor's metadata or mkdir, and product knowledge reads (shared schema and
 * catalog validation). False without a live grant of this instance.
 */
export function prPublicationResourceAllowed(
  target: string,
  operation: PrPublicationOperation
): boolean {
  const grant = currentGrant();
  if (!grant) return false;
  if (
    (operation === 'read' || operation === 'metadata') &&
    (target === 'knowledge/product' || target.startsWith('knowledge/product/'))
  )
    return true;
  if (operation === 'write' || operation === 'append') return grant.write.includes(target);
  if (operation === 'read') return grant.read.includes(target) || grant.write.includes(target);
  return [...grant.read, ...grant.write].some(
    (file) => file === target || target === '' || file.startsWith(target + '/')
  );
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root + '/');
}

/**
 * Does the live grant authorize this I/O? Only inside its ceiling, and only under the roots the
 * former `pr_publication_store` policy grant covered for the binding's tenant (reads: person and
 * tenant charters, the binding's artifact floor, external operations, scratch; writes, appends and
 * mkdir: tenant charters, artifacts, external operations, scratch). Ancestors above these roots
 * (e.g. `active/shared`) and public reads are decided by the caller's own policy, under the same
 * narrowing.
 */
export function prPublicationGrantAuthorizes(
  target: string,
  operation: PrPublicationOperation
): boolean {
  const grant = currentGrant();
  if (!grant?.authorizes || !prPublicationResourceAllowed(target, operation)) return false;
  const tenant =
    grant.binding.scope.kind === 'organization' ? grant.binding.scope.tenant_slug : undefined;
  const charters = tenant ? [`knowledge/confidential/${tenant}/charters`] : [];
  const artifacts = STORAGE_FLOOR_ROOTS.artifact;
  const shared = [PARTITIONED_RUNTIME_STATE_ROOTS.external_operations, STORAGE_FLOOR_ROOTS.scratch];
  const roots =
    operation === 'read' || operation === 'metadata'
      ? [
          'knowledge/personal/charters',
          ...charters,
          `${artifacts}/personal/shared`,
          ...(tenant ? [`${artifacts}/confidential/${tenant}`] : []),
          ...shared,
        ]
      : [...charters, artifacts, ...shared];
  return roots.some((root) => within(target, root));
}

// G3: tier-guard asks these rules through the store grant registry, not by importing this module.
registerStoreGrant({
  id: 'pr-publication',
  active: prPublicationStoreGrantActive,
  authorizes: (target, operation) => prPublicationGrantAuthorizes(target, operation),
  narrowing: ({ candidates, operation }) =>
    prPublicationStoreGrantActive() &&
    !candidates().every((target) => prPublicationResourceAllowed(target, operation))
      ? '[PR_PUBLICATION_SCOPE] Publication store requires exact host resource capability'
      : null,
  // The live grant may create the confidential tier container of its own organization
  // tenant's artifact floor or reservation store, and nothing else structurally.
  structuralMkdir: (relativePath, _protectedPrefix, tenantSlug) =>
    prPublicationStoreGrantActive()
      ? tenantSlug !== undefined &&
        prPublicationGrantTenant() === tenantSlug &&
        [
          `${STORAGE_FLOOR_ROOTS.artifact}/confidential`,
          `${PARTITIONED_RUNTIME_STATE_ROOTS.external_operations}/confidential`,
        ].includes(relativePath) &&
        prPublicationResourceAllowed(relativePath, 'mkdir')
      : undefined,
});
