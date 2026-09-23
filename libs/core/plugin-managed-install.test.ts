import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideApprovalRequest, loadApprovalRequest } from './approval-store.js';
import { withExecutionContext } from './authority.js';
import {
  computePluginContentDigest,
  installPluginManaged,
  isManagedPluginActivationAllowed,
  loadManagedPluginRecordAtPath,
  listManagedPlugins,
  refreshManagedPluginActivation,
} from './plugin-managed-install.js';
import { pathResolver } from './path-resolver.js';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeSymlinkSync,
  safeWriteFile,
} from './secure-io.js';
import { PluginTrustViolationError } from './plugin-source-trust.js';
import { PluginPermissionNarrowedError, permissionsDigest } from './plugin-permissions.js';

const cleanupPaths: string[] = [];

function tracked(dirPath: string): string {
  cleanupPaths.push(dirPath);
  return dirPath;
}

function sourceDir(name: string): string {
  return tracked(
    pathResolver.sharedTmp(
      `plugin-managed-install-test/${process.pid}-source-${name}-${randomUUID()}`
    )
  );
}

function managedRootDir(name: string): string {
  return tracked(
    pathResolver.shared(`plugins/managed-test-${process.pid}-${name}-${randomUUID()}`)
  );
}

afterEach(() => {
  // Managed-plugin paths are only writable under the same authority role the
  // installer itself uses; test cleanup needs the same wrapper.
  withExecutionContext('mission_controller', () => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop() as string;
      safeRmSync(target);
    }
  });
});

function writeManifest(dir: string, manifest: Record<string, unknown>): void {
  safeMkdir(dir, { recursive: true });
  safeWriteFile(path.join(dir, 'plugin-manifest.json'), JSON.stringify(manifest));
}

function writePortableManifest(dir: string, manifest: Record<string, unknown>): void {
  safeMkdir(dir, { recursive: true });
  safeWriteFile(path.join(dir, 'plugin.json'), JSON.stringify(manifest));
}

