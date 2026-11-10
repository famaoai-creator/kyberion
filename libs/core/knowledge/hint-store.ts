/**
 * D8 / MEMORY_LOOP_CLOSURE M3: the one runtime hint store.
 *
 * One API and one schema (`feedback-knowledge-hints.schema.json`), partitioned
 * by capture scope under the registered runtime root
 * `active/shared/runtime/hints/<tier>/<tenant|shared>/<category>.json`:
 * public hints live in `public/shared/`, a tenant's hints in
 * `confidential/<tenant>/`. A tenant hint is never written to a shared
 * partition, and personal hints are not stored here (owner-scoped learning
 * stays on the personal candidate queue).
 *
 * `HINTS.md` files are generated views of the `promoted` category (see
 * promoted-memory.ts): the product view from the public partition only, a
 * tenant view from that tenant's partition only.
 *
 * The pre-D8 unscoped directory `active/shared/runtime/feedback-loop/hints/`
 * is read-only legacy for one release (`readLegacyHints`).
 */
import * as path from 'node:path';
import { defineCatalog } from '../foundation/governed-catalog.js';
import { writeJson } from '../foundation/json.js';
import { getRegisteredEnvText } from '../foundation/env.js';
import { credentialBindingReadiness } from '../foundation/credential-binding.js';
import { PARTITIONED_RUNTIME_STATE_ROOTS } from '../foundation/runtime-state-roots.js';
import { pathResolver, vitestLivePath } from '../path-resolver.js';
import { assertSafeRepositoryPath, safeExistsSync, safeLstat, safeMkdir } from '../secure-io.js';
import { storagePartitionSegments } from '../storage-layout.js';
import type { KnowledgeHint } from './knowledge-index.js';

/** A persisted hint; `evidence_refs` is carried by promoted hints. */
export type StoredHint = KnowledgeHint & { evidence_refs?: string[] };

/** The scopes a hint can be captured in. */
export type HintScope = { tier: 'public' } | { tier: 'confidential'; tenant_slug: string };

const HINTS_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/feedback-knowledge-hints.schema.json'
);
/** @deprecated D8: pre-partition hint directory (Vitest-sandboxed), read-only for one release. */
export function legacyHintsDir(): string {
  return pathResolver.shared('runtime/feedback-loop/hints');
}

function catalogAt(filePath: string) {
  return defineCatalog<StoredHint[]>({
    id: 'feedback-knowledge-hints',
    path: filePath,
    schema: HINTS_SCHEMA_PATH,
  });
}

/** Strip leading/trailing '-' without a regex (an anchored `-+$` backtracks polynomially). */
function trimDashes(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && value[start] === '-') start += 1;
  while (end > start && value[end - 1] === '-') end -= 1;
  return value.slice(start, end);
}

export function sanitizeHintCategory(category: string): string {
  const normalized = trimDashes(
    String(category || 'auto-learned')
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9._-]+/g, '-')
  );
  return normalized || 'auto-learned';
}

/**
 * The capture scope of a hint. An explicit scope wins; otherwise the
 * credential-bound tenant of the running execution, else public. Personal
 * and tenantless confidential scopes are refused, never widened.
 */
export function resolveHintScope(scope?: { tier: string; tenant_slug?: string } | null): HintScope {
  if (scope) {
    if (scope.tier === 'public') return { tier: 'public' };
    const tenant = String(scope.tenant_slug || '').trim();
    if (scope.tier === 'confidential' && tenant)
      return { tier: 'confidential', tenant_slug: tenant };
    throw new Error(
      `[HINT_SCOPE_UNSUPPORTED] ${scope.tier} hint${tenant ? '' : ' without a tenant'} cannot be stored — hints live in public/shared or confidential/<tenant> | next: pass the mission's tenant scope, or keep owner-scoped learning on the personal candidate queue`
    );
  }
  const readiness = credentialBindingReadiness();
  const bound = readiness.status === 'bound' ? readiness.identity.tenantSlug : undefined;
  return bound ? { tier: 'confidential', tenant_slug: bound } : { tier: 'public' };
}

