import * as path from 'node:path';
import * as customerResolver from './customer-resolver.js';
import { pathResolver } from './path-resolver.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

export function resolveActiveProfileRoot(): string {
  return customerResolver.customerRoot('') ?? pathResolver.knowledge('personal');
}

/**
 * UX-04 acceptance 5: approval decisions should carry the onboarding
 * identity's name, not a hardcoded 'sovereign-user'. Falls back to the
 * provided default when onboarding has not run (or the file is unreadable).
 */
export function resolveOperatorDisplayName(fallback = 'sovereign-user'): string {
  try {
    const identityPath = path.join(resolveActiveProfileRoot(), 'my-identity.json');
    if (!safeExistsSync(identityPath)) return fallback;
    const parsed = JSON.parse(String(safeReadFile(identityPath, { encoding: 'utf8' }) || '{}'));
    const name = String(parsed?.name || '').trim();
    return name || fallback;
  } catch {
    return fallback;
  }
}
