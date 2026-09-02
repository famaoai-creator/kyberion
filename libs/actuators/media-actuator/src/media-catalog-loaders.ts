import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReaddir,
} from '@agent/core/secure-io';
import { loadTenantDesignOverrideIndex } from '@agent/core/tenant-design-resolver';
import { defineCatalog, readJson } from '@agent/core/foundation';
import * as path from 'node:path';

export function cloneJsonValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

export function deepMergeCatalog(base: any, next: any): any {
  if (Array.isArray(base) || Array.isArray(next)) return cloneJsonValue(next);
  if (!base || typeof base !== 'object') return cloneJsonValue(next);
  if (!next || typeof next !== 'object') return cloneJsonValue(next);
  const merged: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (
      value &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      merged[key] &&
      typeof merged[key] === 'object' &&
      !Array.isArray(merged[key])
    ) {
      merged[key] = deepMergeCatalog(merged[key], value);
    } else {
      merged[key] = cloneJsonValue(value);
    }
  }
  return merged;
}

export function readJsonFilesRecursively(dirPath: string): any[] {
  const safeDirPath = assertSafeRepositoryPath(dirPath, { allowMissingLeaf: true });
  if (!safeExistsSync(safeDirPath) || !safeLstat(safeDirPath).isDirectory()) return [];
  const entries = safeReaddir(safeDirPath).sort();
  const docs: any[] = [];
  for (const entry of entries) {
    const fullPath = path.join(safeDirPath, entry);
    const stat = safeLstat(fullPath);
    if (stat.isSymbolicLink()) continue;
    if (stat.isDirectory()) {
      docs.push(...readJsonFilesRecursively(fullPath));
      continue;
    }
    if (stat.isFile() && entry.endsWith('.json')) {
      docs.push(readJson(assertSafeRepositoryPath(fullPath)));
    }
  }
  return docs;
}

export function loadJsonValue(filePath: string): ReturnType<JSON['parse']> {
  return readJson(assertSafeRepositoryPath(filePath));
}

export interface ConfidentialThemePack {
  kind: 'pptx-theme-pack' | 'web-theme-pack';
  theme_id?: string;
  theme?: {
    theme_id?: unknown;
    name?: unknown;
  };
  [key: string]: unknown;
}

export function loadConfidentialThemePack(
  rootDir: string,
  filePath: string
): ConfidentialThemePack {
  const safePath = assertSafeRepositoryPath(filePath);
  const raw = readJson<unknown>(safePath);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error(`Confidential theme pack must be an object: ${safePath}`);
  }
  const kind = (raw as Record<string, unknown>).kind;
  const schemaFile =
    kind === 'pptx-theme-pack'
      ? 'knowledge/product/schemas/pptx-theme-pack.schema.json'
      : kind === 'web-theme-pack'
        ? 'knowledge/product/schemas/web-theme-pack.schema.json'
        : undefined;
  if (!schemaFile) {
    throw new Error(`Unsupported confidential theme pack kind at ${safePath}`);
  }
  return defineCatalog<ConfidentialThemePack>({
    id: `confidential-${kind}`,
    path: safePath,
    schema: path.resolve(rootDir, schemaFile),
  }).validate(raw, safePath);
}

export function loadDesignPattern(rootDir: string, filePath: string): any {
  return defineCatalog({
    id: 'design-pattern',
    path: assertSafeRepositoryPath(filePath, { allowMissingLeaf: true }),
    schema: path.resolve(rootDir, 'knowledge/product/schemas/design-pattern.schema.json'),
  }).load();
}

export function loadTenantEntries(rootDir: string): { override_path: string }[] {
  const entries: { override_path: string }[] = [];
  try {
    const registry = loadTenantDesignOverrideIndex(rootDir);
    entries.push(
      ...registry.tenants
        .filter((entry) => Boolean(entry.override_path))
        .map((entry) => ({ override_path: entry.override_path }))
    );
  } catch {
    // The registry is optional; use the deterministic directory fallback below.
  }
  try {
    const confidentialDir = assertSafeRepositoryPath(path.join(rootDir, 'knowledge/confidential'));
    const slugs = safeReaddir(confidentialDir).filter((name) => {
      try {
        const tenantPath = path.join(confidentialDir, name);
        return safeLstat(tenantPath).isDirectory() && !!assertSafeRepositoryPath(tenantPath);
      } catch {
        return false;
      }
    });
    entries.push(
      ...slugs.map((slug) => ({
        override_path: `knowledge/confidential/${slug}/design/tenant-override.json`,
      }))
    );
  } catch {
    // Confidential data may be unavailable in public-only environments.
  }
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (!entry.override_path || seen.has(entry.override_path)) return false;
    seen.add(entry.override_path);
    return true;
  });
}

let cachedTenantRegistry: { entries: { override_path: string }[] } | null = null;
export function resolveConfidentialTenantOverride(
  rootDir: string,
  brandName: string,
  designSystemId?: string
): any {
  if (!brandName) return null;
  try {
    cachedTenantRegistry ??= { entries: loadTenantEntries(rootDir) };
    const key = brandName.toLowerCase();
    for (const entry of cachedTenantRegistry.entries) {
      try {
        const override = loadJsonValue(
          assertSafeRepositoryPath(path.resolve(rootDir, entry.override_path), {
            allowMissingLeaf: true,
          })
        );
        if (
          designSystemId &&
          override.design_system_id &&
          override.design_system_id !== designSystemId
        ) {
          continue;
        }
        if (
          Array.isArray(override.matchers) &&
          override.matchers.some((matcher: string) => key.includes(matcher.toLowerCase()))
        ) {
          return override;
        }
      } catch {
        // Skip unreadable tenant overrides and continue with public defaults.
      }
    }
  } catch {
    // A missing tenant registry must not break rendering.
  }
  return null;
}

export function loadMediaDesignSystemsCatalog(rootDir: string): any {
  const fallback = {
    version: '1.0.0',
    default_system: 'executive-standard',
    systems: {},
  };
  const filePath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/media-design-systems.json'
  );
  const catalog = defineCatalog<{
    version: string;
    default_system: string;
    systems: Record<string, Record<string, unknown>>;
  }>({
    id: 'media-design-systems',
    path: filePath,
    schema: path.resolve(rootDir, 'knowledge/product/schemas/media-design-systems.schema.json'),
    fallback,
    fallbackOnInvalid: true,
  });
  const directoryPath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/media-design-systems'
  );
  const docs = readJsonFilesRecursively(directoryPath);
  if (docs.length === 0) return catalog.load();
  const merged = docs.reduce((acc, doc) => deepMergeCatalog(acc, doc), cloneJsonValue(fallback));
  return catalog.validate(merged, directoryPath);
}
