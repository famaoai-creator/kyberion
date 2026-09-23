import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

// Only the loader's own pre-import re-verification goes through this mock;
// plugin-managed-install's internal verification still uses the real digest,
// so authorization passes and the TOCTOU re-check is what must refuse.
vi.mock('./plugin-managed-install.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./plugin-managed-install.js')>();
  return { ...actual, computePluginContentDigest: vi.fn(() => 'f'.repeat(64)) };
});

import { pathResolver } from './path-resolver.js';
import { withExecutionContext } from './authority.js';
import { decideApprovalRequest, loadApprovalRequest } from './approval-store.js';
import { installPluginManaged, refreshManagedPluginActivation } from './plugin-managed-install.js';
import { safeExistsSync, safeMkdir, safeRmSync, safeWriteFile } from './secure-io.js';
import {
  authorizeConfiguredSkillPlugins,
  loadAuthorizedSkillPlugins,
} from './skill-plugin-loader.js';

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

describe('loadAuthorizedSkillPlugins digest re-verification (EP-01)', () => {
  it('refuses to import when the digest changes between authorization and import()', async () => {
    const id = `${process.pid}-${randomUUID()}`;
    const managedRoot = tracked(
      pathResolver.sharedTmp(`skill-plugin-loader-digest-test/managed-${id}`)
    );
    const src = tracked(pathResolver.sharedTmp(`skill-plugin-loader-digest-test/src-${id}`));
    const cwd = tracked(pathResolver.sharedTmp(`skill-plugin-loader-digest-test/cwd-${id}`));
    const markerPath = path.join(src, 'marker.log');
    safeMkdir(src, { recursive: true });
    safeWriteFile(path.join(src, 'plugin-manifest.json'), JSON.stringify({ plugin_id: 'toctou' }));
    safeWriteFile(
      path.join(src, 'index.mjs'),
      [
        `import { writeFileSync } from ${JSON.stringify('node:' + 'fs')};`,
        `writeFileSync(${JSON.stringify(markerPath)}, 'imported');`,
        '',
      ].join('\n')
    );

    const pluginId = `toctou-${id}`.slice(0, 60);
    const record = installPluginManaged({ pluginId, sourcePath: src, managedRoot });
    const pending = loadApprovalRequest(
      record.approvalChannel as string,
      record.approvalRequestId as string
    );
    decideApprovalRequest('mission_controller', {
      channel: record.approvalChannel as string,
      requestId: record.approvalRequestId as string,
      decision: 'approved',
      decidedBy: 'human:operator',
      decidedByType: 'human',
      authenticated: true,
      payloadHash: pending?.accountability?.payloadHash,
      effectBinding: pending?.accountability?.effectBinding,
    });
    expect(refreshManagedPluginActivation(pluginId, managedRoot)?.activationStatus).toBe(
      'activatable'
    );

    safeMkdir(cwd, { recursive: true });
    safeWriteFile(
      path.join(cwd, '.kyberion-plugins.json'),
      JSON.stringify({ plugins: [path.join(record.managedPath, 'index.mjs')] })
    );
    const [authorization] = authorizeConfiguredSkillPlugins(cwd, managedRoot);
    expect(authorization?.allowed).toBe(true);
    expect(authorization?.managedContentDigest).toBe(record.contentDigest);

    const { loaded, diagnostics } = await loadAuthorizedSkillPlugins(cwd, managedRoot, undefined, {
      trustResolved: true,
    });
    expect(loaded).toHaveLength(0);
    expect(diagnostics).toHaveLength(1);
    expect(diagnostics[0]?.allowed).toBe(false);
    expect(diagnostics[0]?.reason).toMatch(/content digest changed since approval/);
    expect(safeExistsSync(markerPath)).toBe(false);
  });
});
