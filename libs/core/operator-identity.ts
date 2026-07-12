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

/**
 * UX-03: one place that decides the operator's locale. Precedence:
 * KYBERION_LOCALE env → onboarding identity language (my-identity.json) →
 * the given fallback (ja — the primary operator is Japanese-default).
 */
export function resolveOperatorLocale(fallback: 'ja' | 'en' = 'ja'): 'ja' | 'en' {
  const env = process.env.KYBERION_LOCALE?.trim().toLowerCase();
  if (env === 'ja' || env === 'en') return env;
  try {
    const identityPath = path.join(resolveActiveProfileRoot(), 'my-identity.json');
    if (!safeExistsSync(identityPath)) return fallback;
    const parsed = JSON.parse(String(safeReadFile(identityPath, { encoding: 'utf8' }) || '{}'));
    const language = String(parsed?.language || '')
      .trim()
      .toLowerCase();
    if (language.startsWith('ja') || language.includes('日本')) return 'ja';
    if (language.startsWith('en')) return 'en';
    return fallback;
  } catch {
    return fallback;
  }
}
