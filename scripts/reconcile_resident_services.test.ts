import { afterEach, describe, expect, it } from 'vitest';
import * as path from 'node:path';
import { pathResolver } from '@agent/core/path-resolver';
import { safeReadFile, safeRmSync } from '@agent/core/secure-io';
import { readJsonIfPresent } from '@agent/core/foundation';
import { buildLaunchdPlist } from '@agent/core/daemon/launchd';
import { resolveDaemonInstance } from '@agent/core/daemon/specs';
import type { DaemonManager, DaemonRenderContext } from '@agent/core/daemon/service-manager';
import type { ResidentServicesState } from '@agent/core/daemon/resident-services';
import {
  formatReconcileReport,
  main,
  reconcileResidentServices,
  type ReconcileDeps,
} from './reconcile_resident_services.js';

const WORK = pathResolver.sharedTmp(`reconcile-resident-services-test-${process.pid}`);
const HOME = '/Users/op';
const AGENTS = `${HOME}/Library/LaunchAgents`;
const instance = resolveDaemonInstance(pathResolver.rootDir());

afterEach(() => safeRmSync(WORK, { recursive: true, force: true }));

/** An in-memory launchd: cp/rm move unit text, bootstrap/bootout toggle load state. */
function fakeHost(initial: Record<string, string> = {}) {
  const files: Record<string, string> = { ...initial };
  const loaded = new Set<string>();
  const calls: string[] = [];
  const deps: ReconcileDeps = {
    platform: 'darwin',
    homeDir: HOME,
    uid: '501',
    statePath: path.join(WORK, 'state/resident-services.json'),
    renderContext: (_manager: DaemonManager, env: Record<string, string>): DaemonRenderContext => ({
      nodePath: '/opt/homebrew/opt/node/bin/node',
      repoRoot: instance.repoRoot,
      homeDir: HOME,
      uid: '501',
      stagingDir: path.join(WORK, 'staging'),
      userPath: ['/opt/homebrew/bin'],
      env,
    }),
    enabledSurfaces: () => new Set(),
    syncSchedules: async ({ dryRun }) => ({
      added: dryRun ? 0 : 1,
      updated: 0,
      removed: 0,
      unchanged: 3,
      desired: 4,
      skipped: [],
      dryRun,
    }),
    distExists: () => true,
    now: () => new Date('2026-11-01T00:00:00.000Z'),
    listDir: (dir) =>
      Object.keys(files)
        .filter((file) => file.startsWith(`${dir}/`))
        .map((file) => file.slice(dir.length + 1)),
    readFile: (file) => files[file] ?? null,
    exec: (command, args) => {
      const line = [command, ...args].join(' ');
      if (!(command === 'launchctl' && args[0] === 'print')) calls.push(line);
      if (command === 'cp') files[args[1]!] = String(safeReadFile(args[0]!, { encoding: 'utf8' }));
      if (command === 'rm') delete files[args[args.length - 1]!];
      if (command === 'launchctl' && args[0] === 'bootstrap')
        loaded.add(path.basename(args[2]!, '.plist'));
      if (command === 'launchctl' && args[0] === 'bootout') {
        const label = args[1]!.split('/').pop()!;
        if (!loaded.delete(label)) return { status: 113, stdout: '', stderr: 'not loaded' };
      }
      if (command === 'launchctl' && args[0] === 'print')
        return loaded.has(args[1]!.split('/').pop()!)
          ? { status: 0, stdout: '', stderr: '' }
          : { status: 113, stdout: '', stderr: '' };
      return { status: 0, stdout: '', stderr: '' };
    },
  };
  return { files, loaded, calls, deps };
}

function legacyPlist(
  label: string,
  repoRoot: string,
  script: string,
  env?: Record<string, string>
) {
  return buildLaunchdPlist(
    {
      nodePath: '/usr/local/bin/node',
      repoRoot,
      logDir: `${HOME}/Library/Logs`,
      ...(env ? { env } : {}),
    },
    { label, daemonScript: script, logBaseName: label }
  );
}

