import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import { safeMkdir, safeRmSync, safeWriteFile } from '@agent/core/secure-io';
import { runPluginInstall } from './plugin_install.js';

const cleanupPaths: string[] = [];
const originalArgv = process.argv;

function tracked(dirPath: string): string {
  cleanupPaths.push(dirPath);
  return dirPath;
}

function sourceDir(name: string): string {
  return tracked(
    pathResolver.sharedTmp(`plugin-install-cli-test/${process.pid}-src-${name}-${randomUUID()}`)
  );
}

function managedRootDir(name: string): string {
  return tracked(
    pathResolver.shared(`plugins/managed-test-cli-${process.pid}-${name}-${randomUUID()}`)
  );
}

afterEach(() => {
  process.argv = originalArgv;
  withExecutionContext('mission_controller', () => {
    while (cleanupPaths.length > 0) {
      const target = cleanupPaths.pop() as string;
      safeRmSync(target);
    }
  });
});

function captureStdout(): { text: () => string; restore: () => void } {
  const original = process.stdout.write.bind(process.stdout);
  let buffer = '';
  process.stdout.write = ((chunk: any) => {
    buffer += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  return {
    text: () => buffer,
    restore: () => {
      process.stdout.write = original;
    },
  };
}

describe('plugin_install CLI', () => {
  it('requires --source and --id', () => {
    process.argv = ['node', 'plugin_install.ts'];
    const exitCode = runPluginInstall();
    expect(exitCode).toBe(1);
  });

  it('stages an official-tree source and reports it as activatable with no approval needed', () => {
    const managedRoot = managedRootDir('official');
    const pluginId = `cli-official-${process.pid}-${randomUUID()}`;
    process.argv = [
      'node',
      'plugin_install.ts',
      '--source',
      pathResolver.rootResolve('plugins/kyberion'),
      '--id',
      pluginId,
      '--managed-root',
      managedRoot,
      '--json',
    ];

    const capture = captureStdout();
    const exitCode = runPluginInstall();
    capture.restore();

    expect(exitCode).toBe(0);
    const record = JSON.parse(capture.text());
    expect(record.trust).toBe('official');
    expect(record.activationStatus).toBe('activatable');
    expect(record.approvalRequestId).toBeUndefined();
  });

  it('stages a third-party source and prints the pending approval id + how to approve it', () => {
    const managedRoot = managedRootDir('third-party');
    const src = sourceDir('third-party');
    safeMkdir(src, { recursive: true });
    safeWriteFile(
      path.join(src, 'plugin-manifest.json'),
      JSON.stringify({ plugin_id: 'cli-sample' })
    );

    const pluginId = `cli-third-party-${process.pid}-${randomUUID()}`;
    process.argv = [
      'node',
      'plugin_install.ts',
      '--source',
      src,
      '--id',
      pluginId,
      '--managed-root',
      managedRoot,
    ];

    const capture = captureStdout();
    const exitCode = runPluginInstall();
    capture.restore();

    expect(exitCode).toBe(0);
    const output = capture.text();
    expect(output).toContain('Trust: third-party');
    expect(output).toContain('Activation status: pending_approval');
    expect(output).toContain('Approval request id:');
    expect(output).toContain('pnpm cli -- approvals');
    expect(output).toMatch(/pnpm cli -- approve \S+ \S+/);
  });

  it('reports a broken manifest as never-activatable and exits non-zero', () => {
    const managedRoot = managedRootDir('broken');
    const src = sourceDir('broken');
    safeMkdir(src, { recursive: true });
    safeWriteFile(path.join(src, 'plugin-manifest.json'), '{ not json');

    const pluginId = `cli-broken-${process.pid}-${randomUUID()}`;
    process.argv = [
      'node',
      'plugin_install.ts',
      '--source',
      src,
      '--id',
      pluginId,
      '--managed-root',
      managedRoot,
    ];

    const capture = captureStdout();
    const exitCode = runPluginInstall();
    capture.restore();

    expect(exitCode).toBe(1);
    expect(capture.text()).toContain('will never be loaded');
  });
});
