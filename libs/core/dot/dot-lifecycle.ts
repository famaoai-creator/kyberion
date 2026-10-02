/**
 * Dot charter lifecycle — governed status transitions.
 *
 * `status` in a charter file is the only runtime switch a dot has, so it is
 * never hand-edited: `dot activate|pause|retire` go through
 * `transitionDotCharterStatus`, which enforces the activation gate from
 * MSN-RESIDENT-DOT-20261002's hard-won constraint — a dot must not become
 * active while its alert path is unauthorized. Activation therefore requires:
 *
 * - the charter validates against the schema;
 * - `authority.authority_role` resolves in the canonical role registry
 *   (`loadAuthorityRoleIndex`) — trigger-runner rejects unknown roles at
 *   delivery time, so a missing role must fail here, not mid-wake;
 * - `runtime.heartbeat_id` does not collide with a supervised daemon id or
 *   another active charter's heartbeat (a shared heartbeat would mask a
 *   silent dot in the watchdog report).
 *
 * Writes go through secure-io and preserve the file's `$schema` and key order.
 */

import * as path from 'node:path';
import { pathResolver } from '../path-resolver.js';
import { safeMkdir, safeReadFile, safeWriteFile } from '../secure-io.js';
import { parseSafeJsonObjectInput } from '../foundation/safe-json.js';
import { withExecutionContext } from '../authority.js';
import { recordDaemonHeartbeat } from '../daemon-heartbeat.js';
import { loadAuthorityRoleIndex } from '../organization/authority-role-registry.js';
import { appendJsonLine } from '../foundation/json.js';
import {
  listDotCharterPaths,
  loadDotCharter,
  validateDotCharter,
  type DotCharter,
  type DotCharterStatus,
} from './dot-charter.js';

export const DOT_LIFECYCLE_AUDIT_PATH = 'active/shared/runtime/dot-lifecycle-audit.jsonl';

/**
 * Charter files live at repo-root `dots/`; writes are made under the shared
 * coordination role (same pattern as mesh/peer-messaging store writers) so
 * the CLI process persona never needs direct `dots/` grants.
 */
const CHARTER_WRITER_ROLE = 'infrastructure_sentinel';

const TERMINAL_STATUSES: readonly DotCharterStatus[] = ['retired'];
const TRANSITIONS: Record<DotCharterStatus, readonly DotCharterStatus[]> = {
  draft: ['active', 'retired'],
  active: ['paused', 'retired'],
  paused: ['active', 'retired'],
  retired: [],
};

export interface DotLifecycleDeps {
  rootDir?: string;
  now?: () => Date;
  actor?: string;
  /** Daemon ids already supervised — injected by the watchdog caller/tests. */
  supervisedDaemonIds?: readonly string[];
  /** Injectable role-registry lookup for hermetic tests. */
  hasRole?: (role: string) => boolean;
}

function findCharterPath(dotId: string, rootDir?: string): string | null {
  for (const filePath of listDotCharterPaths(rootDir)) {
    try {
      if (loadDotCharter(filePath).dot_id === dotId) return filePath;
    } catch {
      // A malformed charter cannot be transitioned; skip it here and let
      // `dot validate` surface the parse error with its file name.
    }
  }
  return null;
}

function assertActivationReady(
  charter: DotCharter,
  deps: DotLifecycleDeps,
  allCharters: DotCharter[]
): void {
  const hasRole =
    deps.hasRole ?? ((role: string) => Boolean(loadAuthorityRoleIndex(deps.rootDir)[role]));
  if (!hasRole(charter.authority.authority_role)) {
    throw new Error(
      `[DOT_ACTIVATE_ROLE] authority_role '${charter.authority.authority_role}' is not in the canonical role registry (knowledge/product/governance/authority-roles/). Add the role card and re-run sync_authority_roles before activating.`
    );
  }
  const heartbeatId = charter.runtime.heartbeat_id;
  if ((deps.supervisedDaemonIds ?? []).includes(heartbeatId)) {
    throw new Error(
      `[DOT_ACTIVATE_HEARTBEAT] heartbeat_id '${heartbeatId}' collides with a supervised daemon id; a dot heartbeat must be distinct so the watchdog can attribute silence.`
    );
  }
  const colliding = allCharters.find(
    (other) =>
      other.dot_id !== charter.dot_id &&
      other.status === 'active' &&
      other.runtime.heartbeat_id === heartbeatId
  );
  if (colliding) {
    throw new Error(
      `[DOT_ACTIVATE_HEARTBEAT] heartbeat_id '${heartbeatId}' is already used by active dot '${colliding.dot_id}'.`
    );
  }
}

