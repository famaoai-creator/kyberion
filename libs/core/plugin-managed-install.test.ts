import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decideApprovalRequest, loadApprovalRequest } from './approval-store.js';
import { withExecutionContext } from './authority.js';
import {
  installPluginManaged,
  isManagedPluginActivationAllowed,
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
});
