import { pathResolver } from './path-resolver.js';
import { safeReadFile, safeWriteFile, safeExistsSync } from './secure-io.js';
import * as path from 'node:path';
import * as nodePath from 'node:path';

export type ConfigFallbackReason = 'file_not_found' | 'parse_error' | 'unknown';

export interface ConfigFallbackEntry {
  knowledge_path: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  last_error: string;
  reason: ConfigFallbackReason;
  defaults_snapshot: unknown;
  resolved: boolean;
  resolved_at?: string;
}

interface FallbackRegistry {
  version: '1.0.0';
  entries: ConfigFallbackEntry[];
}

const REGISTRY_RELATIVE = nodePath.join('active', 'shared', 'tmp', 'config-fallback-registry.json');

function classifyError(err: unknown): ConfigFallbackReason {
  const msg = String(err instanceof Error ? err.message : err);
  if (/ENOENT|no such file/i.test(msg)) return 'file_not_found';
  if (/SyntaxError|Unexpected token|JSON\.parse/i.test(msg)) return 'parse_error';
  return 'unknown';
}

function readRegistry(): FallbackRegistry {
  try {
    const p = path.join(pathResolver.rootDir(), REGISTRY_RELATIVE);
    if (!safeExistsSync(p)) return { version: '1.0.0', entries: [] };
    return JSON.parse(safeReadFile(p, { encoding: 'utf8' }) as string) as FallbackRegistry;
  } catch {
    return { version: '1.0.0', entries: [] };
  }
}

function writeRegistry(registry: FallbackRegistry): void {
  try {
    const p = path.join(pathResolver.rootDir(), REGISTRY_RELATIVE);
    safeWriteFile(p, JSON.stringify(registry, null, 2));
  } catch { /* silent — observability must never break the caller */ }
}

/**
 * Record a config loader fallback. Call this from any loader's catch block.
 * Never throws. Does not write to the knowledge file — that is deferred to the reconcile pipeline.
 */
export function recordConfigFallback(opts: {
  knowledgePath: string;
  error: unknown;
  defaults: unknown;
}): void {
  try {
    const { knowledgePath, error, defaults } = opts;
    const now = new Date().toISOString();
    const reason = classifyError(error);
    const errorMsg = String(error instanceof Error ? error.message : error).slice(0, 500);

    const registry = readRegistry();
    const existing = registry.entries.find(e => e.knowledge_path === knowledgePath);

    if (existing) {
      existing.last_seen = now;
      existing.occurrence_count += 1;
      existing.last_error = errorMsg;
      existing.reason = reason;
      if (!existing.resolved) {
        existing.defaults_snapshot = defaults;
      }
    } else {
      registry.entries.push({
        knowledge_path: knowledgePath,
        first_seen: now,
        last_seen: now,
        occurrence_count: 1,
        last_error: errorMsg,
        reason,
        defaults_snapshot: defaults,
        resolved: false,
      });
    }

    writeRegistry(registry);
  } catch { /* never propagate */ }
}

/** Read all registry entries. Used by the reconcile script and pipeline. */
export function listFallbacks(): ConfigFallbackEntry[] {
  return readRegistry().entries;
}

/** Mark specific entries as resolved. Called by the reconcile script after repair. */
export function markResolved(knowledgePaths: string[]): void {
  try {
    const registry = readRegistry();
    const pathSet = new Set(knowledgePaths);
    for (const entry of registry.entries) {
      if (pathSet.has(entry.knowledge_path)) {
        entry.resolved = true;
        entry.resolved_at = new Date().toISOString();
      }
    }
    writeRegistry(registry);
  } catch { /* silent */ }
}

/** Remove all resolved entries. Called after a successful reconcile cycle. */
export function pruneResolved(): number {
  const registry = readRegistry();
  const before = registry.entries.length;
  registry.entries = registry.entries.filter(e => !e.resolved);
  writeRegistry(registry);
  return before - registry.entries.length;
}
