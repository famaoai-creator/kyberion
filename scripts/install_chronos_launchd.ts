#!/usr/bin/env node
/**
 * scripts/install_chronos_launchd.ts — LC-01d
 *
 * Ceremony for keeping long-lived daemons alive across logins. The chronos
 * daemon (`pnpm scheduler`) is the ONLY pipeline scheduler in the system; when
 * it dies, every registered pipeline schedule silently stops firing. This
 * script generates a macOS LaunchAgent so launchd restarts it. Other
 * heartbeat-recording daemons from LAUNCHD_DAEMON_SPECS are installed the
 * same way via `--daemon <id>`.
 *
 * Modes:
 *   pnpm kyberion scheduler install                 # dry-run: print plist + exact steps
 *   pnpm kyberion scheduler install --apply         # stage plist + run launchctl
 *   pnpm kyberion scheduler install --apply --daemon generation-schedule
 *   pnpm kyberion scheduler uninstall               # dry-run: print bootout steps
 *   pnpm kyberion scheduler uninstall --apply       # bootout + remove the plist
 *
 * secure-io note: $HOME/Library/LaunchAgents is outside the secure-io write
 * roots, so --apply never writes there via file I/O. The plist is staged
 * under active/shared/tmp/ with safeWriteFile and copied into place with a
 * governed `cp` through safeExecResult — the same governed-exec seam
 * ops-alert.ts uses for curl.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import { createStandardYargs } from '@agent/core/cli-utils';
import { getRegisteredEnvText } from '@agent/core/foundation';
import { escapeXml } from '@agent/core/text-escaping';
import { logger } from '@agent/core/core';
import { pathResolver } from '@agent/core/path-resolver';
import { safeExecResult, safeExistsSync, safeWriteFile } from '@agent/core/secure-io';
import { defineScript, isDirectScript } from './lib/harness.js';

export const CHRONOS_LAUNCHD_LABEL = 'com.kyberion.chronos';

export interface LaunchdDaemonSpec {
  /** Value accepted by `--daemon` (kebab-case). */
  id: string;
  /** launchd Label; also the plist filename stem under ~/Library/LaunchAgents. */
  label: string;
  /** Daemon entrypoint, relative to the repo root (compiled dist path). */
  daemonScript: string;
  /** Extra argv after daemonScript (e.g. flags a one-shot job needs). */
  daemonArgs?: string[];
  /** Log filename stem under logDir (`<logBaseName>.log` / `.err.log`). */
  logBaseName: string;
  /** Where to confirm the agent is doing its job (heartbeat file, alert log, …). */
  verificationHint: string;
  /**
   * Seconds between runs for periodic one-shot jobs (launchd StartInterval).
   * When set the plist drops KeepAlive — a short-lived checker must not be
   * kept resident.
   */
  startIntervalSec?: number;
}

/**
 * Daemons that get launchd persistence. Only daemons that record a heartbeat
 * (daemon_watchdog's DEFAULT_DAEMONS) belong here as KeepAlive residents —
 * anything else cannot be observed when it stops. The
 * agent-runtime-supervisor is deliberately absent: clients respawn it on
 * demand, so launchd would only add a second owner. `daemon-watchdog` runs
 * as a StartInterval one-shot: it must fire even when every watched daemon
 * is dead, which a chronos-scheduled pipeline can never guarantee.
 */
export const LAUNCHD_DAEMON_SPECS: Record<string, LaunchdDaemonSpec> = {
  chronos: {
    id: 'chronos',
    label: CHRONOS_LAUNCHD_LABEL,
    daemonScript: 'dist/scripts/chronos_daemon.js',
    logBaseName: 'kyberion-chronos',
    verificationHint: 'heartbeat: active/shared/runtime/heartbeats/chronos-daemon.json',
  },
  'generation-schedule': {
    id: 'generation-schedule',
    label: 'com.kyberion.generation-schedule',
    daemonScript: 'dist/scripts/run_generation_schedule_daemon.js',
    logBaseName: 'kyberion-generation-schedule',
    verificationHint: 'heartbeat: active/shared/runtime/heartbeats/generation-schedule-daemon.json',
  },
  'daemon-watchdog': {
    id: 'daemon-watchdog',
    label: 'com.kyberion.daemon-watchdog',
    daemonScript: 'dist/scripts/daemon_watchdog.js',
    logBaseName: 'kyberion-daemon-watchdog',
    verificationHint: 'ops alerts: active/shared/observability/ops-alerts.jsonl',
    startIntervalSec: 300,
  },
};

export interface ChronosLaunchdPlistOptions {
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
  /** Daemon entrypoint relative to repoRoot (default: chronos scheduler). */
  daemonScript?: string;
  /** Extra argv after daemonScript. */
  daemonArgs?: string[];
  /** Log filename stem under logDir (default: 'kyberion-chronos'). */
  logBaseName?: string;
  /** StartInterval in seconds for periodic one-shot jobs (drops KeepAlive). */
  startIntervalSec?: number;
  /** Extra daemon environment (names must be in CHRONOS_FORWARDABLE_ENV). */
  env?: Record<string, string>;
}

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
  const label = options.label ?? CHRONOS_LAUNCHD_LABEL;
  const daemonScript = path.join(
    options.repoRoot,
    options.daemonScript ?? 'dist/scripts/chronos_daemon.js'
  );
  const logBaseName = options.logBaseName ?? 'kyberion-chronos';
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
    logger.info(`[chronos-launchd] ok: ${detail}`);
    return;
  }
  const message = `${detail} exited ${result.status}: ${result.stderr.trim() || result.stdout.trim()}`;
  if (tolerateFailure) {
    logger.warn(`[chronos-launchd] tolerated: ${message}`);
    return;
  }
  throw new Error(message);
}

