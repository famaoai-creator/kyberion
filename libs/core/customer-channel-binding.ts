import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { readTenantProfile, listTenantProfileSlugs } from './tenant-registry.js';
import { assertSafeRepositoryPath, safeExistsSync, safeReaddir, safeStat } from './secure-io.js';
import { logger } from './core.js';

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