describe('installPluginManaged', () => {
  it('labels a real plugins/ source as official and activatable without approval', () => {
    const managedRoot = managedRootDir('official');
    const officialSample = pathResolver.rootResolve('plugins/kyberion');

    const record = installPluginManaged({
      pluginId: `official-copy-${process.pid}`,
      sourcePath: officialSample,
      managedRoot,
    });

    expect(record.trust).toBe('official');
    expect(record.activationStatus).toBe('activatable');
    expect(record.approvalRequestId).toBeUndefined();
    expect(isManagedPluginActivationAllowed(record)).toBe(true);

    const listed = listManagedPlugins(managedRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.trust).toBe('official');
  });

  it('loads the portable root manifest from an official repo package', () => {
    const managedRoot = managedRootDir('official-portable');
    const officialSample = pathResolver.rootResolve('plugins/kyberion-agent-plugin');

    const record = installPluginManaged({
      pluginId: `official-portable-${process.pid}`,
      sourcePath: officialSample,
      managedRoot,
    });

    expect(record.manifest?.pluginId).toBe('kyberion-agent-plugin');
    expect(record.trust).toBe('official');
    expect(record.activationStatus).toBe('activatable');
    expect(record.diagnostics).toEqual([]);
  });

  it('labels identical manifest content sourced outside plugins/ as third-party, blocked until approved', () => {
    const managedRoot = managedRootDir('third-party');
    const src = sourceDir('same-content');
    // Same content as an official manifest could produce, including a
    // self-declared (and irrelevant) trust field.
    writeManifest(src, { plugin_id: 'third-party-sample', trust: 'official', version: '1.0.0' });

    const pluginId = `third-party-${process.pid}`;
    const record = installPluginManaged({
      pluginId,
      sourcePath: src,
      managedRoot,
      requestedBy: 'test-suite',
    });

    expect(record.trust).toBe('third-party');
    expect(record.activationStatus).toBe('pending_approval');
    expect(record.approvalRequestId).toBeDefined();
    expect(isManagedPluginActivationAllowed(record)).toBe(false);

    // Cancel-default: with no decision yet, the request is still pending.
    const pending = loadApprovalRequest(
      record.approvalChannel as string,
      record.approvalRequestId as string
    );
    expect(pending?.status).toBe('pending');

    // A human approves the exact bound effect...
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

    // ...and only then does the plugin become activatable.
    const refreshed = refreshManagedPluginActivation(pluginId, managedRoot);
    expect(refreshed?.activationStatus).toBe('activatable');
    expect(isManagedPluginActivationAllowed(refreshed!)).toBe(true);
  });

  it('discovers an Agent Plugins v1 root manifest without weakening provenance gating', () => {
    const managedRoot = managedRootDir('portable-manifest');
    const src = sourceDir('portable-manifest');
    writePortableManifest(src, {
      $schema: 'https://agent-plugins.org/knowledge/product/schemas/1.0.0/plugin.schema.json',
      name: 'portable-sample',
      version: '1.0.0',
    });

    const record = installPluginManaged({
      pluginId: `portable-${process.pid}`,
      sourcePath: src,
      managedRoot,
      requestedBy: 'test-suite',
    });

    expect(record.manifest?.pluginId).toBe('portable-sample');
    expect(record.diagnostics).toEqual([]);
    expect(record.trust).toBe('third-party');
    expect(record.activationStatus).toBe('pending_approval');
  });

  it('rejects an install whose asset symlinks outside the plugin root', () => {
    const managedRoot = managedRootDir('escape');
    const outside = sourceDir('escape-outside');
    safeMkdir(outside, { recursive: true });
    safeWriteFile(path.join(outside, 'secret.txt'), 'do-not-leak');

    const src = sourceDir('escape-plugin');
    writeManifest(src, { plugin_id: 'escaping-plugin' });
    safeSymlinkSync(path.join(outside, 'secret.txt'), path.join(src, 'escape-link.txt'));

    expect(() =>
      installPluginManaged({
        pluginId: `escaping-${process.pid}`,
        sourcePath: src,
        managedRoot,
      })
    ).toThrow(PluginTrustViolationError);

    // Nothing should have landed in the managed directory.
    expect(listManagedPlugins(managedRoot)).toHaveLength(0);
  });

  it('lists a broken manifest as a diagnostic entry that is never executed and never activatable', () => {
    const managedRoot = managedRootDir('broken');
    const src = sourceDir('broken-manifest');
    safeMkdir(src, { recursive: true });
    // Deliberately not valid JSON — and even if it were, plugin code (a .js
    // payload) must never be required/executed by the installer or listing.
    safeWriteFile(path.join(src, 'plugin-manifest.json'), '{ this is not json');
    safeWriteFile(
      path.join(src, 'index.js'),
      "throw new Error('this must never run during install or listing');"
    );

    const pluginId = `broken-${process.pid}`;
    const record = installPluginManaged({ pluginId, sourcePath: src, managedRoot });

    expect(record.manifest).toBeNull();
    expect(record.diagnostics.some((d) => d.severity === 'error')).toBe(true);
    expect(record.activationStatus).toBe('blocked_broken_manifest');
    expect(isManagedPluginActivationAllowed(record)).toBe(false);

    const listed = listManagedPlugins(managedRoot);
    expect(listed).toHaveLength(1);
    expect(listed[0]?.pluginId).toBe(pluginId);
    expect(listed[0]?.activationStatus).toBe('blocked_broken_manifest');
    expect(listed[0]?.diagnostics.length).toBeGreaterThan(0);
  });

  it('does not trust a tampered official activation record', () => {
    const managedRoot = managedRootDir('tampered-record');
    const src = sourceDir('tampered-record');
    writeManifest(src, { plugin_id: 'tampered-record' });
    const pluginId = `tampered-record-${process.pid}`;
    const record = installPluginManaged({
      pluginId,
      sourcePath: src,
      managedRoot,
      requestedBy: 'test-suite',
    });

    withExecutionContext('mission_controller', () =>
      safeWriteFile(
        path.join(record.managedPath, '.kyberion-managed-plugin.json'),
        JSON.stringify({
          ...record,
          trust: 'official',
          trustReason: 'forged',
          activationStatus: 'activatable',
        })
      )
    );

    const listed = listManagedPlugins(managedRoot);
    expect(listed[0]?.trust).toBe('third-party');
    expect(listed[0]?.activationStatus).toBe('pending_approval');
    expect(isManagedPluginActivationAllowed(listed[0]!)).toBe(false);
  });

  it('rejects a managed record path that is not a regular file', () => {
    const managedRoot = managedRootDir('record-directory');
    const src = sourceDir('record-directory');
    writeManifest(src, { plugin_id: 'record-directory' });
    const record = installPluginManaged({
      pluginId: `record-directory-${process.pid}`,
      sourcePath: src,
      managedRoot,
      requestedBy: 'test-suite',
    });

    withExecutionContext('mission_controller', () => {
      safeRmSync(path.join(record.managedPath, '.kyberion-managed-plugin.json'));
      safeMkdir(path.join(record.managedPath, '.kyberion-managed-plugin.json'));
    });

    expect(() =>
      loadManagedPluginRecordAtPath(
        path.join(record.managedPath, '.kyberion-managed-plugin.json'),
        record.managedPath
      )
    ).toThrow('managed plugin record must be a regular file');
  });

  it('blocks a manifest containing a dangerous JSON key', () => {
    const managedRoot = managedRootDir('dangerous-manifest');
    const src = sourceDir('dangerous-manifest');
    safeMkdir(src, { recursive: true });
    safeWriteFile(
      path.join(src, 'plugin-manifest.json'),
      '{"plugin_id":"dangerous-manifest","__proto__":{"trust":"official"}}'
    );

    const record = installPluginManaged({
      pluginId: `dangerous-manifest-${process.pid}`,
      sourcePath: src,
      managedRoot,
    });
    expect(record.manifest).toBeNull();
    expect(record.activationStatus).toBe('blocked_broken_manifest');
    expect(isManagedPluginActivationAllowed(record)).toBe(false);
  });

  it('does not treat a manifest directory as readable JSON', () => {
    const managedRoot = managedRootDir('manifest-directory');
    const src = sourceDir('manifest-directory');
    safeMkdir(path.join(src, 'plugin-manifest.json'), { recursive: true });

    const record = installPluginManaged({
      pluginId: `manifest-directory-${process.pid}`,
      sourcePath: src,
      managedRoot,
    });
    expect(record.manifest).toBeNull();
    expect(record.activationStatus).toBe('blocked_broken_manifest');
  });
});

