/**
 * Run-manifest gate store grant (pipeline-run-manifest-model.md §3.5; the same
 * shape as the PR publication store grant of G2).
 *
 * A manifest-bound native browser run dispatches under `surface_runtime`, which
 * cannot read a tenant's governance state. The external-operation gate of that
 * run still has to read and record it for every admitted step. Two
 * module-private AsyncLocalStorage scopes, issued only by
 * governance/run-manifest-gate-runtime.ts (import boundary test
 * tests/run-manifest-gate-store-capability-boundary.test.ts), give it exactly
 * that and nothing else:
 *   - the gate binding (tenant, manifest hash) of one bound run; it may span
 *     awaits and confers no I/O by itself;
 *   - the store grant of one synchronous store access inside that binding: the
 *     exact files read and written for one of four kinds (charter read, bound
 *     manifest ledger append, review artifact, external-operation reservation).
 *     It ends when the callback returns, a thenable result is refused, and a
 *     captured continuation finds no grant.
 *
 * Ceilings: the bound tenant's standing charters (direct children of
 * knowledge/confidential/<tenant>/charters/, for the tripwire check) and the
 * bound manifest's run-manifest charter directory only; ledger appends to the
 * bound manifest's ledgers only; the tenant's own artifact floor and
 * reservation partition. Another tenant, another manifest, any other tenant
 * knowledge and any non-governance file are outside every kind.
 *
 * Both scopes live in this module instance only (a second instance neither
 * sees nor honours them; scripts/check/check_core_single_instance.ts keeps a
 * production process on one instance), and there is no registry to plant.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { RUN_MANIFEST_HASH_PATTERN } from './charter-scope.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS, STORAGE_FLOOR_ROOTS } from './runtime-state-roots.js';
import { isValidTenantSlug } from './scope.js';
import {
  isContentMutatingResourceAccessOperation,
  isReadLikeResourceAccessOperation,
  type ResourceAccessOperation,
} from './resource-access-scope.js';
import { registerStoreGrant } from './store-grant-registry.js';

export type RunManifestGateStoreKind =
  'charter-read' | 'charter-ledger-write' | 'review-write' | 'reservation-write';

/**
 * Issuance right of the run-manifest gate store grant. The name is listed in
 * role-assumption-policy `shared_core_roles`, which decides which processes may
 * issue the grant (authority.ts assertStoreGrantIssuanceAllowed); it is never
 * an assumable authority role (foundation/retired-store-roles.ts).
 */
export const RUN_MANIFEST_GATE_GRANT_ISSUANCE_RIGHT = 'run_manifest_gate_store';

interface GateBinding {
  readonly tenantSlug: string;
  readonly manifestHash: string;
}
interface StoreGrant {
  readonly binding: GateBinding;
  readonly kind: RunManifestGateStoreKind;
  readonly read: readonly string[];
  readonly write: readonly string[];
  /** False in an installation whose policy does not name the issuance right: narrowing only. */
  readonly authorizes: boolean;
}

const runtime = new AsyncLocalStorage<GateBinding>();
const access = new AsyncLocalStorage<StoreGrant>();
const issuedBindings = new WeakSet<GateBinding>();
const issuedGrants = new WeakSet<StoreGrant>();

function thenable(value: unknown): boolean {
  return (
    Boolean(value) &&
    (typeof value === 'object' || typeof value === 'function') &&
    'then' in (value as object)
  );
}

function currentBinding(): GateBinding | undefined {
  const binding = runtime.getStore();
  return binding && issuedBindings.has(binding) ? binding : undefined;
}

function currentGrant(): StoreGrant | undefined {
  const grant = access.getStore();
  if (!grant || !issuedGrants.has(grant)) return undefined;
  return currentBinding() === grant.binding ? grant : undefined;
}

/**
 * Internal issuer of the gate binding, import-restricted to
 * governance/run-manifest-gate-runtime.ts (withRunManifestGateStore).
 */
