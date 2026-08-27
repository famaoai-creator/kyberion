import { loadJson, safeExistsSync, safeLstat, safeReaddir, safeStat } from '@agent/core';
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
  if (!safeExistsSync(dirPath)) return [];
  const entries = safeReaddir(dirPath).sort();
  const docs: any[] = [];
  for (const entry of entries) {
    const fullPath = path.join(dirPath, entry);
    const stat = safeLstat(fullPath);
    if (stat.isDirectory()) {
      docs.push(...readJsonFilesRecursively(fullPath));
      continue;
    }
    if (entry.endsWith('.json')) docs.push(loadJson(fullPath));
  }
  return docs;
}

export function loadJsonCatalog(
  rootDir: string,
  input: { directoryPath: string; filePath: string; fallback: any }
): any {
  const docs = readJsonFilesRecursively(path.resolve(rootDir, input.directoryPath));
  if (docs.length > 0) {
    return docs.reduce((acc, doc) => deepMergeCatalog(acc, doc), cloneJsonValue(input.fallback));
  }
  const filePath = path.resolve(rootDir, input.filePath);
  return safeExistsSync(filePath) ? loadJson(filePath) : cloneJsonValue(input.fallback);
}

export function loadJsonValue(filePath: string): ReturnType<JSON['parse']> {
  return loadJson(filePath);
}

export function loadTenantEntries(rootDir: string): { override_path: string }[] {
  const entries: { override_path: string }[] = [];
  const indexPath = path.join(rootDir, 'knowledge/confidential/tenants/index.json');
  try {
    const registry = loadJsonValue(indexPath);
    if (Array.isArray(registry.tenants)) {
      entries.push(...registry.tenants.filter((entry: any) => entry?.override_path));
    }
  } catch {
    // The registry is optional; use the deterministic directory fallback below.
  }
  try {
    const confidentialDir = path.join(rootDir, 'knowledge/confidential');
    const slugs = safeReaddir(confidentialDir).filter((name) => {
      try {
        return safeStat(path.join(confidentialDir, name)).isDirectory();
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
        const override = loadJsonValue(path.resolve(rootDir, entry.override_path));
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
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/media-design-systems',
    filePath: 'knowledge/public/design-patterns/media-templates/media-design-systems.json',
    fallback: { default_system: 'executive-standard', systems: {} },
  });
}
