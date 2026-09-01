import { draftDeckSectionBodies, selectDeckTheme } from '@agent/core/deck-theme-direction';
import { htmlToDeckProtocol } from './html-deck-helpers.js';
import { logger } from '@agent/core/core';
import {
  assertSafeRepositoryPath,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
} from '@agent/core/secure-io';
import { pathResolver } from '@agent/core/path-resolver';
import {
  detectRasterCapabilities,
  rasterizeDocument,
  rasterizeHtml,
  assertVisualReviewPathScope,
} from '@agent/core/visual-raster';
import { runVisualReviewLoop } from '@agent/core/visual-review-loop';
import { loadVisualReviewRubric, formatVisualReviewReport } from '@agent/core/visual-review';
import {
  lockMediaBrief,
  inferredDecisions,
  formatBriefForConfirmation,
} from '@agent/core/media-brief-lock';
import { validateThemeContrast } from '@agent/core/design-qa';
import { type PdfDesignProtocol } from '@agent/core/media-contracts';
import {
  buildPptxProtocolFromPdfDesign as buildPptxProtocolFromPdfDesignHelper,
  buildXlsxProtocolFromPdfDesign as buildXlsxProtocolFromPdfDesignHelper,
  DEFAULT_PDF_TO_PPTX_HINTS,
  type PdfToPptxHints,
} from './media-pdf-protocol-helpers.js';
import { recognizeDocumentImage } from './media-ocr.js';
import {
  assertMediaProtocolLayoutReady,
  summarizeMediaPptxLayout,
} from './media-document-pipeline-helpers.js';
import {
  warnLegacyMediaOp,
  resolveMediaBriefCategory,
  normalizeBriefForCategory,
  normalizeDiagramDocumentBrief,
} from './media-document-helpers.js';
import * as mediaPdfHelpers from './media-pdf-helpers.js';
import {
  resolveGraphDefinition,
  resolveDrawioIconMap,
  loadFallbackDrawioTheme,
} from './media-diagram-helpers.js';
import {
  generateDrawioDocument,
  extractChromeGeometryFromPptxDesign,
  deriveLayoutTemplateFromPptxDesign,
  matchLayoutTemplate,
  deriveThemeFromPptxDesign,
} from './media-diagram-render-helpers.js';
import * as path from 'node:path';
import { findSlidesByOwner, pptxDiff, type MediaSlideText } from './media-slide-ops.js';
import {
  loadThemeCatalog,
  resolveConfidentialThemePack,
  resolveNamedTheme,
  buildOutlineFromNormalizedBrief,
  buildCompiledBriefContext,
  resolveObjectInput,
  compileBriefToDesignProtocol,
  buildProposalNarrativeOutline,
  normalizeProposalBrief,
  buildDocumentPdfProtocol,
} from './media-design-protocol.js';

import {
  cloneJsonValue,
  loadJsonValue,
  loadLayoutTemplateCatalog,
  buildPptxSlideFromPattern,
} from './media-layout-runtime.js';
import { opCapture, PDF_PYPDF_OPS } from './media-action-capture.js';

function resolveMediaRepositoryPath(rootDir: string, value: unknown, label: string): string {
  const requested = String(value ?? '').trim();
  if (!requested) throw new Error(`[${label}] path is required`);
  return assertSafeRepositoryPath(path.resolve(rootDir, requested), {
    allowMissingLeaf: true,
  });
}

async function maybeAugmentPdfDesignWithImageOcr(
  pdfDesign: PdfDesignProtocol,
  hints?: PdfToPptxHints
): Promise<PdfDesignProtocol> {
  const resolvedHints: PdfToPptxHints = {
    canvas: { ...DEFAULT_PDF_TO_PPTX_HINTS.canvas, ...(hints?.canvas || {}) },
    features: { ...DEFAULT_PDF_TO_PPTX_HINTS.features, ...(hints?.features || {}) },
    ocr: { ...DEFAULT_PDF_TO_PPTX_HINTS.ocr, ...(hints?.ocr || {}) },
    style: { ...DEFAULT_PDF_TO_PPTX_HINTS.style, ...(hints?.style || {}) },
    layout: { ...DEFAULT_PDF_TO_PPTX_HINTS.layout, ...(hints?.layout || {}) },
    theme: { ...DEFAULT_PDF_TO_PPTX_HINTS.theme, ...(hints?.theme || {}) },
  };
  if (!resolvedHints.features?.fullPageImageOcrOverlay) return pdfDesign;
  if (!Array.isArray(pdfDesign.content?.pages) || pdfDesign.content.pages.length === 0)
    return pdfDesign;

  const cloned = cloneJsonValue(pdfDesign as any) as PdfDesignProtocol;
  for (const page of cloned.content.pages as any[]) {
    const pageWidth = page?.width || 960;
    const pageHeight = page?.height || 540;
    const pageArea = pageWidth * pageHeight;
    const images = Array.isArray(page?.images) ? page.images : [];
    const dominantImage = images.find(
      (image: any) => (image.width || 0) * (image.height || 0) >= pageArea * 0.85
    );
    const positionedTextElements = Array.isArray(page?.elements)
      ? page.elements.filter((element: any) => ['text', 'heading'].includes(element?.type))
      : [];
    const existingTextCount = positionedTextElements.length;
    const reliableTextCount = positionedTextElements.filter((element: any) =>
      mediaPdfHelpers.isLikelyReliablePdfText(String(element?.text || ''))
    ).length;
    const hasMostlyUnreliableText =
      existingTextCount > 0 && reliableTextCount / existingTextCount < 0.35;
    const shouldRunOcr =
      existingTextCount <= 8 || reliableTextCount <= 3 || hasMostlyUnreliableText;
    if (Array.isArray(page?.ocrLines) && page.ocrLines.length > 0) continue;
    if (!dominantImage || !dominantImage.path || !shouldRunOcr) continue;
    try {
      const requestedLanguage = resolvedHints.ocr?.language || 'jpn+eng';
      const ocr = await recognizeDocumentImage({
        path: dominantImage.path,
        language: requestedLanguage,
        mode: 'local_only',
      });
      page.ocrProvider = ocr.provider;
      page.ocrConfidence = ocr.confidence;
      page.ocrLines = mediaPdfHelpers.buildPdfPageOcrOverlayLinesFromResult(
        page,
        dominantImage,
        ocr
      );
    } catch (error: any) {
      logger.warn(
        `[MEDIA_TRANSFORM] fullPageImageOcrOverlay failed on page ${page.pageNumber}: ${error.message}`
      );
    }
  }
  return cloned;
}