export function withRunManifestGateBinding<T>(
  tenantSlug: string,
  manifestHash: string,
  action: () => T
): T {
  if (!isValidTenantSlug(tenantSlug))
    throw new Error('[RUN_MANIFEST_GATE_SCOPE] Valid tenant required');
  if (typeof manifestHash !== 'string' || !RUN_MANIFEST_HASH_PATTERN.test(manifestHash))
    throw new Error('[RUN_MANIFEST_GATE_SCOPE] Valid manifest hash required');
  if (currentBinding())
    throw new Error('[RUN_MANIFEST_GATE_SCOPE] A gate binding is already installed');
  const binding: GateBinding = Object.freeze({ tenantSlug, manifestHash });
  issuedBindings.add(binding);
  let settled = false;
  const end = () => {
    if (!settled) issuedBindings.delete(binding);
    settled = true;
  };
  try {
    const result = runtime.run(binding, action);
    if (thenable(result))
      return Promise.resolve(result as unknown as Promise<unknown>).finally(end) as unknown as T;
    end();
    return result;
  } catch (error) {
    end();
    throw error;
  }
}

/** Snapshot of the live gate binding; mutating it changes nothing. */
export function currentRunManifestGateBinding():
  { tenantSlug: string; manifestHash: string } | undefined {
  const binding = currentBinding();
  return binding
    ? { tenantSlug: binding.tenantSlug, manifestHash: binding.manifestHash }
    : undefined;
}

/** Is a live store grant of this instance current? */
export function runManifestGateStoreGrantActive(): boolean {
  return Boolean(currentGrant());
}

function grantTenant(): string | undefined {
  return currentGrant()?.binding.tenantSlug;
}

const CHARTER_FILE = /^[a-z0-9-]+(?:\.ledger\.jsonl|\.json)$/;
const LEDGER_FILE = /^[a-z0-9-]+\.ledger\.jsonl$/;

function directChild(value: string, dir: string, file: RegExp): boolean {
  if (!value.startsWith(dir + '/')) return false;
  const rest = value.slice(dir.length + 1);
  return !rest.includes('/') && file.test(rest);
}

function chartersOf(binding: GateBinding): { charters: string; manifest: string } {
  const charters = `knowledge/confidential/${binding.tenantSlug}/charters`;
  return { charters, manifest: `${charters}/run-manifests/${binding.manifestHash}` };
}

function ceilingAllows(
  binding: GateBinding,
  kind: RunManifestGateStoreKind,
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
  const { charters, manifest } = chartersOf(binding);
  const floor = `confidential/${binding.tenantSlug}`;
  const artifact = `${STORAGE_FLOOR_ROOTS.artifact}/${floor}`;
  if (kind === 'charter-read')
    return (
      !writing &&
      (value === charters ||
        value === manifest ||
        directChild(value, charters, CHARTER_FILE) ||
        directChild(value, manifest, CHARTER_FILE))
    );
  if (kind === 'charter-ledger-write') return directChild(value, manifest, LEDGER_FILE);
  if (kind === 'review-write')
    return (
      value === `${artifact}/artifacts-index.jsonl` ||
      directChild(
        value,
        `${artifact}/evidence/external-operation-review`,
        /^[a-f0-9]{64}-[a-f0-9]{64}\.json$/
      )
    );
  if (kind === 'reservation-write')
    return new RegExp(
      `^active/shared/(?:runtime/external-operations/${floor}|tmp/${floor}/vitest-external-operations/[\\w-]+/[\\w-]+)/[a-f0-9]{64}\\.json$`
    ).test(value);
  return false;
}

/**
 * Internal synchronous issuer of one store grant, import-restricted to
 * governance/run-manifest-gate-runtime.ts (withRunManifestGateStoreAccess).
 * The exact files must fit the kind's ceiling for the live binding.
 */
