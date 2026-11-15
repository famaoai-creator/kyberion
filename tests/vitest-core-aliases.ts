import fs from 'node:fs';
import path from 'node:path';

/**
 * Public core subpaths can remain stable when their implementation moves:
 * `libs/core/package.json` `exports` maps each public name onto its dist
 * target. Mirror those targets onto the source `.ts` files ahead of any
 * naive directory fallback, so every vitest config resolves `@agent/core/*`
 * the way the compiled workspace package does. Keep this shared — a config
 * that derives its own mapping will drift from the exports map (e.g. a flat
 * `./mission-lookup` export whose source lives under `mission/`).
 */
export function coreSourceAliases(rootDir: string): Array<{ find: RegExp; replacement: string }> {
  const manifest = JSON.parse(
    fs.readFileSync(path.join(rootDir, 'libs/core/package.json'), 'utf8')
  ) as { exports?: Record<string, { types?: string }> };
  return Object.entries(manifest.exports ?? {}).flatMap(([subpath, target]) => {
    if (!subpath.startsWith('./') || !target.types?.startsWith('./dist/')) return [];
    if (!target.types.endsWith('.d.ts')) return [];
    const name = subpath.slice(2);
    const source = target.types.slice('./dist/'.length).replace(/\.d\.ts$/u, '');
    if (source === name || source === `${name}/index`) return [];
    const publicPath = `@agent/core/${name}`.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return [
      {
        find: new RegExp(`^${publicPath}$`),
        replacement: path.join(rootDir, 'libs/core', `${source}.ts`),
      },
    ];
  });
}
