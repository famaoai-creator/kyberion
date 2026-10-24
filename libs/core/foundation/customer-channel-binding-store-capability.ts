import * as path from 'node:path';
import type { ResourceAccessOperation } from './resource-access-scope.js';

/**
 * Narrow, tenant-bound writer of one tenant's customer channel bindings
 * (`customer/<tenant>/connections/channel-bindings.json`, D8,
 * scripts/customer-channel/bindings.ts `writeBindingChange`). Its policy grant
 * is the bound tenant's `customer/<tenant>/connections/` directory; the tier
 * guard narrows every write and mkdir to {@link customerChannelBindingStorePathAllowed}:
 * the bindings file and the directories leading to it. No other customer/
 * file (connection secrets, overlays), no knowledge or runtime state. It
 * replaces the broad `customer_create` role on that write.
 */
export const CUSTOMER_CHANNEL_BINDING_STORE_ROLE = 'customer_channel_binding_store';

const BINDINGS_FILE = /^customer\/[a-z][a-z0-9-]{1,30}\/connections\/channel-bindings\.json$/u;

/** May the binding store role write / create this repo-relative path? Reads stay with its policy grant. */
export function customerChannelBindingStorePathAllowed(
  relativePath: string,
  operation: ResourceAccessOperation
): boolean {
  if (operation === 'read' || operation === 'metadata') return true;
  if (path.posix.normalize(relativePath) !== relativePath) return false;
  if (operation === 'mkdir') {
    const file = `${relativePath}/channel-bindings.json`;
    const nested = `${relativePath}/connections/channel-bindings.json`;
    return relativePath === 'customer' || BINDINGS_FILE.test(file) || BINDINGS_FILE.test(nested);
  }
  return BINDINGS_FILE.test(relativePath);
}
