/**
 * The browser actuator's native pipeline format as a Run Manifest source
 * (pipeline-run-manifest-model.md §3.5).
 *
 * A native file is the browser actuator's own contract —
 * `{action: 'pipeline', session_id, options, context, steps: [{type, op, params}]}`
 * with bare op names (`goto`, `fill`, `if`) — run by the browser actuator
 * itself (`pnpm kyberion browser run --adf <file>`, or its CLI `--input`).
 * The whole file is one browser pipeline: every step, nested `if` / `while`
 * bodies included, is a `browser:*` step dispatched by its authored `type`.
 */
import * as path from 'node:path';
import { isRecord } from '../foundation/primitives.js';
import {
  storageFloorRelativePath,
  storagePartitionSegments,
  type StorageDataTier,
} from '../storage-layout.js';
import { pathResolver } from '../path-resolver.js';

/** `source.format` of a manifest compiled from a native browser pipeline. */
export const BROWSER_NATIVE_FORMAT = 'browser_native' as const;
export type RunManifestSourceFormat = typeof BROWSER_NATIVE_FORMAT;

/** The step kinds the browser actuator's engine dispatches by. */
const NATIVE_STEP_TYPES = new Set(['capture', 'transform', 'apply', 'control']);

/**
 * Nested step lists the browser actuator runs itself, by control op: the
 * runtime tags them with the same `<entry>.<key>.<index>` ids the compiler
 * assigns (`browser:if` → then/else, `browser:while` → pipeline).
 */
export const NATIVE_BROWSER_BODY_KEYS: Readonly<Record<string, readonly string[]>> = {
  if: ['then', 'else'],
  while: ['pipeline'],
};

/** The bare browser op of a native step (`browser:` prefix dropped). */
export function nativeBrowserOp(op: string): string {
  return op.replace(/^browser:/u, '');
}

/**
 * Whether a parsed JSON document is a native browser pipeline rather than a
 * pipeline ADF: `action: 'pipeline'`, every top-level step typed with an
 * engine kind and a bare or `browser:` op, and at least one bare op. A file
 * whose ops are all `browser:`-qualified is runnable by `pnpm pipeline` and is
 * treated as ADF.
 */
export function isNativeBrowserPipelineDocument(value: unknown): boolean {
  if (!isRecord(value) || value.action !== 'pipeline') return false;
  const steps = value.steps;
  if (!Array.isArray(steps) || steps.length === 0) return false;
  let bare = false;
  for (const step of steps) {
    if (!isRecord(step) || typeof step.op !== 'string' || !NATIVE_STEP_TYPES.has(String(step.type)))
      return false;
    if (!step.op.includes(':')) bare = true;
    else if (!step.op.startsWith('browser:')) return false;
  }
  return bare;
}

/**
 * The ADF-shaped view of native steps (`browser:<op>`, recursively through
 * the bodies the browser actuator runs and `on_error.fallback`). Used for the
 * static analyses that read qualified ops (model need, browser options,
 * `pipeline check`); the step's own `type` is kept, since the native engine
 * dispatches — and admits — by it.
 */
export function nativeBrowserManifestSteps(steps: unknown): unknown[] {
  if (!Array.isArray(steps)) return [];
  return steps.map((step) => {
    if (!isRecord(step) || typeof step.op !== 'string') return step;
    const op = nativeBrowserOp(step.op);
    const params = isRecord(step.params) ? { ...step.params } : step.params;
    if (isRecord(params))
      for (const key of NATIVE_BROWSER_BODY_KEYS[op] ?? [])
        if (Array.isArray(params[key])) params[key] = nativeBrowserManifestSteps(params[key]);
    const onError = isRecord(step.on_error) ? step.on_error : undefined;
    return {
      ...step,
      op: `browser:${op}`,
      ...(params !== undefined ? { params } : {}),
      ...(onError && Array.isArray(onError.fallback)
        ? { on_error: { ...onError, fallback: nativeBrowserManifestSteps(onError.fallback) } }
        : {}),
    };
  });
}

// ---------------------------------------------------------------------------
// Step-authored file writes
// ---------------------------------------------------------------------------

/**
 * The per-step approval a manifest-bound native run asks for before a step
 * writes a file outside the run's partition. Declared in the authorization
 * registry; never manifest-bindable, never delegable.
 */
export const NATIVE_WRITE_FILE_OPERATION = 'browser:write_file';

