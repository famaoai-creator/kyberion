import { spawnManagedProcess } from '@agent/core/managed-process';
import { safeReadFile, safeExistsSync, safeMkdir } from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { logger } from '@agent/core/core';
import * as path from 'node:path';

/**
 * Cross-invocation session management for mirror daemons. Actuator CLI calls
 * are short-lived, so `start_screen_stream` spawns a detached node daemon
 * (mirror-daemon.js) that owns the HTTP server; `stop`/`status` coordinate
 * through the daemon's state file + SIGTERM.
 */
export interface MirrorDaemonSessionOptions {
  platform: 'ios' | 'android';
  /** iOS: simulator udid. Android: serial (empty = default device). */
  deviceId: string;
  stateFile: string;
  daemonPath: string;
  rootDir: string;
  resourceId: string;
  fps?: number;
  noInput?: boolean;
  waitMs?: number;
}

/** Stable per-(platform, device) state path — shared across CLI invocations. */
export function mirrorStateFilePath(platform: 'ios' | 'android', deviceId: string): string {
  return pathResolver.sharedTmp(`mobile-mirror/mirror-${platform}-${deviceId || 'default'}.json`);
}

export interface MirrorSessionInfo {
  pid?: number;
  platform?: string;
  device?: string;
  port?: number;
  token?: string;
  viewer_url?: string;
  stream_url?: string;
  tap_enabled?: boolean;
  state?: string;
  last_error?: string;
  started_at?: string;
}

export function readMirrorSession(stateFile: string): MirrorSessionInfo | null {
  if (!safeExistsSync(stateFile)) return null;
  try {
    const raw = safeReadFile(stateFile, { encoding: 'utf8' });
    return JSON.parse(String(raw)) as MirrorSessionInfo;
  } catch {
    return null;
  }
}

/**
 * Verify a recorded session is really our daemon before reusing it or sending
 * SIGTERM: the state file alone cannot distinguish a stale file + recycled
 * pid from a live mirror, so we ask the daemon itself.
 */
async function verifyDaemonResponds(state: MirrorSessionInfo): Promise<boolean> {
  if (!state.port || !state.pid || !isPidAlive(state.pid)) return false;
  try {
    const res = await fetch(
      `http://127.0.0.1:${state.port}/status?token=${encodeURIComponent(state.token ?? '')}`,
      { signal: AbortSignal.timeout(1500) }
    );
    if (!res.ok) return false;
    const status = (await res.json()) as { device?: string; tap_enabled?: boolean };
    return typeof status.device === 'string' && status.device === state.device;
  } catch {
    return false;
  }
}

export async function startMirrorDaemonSession(
  options: MirrorDaemonSessionOptions
): Promise<MirrorSessionInfo & { resource_id: string; state_file: string }> {
  const existing = readMirrorSession(options.stateFile);
  if (existing && (await verifyDaemonResponds(existing))) {
    return { ...existing, resource_id: options.resourceId, state_file: options.stateFile };
  }

  const args = [
    options.daemonPath,
    '--platform',
    options.platform,
    '--state-file',
    options.stateFile,
    '--fps',
    String(options.fps ?? 3),
  ];
  if (options.platform === 'ios') {
    args.push('--udid', options.deviceId);
  } else if (options.deviceId) {
    args.push('--serial', options.deviceId);
  }
  if (options.noInput) args.push('--no-input');

  safeMkdir(path.dirname(options.stateFile), { recursive: true });

  const managed = spawnManagedProcess({
    resourceId: options.resourceId,
    kind: 'service',
    ownerId: options.platform === 'ios' ? 'ios-actuator' : 'android-actuator',
    ownerType: 'actuator',
    command: 'node',
    args,
    shutdownPolicy: 'detached',
    spawnOptions: { detached: true, stdio: 'ignore', cwd: options.rootDir },
    metadata: { platform: options.platform, device: options.deviceId },
  });
  managed.child.unref();

  const deadline = Date.now() + (options.waitMs ?? 6000);
  while (Date.now() < deadline) {
    const state = readMirrorSession(options.stateFile);
    if (state?.port && state.pid === managed.child.pid) {
      return { ...state, resource_id: options.resourceId, state_file: options.stateFile };
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }

  throw new Error(
    `mirror daemon did not report a bound port within ${options.waitMs ?? 6000}ms (state file: ${options.stateFile})`
  );
}

export async function stopMirrorDaemonSession(
  stateFile: string
): Promise<{ stopped: boolean; pid?: number; reason?: string }> {
  const state = readMirrorSession(stateFile);
  if (!state?.pid) return { stopped: false };
  // Refuse to signal a pid we cannot prove is the mirror daemon — a stale
  // state file plus pid reuse could otherwise kill an unrelated process.
  if (!(await verifyDaemonResponds(state))) {
    return { stopped: false, pid: state.pid, reason: 'daemon-unverifiable' };
  }
  try {
    process.kill(state.pid, 'SIGTERM');
    logger.info(`[SHARED_MOBILE] mirror daemon ${state.pid} asked to stop (${stateFile})`);
    return { stopped: true, pid: state.pid };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    if (/ESRCH/.test(message)) return { stopped: false, pid: state.pid };
    throw error;
  }
}

function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