describe('scheduler reconcile', () => {
  it('dry-run plans installs, writes nothing and runs no host command', async () => {
    const host = fakeHost();
    const printed: unknown[] = [];
    const report = await main([], (value) => printed.push(value), host.deps);
    expect(report.status).toBe('pending');
    expect(report.plan.pendingChanges).toBe(2);
    expect(host.calls).toEqual([]);
    expect(readJsonIfPresent(host.deps.statePath!)).toBeNull();
    expect(report.schedules).toMatchObject({ dryRun: true });
    expect(String(printed[0])).toContain('pnpm kyberion scheduler reconcile --apply');
  });

  it('--apply installs scoped units, records state, and a second run is a no-op', async () => {
    const host = fakeHost();
    const first = await reconcileResidentServices({ apply: true }, host.deps);
    expect(first.status).toBe('ok');
    expect(first.applied.map((entry) => `${entry.id}:${entry.ok}`)).toEqual([
      'chronos:true',
      'daemon-watchdog:true',
    ]);
    expect(Object.keys(host.files).sort()).toEqual([
      `${AGENTS}/com.kyberion.chronos.${instance.id}.plist`,
      `${AGENTS}/com.kyberion.daemon-watchdog.${instance.id}.plist`,
    ]);
    const state = readJsonIfPresent<ResidentServicesState>(host.deps.statePath!);
    expect(state).toMatchObject({ instance_id: instance.id, repo_root: instance.repoRoot });
    expect(state!.services.map((entry) => entry.label)).toEqual([
      `com.kyberion.chronos.${instance.id}`,
      `com.kyberion.daemon-watchdog.${instance.id}`,
    ]);
    expect(state!.services[0]!.node_path).toBe('/opt/homebrew/opt/node/bin/node');

    host.calls.length = 0;
    const second = await reconcileResidentServices({ apply: true }, host.deps);
    expect(second.plan.pendingChanges).toBe(0);
    expect(second.applied).toEqual([]);
    expect(host.calls).toEqual([]);
    expect(formatReconcileReport(second)).toContain('Nothing to change.');
  });

  it("migrates this checkout's legacy unit and leaves a foreign checkout's untouched", async () => {
    const legacyChronos = `${AGENTS}/com.kyberion.chronos.plist`;
    const foreignSupervisor = `${AGENTS}/com.kyberion.agent-runtime-supervisor.plist`;
    const host = fakeHost({
      [legacyChronos]: legacyPlist(
        'com.kyberion.chronos',
        instance.repoRoot,
        'dist/scripts/chronos_daemon.js',
        {
          KYBERION_PERSONA: 'sovereign',
        }
      ),
      [foreignSupervisor]: legacyPlist(
        'com.kyberion.agent-runtime-supervisor',
        '/Volumes/elsewhere/kyberion',
        'dist/scripts/agent_runtime_supervisor_daemon.js'
      ),
    });
    host.loaded.add('com.kyberion.chronos');
    host.loaded.add('com.kyberion.agent-runtime-supervisor');

    const report = await reconcileResidentServices(
      { apply: true, include: ['agent-runtime-supervisor'] },
      host.deps
    );
    expect(report.plan.items.find((item) => item.id === 'chronos')!.action).toBe('migrate');
    expect(host.files[legacyChronos]).toBeUndefined();
    expect(host.loaded.has('com.kyberion.chronos')).toBe(false);
    // Forwarded operator settings survive the migration (allowlisted names only).
    expect(host.files[`${AGENTS}/com.kyberion.chronos.${instance.id}.plist`]).toContain(
      '<key>KYBERION_PERSONA</key>'
    );
    // The other checkout's unit: reported, never booted out or removed.
    expect(host.files[foreignSupervisor]).toBeDefined();
    expect(host.loaded.has('com.kyberion.agent-runtime-supervisor')).toBe(true);
    expect(
      host.calls.some((call) => call.includes('com.kyberion.agent-runtime-supervisor.plist'))
    ).toBe(false);
    expect(report.plan.foreign.map((unit) => unit.label)).toEqual([
      'com.kyberion.agent-runtime-supervisor',
    ]);
    expect(formatReconcileReport(report)).toContain('owned by another checkout');
  });

  it('skips a surface-owned service while its surface is enabled', async () => {
    const host = fakeHost();
    const report = await reconcileResidentServices(
      { apply: false, include: ['generation-schedule'] },
      { ...host.deps, enabledSurfaces: () => new Set(['generation-schedule']) }
    );
    expect(report.plan.items.find((item) => item.id === 'generation-schedule')!.action).toBe(
      'surface-owned'
    );
  });

  it('reports a failed apply without recording the service as installed', async () => {
    const host = fakeHost();
    const report = await reconcileResidentServices(
      { apply: true },
      { ...host.deps, distExists: (file) => !file.endsWith('daemon_watchdog.js') }
    );
    expect(report.status).toBe('failed');
    const state = readJsonIfPresent<ResidentServicesState>(host.deps.statePath!);
    expect(state!.services.map((entry) => entry.id)).toEqual(['chronos']);
  });
});
