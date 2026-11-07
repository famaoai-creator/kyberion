import * as path from 'node:path';
import * as stanceResolver from './stance-resolver.js';
import { pathResolver } from './path-resolver.js';

/** Lexical resolution defers stance filesystem checks until the caller authorizes the target. */
export function resolveActiveProfileRoot(options: { lexicalOnly?: boolean } = {}): string {
  if (options.lexicalOnly) {
    const slug = stanceResolver.activeStance();
    return slug
      ? path.join(pathResolver.rootDir(), stanceResolver.STANCES_DIR, slug)
      : pathResolver.knowledge('personal');
  }
  return stanceResolver.stanceRoot('') ?? pathResolver.knowledge('personal');
}
