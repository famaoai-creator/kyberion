import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeRmSync, safeSymlinkSync } from '../secure-io.js';
import {
  daemonInstanceFromCanonicalRoot,
  resolveDaemonInstance,
  scopeDaemonServiceSpec,
  DAEMON_SPECS,
} from './specs.js';
import { launchdManager } from './launchd.js';
import { systemdUserManager } from './systemd-user.js';
import { windowsTaskSchedulerManager } from './windows-task-scheduler.js';
import type { DaemonRenderContext } from './service-manager.js';

const fixture = pathResolver.sharedTmp(`daemon-instance-test-${process.pid}-${randomUUID()}`);
afterEach(() => safeRmSync(fixture, { recursive: true, force: true }));
describe('checkout daemon identity', () => {
  it('keeps different physical roots distinct and normalizes trailing separators', () => {
    safeMkdir(path.join(fixture, 'physical'), { recursive: true });
    safeMkdir(path.join(fixture, 'other'), { recursive: true });
    const physical = resolveDaemonInstance(path.join(fixture, 'physical'));
    expect(resolveDaemonInstance(path.join(fixture, 'other')).id).not.toBe(physical.id);
    expect(resolveDaemonInstance(path.join(fixture, 'physical') + path.sep)).toEqual(physical);
  });
  it.skipIf(process.platform === 'win32')(
    'resolves actual directory symlink aliases to one identity',
    () => {
      safeMkdir(path.join(fixture, 'physical'), { recursive: true });
      safeSymlinkSync(path.join(fixture, 'physical'), path.join(fixture, 'alias'), 'dir');
      expect(resolveDaemonInstance(path.join(fixture, 'alias'))).toEqual(
        resolveDaemonInstance(path.join(fixture, 'physical'))
      );
    }
  );
  it('normalizes physical Windows path spelling consistently', () => {
    expect(daemonInstanceFromCanonicalRoot('C:\\Checkouts\\Prod\\', 'win32').id).toBe(
      daemonInstanceFromCanonicalRoot('c:/Checkouts/Prod', 'win32').id
    );
    expect(() => daemonInstanceFromCanonicalRoot('../prod')).toThrow(
      'DAEMON_INSTANCE_ROOT_INVALID'
    );
    expect(resolveDaemonInstance('C:\\Alias', () => 'C:\\Checkouts\\Prod', 'win32').id).toBe(
      daemonInstanceFromCanonicalRoot('c:/Checkouts/Prod', 'win32').id
    );
    expect(daemonInstanceFromCanonicalRoot('C:\\Checkouts\\Prod', 'win32').id).not.toBe(
      daemonInstanceFromCanonicalRoot('C:\\Checkouts\\prod', 'win32').id
    );
  });
  it.each([launchdManager, systemdUserManager, windowsTaskSchedulerManager])(
    '$platform keeps installation, logs and every management target separate',
    (manager) => {
      const windows = manager.platform === 'windows-task-scheduler';
      const roots = windows
        ? ['C:\\Repos\\Prod', 'C:\\Repos\\Forcheck']
        : ['/repos/prod', '/repos/forcheck'];
      const instances = roots.map((root) =>
        daemonInstanceFromCanonicalRoot(root, windows ? 'win32' : 'linux')
      );
      const [a, b] = instances.map((instance) =>
        scopeDaemonServiceSpec(DAEMON_SPECS.chronos, instance)
      );
      const context = (repoRoot: string): DaemonRenderContext & { userId: string } => ({
        repoRoot,
        nodePath: windows ? 'C:\\Node\\node.exe' : '/usr/bin/node',
        homeDir: windows ? 'C:\\Users\\Alice' : '/home/alice',
        uid: '501',
        userId: 'Alice',
        stagingDir: windows ? 'C:\\Temp\\units' : '/tmp/units',
        env: { KYBERION_ROOT: 'hostile-other-root' },
      });
      const ca = context(roots[0]),
        cb = context(roots[1]);
      const pa = manager.planInstall(a, ca),
        pb = manager.planInstall(b, cb);
      expect(pa.unitFiles.map((f) => f.targetPath)).not.toEqual(
        pb.unitFiles.map((f) => f.targetPath)
      );
      expect(a.logBaseName).not.toBe(b.logBaseName);
      const contents = pa.unitFiles.map((file) => file.content).join('\n');
      const readable = windows
        ? Buffer.from(contents.match(/-EncodedCommand ([A-Za-z0-9+/=]+)/)![1], 'base64').toString(
            'utf16le'
          )
        : contents;
      expect(readable).toContain('KYBERION_ROOT');
      expect(readable).toContain(roots[0]);
      expect(readable).not.toContain('hostile-other-root');
      for (const verb of ['planStart', 'planStop', 'planRestart', 'planUninstall'] as const) {
        const commands = JSON.stringify(manager[verb](a, ca).commands);
        expect(commands).toContain(instances[0].id);
        expect(commands).not.toContain(instances[1].id);
        expect(manager[verb](a, ca).unitFiles).toEqual([]);
      }
      expect(JSON.stringify(manager.statusCommand(a, ca))).toContain(instances[0].id);
      expect(pa.unitFiles.map((f) => f.content).join('\n')).not.toContain(instances[1].id);
      // The old globally registered unit remains a separate explicit target.
      expect(JSON.stringify(pa.commands)).not.toContain(`/${DAEMON_SPECS.chronos.label}\"`);
    }
  );
});
