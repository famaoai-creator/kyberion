import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { readTenantProfile, tenantProfileDir } from './organization/tenant-registry.js';
import { TENANT_CHANNEL_BINDINGS_FILE, tenantHomePath } from './organization/tenant-home.js';
import { CUSTOMER_CHANNEL_BINDING_STORE_ROLE } from './foundation/customer-channel-binding-store-capability.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeReaddir } from './secure-io.js';
import { logger } from './core.js';
import { isValidTenantSlug } from './foundation/scope.js';
import { withExecutionContext } from './authority.js';

/** Reads exactly `knowledge/personal/tenants/<tenant>.json` (shared core role). */
const TENANT_REGISTRY_READER_ROLE = 'workspace_tenant_registry_reader';
const TENANT_REGISTRY_INDEX_READER_ROLE = 'workspace_tenant_registry_index_reader';

/**
 * E2E-06 Task 1: channel → customer binding.
 *
 * A binding declares that a specific surface channel (Slack channel, Telegram
 * chat, email address, …) is a conversation with a customer tenant. Bound
 * channels are handled in customer mode BEFORE any operator processing:
 * catalog-grounded replies, tenant-scoped knowledge, approval-gated outbound.
 */

export type CustomerBindingSurface = 'slack' | 'telegram' | 'email' | 'imessage' | 'discord';

export interface CustomerChannelBinding {
  surface: CustomerBindingSurface;
  channel_id: string;
  counterpart?: { name?: string; org?: string };
  language?: string;
  disclosure_level?: 'public_catalog_only';
  /** Conversation-mode override; default derives from the deal stage. */
  mode?: 'sales' | 'support' | 'requirements_hearing';
  active?: boolean;
}

export interface ResolvedCustomerBinding {
  tenantSlug: string;
  binding: CustomerChannelBinding;
}

export const CUSTOMER_CHANNEL_BINDINGS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/customer-channel-binding.schema.json'
);

export interface CustomerChannelBindingListOptions {
  /** Repository root seam for hermetic callers; defaults to the live root. */
  rootDir?: string;
  /**
   * Throw on registry/binding read, path or validation failures instead of
   * treating them as no bindings. Genuine absence still yields no bindings.
   * For checks that must fail closed, such as a bind's cross-tenant check.
   */
  strict?: boolean;
}

