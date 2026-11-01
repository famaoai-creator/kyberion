import { describe, expect, it } from 'vitest';
import { windowsTaskSchedulerManager, buildWindowsTaskXml } from './windows-task-scheduler.js';
import { daemonUnitFileBytes } from './service-manager.js';
import type { DaemonRenderContext } from './service-manager.js';
import { DAEMON_SPECS } from './specs.js';
const ctx: DaemonRenderContext & { userId: string; systemRoot: string } = {
  nodePath: 'C:\\Program Files\\nodejs\\node.exe',
  repoRoot: 'C:\\work\\kyberion',
  homeDir: 'C:\\Users\\alice',
  uid: '1001',
  stagingDir: 'C:\\work\\kyberion\\active\\shared\\tmp',
  userId: 'DOMAIN\\alice',
  systemRoot: 'C:\\Windows',
  env: { KYBERION_PERSONA: 'operator' },
};
const spec = DAEMON_SPECS.chronos;
describe('Windows Task Scheduler manager', () => {
  it('renders an interactive least-privilege logon task and encoded PowerShell action', () => {
    const xml = buildWindowsTaskXml(spec, ctx);
    expect(xml).toContain('<LogonType>InteractiveToken</LogonType>');
    expect(xml).toContain('<RunLevel>LeastPrivilege</RunLevel>');
    expect(xml).toContain('-EncodedCommand');
    expect(xml).toContain('DOMAIN\\alice');
    expect(xml).not.toContain('KYBERION_PERSONA');
    const staged = daemonUnitFileBytes('windows-task-scheduler', xml) as Buffer;
    expect(staged.subarray(0, 2)).toEqual(Buffer.from([0xff, 0xfe]));
    expect(staged.subarray(2).toString('utf16le')).toContain('encoding="UTF-16"');
  });
  it('plans task registration and start without touching the host', () => {
    const p = windowsTaskSchedulerManager.planInstall(spec, ctx);
    expect(p.unitFiles[0].stagedPath).toContain('.xml');
    expect(p.commands[0].run[0]).toBe('schtasks.exe');
    expect(p.commands[0].run).toContain('/Create');
    expect(p.commands[1].run).toContain('/Run');
  });
  it('maps standalone start, stop, restart, uninstall, and status to schtasks', () => {
    expect(windowsTaskSchedulerManager.planStart(spec, ctx).commands[0].run).toContain('/Run');
    expect(windowsTaskSchedulerManager.planStop(spec, ctx).commands[0].run).toContain('/End');
    expect(windowsTaskSchedulerManager.planRestart(spec, ctx).commands[1].run).toContain('/Run');
    expect(windowsTaskSchedulerManager.planUninstall(spec, ctx).commands[1].run).toContain(
      '/Delete'
    );
    expect(windowsTaskSchedulerManager.statusCommand(spec, ctx)?.run).toContain('/Query');
  });
  it('fails closed when the user identity is missing', () => {
    expect(() =>
      windowsTaskSchedulerManager.planInstall(spec, { ...ctx, userId: undefined })
    ).toThrow(/user name/);
  });
});
