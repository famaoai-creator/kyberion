#!/usr/bin/env node
/**
 * scripts/install_chronos_launchd.ts — LC-01d
 *
 * Ceremony for keeping long-lived daemons alive across logins. The chronos
 * daemon (`pnpm scheduler`) is the ONLY pipeline scheduler in the system; when
 * it dies, every registered pipeline schedule silently stops firing. This
 * script registers it with the host's per-user service manager so the OS
 * restarts it. Other heartbeat-recording daemons from DAEMON_SPECS are
 * installed the same way via `--daemon <id>`.
 *
 * Platform support goes through libs/core/daemon/service-manager.ts:
 * macOS → launchd LaunchAgent, Linux → systemd --user unit (+ .timer for
 * interval jobs). Windows has no user-daemon story here — DEPLOYMENT.md
 * routes Windows daemons through the surface commands instead.
 *
 * Modes:
 *   pnpm kyberion scheduler install                 # dry-run: print unit + exact steps
 *   pnpm kyberion scheduler install --apply         # stage unit + load it
 *   pnpm kyberion scheduler install --apply --daemon generation-schedule
 *   pnpm kyberion scheduler restart                 # dry-run: print restart steps
 *   pnpm kyberion scheduler restart --apply         # launchctl kickstart / systemctl restart
 *   pnpm kyberion scheduler status                  # print the manager's live status
 *   pnpm kyberion scheduler uninstall               # dry-run: print removal steps
 *   pnpm kyberion scheduler uninstall --apply       # unload + remove the unit
 *
 * secure-io note: the service-manager directories (~/Library/LaunchAgents,
 * ~/.config/systemd/user) are outside the secure-io write roots, so --apply
 * never writes there via file I/O. Unit files are staged under
 * active/shared/tmp/ with safeWriteFile and copied into place with a
 * governed `cp` through safeExecResult — the same governed-exec seam
 * ops-alert.ts uses for curl.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeExistsSync, safeWriteFile } from '@agent/core/secure-io';
import {
  resolveDaemonManager,
  type DaemonPlan,
  type DaemonRenderContext,
  type DaemonServiceSpec,
} from '@agent/core/daemon/service-manager';
import { buildLaunchdPlist, type LaunchdPlistOptions } from '@agent/core/daemon/launchd';
import { CHRONOS_DAEMON_LABEL, DAEMON_SPECS } from '@agent/core/daemon/specs';
import { defineScript, isDirectScript } from './lib/harness.js';

export const CHRONOS_LAUNCHD_LABEL = CHRONOS_DAEMON_LABEL;

/** @deprecated Name kept for compatibility — the spec is platform-neutral. */
export type LaunchdDaemonSpec = DaemonServiceSpec;
export const LAUNCHD_DAEMON_SPECS = DAEMON_SPECS;

/** @deprecated Alias of LaunchdPlistOptions for existing callers/tests. */
export type ChronosLaunchdPlistOptions = LaunchdPlistOptions;

/**
 * Map a Homebrew Cellar node path to the version-independent opt symlink
 * (`<prefix>/opt/<pkg>/bin/node`). `process.execPath` bakes in the versioned
 * Cellar path, which the next `brew upgrade` deletes — that is what stranded
 * the original agent in the launchd penalty box (spawn failed, EX_CONFIG).
 * The opt link tracks whatever version is currently linked. Non-Homebrew
 * installs (nvm, pkg installer, …) and a missing opt link fall back to the
 * exec path unchanged.
 */
export function resolveStableNodePath(
  execPath: string = process.execPath,
  exists: (candidate: string) => boolean = safeExistsSync
): string {
  const match = /^(.*)\/Cellar\/([^/]+)\/[^/]+\/bin\/node$/.exec(execPath);
  if (!match) return execPath;
  const optPath = `${match[1]}/opt/${match[2]}/bin/node`;
  return exists(optPath) ? optPath : execPath;
}

/**
 * Settings the daemon may inherit from the installing shell. Secrets are
 * deliberately absent: Chronos only enqueues deliveries, and each surface
 * bridge sends with its own credentials.
 */
