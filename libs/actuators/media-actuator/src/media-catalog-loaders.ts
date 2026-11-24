import { loadJsonValue } from '@agent/core/creative-design-resolver';
export {
  cloneJsonValue,
  deepMergeCatalog,
  readJsonFilesRecursively,
  loadJsonValue,
  loadMediaDesignSystemsCatalog,
  type MediaDesignSystemDefinition,
  type MediaDesignSystemsCatalog,
} from '@agent/core/creative-design-resolver';
import { assertSafeRepositoryPath, safeLstat, safeReaddir } from '@agent/core/secure-io';
import { loadTenantDesignOverrideIndex } from '@agent/core/organization/tenant-design-resolver';
import {
  loadTenantDesignOverride,
  type TenantDesignOverride,
} from '@agent/core/organization/tenant-design-override';
import { defineCatalog, parseSafeJsonObjectValue } from '@agent/core/foundation';
import * as path from 'node:path';

export interface ConfidentialThemePack {
  kind: 'pptx-theme-pack' | 'web-theme-pack';
  theme_id?: string;
  theme?: {
    theme_id?: unknown;
    name?: unknown;
  };
  layout_templates?: unknown;
  pptx?: {
    master?: Record<string, unknown>;
    canvas?: Record<string, unknown>;
  };
  web?: Record<string, unknown>;
  [key: string]: unknown;
}

export function loadConfidentialThemePack(
  rootDir: string,
  filePath: string
): ConfidentialThemePack {
  const safePath = assertSafeRepositoryPath(filePath);
  const raw = parseSafeJsonObjectValue(
    loadJsonValue(safePath),
    `Confidential theme pack ${safePath}`
  );
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

export interface MediaDesignPattern {
  pattern_id: string;
  category: 'strategic' | 'technical' | 'analytical' | 'operational' | 'relational';
  target_audience: string;
  description?: string;
  layout_strategy: {
    visual_weight: 'visual_heavy' | 'balanced' | 'text_heavy';
    structure: string[];
    color_palette?: string;
  };
  content_data?: Array<{
    slide?: number;
    title?: string;
    subtitle?: string;
    body?: string | string[];
    visual?: string;
    [key: string]: unknown;
  }>;
  media_actuator_config?: {
    template_id?: string;
    engine: 'pptx' | 'puppeteer' | 'd2' | 'mermaid' | 'chartjs';
    output_format?: 'pptx' | 'pdf' | 'docx' | 'xlsx' | 'png' | 'svg';
    theme?: string;
    styles?: Record<string, unknown>;
  };
  [key: string]: unknown;
}

export function loadDesignPattern(rootDir: string, filePath: string): MediaDesignPattern {
  return defineCatalog<MediaDesignPattern>({
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
): TenantDesignOverride | null {
  if (!brandName) return null;
  try {
    cachedTenantRegistry ??= { entries: loadTenantEntries(rootDir) };
    const key = brandName.toLowerCase();
    for (const entry of cachedTenantRegistry.entries) {
      try {
        const overridePath = assertSafeRepositoryPath(path.resolve(rootDir, entry.override_path), {
          allowMissingLeaf: true,
        });
        const override = loadTenantDesignOverride(
          rootDir,
          overridePath,
          path.dirname(overridePath)
        );
        if (!override) continue;
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
