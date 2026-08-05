import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeReaddir, safeStat } from '@agent/core/secure-io';

const API_ROOT = pathResolver.rootResolve('presence/displays/chronos-mirror-v2/src/app/api');

function routeFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of safeReaddir(directory)) {
    const fullPath = path.join(directory, entry);
    const stat = safeStat(fullPath);
    if (stat.isDirectory()) {
      files.push(...routeFiles(fullPath));
    } else if (entry === 'route.ts') {
      files.push(fullPath);
    }
  }
  return files;
}

describe('Chronos API viewer contract', () => {
  it('requires a ViewerContext on every API route except the public health probe', () => {
    const routes = routeFiles(API_ROOT);
    expect(routes.length).toBeGreaterThan(1);

    for (const route of routes) {
      const source = String(safeReadFile(route, { encoding: 'utf8' }));
      const routeName = path.relative(API_ROOT, route);
      if (routeName === path.join('healthz', 'route.ts')) {
        expect(source).not.toContain('resolveViewerContextForRequest');
        continue;
      }
      expect(source, routeName).toContain('resolveViewerContextForRequest');
      expect(source, routeName).toMatch(/resolvedViewer\.response/);
    }
  });
});
