import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeStat,
  safeExec,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import { loadTenantDesignOverrideIndex } from '@agent/core/tenant-design-resolver';
import { retry } from '@agent/core/async-utils';
import {
  filterPptxSlides,
  generateNativeDocx,
  generateNativePdf,
  generateNativePptx,
  generateNativeXlsx,
  patchPptxText,
  patchPptxParagraphs,
} from '@agent/core/media-contracts';
import {
  assertMediaProtocolLayoutReady,
  summarizeMediaPptxLayout,
} from './media-document-pipeline-helpers.js';
import { registerPresentationPreferenceProfileOp } from './presentation-preference-ops.js';
import {
  warnLegacyMediaOp,
  buildUnifiedDocumentBrief,
  normalizeDiagramDocumentBrief,
} from './media-document-helpers.js';
import { buildMermaidConfig } from './media-diagram-helpers.js';
import {
  resolveDiagramSource,
  resolveDiagramTheme,
  deriveLayoutTemplateFromPptxDesign,
} from './media-diagram-render-helpers.js';
import { normalizeXlsxDesignProtocol } from './media-spreadsheet-pipeline-helpers.js';
import * as path from 'node:path';
import {
  ensureParentDir,
  loadDocumentCompositionCatalog,
  resolveObjectInput,
  compileBriefToDesignProtocol,
} from './media-design-protocol.js';

import {
  cloneJsonValue,
  buildRetryOptions,
  loadLayoutTemplateCatalog,
} from './media-layout-runtime.js';
import { opCapture, PDF_PYPDF_OPS } from './media-action-capture.js';
import { renderCompiledProtocol, renderDiagramDocumentBrief } from './media-design-protocol.js';

function resolveMediaRepositoryPath(rootDir: string, value: unknown, resolve: Function): string {
  return assertSafeRepositoryPath(path.resolve(rootDir, String(resolve(value))), {
    allowMissingLeaf: true,
  });
}

