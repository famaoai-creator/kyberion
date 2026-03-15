import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '../libs/core/index.js';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Runtime surface operations contract', () => {
  it('exposes surface lifecycle scripts from package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['surfaces:reconcile']).toBe('node dist/scripts/surface_runtime.js --action reconcile');
    expect(pkg.scripts['surfaces:status']).toBe('node dist/scripts/surface_runtime.js --action status');
  });

  it('includes surface checks in the vital pipeline', () => {
    const vital = JSON.parse(read('pipelines/vital-check.json')) as { steps: Array<{ params?: { message?: string; cmd?: string } }> };
    const rendered = JSON.stringify(vital.steps);
    expect(rendered).toContain('active-surfaces.json');
    expect(rendered).toContain('runtime/surfaces/state.json');
  });

  it('mentions runtime surfaces in the operator dashboard and onboarding next steps', () => {
    const dashboard = read('scripts/sovereign_dashboard.ts');
    const onboarding = read('scripts/onboarding_wizard.ts');
    expect(dashboard).toContain('RUNTIME SURFACES');
    expect(onboarding).toContain('pnpm surfaces:reconcile');
  });

  it('includes troubleshooting diagnostics in surface runtime status', () => {
    const surfaceRuntime = read('scripts/surface_runtime.ts');
    expect(surfaceRuntime).toContain('recentLogTail');
    expect(surfaceRuntime).toContain('diagnostics');
    expect(surfaceRuntime).toContain('lastKnownState');
  });
});
