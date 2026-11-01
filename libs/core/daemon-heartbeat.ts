import * as path from 'node:path';
import { defineCatalog } from './foundation/governed-catalog.js';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeMkdir,
  safeReaddir,
  safeLstat,
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
/**
 * A daemon that refreshes its heartbeat during a long tick (phase
 * `tick_in_progress` + `tick_started_at`, see chronos runTickWithHeartbeat)
 * is alive while the heartbeat is fresh — but a tick running longer than this
 * is hung or runaway and counts as unhealthy. Generous: a backup archive alone
 * may take up to 6h.
 */
export const DAEMON_TICK_IN_PROGRESS_MAX_MS = 8 * 60 * 60 * 1000;

/** Milliseconds a tick has been in progress, or null when no tick is in progress. */
export function tickInProgressAgeMs(
  heartbeat: Pick<DaemonHeartbeat, 'details'> | undefined,
  nowMs: number
): number | null {
  const details = heartbeat?.details;
  if (details?.phase !== 'tick_in_progress' || typeof details.tick_started_at !== 'string') {
    return null;
  }
  const startedMs = Date.parse(details.tick_started_at);
  return Number.isFinite(startedMs) ? Math.max(0, nowMs - startedMs) : null;
}
const DAEMON_HEARTBEAT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/daemon-heartbeat.schema.json'
);

function daemonHeartbeatCatalogAtPath(filePath: string) {
  return defineCatalog<DaemonHeartbeat>({
    id: 'daemon-heartbeat',
    path: filePath,
    schema: DAEMON_HEARTBEAT_SCHEMA_PATH,
  });
}

function heartbeatRoot(rootDir?: string): string {
  return assertSafeRepositoryPath(rootDir ?? pathResolver.shared('runtime/heartbeats'), {
    allowMissingLeaf: true,
  });
}

function heartbeatPath(daemonId: string, rootDir?: string): string {
  const safeId = daemonId.replace(/[^a-zA-Z0-9_.-]/g, '_');
  return assertSafeRepositoryPath(path.join(heartbeatRoot(rootDir), `${safeId}.json`), {
    allowMissingLeaf: true,
  });
}

/** Load one persisted heartbeat through the shared schema and daemon binding. */
export function loadDaemonHeartbeatAtPath(
  filePath: string,
  expectedDaemonId: string
): DaemonHeartbeat {
  const safeFilePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeLstat(safeFilePath).isFile()) {
    throw new Error(`[DAEMON_HEARTBEAT] heartbeat must be a regular file: ${filePath}`);
  }
  const heartbeat = daemonHeartbeatCatalogAtPath(safeFilePath).load();
  if (heartbeat.daemon_id !== expectedDaemonId) {
    throw new Error(
      `[DAEMON_HEARTBEAT_SCOPE_MISMATCH] heartbeat belongs to ${heartbeat.daemon_id}, expected ${expectedDaemonId}`
    );
  }
  return heartbeat;
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
  const validated = daemonHeartbeatCatalogAtPath(heartbeatPath(daemonId, root)).validate(
    heartbeat,
    heartbeatPath(daemonId, root)
  );
  safeWriteFile(heartbeatPath(daemonId, root), `${JSON.stringify(validated, null, 2)}\n`, {
    encoding: 'utf8',
  });
  return validated;
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
    const heartbeat = loadDaemonHeartbeatAtPath(filePath, daemonId);
    const now = (options.now ?? new Date()).getTime();
    const timestamp = new Date(heartbeat.timestamp).getTime();
    if (!Number.isFinite(timestamp)) {
      return { daemon_id: daemonId, status: 'malformed', reason: 'timestamp is invalid' };
    }
    const ageMs = now - timestamp;
    const staleAfterMs = options.staleAfterMs ?? DEFAULT_STALE_AFTER_MS;
    // A daemon that reports `stale_code` knows its loaded build is older than
    // the current dist — heartbeats may still be fresh, but the process must
    // be recycled onto the new build, so it counts as unhealthy.
    const staleCode = heartbeat.details?.stale_code === true;
    const tickAgeMs = tickInProgressAgeMs(heartbeat, now);
    const tickOverrun = tickAgeMs !== null && tickAgeMs > DAEMON_TICK_IN_PROGRESS_MAX_MS;
    const stale = ageMs > staleAfterMs || staleCode || tickOverrun;
    return {
      daemon_id: daemonId,
      status: stale ? 'stale' : 'healthy',
      age_ms: ageMs,
      heartbeat,
      ...(staleCode
        ? { reason: 'daemon reports stale_code (running build older than dist)' }
        : ageMs > staleAfterMs
          ? { reason: `heartbeat is older than ${staleAfterMs}ms` }
          : tickOverrun
            ? {
                reason: `tick in progress since ${String(heartbeat.details?.tick_started_at)} — longer than ${DAEMON_TICK_IN_PROGRESS_MAX_MS}ms`,
              }
            : {}),
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
    .map((name) => {
      const daemonId = path.basename(name, '.json');
      try {
        return readDaemonHeartbeat(daemonId, options);
      } catch (error) {
        return {
          daemon_id: daemonId,
          status: 'malformed' as const,
          reason: error instanceof Error ? error.message : String(error),
        };
      }
    });
}
