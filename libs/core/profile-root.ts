import * as path from 'node:path';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';

/** Lexical resolution defers customer filesystem checks until the caller authorizes the target. */
export function resolveActiveProfileRoot(options: { lexicalOnly?: boolean } = {}): string {
  if (options.lexicalOnly) {
    const slug = customerResolver.activeCustomer();
    return slug
      ? path.join(pathResolver.rootDir(), 'customer', slug)
      : pathResolver.knowledge('personal');
  }
  return customerResolver.customerRoot('') ?? pathResolver.knowledge('personal');
}
