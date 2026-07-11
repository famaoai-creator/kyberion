import * as path from 'node:path';
import { resolveActiveProfileRoot } from './profile-root.js';
import { safeExistsSync, safeReadFile } from './secure-io.js';

/**
 * UX-04 acceptance 5: approval decisions should carry the onboarding
 * identity's name, not a hardcoded 'sovereign-user'. Falls back to the
 * provided default when onboarding has not run (or the file is unreadable).
 *
 * Lives apart from profile-root so that module keeps its dependency-light
 * mockable shape (its tests stub path-resolver with a minimal surface).
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
