import { describe, expect, it } from 'vitest';
import { safeReadFile } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { loadSurfaceManifest } from '@agent/core/surface/surface-runtime';
import { normalizeSurfaceRuntimeArgs, runSurfaceRuntime } from './surface_runtime.js';

describe('clean-install managed startup documentation', () => {
  const quickstart = String(
    safeReadFile(pathResolver.rootResolve('docs/QUICKSTART.md'), { encoding: 'utf8' })
  );

  it('starts managed surfaces only after install and full build, then verifies readiness', () => {
    const marker = quickstart.indexOf('<!-- kyberion-managed-startup -->');
    expect(marker).toBeGreaterThan(quickstart.indexOf('pnpm install\npnpm build'));
    const startup = quickstart.slice(marker).match(/\x60\x60\x60bash\n([\s\S]*?)\x60\x60\x60/)?.[1];
    expect(startup?.trim().split('\n')).toEqual([
      'set -e',
      'export KYBERION_LOCALHOST_AUTOADMIN=true',
      'pnpm surfaces reconcile',
      'pnpm surfaces status',
      'pnpm kyberion setup report --persona first-time-user',
    ]);
    expect(startup).not.toContain('agent-runtime:supervisor');
    expect(startup).not.toContain('mission:orchestrator');
    expect(startup).not.toContain('chronos:dev');
  });

  it('accepts the documented managed action through the real CLI without starting services', async () => {
    expect(await runSurfaceRuntime(['reconcile', '--dry-run', '--quiet'])).toEqual({
      status: 'dry_run',
      action: 'reconcile',
      surface: null,
    });
    expect(normalizeSurfaceRuntimeArgs(['status'])).toEqual(['--action', 'status']);
  });

  it('advertises registry-backed local defaults and leaves external bridges optional', () => {
    const manifest = loadSurfaceManifest(undefined, { applyOverrides: false });
    for (const id of ['concierge', 'chronos-mirror-v2', 'presence-studio']) {
      const definition = manifest.surfaces.find((surface) => surface.id === id);
      expect(definition?.enabled).toBe(true);
      expect(definition?.healthPath).toBeTruthy();
      expect(quickstart).toContain(`http://127.0.0.1:${definition?.port}`);
    }
    expect(manifest.surfaces.find((surface) => surface.id === 'slack-bridge')?.enabled).toBe(false);
    expect(quickstart).toContain('reconcile\x60 deliberately skips disabled surfaces');
    expect(quickstart).toContain('They are one-shot workers');
  });
});