const RECORD_FILE = '.kyberion-managed-plugin.json';

function approve(record: { approvalChannel?: string; approvalRequestId?: string }): void {
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
}

function readRecordJson(managedPath: string): Record<string, unknown> {
  return JSON.parse(
    String(safeReadFile(path.join(managedPath, RECORD_FILE), { encoding: 'utf8' }))
  );
}

function rewriteRecord(managedPath: string, value: Record<string, unknown>): void {
  withExecutionContext('mission_controller', () =>
    safeWriteFile(path.join(managedPath, RECORD_FILE), JSON.stringify(value, null, 2))
  );
}

/** Installs + approves a third-party plugin declaring fs readonly on the public tier. */
function installApprovedThirdParty(name: string) {
  const managedRoot = managedRootDir(name);
  const src = sourceDir(name);
  writeManifest(src, {
    plugin_id: `${name}-sample`,
    version: '1.0.0',
    permissions: { fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: 'docs' }] } },
  });
  safeWriteFile(path.join(src, 'index.mjs'), 'export const value = 1;\n');
  const pluginId = `${name}-${process.pid}`;
  const record = installPluginManaged({
    pluginId,
    sourcePath: src,
    managedRoot,
    requestedBy: 'test-suite',
  });
  approve(record);
  const refreshed = refreshManagedPluginActivation(pluginId, managedRoot);
  expect(refreshed?.activationStatus).toBe('activatable');
  return { managedRoot, pluginId, record: refreshed! };
}