export function withRunManifestGateStoreGrant<T>(
  kind: RunManifestGateStoreKind,
  read: readonly string[],
  write: readonly string[],
  authorizes: boolean,
  action: () => T
): T {
  const binding = currentBinding();
  if (!binding) throw new Error('[RUN_MANIFEST_GATE_SCOPE] Bound run-manifest gate required');
  if (
    !Array.isArray(read) ||
    !Array.isArray(write) ||
    !read.every((file) => ceilingAllows(binding, kind, file, false)) ||
    !write.every((file) => ceilingAllows(binding, kind, file, true))
  )
    throw new Error('[RUN_MANIFEST_GATE_SCOPE] Resource is outside the run-manifest gate store');
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
        throw new Error('[RUN_MANIFEST_GATE_SCOPE] Gate store access is synchronous only');
      }
      return result;
    });
  } finally {
    issuedGrants.delete(grant);
  }
}

/**
 * Deny-only ceiling of the live grant: the exact files read (and written), any
 * ancestor's metadata or mkdir, and product knowledge reads (schemas, catalog
 * validation). False without a live grant of this instance.
 */
export function runManifestGateResourceAllowed(
  target: string,
  operation: ResourceAccessOperation
): boolean {
  const grant = currentGrant();
  if (!grant) return false;
  if (
    isReadLikeResourceAccessOperation(operation) &&
    (target === 'knowledge/product' || target.startsWith('knowledge/product/'))
  )
    return true;
  if (isContentMutatingResourceAccessOperation(operation)) return grant.write.includes(target);
  if (operation === 'read') return grant.read.includes(target) || grant.write.includes(target);
  return [...grant.read, ...grant.write].some(
    (file) => file === target || target === '' || file.startsWith(target + '/')
  );
}

function within(target: string, root: string): boolean {
  return target === root || target.startsWith(root + '/');
}

/**
 * Does the live grant authorize this I/O? Only inside its ceiling, and only
 * under the bound tenant's governance roots: reads of its charters, artifact
 * floor and reservation partition; writes to the bound manifest's charter
 * directory, the artifact floor and the reservation partition. Ancestors above
 * these roots stay with the caller's own policy, under the same narrowing.
 */
export function runManifestGateGrantAuthorizes(
  target: string,
  operation: ResourceAccessOperation
): boolean {
  const grant = currentGrant();
  if (!grant?.authorizes || !runManifestGateResourceAllowed(target, operation)) return false;
  const { charters, manifest } = chartersOf(grant.binding);
  const floor = `confidential/${grant.binding.tenantSlug}`;
  const shared = [
    `${PARTITIONED_RUNTIME_STATE_ROOTS.external_operations}/${floor}`,
    `${STORAGE_FLOOR_ROOTS.scratch}/${floor}/vitest-external-operations`,
    `${STORAGE_FLOOR_ROOTS.artifact}/${floor}`,
  ];
  const roots = isReadLikeResourceAccessOperation(operation)
    ? [charters, ...shared]
    : [manifest, ...shared];
  return roots.some((root) => within(target, root));
}

// G3: tier-guard asks these rules through the store grant registry.
registerStoreGrant({
  id: 'run-manifest-gate',
  active: runManifestGateStoreGrantActive,
  authorizes: (target, operation) => runManifestGateGrantAuthorizes(target, operation),
  narrowing: ({ candidates, operation }) =>
    runManifestGateStoreGrantActive() &&
    !candidates().every((target) => runManifestGateResourceAllowed(target, operation))
      ? '[RUN_MANIFEST_GATE_SCOPE] Run-manifest gate store requires an exact governance resource'
      : null,
  // The live grant may create the confidential tier container of its own
  // tenant's artifact floor or reservation store, and nothing else structurally.
  structuralMkdir: (relativePath, _protectedPrefix, tenantSlug) =>
    runManifestGateStoreGrantActive()
      ? tenantSlug !== undefined &&
        grantTenant() === tenantSlug &&
        [
          `${STORAGE_FLOOR_ROOTS.artifact}/confidential`,
          `${PARTITIONED_RUNTIME_STATE_ROOTS.external_operations}/confidential`,
        ].includes(relativePath) &&
        runManifestGateResourceAllowed(relativePath, 'mkdir')
      : undefined,
});