/** Ops whose `path` param names a file the step writes, and their default path. */
const WRITE_PATH_OPS: Readonly<Record<string, (sessionId: string) => string | undefined>> = {
  // The default screenshot directory is a write root.
  screenshot: () => 'evidence/browser/screenshot.png',
  export_playwright: (sessionId) => `active/shared/tmp/browser/${sessionId}-playwright.spec.ts`,
  export_adf: (sessionId) => `active/shared/tmp/browser/${sessionId}-pipeline.json`,
  export_failure_bundle: (sessionId) =>
    `active/shared/tmp/browser/${sessionId.replace(/[^a-zA-Z0-9._-]/gu, '_')}-failure-bundle.json`,
  // Without a path the handoff is only exported into the run context.
  export_session_handoff: () => undefined,
};

/** Browser ops whose `path` param names a file the step writes. */
export const NATIVE_WRITE_PATH_OPS: readonly string[] = Object.freeze(Object.keys(WRITE_PATH_OPS));

/**
 * Browser ops that read a step-supplied file into the browser (cookies,
 * storage, headers). Confined to the run partition under a binding.
 */
export const NATIVE_READ_PATH_OPS: readonly string[] = Object.freeze(['import_session_handoff']);

/**
 * Where a manifest-bound native run's steps may read a step-supplied file
 * (repo-relative): the run's own partitions only — its browser profile
 * partition and its scratch and artifact `browser/` directories. Never the
 * whole browser runtime directory (other tenants' profiles live there).
 */
export function nativeRunReadRoots(scope: { tier: string; tenant_slug?: string }): string[] {
  const partition = {
    kind: 'tier' as const,
    tier: scope.tier as StorageDataTier,
    ...(scope.tenant_slug ? { tenant: scope.tenant_slug } : {}),
  };
  return [
    path.posix.join(
      pathResolver.toRepoRelative(pathResolver.shared('runtime/browser/profiles')),
      ...storagePartitionSegments(partition)
    ),
    ...nativeRunWriteRoots(scope).slice(1),
  ];
}

/** Where a manifest-bound native run's steps may write files (repo-relative). */
export function nativeRunWriteRoots(scope: { tier: string; tenant_slug?: string }): string[] {
  const partition = {
    kind: 'tier' as const,
    tier: scope.tier as StorageDataTier,
    ...(scope.tenant_slug ? { tenant: scope.tenant_slug } : {}),
  };
  return [
    // The default screenshot directory (the surface identity an unbound
    // `browser run --adf` uses can write it too).
    'evidence/browser',
    storageFloorRelativePath('scratch', partition, 'browser'),
    storageFloorRelativePath('artifact', partition, 'browser'),
  ];
}

function withinRoot(relative: string, root: string): boolean {
  return relative === root || relative.startsWith(`${root}/`);
}

/** Repo-relative POSIX form of a literal path, or undefined when it may leave the repository. */
function literalRepoPath(value: string): string | undefined {
  if (!value.trim() || path.posix.isAbsolute(value) || /^[A-Za-z]:|\\/u.test(value))
    return undefined;
  const normalized = path.posix.normalize(value.trim());
  return normalized.startsWith('..') ? undefined : normalized.replace(/\/+$/u, '');
}

export interface NativeWritePath {
  /** The authored (or default) path; templates kept. */
  path: string;
  /** Statically inside a write root (a templated file name in a literal root directory counts). */
  confined: boolean;
  /** The same file name under the run's scratch partition. */
  suggested_path: string;
}

/**
 * The file a native write step writes, judged statically: confined when the
 * path is literal and inside a write root, or when only its final segment is
 * templated and its directory is a literal write root (the runtime still
 * refuses a resolved name that leaves it). Undefined for steps that write no
 * file. Used by the compiler (authored params) and the runtime (resolved).
 */
export function nativeWritePath(
  op: string,
  params: Record<string, unknown>,
  scope: { tier: string; tenant_slug?: string },
  sessionId = 'default'
): NativeWritePath | undefined {
  const fallback = WRITE_PATH_OPS[nativeBrowserOp(op)];
  if (!fallback) return undefined;
  const authored =
    typeof params.path === 'string' && params.path ? params.path : fallback(sessionId);
  if (authored === undefined) return undefined;
  const roots = nativeRunWriteRoots(scope);
  const slash = authored.lastIndexOf('/');
  const directory = slash < 0 ? '' : authored.slice(0, slash);
  const name = authored.slice(slash + 1) || 'output';
  const literalDirectory = !/\{\{/u.test(directory);
  const relative = literalDirectory
    ? literalRepoPath(/\{\{/u.test(name) ? `${directory}/x` : authored)
    : undefined;
  const confined =
    relative !== undefined &&
    !/\{\{[^}]*[/\\]/u.test(name) &&
    roots.some((root) => withinRoot(relative, root) && relative !== root);
  return { path: authored, confined, suggested_path: `${roots[1]}/${name}` };
}
