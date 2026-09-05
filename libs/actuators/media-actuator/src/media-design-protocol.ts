import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
} from '@agent/core/secure-io';
import { defineCatalog, isRecord } from '@agent/core/foundation';
import { loadProjectRecord } from '@agent/core/project-registry';
import { loadServiceBindingRecord } from '@agent/core/service-binding-registry';
import type { TenantDesignOverride } from '@agent/core/tenant-design-override';
import {
  resolveThemeColorRole as resolveThemeColorRolePolicy,
  resolveThemeHexRole as resolveThemeHexRolePolicy,
} from '@agent/core/media-theme-role-policy';
import {
  resolveDocumentProfileCandidates as resolveDocumentProfileCandidatesPolicy,
  resolveDocumentProfileKeywords as resolveDocumentProfileKeywordsPolicy,
} from '@agent/core/document-inference-policy';
import { createProposalPptxFlow } from './proposal-pptx-helpers.js';
import {
  createMediaDocumentPipelineHelpers,
  type MediaInvoicePdfProtocol,
  type MediaPptxProtocol,
} from './media-document-pipeline-helpers.js';
import type {
  MediaReportDocxProtocol,
  MediaReportPdfProtocol,
} from './media-report-pipeline-helpers.js';
import {
  buildMediaGenerationBoundary,
  resolveMediaBriefCategory,
  normalizeBriefForCategory,
  type ProtocolKind,
  buildReportNarrativeOutline,
  buildSpreadsheetNarrativeOutline,
  buildDiagramNarrativeOutline,
  type MediaCompositionPreset,
  type MediaDocumentCompositionCatalog,
  type MediaTheme,
} from './media-document-helpers.js';
import { generateDrawioDocument, normalizeFontFamily } from './media-diagram-render-helpers.js';
import { createMediaReportPipelineHelpers } from './media-report-pipeline-helpers.js';
import {
  createMediaSpreadsheetPipelineHelpers,
  normalizeXlsxDesignProtocol,
} from './media-spreadsheet-pipeline-helpers.js';
import type { MediaTrackerXlsxProtocol } from './media-spreadsheet-pipeline-helpers.js';
import { buildPptxSlideFromPattern as runtimeBuildPptxSlideFromPattern } from './media-layout-runtime.js';
import {
  loadConfidentialThemePack,
  type ConfidentialThemePack,
  type MediaDesignSystemDefinition,
  resolveConfidentialTenantOverride,
} from './media-catalog-loaders.js';
import * as path from 'node:path';
import { resolveEastAsianFontFamily } from '@agent/core/design-fonts';
import {
  loadSemanticRenderTokenCatalog as loadValidatedSemanticRenderTokenCatalog,
  resolveSemanticRenderTokens as resolveValidatedSemanticRenderTokens,
  type MediaPptxPalette,
  type SemanticRenderTokenCatalog,
  type SemanticRenderTokens,
} from './media-layout-design-tokens.js';
import {
  cloneJsonValue,
  deepMergeCatalog,
  readJsonFilesRecursively,
  loadMediaDesignSystemsCatalog,
} from './media-catalog-loaders.js';

function ensureParentDir(targetPath: string): void {
  const parentDir = path.dirname(targetPath);
  if (!safeExistsSync(parentDir)) {
    safeMkdir(parentDir, { recursive: true });
  }
}

type ArtifactLibraryCatalog = {
  profiles: Record<
    string,
    {
      artifact_family: string;
      document_type: string;
      description?: string;
      sections: Array<{
        section_id: string;
        title: string;
        layout_key: string;
      }>;
    }
  >;
};

interface MediaThemeCatalog {
  version: string;
  default_theme: string;
  themes: Record<string, MediaTheme>;
}

function loadArtifactLibraryCatalog(rootDir: string): ArtifactLibraryCatalog {
  const dirPath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/artifact-library'
  );
  const docs = readJsonFilesRecursively(dirPath);
  const aggregationSeed: ArtifactLibraryCatalog = { profiles: {} };
  const catalog = defineCatalog<ArtifactLibraryCatalog>({
    id: 'artifact-library',
    path: path.join(dirPath, 'index.json'),
    schema: path.resolve(rootDir, 'knowledge/product/schemas/artifact-library.schema.json'),
  });
  if (docs.length === 0) return catalog.load();
  const merged = docs.reduce((acc, doc) => {
    if (!isRecord(doc)) return acc;
    return deepMergeCatalog(acc, { profiles: doc.profiles || {} });
  }, cloneJsonValue(aggregationSeed));
  return catalog.validate(merged, dirPath);
}

function loadDocumentCompositionCatalog(rootDir: string): MediaDocumentCompositionCatalog {
  const aggregationSeed: MediaDocumentCompositionCatalog = { defaults: {}, profiles: {} };
  const catalog = defineCatalog<MediaDocumentCompositionCatalog>({
    id: 'document-composition-presets',
    path: path.resolve(
      rootDir,
      'knowledge/public/design-patterns/media-templates/document-composition-presets.json'
    ),
    schema: path.resolve(
      rootDir,
      'knowledge/product/schemas/document-composition-presets.schema.json'
    ),
  });
  const directoryPath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/document-composition-presets'
  );
  const docs = readJsonFilesRecursively(directoryPath);
  const primaryCatalog =
    docs.length === 0
      ? catalog.load()
      : catalog.validate(
          docs.reduce((acc, doc) => deepMergeCatalog(acc, doc), cloneJsonValue(aggregationSeed)),
          directoryPath
        );
  const artifactLibraryCatalog = loadArtifactLibraryCatalog(rootDir);
  return catalog.validate(
    {
      ...primaryCatalog,
      profiles: {
        ...(artifactLibraryCatalog.profiles || {}),
        ...(primaryCatalog.profiles || {}),
      },
    },
    directoryPath
  );
}