describe('EP-01 content digest binding', () => {
  it('computes a stable digest that excludes the managed record and tracks content and paths', () => {
    const dir = sourceDir('digest');
    safeMkdir(path.join(dir, 'lib'), { recursive: true });
    safeWriteFile(path.join(dir, 'a.txt'), 'alpha');
    safeWriteFile(path.join(dir, 'lib', 'b.txt'), 'beta');
    const first = computePluginContentDigest(dir);
    expect(first).toMatch(/^[a-f0-9]{64}$/);

    safeWriteFile(path.join(dir, RECORD_FILE), '{"ignored":true}');
    expect(computePluginContentDigest(dir)).toBe(first);

    safeWriteFile(path.join(dir, 'lib', 'b.txt'), 'betA');
    const changed = computePluginContentDigest(dir);
    expect(changed).not.toBe(first);

    safeWriteFile(path.join(dir, 'lib', 'b.txt'), 'beta');
    safeRmSync(path.join(dir, 'a.txt'));
    safeWriteFile(path.join(dir, 'a2.txt'), 'alpha');
    expect(computePluginContentDigest(dir)).not.toBe(first);
  });

  it('rejects symlinks inside the digested tree', () => {
    const dir = sourceDir('digest-symlink');
    safeMkdir(dir, { recursive: true });
    safeWriteFile(path.join(dir, 'real.txt'), 'x');
    safeSymlinkSync(path.join(dir, 'real.txt'), path.join(dir, 'link.txt'));
    expect(() => computePluginContentDigest(dir)).toThrow('symlink');
  });

  it('records digest, version and narrowed grant, and binds them into the approval', () => {
    const managedRoot = managedRootDir('binding');
    const src = sourceDir('binding');
    writeManifest(src, {
      plugin_id: 'binding-sample',
      version: '2.1.0',
      permissions: {
        fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: 'docs' }] },
        env: ['HOME'],
      },
    });
    const previews: unknown[] = [];
    let managedExistedAtPreview = true;
    const pluginId = `binding-${process.pid}`;
    const record = installPluginManaged({
      pluginId,
      sourcePath: src,
      managedRoot,
      onPermissionsResolved: (preview) => {
        previews.push(preview);
        managedExistedAtPreview = safeExistsSync(path.join(managedRoot, pluginId));
      },
    });

    expect(previews).toHaveLength(1);
    expect(managedExistedAtPreview).toBe(false);
    expect(record.contentDigest).toBe(computePluginContentDigest(record.managedPath));
    expect(record.manifestVersion).toBe('2.1.0');
    expect(record.grantedPermissions).toEqual({
      network: { mode: 'none', hosts: [] },
      fs: { mode: 'readonly', paths: [{ tier: 'public', prefix: 'docs' }] },
      ops_invoke: [],
      env: [],
      secrets: [],
    });
    expect(record.permissionsDigest).toBe(permissionsDigest(record.grantedPermissions!));

    const approval = loadApprovalRequest(
      record.approvalChannel as string,
      record.approvalRequestId as string
    );
    expect(approval?.status).toBe('pending');
    expect(approval?.summary).toContain(
      'fs=readonly [public:docs] (requested readwrite [public:docs])'
    );
    expect(approval?.details).toContain(record.contentDigest);
    expect(readRecordJson(record.managedPath).contentDigest).toBe(record.contentDigest);
  });

  it('blocks an approved plugin whose managed copy changes by one byte', () => {
    const { managedRoot, pluginId, record } = installApprovedThirdParty('tamper-byte');
    withExecutionContext('mission_controller', () =>
      safeWriteFile(path.join(record.managedPath, 'index.mjs'), 'export const value = 2;\n')
    );

    const listed = listManagedPlugins(managedRoot);
    expect(listed[0]?.activationStatus).toBe('blocked_digest_mismatch');
    expect(isManagedPluginActivationAllowed(listed[0]!)).toBe(false);

    const refreshed = refreshManagedPluginActivation(pluginId, managedRoot);
    expect(refreshed?.activationStatus).toBe('blocked_digest_mismatch');
    expect(readRecordJson(record.managedPath).activationStatus).toBe('blocked_digest_mismatch');
  });

  it('blocks when the manifest version changes (on disk or in the record)', () => {
    const { managedRoot, record } = installApprovedThirdParty('tamper-version');
    const original = readRecordJson(record.managedPath);
    rewriteRecord(record.managedPath, { ...original, manifestVersion: '9.9.9' });
    expect(listManagedPlugins(managedRoot)[0]?.activationStatus).toBe('blocked_digest_mismatch');

    rewriteRecord(record.managedPath, original);
    expect(listManagedPlugins(managedRoot)[0]?.activationStatus).toBe('activatable');

    const manifestPath = path.join(record.managedPath, 'plugin-manifest.json');
    const manifest = JSON.parse(String(safeReadFile(manifestPath, { encoding: 'utf8' })));
    withExecutionContext('mission_controller', () =>
      safeWriteFile(manifestPath, JSON.stringify({ ...manifest, version: '1.0.1' }))
    );
    expect(listManagedPlugins(managedRoot)[0]?.activationStatus).toBe('blocked_digest_mismatch');
  });

  it('blocks when the recorded permission grant is widened', () => {
    const { managedRoot, record } = installApprovedThirdParty('tamper-permissions');
    const original = readRecordJson(record.managedPath);
    const widened = {
      ...(record.grantedPermissions as object),
      fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: '' }] },
    };
    // Digest left stale.
    rewriteRecord(record.managedPath, { ...original, grantedPermissions: widened });
    expect(listManagedPlugins(managedRoot)[0]?.activationStatus).toBe('blocked_digest_mismatch');

    // Digest recomputed to match the forged grant: still blocked (re-derived from manifest + policy).
    rewriteRecord(record.managedPath, {
      ...original,
      grantedPermissions: widened,
      permissionsDigest: permissionsDigest(widened as never),
    });
    expect(listManagedPlugins(managedRoot)[0]?.activationStatus).toBe('blocked_digest_mismatch');
  });

  it('treats a legacy record without a content digest as pending re-approval', () => {
    const { managedRoot, pluginId, record } = installApprovedThirdParty('legacy');
    const {
      contentDigest: _contentDigest,
      manifestVersion: _manifestVersion,
      grantedPermissions: _grantedPermissions,
      permissionsDigest: _permissionsDigest,
      ...legacy
    } = readRecordJson(record.managedPath);
    rewriteRecord(record.managedPath, { ...legacy, activationStatus: 'activatable' });

    const listed = listManagedPlugins(managedRoot);
    expect(listed[0]?.contentDigest).toBeUndefined();
    expect(listed[0]?.activationStatus).toBe('pending_approval');
    expect(refreshManagedPluginActivation(pluginId, managedRoot)?.activationStatus).toBe(
      'pending_approval'
    );
  });

  it('rejects a record with a partial integrity binding', () => {
    const { managedRoot, record } = installApprovedThirdParty('partial-binding');
    const { permissionsDigest: _permissionsDigest, ...partial } = readRecordJson(
      record.managedPath
    );
    rewriteRecord(record.managedPath, partial);
    // Unreadable record degrades to a hand-placed, non-activatable entry.
    const listed = listManagedPlugins(managedRoot);
    expect(listed[0]?.activationStatus).not.toBe('activatable');
  });

  it('records a digest for official sources without requiring approval', () => {
    const managedRoot = managedRootDir('official-digest');
    const record = installPluginManaged({
      pluginId: `official-digest-${process.pid}`,
      sourcePath: pathResolver.rootResolve('plugins/kyberion'),
      managedRoot,
    });
    expect(record.contentDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(record.approvalRequestId).toBeUndefined();
    expect(record.activationStatus).toBe('activatable');
    // The Cowork v1 descriptive permissions block is not an EP-02 declaration.
    expect(record.grantedPermissions?.fs.mode).toBe('none');
    expect(record.diagnostics.map((d) => d.code)).toContain('manifest_legacy_permissions_ignored');
    expect(listManagedPlugins(managedRoot)[0]?.activationStatus).toBe('activatable');
  });
});

