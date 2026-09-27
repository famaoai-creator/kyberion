import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { getFoundationIo } from './foundation/io.js';
import * as pathResolver from './path-resolver.js';

/**
 * RN-01: opt-in observation of in-process role assumptions.
 *
 * With `KYBERION_ROLE_ASSUMPTION_TRACE=<path>` set, every
 * withExecutionContext / withExecutionContextAsync decision, and a delegated
 * child role decision (DR-01, `source: 'delegation'`, once per process), is
 * appended as one JSONL record `{system_role, assumed_role, allowed, caller, ts}`. The
 * traces are the observed-usage half of the evidence used to narrow
 * role-assumption-policy.json (AUTHORITY_MODEL.md section 3.B2); the other half
 * is scripts/analyze_role_assumptions.ts.
 *
 * - Zero cost when unset: one registered-env lookup per assumption.
 * - The target must be a `.jsonl` file inside a dedicated directory,
 *   `active/shared/tmp/role-assumption-trace/` or
 *   `active/shared/runtime/role-assumption-trace/` (both default_allow for
 *   every role), so the trace never needs a grant and never reaches a
 *   tier-governed store; no component of the path may be a symbolic link.
 *   Any other target is ignored with a single warning.
 * - The file is created with an exclusive create, then appended to. Writes go
 *   through the secure-io foundation bridge (authority.ts cannot import
 *   secure-io directly without a bootstrap cycle).
 * - Nothing here can change the decision: every step (path resolution
 *   included) runs inside one try; a failure is reported once and the trace
 *   is disabled for the rest of the process.
 */
export const ROLE_ASSUMPTION_TRACE_ENV = 'KYBERION_ROLE_ASSUMPTION_TRACE';

export const ROLE_ASSUMPTION_TRACE_DIRS = [
  'active/shared/tmp/role-assumption-trace/',
  'active/shared/runtime/role-assumption-trace/',
];

export interface RoleAssumptionTraceRecord {
  system_role: string | null;
  assumed_role: string;
  allowed: boolean;
  /**
   * `delegation` when the decision is a child's delegated role (DR-01,
   * KYBERION_DELEGATED_ROLE) rather than an in-process assumption; absent
   * for in-process assumptions.
   */
  source?: 'delegation';
  /** First stack frame outside the authority module, repo-relative (`file:line:col`). */
  caller: string | null;
  /** The caller and up to four further frames, to see through role-forwarding wrappers. */
  stack: string[];
  ts: string;
}

let writing = false;
let disabledReason: string | null = null;
let warnedPath: string | null = null;
const createdTargets = new Set<string>();

/** Test seam: forget a disabled trace / warned path / created files. */
export function resetRoleAssumptionTraceState(): void {
  writing = false;
  disabledReason = null;
  warnedPath = null;
  createdTargets.clear();
}

function rejectTracePath(value: string, reason: string): null {
  if (warnedPath !== value) {
    warnedPath = value;
    console.warn(
      `[ROLE_ASSUMPTION_TRACE] ignoring ${ROLE_ASSUMPTION_TRACE_ENV}=${value}: ${reason}`
    );
  }
  return null;
}

/**
 * Resolve the configured trace path, or null when tracing is off or the target
 * is not a `.jsonl` file in a dedicated trace directory reached without
 * symbolic links.
 */
export function resolveRoleAssumptionTracePath(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const root = pathResolver.rootDir();
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved).split(path.sep).join('/');
  const inDedicatedDir = ROLE_ASSUMPTION_TRACE_DIRS.some(
    (dir) => relative.startsWith(dir) && relative.length > dir.length
  );
  if (!inDedicatedDir || relative.includes('/../')) {
    return rejectTracePath(
      value,
      `the trace must live under ${ROLE_ASSUMPTION_TRACE_DIRS.join(' or ')}`
    );
  }
  if (!relative.endsWith('.jsonl')) {
    return rejectTracePath(value, 'the trace file must end in .jsonl');
  }
  try {
    // Throws on a symbolic link anywhere on the path, the leaf included.
    return pathResolver.assertSafeRepositoryPath(resolved, { allowMissingLeaf: true });
  } catch (err) {
    return rejectTracePath(value, err instanceof Error ? err.message : String(err));
  }
}

const AUTHORITY_FRAME =
  /[\\/]libs[\\/]core[\\/](?:dist[\\/])?(?:authority|role-assumption-trace|foundation[\\/]execution-scope)\.[cm]?[jt]s\b/;

/** Functions of the assumption path itself, recognised by name when bundled (Next.js chunks). */
const AUTHORITY_FUNCTIONS = new Set([
  'traceRoleAssumption',
  'captureStack',
  'assertRoleAssumptionAllowed',
  'resolveDelegatedRootScope',
  'acceptedRootScope',
  'currentExecutionScope',
  'scopedAssumedRole',
  'scopedPersona',
  'executionPersonaText',
  'prepareExecutionContext',
  'withExecutionContext',
  'withExecutionContextAsync',
]);

