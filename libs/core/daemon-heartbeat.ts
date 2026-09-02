import * as path from 'node:path';
import { readJson } from './foundation/json.js';
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
const DAEMON_HEARTBEAT_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/daemon-heartbeat.schema.json'
);

const daemonHeartbeatCatalog = defineCatalog<DaemonHeartbeat>({
  id: 'daemon-heartbeat',
  path: DAEMON_HEARTBEAT_SCHEMA_PATH,
  schema: DAEMON_HEARTBEAT_SCHEMA_PATH,
});

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
  const heartbeat = daemonHeartbeatCatalog.validate(readJson<unknown>(safeFilePath), safeFilePath);
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
  const validated = daemonHeartbeatCatalog.validate(heartbeat, heartbeatPath(daemonId, root));
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
