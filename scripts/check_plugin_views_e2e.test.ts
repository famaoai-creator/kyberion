import { describe, expect, it, vi } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { pluginViewFrameResponseHeaders } from '@agent/core/plugin-view-frame';
import { safeReadFile } from '@agent/core/secure-io';
import {
  E2eRun,
  frameHeaderMismatches,
  missingAuditEvidence,
  parseE2eArgs,
  parseLastJsonObject,
  PLUGIN_ID,
  surfaceRuntimeLaunchEnv,
  TENANT_SLUG,
} from './check_plugin_views_e2e.js';

describe('check_plugin_views_e2e helpers (PE-02)', () => {
  it('parses flags with a bounded overall timeout', () => {
    expect(parseE2eArgs([])).toEqual({
      keepRoot: false,
      timeoutMs: 100_000,
      launchModes: ['direct', 'surface-runtime'],
    });
    expect(parseE2eArgs(['--keep-root', '--timeout-ms', '60000'])).toEqual({
      keepRoot: true,
      timeoutMs: 60_000,
      launchModes: ['direct', 'surface-runtime'],
    });
    expect(() => parseE2eArgs(['--timeout-ms', '5'])).toThrow(/--timeout-ms/);
  });

  it('selects one launch mode or both (RA-03)', () => {
    expect(parseE2eArgs(['--launch-mode', 'surface-runtime']).launchModes).toEqual([
      'surface-runtime',
    ]);
    expect(parseE2eArgs(['--launch-mode', 'direct']).launchModes).toEqual(['direct']);
    expect(parseE2eArgs(['--launch-mode', 'both']).launchModes).toEqual([
      'direct',
      'surface-runtime',
    ]);
    expect(() => parseE2eArgs(['--launch-mode', 'docker'])).toThrow(/--launch-mode/);
  });

  it('mirrors the environment surface_runtime gives the Chronos surface', () => {
    const runtimeSource = String(
      safeReadFile(pathResolver.rootResolve('scripts/surface_runtime.ts'), { encoding: 'utf8' })
    );
    expect(runtimeSource).toContain(
      "SYSTEM_ROLE: surfaceId.replace(/-/g, '_'), // Inject role for secure-io"
    );
    expect(runtimeSource).toContain('AUTHORIZED_SCOPE: serviceId,');
    const [manifest] = (
      JSON.parse(
        String(
          safeReadFile(
            pathResolver.rootResolve(
              'knowledge/product/governance/surfaces/chronos-mirror-v2.json'
            ),
            { encoding: 'utf8' }
          )
        )
      ) as { surfaces: Array<{ id: string; service_id?: string; env?: Record<string, string> }> }
    ).surfaces;
    const pkg = JSON.parse(
      String(safeReadFile(pathResolver.rootResolve('package.json'), { encoding: 'utf8' }))
    ) as { scripts: Record<string, string> };
    expect(pkg.scripts.surfaces).toContain('KYBERION_PERSONA=worker SYSTEM_ROLE=surface_runtime');
    expect(manifest.env ?? {}).toEqual({});
    expect(surfaceRuntimeLaunchEnv()).toEqual({
      KYBERION_PERSONA: 'worker',
      AUTHORIZED_SCOPE: manifest.service_id || manifest.id,
      SYSTEM_ROLE: manifest.id.replace(/-/g, '_'),
    });
  });

  it('reads the last JSON object a CLI printed after its logs', () => {
    expect(parseLastJsonObject('[INFO] booting\n{\n  "a": 1\n}\n')).toEqual({ a: 1 });
    expect(parseLastJsonObject('{"b":2}')).toEqual({ b: 2 });
    expect(() => parseLastJsonObject('[1]')).toThrow(/not a JSON object/);
  });

  it('names every frame lockdown header that is missing or different', () => {
    const expected = pluginViewFrameResponseHeaders();
    const served = Object.fromEntries(
      Object.entries(expected).map(([name, value]) => [name.toLowerCase(), value])
    );
    expect(frameHeaderMismatches({ ...served, vary: 'rsc' })).toEqual([]);
    const weakened = { ...served, 'content-security-policy': "default-src 'self'" };
    delete (weakened as Record<string, string>)['x-content-type-options'];
    expect(frameHeaderMismatches(weakened)).toEqual([
      'Content-Security-Policy',
      'X-Content-Type-Options',
    ]);
  });

  it('requires activation, claim, one execution and the refused second execution in the audit chain', () => {
    const id = 'approval-1';
    const complete = [
      {
        action: 'plugin_host.activate',
        result: 'completed',
        operation: PLUGIN_ID,
        tenantSlug: TENANT_SLUG,
      },
      { action: 'plugin_view.action.started', result: 'allowed', correlationId: id },
      { action: 'plugin_view.action.execute', result: 'completed', correlationId: id },
      { action: 'plugin_view.action.execute', result: 'denied', correlationId: id },
    ];
    expect(missingAuditEvidence(complete, id)).toEqual([]);
    expect(missingAuditEvidence(complete.slice(0, 3), id)).toEqual([
      'plugin_view.action.execute denied (second execution)',
    ]);
    // Evidence of another approval does not count.
    expect(missingAuditEvidence(complete, 'approval-2')).toHaveLength(3);
    expect(
      missingAuditEvidence(
        complete.map((entry) => ({ ...entry, tenantSlug: 'other-tenant' })),
        id
      )
    ).toEqual(['plugin_host.activate completed']);
  });

  it('tears down a server or browser that finishes starting after the run was aborted', async () => {
    const fakeServer = () => ({
      baseUrl: 'http://127.0.0.1:1',
      logTail: () => '',
      exited: () => false,
      stop: vi.fn(async () => undefined),
    });
    const run = new E2eRun();
    const kept = fakeServer();
    await expect(run.adoptServer(kept as never)).resolves.toBe(kept);

    run.aborted = true;
    const late = fakeServer();
    await expect(run.adoptServer(late as never)).rejects.toThrow(/aborted/);
    expect(late.stop).toHaveBeenCalledTimes(1);
    const browser = { close: vi.fn(async () => undefined) };
    await expect(run.adoptBrowser(browser as never)).rejects.toThrow(/aborted/);
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(() => run.assertActive()).toThrow(/aborted/);

    await run.teardown();
    await run.teardown();
    expect(kept.stop).toHaveBeenCalled();
  });
});
