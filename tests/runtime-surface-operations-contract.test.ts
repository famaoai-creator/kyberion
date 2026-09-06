import { describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { safeReadFile } from '@agent/core';

const rootDir = process.cwd();

function read(relPath: string): string {
  return safeReadFile(path.join(rootDir, relPath), { encoding: 'utf8' }) as string;
}

describe('Runtime surface operations contract', () => {
  it('exposes one governed surface lifecycle entrypoint from package.json', () => {
    const pkg = JSON.parse(read('package.json')) as { scripts: Record<string, string> };
    expect(pkg.scripts.surfaces).toContain('scripts/run_with_env.ts');
    expect(pkg.scripts.surfaces).toContain('KYBERION_PERSONA=worker');
    expect(pkg.scripts.surfaces).toContain('SYSTEM_ROLE=surface_runtime');
    expect(pkg.scripts.surfaces).toContain('dist/scripts/surface_runtime.js');
    for (const action of ['setup', 'reconcile', 'status', 'repair', 'start', 'stop'])
      expect(pkg.scripts[`surfaces:${action}`]).toBeUndefined();
    expect(pkg.scripts['channels:list']).toBe('node dist/scripts/channel_directory.js');
    // SX-05 (script ratchet, commit a877d9c12) pruned the combined
    // `bootstrap` alias along with the rest of the redundant script surface
    // (package scripts 168 -> <=120); the canonical successor is the
    // documented two-command sequence `pnpm build && pnpm surfaces
    // reconcile` in docs/INITIALIZATION.md / AGENTS.md §3, not a script.
    // The successor is the documented two-command sequence, so the contract
    // is that both halves exist and the onboarding doc still spells it out.
    expect(pkg.scripts.build).toContain('build:packages');
    expect(read('docs/INITIALIZATION.md')).toContain('pnpm surfaces reconcile');
    expect(pkg.scripts.dashboard).toBe('node dist/scripts/sovereign_dashboard.js');
    expect(pkg.scripts['dashboard:onboarding']).toBeUndefined();
  });

  it('includes surface checks in the vital pipeline', () => {
    const vital = JSON.parse(read('pipelines/vital-check.json')) as {
      steps: Array<{ params?: { message?: string; cmd?: string } }>;
    };
    const rendered = JSON.stringify(vital.steps);
    expect(rendered).toContain('active-surfaces.json');
    expect(rendered).toContain('knowledge/product/governance/surfaces');
    expect(rendered).toContain('runtime/surfaces/state.json');
  });

  it('mentions runtime surfaces in the operator dashboard and onboarding next steps', () => {
    const dashboard = read('scripts/sovereign_dashboard.ts');
    const onboarding = read('scripts/onboarding_wizard.ts');
    const operatorGuide = read('docs/OPERATOR_UX_GUIDE.md');
    expect(dashboard).toContain('ONBOARDING HOME');
    expect(dashboard).toContain('Next:');
    expect(dashboard).toContain(
      'Focused view: onboarding setup, connection review, tenant context, starter mission.'
    );
    expect(dashboard).toContain('RUNTIME SURFACES');
    expect(onboarding).toContain('pnpm surfaces reconcile');
    expect(operatorGuide).toContain('discord-bridge');
    expect(operatorGuide).toContain('telegram-bridge');
    expect(operatorGuide).toContain('pnpm surfaces start -- --surface <surface-id>');
  });

  it('includes troubleshooting diagnostics in surface runtime status', () => {
    const surfaceRuntime = read('scripts/surface_runtime.ts');
    const lifecycleModel = read(
      'knowledge/product/architecture/runtime-surface-lifecycle-model.md'
    );
    expect(surfaceRuntime).toContain("from '@agent/core/surface-runtime'");
    expect(surfaceRuntime).toContain('recentLogTail');
    expect(surfaceRuntime).toContain('diagnostics');
    expect(surfaceRuntime).toContain('lastKnownState');
    expect(surfaceRuntime).toContain('repairHint');
    expect(surfaceRuntime).toContain('nextAction');
    expect(surfaceRuntime).toContain("case 'repair'");
    expect(lifecycleModel).toContain('Waited for background terminal');
    expect(lifecycleModel).toContain('active/shared/runtime/surfaces/state.json');
    expect(lifecycleModel).toContain('discord-bridge');
    expect(lifecycleModel).toContain('telegram-bridge');
  });
});