function hintStoreRoot(): string {
  const override = getRegisteredEnvText('KYBERION_HINT_STORE_ROOT')?.trim();
  return override || PARTITIONED_RUNTIME_STATE_ROOTS.hints;
}

/** Repository-safe absolute directory of one scope partition. */
export function hintPartitionDir(scope: HintScope): string {
  const segments = storagePartitionSegments(
    scope.tier === 'public'
      ? { kind: 'tier', tier: 'public' }
      : { kind: 'tier', tier: 'confidential', tenant: scope.tenant_slug }
  );
  // vitestLivePath: the default root is a live store, sandboxed under Vitest.
  return assertSafeRepositoryPath(
    vitestLivePath(pathResolver.rootResolve(path.join(hintStoreRoot(), ...segments))),
    { allowMissingLeaf: true }
  );
}

export function hintStorePath(category: string, scope: HintScope): string {
  return assertSafeRepositoryPath(
    path.join(hintPartitionDir(scope), `${sanitizeHintCategory(category)}.json`),
    { allowMissingLeaf: true }
  );
}

function omitUndefined(hint: StoredHint): StoredHint {
  return Object.fromEntries(
    Object.entries(hint).filter(([, value]) => value !== undefined)
  ) as StoredHint;
}

/** Load one hint file through its schema and path boundary (regular files only). */
export function loadHintFileAtPath(filePath: string): StoredHint[] {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: false });
  if (!safeExistsSync(safePath) || !safeLstat(safePath).isFile()) {
    throw new Error(`[FEEDBACK_HINTS_FILE] hints must be a regular file: ${filePath}`);
  }
  return catalogAt(safePath).load();
}

function loadOptional(filePath: string): StoredHint[] {
  if (!safeExistsSync(filePath)) return [];
  try {
    return loadHintFileAtPath(filePath);
  } catch {
    return [];
  }
}

/** Hints of one category in one scope partition (oldest first). */
export function readScopedHints(
  category: string,
  scope?: { tier: string; tenant_slug?: string } | null
): StoredHint[] {
  return loadOptional(hintStorePath(category, resolveHintScope(scope)));
}

/** One-release read of the pre-partition, unscoped hint directory. */
export function readLegacyHints(category: string): StoredHint[] {
  return loadOptional(
    assertSafeRepositoryPath(
      path.join(legacyHintsDir(), `${sanitizeHintCategory(category)}.json`),
      { allowMissingLeaf: true }
    )
  );
}

/**
 * Persist hints into their scope partition. New topics are appended; with
 * `replaceByTopic` an existing topic is updated in place. The newest `cap`
 * hints are kept. Returns the hints that were added or replaced.
 */
export function persistScopedHints(
  hints: StoredHint[],
  category: string,
  scope?: { tier: string; tenant_slug?: string } | null,
  options: { cap?: number; replaceByTopic?: boolean } = {}
): { path: string; written: StoredHint[]; total: number } {
  const resolved = resolveHintScope(scope);
  const filePath = hintStorePath(category, resolved);
  if (hints.length === 0) return { path: filePath, written: [], total: 0 };
  const existing = loadOptional(filePath);
  const byTopic = new Map(existing.map((hint, index) => [hint.topic, index]));
  const combined = [...existing];
  const written: StoredHint[] = [];
  for (const hint of hints) {
    const index = byTopic.get(hint.topic);
    if (index === undefined) {
      byTopic.set(hint.topic, combined.length);
      combined.push(hint);
      written.push(hint);
    } else if (options.replaceByTopic) {
      combined[index] = hint;
      written.push(hint);
    }
  }
  if (written.length === 0) return { path: filePath, written, total: existing.length };
  const kept = combined.slice(-(options.cap ?? 100)).map(omitUndefined);
  const validated = catalogAt(filePath).validate(kept, filePath);
  const dir = path.dirname(filePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  writeJson(filePath, validated);
  return { path: filePath, written, total: kept.length };
}