function loadThemeCatalog(rootDir: string): MediaThemeCatalog {
  const emptyScope: MediaThemeCatalog = {
    version: '1.0.0',
    default_theme: 'kyberion-standard',
    themes: {},
  };
  const schemaPath = path.resolve(rootDir, 'knowledge/product/schemas/media-themes.schema.json');
  const loadScope = (
    id: string,
    directoryPath: string,
    filePath: string,
    optional = false
  ): MediaThemeCatalog => {
    const catalog = defineCatalog<MediaThemeCatalog>({
      id,
      path: path.resolve(rootDir, filePath),
      schema: schemaPath,
      ...(optional ? { fallback: emptyScope } : {}),
    });
    const directory = path.resolve(rootDir, directoryPath);
    const docs = readJsonFilesRecursively(directory);
    if (docs.length === 0) return catalog.load();
    const merged = docs.reduce(
      (acc, doc) => deepMergeCatalog(acc, doc),
      cloneJsonValue(emptyScope)
    );
    return catalog.validate(merged, directory);
  };

  const publicCatalog = loadScope(
    'media-themes-public',
    'knowledge/public/design-patterns/media-templates/themes',
    'knowledge/public/design-patterns/media-templates/themes.json'
  );
  const runtimeCatalog = loadScope(
    'media-themes-runtime',
    'active/shared/runtime/design-patterns/media-templates/themes',
    'active/shared/runtime/design-patterns/media-templates/themes.json',
    true
  );
  const personalCatalog = loadScope(
    'media-themes-personal',
    'knowledge/personal/design-patterns/media-templates/themes',
    'knowledge/personal/design-patterns/media-templates/themes.json',
    true
  );
  const merged = deepMergeCatalog(deepMergeCatalog(publicCatalog, runtimeCatalog), personalCatalog);
  return defineCatalog({
    id: 'media-themes',
    path: path.resolve(rootDir, 'knowledge/public/design-patterns/media-templates/themes.json'),
    schema: schemaPath,
  }).validate(merged, 'media theme scope merge');
}

function loadConfidentialThemePackEntries(
  rootDir: string
): { theme_id: string; theme_name?: string; pack_path: string }[] {
  try {
    const confidentialDir = path.resolve(rootDir, 'knowledge/confidential');
    let tenantNames: string[] = [];
    try {
      tenantNames = safeReaddir(confidentialDir);
    } catch (err: unknown) {
      logger.warn(
        `[THEME_RESOLVER] safeReaddir failed on ${confidentialDir}: ${errorMessage(err)}`
      );
    }
    const entries: { theme_id: string; theme_name?: string; pack_path: string }[] = [];
    for (const tenantName of tenantNames) {
      const themePackPath = path.join(confidentialDir, tenantName, 'design', 'theme.json');
      if (!safeExistsSync(themePackPath)) continue;
      try {
        const pack = loadConfidentialThemePack(rootDir, themePackPath);
        const themeId = String(
          pack?.theme_id || pack?.theme?.theme_id || pack?.theme?.name || ''
        ).trim();
        if (!themeId) continue;
        entries.push({
          theme_id: themeId,
          theme_name: typeof pack.theme?.name === 'string' ? pack.theme.name : undefined,
          pack_path: `knowledge/confidential/${tenantName}/design/theme.json`,
        });
      } catch (err: unknown) {
        logger.warn(
          `[THEME_RESOLVER] Failed reading theme JSON for tenant ${tenantName}: ${errorMessage(err)}`
        );
        continue;
      }
    }
    return entries;
  } catch (err: unknown) {
    logger.warn(
      `[THEME_RESOLVER] loadConfidentialThemePackEntries general failure: ${errorMessage(err)}`
    );
    return [];
  }
}

