import * as path from 'node:path';
import { getRegisteredEnvText } from './foundation/env.js';
import { getFoundationIo } from './foundation/io.js';
import * as pathResolver from './path-resolver.js';

/**
 * RN-01: opt-in observation of in-process role assumptions.
 *
 * With `KYBERION_ROLE_ASSUMPTION_TRACE=<path>` set, every
 * withExecutionContext / withExecutionContextAsync decision is appended as
 * one JSONL record `{system_role, assumed_role, allowed, caller, ts}`. The
 * traces are the observed-usage half of the evidence used to narrow
 * role-assumption-policy.json (AUTHORITY_MODEL.md section 3.B2); the other half
 * is scripts/analyze_role_assumptions.ts.
 *
 * - Zero cost when unset: one registered-env lookup per assumption.
 * - The path must stay under `active/shared/tmp/` or `active/shared/runtime/`
 *   (both default_allow for every role), so the trace never needs a grant and
 *   never reaches a tier-governed store. Any other path is ignored with a
 *   single warning.
 * - Writes go through the secure-io foundation bridge (authority.ts cannot
 *   import secure-io directly without a bootstrap cycle). A failing write never
 *   affects the assumption; it is reported once and the trace is disabled for
 *   the rest of the process.
 */
export const ROLE_ASSUMPTION_TRACE_ENV = 'KYBERION_ROLE_ASSUMPTION_TRACE';

const ALLOWED_TRACE_PREFIXES = ['active/shared/tmp/', 'active/shared/runtime/'];

export interface RoleAssumptionTraceRecord {
  system_role: string | null;
  assumed_role: string;
  allowed: boolean;
  /** First stack frame outside the authority module, repo-relative (`file:line:col`). */
  caller: string | null;
  /** The caller and up to four further frames, to see through role-forwarding wrappers. */
  stack: string[];
  ts: string;
}

let writing = false;
let disabledReason: string | null = null;
let warnedPath: string | null = null;

/** Test seam: forget a disabled trace / warned path. */
export function resetRoleAssumptionTraceState(): void {
  writing = false;
  disabledReason = null;
  warnedPath = null;
}

/**
 * Resolve the configured trace path, or null when tracing is off or the path
 * is outside the allowed runtime directories.
 */
export function resolveRoleAssumptionTracePath(raw: string | undefined): string | null {
  const value = raw?.trim();
  if (!value) return null;
  const root = pathResolver.rootDir();
  const resolved = path.resolve(root, value);
  const relative = path.relative(root, resolved).split(path.sep).join('/');
  if (ALLOWED_TRACE_PREFIXES.some((prefix) => relative.startsWith(prefix))) return resolved;
  if (warnedPath !== value) {
    warnedPath = value;
    console.warn(
      `[ROLE_ASSUMPTION_TRACE] ignoring ${ROLE_ASSUMPTION_TRACE_ENV}=${value}: the trace must live under ${ALLOWED_TRACE_PREFIXES.join(' or ')}`
    );
  }
  return null;
}

const AUTHORITY_FRAME =
  /[\\/]libs[\\/]core[\\/](?:dist[\\/])?(?:authority|role-assumption-trace)\.[cm]?[jt]s\b/;

function frameLocation(frame: string): string | null {
  const match = /\(([^()]+)\)\s*$/.exec(frame) ?? /^\s*at\s+(.+)$/.exec(frame);
  return match ? match[1].trim() : null;
}

const MAX_TRACE_FRAMES = 5;

/**
 * The stack frames outside authority.ts / this module (at most
 * {@link MAX_TRACE_FRAMES}), relative to the checkout that holds libs/core
 * (not KYBERION_ROOT, which may be a hermetic runtime root). Bundled frames
 * (e.g. Next.js chunks) are returned as-is.
 */
export function callerFramesFromStack(stack: string | undefined): string[] {
  if (!stack) return [];
  const frames: string[] = [];
  let codeRoot: string | null = null;
  for (const line of stack.split('\n').slice(1)) {
    const location = frameLocation(line);
    if (!location) continue;
    const cleaned = location.replace(/^file:\/\//, '');
    if (AUTHORITY_FRAME.test(cleaned)) {
      const index = cleaned.search(/[\\/]libs[\\/]core[\\/]/);
      if (index > 0 && !codeRoot) codeRoot = cleaned.slice(0, index);
      continue;
    }
    if (cleaned.startsWith('node:') || cleaned.includes('node:internal')) continue;
    frames.push(
      codeRoot && cleaned.startsWith(`${codeRoot}/`) ? cleaned.slice(codeRoot.length + 1) : cleaned
    );
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

/**
 * Record one assumption decision when tracing is enabled. Never throws.
 */
export function traceRoleAssumption(
  systemRole: string | undefined,
  assumedRole: string,
  allowed: boolean
): void {
  if (disabledReason || writing) return;
  const target = resolveRoleAssumptionTracePath(getRegisteredEnvText(ROLE_ASSUMPTION_TRACE_ENV));
  if (!target) return;
  writing = true;
  try {
    const frames = callerFramesFromStack(captureStack());
    const record: RoleAssumptionTraceRecord = {
      system_role: systemRole?.trim() ? systemRole.trim().toLowerCase() : null,
      assumed_role: assumedRole,
      allowed,
      caller: frames[0] ?? null,
      stack: frames,
      ts: new Date().toISOString(),
    };
    const line = `${JSON.stringify(record)}\n`;
    const io = getFoundationIo();
    // safeAppendFileSync does not create directories; the first record goes
    // through the atomic writer, which does.
    if (io.exists(target)) io.appendFile(target, line);
    else io.writeFile(target, line);
  } catch (err) {
    disabledReason = err instanceof Error ? err.message : String(err);
    console.warn(`[ROLE_ASSUMPTION_TRACE] disabled after a failed write: ${disabledReason}`);
  } finally {
    writing = false;
  }
}