function readBindingsFile(
  filePath: string,
  rootDir: string,
  strict = false
): CustomerChannelBinding[] {
  try {
    const safeFilePath = assertSafeRepositoryPath(filePath, { rootDir, allowMissingLeaf: true });
    if (strict) {
      try {
        safeLstat(safeFilePath);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
    } else if (!safeExistsSync(safeFilePath)) return [];
    const parsed = defineCatalog<{ bindings: CustomerChannelBinding[] }>({
      id: 'customer-channel-binding',
      path: safeFilePath,
      schema: CUSTOMER_CHANNEL_BINDINGS_SCHEMA_PATH,
    }).load();
    return parsed.bindings;
  } catch (err) {
    if (strict) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[customer-channel-binding] failed to read ${filePath}: ${message}`);
    return [];
  }
}

/**
 * Is this one tenant registered and active? Read as the tenant registry's
 * narrow reader (`knowledge/personal/tenants/<tenant>.json` only), so a
 * process without a personal-tier persona can check it; any failure is "no".
 */
function isActiveTenant(tenantSlug: string, rootDir: string, strict = false): boolean {
  try {
    return withExecutionContext(
      TENANT_REGISTRY_READER_ROLE,
      () => readTenantProfile(tenantSlug, { rootDir })?.status === 'active',
      'worker',
      tenantSlug
    );
  } catch (err) {
    if (strict) throw err;
    return false;
  }
}

/** Is this tenant registered and active (fails closed)? The rule every binding read and write uses. */
export function isActiveCustomerTenant(
  tenantSlug: string,
  options: CustomerChannelBindingListOptions = {}
): boolean {
  if (!isValidTenantSlug(tenantSlug)) return false;
  return isActiveTenant(tenantSlug, path.resolve(options.rootDir ?? pathResolver.rootDir()));
}

/**
 * One tenant's bindings, read as the binding store role bound to that tenant —
 * the role whose grant is exactly that file. Throws when the caller is bound to
 * another tenant ([ROLE_TENANT_SCOPE_MISMATCH]).
 */
function readTenantBindingsFile(
  tenantSlug: string,
  rootDir: string,
  strict = false
): CustomerChannelBinding[] {
  const filePath = tenantHomePath(tenantSlug, TENANT_CHANNEL_BINDINGS_FILE, rootDir);
  return withExecutionContext(
    CUSTOMER_CHANNEL_BINDING_STORE_ROLE,
    () => readBindingsFile(filePath, rootDir, strict),
    'worker',
    tenantSlug
  );
}

/** Registered, active tenants — the only ones that may have bindings. */
export function listActiveCustomerTenantSlugs(
  options: CustomerChannelBindingListOptions = {}
): string[] {
  const rootDir = path.resolve(options.rootDir ?? pathResolver.rootDir());
  return [...activeRegisteredTenantSlugs(rootDir, options.strict === true)].sort();
}

/**
 * Registered, active tenants. The registry is listed as its index reader and
 * each profile read as its tenant-bound reader, so no personal-tier persona is
 * needed. A malformed, unreadable or unauthorized profile is not a binding
 * authority: discovery skips it, or (strict) throws so a check fails closed.
 */
function activeRegisteredTenantSlugs(rootDir: string, strict = false): Set<string> {
  const registered = new Set<string>();
  let slugs: string[];
  try {
    // The index reader lists names only; each profile is then checked by isActiveTenant.
    slugs = withExecutionContext(
      TENANT_REGISTRY_INDEX_READER_ROLE,
      () => {
        const dir = tenantProfileDir({ rootDir });
        if (!safeExistsSync(dir)) return [];
        return safeReaddir(dir)
          .filter((entry) => entry.endsWith('.json'))
          .map((entry) => entry.slice(0, -'.json'.length))
          .filter(isValidTenantSlug);
      },
      'worker'
    );
  } catch (err) {
    if (strict) throw err;
    return registered;
  }
  for (const slug of slugs) {
    if (isActiveTenant(slug, rootDir, strict)) registered.add(slug);
  }
  return registered;
}

export function listCustomerChannelBindings(
  options: CustomerChannelBindingListOptions = {}
): Array<ResolvedCustomerBinding & { file: string }> {
  const rootDir = path.resolve(options.rootDir ?? pathResolver.rootDir());
  const results: Array<ResolvedCustomerBinding & { file: string }> = [];
  // Only a registered, active tenant has bindings; each lives in that tenant's home.
  for (const slug of [...activeRegisteredTenantSlugs(rootDir, options.strict === true)].sort()) {
    let bindings: CustomerChannelBinding[];
    try {
      bindings = readTenantBindingsFile(slug, rootDir, options.strict === true);
    } catch (err) {
      if (options.strict) throw err;
      // A tenant this process may not read routes nothing here (fails closed).
      continue;
    }
    const file = tenantHomePath(slug, TENANT_CHANNEL_BINDINGS_FILE, rootDir);
    for (const binding of bindings) results.push({ tenantSlug: slug, binding, file });
  }
  return results;
}

/**
 * Resolve a customer binding for an inbound message. Returns null when the
 * channel is not bound (→ normal operator processing). Inactive bindings do
 * not match.
 */
export function resolveCustomerBinding(
  surface: string,
  channelId: string,
  options: CustomerChannelBindingListOptions = {}
): ResolvedCustomerBinding | null {
  const normalizedSurface = String(surface || '').trim();
  const normalizedChannel = String(channelId || '').trim();
  if (!normalizedSurface || !normalizedChannel) return null;
  for (const entry of listCustomerChannelBindings(options)) {
    if (entry.binding.active === false) continue;
    if (entry.binding.surface !== normalizedSurface) continue;
    if (entry.binding.channel_id !== normalizedChannel) continue;
    return { tenantSlug: entry.tenantSlug, binding: entry.binding };
  }
  return null;
}

/**
 * CD-11: one tenant's bindings only (`knowledge/confidential/<tenant>/connections/channel-bindings.json`),
 * never a walk over other tenants, and none for a tenant that is not
 * registered and active (fails closed). A file that cannot be read or does
 * not validate is logged and yields no bindings, unless strict is requested.
 */
export function readTenantCustomerChannelBindings(
  tenantSlug: string,
  options: CustomerChannelBindingListOptions = {}
): CustomerChannelBinding[] {
  if (!isValidTenantSlug(tenantSlug)) return [];
  const rootDir = path.resolve(options.rootDir ?? pathResolver.rootDir());
  // Same rule as the cross-tenant listing: only a registered, active tenant
  // has bindings (a suspended tenant never messages its customers).
  if (!isActiveTenant(tenantSlug, rootDir, options.strict === true)) return [];
  try {
    return readTenantBindingsFile(tenantSlug, rootDir, options.strict === true);
  } catch (err) {
    if (options.strict) throw err;
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(
      `[customer-channel-binding] tenant '${tenantSlug}' bindings not readable here: ${message}`
    );
    return [];
  }
}

/** CD-11: the tenant's active binding for exactly this surface + channel, or null. */
export function findTenantCustomerChannelBinding(
  tenantSlug: string,
  surface: string,
  channelId: string,
  options: CustomerChannelBindingListOptions = {}
): ResolvedCustomerBinding | null {
  const binding = readTenantCustomerChannelBindings(tenantSlug, options).find(
    (item) => item.active !== false && item.surface === surface && item.channel_id === channelId
  );
  return binding ? { tenantSlug, binding } : null;
}
