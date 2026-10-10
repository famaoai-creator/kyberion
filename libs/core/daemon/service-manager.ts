/**
 * libs/core/daemon/service-manager.ts — platform daemon persistence abstraction.
 *
 * Kyberion's resident daemons (chronos scheduler, generation schedule,
 * agent-runtime-supervisor, daemon-watchdog) need a per-user service manager
 * so they survive login and restart on failure. The mechanism differs by OS
 * (launchd on macOS, systemd user units on Linux), while the daemon spec is
 * identical — this module is that seam.
 *
 * Managers are pure planners: they render unit files and return the command
 * list the caller executes through the governed exec seam (`safeExecResult`).
 * No manager performs I/O itself, which keeps them trivially testable and
 * keeps host mutation in the script layer where --apply is enforced.
 *
 * Windows is intentionally unsupported: per docs/operator/DEPLOYMENT.md,
 * Windows-native daemons are managed through the surface commands
 * (`pnpm surfaces status` / `pnpm surfaces repair`), not OS service units.
 */
import { launchdManager } from './launchd.js';
import { systemdUserManager } from './systemd-user.js';

export interface DaemonServiceSpec {
  /** Value accepted by `--daemon` (kebab-case). */
  id: string;
  /**
   * System identity: launchd `Label` / plist stem (com.kyberion.*) on macOS;
   * on Linux the manager derives a systemd unit name from it.
   */
  label: string;
  /** Daemon entrypoint, relative to the repo root (compiled dist path). */
  daemonScript: string;
  /** Extra argv after daemonScript (e.g. flags a one-shot job needs). */
  daemonArgs?: string[];
  /** Log filename stem under the platform log dir. */
  logBaseName: string;
  /** Where to confirm the agent is doing its job (heartbeat file, alert log, …). */
  verificationHint: string;
  /**
   * Seconds between runs for periodic one-shot jobs (launchd StartInterval /
   * systemd timer unit). When set, the daemon must not be kept resident.
   */
  startIntervalSec?: number;
  /**
   * Restart only on non-zero exit — for daemons that exit cleanly when
   * another instance already owns the role. launchd: KeepAlive
   * {SuccessfulExit: false}; systemd: Restart=on-failure.
   */
  keepAliveOnCrashOnly?: boolean;
}

/** Everything a manager needs to render units for this host. */
export interface DaemonRenderContext {
  /** Absolute path to the node binary (prefer a version-stable symlink). */
  nodePath: string;
  /** Absolute repo root (WorkingDirectory). */
  repoRoot: string;
  /** Installing user's home directory. */
  homeDir: string;
  /** Numeric uid — launchd domains are gui/<uid>. */
  uid: string;
  /**
   * Directory under a secure-io write root where unit files are staged before
   * being copied into the service-manager location (~/Library, ~/.config are
   * outside the write roots and are only reachable through governed exec).
   */
  stagingDir: string;
  /** Extra daemon environment (allowlist-checked by the caller). */
  env?: Record<string, string>;
}

export interface DaemonCommand {
  /** argv for the governed exec seam. */
  run: string[];
  /** Non-zero exit is logged but not fatal (e.g. bootout before bootstrap). */
  tolerateFailure?: boolean;
  /** Human-readable purpose, echoed in dry-run output. */
  describe?: string;
}

export interface DaemonUnitFile {
  /** Staging path under ctx.stagingDir the caller writes with secure-io. */
  stagedPath: string;
  /** Final install location (e.g. ~/Library/LaunchAgents/<label>.plist). */
  targetPath: string;
  /** Rendered unit content. */
  content: string;
}

export interface DaemonPlan {
  /** Unit files to stage then copy into place (install only). */
  unitFiles: DaemonUnitFile[];
  /** Commands to execute, in order (install/uninstall/restart). */
  commands: DaemonCommand[];
  /** Dry-run: what a human would do by hand. */
  manualSteps: string[];
  /** Where the operator confirms the daemon is alive. */
  verificationHint: string;
}

export type DaemonManagerPlatform = 'launchd' | 'systemd-user';

export interface DaemonManager {
  readonly platform: DaemonManagerPlatform;
  planInstall(spec: DaemonServiceSpec, ctx: DaemonRenderContext): DaemonPlan;
  planUninstall(spec: DaemonServiceSpec, ctx: DaemonRenderContext): DaemonPlan;
  planRestart(spec: DaemonServiceSpec, ctx: DaemonRenderContext): DaemonPlan;
  /** Status probe for `status` verbs; null when the platform has none. */
  statusCommand(spec: DaemonServiceSpec, ctx: DaemonRenderContext): DaemonCommand | null;
}

/**
 * The service manager for this host, or null when the platform has no
 * user-level daemon persistence story (Windows: use the surface commands —
 * see docs/operator/DEPLOYMENT.md).
 */
export function resolveDaemonManager(
  platform: NodeJS.Platform = process.platform
): DaemonManager | null {
  if (platform === 'darwin') return launchdManager;
  if (platform === 'linux') return systemdUserManager;
  return null;
}