function auditTransition(entry: Record<string, unknown>, deps: DotLifecycleDeps): void {
  const auditPath = path.join(deps.rootDir ?? pathResolver.rootDir(), DOT_LIFECYCLE_AUDIT_PATH);
  safeMkdir(path.dirname(auditPath), { recursive: true });
  appendJsonLine(auditPath, {
    ts: (deps.now?.() ?? new Date()).toISOString(),
    actor: deps.actor ?? 'operator',
    ...entry,
  });
}

/**
 * Transition a charter's status through the governed path. Returns the updated
 * charter. Throws on an unknown dot, an illegal transition, or a failed
 * activation gate.
 */
export function transitionDotCharterStatus(
  dotId: string,
  target: DotCharterStatus,
  deps: DotLifecycleDeps = {}
): DotCharter {
  const filePath = findCharterPath(dotId, deps.rootDir);
  if (!filePath) {
    throw new Error(`[DOT_NOT_FOUND] no charter for dot_id '${dotId}' under dots/`);
  }
  const rawText = safeReadFile(filePath, { encoding: 'utf8' }) as string;
  const parsed = parseSafeJsonObjectInput(rawText, `dot charter ${filePath}`);
  const current = validateDotCharter(parsed, filePath);

  const allowed = TRANSITIONS[current.status] ?? [];
  if (!allowed.includes(target)) {
    throw new Error(
      `[DOT_TRANSITION] cannot move '${dotId}' from ${current.status} to ${target} (allowed: ${allowed.join(', ') || 'none'})`
    );
  }
  if (target === 'active') {
    const all = listDotCharterPaths(deps.rootDir)
      .map((p) => {
        try {
          return loadDotCharter(p);
        } catch {
          return null;
        }
      })
      .filter((c): c is DotCharter => c !== null);
    assertActivationReady(current, deps, all);
  }

  const next = { ...parsed, status: target };
  const validated = validateDotCharter(next, filePath);
  withExecutionContext(CHARTER_WRITER_ROLE, () => {
    safeWriteFile(filePath, `${JSON.stringify(next, null, 2)}\n`, { encoding: 'utf8' });
    auditTransition(
      {
        event: 'dot_status_transition',
        dot_id: dotId,
        from: current.status,
        to: target,
        path: filePath,
      },
      deps
    );
    // Activation seeds a heartbeat so the watchdog sees 'starting', not
    // 'missing', until the first real wake lands.
    if (target === 'active') {
      recordDaemonHeartbeat(
        validated.runtime.heartbeat_id,
        { status: 'starting', details: { dot_id: dotId, event: 'activated' } },
        deps.rootDir
          ? {
              rootDir: path.join(deps.rootDir, 'active/shared/runtime/heartbeats'),
            }
          : {}
      );
    }
  });
  return validated;
}

/** Non-mutating activation check used by `dot validate --gate`. */
export function checkDotActivationReadiness(
  charter: DotCharter,
  deps: DotLifecycleDeps = {}
): { ready: boolean; errors: string[] } {
  const errors: string[] = [];
  try {
    const all = listDotCharterPaths(deps.rootDir)
      .map((p) => {
        try {
          return loadDotCharter(p);
        } catch {
          return null;
        }
      })
      .filter((c): c is DotCharter => c !== null);
    assertActivationReady(charter, deps, all);
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  return { ready: errors.length === 0, errors };
}

export function isDotStatusTerminal(status: DotCharterStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}
