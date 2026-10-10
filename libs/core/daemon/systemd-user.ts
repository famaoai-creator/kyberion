/**
 * libs/core/daemon/systemd-user.ts — systemd user-unit daemon manager (Linux).
 *
 * Mirrors the launchd manager for `systemctl --user`: per-user units under
 * ~/.config/systemd/user, logs under ~/.local/state/kyberion (created via
 * ExecStartPre — user units cannot rely on StateDirectory on older systemd),
 * Restart=always ≈ launchd KeepAlive, Restart=on-failure ≈ keepAliveOnCrashOnly,
 * and a `.timer` unit for startIntervalSec one-shot jobs.
 *
 * Planning is pure; the caller stages files via secure-io and executes the
 * commands through the governed exec seam.
 */
import * as path from 'node:path';
import type { DaemonManager, DaemonRenderContext, DaemonServiceSpec } from './service-manager.js';

/** systemd unit-safe name: com.kyberion.chronos -> kyberion-chronos. */
export function systemdUnitStem(spec: DaemonServiceSpec): string {
  const stem = spec.label.replace(/^com\./, '').replaceAll('.', '-');
  return /^[a-z][a-z0-9_-]*$/i.test(stem) ? stem : `kyberion-${spec.id}`;
}

function logDir(ctx: DaemonRenderContext): string {
  return path.join(ctx.homeDir, '.local', 'state', 'kyberion');
}

/** Pure unit-file render — string in, string out, no I/O. */
export function buildSystemdServiceUnit(spec: DaemonServiceSpec, ctx: DaemonRenderContext): string {
  const daemonScript = path.join(ctx.repoRoot, spec.daemonScript);
  const envLines = Object.entries(ctx.env ?? {})
    .map(([name, value]) => `Environment=${name}=${value}`)
    .join('\n');
  const restart = spec.startIntervalSec
    ? ''
    : `Restart=${spec.keepAliveOnCrashOnly ? 'on-failure' : 'always'}\nRestartSec=10\n`;
  return `[Unit]
Description=Kyberion daemon: ${spec.id}

[Service]
Type=${spec.startIntervalSec ? 'oneshot' : 'simple'}
WorkingDirectory=${ctx.repoRoot}
Environment=PATH=${path.dirname(ctx.nodePath)}:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin
${envLines ? `${envLines}\n` : ''}ExecStartPre=/bin/mkdir -p ${logDir(ctx)}
ExecStart=${ctx.nodePath} ${daemonScript}${(spec.daemonArgs ?? []).map((arg) => ` ${arg}`).join('')}
${restart}StandardOutput=append:${path.join(logDir(ctx), `${spec.logBaseName}.log`)}
StandardError=append:${path.join(logDir(ctx), `${spec.logBaseName}.err.log`)}

[Install]
WantedBy=default.target
`;
}

export function buildSystemdTimerUnit(spec: DaemonServiceSpec): string {
  const stem = systemdUnitStem(spec);
  return `[Unit]
Description=Kyberion daemon timer: ${spec.id}

[Timer]
OnBootSec=1min
OnUnitActiveSec=${spec.startIntervalSec}sec
Unit=${stem}.service
Persistent=true

[Install]
WantedBy=timers.target
`;
}

export function systemdUnitDir(homeDir: string): string {
  return path.join(homeDir, '.config', 'systemd', 'user');
}

/** The unit systemctl acts on: the timer when scheduled, else the service. */
function activeUnitName(spec: DaemonServiceSpec): string {
  const stem = systemdUnitStem(spec);
  return spec.startIntervalSec ? `${stem}.timer` : `${stem}.service`;
}

function unitPaths(spec: DaemonServiceSpec, ctx: DaemonRenderContext): string[] {
  const stem = systemdUnitStem(spec);
  const dir = systemdUnitDir(ctx.homeDir);
  const paths = [path.join(dir, `${stem}.service`)];
  if (spec.startIntervalSec) paths.push(path.join(dir, `${stem}.timer`));
  return paths;
}

export const systemdUserManager: DaemonManager = {
  platform: 'systemd-user',

  planInstall(spec, ctx) {
    const stem = systemdUnitStem(spec);
    const dir = systemdUnitDir(ctx.homeDir);
    const stagedService = path.join(ctx.stagingDir, `${stem}.service`);
    const unitFiles = [
      {
        stagedPath: stagedService,
        targetPath: path.join(dir, `${stem}.service`),
        content: buildSystemdServiceUnit(spec, ctx),
      },
    ];
    if (spec.startIntervalSec) {
      unitFiles.push({
        stagedPath: path.join(ctx.stagingDir, `${stem}.timer`),
        targetPath: path.join(dir, `${stem}.timer`),
        content: buildSystemdTimerUnit(spec),
      });
    }
    const unit = activeUnitName(spec);
    return {
      unitFiles,
      commands: [
        { run: ['mkdir', '-p', dir], describe: 'ensure systemd user unit directory' },
        ...unitFiles.map((file) => ({
          run: ['cp', file.stagedPath, file.targetPath],
          describe: `install ${path.basename(file.targetPath)}`,
        })),
        { run: ['systemctl', '--user', 'daemon-reload'], describe: 'reload unit files' },
        {
          run: ['systemctl', '--user', 'enable', '--now', unit],
          describe: `enable and start ${unit}`,
        },
      ],
      manualSteps: [
        ...unitFiles.map((file, i) => `${i + 1}. Save the unit above to: ${file.targetPath}`),
        `${unitFiles.length + 1}. systemctl --user daemon-reload`,
        `${unitFiles.length + 2}. systemctl --user enable --now ${unit}`,
        `${unitFiles.length + 3}. Verify: systemctl --user status ${unit}`,
      ],
      verificationHint: spec.verificationHint,
    };
  },

  planUninstall(spec, ctx) {
    const unit = activeUnitName(spec);
    return {
      unitFiles: [],
      commands: [
        {
          run: ['systemctl', '--user', 'disable', '--now', unit],
          tolerateFailure: true,
          describe: `stop and disable ${unit}`,
        },
        ...unitPaths(spec, ctx).map((target) => ({
          run: ['rm', '-f', target],
          describe: `remove ${path.basename(target)}`,
        })),
        { run: ['systemctl', '--user', 'daemon-reload'], describe: 'reload unit files' },
      ],
      manualSteps: [
        `1. systemctl --user disable --now ${unit}`,
        ...unitPaths(spec, ctx).map((target, i) => `${i + 2}. rm ${target}`),
        `${unitPaths(spec, ctx).length + 2}. systemctl --user daemon-reload`,
      ],
      verificationHint: spec.verificationHint,
    };
  },

  planRestart(spec) {
    const unit = activeUnitName(spec);
    return {
      unitFiles: [],
      commands: [
        {
          run: ['systemctl', '--user', 'restart', unit],
          describe: `restart ${unit}`,
        },
      ],
      manualSteps: [`systemctl --user restart ${unit}`],
      verificationHint: spec.verificationHint,
    };
  },

  statusCommand(spec) {
    return {
      run: ['systemctl', '--user', 'status', activeUnitName(spec), '--no-pager'],
      describe: `systemd state for ${activeUnitName(spec)}`,
    };
  },
};