async function opApply(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = pathResolver.rootDir();
  if (PDF_PYPDF_OPS.has(op)) return opCapture(op, params, ctx, resolve);
  switch (op) {
    case 'register_presentation_preference_profile': {
      const result = registerPresentationPreferenceProfileOp({
        profile: params.profile !== undefined ? resolve(params.profile) : undefined,
        profile_path: params.profile_path ? resolve(params.profile_path) : undefined,
        registry_path: params.registry_path ? resolve(params.registry_path) : undefined,
      });
      return {
        ...ctx,
        [params.export_as || 'presentation_preference_profile_registered']: result,
      };
    }
    case 'mermaid_render': {
      const outPath = resolveMediaRepositoryPath(rootDir, params.path, resolve);
      const source = resolveDiagramSource(rootDir, params, ctx, resolve);
      ensureParentDir(outPath);

      const tempDir = pathResolver.sharedTmp(`actuators/media-actuator/diagram_${Date.now()}`);
      safeMkdir(tempDir, { recursive: true });

      const inputPath = path.join(tempDir, 'diagram.mmd');
      safeWriteFile(inputPath, source);

      const args = ['-i', inputPath, '-o', outPath];
      const activeTheme = resolveDiagramTheme(params, ctx);
      const mermaidConfig = buildMermaidConfig(
        activeTheme,
        params.background_color ? resolve(params.background_color) : undefined
      );
      const configPath = path.join(tempDir, 'mermaid.config.json');
      safeWriteFile(configPath, JSON.stringify(mermaidConfig, null, 2));
      args.push('-c', configPath);

      if (params.width) args.push('-w', String(resolve(params.width)));
      if (params.height) args.push('-H', String(resolve(params.height)));
      if (params.background_color) args.push('-b', String(resolve(params.background_color)));

      await retry(
        async () => safeExec('mmdc', args, { cwd: rootDir, timeoutMs: params.timeout_ms || 30000 }),
        buildRetryOptions()
      );

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Mermaid rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'd2_render': {
      const outPath = resolveMediaRepositoryPath(rootDir, params.path, resolve);
      const source = resolveDiagramSource(rootDir, params, ctx, resolve);
      ensureParentDir(outPath);

      const tempDir = pathResolver.sharedTmp(`actuators/media-actuator/diagram_${Date.now()}`);
      safeMkdir(tempDir, { recursive: true });

      const inputPath = path.join(tempDir, 'diagram.d2');
      safeWriteFile(inputPath, source);

      const args = [inputPath, outPath];
      if (params.layout) args.push('--layout', String(resolve(params.layout)));
      if (params.theme_id) args.push('--theme', String(resolve(params.theme_id)));
      if (params.sketch) args.push('--sketch');
      if (params.pad) args.push('--pad', String(resolve(params.pad)));

      await retry(
        async () => safeExec('d2', args, { cwd: rootDir, timeoutMs: params.timeout_ms || 30000 }),
        buildRetryOptions()
      );

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] D2 rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'document_diagram_render_from_brief': {
      warnLegacyMediaOp(op);
      const rawBrief = resolveObjectInput(ctx, params, resolve, {
        paramKey: 'brief',
        fromKey: params.from,
        opName: 'document_diagram_render_from_brief',
      });
      const brief = normalizeDiagramDocumentBrief(rawBrief);
      const outPath = resolveMediaRepositoryPath(
        rootDir,
        params.path || params.output_path,
        resolve
      );
      await renderDiagramDocumentBrief(rootDir, brief, outPath, params, ctx, resolve);
      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Diagram rendered from brief at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'pptx_render': {
      const baseProtocol = ctx[params.design_from || 'last_pptx_design'];
      // LE-01: a pipeline can opt the protocol into the engine design cascade
      // (or override per-key defaults) without editing the protocol JSON.
      const protocol =
        params.design_defaults !== undefined
          ? { ...baseProtocol, designDefaults: params.design_defaults }
          : baseProtocol;
      assertMediaProtocolLayoutReady(protocol, {
        allowLayoutOverflow: params.allow_layout_overflow === true,
      });
      const outPath = resolveMediaRepositoryPath(
        rootDir,
        params.path || params.output_path,
        resolve
      );

      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });

      await retry(async () => generateNativePptx(protocol, outPath), buildRetryOptions());

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] PPTX rendered at: ${outPath} (${stats.size} bytes).`);
      return {
        ...ctx,
        [params.export_as || 'media_render_diagnostics']:
          protocol?.metadata?.layoutDiagnostics || summarizeMediaPptxLayout(protocol),
      };
    }
    case 'pptx_patch': {
      const sourcePath = resolveMediaRepositoryPath(rootDir, params.source, resolve);
      const outPath = resolveMediaRepositoryPath(rootDir, params.path, resolve);
      const replacements =
        params.replacements || ctx[params.replacements_from || 'last_replacements'] || {};

      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });

      patchPptxText(sourcePath, outPath, replacements);

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] PPTX patched at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'pptx_filter_slides': {
      const sourcePath = resolveMediaRepositoryPath(rootDir, params.source, resolve);
      const outPath = resolveMediaRepositoryPath(rootDir, params.path, resolve);
      const keepIndices: number[] =
        params.keep_indices || ctx[params.keep_indices_from || 'last_keep_indices'] || [];

      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });

      filterPptxSlides(sourcePath, outPath, keepIndices);

      const stats = safeStat(outPath);
      logger.info(
        `✅ [MEDIA] PPTX filtered to slides [${keepIndices.join(',')}] at: ${outPath} (${stats.size} bytes).`
      );
      break;
    }
    case 'pptx_patch_paragraphs': {
      const sourcePath = resolveMediaRepositoryPath(rootDir, params.source, resolve);
      const outPath = resolveMediaRepositoryPath(rootDir, params.path, resolve);
      const replacements =
        params.paragraph_replacements ||
        ctx[params.replacements_from || 'last_paragraph_replacements'] ||
        [];

      if (!safeExistsSync(path.dirname(outPath)))
        safeMkdir(path.dirname(outPath), { recursive: true });

      const result = patchPptxParagraphs(sourcePath, outPath, replacements);

      const stats = safeStat(outPath);
      logger.info(
        `✅ [MEDIA] PPTX paragraph-patched (${result.match_count} matches across ${result.modified_slides.length} slide(s)) at: ${outPath} (${stats.size} bytes).`
      );
      break;
    }
    case 'xlsx_render': {
      const xlsxProtocol = normalizeXlsxDesignProtocol(
        ctx[params.design_from || 'last_xlsx_design']
      );
      const xlsxOutPath = resolveMediaRepositoryPath(
        rootDir,
        params.path || params.output_path,
        resolve
      );
      if (!safeExistsSync(path.dirname(xlsxOutPath)))
        safeMkdir(path.dirname(xlsxOutPath), { recursive: true });
      await retry(async () => generateNativeXlsx(xlsxProtocol, xlsxOutPath), buildRetryOptions());
      const xlsxStats = safeStat(xlsxOutPath);
      logger.info(`✅ [MEDIA] XLSX rendered at: ${xlsxOutPath} (${xlsxStats.size} bytes).`);
      break;
    }
    case 'docx_render': {
      const docxProtocol = ctx[params.design_from || 'last_docx_design'];
      const docxOutPath = resolveMediaRepositoryPath(
        rootDir,
        params.path || params.output_path,
        resolve
      );
      if (!safeExistsSync(path.dirname(docxOutPath)))
        safeMkdir(path.dirname(docxOutPath), { recursive: true });
      await retry(async () => generateNativeDocx(docxProtocol, docxOutPath), buildRetryOptions());
      const docxStats = safeStat(docxOutPath);
      logger.info(`✅ [MEDIA] DOCX rendered at: ${docxOutPath} (${docxStats.size} bytes).`);
      break;
    }
    case 'pdf_render': {
      const pdfProtocol = ctx[params.design_from || 'last_pdf_design'];
      const pdfOutPath = resolveMediaRepositoryPath(
        rootDir,
        params.path || params.output_path,
        resolve
      );
      if (!safeExistsSync(path.dirname(pdfOutPath)))
        safeMkdir(path.dirname(pdfOutPath), { recursive: true });
      await retry(
        async () => generateNativePdf(pdfProtocol, pdfOutPath, params.options),
        buildRetryOptions()
      );
      const pdfStats = safeStat(pdfOutPath);
      logger.info(`✅ [MEDIA] PDF rendered at: ${pdfOutPath} (${pdfStats.size} bytes).`);
      break;
    }
    case 'generate_document': {
      const fromKey = resolve(params.from) || 'last_json';
      const inlineData = params.data && typeof params.data === 'object' ? params.data : {};
      const source =
        params.brief && typeof params.brief === 'object'
          ? params.brief
          : ctx[fromKey] && typeof ctx[fromKey] === 'object'
            ? ctx[fromKey]
            : {};
      const renderTarget = String(
        params.render_target || source.render_target || inlineData.render_target || ''
      ).trim();
      const profileId = String(
        params.profile_id || source.document_profile || inlineData.document_profile || ''
      ).trim();
      const brief = buildUnifiedDocumentBrief(
        rootDir,
        {
          profileId,
          renderTarget,
          source,
          data: inlineData,
        },
        loadDocumentCompositionCatalog
      );
      const compiled = compileBriefToDesignProtocol(rootDir, brief);
      const outPath = resolveMediaRepositoryPath(
        rootDir,
        params.path || params.output_path,
        resolve
      );
      await renderCompiledProtocol(compiled, outPath, params.options);
      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Unified document generated at: ${outPath} (${stats.size} bytes).`);
      return {
        ...ctx,
        [params.export_as || 'media_render_diagnostics']:
          compiled.protocol?.metadata?.layoutDiagnostics ||
          summarizeMediaPptxLayout(compiled.protocol),
      };
    }
    case 'write_file':
      safeWriteFile(
        resolveMediaRepositoryPath(rootDir, params.path, resolve),
        ctx[params.from] || params.content
      );
      break;
    case 'drawio_write': {
      const outPath = resolveMediaRepositoryPath(rootDir, params.path, resolve);
      const content = ctx[params.from || 'last_drawio_document'] || resolve(params.content);
      if (typeof content !== 'string' || !content.trim()) {
        throw new Error('drawio_write requires XML content via params.from or params.content');
      }
      ensureParentDir(outPath);
      safeWriteFile(outPath, content);
      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Draw.io document written at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'save_brand_to_confidential': {
      // Writes tenant-override.json + layout-templates.json to confidential tier,
      // then registers the tenant in knowledge/confidential/tenants/index.json.
      const tenantSlug: string = resolve(params.tenant_slug) || ctx.tenant_slug;
      const brandName: string = resolve(params.brand_name) || ctx.brand_name || tenantSlug;
      const matchers: string[] = params.matchers
        ? Array.isArray(params.matchers)
          ? params.matchers
          : [resolve(params.matchers)]
        : [brandName.toLowerCase()];
      const dsId: string =
        resolve(params.design_system_id) || ctx.design_system_id || 'executive-standard';
      const theme: any = ctx[resolve(params.theme_from) || 'active_theme'] || {};
      const webTheme: any =
        ctx[resolve(params.web_theme_from) || 'active_web_theme'] || ctx.active_web_theme || null;
      const webSnapshot: any =
        ctx[resolve(params.web_from) || 'web_snapshot'] || ctx.active_web_snapshot || null;
      const layoutGeo: any = ctx[resolve(params.layout_from) || 'last_layout_geometry'] || {};
      const pptxDesign: any =
        ctx[resolve(params.pptx_from) || 'source_pptx_design'] || ctx.active_pptx_design || null;
      const isWebPack = Boolean(webTheme);
      const webHeritage = webTheme?.web
        ? cloneJsonValue(webTheme.web)
        : webSnapshot
          ? cloneJsonValue(webSnapshot)
          : null;
      const webLayoutTemplates =
        webTheme?.layout_templates || webHeritage?.layout_templates || null;
      const extractedTemplate: any =
        layoutGeo?.template || (pptxDesign ? deriveLayoutTemplateFromPptxDesign(pptxDesign) : null);

      if (!tenantSlug) throw new Error('save_brand_to_confidential: tenant_slug is required');

      const confDir = resolveMediaRepositoryPath(
        rootDir,
        `knowledge/confidential/${tenantSlug}/design`,
        resolve
      );
      safeMkdir(confDir, { recursive: true });

      // 1. Build and write layout-templates.json
      const templateId = `${tenantSlug}-extracted`;
      const needsNewTemplate = isWebPack ? true : layoutGeo.needs_new_template !== false;
      const webTemplate = webLayoutTemplates?.templates
        ? webLayoutTemplates.templates?.[webLayoutTemplates.default] ||
          webLayoutTemplates.templates?.[Object.keys(webLayoutTemplates.templates)[0]]
        : null;
      const templatePayload = isWebPack
        ? webTemplate || {
            chrome: {
              viewport: webHeritage?.viewport || null,
              background: webHeritage?.background || null,
              container: webHeritage?.container || null,
            },
            hero: webHeritage?.hero || {},
            body_zones: webHeritage?.body_zones || {},
            web: webHeritage || {},
          }
        : extractedTemplate || {
            chrome: layoutGeo.geometry?.chrome || {},
            hero: {},
            body_zones: {},
          };
      if (needsNewTemplate && (layoutGeo.geometry || extractedTemplate || isWebPack)) {
        const pubCatalog = loadLayoutTemplateCatalog(rootDir);
        const baseTemplate =
          pubCatalog.templates?.[layoutGeo.recommended_template_id || 'corporate-standard'] || {};
        const newTemplate = {
          chrome: { ...baseTemplate.chrome, ...(templatePayload.chrome || {}) },
          hero: { ...baseTemplate.hero, ...(templatePayload.hero || {}) },
          body_zones: { ...baseTemplate.body_zones, ...(templatePayload.body_zones || {}) },
          ...(templatePayload.web ? { web: cloneJsonValue(templatePayload.web) } : {}),
          _meta: isWebPack
            ? `Auto-extracted from Web heritage for ${brandName}. Review layout before production use.`
            : `Auto-extracted from PPTX for ${brandName}. Review geometry before production use.`,
        };
        const layoutCatalog = {
          version: '1.0.0',
          default: templateId,
          templates: { [templateId]: newTemplate },
        };
        safeWriteFile(
          path.join(confDir, 'layout-templates.json'),
          JSON.stringify(layoutCatalog, null, 2)
        );
        logger.info(`[BRAND_IMPORT] Wrote confidential layout-templates.json for ${tenantSlug}`);
      }

      // 2. Build and write tenant-override.json
      const usedTemplateId = needsNewTemplate
        ? templateId
        : layoutGeo.matched_template_id || templateId;
      const override: any = {
        _meta: `Auto-imported brand profile for ${brandName}. Review before production use.`,
        design_system_id: dsId,
        matchers,
        theme: `${tenantSlug}-imported`,
      };
      if (needsNewTemplate) {
        override.layout_template_id = templateId;
        override.layout_template_catalog = `knowledge/confidential/${tenantSlug}/design/layout-templates.json`;
      } else {
        override.layout_template_id = usedTemplateId;
      }
      const extractedTheme = webTheme?.theme || theme?.theme || theme;
      if (extractedTheme?.colors || extractedTheme?.fonts) {
        override.extracted_theme = { colors: extractedTheme.colors, fonts: extractedTheme.fonts };
      }
      if (resolve(params.logo_url))
        override.branding = {
          brand_name: brandName,
          logo_url: resolve(params.logo_url),
          tone: 'professional-enterprise',
        };
      else override.branding = { brand_name: brandName };
      if (pptxDesign || theme?.pptx || webTheme) {
        override.theme_pack_path = `knowledge/confidential/${tenantSlug}/design/theme.json`;
      }

      safeWriteFile(path.join(confDir, 'tenant-override.json'), JSON.stringify(override, null, 2));
      logger.info(`[BRAND_IMPORT] Wrote confidential tenant-override.json for ${tenantSlug}`);

      const packTheme = {
        name: webTheme?.theme?.name || theme?.name || brandName,
        colors: webTheme?.theme?.colors || theme?.colors || {},
        fonts: webTheme?.theme?.fonts || theme?.fonts || {},
        assets: {
          logo_url:
            resolve(params.logo_url) ||
            webTheme?.theme?.assets?.logo_url ||
            theme?.assets?.logo_url ||
            undefined,
        },
      };
      const packHeritage = pptxDesign
        ? {
            canvas: cloneJsonValue(pptxDesign.canvas || null),
            master: cloneJsonValue(pptxDesign.master || null),
            rawThemeXml: pptxDesign.rawThemeXml || null,
            rawMasterXml: pptxDesign.rawMasterXml || null,
            rawMasterRelsXml: pptxDesign.rawMasterRelsXml || null,
            rawLayouts: Array.isArray(pptxDesign.rawLayouts)
              ? cloneJsonValue(pptxDesign.rawLayouts)
              : [],
            rawMasters: Array.isArray(pptxDesign.rawMasters)
              ? cloneJsonValue(pptxDesign.rawMasters)
              : [],
            masterMedia: Array.isArray(pptxDesign.masterMedia)
              ? cloneJsonValue(pptxDesign.masterMedia)
              : [],
            rawParts: pptxDesign.rawParts || null,
          }
        : theme?.pptx
          ? cloneJsonValue(theme.pptx)
          : null;
      const packLayoutTemplates =
        isWebPack && webLayoutTemplates
          ? cloneJsonValue(webLayoutTemplates)
          : needsNewTemplate && extractedTemplate
            ? {
                version: '1.0.0',
                default: templateId,
                templates: {
                  [templateId]: {
                    chrome: { ...(extractedTemplate.chrome || {}) },
                    hero: { ...(extractedTemplate.hero || {}) },
                    body_zones: { ...(extractedTemplate.body_zones || {}) },
                    _meta: `Derived from PPTX heritage for ${brandName}.`,
                  },
                },
              }
            : extractedTemplate
              ? {
                  version: '1.0.0',
                  default:
                    layoutGeo.matched_template_id ||
                    layoutGeo.recommended_template_id ||
                    templateId,
                  templates: {
                    [layoutGeo.matched_template_id ||
                    layoutGeo.recommended_template_id ||
                    templateId]: cloneJsonValue(extractedTemplate),
                  },
                }
              : null;
      const themePack = {
        kind: isWebPack ? 'web-theme-pack' : 'pptx-theme-pack',
        version: '1.0.0',
        theme_id: `${tenantSlug}-imported`,
        brand_name: brandName,
        tenant_slug: tenantSlug,
        design_system_id: dsId,
        theme: packTheme,
        web: webHeritage,
        pptx: packHeritage,
        layout_templates: packLayoutTemplates,
        layout_template_id: usedTemplateId,
        layout_template_catalog: override.layout_template_catalog || null,
        source_theme_name: webTheme?.theme?.name || theme?.name || null,
      };
      safeWriteFile(path.join(confDir, 'theme.json'), JSON.stringify(themePack, null, 2));
      logger.info(`[BRAND_IMPORT] Wrote confidential theme.json for ${tenantSlug}`);

      // 3. Update knowledge/confidential/tenants/index.json
      const registryPath = resolveMediaRepositoryPath(
        rootDir,
        'knowledge/confidential/tenants/index.json',
        resolve
      );
      let registry: any = { tenants: [] };
      try {
        registry = loadTenantDesignOverrideIndex(rootDir);
      } catch {
        /* create new */
      }
      const overridePath = `knowledge/confidential/${tenantSlug}/design/tenant-override.json`;
      const existing = registry.tenants.findIndex((t: any) => t.id === tenantSlug);
      if (existing >= 0)
        registry.tenants[existing] = { id: tenantSlug, override_path: overridePath };
      else registry.tenants.push({ id: tenantSlug, override_path: overridePath });
      safeWriteFile(registryPath, JSON.stringify(registry, null, 2));
      logger.info(`[BRAND_IMPORT] Updated confidential tenant registry for ${tenantSlug}`);

      logger.info(`✅ [BRAND_IMPORT] Brand saved to confidential tier → ${confDir}`);
      break;
    }
    case 'log':
      logger.info(`[MEDIA_LOG] ${resolve(params.message)}`);
      break;
  }
  return ctx;
}

export { opApply };