export const CHRONOS_FORWARDABLE_ENV = [
  'KYBERION_PERSONA',
  'KYBERION_CHRONOS_SCHEDULES',
  'KYBERION_OPERATOR_SLACK_DM',
  'KYBERION_REASONING_BACKEND',
] as const;

/**
 * Read the `--forward-env` settings from this shell. The allowlist is checked
 * before any value is read, so a refused name (e.g. a secret) is never loaded.
 */
export function resolveForwardedChronosEnv(
  names: string[],
  readEnv: (name: string) => string | undefined = (name) => getRegisteredEnvText(name)
): Record<string, string> {
  return Object.fromEntries(
    names.map((name) => {
      if (!(CHRONOS_FORWARDABLE_ENV as readonly string[]).includes(name)) {
        throw new Error(`[POLICY_VIOLATION] ${name} cannot be forwarded to the Chronos daemon.`);
      }
      const value = readEnv(name);
      if (!value) throw new Error(`--forward-env ${name}: not set in this shell.`);
      return [name, value];
    })
  );
}

/** Pure plist generation — string in, string out, no I/O. */
export function buildChronosLaunchdPlist(options: ChronosLaunchdPlistOptions): string {
  for (const name of Object.keys(options.env ?? {})) {
    if (!(CHRONOS_FORWARDABLE_ENV as readonly string[]).includes(name)) {
      throw new Error(`[POLICY_VIOLATION] ${name} cannot be forwarded to the Chronos daemon.`);
    }
  }
  return buildLaunchdPlist(options, {
    label: CHRONOS_DAEMON_LABEL,
    daemonScript: 'dist/scripts/chronos_daemon.js',
    logBaseName: 'kyberion-chronos',
  });
}

export function launchAgentTargetPath(label: string, homeDir: string = os.homedir()): string {
  return path.join(homeDir, 'Library/LaunchAgents', `${label}.plist`);
}

export function chronosLaunchAgentTargetPath(homeDir: string = os.homedir()): string {
  return launchAgentTargetPath(CHRONOS_LAUNCHD_LABEL, homeDir);
}

function currentUid(): string {
  return typeof process.getuid === 'function' ? String(process.getuid()) : '$UID';
}

function runOrThrow(command: string, args: string[], tolerateFailure = false): void {
  const result = safeExecResult(command, args, { timeoutMs: 15_000 });
  const detail = `${command} ${args.join(' ')}`;
  if (result.status === 0) {
    logger.info(`[daemon-manager] ok: ${detail}`);
    return;
  }
  const message = `${detail} exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`;
  if (tolerateFailure) {
    logger.warn(`[daemon-manager] tolerated: ${message}`);
    return;
  }
  throw new Error(message);
}

function printPlan(
  verb: 'Install' | 'Uninstall' | 'Restart',
  plan: DaemonPlan,
  applyCommand: string,
  print: (value: unknown) => void
): void {
  print(
    [
      ...plan.unitFiles.flatMap((file) => [
        `--- unit file for ${file.targetPath} (generated) ---`,
        file.content,
      ]),
      `--- ${verb} steps (dry-run: nothing was changed) ---`,
      ...plan.manualSteps,
      `   (${plan.verificationHint})`,
      '',
      `Or run: ${applyCommand}`,
    ].join('\n')
  );
}

export interface InstallChronosOptions {
  /** Test seam: override the detected platform (e.g. 'darwin', 'linux'). */
  platform?: NodeJS.Platform;
}

