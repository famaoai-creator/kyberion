import { describe, expect, it } from 'vitest';
import { resolveDaemonManager, type DaemonRenderContext } from './service-manager.js';
import { buildSystemdServiceUnit, buildSystemdTimerUnit, systemdUnitStem } from './systemd-user.js';
import { DAEMON_SPECS } from './specs.js';

const ctx: DaemonRenderContext = {
  nodePath: '/usr/bin/node',
  repoRoot: '/repo/kyberion',
  homeDir: '/home/alice',
  uid: '501',
  stagingDir: '/tmp/staging',
};

const chronos = DAEMON_SPECS['chronos'];
const watchdog = DAEMON_SPECS['daemon-watchdog'];

describe('resolveDaemonManager', () => {
  it('maps darwin to launchd and linux to systemd-user', () => {
    expect(resolveDaemonManager('darwin')?.platform).toBe('launchd');
    expect(resolveDaemonManager('linux')?.platform).toBe('systemd-user');
  });

  it('returns null for platforms without a user daemon story', () => {
    expect(resolveDaemonManager('win32')).toBeNull();
  });
});

describe('launchd manager plans', () => {
  const manager = resolveDaemonManager('darwin')!;

  it('installs via bootstrap into the per-user LaunchAgents directory', () => {
    const plan = manager.planInstall(chronos, ctx);
    expect(plan.unitFiles).toHaveLength(1);
    expect(plan.unitFiles[0].targetPath).toBe(
      '/home/alice/Library/LaunchAgents/com.kyberion.chronos.plist'
    );
    expect(plan.unitFiles[0].content).toContain('<string>com.kyberion.chronos</string>');
    expect(plan.commands.map((c) => c.run[0])).toEqual([
      'mkdir',
      'mkdir',
      'cp',
      'launchctl',
      'launchctl',
    ]);
    expect(plan.commands.at(-1)?.run).toEqual([
      'launchctl',
      'bootstrap',
      'gui/501',
      '/home/alice/Library/LaunchAgents/com.kyberion.chronos.plist',
    ]);
  });

  it('restarts a live agent with kickstart -k (the stale-heartbeat fix)', () => {
    const plan = manager.planRestart(chronos, ctx);
    expect(plan.unitFiles).toHaveLength(0);
    expect(plan.commands).toEqual([
      expect.objectContaining({
        run: ['launchctl', 'kickstart', '-k', 'gui/501/com.kyberion.chronos'],
      }),
    ]);
  });

  it('uninstalls via bootout plus plist removal', () => {
    const plan = manager.planUninstall(chronos, ctx);
    expect(plan.commands[0].run[0]).toBe('launchctl');
    expect(plan.commands[0].run).toContain('bootout');
    expect(plan.commands[0].tolerateFailure).toBe(true);
    expect(plan.commands[1].run).toEqual([
      'rm',
      '-f',
      '/home/alice/Library/LaunchAgents/com.kyberion.chronos.plist',
    ]);
  });
});

describe('systemd-user manager plans', () => {
  const manager = resolveDaemonManager('linux')!;

  it('maps the com.kyberion.* label to a systemd-safe unit stem', () => {
    expect(systemdUnitStem(chronos)).toBe('kyberion-chronos');
  });

  it('renders a resident service unit mirroring KeepAlive', () => {
    const unit = buildSystemdServiceUnit(chronos, ctx);
    expect(unit).toContain('ExecStart=/usr/bin/node /repo/kyberion/dist/scripts/chronos_daemon.js');
    expect(unit).toContain('WorkingDirectory=/repo/kyberion');
    expect(unit).toContain('Restart=always');
    expect(unit).toContain('WantedBy=default.target');
  });

  it('renders on-failure restart for keepAliveOnCrashOnly daemons', () => {
    const unit = buildSystemdServiceUnit(DAEMON_SPECS['agent-runtime-supervisor'], ctx);
    expect(unit).toContain('Restart=on-failure');
    expect(unit).not.toContain('Restart=always');
  });

  it('installs interval jobs as a .timer plus .service pair', () => {
    const plan = manager.planInstall(watchdog, ctx);
    expect(plan.unitFiles.map((f) => f.targetPath)).toEqual([
      '/home/alice/.config/systemd/user/kyberion-daemon-watchdog.service',
      '/home/alice/.config/systemd/user/kyberion-daemon-watchdog.timer',
    ]);
    expect(plan.commands.at(-1)?.run).toEqual([
      'systemctl',
      '--user',
      'enable',
      '--now',
      'kyberion-daemon-watchdog.timer',
    ]);
    const timer = buildSystemdTimerUnit(watchdog);
    expect(timer).toContain(`OnUnitActiveSec=${watchdog.startIntervalSec}sec`);
    // One-shot checkers are not resident services.
    const service = buildSystemdServiceUnit(watchdog, ctx);
    expect(service).toContain('Type=oneshot');
    expect(service).not.toContain('Restart=');
  });

  it('restarts via systemctl --user restart', () => {
    const plan = manager.planRestart(chronos, ctx);
    expect(plan.commands).toEqual([
      expect.objectContaining({
        run: ['systemctl', '--user', 'restart', 'kyberion-chronos.service'],
      }),
    ]);
  });
});