function resolveConfidentialThemePack(
  rootDir: string,
  themeName: string
): ConfidentialThemePack | null {
  const normalized = String(themeName || '')
    .trim()
    .toLowerCase();
  if (!normalized) return null;

  // Try direct path first to bypass sandbox/secure-io directory listing limitations
  const potentialSlugs = [
    normalized,
    normalized.split('-')[0],
    normalized.replace('-imported', ''),
  ];
  for (const slug of potentialSlugs) {
    if (!slug) continue;
    const directPath = path.join(rootDir, 'knowledge/confidential', slug, 'design/theme.json');
    if (safeExistsSync(directPath)) {
      try {
        const pack = loadConfidentialThemePack(rootDir, directPath);
        const themeId = String(
          pack?.theme_id || pack?.theme?.theme_id || pack?.theme?.name || ''
        ).trim();
        if (
          themeId.toLowerCase() === normalized ||
          String(pack?.theme?.name || '').toLowerCase() === normalized
        ) {
          logger.info(
            `[THEME_RESOLVER] Direct resolved confidential theme pack from: ${directPath}`
          );
          return pack;
        }
      } catch (err: unknown) {
        logger.warn(`[THEME_RESOLVER] Direct load failed for ${directPath}: ${errorMessage(err)}`);
      }
    }
  }

  // Scan fallback
  for (const entry of loadConfidentialThemePackEntries(rootDir)) {
    if (
      entry.theme_id.toLowerCase() !== normalized &&
      String(entry.theme_name || '').toLowerCase() !== normalized
    ) {
      continue;
    }
    try {
      const packPath = assertSafeRepositoryPath(path.resolve(rootDir, entry.pack_path), {
        allowMissingLeaf: true,
      });
      return loadConfidentialThemePack(rootDir, packPath);
    } catch {
      continue;
    }
  }
  return null;
}

type ImportedDesignMdIndex = {
  generated_at: string;
  source_repo: string;
  source_dir: string;
  count: number;
  systems: Array<{
    design_system_id: string;
    theme_id: string;
    slug: string;
    name: string;
    category: string;
    description: string;
    source_path: string;
    keywords: string[];
  }>;
};

type ImportedDesignReference = ImportedDesignMdIndex['systems'][number];

type ImportedDesignRecommendation = Pick<
  ImportedDesignReference,
  'design_system_id' | 'theme_id' | 'slug' | 'name' | 'category' | 'description' | 'source_path'
> & {
  recommendation_score: number;
};

function loadImportedDesignMdIndex(rootDir: string): ImportedDesignMdIndex {
  const aggregationSeed: ImportedDesignMdIndex = {
    generated_at: '1970-01-01T00:00:00.000Z',
    source_repo: 'unavailable',
    source_dir: 'unavailable',
    count: 0,
    systems: [],
  };
  const catalog = defineCatalog<ImportedDesignMdIndex>({
    id: 'imported-design-md-index',
    path: path.resolve(
      rootDir,
      'knowledge/public/design-patterns/media-templates/design-md-catalog/index.json'
    ),
    schema: path.resolve(rootDir, 'knowledge/product/schemas/imported-design-md-index.schema.json'),
  });
  const directoryPath = path.resolve(
    rootDir,
    'knowledge/public/design-patterns/media-templates/design-md-catalog'
  );
  const docs = readJsonFilesRecursively(directoryPath);
  if (docs.length === 0) return catalog.load();
  const merged = docs.reduce(
    (acc, doc) => deepMergeCatalog(acc, doc),
    cloneJsonValue(aggregationSeed)
  );
  return catalog.validate(merged, directoryPath);
}

