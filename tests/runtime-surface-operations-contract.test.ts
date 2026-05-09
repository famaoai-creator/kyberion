import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Runtime surface operations contract', () => {
  it('exposes surface lifecycle scripts from package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts['surfaces:reconcile']).toBe('node dist/scripts/surface_runtime.js --action reconcile');
    expect(pkg.scripts['surfaces:status']).toBe('node dist/scripts/surface_runtime.js --action status');
    expect(pkg.scripts.bootstrap).toBe('pnpm build && node dist/scripts/surface_runtime.js --action reconcile');
    expect(pkg.scripts['dashboard:onboarding']).toBe('node dist/scripts/sovereign_dashboard.js --once --focus onboarding');
  });

  it('includes surface checks in the vital pipeline', () => {
    const vital = JSON.parse(read('pipelines/vital-check.json')) as { steps: Array<{ params?: { message?: string; cmd?: string } }> };
    const rendered = JSON.stringify(vital.steps);
    expect(rendered).toContain('active-surfaces.json');
    expect(rendered).toContain('knowledge/public/governance/surfaces');
    expect(rendered).toContain('runtime/surfaces/state.json');
  });

  it('mentions runtime surfaces in the operator dashboard and onboarding next steps', () => {
    const dashboard = read('scripts/sovereign_dashboard.ts');
    const onboarding = read('scripts/onboarding_wizard.ts');
    const operatorGuide = read('docs/OPERATOR_UX_GUIDE.md');
    expect(dashboard).toContain('ONBOARDING HOME');
    expect(dashboard).toContain('Next:');
    expect(dashboard).toContain('Focused view: onboarding setup, connection review, tenant context, starter mission.');
    expect(dashboard).toContain('RUNTIME SURFACES');
    expect(onboarding).toContain('pnpm surfaces:reconcile');
    expect(operatorGuide).toContain('discord-bridge');
    expect(operatorGuide).toContain('telegram-bridge');
    expect(operatorGuide).toContain('pnpm surfaces:start -- --surface <surface-id>');
  });

  it('includes troubleshooting diagnostics in surface runtime status', () => {
    const surfaceRuntime = read('scripts/surface_runtime.ts');
    const lifecycleModel = read('knowledge/public/architecture/runtime-surface-lifecycle-model.md');
    expect(surfaceRuntime).toContain("from '@agent/core'");
    expect(surfaceRuntime).toContain('recentLogTail');
    expect(surfaceRuntime).toContain('diagnostics');
    expect(surfaceRuntime).toContain('lastKnownState');
    expect(lifecycleModel).toContain('Waited for background terminal');
    expect(lifecycleModel).toContain('active/shared/runtime/surfaces/state.json');
    expect(lifecycleModel).toContain('discord-bridge');
    expect(lifecycleModel).toContain('telegram-bridge');
  });
});
