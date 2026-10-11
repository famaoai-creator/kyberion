/** Durable round-robin continuation, advanced before an executor awaits work. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { readJson, readJsonIfPresent, writeJson } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { pathResolver } from '../path-resolver.js';
import { safeExistsSync, safeMkdir } from '../secure-io.js';
import { DOT_STATE_ROOT } from './dot-state-paths.js';
import type { DotCharter, LoadedDotCharter } from './dot-charter.js';

function identity(c: DotCharter): string {
  return (
    c.dot_id +
    ':' +
    createHash('sha256')
      .update(JSON.stringify([c.scope.tenant_slug ?? null, c.scope.organization_id ?? null]))
      .digest('hex')
  );
}
function file(rootDir?: string): string {
  return path.join(rootDir ?? pathResolver.rootDir(), DOT_STATE_ROOT, 'executor-schedule.json');
}
/** The executor's existing shape check; deliberately does not change scheduling policy. */
export function isExecutorSchedulingCursor(value: unknown): value is { after: string } {
  return Boolean(
    value &&
    typeof (value as { after?: unknown }).after === 'string' &&
    (value as { after: string }).after
  );
}

/** No lock or writes: inspect persisted evidence, never reset or advance the cursor. */
export function inspectExecutorSchedulingCursor(rootDir?: string): {
  state: 'recorded' | 'unrecorded' | 'blocked' | 'unknown';
  reason: string;
  next: string;
} {
  try {
    const p = file(rootDir);
    if (!safeExistsSync(p))
      return {
        state: 'unrecorded',
        reason: 'No persisted continuation; the executor uses its initial order.',
        next: 'Observe the next authorized sweep; absence alone does not prove a stalled executor.',
      };
    const value: unknown = readJson(p);
    if (isExecutorSchedulingCursor(value))
      return {
        state: 'recorded',
        reason: 'Persisted cursor format is accepted; executor liveness is not established.',
        next: 'Use current work evidence below; this read does not advance the cursor.',
      };
    if (value)
      return {
        state: 'blocked',
        reason:
          'Persisted cursor shape is rejected; normal executor sweeps stop before claiming work.',
        next: 'An operator must inspect and recover executor-schedule.json before another normal sweep; do not delete or reset it automatically.',
      };
    return {
      state: 'unknown',
      reason:
        'Persisted cursor contains no usable continuation; the current executor falls back to initial ordering.',
      next: 'Ask an operator to inspect scheduling evidence; this is not proof the executor stopped.',
    };
  } catch {
    return {
      state: 'unknown',
      reason:
        'Scheduling evidence is malformed or unreadable; continuation is unknown. The current optional reader may fall back to initial ordering.',
      next: 'Ask an operator to inspect executor-schedule.json; no cursor was cleared or repaired.',
    };
  }
}

function guarded<T>(rootDir: string | undefined, fn: (p: string) => T): T {
  const p = file(rootDir);
  return withExecutionContext('infrastructure_sentinel', () =>
    withLockSync(
      'dot-executor-schedule:' + createHash('sha256').update(path.resolve(p)).digest('hex'),
      () => fn(p)
    )
  );
}
export function orderExecutorCharters(
  active: readonly LoadedDotCharter[],
  rootDir?: string
): LoadedDotCharter[] {
  const ordered = [...active].sort((a, b) =>
    identity(a.charter) < identity(b.charter)
      ? -1
      : identity(a.charter) > identity(b.charter)
        ? 1
        : 0
  );
  const state = guarded(rootDir, (p) => readJsonIfPresent<{ after: string }>(p));
  if (!state) return ordered;
  if (!isExecutorSchedulingCursor(state))
    throw new Error('executor scheduling cursor is invalid; operator recovery required');
  const next = ordered.findIndex((row) => identity(row.charter) > state.after);
  return next < 0 ? ordered : [...ordered.slice(next), ...ordered.slice(0, next)];
}
export function recordExecutorTurn(c: DotCharter, rootDir?: string): void {
  guarded(rootDir, (p) => {
    safeMkdir(path.dirname(p), { recursive: true });
    // Dot ids already occur in the shared WorkItem store. Scope remains hashed.
    writeJson(p, { after: identity(c) });
  });
}