async function opTransform(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = pathResolver.rootDir();
  if (PDF_PYPDF_OPS.has(op)) return opCapture(op, params, ctx, resolve);
  switch (op) {
    case 'find_slides_by_owner': {
      const slides = (params.slides ||
        ctx[params.from || 'last_pptx_slides'] ||
        []) as MediaSlideText[];
      const labels = Array.isArray(params.owner_labels)
        ? params.owner_labels.map(String)
        : Array.isArray(ctx[params.owner_labels_from || 'owner_labels'])
          ? ctx[params.owner_labels_from || 'owner_labels'].map(String)
          : [];
      const result = findSlidesByOwner({
        slides,
        owner_labels: labels,
        match_mode: params.match_mode,
      });
      return {
        ...ctx,
        [params.export_as || 'slide_owner_matches']: result,
      };
    }
    case 'pptx_diff': {
      const before = (params.before ||
        ctx[params.before_from || 'before_slides'] ||
        []) as MediaSlideText[];
      const after = (params.after ||
        ctx[params.after_from || 'after_slides'] ||
        []) as MediaSlideText[];
      return { ...ctx, [params.export_as || 'pptx_diff']: pptxDiff({ before, after }) };
    }
    case 'pdf_to_pptx_design': {
      const pdfDesign = ctx[params.from || 'last_pdf_design'];
      if (!pdfDesign || typeof pdfDesign !== 'object') {
        throw new Error(
          `pdf_to_pptx_design could not find context key: ${params.from || 'last_pdf_design'}`
        );
      }
      const augmentedPdfDesign = await maybeAugmentPdfDesignWithImageOcr(
        pdfDesign as PdfDesignProtocol,
        params.hints
      );
      return {
        ...ctx,
        [params.export_as || 'last_pptx_design']: buildPptxProtocolFromPdfDesignHelper(
          augmentedPdfDesign,
          params.hints
        ),
        merged_output_format: 'pptx',
      };
    }
    case 'pdf_to_xlsx_design': {
      const pdfDesign = ctx[params.from || 'last_pdf_design'];
      if (!pdfDesign || typeof pdfDesign !== 'object') {
        throw new Error(
          `pdf_to_xlsx_design could not find context key: ${params.from || 'last_pdf_design'}`
        );
      }
      return {
        ...ctx,
        [params.export_as || 'last_xlsx_design']: buildXlsxProtocolFromPdfDesignHelper(
          pdfDesign as PdfDesignProtocol,
          params.hints
        ),
        merged_output_format: 'xlsx',
      };
    }
    case 'apply_theme': {
      const themes = loadThemeCatalog(rootDir);
      if (!themes || typeof themes !== 'object' || !themes.themes) {
        logger.warn('[MEDIA_TRANSFORM] theme catalog not found, skipping theme application');
        return ctx;
      }
      let themeName = resolve(params.theme) || themes.default_theme || 'kyberion-standard';
      // LLM-boundary audit fix A: theme: 'auto' selects a story-matched theme
      // from the governed catalog (selection only — never invents colors);
      // failure or an empty story keeps the catalog default.
      if (themeName === 'auto') {
        const fallbackTheme = themes.default_theme || 'kyberion-standard';
        const storySource =
          ctx.document_outline ||
          ctx.last_brief ||
          ctx.brief ||
          params.story ||
          ctx.last_json ||
          {};
        themeName = await selectDeckTheme({
          title: String(
            (storySource as any).title || (storySource as any).document_type || 'Document'
          ),
          summary: JSON.stringify(storySource).slice(0, 1500),
          catalog: Object.entries(themes.themes).map(([id, record]: [string, any]) => ({
            id,
            name: record?.name ? String(record.name) : undefined,
          })),
          defaultTheme: fallbackTheme,
        });
      }
      const theme = themes.themes[themeName];
      const confidentialPack = theme ? null : resolveConfidentialThemePack(rootDir, themeName);
      const resolvedTheme =
        theme ||
        (confidentialPack?.theme
          ? {
              ...confidentialPack.theme,
              layout_templates: confidentialPack.layout_templates || null,
              pptx: confidentialPack.pptx || null,
              web: confidentialPack.web || null,
            }
          : null);
      if (!resolvedTheme) {
        logger.warn(
          `[MEDIA_TRANSFORM] Theme "${themeName}" not found, available: ${Object.keys(themes.themes).join(', ')}`
        );
        return ctx;
      }
      return {
        ...ctx,
        active_theme: resolvedTheme,
        active_theme_name: themeName,
        active_theme_pack: confidentialPack || null,
        active_pptx_master: confidentialPack?.pptx?.master || ctx.active_pptx_master,
        active_canvas: confidentialPack?.pptx?.canvas || ctx.active_canvas,
        active_web_theme: confidentialPack?.web
          ? {
              theme: confidentialPack.theme || resolvedTheme,
              web: confidentialPack.web,
              layout_templates: confidentialPack.layout_templates || null,
            }
          : ctx.active_web_theme,
      };
    }
    case 'apply_pattern': {
      const patternPath = resolveMediaRepositoryPath(
        rootDir,
        resolve(params.pattern_path),
        'apply_pattern'
      );
      if (!safeExistsSync(patternPath)) {
        throw new Error(`Design pattern not found: ${patternPath}`);
      }
      const pattern = loadJsonValue(patternPath);
      return { ...ctx, active_pattern: pattern, pattern_id: pattern.pattern_id };
    }
    case 'merge_content': {
      const pattern = ctx.active_pattern;
      const theme = ctx.active_theme;
      const contentData = resolve(params.content_data) || pattern?.content_data || [];
      const outputFormat =
        resolve(params.output_format) || pattern?.media_actuator_config?.engine || 'pptx';

      if (outputFormat === 'pptx') {
        const themeColors = resolveThemeColors(theme);
        const themePack = ctx.active_theme_pack || null;
        const activeMaster = ctx.active_pptx_master || themePack?.pptx?.master;
        const canvas = ctx.active_canvas || themePack?.pptx?.canvas || { w: 10, h: 5.625 };
        const protocol: any = {
          version: '3.0.0',
          generatedAt: new Date().toISOString(),
          canvas,
          theme: {
            dk1: (themeColors.primary || '#000000').replace('#', ''),
            dk2: (themeColors.secondary || themeColors.text || '#44546A').replace('#', ''),
            lt1: (themeColors.background || '#FFFFFF').replace('#', ''),
            lt2: (themeColors.background || '#E7E6E6').replace('#', ''),
            accent1: (themeColors.accent || '#38BDF8').replace('#', ''),
            accent2: (themeColors.secondary || '#334155').replace('#', ''),
          },
          master: {
            elements: Array.isArray(activeMaster?.elements) ? activeMaster.elements : [],
            extensions: activeMaster?.extensions,
            bgXml: activeMaster?.bgXml,
          },
          slides: contentData.map((data: any, idx: number) =>
            buildPptxSlideFromPattern(rootDir, data, idx, theme, pattern, activeMaster, canvas)
          ),
        };
        protocol.metadata = {
          ...(protocol.metadata || {}),
          layoutDiagnostics: summarizeMediaPptxLayout(protocol),
        };
        return { ...ctx, last_pptx_design: protocol, merged_output_format: 'pptx' };
      }

      // For non-pptx formats, store the merged data for downstream processing
      return { ...ctx, merged_content: contentData, merged_output_format: outputFormat };
    }
    case 'set': {
      const key = resolve(params.key);
      const value = resolve(params.value);
      if (key) return { ...ctx, [key]: value };
      return ctx;
    }
    case 'layout_template_from_pptx_design': {
      const fromKey = resolve(params.from) || 'last_pptx_design';
      const design = ctx[fromKey];
      if (!design)
        throw new Error(`layout_template_from_pptx_design: context key not found: ${fromKey}`);

      const geometry = extractChromeGeometryFromPptxDesign(design);
      const publicCatalog = loadLayoutTemplateCatalog(rootDir);
      const publicMatch = matchLayoutTemplate(geometry, publicCatalog);

      const tenantSlug: string = resolve(params.tenant_slug) || ctx.tenant_slug || '';
      let confMatch: { id: string; score: number; catalog?: string } | null = null;
      if (tenantSlug) {
        const confPath = `knowledge/confidential/${tenantSlug}/design/layout-templates.json`;
        try {
          const confCatalog = loadJsonValue(
            resolveMediaRepositoryPath(rootDir, confPath, 'layout_template_from_pptx_design')
          );
          const m = matchLayoutTemplate(geometry, confCatalog);
          if (m) confMatch = { ...m, catalog: confPath };
        } catch {
          /* no confidential catalog yet */
        }
      }

      const THRESHOLD = 0.85;
      const chosen: any =
        (confMatch?.score ?? 0) >= (publicMatch?.score ?? 0) ? confMatch : publicMatch;
      const baseTemplate = chosen?.id
        ? chosen?.catalog === 'public' || !chosen?.catalog
          ? publicCatalog.templates?.[chosen.id]
          : null
        : null;
      const template = deriveLayoutTemplateFromPptxDesign(
        design,
        baseTemplate || publicCatalog.templates?.[chosen?.id || 'corporate-standard'] || {}
      );
      const result: any = {
        geometry,
        matched_template_id: chosen && chosen.score >= THRESHOLD ? chosen.id : null,
        match_score: chosen?.score ?? 0,
        match_catalog: (chosen as any)?.catalog || 'public',
        needs_new_template: !chosen || chosen.score < THRESHOLD,
        recommended_template_id: chosen?.id || 'corporate-standard',
        template,
      };
      return { ...ctx, [params.export_as || 'last_layout_geometry']: result };
    }
    case 'theme_from_pptx_design': {
      const fromKey = resolve(params.from) || 'last_pptx_design';
      const design = ctx[fromKey];
      if (!design) {
        throw new Error(`theme_from_pptx_design could not find context key: ${fromKey}`);
      }

      const derivedTheme = deriveThemeFromPptxDesign(design, resolve(params.name));
      const nextCtx: Record<string, any> = {
        ...ctx,
        active_theme: derivedTheme,
        active_theme_name: derivedTheme.name || resolve(params.name) || 'pptx-extracted-theme',
        active_pptx_master: design.master,
        active_canvas: design.canvas,
        active_pptx_design: design,
        active_theme_source: fromKey,
      };

      if (params.export_as) {
        nextCtx[params.export_as] = derivedTheme;
      }
      if (params.export_master_as) {
        nextCtx[params.export_master_as] = design.master;
      }
      return nextCtx;
    }
    case 'proposal_storyline_from_brief': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief = ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`proposal_storyline_from_brief could not find context key: ${fromKey}`);
      }
      const brief = normalizeProposalBrief(rootDir, rawBrief);
      const outline = buildProposalNarrativeOutline(rootDir, brief);
      const slides = outline.toc.map((entry: any, idx: number) => ({
        id: entry.section_id || `slide_${idx + 1}`,
        title: entry.title,
        objective: entry.objective,
        body: Array.isArray(entry.body) ? entry.body : [entry.objective].filter(Boolean),
        visual: entry.visual,
        media_kind: entry.media_kind,
        layout_key: entry.layout_key,
        semantic_type: entry.semantic_type,
        pattern_id: entry.pattern_id,
        slide_pattern: entry.slide_pattern,
        body_zone: entry.body_zone,
        design_system_id: outline.design_system_id,
        branding: outline.branding || {},
      }));

      return {
        ...ctx,
        [params.export_as || 'proposal_storyline']: {
          kind: 'proposal-storyline-adf',
          title: brief.title || 'Proposal',
          client: brief.client,
          core_message: brief.story?.core_message,
          document_profile: brief.document_profile,
          design_system_id: outline.design_system_id,
          branding: outline.branding || {},
          layout_template_id: brief.layout_template_id,
          narrative_pattern_id: outline.narrative_pattern_id,
          recommended_theme: outline.recommended_theme,
          recommended_layout_template_id: outline.recommended_layout_template_id,
          toc: outline.toc,
          diagnostics: outline.diagnostics,
          slides,
        },
      };
    }
    case 'document_outline_from_brief': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief = ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`document_outline_from_brief could not find context key: ${fromKey}`);
      }
      const category = resolveMediaBriefCategory(rawBrief);
      const brief = normalizeBriefForCategory(rootDir, rawBrief);
      const outline = buildOutlineFromNormalizedBrief(rootDir, category, brief);

      // Story-matched theme (deck counterpart of video-visual-direction):
      // only when the brief did not explicitly choose one — operator intent
      // always wins, and failure keeps the preset default.
      const explicitTheme = (brief as any).theme || (brief as any).payload?.theme;
      if (!explicitTheme && outline?.recommended_theme) {
        const catalogRaw = loadThemeCatalog(rootDir)?.themes || {};
        const catalog = Object.entries(catalogRaw).map(([id, record]: [string, any]) => ({
          id,
          name: record?.name ? String(record.name) : undefined,
        }));
        outline.recommended_theme = await selectDeckTheme({
          title: String((brief as any).title || outline.document_type || 'Document'),
          summary: JSON.stringify(
            (brief as any).sections ?? (brief as any).objective ?? brief
          ).slice(0, 1500),
          tone: (brief as any).tone ? String((brief as any).tone) : undefined,
          audience: (brief as any).audience ? String((brief as any).audience) : undefined,
          catalog,
          defaultTheme: String(outline.recommended_theme),
        });
      }

      // LLM-boundary audit fix B: fill ONLY empty section bodies (the
      // llm_zone declared draft_body_content but nothing implemented it —
      // body-less briefs rendered heading-only decks). Existing bodies and
      // failures leave the outline untouched.
      const outlineSections = Array.isArray((outline as any)?.sections)
        ? ((outline as any).sections as any[])
        : [];
      const draftTargets = outlineSections.map((section: any) => ({
        id: String(section.section_id || section.id || section.title || 'section'),
        title: String(section.title || section.section_id || 'Section'),
        body: Array.isArray(section.body) ? section.body.join(' ') : section.body,
      }));
      if (draftTargets.some((section) => !String(section.body ?? '').trim())) {
        const drafts = await draftDeckSectionBodies({
          title: String((brief as any).title || outline.document_type || 'Document'),
          tone: (brief as any).tone ? String((brief as any).tone) : undefined,
          audience: (brief as any).audience ? String((brief as any).audience) : undefined,
          locale: (brief as any).locale ? String((brief as any).locale) : undefined,
          sections: draftTargets,
        });
        for (const section of outlineSections) {
          const key = String(section.section_id || section.id || section.title || 'section');
          const hasBody = Array.isArray(section.body)
            ? section.body.some((value: any) => String(value ?? '').trim())
            : Boolean(String(section.body ?? '').trim());
          if (!hasBody && drafts[key]) {
            section.body = Array.isArray(section.body) ? [drafts[key]] : drafts[key];
          }
        }
      }

      return {
        ...ctx,
        [params.export_as || 'document_outline']: outline,
      };
    }
    case 'brief_to_design_protocol': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief =
        params.brief && typeof params.brief === 'object' ? params.brief : ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`brief_to_design_protocol could not find context key: ${fromKey}`);
      }
      const sourceBrief =
        (rawBrief as any).kind === 'locked-media-brief' &&
        (rawBrief as any).source_brief &&
        typeof (rawBrief as any).source_brief === 'object'
          ? (rawBrief as any).source_brief
          : rawBrief;
      const compiled = compileBriefToDesignProtocol(rootDir, sourceBrief);
      const exportKey = params.export_as || compiled.exportKey;
      return {
        ...ctx,
        active_theme: ctx.active_theme || compiled.theme || ctx.active_theme,
        active_theme_name: ctx.active_theme_name || compiled.themeName,
        document_outline: compiled.outline,
        [exportKey]: compiled.protocol,
        last_design_protocol: compiled.protocol,
        last_design_protocol_kind: compiled.protocolKind,
      };
    }
    case 'deck_from_html': {
      // Convention-based HTML → editable PptxDesignProtocol. Source is an HTML
      // string from a ctx channel (`from`), an inline `html` param, or a file
      // (`path`). Produces `last_pptx_design` for a downstream pptx_render.
      let html: unknown = typeof params.html === 'string' ? params.html : undefined;
      if (html === undefined && params.path) {
        const p = resolveMediaRepositoryPath(rootDir, resolve(params.path), 'deck_from_html');
        // Keep file-backed input bounded at the same gate as inline input;
        // otherwise safeReadFile may allocate its 100MB default before the
        // parser rejects the 8MiB protocol limit.
        html = safeReadFile(p, {
          encoding: 'utf8',
          maxSizeMB: 8,
          label: 'deck_from_html input',
        }) as string;
      }
      if (html === undefined) html = ctx[resolve(params.from) || 'last_html'];
      if (typeof html !== 'string' || !html.trim()) {
        throw new Error(
          'deck_from_html requires HTML via params.html, params.path, or a ctx channel (params.from)'
        );
      }
      const { protocol, slideCount } = htmlToDeckProtocol(html);
      const exportKey = params.export_as || 'last_pptx_design';
      return {
        ...ctx,
        [exportKey]: protocol,
        last_pptx_design: protocol,
        last_design_protocol: protocol,
        last_design_protocol_kind: 'pptx',
        deck_from_html_slide_count: slideCount,
      };
    }
    case 'pptx_layout_preflight': {
      const fromKey = resolve(params.from) || 'last_pptx_design';
      const protocol = ctx[fromKey];
      if (!protocol || typeof protocol !== 'object') {
        throw new Error(`pptx_layout_preflight could not find context key: ${fromKey}`);
      }
      assertMediaProtocolLayoutReady(protocol, {
        allowLayoutOverflow: params.allow_layout_overflow === true,
      });
      const diagnostics =
        protocol?.metadata?.layoutDiagnostics || summarizeMediaPptxLayout(protocol);
      return {
        ...ctx,
        [params.export_as || 'media_layout_diagnostics']: diagnostics,
      };
    }
    case 'lock_media_brief': {
      // MP-05: fix the brief before anything is produced, and record which
      // parts the operator actually decided. An inference nobody can see is
      // how a deck ends up written for the wrong reader.
      const fromKey = resolve(params.from) || 'last_json';
      const raw = ctx[fromKey];
      if (!raw || typeof raw !== 'object') {
        throw new Error(`[UNKNOWN_INPUT] lock_media_brief could not find context key: ${fromKey}`);
      }

      const stated: Record<string, string | undefined> = {};
      for (const field of ['audience', 'objective', 'tone', 'locale', 'render_target', 'title']) {
        const value = (raw as any)[field];
        if (typeof value === 'string' && value.trim()) stated[field] = value.trim();
      }

      const inferred: Record<string, { value: string; rationale: string }> = {};
      if (!stated.locale) {
        inferred.locale = {
          value: 'ja-JP',
          rationale: 'no locale stated; defaulted to the workspace locale',
        };
      }
      if (!stated.tone) {
        inferred.tone = {
          value: stated.audience ? 'formal' : 'neutral',
          rationale: stated.audience
            ? `inferred from the stated audience "${stated.audience}"`
            : 'no audience or tone stated',
        };
      }

      // Nested params are not template-resolved by the dispatcher, so a
      // pipeline writing `"visual_review_rounds": "{{rounds}}"` would otherwise
      // hand the op the literal placeholder. Resolve each value here; the
      // run-shape schema then coerces the resulting strings.
      const rawRunShape =
        params.run_shape && typeof params.run_shape === 'object' ? params.run_shape : {};
      const runShape: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rawRunShape)) {
        runShape[key] = typeof value === 'string' ? resolve(value) : value;
      }

      const locked = lockMediaBrief({
        intent: String((raw as any).title || (raw as any).objective || 'media brief'),
        stated,
        inferred,
        runShape: runShape as any,
        sourceBrief: raw as Record<string, unknown>,
      });

      // Surfaced, not buried: the operator needs to see the guesses.
      const assumptions = inferredDecisions(locked);
      if (assumptions.length > 0) {
        logger.info(`📋 [MEDIA]\n${formatBriefForConfirmation(locked)}`);
      }

      return { ...ctx, [params.export_as || 'locked_media_brief']: locked };
    }
    case 'visual_review': {
      const capabilities = detectRasterCapabilities({ refresh: true });
      const lockedBrief = ctx[String(resolve(params.brief_from) || 'locked_media_brief')];
      const runShape = lockedBrief?.run_shape;
      const tier = String(resolve(params.tier) || 'public');
      if (!['public', 'confidential', 'personal'].includes(tier)) {
        throw new Error(
          '[VISUAL_REVIEW_TIER_INVALID] tier must be public, confidential, or personal'
        );
      }
      const missionId = String(resolve(params.mission_id) || 'none');
      const tenantSlug = String(resolve(params.tenant_slug) || 'kyberion');
      if (tier !== 'public' && !lockedBrief) {
        throw new Error(
          '[VISUAL_REVIEW_LOCK_REQUIRED] confidential and personal reviews require a locked media brief'
        );
      }
      const allowExternal =
        lockedBrief && runShape
          ? runShape.allow_external_visual_review === true
          : tier === 'public' && params.allow_external_egress === true;
      const requestedWorkDir = params.work_dir
        ? resolve(params.work_dir)
        : tier === 'public'
          ? undefined
          : missionId !== 'none'
            ? path.join('active', 'missions', tier, missionId, 'visual-review')
            : undefined;
      const artifactKind = String(resolve(params.artifact_kind) || 'pptx') as
        'pptx' | 'doc' | 'video-scenes' | 'web';
      const label = String(params.label || params.path || 'media-review').replace(
        /[^a-zA-Z0-9._-]/g,
        '-'
      );
      const rawHtmlPaths = Array.isArray(params.html_paths)
        ? params.html_paths.map((value: unknown) => String(resolve(value)))
        : [];
      const artifactInput = String(resolve(params.path || params.artifact_path) || '');
      let artifactPath = '';
      if (artifactKind === 'video-scenes' || artifactKind === 'web') {
        if (rawHtmlPaths.length === 0) {
          throw new Error(
            '[VISUAL_REVIEW_HTML_INPUT_REQUIRED] html_paths is required for HTML review'
          );
        }
        for (const htmlPath of rawHtmlPaths) {
          assertVisualReviewPathScope({
            artifactPath: htmlPath,
            workDir: requestedWorkDir,
            tier: tier as any,
            tenantSlug,
            missionId,
          });
        }
      } else {
        artifactPath = resolveMediaRepositoryPath(rootDir, artifactInput, 'visual_review');
        assertVisualReviewPathScope({
          artifactPath,
          workDir: requestedWorkDir,
          tier: tier as any,
          tenantSlug,
          missionId,
        });
        if (!safeExistsSync(artifactPath)) {
          throw new Error(
            '[UNKNOWN_ARTIFACT] visual_review could not find artifact: ' + artifactPath
          );
        }
      }

      const scope = {
        tenant_id: tenantSlug,
        mission_id: missionId,
        read_tiers: [tier],
        write_tier: tier,
        purpose: 'media visual review',
        external_egress: allowExternal ? 'allow' : 'deny',
      } as any;

      // Zero rounds means the operator turned the review off; that is a
      // deliberate skip, not a pass.
      if (runShape && runShape.visual_review_rounds === 0) {
        return {
          ...ctx,
          [params.export_as || 'media_visual_review']: {
            status: 'skipped',
            rubric_model:
              'visual-review-rubric@' +
              String((loadVisualReviewRubric({ tenantSlug }) as any).version || '1'),
            error_count: 0,
            warning_count: 0,
            images_reviewed: 0,
            findings: [],
            delivery_status: 'unreviewed',
            review_outcome: 'unreviewed',
            skipped_reason: 'visual review disabled by the locked brief (visual_review_rounds = 0)',
            raster: { available: false, backend: null, missing_binaries: capabilities.missing },
          },
        };
      }

      let lastRaster: any = {
        available: false,
        images: [],
        unavailable_reason: 'rasterization did not run',
      };
      const render = async () => {
        lastRaster =
          artifactKind === 'video-scenes' || artifactKind === 'web'
            ? await rasterizeHtml({
                htmlPaths: rawHtmlPaths,
                label,
                ...(requestedWorkDir ? { workDir: requestedWorkDir } : {}),
                tier: tier as any,
                tenantSlug,
                missionId,
              })
            : rasterizeDocument({
                sourcePath: artifactPath,
                label,
                ...(params.dpi ? { dpi: Number(params.dpi) } : {}),
                ...(params.max_pages ? { maxPages: Number(params.max_pages) } : {}),
                ...(requestedWorkDir ? { workDir: requestedWorkDir } : {}),
                tier: tier as any,
                tenantSlug,
                missionId,
              });
        return {
          images: lastRaster.images,
          ...(lastRaster.unavailable_reason
            ? { unavailable_reason: lastRaster.unavailable_reason }
            : {}),
        };
      };
      const loop = await runVisualReviewLoop({
        render,
        review: {
          artifactKind,
          title: params.title ? String(resolve(params.title)) : undefined,
          scope,
          backendName: String(resolve(params.backend) || 'stub'),
          rubric: loadVisualReviewRubric({ tenantSlug }),
        },
        maxRounds: Number(runShape?.visual_review_rounds ?? 1),
      });
      const report = loop.final_report || {
        status: 'skipped' as const,
        findings: [],
        error_count: 0,
        warning_count: 0,
        images_reviewed: 0,
        skipped_reason: 'visual review did not produce a report',
      };

      if (report.status !== 'reviewed' && lastRaster.unavailable_reason) {
        report.skipped_reason = lastRaster.unavailable_reason;
      }

      if (report.status !== 'reviewed') {
        logger.warn(`⚠️  [MEDIA] ${formatVisualReviewReport(report)}`);
      } else if (report.findings.length > 0) {
        logger.info(`🔍 [MEDIA]\n${formatVisualReviewReport(report)}`);
      }
      if (missionId !== 'none') {
        const missionPath = pathResolver.findMissionPath(missionId);
        if (missionPath) {
          try {
            const evidenceDir = path.join(missionPath, 'evidence');
            safeMkdir(evidenceDir, { recursive: true });
            safeWriteFile(
              path.join(evidenceDir, 'visual-review-report.json'),
              JSON.stringify(
                {
                  version: '1.0.0',
                  mission_id: missionId,
                  tenant_slug: tenantSlug,
                  tier,
                  artifact_kind: artifactKind,
                  delivery_status:
                    loop.outcome === 'clean'
                      ? 'clean'
                      : loop.outcome === 'residual'
                        ? 'residual'
                        : 'unreviewed',
                  review_outcome: loop.outcome,
                  rounds: loop.rounds,
                  report,
                  generated_at: new Date().toISOString(),
                },
                null,
                2
              )
            );
          } catch (error: any) {
            logger.warn('[MEDIA] visual review evidence could not be persisted: ' + error?.message);
          }
        }
      }

      return {
        ...ctx,
        [params.export_as || 'media_visual_review']: {
          status: report.status,
          rubric_model:
            'visual-review-rubric@' +
            String((loadVisualReviewRubric({ tenantSlug }) as any).version || '1'),
          error_count: report.error_count,
          warning_count: report.warning_count,
          images_reviewed: report.images_reviewed,
          findings: report.findings,
          delivery_status:
            loop.outcome === 'clean'
              ? 'clean'
              : loop.outcome === 'residual'
                ? 'residual'
                : 'unreviewed',
          review_outcome: loop.outcome,
          rounds: loop.rounds,
          summary: loop.summary,
          ...(report.verdict ? { verdict: report.verdict } : {}),
          ...(report.skipped_reason ? { skipped_reason: report.skipped_reason } : {}),
          raster: {
            available: lastRaster.available,
            backend: lastRaster.backend ?? null,
            missing_binaries: capabilities.missing,
          },
        },
      };
    }
    case 'visual_review_delivery_gate': {
      const fromKey = String(resolve(params.from) || 'media_visual_review');
      const report = ctx[fromKey];
      if (!report || typeof report !== 'object') {
        throw new Error('[VISUAL_REVIEW_GATE_BLOCKED] visual review report is missing');
      }
      const deliveryStatus = String((report as any).delivery_status || '');
      if (deliveryStatus !== 'clean') {
        throw new Error(
          '[VISUAL_REVIEW_GATE_BLOCKED] delivery requires a clean visual review: ' +
            String((report as any).summary || (report as any).skipped_reason || deliveryStatus)
        );
      }
      return {
        ...ctx,
        [params.export_as || 'visual_review_delivery_gate']: {
          status: 'passed',
          source: fromKey,
          delivery_status: deliveryStatus,
        },
      };
    }
    case 'proposal_content_from_storyline': {
      const fromKey = resolve(params.from) || 'proposal_storyline';
      const storyline = ctx[fromKey];
      if (!storyline || typeof storyline !== 'object' || !Array.isArray(storyline.slides)) {
        throw new Error(`proposal_content_from_storyline could not find context key: ${fromKey}`);
      }

      const contentData = storyline.slides.map((slide: any) => ({
        title: slide.title,
        body: Array.isArray(slide.body) ? slide.body : [slide.objective].filter(Boolean),
        subtitle: slide.objective,
        visual: slide.visual,
        media_kind: slide.media_kind,
        layout_key: slide.layout_key,
        semantic_type: slide.semantic_type,
        design_system_id: storyline.design_system_id,
        branding: storyline.branding || {},
      }));

      return {
        ...ctx,
        active_theme:
          ctx.active_theme ||
          resolveNamedTheme(rootDir, storyline.recommended_theme) ||
          ctx.active_theme,
        active_theme_name: ctx.active_theme_name || storyline.recommended_theme,
        [params.export_as || 'proposal_content_data']: contentData,
      };
    }
    case 'document_pdf_from_brief': {
      const fromKey = resolve(params.from) || 'last_json';
      const brief = ctx[fromKey];
      if (!brief || typeof brief !== 'object') {
        throw new Error(`document_pdf_from_brief could not find context key: ${fromKey}`);
      }

      const invoiceProtocol = buildDocumentPdfProtocol(brief);
      return {
        ...ctx,
        [params.export_as || 'last_pdf_design']: invoiceProtocol,
      };
    }
    case 'document_diagram_asset_from_brief': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief = ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`document_diagram_asset_from_brief could not find context key: ${fromKey}`);
      }

      const brief = normalizeDiagramDocumentBrief(rawBrief);
      const nextCtx: Record<string, any> = {
        ...ctx,
        [params.export_as || 'document_diagram_asset']: brief.payload.source || brief.payload.graph,
        document_diagram_render_target: brief.render_target,
        document_diagram_layout_template_id: brief.layout_template_id,
        document_diagram_brief: brief,
      };

      if (brief.render_target === 'drawio') {
        const iconMap = resolveDrawioIconMap(rootDir, params, resolve);
        const activeTheme =
          ctx.active_theme ||
          loadFallbackDrawioTheme(rootDir, brief.layout_template_id, loadThemeCatalog);
        nextCtx.last_drawio_document = generateDrawioDocument(brief.payload.graph, {
          title: brief.payload.title || brief.title || 'Diagram',
          theme: activeTheme,
          iconMap,
          iconRoot: params.icon_root
            ? resolveMediaRepositoryPath(rootDir, resolve(params.icon_root), 'icon_root')
            : undefined,
        });
      } else if (typeof brief.payload.source === 'string') {
        nextCtx.document_diagram_source = brief.payload.source;
      }

      return nextCtx;
    }
    case 'document_spreadsheet_design_from_brief': {
      warnLegacyMediaOp(op);
      const rawBrief = resolveObjectInput(ctx, params, resolve, {
        fromKey: params.from,
        opName: 'document_spreadsheet_design_from_brief',
      });
      return buildCompiledBriefContext({
        rootDir,
        ctx,
        rawBrief,
        exportAs: params.export_as || 'last_xlsx_design',
        briefContextKey: 'document_spreadsheet_brief',
      });
    }
    case 'document_report_design_from_brief': {
      warnLegacyMediaOp(op);
      const rawBrief = resolveObjectInput(ctx, params, resolve, {
        fromKey: params.from,
        opName: 'document_report_design_from_brief',
      });
      return buildCompiledBriefContext({
        rootDir,
        ctx,
        rawBrief,
        exportAs: params.export_as,
        briefContextKey: 'document_report_brief',
      });
    }
    case 'drawio_from_graph': {
      const graph = resolveGraphDefinition(rootDir, params, ctx, resolve);
      const iconMap = resolveDrawioIconMap(rootDir, params, resolve);
      const preferredTheme = resolve(params.theme) || graph?.render_hints?.theme;
      const activeTheme =
        ctx.active_theme || loadFallbackDrawioTheme(rootDir, preferredTheme, loadThemeCatalog);
      const document = generateDrawioDocument(graph, {
        title: resolve(params.title) || graph.title || 'Architecture Diagram',
        theme: activeTheme,
        iconMap,
        iconRoot: params.icon_root
          ? resolveMediaRepositoryPath(rootDir, resolve(params.icon_root), 'icon_root')
          : undefined,
      });
      return {
        ...ctx,
        [params.export_as || 'last_drawio_document']: document,
        last_drawio_graph: graph,
      };
    }
    default:
      throw new Error(`[UNKNOWN_OP] Unknown op: ${op}`);
  }
}

