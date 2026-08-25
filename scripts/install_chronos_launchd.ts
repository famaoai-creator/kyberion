#!/usr/bin/env node
/**
 * scripts/install_chronos_launchd.ts — LC-01d
 *
 * Ceremony for keeping the chronos scheduler daemon alive across logins.
 * The daemon (`pnpm chronos`) is the ONLY scheduler in the system; when it
 * dies, every registered pipeline schedule silently stops firing. This
 * script generates a macOS LaunchAgent so launchd restarts it.
 *
 * Modes:
 *   pnpm chronos:install                 # dry-run: print plist + exact steps
 *   pnpm chronos:install -- --apply      # stage plist + run launchctl
 *   pnpm chronos:uninstall               # dry-run: print bootout steps
 *   pnpm chronos:uninstall -- --apply    # bootout + remove the plist
 *
 * secure-io note: $HOME/Library/LaunchAgents is outside the secure-io write
 * roots, so --apply never writes there via file I/O. The plist is staged
 * under active/shared/tmp/ with safeWriteFile and copied into place with a
 * governed `cp` through safeExecResult — the same governed-exec seam
 * ops-alert.ts uses for curl.
 */
import * as os from 'node:os';
import * as path from 'node:path';
import {
  createStandardYargs,
  escapeXml,
  logger,
  pathResolver,
  safeExecResult,
  safeExistsSync,
  safeWriteFile,
} from '@agent/core';
import { isDirectScript } from './lib/harness.js';

export const CHRONOS_LAUNCHD_LABEL = 'com.kyberion.chronos';

export interface ChronosLaunchdPlistOptions {
  /** Absolute path to the node binary (production: process.execPath). */
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
}

/** Pure plist generation — string in, string out, no I/O. */
export function buildChronosLaunchdPlist(options: ChronosLaunchdPlistOptions): string {
  const label = options.label ?? CHRONOS_LAUNCHD_LABEL;
  const daemonScript = path.join(options.repoRoot, 'dist/scripts/chronos_daemon.js');
  const stdoutPath = path.join(options.logDir, 'kyberion-chronos.log');
  const stderrPath = path.join(options.logDir, 'kyberion-chronos.err.log');
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
    <string>${escapeXml(daemonScript)}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>ThrottleInterval</key>
  <integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${escapeXml(pathEnv)}</string>
  </dict>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdoutPath)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderrPath)}</string>
</dict>
</plist>
`;
}

export function chronosLaunchAgentTargetPath(homeDir: string = os.homedir()): string {
  return path.join(homeDir, 'Library/LaunchAgents', `${CHRONOS_LAUNCHD_LABEL}.plist`);
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

function printManualSteps(plist: string, target: string, uid: string): void {
  console.log('--- LaunchAgent plist (generated) ---');
  console.log(plist);
  console.log('--- Install steps (dry-run: nothing was changed) ---');
  console.log(`1. Save the plist above to: ${target}`);
  console.log(`2. launchctl bootstrap gui/${uid} ${target}`);
  console.log(`3. Verify: launchctl print gui/${uid}/${CHRONOS_LAUNCHD_LABEL} | head`);
  console.log('   (heartbeat: active/shared/runtime/heartbeats/chronos-daemon.json)');
  console.log('');
  console.log(
    'Or run: pnpm chronos:install -- --apply  (if the flag is not forwarded: node dist/scripts/install_chronos_launchd.js --apply)'
  );
  console.log(
    `Uninstall later: launchctl bootout gui/${uid}/${CHRONOS_LAUNCHD_LABEL} && rm ${target}`
  );
}

async function main(): Promise<void> {
  const argv = await createStandardYargs()
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
    .parseSync();

  const repoRoot = pathResolver.rootDir();
  const nodePath = process.execPath;
  const uid = currentUid();
  const target = chronosLaunchAgentTargetPath();
  const logDir = path.join(os.homedir(), 'Library/Logs');
  const plist = buildChronosLaunchdPlist({ nodePath, repoRoot, logDir });

  if (argv.uninstall) {
    if (!argv.apply) {
      console.log('--- Uninstall steps (dry-run: nothing was changed) ---');
      console.log(`1. launchctl bootout gui/${uid}/${CHRONOS_LAUNCHD_LABEL}`);
      console.log(`2. rm ${target}`);
      console.log('');
      console.log('Or run: pnpm chronos:uninstall -- --apply');
      return;
    }
    if (process.platform !== 'darwin') {
      throw new Error(
        'launchd uninstall is macOS-only (use systemd on Linux — see docs/operator/DEPLOYMENT.md)'
      );
    }
    runOrThrow('launchctl', ['bootout', `gui/${uid}/${CHRONOS_LAUNCHD_LABEL}`], true);
    runOrThrow('rm', ['-f', target]);
    logger.success(`[chronos-launchd] uninstalled ${CHRONOS_LAUNCHD_LABEL} (${target} removed)`);
    return;
  }

  if (!argv.apply) {
    printManualSteps(plist, target, uid);
    return;
  }

  if (process.platform !== 'darwin') {
    throw new Error(
      'launchd install is macOS-only (use systemd on Linux — see docs/operator/DEPLOYMENT.md)'
    );
  }

  const distDaemon = path.join(repoRoot, 'dist/scripts/chronos_daemon.js');
  if (!safeExistsSync(distDaemon)) {
    throw new Error(`dist build missing: ${distDaemon} — run \`pnpm build\` first`);
  }

  // Ensure the log directory the plist points at exists (governed exec —
  // ~/Library is outside the secure-io write root).
  runOrThrow('mkdir', ['-p', logDir]);

  // Stage under active/shared/tmp (secure-io write root), then copy into
  // ~/Library/LaunchAgents via governed exec — see header note.
  const staging = pathResolver.sharedTmp(`launchd/${CHRONOS_LAUNCHD_LABEL}.plist`);
  safeWriteFile(staging, plist);
  runOrThrow('mkdir', ['-p', path.dirname(target)]);
  runOrThrow('cp', [staging, target]);
  // Re-bootstrap cleanly if an older agent is already loaded.
  runOrThrow('launchctl', ['bootout', `gui/${uid}/${CHRONOS_LAUNCHD_LABEL}`], true);
  runOrThrow('launchctl', ['bootstrap', `gui/${uid}`, target]);
  logger.success(
    `[chronos-launchd] installed ${CHRONOS_LAUNCHD_LABEL} at ${target} — verify with: launchctl print gui/${uid}/${CHRONOS_LAUNCHD_LABEL} | head`
  );
}

if (
  isDirectScript(import.meta.url, 'install_chronos_launchd.ts') ||
  isDirectScript(import.meta.url, 'install_chronos_launchd.js')
) {
  main().catch((err) => {
    logger.error(err?.message ?? String(err));
    process.exit(1);
  });
}