export async function main(
  args: string[],
  print: (value: unknown) => void,
  options: InstallChronosOptions = {}
): Promise<void> {
  const argv = await createStandardYargs(['node', 'install_chronos_launchd', ...args])
    .option('apply', {
      type: 'boolean',
      default: false,
      describe: 'Actually stage the unit and run the service manager (default: dry-run print only)',
    })
    .option('uninstall', {
      type: 'boolean',
      default: false,
      describe: 'Remove the unit instead of installing it',
    })
    .option('restart', {
      type: 'boolean',
      default: false,
      describe:
        'Restart the daemon (launchctl kickstart -k / systemctl --user restart) — the fix for a live process with a stale heartbeat',
    })
    .option('status', {
      type: 'boolean',
      default: false,
      describe: 'Print the service manager status for the daemon (read-only)',
    })
    .option('forward-env', {
      type: 'string',
      array: true,
      default: [],
      describe: `Copy a setting from this shell into the daemon (${CHRONOS_FORWARDABLE_ENV.join(', ')})`,
    })
    .option('daemon', {
      type: 'string',
      default: 'chronos',
      describe: `Daemon to manage (${Object.keys(DAEMON_SPECS).join(', ')})`,
    })
    .parseSync();

  const daemonId = String(argv.daemon);
  const spec = DAEMON_SPECS[daemonId];
  if (!spec) {
    throw new Error(
      `unknown daemon '${daemonId}' — known: ${Object.keys(DAEMON_SPECS).join(', ')}`
    );
  }

  const manager = resolveDaemonManager(options.platform);
  if (!manager) {
    throw new Error(
      `no user-level daemon manager for platform '${options.platform ?? process.platform}' — ` +
        'on Windows, run daemons through the surface commands (pnpm surfaces start/repair); see docs/operator/DEPLOYMENT.md'
    );
  }

  const repoRoot = pathResolver.rootDir();
  const env = resolveForwardedChronosEnv(argv['forward-env'] as string[]);
  const ctx: DaemonRenderContext = {
    nodePath: resolveStableNodePath(),
    repoRoot,
    homeDir: os.homedir(),
    uid: currentUid(),
    stagingDir: pathResolver.sharedTmp(`daemon-units/${manager.platform}`),
    env,
  };
  const verbFlag = daemonId === 'chronos' ? '' : ` --daemon ${daemonId}`;

  if (argv.status) {
    const status = manager.statusCommand(spec, ctx);
    if (!status) {
      print(`no status command for platform '${manager.platform}'`);
      return;
    }
    const [command, ...commandArgs] = status.run;
    const result = safeExecResult(command, commandArgs, { timeoutMs: 15_000 });
    print(
      result.stdout.trim() ||
        result.stderr.trim() ||
        `${status.run.join(' ')} exited ${result.status}`
    );
    return;
  }

  const verb = argv.uninstall ? 'uninstall' : argv.restart ? 'restart' : 'install';
  const plan =
    verb === 'uninstall'
      ? manager.planUninstall(spec, ctx)
      : verb === 'restart'
        ? manager.planRestart(spec, ctx)
        : manager.planInstall(spec, ctx);
  const applyCommand = `pnpm kyberion scheduler ${verb} --apply${verbFlag}`;

  if (!argv.apply) {
    printPlan(
      verb === 'uninstall' ? 'Uninstall' : verb === 'restart' ? 'Restart' : 'Install',
      plan,
      applyCommand,
      print
    );
    return;
  }

  if (verb === 'install') {
    const distDaemon = path.join(repoRoot, spec.daemonScript);
    if (!safeExistsSync(distDaemon)) {
      throw new Error(`dist build missing: ${distDaemon} — run \`pnpm build\` first`);
    }
  }

  // Stage unit files under the secure-io write root, then copy into the
  // service-manager location via governed exec — see header note.
  for (const unit of plan.unitFiles) {
    safeWriteFile(unit.stagedPath, unit.content);
  }
  for (const command of plan.commands) {
    runOrThrow(command.run[0], command.run.slice(1), command.tolerateFailure === true);
  }
  logger.success(
    `[daemon-manager] ${verb}ed ${spec.label} via ${manager.platform} — verify: ${plan.verificationHint}`
  );
}

export const runInstallChronosLaunchd = defineScript({
  name: 'chronos:install',
  flags: [],
  run: ({ argv, print }) => main(argv, print),
});

if (
  isDirectScript(import.meta.url, 'install_chronos_launchd.ts') ||
  isDirectScript(import.meta.url, 'install_chronos_launchd.js')
)
  void runInstallChronosLaunchd();
