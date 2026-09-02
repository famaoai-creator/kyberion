import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideApprovalRequest, loadApprovalRequest } from './approval-store.js';
import { withExecutionContext } from './authority.js';
import {
  installPluginManaged,
  isManagedPluginActivationAllowed,
  loadManagedPluginRecordAtPath,
  listManagedPlugins,
  refreshManagedPluginActivation,
} from './plugin-managed-install.js';
import { pathResolver } from './path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync, safeWriteFile } from './secure-io.js';
import { PluginTrustViolationError } from './plugin-source-trust.js';

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
});
