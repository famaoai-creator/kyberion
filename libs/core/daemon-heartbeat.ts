import * as path from 'node:path';
import {
  safeExistsSync,
  safeMkdir,
  safeReadFile,
  safeReaddir,
  safeWriteFile,
} from './secure-io.js';
import * as pathResolver from './path-resolver.js';

export interface DaemonHeartbeat {
  daemon_id: string;
  pid: number;
  status: 'starting' | 'running' | 'stopping' | 'error';
  timestamp: string;
  details?: Record<string, unknown>;
}

export interface DaemonHeartbeatStatus {
  daemon_id: string;
  status: 'healthy' | 'stale' | 'missing' | 'malformed';
  age_ms?: number;
  heartbeat?: DaemonHeartbeat;
  reason?: string;
}

export interface HeartbeatOptions {
  rootDir?: string;
  now?: Date;
  staleAfterMs?: number;
}

const DEFAULT_STALE_AFTER_MS = 3 * 60 * 1000;

function heartbeatRoot(rootDir?: string): string {
  return rootDir ?? pathResolver.shared('runtime/heartbeats');
}

function heartbeatPath(daemonId: string, rootDir?: string): string {
  const safeId = daemonId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return path.join(heartbeatRoot(rootDir), `${safeId}.json`);
}

export function recordDaemonHeartbeat(
  daemonId: string,
  input: Partial<Omit<DaemonHeartbeat, 'daemon_id' | 'timestamp'>> = {},
  options: HeartbeatOptions = {}
): DaemonHeartbeat {
  const root = heartbeatRoot(options.rootDir);
  if (!safeExistsSync(root)) safeMkdir(root, { recursive: true });
  const heartbeat: DaemonHeartbeat = {
    daemon_id: daemonId,
    pid: input.pid ?? process.pid,
    status: input.status ?? 'running',
    timestamp: (options.now ?? new Date()).toISOString(),
    ...(input.details ? { details: input.details } : {}),
  };
  safeWriteFile(heartbeatPath(daemonId, root), `${JSON.stringify(heartbeat, null, 2)}\n`, {
    encoding: 'utf8',
  });
  return heartbeat;
}

export function readDaemonHeartbeat(
  daemonId: string,
  options: HeartbeatOptions = {}
): DaemonHeartbeatStatus {
  const filePath = heartbeatPath(daemonId, options.rootDir);
  if (!safeExistsSync(filePath)) {
    return { daemon_id: daemonId, status: 'missing', reason: 'heartbeat file is missing' };
  }
  try {
    const raw = safeReadFile(filePath, { encoding: 'utf8' }) as string;
    const heartbeat = JSON.parse(raw) as DaemonHeartbeat;
    if (
      heartbeat.daemon_id !== daemonId ||
      typeof heartbeat.timestamp !== 'string' ||
      typeof heartbeat.pid !== 'number'
    ) {
      return { daemon_id: daemonId, status: 'malformed', reason: 'heartbeat shape is invalid' };
    }
    const now = (options.now ?? new Date()).getTime();
    const timestamp = new Date(heartbeat.timestamp).getTime();
    if (!Number.isFinite(timestamp)) {
      return { daemon_id: daemonId, status: 'malformed', reason: 'timestamp is invalid' };
    }
    const ageMs = now - timestamp;
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    return {
      daemon_id: daemonId,
      status: ageMs > staleAfterMs ? 'stale' : 'healthy',
      age_ms: ageMs,
      heartbeat,
      ...(ageMs > staleAfterMs ? { reason: `heartbeat is older than ${staleAfterMs}ms` } : {}),
    };
  } catch (error) {
    return {
      daemon_id: daemonId,
      status: 'malformed',
      reason: error instanceof Error ? error.message : String(error),
    };
  }
}

export function listDaemonHeartbeatStatuses(
  options: HeartbeatOptions = {}
): DaemonHeartbeatStatus[] {
  const root = heartbeatRoot(options.rootDir);
  if (!safeExistsSync(root)) return [];
  return safeReaddir(root)
    .filter((name) => name.endsWith('.json'))
    .map((name) => readDaemonHeartbeat(path.basename(name, '.json'), options));
}
