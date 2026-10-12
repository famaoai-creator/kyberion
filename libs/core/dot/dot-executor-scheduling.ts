/** Durable round-robin continuation, advanced before an executor awaits work. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { readJson, writeJson } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { pathResolver } from '../path-resolver.js';
import { safeLstat, safeMkdir } from '../secure-io.js';
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

/** Only a genuinely absent file starts a new order; corrupt evidence is never reset. */
function readExecutorSchedulingCursor(p: string): { after: string } | null {
  const invalid = () =>
    new Error('executor scheduling cursor is invalid or unreadable; operator recovery required');
  let stat: ReturnType<typeof safeLstat>;
  try {
    stat = safeLstat(p);
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code === 'ENOENT') return null;
    throw invalid();
  }
  // A dangling link or non-regular object is existing evidence, not missing state.
  if (!stat.isFile()) throw invalid();
  try {
    const value: unknown = readJson(p);
    if (isExecutorSchedulingCursor(value)) return value;
  } catch {
    // Even ENOENT after the metadata read is uncertainty, not initialization.
    // Do not expose parser/path details through the executor's warning or status.
  }
  throw invalid();
}

/** No lock or writes: inspect persisted evidence, never reset or advance the cursor. */
export function inspectExecutorSchedulingCursor(rootDir?: string): {
  state: 'recorded' | 'unrecorded' | 'blocked' | 'unknown';
  reason: string;
  next: string;
} {
  try {
    const value = readExecutorSchedulingCursor(file(rootDir));
    if (!value)
      return {
        state: 'unrecorded',
        reason: 'No persisted continuation; the executor uses its initial order.',
        next: 'Observe the next authorized sweep; absence alone does not prove a stalled executor.',
      };
    return {
      state: 'recorded',
      reason: 'Persisted cursor format is accepted; executor liveness is not established.',
      next: 'Use current work evidence below; this read does not advance the cursor.',
    };
  } catch {
    return {
      state: 'blocked',
      reason:
        'Scheduling cursor is invalid or unreadable; normal executor sweeps stop before claiming work. Scoped diagnostic passes do not use this cursor.',
      next: 'An operator must inspect and recover executor-schedule.json before another normal sweep; do not delete or reset it automatically.',
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
  const state = guarded(rootDir, readExecutorSchedulingCursor);
  if (!state) return ordered;
  const next = ordered.findIndex((row) => identity(row.charter) > state.after);
  return next < 0 ? ordered : [...ordered.slice(next), ...ordered.slice(0, next)];
}
export function recordExecutorTurn(c: DotCharter, rootDir?: string): void {
  guarded(rootDir, (p) => {
    // Ordering and recording hold separate locks; preserve corruption seen between turns.
    readExecutorSchedulingCursor(p);
    safeMkdir(path.dirname(p), { recursive: true });
    // Dot ids already occur in the shared WorkItem store. Scope remains hashed.
    writeJson(p, { after: identity(c) });
  });
}
