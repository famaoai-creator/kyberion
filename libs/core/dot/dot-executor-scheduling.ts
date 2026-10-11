/** Durable round-robin continuation, advanced before an executor awaits work. */
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { withExecutionContext } from '../authority.js';
import { readJsonIfPresent, writeJson } from '../foundation/json.js';
import { withLockSync } from '../foundation/lock-utils.js';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir } from '../secure-io.js';
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
  if (typeof state.after !== 'string' || !state.after)
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