/** Top-level repo directories used to relativise a frame outside libs/core. */
const REPO_TOP_LEVEL =
  /(?:^|[\\/])((?:libs|presence|satellites|scripts|dist|plugins|tests)[\\/].*)$/;

function parseFrame(frame: string): { fn: string | null; location: string } | null {
  const withName = /^\s*at\s+(?:async\s+)?(.+?)\s+\(([^()]+)\)\s*$/.exec(frame);
  if (withName) return { fn: withName[1].trim(), location: withName[2].trim() };
  const bare = /^\s*at\s+(?:async\s+)?(.+)$/.exec(frame);
  return bare ? { fn: null, location: bare[1].trim() } : null;
}

const MAX_TRACE_FRAMES = 5;

/**
 * The stack frames outside authority.ts / this module (at most
 * {@link MAX_TRACE_FRAMES}) as `path:line:col` or `path:line:col (function)`,
 * relative to the checkout that holds libs/core (not KYBERION_ROOT, which may
 * be a hermetic runtime root). In bundles (Next.js chunks) the assumption path
 * is recognised by function name.
 */
export function callerFramesFromStack(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  let codeRoot: string | null = null;
  for (const line of stack.split('\n').slice(1)) {
    const parsed = parseFrame(line);
    if (!parsed) continue;
    const cleaned = parsed.location.replace(/^file:\/\//, '');
    const fnName = parsed.fn?.replace(/^(?:Object|Module)\./, '') ?? null;
    if (AUTHORITY_FRAME.test(cleaned)) {
      const index = cleaned.search(/[\\/]libs[\\/]core[\\/]/);
      if (index > 0 && !codeRoot) codeRoot = cleaned.slice(0, index);
      continue;
    }
    if (fnName && AUTHORITY_FUNCTIONS.has(fnName)) continue;
    if (cleaned.startsWith('node:') || cleaned.includes('node:internal')) continue;
    const relative =
      codeRoot && cleaned.startsWith(`${codeRoot}/`)
        ? cleaned.slice(codeRoot.length + 1)
        : (REPO_TOP_LEVEL.exec(cleaned)?.[1] ?? cleaned);
    frames.push(fnName ? `${relative} (${fnName})` : relative);
    if (frames.length >= MAX_TRACE_FRAMES) break;
  }
  return frames;
}

function captureStack(): string | undefined {
  const previousLimit = Error.stackTraceLimit;
  Error.stackTraceLimit = 30;
  try {
    return new Error().stack;
  } finally {
    Error.stackTraceLimit = previousLimit;
  }
}

/** Create the trace file exclusively once per process; a concurrent creator is fine. */
function ensureTraceFile(target: string): void {
  if (createdTargets.has(target)) return;
  const io = getFoundationIo();
  if (!io.exists(target)) {
    if (!io.createExclusiveFile) throw new Error('foundation io cannot create files exclusively');
    try {
      io.createExclusiveFile(target, '');
    } catch (err) {
      // Another process created it between the check and the create.
      if (!(err instanceof Error && /EEXIST/.test(err.message)) || !io.exists(target)) throw err;
    }
  }
  createdTargets.add(target);
}

/**
 * Record one assumption decision when tracing is enabled. Never throws and
 * never changes the decision: the caller decides before and after it.
 */
export function traceRoleAssumption(
  systemRole: string | undefined,
  assumedRole: string,
  allowed: boolean,
  source?: 'delegation'
): void {
  let entered = false;
  try {
    if (disabledReason || writing) return;
    const raw = getRegisteredEnvText(ROLE_ASSUMPTION_TRACE_ENV);
    if (!raw) return;
    writing = entered = true;
    const target = resolveRoleAssumptionTracePath(raw);
    if (!target) return;
    const frames = callerFramesFromStack(captureStack());
    const record: RoleAssumptionTraceRecord = {
      system_role: systemRole?.trim() ? systemRole.trim().toLowerCase() : null,
      assumed_role: assumedRole,
      allowed,
      ...(source ? { source } : {}),
      caller: frames[0] ?? null,
      stack: frames,
      ts: new Date().toISOString(),
    };
    ensureTraceFile(target);
    getFoundationIo().appendFile(target, `${JSON.stringify(record)}\n`);
  } catch (err) {
    try {
      disabledReason = err instanceof Error ? err.message : String(err);
      console.warn(`[ROLE_ASSUMPTION_TRACE] disabled after a failure: ${disabledReason}`);
    } catch {
      disabledReason = disabledReason ?? 'trace failure';
    }
  } finally {
    if (entered) writing = false;
  }
}
