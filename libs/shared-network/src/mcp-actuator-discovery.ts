/**
 * Shared access to the generated `actuator-op-discovery.json` for the MCP
 * facade: memoized on file mtime so `capability.list`/`.search` and
 * `actuator.invoke` do not re-parse the full catalog per call, and tolerant
 * of the file being absent or stale (it is generated state — regenerate with
 * `pnpm generate:op-registry`).
 */
import {
  loadActuatorOpDiscoveryAtPath,
  type ActuatorOpDiscoveryFile,
  type ActuatorOpDiscoveryOperation,
} from '@agent/core/actuator/actuator-op-discovery';
import { pathResolver } from '@agent/core/path-resolver';
import { safeLstat } from '@agent/core/secure-io';

const DISCOVERY_PATH = pathResolver.knowledge('product/orchestration/actuator-op-discovery.json');

let memo: { mtimeMs: number; catalog: ActuatorOpDiscoveryFile | null } | null = null;

/**
 * Load the discovery catalog, or null when it is missing/unreadable. The
 * result is memoized on mtime; the missing case is intentionally not memoized
 * so a regenerated catalog is picked up on the next call.
 */
export function loadMcpActuatorOpDiscovery(): ActuatorOpDiscoveryFile | null {
  let mtimeMs: number | null;
  try {
    const stat = safeLstat(DISCOVERY_PATH);
    mtimeMs = typeof stat.mtimeMs === 'number' ? stat.mtimeMs : null;
  } catch {
    return null;
  }
  if (mtimeMs !== null && memo && memo.mtimeMs === mtimeMs) return memo.catalog;
  let catalog: ActuatorOpDiscoveryFile | null = null;
  try {
    catalog = loadActuatorOpDiscoveryAtPath(DISCOVERY_PATH);
  } catch {
    catalog = null;
  }
  if (mtimeMs !== null) memo = { mtimeMs, catalog };
  return catalog;
}

/** Op-name lists per lookup key (`n` and the directory basename). */
export function discoveryOpsByActuator(catalog: ActuatorOpDiscoveryFile): Map<string, string[]> {
  const byActuator = new Map<string, string[]>();
  for (const record of catalog.actuators || []) {
    const ops = (record?.ops || [])
      .map((entry) => (typeof entry?.op === 'string' ? entry.op : ''))
      .filter(Boolean);
    const keys = new Set<string>();
    if (record?.n) keys.add(record.n);
    const dirName = record?.path?.split('/').filter(Boolean).pop();
    if (dirName) keys.add(dirName);
    for (const key of keys) {
      const merged = byActuator.get(key) ?? [];
      for (const op of ops) if (!merged.includes(op)) merged.push(op);
      byActuator.set(key, merged);
    }
  }
  return byActuator;
}

/** Exact `n` match first, then the path basename — no substring matching. */
function discoveryRecordFor(
  catalog: ActuatorOpDiscoveryFile,
  actuatorIds: readonly string[]
): { ops: ActuatorOpDiscoveryOperation[] } | undefined {
  const wanted = new Set(actuatorIds.filter(Boolean));
  return (catalog.actuators || []).find(
    (entry) =>
      wanted.has(entry?.n) || wanted.has(entry?.path?.split('/').filter(Boolean).pop() ?? '')
  );
}

export function lookupDiscoveryOpEntry(
  catalog: ActuatorOpDiscoveryFile,
  actuatorIds: readonly string[],
  op: string
): ActuatorOpDiscoveryOperation | null {
  const record = discoveryRecordFor(catalog, actuatorIds);
  return record?.ops?.find((entry) => entry?.op === op) ?? null;
}