// Warn once per palette: runtime/personal/tenant themes bypass the CI
// contrast gate, so the renderer is the last line of defense. Rendering is
// never blocked — the defect lands in the log/trace for the designer review.
const auditedThemePalettes = new Set<string>();
function auditThemeContrast(colors: Record<string, string>): void {
  const signature = JSON.stringify(colors);
  if (auditedThemePalettes.has(signature)) return;
  auditedThemePalettes.add(signature);
  try {
    const issues = validateThemeContrast(colors);
    for (const issue of issues.filter((entry) => entry.severity === 'must_fix')) {
      logger.warn(
        `[THEME_CONTRAST] ${issue.pair} ${issue.ratio}:1 < ${issue.required}:1 (${issue.foreground} on ${issue.background}) — ${issue.note}`
      );
    }
  } catch {
    // contrast auditing must never break rendering
  }
}

function resolveThemeColors(theme: any): Record<string, string> {
  const cssVars = {
    ...(theme?.css_vars || {}),
    ...(theme?.theme?.css_vars || {}),
  };
  const colors = {
    ...(theme?.colors || {}),
    ...(theme?.theme?.colors || {}),
  };
  const mappedFromCssVars = {
    background: cssVarHex(cssVars['--kb-bg-main']),
    primary: cssVarHex(cssVars['--kb-panel-bg']) || cssVarHex(cssVars['--kb-bg-main']),
    secondary: cssVarHex(cssVars['--kb-warning']),
    accent: cssVarHex(cssVars['--kb-accent']),
    text: cssVarHex(cssVars['--kb-text-primary']),
  };
  const resolved = Object.entries(mappedFromCssVars).reduce<Record<string, string>>(
    (acc, [key, value]) => {
      if (value) acc[key] = value;
      return acc;
    },
    { ...colors }
  );
  auditThemeContrast(resolved);
  return resolved;
}

function cssVarHex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  const hex = trimmed.match(/^#(?:[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/);
  if (hex) return trimmed;
  const rgba = trimmed.match(
    /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i
  );
  if (!rgba) return undefined;
  const channels = rgba.slice(1, 4).map((entry) => Math.max(0, Math.min(255, Number(entry))));
  if (channels.some((entry) => !Number.isFinite(entry))) return undefined;
  return `#${channels.map((entry) => entry.toString(16).padStart(2, '0')).join('')}`;
}

export { opTransform };