function normalizeDesignLookupKey(input: unknown): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function recordValue(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function resolveDesignBindingHints(brief: any): {
  tenant_id?: string;
  client_key?: string;
  design_system_id?: string;
  design_reference?: string;
  theme?: string;
  branding?: Record<string, unknown>;
} {
  const direct = {
    tenant_id:
      String(
        brief?.tenant_id ||
          brief?.payload?.tenant_id ||
          brief?.tenant_slug ||
          brief?.payload?.tenant_slug ||
          ''
      ).trim() || undefined,
    client_key: String(brief?.client_key || brief?.payload?.client_key || '').trim() || undefined,
    design_system_id:
      String(brief?.design_system_id || brief?.payload?.design_system_id || '').trim() || undefined,
    design_reference:
      String(brief?.design_reference || brief?.payload?.design_reference || '').trim() || undefined,
    theme: String(brief?.theme || brief?.payload?.theme || '').trim() || undefined,
    branding:
      brief?.branding && typeof brief.branding === 'object'
        ? brief.branding
        : brief?.payload?.branding && typeof brief.payload.branding === 'object'
          ? brief.payload.branding
          : {},
  };
  const projectId = String(brief?.project_id || brief?.payload?.project_id || '').trim();
  const project = projectId ? loadProjectRecord(projectId) : null;
  const projectMeta =
    project?.metadata && typeof project.metadata === 'object'
      ? (project.metadata as Record<string, unknown>)
      : {};
  const bindingIds = [
    ...(Array.isArray(project?.service_bindings) ? project!.service_bindings : []).map(
      (value: unknown) => String(value)
    ),
    ...(Array.isArray(brief?.service_binding_ids) ? brief.service_binding_ids : []).map(
      (value: unknown) => String(value)
    ),
    ...(Array.isArray(brief?.payload?.service_binding_ids)
      ? brief.payload.service_binding_ids
      : []
    ).map((value: unknown) => String(value)),
  ].filter(Boolean);
  const bindings = bindingIds
    .map((bindingId) => loadServiceBindingRecord(bindingId))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const bindingMeta =
    bindings
      .map((binding) =>
        binding.metadata && typeof binding.metadata === 'object'
          ? (binding.metadata as Record<string, unknown>)
          : {}
      )
      .find((meta) => Object.keys(meta).length > 0) || {};

  return {
    tenant_id:
      direct.tenant_id ||
      String(projectMeta.tenant_id || bindingMeta.tenant_id || '').trim() ||
      undefined,
    client_key:
      direct.client_key ||
      String(projectMeta.client_key || bindingMeta.client_key || '').trim() ||
      undefined,
    design_system_id:
      direct.design_system_id ||
      String(projectMeta.design_system_id || bindingMeta.design_system_id || '').trim() ||
      undefined,
    design_reference:
      direct.design_reference ||
      String(
        projectMeta.design_reference ||
          bindingMeta.design_reference ||
          bindingMeta.design_system_slug ||
          ''
      ).trim() ||
      undefined,
    theme: direct.theme || String(projectMeta.theme || bindingMeta.theme || '').trim() || undefined,
    branding: {
      ...recordValue(projectMeta.branding),
      ...recordValue(bindingMeta.branding),
      ...recordValue(direct.branding),
    },
  };
}

function resolveImportedDesignReference(
  rootDir: string,
  input: Record<string, unknown>
): ImportedDesignReference | null {
  const catalog = loadImportedDesignMdIndex(rootDir);
  const candidates = [
    input?.design_reference,
    input?.client_key,
    input?.tenant_id,
    input?.client,
    input?.project_name,
    input?.project_id,
  ]
    .map((value: unknown) => normalizeDesignLookupKey(value))
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const systems = Array.isArray(catalog.systems) ? catalog.systems : [];
  return (
    systems.find((entry: ImportedDesignReference) => {
      const values = [
        entry?.design_system_id,
        entry?.theme_id,
        entry?.slug,
        entry?.name,
        entry?.description,
        entry?.category,
        ...(Array.isArray(entry?.keywords) ? entry.keywords : []),
      ].map(normalizeDesignLookupKey);
      return candidates.some((candidate) =>
        values.some((value) => {
          if (!value) return false;
          if (value === candidate) return true;
          if (candidate.length >= 4 && value.includes(candidate)) return true;
          return false;
        })
      );
    }) || null
  );
}

function recommendImportedDesignReferences(
  rootDir: string,
  brief: any,
  limit = 3
): ImportedDesignRecommendation[] {
  const catalog = loadImportedDesignMdIndex(rootDir);
  const systems = Array.isArray(catalog.systems) ? catalog.systems : [];
  const haystack = normalizeDesignLookupKey(
    [
      brief?.design_reference,
      brief?.client,
      brief?.client_key,
      brief?.title,
      brief?.objective,
      brief?.summary,
      brief?.project_name,
      brief?.project_id,
      brief?.payload?.title,
      brief?.payload?.summary,
      brief?.payload?.client,
      brief?.story?.core_message,
      brief?.story?.closing_cta,
      brief?.payload?.story?.core_message,
      brief?.audience,
      brief?.payload?.audience,
    ]
      .filter(Boolean)
      .join(' ')
  );

  if (!haystack) return [];

  const scored = systems
    .map((entry: ImportedDesignReference) => {
      const terms = [
        entry?.slug,
        entry?.name,
        entry?.category,
        entry?.description,
        ...(Array.isArray(entry?.keywords) ? entry.keywords : []),
      ]
        .map(normalizeDesignLookupKey)
        .filter(Boolean);
      let score = 0;
      for (const term of terms) {
        if (!term) continue;
        if (haystack === term) score += 10;
        else if (haystack.includes(term))
          score += Math.min(6, Math.max(2, term.split(' ').length + 1));
        else if (term.includes(haystack)) score += 1;
      }
      return {
        ...entry,
        recommendation_score: score,
      };
    })
    .filter((entry) => entry.recommendation_score > 0)
    .sort((left: ImportedDesignRecommendation, right: ImportedDesignRecommendation) => {
      if (right.recommendation_score !== left.recommendation_score)
        return right.recommendation_score - left.recommendation_score;
      return String(left.design_system_id || '').localeCompare(
        String(right.design_system_id || '')
      );
    });

  return scored.slice(0, limit).map((entry: ImportedDesignRecommendation) => ({
    design_system_id: entry.design_system_id,
    theme_id: entry.theme_id,
    slug: entry.slug,
    name: entry.name,
    category: entry.category,
    description: entry.description,
    recommendation_score: entry.recommendation_score,
    source_path: entry.source_path,
  }));
}

function resolveMediaDesignSystem(
  rootDir: string,
  brief: any
): {
  designSystemId: string;
  system: MediaDesignSystemDefinition;
  tenantOverride: TenantDesignOverride | null;
  resolvedThemeName: string;
  branding: Record<string, unknown>;
  promptGuide: string[];
  sourceDesign?: Record<string, unknown> | null;
  recommendations: ImportedDesignRecommendation[];
} {
  const catalog = loadMediaDesignSystemsCatalog(rootDir);
  const bindingHints = resolveDesignBindingHints(brief);
  const recommendations = recommendImportedDesignReferences(rootDir, brief);
  const explicit = String(bindingHints.design_system_id || '').trim();
  const resolveTenantOverride = (_system: MediaDesignSystemDefinition, designSystemId?: string) => {
    const clientHint =
      bindingHints.tenant_id ||
      bindingHints.client_key ||
      brief?.client ||
      brief?.payload?.client ||
      '';
    const override = resolveConfidentialTenantOverride(rootDir, String(clientHint));
    if (override) return override;
    return designSystemId
      ? resolveConfidentialTenantOverride(rootDir, String(clientHint), designSystemId)
      : null;
  };
  const buildResult = (designSystemId: string, system: MediaDesignSystemDefinition) => {
    const tenantOverride = resolveTenantOverride(system, designSystemId);
    const promptGuide = Array.isArray(system?.metadata?.prompt_guide)
      ? system.metadata.prompt_guide.filter((value): value is string => typeof value === 'string')
      : [];
    return {
      designSystemId,
      system,
      tenantOverride,
      resolvedThemeName: String(
        bindingHints.theme || tenantOverride?.theme || system?.theme || 'kyberion-standard'
      ),
      branding: {
        ...(system?.branding || {}),
        ...(tenantOverride?.branding || {}),
        ...(bindingHints.branding || {}),
      },
      promptGuide,
      recommendations,
      sourceDesign:
        system?.metadata?.source_type === 'design-md'
          ? {
              source_type: system.metadata.source_type,
              source_repo: system.metadata.source_repo,
              source_path: system.metadata.source_path,
              slug: system.metadata.slug,
              category: system.metadata.category,
              description: system.metadata.description,
            }
          : null,
    };
  };
  if (explicit && catalog.systems?.[explicit]) {
    return buildResult(explicit, catalog.systems[explicit]);
  }
  const imported = resolveImportedDesignReference(rootDir, {
    ...bindingHints,
    client: brief?.client || brief?.payload?.client,
    project_name:
      brief?.project_name || brief?.payload?.project_name || brief?.name || brief?.payload?.name,
    project_id: brief?.project_id || brief?.payload?.project_id,
  });
  if (imported?.design_system_id && catalog.systems?.[imported.design_system_id]) {
    return buildResult(imported.design_system_id, catalog.systems[imported.design_system_id]);
  }
  const profileId = String(brief?.document_profile || '').trim();
  const matched = Object.entries(catalog.systems || {}).find(
    ([, system]: [string, MediaDesignSystemDefinition]) =>
      Array.isArray(system?.profiles) && system.profiles.includes(profileId)
  );
  if (matched) {
    return buildResult(matched[0], matched[1]);
  }
  const fallbackId = String(catalog.default_system || 'executive-standard');
  return buildResult(fallbackId, catalog.systems?.[fallbackId] || { theme: 'kyberion-standard' });
}

function loadSemanticRenderTokenCatalog(rootDir: string): SemanticRenderTokenCatalog {
  return loadValidatedSemanticRenderTokenCatalog(rootDir);
}

function resolveSemanticRenderTokens(
  rootDir: string,
  semanticType?: string,
  designSystemId?: string
): SemanticRenderTokens {
  return resolveValidatedSemanticRenderTokens(rootDir, semanticType, designSystemId);
}

function resolveSemanticComponentRule(
  rootDir: string,
  semanticType: string | undefined,
  medium: string,
  component: string
): Record<string, unknown> {
  const tokens = resolveSemanticRenderTokens(rootDir, semanticType);
  const mediumTokens = tokens[medium];
  if (!mediumTokens) return {};
  const componentTokens = mediumTokens[component];
  if (isRecord(componentTokens)) return { ...componentTokens };
  // PDF rules are defined directly under the medium rather than beneath a
  // component key. Preserve that schema shape while keeping docx component
  // lookups strict and fail-closed when the requested component is absent.
  return medium === 'pdf' ? { ...mediumTokens } : {};
}

function resolveNamedTheme(rootDir: string, preferredTheme?: string): MediaTheme | null {
  const catalog = loadThemeCatalog(rootDir);
  const themeName = String(preferredTheme || catalog.default_theme || 'kyberion-standard').trim();

  // 1. Try public theme directly
  const publicTheme = catalog.themes?.[themeName] || null;
  if (publicTheme) return publicTheme;

  // 2. Try confidential theme pack
  const confidentialPack = resolveConfidentialThemePack(rootDir, themeName);
  if (confidentialPack?.theme) {
    return {
      ...confidentialPack.theme,
      layout_templates: confidentialPack.layout_templates || null,
      pptx: confidentialPack.pptx || null,
      web: confidentialPack.web || null,
      kind: confidentialPack.kind || null,
    };
  }

  // 3. Fallback to default public theme
  return catalog.themes?.[catalog.default_theme] || null;
}

function resolveDocumentCompositionPresetCore(
  rootDir: string,
  brief: any
): { profileId: string; preset: MediaCompositionPreset } {
  const catalog = loadDocumentCompositionCatalog(rootDir);
  const profiles = catalog.profiles || {};
  const defaults = catalog.defaults || {};
  const artifactFamily = String(
    brief?.artifact_family || brief?.payload?.artifact_family || ''
  ).trim();
  const documentType = String(brief?.document_type || brief?.payload?.document_type || '').trim();
  const explicitProfile = String(
    brief?.document_profile || brief?.payload?.document_profile || brief?.profile_id || ''
  ).trim();

  const candidateProfiles = new Set<string>();
  if (explicitProfile) candidateProfiles.add(explicitProfile);
  if (artifactFamily && typeof defaults[artifactFamily] === 'string')
    candidateProfiles.add(defaults[artifactFamily]);
  if (documentType && typeof defaults[documentType] === 'string')
    candidateProfiles.add(defaults[documentType]);
  for (const candidate of resolveDocumentProfileCandidatesPolicy(documentType, artifactFamily)) {
    candidateProfiles.add(String(candidate));
  }

  const clueText = [
    brief?.title,
    brief?.summary,
    brief?.objective,
    brief?.document_type,
    brief?.document_profile,
    brief?.payload?.title,
    brief?.payload?.summary,
    brief?.payload?.objective,
    brief?.payload?.document_type,
    brief?.payload?.document_profile,
  ]
    .filter(Boolean)
    .map((value) => String(value).toLowerCase())
    .join(' ');
  const keywords = resolveDocumentProfileKeywordsPolicy(documentType, artifactFamily);
  const buildPreset = (profileId: string, preset: MediaCompositionPreset) => {
    const designSystem = resolveMediaDesignSystem(rootDir, {
      ...brief,
      document_profile: profileId,
      profile_id: profileId,
    });
    return {
      profileId,
      preset: {
        ...preset,
        design_system_id: designSystem.designSystemId,
        recommended_theme: designSystem.resolvedThemeName || preset.recommended_theme,
        branding: {
          ...(preset.branding || {}),
          ...(designSystem.branding || {}),
        },
        prompt_guide: Array.isArray(preset.prompt_guide)
          ? preset.prompt_guide
          : designSystem.promptGuide,
        source_design: preset.source_design || designSystem.sourceDesign || null,
        design_recommendations: Array.isArray(preset.design_recommendations)
          ? preset.design_recommendations
          : designSystem.recommendations,
      },
    };
  };

  for (const profileId of candidateProfiles) {
    const preset = profiles?.[profileId];
    if (!preset) continue;
    if (keywords.length === 0 || keywords.some((keyword) => clueText.includes(keyword))) {
      return buildPreset(profileId, preset);
    }
  }

  const defaultProfile = (key: string): string =>
    typeof defaults[key] === 'string' ? defaults[key] : '';
  const inferredProfileId =
    explicitProfile ||
    defaultProfile(artifactFamily) ||
    defaultProfile(documentType) ||
    defaultProfile('proposal') ||
    defaultProfile('report') ||
    defaultProfile('spreadsheet') ||
    defaultProfile('diagram');
  if (inferredProfileId && profiles?.[inferredProfileId]) {
    return buildPreset(inferredProfileId, profiles[inferredProfileId]);
  }

  for (const [profileId, preset] of Object.entries(profiles)) {
    if (!preset || typeof preset !== 'object') continue;
    if (artifactFamily && String(preset.artifact_family || '') !== artifactFamily) continue;
    if (documentType && String(preset.document_type || '') !== documentType) continue;
    return buildPreset(profileId, preset);
  }

  const fallbackId = String(
    defaults[artifactFamily] ||
      defaults[documentType] ||
      defaults.report ||
      defaults.proposal ||
      defaults.spreadsheet ||
      defaults.diagram ||
      'summary-report'
  );
  const profileId = profiles[fallbackId]
    ? fallbackId
    : profiles['summary-report']
      ? 'summary-report'
      : fallbackId;
  const preset = profiles[profileId] || profiles[fallbackId] || profiles['summary-report'] || {};
  return buildPreset(profileId, preset);
}

const buildPptxSlideFromPattern = (...args: Parameters<typeof runtimeBuildPptxSlideFromPattern>) =>
  runtimeBuildPptxSlideFromPattern(...args);

type DocumentCompositionPresetResolution = ReturnType<typeof resolveDocumentCompositionPresetCore>;

const mediaDocumentPipelineHelpers = createMediaDocumentPipelineHelpers({
  resolveNamedTheme,
  loadDocumentCompositionCatalog,
  buildPptxSlideFromPattern,
  buildProposalNarrativeOutline,
  buildReportNarrativeOutline,
  buildSpreadsheetNarrativeOutline,
  buildDiagramNarrativeOutline,
  buildReportDocxProtocol,
  buildReportPdfProtocol,
  buildTrackerSpreadsheetProtocol,
  buildDocumentPdfProtocol,
  normalizeXlsxDesignProtocol,
  resolveDocumentLayoutTemplate,
  resolveDocumentCompositionPreset,
  applyCompositionTemplate,
  buildMediaGenerationBoundary,
  normalizeBriefForCategory,
  resolveMediaBriefCategory,
  generateDrawioDocument,
});

const mediaReportPipelineHelpers = createMediaReportPipelineHelpers({
  resolveNamedTheme,
  resolveDocumentCompositionPreset,
  resolveDocumentLayoutTemplate,
  resolveSemanticComponentRule,
  themeToDocxStyleHints,
  themeToPptxPalette,
  normalizeFontFamily,
});
const mediaSpreadsheetPipelineHelpers = createMediaSpreadsheetPipelineHelpers({
  resolveNamedTheme,
  resolveDocumentCompositionPreset,
  resolveDocumentLayoutTemplate,
  loadSemanticRenderTokenCatalog,
});

function resolveDocumentCompositionPreset(
  rootDir: string,
  brief: any
): DocumentCompositionPresetResolution {
  return resolveDocumentCompositionPresetCore(rootDir, brief);
}

function buildOutlineDrivenPptxProtocol(
  rootDir: string,
  outline: any
): { protocol: MediaPptxProtocol; theme: any; themeName: string } {
  return mediaDocumentPipelineHelpers.buildOutlineDrivenPptxProtocol(rootDir, outline);
}

const proposalPptxFlow = createProposalPptxFlow({
  resolveDocumentCompositionPreset,
  buildMediaGenerationBoundary,
});

function buildPresentationPptxProtocol(
  rootDir: string,
  brief: any
): { protocol: MediaPptxProtocol; outline: any; theme: any; themeName: string } {
  return mediaDocumentPipelineHelpers.buildPresentationPptxProtocol(rootDir, brief);
}

function buildOutlineFromNormalizedBrief(
  rootDir: string,
  category: 'presentation' | 'document' | 'spreadsheet' | 'diagram',
  brief: any
): any {
  return mediaDocumentPipelineHelpers.buildOutlineFromNormalizedBrief(rootDir, category, brief);
}

function buildCompiledBriefContext(input: {
  rootDir: string;
  ctx: any;
  rawBrief: any;
  exportAs?: string;
  briefContextKey?: string;
}): any {
  return mediaDocumentPipelineHelpers.buildCompiledBriefContext(input);
}

async function renderCompiledProtocol(
  compiled: {
    protocol: any;
    protocolKind: ProtocolKind;
  },
  outPath: string,
  options?: any
): Promise<void> {
  return mediaDocumentPipelineHelpers.renderCompiledProtocol(compiled, outPath, options);
}

async function renderDiagramDocumentBrief(
  rootDir: string,
  brief: any,
  outPath: string,
  params: any,
  ctx: any,
  resolve: Function
): Promise<void> {
  return mediaDocumentPipelineHelpers.renderDiagramDocumentBrief(
    rootDir,
    brief,
    outPath,
    params,
    ctx,
    resolve
  );
}

function resolveObjectInput(
  ctx: any,
  params: any,
  resolve: Function,
  defaults: {
    paramKey?: string;
    fromKey?: string;
    opName: string;
  }
): any {
  return mediaDocumentPipelineHelpers.resolveObjectInput(ctx, params, resolve, defaults);
}

function compileBriefToDesignProtocol(
  rootDir: string,
  rawBrief: any
): {
  protocol: any;
  outline: any;
  theme: any;
  themeName: string;
  protocolKind: ProtocolKind;
  exportKey: string;
} {
  return mediaDocumentPipelineHelpers.compileBriefToDesignProtocol(rootDir, rawBrief);
}

function themeToPptxPalette(theme: MediaTheme | null): MediaPptxPalette {
  const nestedTheme = recordValue(theme?.theme);
  const colors = recordValue(theme?.colors ?? nestedTheme.colors);
  return {
    dk1: String(colors.primary || '#000000').replace('#', ''),
    dk2: String(colors.secondary || colors.text || '#44546A').replace('#', ''),
    lt1: String(colors.background || '#FFFFFF').replace('#', ''),
    lt2: String(colors.background || '#E7E6E6').replace('#', ''),
    accent1: String(colors.accent || '#38BDF8').replace('#', ''),
    accent2: String(colors.secondary || '#334155').replace('#', ''),
  };
}

function themeToDocxStyleHints(
  theme: MediaTheme | null,
  locale?: string
): { headingFont: string; bodyFont: string; accent: string } {
  const nestedTheme = recordValue(theme?.theme);
  const themeFonts = recordValue(theme?.fonts ?? nestedTheme.fonts);
  const heading = typeof themeFonts.heading === 'string' ? themeFonts.heading : undefined;
  const body = typeof themeFonts.body === 'string' ? themeFonts.body : undefined;
  const headingFont = normalizeFontFamily(
    locale?.startsWith('ja') ? resolveEastAsianFontFamily(heading || body) : heading || 'Aptos'
  );
  const bodyFont = normalizeFontFamily(
    locale?.startsWith('ja') ? resolveEastAsianFontFamily(body || heading) : body || 'Aptos'
  );
  const colors = recordValue(theme?.colors ?? nestedTheme.colors);
  return {
    headingFont,
    bodyFont,
    accent: String(colors.accent || '#2563eb').replace('#', ''),
  };
}

function resolveThemeColorRole(
  palette: MediaPptxPalette,
  accentHex: string,
  role?: string
): string {
  const resolvedRole = resolveThemeColorRolePolicy(role, 'secondary');
  switch (resolvedRole) {
    case 'accent':
      return accentHex || palette.accent1 || '2563EB';
    case 'primary':
      return palette.dk1 || '111827';
    default:
      return palette.dk2 || palette.dk1 || accentHex || '334155';
  }
}

function resolveThemeHexColor(
  themeColors: Record<string, unknown>,
  role?: string,
  fallback = '#334155'
): string {
  const resolvedRole = resolveThemeHexRolePolicy(role, 'secondary');
  switch (resolvedRole) {
    case 'accent':
      return String(themeColors.accent || fallback);
    case 'primary':
      return String(themeColors.primary || fallback);
    case 'background':
      return String(themeColors.background || '#F8FAFC');
    case 'success':
      return String(themeColors.success || '#DCFCE7');
    case 'warning':
      return String(themeColors.warning || '#FEF3C7');
    case 'info':
      return String(themeColors.info || '#DBEAFE');
    case 'muted':
      return String(themeColors.muted || '#F1F5F9');
    case 'surface':
      return String(themeColors.surface || themeColors.background_card || '#E9EDF4');
    case 'navy':
      return String(themeColors.navy || themeColors.primary_dark || fallback);
    case 'cta':
      return String(themeColors.cta || themeColors.azure || themeColors.accent || fallback);
    case 'text_primary':
      return String(themeColors.text_primary || themeColors.text || '#000000');
    case 'text_secondary':
      return String(themeColors.text_secondary || themeColors.secondary || '#595959');
    default:
      return String(themeColors.secondary || themeColors.text || fallback);
  }
}

function applyCompositionTemplate(
  template: any,
  tokens: Record<string, string>,
  fallback = ''
): string {
  return proposalPptxFlow.applyCompositionTemplate(template, tokens, fallback);
}

function normalizeProposalText(value: unknown): string {
  return proposalPptxFlow.normalizeProposalText(value);
}

function isPlaceholderProposalText(value: unknown): boolean {
  return proposalPptxFlow.isPlaceholderProposalText(value);
}

function sanitizeProposalText(value: unknown, fallback: string): string {
  return proposalPptxFlow.sanitizeProposalText(value, fallback);
}

function normalizeProposalList(value: unknown, fallback: string[]): string[] {
  return proposalPptxFlow.normalizeProposalList(value, fallback);
}

function normalizeAudienceList(value: unknown, fallback: string[]): string[] {
  return proposalPptxFlow.normalizeAudienceList(value, fallback);
}

function buildCanonicalProposalEvidence(brief: any): Array<{ title: string; point: string }> {
  return proposalPptxFlow.buildCanonicalProposalEvidence(brief);
}

function buildCanonicalProposalSlides(rootDir: string, brief: any): any[] {
  return proposalPptxFlow.buildCanonicalProposalSlides(rootDir, brief);
}

function buildProposalNarrativeOutline(rootDir: string, brief: any): any {
  return proposalPptxFlow.buildProposalNarrativeOutline(rootDir, brief);
}

function normalizeProposalBrief(rootDir: string, input: any): any {
  return proposalPptxFlow.normalizeProposalBrief(rootDir, input);
}

function buildReportDocxProtocol(rootDir: string, brief: any): MediaReportDocxProtocol {
  return mediaReportPipelineHelpers.buildReportDocxProtocol(rootDir, brief);
}

function buildReportPdfProtocol(rootDir: string, brief: any): MediaReportPdfProtocol {
  return mediaReportPipelineHelpers.buildReportPdfProtocol(rootDir, brief);
}

function buildTrackerSpreadsheetProtocol(rootDir: string, brief: any): MediaTrackerXlsxProtocol {
  return mediaSpreadsheetPipelineHelpers.buildTrackerSpreadsheetProtocol(rootDir, brief);
}
function resolveDocumentLayoutTemplate(
  rootDir: string,
  brief: any
): { templateId: string; template: any } {
  return mediaDocumentPipelineHelpers.resolveDocumentLayoutTemplate(rootDir, brief);
}

function buildDocumentPdfProtocol(rawBrief: any): MediaInvoicePdfProtocol {
  return mediaDocumentPipelineHelpers.buildDocumentPdfProtocol(rawBrief);
}

export {
  ensureParentDir,
  deepMergeCatalog,
  readJsonFilesRecursively,
  loadArtifactLibraryCatalog,
  loadDocumentCompositionCatalog,
  loadThemeCatalog,
  loadConfidentialThemePackEntries,
  resolveConfidentialThemePack,
  loadMediaDesignSystemsCatalog,
  loadImportedDesignMdIndex,
  normalizeDesignLookupKey,
  resolveDesignBindingHints,
  resolveImportedDesignReference,
  recommendImportedDesignReferences,
  resolveMediaDesignSystem,
  loadSemanticRenderTokenCatalog,
  resolveSemanticRenderTokens,
  resolveSemanticComponentRule,
  resolveNamedTheme,
  resolveDocumentCompositionPresetCore,
  resolveDocumentCompositionPreset,
  buildOutlineDrivenPptxProtocol,
  buildPresentationPptxProtocol,
  buildOutlineFromNormalizedBrief,
  buildCompiledBriefContext,
  resolveObjectInput,
  compileBriefToDesignProtocol,
  themeToPptxPalette,
  themeToDocxStyleHints,
  resolveThemeColorRole,
  resolveThemeHexColor,
  applyCompositionTemplate,
  normalizeProposalText,
  isPlaceholderProposalText,
  sanitizeProposalText,
  normalizeProposalList,
  normalizeAudienceList,
  buildCanonicalProposalEvidence,
  buildCanonicalProposalSlides,
  buildProposalNarrativeOutline,
  normalizeProposalBrief,
  buildReportDocxProtocol,
  buildReportPdfProtocol,
  buildTrackerSpreadsheetProtocol,
  resolveDocumentLayoutTemplate,
  buildDocumentPdfProtocol,
  renderCompiledProtocol,
  renderDiagramDocumentBrief,
};
