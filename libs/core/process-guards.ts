import { logger } from './core.js';

/**
 * IP-08 Task 6: long-lived servers (bridges, hubs, daemons) had no
 * process-level rejection/exception handlers — a floating promise or a
 * throw on an event-loop tick would either kill the process (exception)
 * or vanish silently (rejection). Install once per process: both events
 * are logged with the server's name; the process is NOT exited (these are
 * recording guards, not crash handlers — supervisors own restart policy).
 */

let installedAs: string | null = null;

// Identical process-level failures (a dead stderr re-throwing EIO on every
// log line, a persistently rejecting promise, …) previously produced one
// full-stack log line per occurrence — a self-amplifying file storm. Track
// per-signal signatures and emit at most one line per window, counting the
// suppressed duplicates into the next emission.
const guardDedup = new Map<string, { count: number; lastEmitAt: number }>();

/** Re-emit window for an identical guard signature. */
const GUARD_DEDUP_WINDOW_MS = 60_000;

/** Bound for the stack/detail carried on one guard line (file-size guard). */
const GUARD_DETAIL_MAX_CHARS = 2_000;

/** Test hook. */
export function resetProcessGuardDedupForTests(): void {
  guardDedup.clear();
}

function guardSignature(kind: string, detail: string): string {
  return `${kind} ${(detail.split('\n', 1)[0] ?? '').slice(0, 200)}`;
}

function emitGuarded(kind: string, name: string, detail: string): void {
  const trimmed =
    detail.length > GUARD_DETAIL_MAX_CHARS ? `${detail.slice(0, GUARD_DETAIL_MAX_CHARS)}…` : detail;
  const key = `${name} ${guardSignature(kind, trimmed)}`;
  const now = Date.now();
  const seen = guardDedup.get(key);
  if (seen && now - seen.lastEmitAt < GUARD_DEDUP_WINDOW_MS) {
    seen.count += 1;
    return;
  }
  const suppressed = seen?.count ?? 0;
  guardDedup.set(key, { count: 0, lastEmitAt: now });
  const suffix =
    suppressed > 0 ? ` (plus ×${suppressed} identical suppressed in the last 60s)` : '';
  if (kind === 'unhandledRejection') {
    logger.error(`[${name}] unhandledRejection: ${trimmed}${suffix}`);
  } else {
    logger.error(`[${name}] uncaughtException (process kept alive): ${trimmed}${suffix}`);
  }
}

export function installProcessGuards(name: string): void {
  if (installedAs) {
    if (installedAs !== name) {
      logger.info(`[process-guards] already installed as ${installedAs}; ${name} reuses them`);
    }
    return;
  }
  installedAs = name;

  process.on('unhandledRejection', (reason) => {
    const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason);
    emitGuarded('unhandledRejection', name, detail);
  });

  process.on('uncaughtException', (error) => {
    const detail = error instanceof Error ? (error.stack ?? error.message) : String(error);
    emitGuarded('uncaughtException', name, detail);
  });

  logger.info(`[process-guards] installed for ${name}`);
}

/** Test hook. */
export function resetProcessGuardsForTests(): void {
  installedAs = null;
}
