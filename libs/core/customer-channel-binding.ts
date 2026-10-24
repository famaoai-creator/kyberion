import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { readTenantProfile, listTenantProfileSlugs } from './organization/tenant-registry.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir, safeStat } from './secure-io.js';
import { logger } from './core.js';
import { isValidTenantSlug } from './foundation/scope.js';
import { withExecutionContext } from './authority.js';

/** Reads exactly `knowledge/personal/tenants/<tenant>.json` (shared core role). */
const TENANT_REGISTRY_READER_ROLE = 'workspace_tenant_registry_reader';

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

const BINDINGS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/customer-channel-binding.schema.json'
);

export interface CustomerChannelBindingListOptions {
  /** Repository root seam for hermetic callers; defaults to the live root. */
  rootDir?: string;
}

function readBindingsFile(filePath: string, rootDir: string): CustomerChannelBinding[] {
  try {
    const safeFilePath = assertSafeRepositoryPath(filePath, { rootDir });
    if (!safeExistsSync(safeFilePath)) return [];
    const parsed = defineCatalog<{ bindings: CustomerChannelBinding[] }>({
      id: 'customer-channel-binding',
      path: safeFilePath,
      schema: BINDINGS_SCHEMA_PATH,
    }).load();
    return parsed.bindings;
  } catch (err) {
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
function isActiveTenant(tenantSlug: string, rootDir: string): boolean {
  try {
    return withExecutionContext(
      TENANT_REGISTRY_READER_ROLE,
      () => readTenantProfile(tenantSlug, { rootDir })?.status === 'active',
      'worker',
      tenantSlug
    );
  } catch {
    return false;
  }
}

function activeRegisteredTenantSlugs(rootDir: string): Set<string> {
  const registered = new Set<string>();
  let slugs: string[];
  try {
    slugs = listTenantProfileSlugs({ rootDir });
  } catch {
    return registered;
  }
  for (const slug of slugs) {
    try {
      if (readTenantProfile(slug, { rootDir })?.status === 'active') registered.add(slug);
    } catch {
      // A malformed, unreadable, or unauthorized profile is not a binding
      // authority. Discovery fails closed for that tenant.
    }
  }
  return registered;
}

export function listCustomerChannelBindings(
  options: CustomerChannelBindingListOptions = {}
): Array<ResolvedCustomerBinding & { file: string }> {
  const rootDir = path.resolve(options.rootDir ?? pathResolver.rootDir());
  const customerRootDir = path.join(rootDir, 'customer');
  const results: Array<ResolvedCustomerBinding & { file: string }> = [];
  let safeCustomerRoot: string;
  try {
    safeCustomerRoot = assertSafeRepositoryPath(customerRootDir, { rootDir });
  } catch {
    return results;
  }
  if (!safeExistsSync(safeCustomerRoot)) return results;
  const activeTenants = activeRegisteredTenantSlugs(rootDir);
  let slugs: string[] = [];
  try {
    slugs = safeReaddir(safeCustomerRoot);
  } catch {
    return results;
  }
  for (const slug of slugs) {
    if (!activeTenants.has(slug)) continue;
    const dirPath = path.join(safeCustomerRoot, slug);
    let safeDirPath: string;
    try {
      safeDirPath = assertSafeRepositoryPath(dirPath, { rootDir });
      if (!safeStat(safeDirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const filePath = path.join(safeDirPath, 'connections', 'channel-bindings.json');
    for (const binding of readBindingsFile(filePath, rootDir)) {
      results.push({ tenantSlug: slug, binding, file: filePath });
    }
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
 * CD-11: one tenant's bindings only (`customer/<tenant>/connections/channel-bindings.json`),
 * never a walk over other tenants, and none for a tenant that is not
 * registered and active (fails closed). A file that cannot be read or does
 * not validate is logged and yields no bindings.
 */
export function readTenantCustomerChannelBindings(
  tenantSlug: string,
  options: CustomerChannelBindingListOptions = {}
): CustomerChannelBinding[] {
  if (!isValidTenantSlug(tenantSlug)) return [];
  const rootDir = path.resolve(options.rootDir ?? pathResolver.rootDir());
  // Same rule as the cross-tenant listing: only a registered, active tenant
  // has bindings (a suspended tenant never messages its customers).
  if (!isActiveTenant(tenantSlug, rootDir)) return [];
  const filePath = path.join(
    rootDir,
    'customer',
    tenantSlug,
    'connections',
    'channel-bindings.json'
  );
  return readBindingsFile(filePath, rootDir);
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
