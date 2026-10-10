/**
 * libs/core/daemon/launchd.ts — launchd (macOS) daemon manager.
 *
 * Renders per-user LaunchAgent plists and plans the launchctl verbs for
 * install / uninstall / restart / status. Planning is pure: the caller stages
 * unit files under active/shared/tmp/ and runs the commands through the
 * governed exec seam (see install_chronos_launchd.ts).
 */
import * as path from 'node:path';
import { escapeXml } from '../text-escaping.js';
import type { DaemonManager, DaemonRenderContext, DaemonServiceSpec } from './service-manager.js';

export interface LaunchdPlistOptions {
  /** Absolute path to the node binary (production: resolveStableNodePath()). */
  nodePath: string;
  /** Absolute repo root (production: pathResolver.rootDir()). */
  repoRoot: string;
  /**
   * Directory for launchd stdout/stderr logs (production: ~/Library/Logs).
   * Must be on the boot volume: launchd fails spawn with EX_CONFIG when the
   * Standard*Path targets live on an external volume it cannot open (TCC).
   */
  logDir: string;
  label?: string;
  /** Daemon entrypoint relative to repoRoot. */
  daemonScript?: string;
  /** Extra argv after daemonScript. */
  daemonArgs?: string[];
  /** Log filename stem under logDir. */
  logBaseName?: string;
  /** StartInterval in seconds for periodic one-shot jobs (drops KeepAlive). */
  startIntervalSec?: number;
  /**
   * Emit KeepAlive as {SuccessfulExit: false} instead of a bare true — for
   * daemons that exit cleanly when another instance already owns the role.
   */
  keepAliveOnCrashOnly?: boolean;
  /** Extra daemon environment (names must be allowlisted by the caller). */
  env?: Record<string, string>;
}

/** Pure plist generation — string in, string out, no I/O. */
export function buildLaunchdPlist(
  options: LaunchdPlistOptions,
  defaults: { label: string; daemonScript: string; logBaseName: string }
): string {
  const label = options.label ?? defaults.label;
  const daemonScript = path.join(options.repoRoot, options.daemonScript ?? defaults.daemonScript);
  const logBaseName = options.logBaseName ?? defaults.logBaseName;
  const stdoutPath = path.join(options.logDir, `${logBaseName}.log`);
  const stderrPath = path.join(options.logDir, `${logBaseName}.err.log`);
  // launchd spawns with PATH=/usr/bin:/bin:/usr/sbin:/sbin; scheduled
  // pipelines shell out to node/pnpm, so extend PATH with the node bin dir
  // and the standard package-manager locations.
  const pathEnv = [
    path.dirname(options.nodePath),
    '/opt/homebrew/bin',
    '/usr/local/bin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ].join(':');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>WorkingDirectory</key>
  <string>${escapeXml(options.repoRoot)}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${escapeXml(options.nodePath)}</string>
    <string>${escapeXml(daemonScript)}</string>${(options.daemonArgs ?? [])
      .map(
        (arg) => `
    <string>${escapeXml(arg)}</string>`
      )
      .join('')}
  </array>
  <key>RunAtLoad</key>
  <true/>${
    options.startIntervalSec
      ? `
  <key>StartInterval</key>
  <integer>${options.startIntervalSec}</integer>`
      : options.keepAliveOnCrashOnly
        ? `
  <key>KeepAlive</key>
  <dict>
    <key>SuccessfulExit</key>
    <false/>
  </dict>
  <key>ThrottleInterval</key>
  <integer>10</integer>`
        : `
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>`
  }
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>${Object.entries(options.env ?? {})
      .map(
        ([name, value]) => `
    <key>${escapeXml(name)}</key>
    <string>${escapeXml(value)}</string>`
      )
      .join('')}
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

export function launchdUnitPath(spec: DaemonServiceSpec, homeDir: string): string {
  return path.join(homeDir, 'Library/LaunchAgents', `${spec.label}.plist`);
}

function serviceTarget(spec: DaemonServiceSpec, ctx: DaemonRenderContext): string {
  return `gui/${ctx.uid}/${spec.label}`;
}

export const launchdManager: DaemonManager = {
  platform: 'launchd',

  planInstall(spec, ctx) {
    const logDir = path.join(ctx.homeDir, 'Library/Logs');
    const target = launchdUnitPath(spec, ctx.homeDir);
    const plist = buildLaunchdPlist(
      {
        nodePath: ctx.nodePath,
        repoRoot: ctx.repoRoot,
        logDir,
        label: spec.label,
        daemonScript: spec.daemonScript,
        daemonArgs: spec.daemonArgs,
        logBaseName: spec.logBaseName,
        startIntervalSec: spec.startIntervalSec,
        keepAliveOnCrashOnly: spec.keepAliveOnCrashOnly,
        env: ctx.env,
      },
      { label: spec.label, daemonScript: spec.daemonScript, logBaseName: spec.logBaseName }
    );
    const staged = path.join(ctx.stagingDir, `${spec.label}.plist`);
    const domain = `gui/${ctx.uid}`;
    return {
      unitFiles: [{ stagedPath: staged, targetPath: target, content: plist }],
      commands: [
        { run: ['mkdir', '-p', logDir], describe: 'ensure launchd log directory' },
        { run: ['mkdir', '-p', path.dirname(target)], describe: 'ensure LaunchAgents directory' },
        { run: ['cp', staged, target], describe: `install ${path.basename(target)}` },
        {
          run: ['launchctl', 'bootout', serviceTarget(spec, ctx)],
          tolerateFailure: true,
          describe: 'drop any previously loaded agent',
        },
        { run: ['launchctl', 'bootstrap', domain, target], describe: `load ${spec.label}` },
      ],
      manualSteps: [
        `1. Save the plist above to: ${target}`,
        `2. launchctl bootstrap ${domain} ${target}`,
        `3. Verify: launchctl print ${serviceTarget(spec, ctx)} | head`,
      ],
      verificationHint: spec.verificationHint,
    };
  },

  planUninstall(spec, ctx) {
    const target = launchdUnitPath(spec, ctx.homeDir);
    return {
      unitFiles: [],
      commands: [
        {
          run: ['launchctl', 'bootout', serviceTarget(spec, ctx)],
          tolerateFailure: true,
          describe: `unload ${spec.label}`,
        },
        { run: ['rm', '-f', target], describe: `remove ${path.basename(target)}` },
      ],
      manualSteps: [`1. launchctl bootout ${serviceTarget(spec, ctx)}`, `2. rm ${target}`],
      verificationHint: spec.verificationHint,
    };
  },

  planRestart(spec, ctx) {
    return {
      unitFiles: [],
      commands: [
        {
          run: ['launchctl', 'kickstart', '-k', serviceTarget(spec, ctx)],
          describe: `SIGTERM + relaunch ${spec.label}`,
        },
      ],
      manualSteps: [`launchctl kickstart -k ${serviceTarget(spec, ctx)}`],
      verificationHint: spec.verificationHint,
    };
  },

  statusCommand(spec, ctx) {
    return {
      run: ['launchctl', 'print', serviceTarget(spec, ctx)],
      describe: `print launchd state for ${spec.label}`,
    };
  },
};
