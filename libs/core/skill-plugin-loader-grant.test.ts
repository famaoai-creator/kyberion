import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import { installPluginManaged } from './plugin-managed-install.js';
import { resolvePluginExecutionGrant } from './plugin-grant-runtime.js';
import {
  disposeSkillPluginContributions,
  loadAuthorizedSkillPlugins,
} from './skill-plugin-loader.js';

const TENANT = 'grant-override-tenant';

// The tenant override narrows the official ceiling's env to nothing, so the
// approved record grant is strictly narrower than a tenant-less re-narrowing
// of the same manifest.
vi.mock('./plugin-permissions.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plugin-permissions.js')>();
  return {
    ...actual,
    loadPluginPermissionPolicy: (policyPath?: string) => {
      const base = actual.loadPluginPermissionPolicy(policyPath);
      return {
        ...base,
        tenant_overrides: {
          ...base.tenant_overrides,
          [TENANT]: { ceilings: { official: { env: [] } } },
        },
      };
    },
  };
});

const cleanupPaths: string[] = [];

function tracked(dirPath: string): string {
  cleanupPaths.push(dirPath);
  return dirPath;
}

afterEach(() => {
  withExecutionContext('mission_controller', () => {
    while (cleanupPaths.length > 0) safeRmSync(cleanupPaths.pop() as string);
  });
});

describe('official managed installs on the skill path (N3)', () => {
  it('runs under the approved record grant, including tenant narrowing', async () => {
    const managedRoot = tracked(
      pathResolver.shared(`plugins/managed-test-${process.pid}-tenant-grant-${randomUUID()}`)
    );
    const record = installPluginManaged({
      pluginId: `tenant-grant-${process.pid}`,
      sourcePath: pathResolver.rootResolve('plugins/fixtures/plugin-permissions-fixture'),
      managedRoot,
      tenantSlug: TENANT,
    });
    expect(record).toMatchObject({ trust: 'official', activationStatus: 'activatable' });
    expect(record.grantedPermissions?.env).toEqual([]);

    const entry = path.join(record.managedPath, 'index.mjs');
    const resolved = resolvePluginExecutionGrant(
      { pluginId: record.pluginId, sourcePath: entry, trust: 'official' },
      { managedRoot }
    );
    expect(resolved).toMatchObject({ source: 'managed_record', grant: record.grantedPermissions });

    const cwd = tracked(
      pathResolver.sharedTmp(`skill-plugin-loader-grant-test/${process.pid}-${randomUUID()}`)
    );
    safeMkdir(cwd, { recursive: true });
    safeWriteFile(path.join(cwd, '.kyberion-plugins.json'), JSON.stringify({ plugins: [entry] }));
    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, managedRoot, undefined, {
      trustResolved: true,
    });
    try {
      expect(diagnostics).toEqual([]);
      expect(loaded[0]?.grant).toEqual(record.grantedPermissions);
      expect(loaded[0]?.grant?.env).toEqual([]);
    } finally {
      disposeSkillPluginContributions(loaded);
    }
  });
});
