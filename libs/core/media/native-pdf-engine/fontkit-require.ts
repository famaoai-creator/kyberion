import { createRequire } from 'node:module';
import { pathResolver } from '../../path-resolver.js';

/**
 * Resolve fontkit for both:
 * - source / `@agent/core` dist (next to this module; works under KYBERION_ROOT fixtures)
 * - inlined CLI bundles (`dist/scripts/cli.js`) that lose the package-local node_modules edge
 */
export function createFontkitRequire(): NodeRequire {
  const candidates: Array<() => NodeRequire> = [
    () => createRequire(import.meta.url),
    () => createRequire(pathResolver.rootResolve('libs/core/package.json')),
  ];
  const errors: Error[] = [];
  for (const make of candidates) {
    try {
      const req = make();
      req.resolve('fontkit');
      return req;
    } catch (error) {
      errors.push(error instanceof Error ? error : new Error(String(error)));
    }
  }
  throw errors[0] ?? new Error('Cannot find module fontkit');
}
