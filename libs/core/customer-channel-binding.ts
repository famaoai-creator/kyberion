import * as path from 'node:path';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile, safeReaddir, safeStat } from './secure-io.js';
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
  active?: boolean;
}

export interface ResolvedCustomerBinding {
  tenantSlug: string;
  binding: CustomerChannelBinding;
}

function readBindingsFile(filePath: string): CustomerChannelBinding[] {
  try {
    if (!safeExistsSync(filePath)) return [];
    const parsed = JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string) as {
      bindings?: CustomerChannelBinding[];
    };
    return Array.isArray(parsed?.bindings) ? parsed.bindings : [];
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    logger.warn(`[customer-channel-binding] failed to read ${filePath}: ${message}`);
    return [];
  }
}

export function listCustomerChannelBindings(): Array<ResolvedCustomerBinding & { file: string }> {
  const customerRootDir = pathResolver.rootResolve('customer');
  const results: Array<ResolvedCustomerBinding & { file: string }> = [];
  if (!safeExistsSync(customerRootDir)) return results;
  let slugs: string[] = [];
  try {
    slugs = safeReaddir(customerRootDir);
  } catch {
    return results;
  }
  for (const slug of slugs) {
    if (slug.startsWith('_') || slug.startsWith('.')) continue;
    const dirPath = path.join(customerRootDir, slug);
    try {
      if (!safeStat(dirPath).isDirectory()) continue;
    } catch {
      continue;
    }
    const filePath = path.join(dirPath, 'connections', 'channel-bindings.json');
    for (const binding of readBindingsFile(filePath)) {
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
  channelId: string
): ResolvedCustomerBinding | null {
  const normalizedSurface = String(surface || '').trim();
  const normalizedChannel = String(channelId || '').trim();
  if (!normalizedSurface || !normalizedChannel) return null;
  for (const entry of listCustomerChannelBindings()) {
    if (entry.binding.active === false) continue;
    if (entry.binding.surface !== normalizedSurface) continue;
    if (entry.binding.channel_id !== normalizedChannel) continue;
    return { tenantSlug: entry.tenantSlug, binding: entry.binding };
  }
  return null;
}