describe('EP-02 install-time narrowing', () => {
  it('aborts without staging anything when a critical capability narrows to nothing', () => {
    const managedRoot = managedRootDir('narrowed');
    const src = sourceDir('narrowed');
    writeManifest(src, {
      plugin_id: 'narrowed-sample',
      permissions: { network: { mode: 'allowlist', hosts: ['api.example.com'] } },
    });
    let resolvedCalls = 0;
    expect(() =>
      installPluginManaged({
        pluginId: `narrowed-${process.pid}`,
        sourcePath: src,
        managedRoot,
        onPermissionsResolved: () => {
          resolvedCalls += 1;
        },
      })
    ).toThrow(PluginPermissionNarrowedError);
    expect(resolvedCalls).toBe(0);
    expect(listManagedPlugins(managedRoot)).toHaveLength(0);
  });

  it('treats a malformed permissions declaration as a broken manifest', () => {
    const managedRoot = managedRootDir('bad-permissions');
    const src = sourceDir('bad-permissions');
    writeManifest(src, {
      plugin_id: 'bad-permissions',
      permissions: { network: { mode: 'any' } },
    });
    const record = installPluginManaged({
      pluginId: `bad-permissions-${process.pid}`,
      sourcePath: src,
      managedRoot,
    });
    expect(record.activationStatus).toBe('blocked_broken_manifest');
    expect(record.approvalRequestId).toBeUndefined();
    expect(record.diagnostics.map((d) => d.code)).toContain('manifest_invalid_permissions');
  });

  it('rejects an invalid tenant slug', () => {
    const src = sourceDir('bad-tenant');
    writeManifest(src, { plugin_id: 'bad-tenant' });
    expect(() =>
      installPluginManaged({
        pluginId: `bad-tenant-${process.pid}`,
        sourcePath: src,
        managedRoot: managedRootDir('bad-tenant'),
        tenantSlug: 'public',
      })
    ).toThrow('Invalid tenant slug');
  });
});
