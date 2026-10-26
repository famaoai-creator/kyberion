import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { escapeXml } from '../text-escaping.js';
import { daemonBoundEnvironment } from './render-context.js';
import type { DaemonManager, DaemonRenderContext, DaemonServiceSpec } from './service-manager.js';

export interface WindowsTaskContext extends DaemonRenderContext {
  userId?: string;
  systemRoot?: string;
}
function taskName(spec: DaemonServiceSpec, ctx: WindowsTaskContext): string {
  if (!ctx.userId) throw new Error('Windows Task Scheduler requires the installing user name.');
  const user = createHash('sha256').update(ctx.userId.toLowerCase()).digest('hex').slice(0, 10);
  const label = spec.id.replace(/[^A-Za-z0-9_-]/g, '-');
  return `Kyberion-${label}${spec.instanceId ? `-${spec.instanceId}` : ''}-${user}`;
}
function psQuote(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}
function encodedPowerShell(spec: DaemonServiceSpec, ctx: WindowsTaskContext): string {
  const exe = path.win32.join(
    ctx.systemRoot ?? 'C:\\Windows',
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe'
  );
  const script = [
    `$ErrorActionPreference = 'Continue'`,
    `$env:PATH = ${psQuote(`${path.win32.dirname(ctx.nodePath)};${ctx.systemRoot ?? 'C:\\Windows'}\\System32`)} + ';' + $env:PATH`,
    ...Object.entries(daemonBoundEnvironment(ctx)).map(([k, v]) => `$env:${k} = ${psQuote(v)}`),
    `$logDir = Join-Path $env:LOCALAPPDATA 'Kyberion\\Logs'`,
    `New-Item -ItemType Directory -Force -Path $logDir | Out-Null`,
    `$log = Join-Path $logDir ${psQuote(`${spec.logBaseName}.log`)}`,
    `$err = Join-Path $logDir ${psQuote(`${spec.logBaseName}.err.log`)}`,
    `$node = ${psQuote(ctx.nodePath)}`,
    `$script = ${psQuote(path.win32.join(ctx.repoRoot, spec.daemonScript))}`,
    `$args = @($script${(spec.daemonArgs ?? []).map((a) => `, ${psQuote(a)}`).join('')})`,
    ...(spec.startIntervalSec
      ? [`& $node @args 1>> $log 2>> $err`]
      : [
          `while ($true) { & $node @args 1>> $log 2>> $err; $code = $LASTEXITCODE; if (${spec.keepAliveOnCrashOnly ? '$code -eq 0' : '$false'}) { break }; Start-Sleep -Seconds 10 }`,
        ]),
  ].join('; ');
  return `${exe}|${Buffer.from(script, 'utf16le').toString('base64')}`;
}
export function buildWindowsTaskXml(spec: DaemonServiceSpec, ctx: WindowsTaskContext): string {
  taskName(spec, ctx);
  const [exe, encoded] = encodedPowerShell(spec, ctx).split('|');
  const repetition = spec.startIntervalSec
    ? `<Repetition><Interval>PT${spec.startIntervalSec}S</Interval><StopAtDurationEnd>false</StopAtDurationEnd></Repetition>`
    : '';
  const trigger = spec.startIntervalSec
    ? `<LogonTrigger><Enabled>true</Enabled>${repetition}</LogonTrigger>`
    : `<LogonTrigger><Enabled>true</Enabled></LogonTrigger>`;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<Task version="1.4" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task"><RegistrationInfo><Description>Kyberion daemon ${escapeXml(spec.id)} for ${escapeXml(ctx.userId ?? '')}</Description></RegistrationInfo><Triggers>${trigger}</Triggers><Principals><Principal id="Author"><UserId>${escapeXml(ctx.userId ?? '')}</UserId><LogonType>InteractiveToken</LogonType><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy><StartWhenAvailable>true</StartWhenAvailable><Enabled>true</Enabled><ExecutionTimeLimit>PT0S</ExecutionTimeLimit><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Actions Context="Author"><Exec><Command>${escapeXml(exe)}</Command><Arguments>-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand ${encoded}</Arguments><WorkingDirectory>${escapeXml(ctx.repoRoot)}</WorkingDirectory></Exec></Actions></Task>`;
}
function plan(
  spec: DaemonServiceSpec,
  ctx: WindowsTaskContext,
  verb: 'start' | 'stop' | 'restart' | 'uninstall'
) {
  const name = taskName(spec, ctx);
  const base = { unitFiles: [], verificationHint: spec.verificationHint };
  if (verb === 'start')
    return {
      ...base,
      commands: [{ run: ['schtasks.exe', '/Run', '/TN', name] }],
      manualSteps: [`schtasks.exe /Run /TN "${name}"`],
    };
  if (verb === 'stop')
    return {
      ...base,
      commands: [{ run: ['schtasks.exe', '/End', '/TN', name], tolerateFailure: true }],
      manualSteps: [`schtasks.exe /End /TN "${name}"`],
    };
  if (verb === 'restart')
    return {
      ...base,
      commands: [
        { run: ['schtasks.exe', '/End', '/TN', name], tolerateFailure: true },
        { run: ['schtasks.exe', '/Run', '/TN', name] },
      ],
      manualSteps: [`schtasks.exe /End /TN "${name}"`, `schtasks.exe /Run /TN "${name}"`],
    };
  return {
    ...base,
    commands: [
      { run: ['schtasks.exe', '/End', '/TN', name], tolerateFailure: true },
      { run: ['schtasks.exe', '/Delete', '/TN', name, '/F'], tolerateFailure: true },
    ],
    manualSteps: [`schtasks.exe /End /TN "${name}"`, `schtasks.exe /Delete /TN "${name}" /F`],
  };
}
export const windowsTaskSchedulerManager: DaemonManager = {
  platform: 'windows-task-scheduler',
  planInstall(spec, rawCtx) {
    const ctx = rawCtx as WindowsTaskContext;
    const name = taskName(spec, ctx);
    const stagedPath = path.win32.join(ctx.stagingDir, `${name}.xml`);
    const targetPath = `Task Scheduler\\${name}`;
    return {
      unitFiles: [{ stagedPath, targetPath, content: buildWindowsTaskXml(spec, ctx) }],
      commands: [
        { run: ['schtasks.exe', '/Create', '/TN', name, '/XML', stagedPath, '/F'] },
        { run: ['schtasks.exe', '/Run', '/TN', name] },
      ],
      manualSteps: [
        `schtasks.exe /Create /TN "${name}" /XML <task.xml> /F`,
        `schtasks.exe /Run /TN "${name}"`,
      ],
      verificationHint: spec.verificationHint,
    };
  },
  planStart: (s, c) => plan(s, c as WindowsTaskContext, 'start'),
  planStop: (s, c) => plan(s, c as WindowsTaskContext, 'stop'),
  planRestart: (s, c) => plan(s, c as WindowsTaskContext, 'restart'),
  planUninstall: (s, c) => plan(s, c as WindowsTaskContext, 'uninstall'),
  statusCommand(spec, rawCtx) {
    const name = taskName(spec, rawCtx as WindowsTaskContext);
    return {
      run: ['schtasks.exe', '/Query', '/TN', name, '/FO', 'LIST', '/V'],
      describe: `Task Scheduler status for ${spec.id}`,
    };
  },
};
