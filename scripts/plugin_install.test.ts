import { randomUUID } from 'node:crypto';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { pathResolver } from '@agent/core/path-resolver';
import { withExecutionContext } from '@agent/core/authority';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeRmSync,
  safeWriteFile,
} from '@agent/core/secure-io';
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

function runWithProcessArgs(print: (value: unknown) => void = () => undefined): number {
  return runPluginInstall(process.argv.slice(2), print);
}

describe('plugin_install CLI', () => {
  it('requires --source and --id', () => {
    process.argv = ['node', 'plugin_install.ts'];
    const exitCode = runWithProcessArgs();
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

    const output: string[] = [];
    const exitCode = runWithProcessArgs((value) => output.push(String(value)));

    expect(exitCode).toBe(0);
    const record = JSON.parse(output.join(''));
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

    const output: string[] = [];
    const exitCode = runWithProcessArgs((value) => output.push(String(value)));

    expect(exitCode).toBe(0);
    const rendered = output.join('\n');
    expect(rendered).toContain('Trust: third-party');
    expect(rendered).toContain('Activation status: pending_approval');
    expect(rendered).toContain('Approval request id:');
    expect(rendered).toContain('pnpm kyberion approvals');
    expect(rendered).toMatch(/pnpm kyberion approve \S+ \S+/);
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

    const output: string[] = [];
    const exitCode = runWithProcessArgs((value) => output.push(String(value)));

    expect(exitCode).toBe(1);
    expect(output.join('\n')).toContain('will never be loaded');
  });

  it('prints the requested/ceiling/granted permission table before the approval request', () => {
    const managedRoot = managedRootDir('permissions');
    const src = sourceDir('permissions');
    safeMkdir(src, { recursive: true });
    safeWriteFile(
      path.join(src, 'plugin-manifest.json'),
      JSON.stringify({
        plugin_id: 'cli-permissions',
        permissions: {
          fs: { mode: 'readwrite', paths: [{ tier: 'public', prefix: 'docs' }] },
          env: ['HOME'],
        },
      })
    );
    process.argv = [
      'node',
      'plugin_install.ts',
      '--source',
      src,
      '--id',
      `cli-permissions-${process.pid}-${randomUUID()}`,
      '--managed-root',
      managedRoot,
    ];

    const output: string[] = [];
    const exitCode = runWithProcessArgs((value) => output.push(String(value)));

    expect(exitCode).toBe(0);
    const rendered = output.join('\n');
    expect(rendered).toMatch(/capability\s+\| requested\s+\| ceiling\s+\| granted\s+\| narrowed/);
    expect(rendered).toMatch(
      /fs\s+\| readwrite \[public:docs\]\s+\| readonly \[public:\*\]\s+\| readonly \[public:docs\]\s+\| yes/
    );
    expect(rendered).toMatch(/env\s+\| HOME\s+\| none\s+\| none\s+\| yes/);
    expect(rendered.indexOf('capability')).toBeLessThan(rendered.indexOf('Approval request id:'));
    expect(rendered).toMatch(/Content digest: [a-f0-9]{64}/);
  });

  it('exits non-zero with the required elevation and installs nothing when a critical capability narrows to nothing', () => {
    const managedRoot = managedRootDir('narrowed');
    const src = sourceDir('narrowed');
    safeMkdir(src, { recursive: true });
    safeWriteFile(
      path.join(src, 'plugin-manifest.json'),
      JSON.stringify({
        plugin_id: 'cli-narrowed',
        permissions: { network: { mode: 'allowlist', hosts: ['api.example.com'] } },
      })
    );
    process.argv = [
      'node',
      'plugin_install.ts',
      '--source',
      src,
      '--id',
      `cli-narrowed-${process.pid}-${randomUUID()}`,
      '--managed-root',
      managedRoot,
    ];

    const output: string[] = [];
    const exitCode = runWithProcessArgs((value) => output.push(String(value)));

    expect(exitCode).toBe(1);
    const rendered = output.join('\n');
    expect(rendered).toContain('no approval was requested');
    expect(rendered).toContain(
      "Required elevation: trust level 'third-party' must be allowed network"
    );
    expect(rendered).not.toContain('Approval request id:');
    expect(safeExistsSync(managedRoot)).toBe(false);
  });

  it('connects the plugin CLI to the shared script printer', () => {
    const source = String(
      safeReadFile(pathResolver.rootResolve('scripts/plugin_install.ts'), { encoding: 'utf8' }) ||
        ''
    );

    expect(source).not.toContain('process.stdout.write');
    expect(source).not.toContain('console.log');
    expect(source).not.toContain('console.error');
    expect(source).toContain('runPluginInstall(context.argv, context.print)');
  });
});
