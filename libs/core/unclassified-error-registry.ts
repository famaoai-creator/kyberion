import { pathResolver } from './path-resolver.js';
import { nowIso } from './foundation/time.js';
import { defineCatalog } from './foundation/governed-catalog.js';
import { assertSafeRepositoryPath, safeExistsSync, safeMkdir, safeWriteFile } from './secure-io.js';
import * as nodePath from 'node:path';
import { createLogger } from './logger.js';
const logger = createLogger('unclassified-error-registry');

export interface UnclassifiedErrorEntry {
  message_excerpt: string;
  code?: string;
  first_seen: string;
  last_seen: string;
  occurrence_count: number;
  reconciled: boolean;
  reconciled_at?: string;
}

interface UnclassifiedErrorRegistry {
  version: '1.0.0';
  entries: UnclassifiedErrorEntry[];
}

const REGISTRY_RELATIVE = nodePath.join(
  'active',
  'shared',
  'tmp',
  'unclassified-error-registry.json'
);
const EXCERPT_LEN = 200;

// In-process cooldown: skip disk write if the same excerpt was recorded within 60 s.
const _recentWrites = new Map<string, number>();
const COOLDOWN_MS = 60_000;

function registryPath(): string {
  return nodePath.join(pathResolver.rootDir(), REGISTRY_RELATIVE);
}

const REGISTRY_SCHEMA_PATH = pathResolver.knowledge(
  'product/schemas/unclassified-error-registry.schema.json'
);

function registryCatalogAtPath(filePath: string) {
  return defineCatalog<UnclassifiedErrorRegistry>({
    id: 'unclassified-error-registry',
    path: filePath,
    schema: REGISTRY_SCHEMA_PATH,
    fallback: { version: '1.0.0', entries: [] },
    fallbackOnInvalid: true,
  });
}

function readRegistry(): UnclassifiedErrorRegistry {
  try {
    return registryCatalogAtPath(registryPath()).load();
  } catch {
    return { version: '1.0.0', entries: [] };
  }
}

function writeRegistry(registry: UnclassifiedErrorRegistry): void {
  try {
    writeUnclassifiedErrorRegistryAtPath(registryPath(), registry);
  } catch {
    /* observability must never break the caller */
  }
}

export function writeUnclassifiedErrorRegistryAtPath(
  filePath: string,
  registry: UnclassifiedErrorRegistry
): string {
  const safePath = assertSafeRepositoryPath(filePath, { allowMissingLeaf: true });
  const validated = registryCatalogAtPath(safePath).validate(registry, safePath);
  const dir = nodePath.dirname(safePath);
  if (!safeExistsSync(dir)) safeMkdir(dir, { recursive: true });
  safeWriteFile(safePath, JSON.stringify(validated, null, 2));
  return safePath;
}

/**
 * Record an error that matched no classification rule.
 * Call this when classifyError() would return ruleId === 'fallback'.
 * Never throws. Includes a 60 s in-process cooldown per excerpt to avoid disk churn.
 */
export function recordUnclassifiedError(message: string, code?: string | number): void {
  try {
    const excerpt = message.slice(0, EXCERPT_LEN);
    const codeStr = code !== undefined ? String(code) : undefined;
    const dedupeKey = `${excerpt}|${codeStr ?? ''}`;
    const now = Date.now();

    const lastWrite = _recentWrites.get(dedupeKey);
    if (lastWrite !== undefined && now - lastWrite < COOLDOWN_MS) return;
    _recentWrites.set(dedupeKey, now);

    const timestamp = new Date(now).toISOString();
    const registry = readRegistry();
    const existing = registry.entries.find(
      (e) => e.message_excerpt === excerpt && e.code === codeStr
    );

    if (existing) {
      existing.occurrence_count += 1;
      existing.last_seen = timestamp;
    } else {
      const entry: UnclassifiedErrorEntry = {
        message_excerpt: excerpt,
        first_seen: timestamp,
        last_seen: timestamp,
        occurrence_count: 1,
        reconciled: false,
      };
      if (codeStr !== undefined) entry.code = codeStr;
      registry.entries.push(entry);
    }

    writeRegistry(registry);
  } catch {
    /* never propagate */
  }
}

export function listUnclassifiedErrors(): UnclassifiedErrorEntry[] {
  return readRegistry().entries;
}

export function markReconciled(excerpts: string[]): void {
  try {
    const set = new Set(excerpts);
    const registry = readRegistry();
    const now = nowIso();
    for (const entry of registry.entries) {
      if (set.has(entry.message_excerpt)) {
        entry.reconciled = true;
        entry.reconciled_at = now;
      }
    }
    writeRegistry(registry);
  } catch (err) {
    logger.warn(`suppressed error in markReconciled: ${err}`);
  }
}

export function pruneReconciled(): number {
  try {
    const registry = readRegistry();
    const before = registry.entries.length;
    registry.entries = registry.entries.filter((e) => !e.reconciled);
    writeRegistry(registry);
    return before - registry.entries.length;
  } catch {
    return 0;
  }
}