function printManualSteps(
  plist: string,
  spec: LaunchdDaemonSpec,
  target: string,
  uid: string,
  print: (value: unknown) => void
): void {
  print(
    [
      '--- LaunchAgent plist (generated) ---',
      plist,
      '--- Install steps (dry-run: nothing was changed) ---',
      `1. Save the plist above to: ${target}`,
      `2. launchctl bootstrap gui/${uid} ${target}`,
      `3. Verify: launchctl print gui/${uid}/${spec.label} | head`,
      `   (${spec.verificationHint})`,
      '',
      'Or run: pnpm kyberion scheduler install --apply  (if the flag is not forwarded: node dist/scripts/install_chronos_launchd.js --apply)',
      `Uninstall later: launchctl bootout gui/${uid}/${spec.label} && rm ${target}`,
    ].join('\n')
  );
}

export async function main(args: string[], print: (value: unknown) => void): Promise<void> {
  const argv = await createStandardYargs(['node', 'install_chronos_launchd', ...args])
    .option('apply', {
      type: 'boolean',
      default: false,
      describe: 'Actually stage the plist and run launchctl (default: dry-run print only)',
    })
    .option('uninstall', {
      type: 'boolean',
      default: false,
      describe: 'Remove the LaunchAgent instead of installing it',
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
      describe: `Daemon to install (${Object.keys(LAUNCHD_DAEMON_SPECS).join(', ')})`,
    })
    .parseSync();

  const daemonId = String(argv.daemon);
  const spec = LAUNCHD_DAEMON_SPECS[daemonId];
  if (!spec) {
    throw new Error(
      `unknown daemon '${daemonId}' — known: ${Object.keys(LAUNCHD_DAEMON_SPECS).join(', ')}`
    );
  }

  const repoRoot = pathResolver.rootDir();
  const nodePath = resolveStableNodePath();
  const uid = currentUid();
  const target = launchAgentTargetPath(spec.label);
  const logDir = path.join(os.homedir(), 'Library/Logs');
  const env = resolveForwardedChronosEnv(argv['forward-env'] as string[]);
  const plist = buildChronosLaunchdPlist({
    nodePath,
    repoRoot,
    logDir,
    label: spec.label,
    daemonScript: spec.daemonScript,
    daemonArgs: spec.daemonArgs,
    logBaseName: spec.logBaseName,
    startIntervalSec: spec.startIntervalSec,
    env,
  });

  if (argv.uninstall) {
    if (!argv.apply) {
      print(
        [
          '--- Uninstall steps (dry-run: nothing was changed) ---',
          `1. launchctl bootout gui/${uid}/${spec.label}`,
          `2. rm ${target}`,
          '',
          `Or run: pnpm kyberion scheduler uninstall --apply${daemonId === 'chronos' ? '' : ` --daemon ${daemonId}`}`,
        ].join('\n')
      );
      return;
    }
    if (process.platform !== 'darwin') {
      throw new Error(
        'launchd uninstall is macOS-only (use systemd on Linux — see docs/operator/DEPLOYMENT.md)'
      );
    }
    runOrThrow('launchctl', ['bootout', `gui/${uid}/${spec.label}`], true);
    runOrThrow('rm', ['-f', target]);
    logger.success(`[chronos-launchd] uninstalled ${spec.label} (${target} removed)`);
    return;
  }

  if (!argv.apply) {
    printManualSteps(plist, spec, target, uid, print);
    return;
  }

  if (process.platform !== 'darwin') {
    throw new Error(
      'launchd install is macOS-only (use systemd on Linux — see docs/operator/DEPLOYMENT.md)'
    );
  }

  const distDaemon = path.join(repoRoot, spec.daemonScript);
  if (!safeExistsSync(distDaemon)) {
    throw new Error(`dist build missing: ${distDaemon} — run \`pnpm build\` first`);
  }

  // Ensure the log directory the plist points at exists (governed exec —
  // ~/Library is outside the secure-io write root).
  runOrThrow('mkdir', ['-p', logDir]);

  // Stage under active/shared/tmp (secure-io write root), then copy into
  // ~/Library/LaunchAgents via governed exec — see header note.
  const staging = pathResolver.sharedTmp(`launchd/${spec.label}.plist`);
  safeWriteFile(staging, plist);
  runOrThrow('mkdir', ['-p', path.dirname(target)]);
  runOrThrow('cp', [staging, target]);
  // Re-bootstrap cleanly if an older agent is already loaded.
  runOrThrow('launchctl', ['bootout', `gui/${uid}/${spec.label}`], true);
  runOrThrow('launchctl', ['bootstrap', `gui/${uid}`, target]);
  logger.success(
    `[chronos-launchd] installed ${spec.label} at ${target} — verify with: launchctl print gui/${uid}/${spec.label} | head`
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
