import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeReaddir,
  safeLstat,
  safeStat,
  safeExec,
  derivePipelineStatus,
  pathResolver,
  pptxUtils,
  xlsxUtils,
  docxUtils,
  loadProjectRecord,
  loadServiceBindingRecord,
  resolveRef,
  handleStepError,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import {
  distillPdfDesign,
  generateNativeDocx,
  generateNativePdf,
  generateNativePptx,
  generateNativeXlsx,
  patchPptxText,
  type PdfDesignProtocol,
} from '@agent/core/media-contracts';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as excelUtils from '@agent/shared-media';
import { PDFParse } from 'pdf-parse';

/**
 * Media-Actuator v2.1.3 [SECURE-IO REINFORCED]
 * Strictly compliant with Layer 2 (Shield).
 * Uses standard safeWriteFile for all physical outputs.
 */

interface PipelineStep {
  type: 'capture' | 'transform' | 'apply' | 'control';
  op: string;
  params: any;
}

interface MediaAction {
  action: 'pipeline';
  steps: PipelineStep[];
  context?: Record<string, any>;
  options?: {
    max_steps?: number;
    timeout_ms?: number;
  };
}

function cloneJsonValue<T>(value: T): T {
  return value === undefined ? value : JSON.parse(JSON.stringify(value));
}

function mergePptxShape(base: any, overrides: any): any {
  return {
    ...base,
    ...(overrides || {}),
    pos: {
      ...(base?.pos || {}),
      ...(overrides?.pos || {}),
    },
    style: {
      ...(base?.style || {}),
      ...(overrides?.style || {}),
    },
  };
}

function resolveSlideTemplate(template: any, slideData: any, fallback = ''): string {
  if (typeof template !== 'string') return fallback;
  return template
    .replace(/{{\s*title\s*}}/g, slideData?.title || '')
    .replace(/{{\s*subtitle\s*}}/g, slideData?.subtitle || '')
    .replace(/{{\s*body\s*}}/g, Array.isArray(slideData?.body) ? slideData.body.join('\n') : (slideData?.body || ''))
    .replace(/{{\s*visual\s*}}/g, slideData?.visual || '');
}

function loadSlideLayoutPresetCatalog(rootDir: string): any {
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/slide-layout-presets',
    filePath: 'knowledge/public/design-patterns/media-templates/slide-layout-presets.json',
    fallback: { defaults: {}, presets: {} },
  });
}

function resolveRuntimeSlidePreset(rootDir: string, slideData: any): any {
  const layoutKey = String(slideData?.layout_key || '').trim();
  const mediaKind = String(slideData?.media_kind || '').trim();
  const presetKey = layoutKey || mediaKind;
  const catalog = loadSlideLayoutPresetCatalog(rootDir);
  const designSystems = loadMediaDesignSystemsCatalog(rootDir);
  const system = slideData?.design_system_id ? designSystems.systems?.[slideData.design_system_id] : null;
  const defaults = catalog.defaults?.['title-body'] || null;
  const preset = catalog.presets?.[presetKey] || catalog.presets?.[mediaKind] || defaults;
  const override = system?.slide_layout_overrides?.[presetKey] || system?.slide_layout_overrides?.[mediaKind] || null;
  if (!preset && !override) return null;
  return mergePptxShape(preset || {}, override || {});
}

function buildPptxSlideFromPattern(rootDir: string, data: any, idx: number, theme: any, pattern: any, activeMaster: any, canvas: any) {
  const themeColors = theme?.colors || {};
  const semanticType = data.semantic_type || classifyRenderSemantic(data.layout_key, data.media_kind);
  const semanticTokens = resolveSemanticRenderTokens(rootDir, semanticType, data.design_system_id);
  const pptxTokens = semanticTokens.pptx || {};
  const pageLayouts = pattern?.page_layouts || {};
  const pageLayoutId = data.page_layout || data.page_layout_id || data.layout_id;
  const pageLayout = pageLayoutId ? pageLayouts[pageLayoutId] : undefined;
  const runtimePreset = resolveRuntimeSlidePreset(rootDir, data);
  const placeholderConfig = {
    ...(runtimePreset || {}),
    ...(pageLayout?.placeholders || {}),
  };
  const bodyText = Array.isArray(data.body) ? data.body.join('\n') : (data.subtitle || data.body || '');
  const elements: any[] = [];

  if (Array.isArray(pageLayout?.elements)) {
    elements.push(...cloneJsonValue(pageLayout.elements));
  }

  if (data.title && placeholderConfig.title !== false) {
    const titleElement = mergePptxShape({
      type: 'text',
      placeholderType: 'title',
      pos: { x: 0.5, y: 0.5, w: 9, h: 1 },
      text: data.title,
      style: {
        fontSize: 32,
        bold: true,
        color: (themeColors.text || '#000000').replace('#', ''),
        fontFamily: theme?.fonts?.heading?.split(',')[0] || 'Inter',
        align: pptxTokens.title_align || 'center',
      },
    }, placeholderConfig.title);
    titleElement.style = {
      ...(titleElement.style || {}),
      align: pptxTokens.title_align || titleElement.style?.align,
    };
    titleElement.text = resolveSlideTemplate(titleElement.text, data, data.title);
    elements.push(titleElement);
  }

  if (bodyText && placeholderConfig.body !== false) {
    const bodyElement = mergePptxShape({
      type: 'text',
      placeholderType: 'body',
      pos: { x: 1, y: 1.8, w: 8, h: 2.8 },
      text: bodyText,
      style: {
        fontSize: 18 + Number(pptxTokens.body_font_size_delta || 0),
        color: resolveThemeHexColor(themeColors, pptxTokens.body_color_role, '#334155').replace('#', ''),
        fontFamily: theme?.fonts?.body?.split(',')[0] || 'System-ui',
        align: 'left',
        valign: 'top',
      },
    }, placeholderConfig.body);
    bodyElement.style = {
      ...(bodyElement.style || {}),
      fontSize: 18 + Number(pptxTokens.body_font_size_delta || 0),
      color: resolveThemeHexColor(themeColors, pptxTokens.body_color_role, '#334155').replace('#', ''),
    };
    bodyElement.text = resolveSlideTemplate(bodyElement.text, data, bodyText);
    elements.push(bodyElement);
  }

  if (data.visual && placeholderConfig.visual !== false) {
    const visualElement = mergePptxShape({
      type: 'shape',
      shapeType: 'rect',
      pos: { x: 1, y: 4.6, w: 8, h: 0.5 },
      text: `[Visual: ${data.visual}]`,
      style: {
        fill: resolveThemeHexColor(themeColors, pptxTokens.visual_fill_role, '#F1F5F9').replace('#', ''),
        color: resolveThemeHexColor(themeColors, pptxTokens.visual_text_role, '#64748B').replace('#', ''),
        fontSize: 12,
        italic: true,
        align: 'center',
        valign: 'middle',
      },
    }, placeholderConfig.visual);
    visualElement.style = {
      ...(visualElement.style || {}),
      fill: resolveThemeHexColor(themeColors, pptxTokens.visual_fill_role, '#F1F5F9').replace('#', ''),
      color: resolveThemeHexColor(themeColors, pptxTokens.visual_text_role, '#64748B').replace('#', ''),
    };
    visualElement.text = resolveSlideTemplate(visualElement.text, data, `[Visual: ${data.visual}]`);
    elements.push(visualElement);
  }

  if (Array.isArray(data.elements)) {
    elements.push(...cloneJsonValue(data.elements));
  }

  return {
    id: data.id || `slide${idx + 1}`,
    elements,
    backgroundFill: data.backgroundFill || pageLayout?.backgroundFill,
    bgXml: data.bgXml || pageLayout?.bgXml,
    transitionXml: data.transitionXml || pageLayout?.transitionXml,
    notesXml: data.notesXml,
    extensions: data.extensions || pageLayout?.extensions,
    metadata: {
      pageLayoutId,
      layoutKey: data.layout_key,
      mediaKind: data.media_kind,
      semanticType,
      canvas,
      hasMaster: Boolean(activeMaster),
    },
  };
}

async function handleAction(input: MediaAction) {
  if (input.action !== 'pipeline') throw new Error('Unsupported action');
  return await executePipeline(input.steps || [], input.context || {}, input.options);
}

async function executePipeline(steps: PipelineStep[], initialCtx: any = {}, options: any = {}, state: any = { stepCount: 0, startTime: Date.now() }) {
  const rootDir = process.cwd();
  let ctx = { ...initialCtx, timestamp: new Date().toISOString() };
  
  const resolve = (val: any) => {
    if (typeof val !== 'string') return val;
    const singleVarMatch = val.match(/^{{(.*?)}}$/);
    if (singleVarMatch) {
      const parts = singleVarMatch[1].trim().split('.');
      let current = ctx;
      for (const part of parts) { current = current?.[part]; }
      return current !== undefined ? current : '';
    }
    return val.replace(/{{(.*?)}}/g, (_, p) => {
      const parts = p.trim().split('.');
      let current = ctx;
      for (const part of parts) { current = current?.[part]; }
      return current !== undefined ? (typeof current === 'object' ? JSON.stringify(current) : String(current)) : '';
    });
  };

  const results = [];
  for (const step of steps) {
    state.stepCount++;
    try {
      logger.info(`  [MEDIA_PIPELINE] [Step ${state.stepCount}] ${step.type}:${step.op}...`);
      switch (step.type) {
        case 'capture': ctx = await opCapture(step.op, step.params, ctx, resolve); break;
        case 'transform': ctx = await opTransform(step.op, step.params, ctx, resolve); break;
        case 'apply': ctx = await opApply(step.op, step.params, ctx, resolve); break;
        case 'control': {
          if (step.op === 'ref') {
            const refPath = resolve(step.params.path);
            const bindResolved: Record<string, any> = {};
            if (step.params.bind) {
              for (const [k, v] of Object.entries(step.params.bind as Record<string, any>)) {
                bindResolved[k] = resolve(v);
              }
            }
            const refResult = await resolveRef(refPath, bindResolved, ctx, resolve);
            const subResult = await executePipeline(refResult.steps, { ...ctx, ...refResult.mergedCtx }, options, state);
            const { _refDepth, ...subCtxClean } = subResult.context || {};
            ctx = { ...ctx, ...subCtxClean };
          }
          break;
        }
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
      const stepOnError = (step as any).on_error;
      if (stepOnError) {
        try {
          const recovery = await handleStepError(err, step, stepOnError, ctx,
            async (fallbackSteps: any[], errCtx: any) => {
              const res = await executePipeline(fallbackSteps, errCtx, options, state);
              return res.context;
            }, resolve);
          if (recovery.recovered) {
            ctx = recovery.ctx;
            results.push({ op: step.op, status: 'recovered' as any });
            continue;
          }
        } catch (_) { /* fallthrough to default error handling */ }
      }
      logger.error(`  [MEDIA_PIPELINE] Step failed (${step.op}): ${err.message}`);
      results.push({ op: step.op, status: 'failed', error: err.message });
      break;
    }
  }

  if (initialCtx.context_path) {
    safeWriteFile(path.resolve(rootDir, initialCtx.context_path), JSON.stringify(ctx, null, 2));
  }

  return { status: derivePipelineStatus(results), results, context: ctx };
}

async function opCapture(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = process.cwd();
  switch (op) {
    case 'json_read': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      const parsed = JSON.parse(safeReadFile(sourcePath, { encoding: 'utf8' }) as string);
      return { ...ctx, [params.export_as || 'last_json']: parsed };
    }
    case 'pptx_extract': {
      const sourcePath = path.resolve(rootDir, resolve(params.path));
      const assetsDir = pathResolver.sharedTmp(`actuators/media-actuator/assets_${Date.now()}`);
      const design = await pptxUtils.distillPptxDesign(sourcePath, assetsDir);
      return { ...ctx, [params.export_as || 'last_pptx_design']: design, last_assets_dir: assetsDir };
    }
    case 'xlsx_extract': {
      const xlsxPath = path.resolve(rootDir, resolve(params.path));
      const xlsxDesign = await xlsxUtils.distillXlsxDesign(xlsxPath);
      return { ...ctx, [params.export_as || 'last_xlsx_design']: xlsxDesign };
    }
    case 'docx_extract': {
      const docxPath = path.resolve(rootDir, resolve(params.path));
      const docxDesign = await docxUtils.distillDocxDesign(docxPath);
      return { ...ctx, [params.export_as || 'last_docx_design']: docxDesign };
    }
    case 'pdf_extract': {
      const pdfPath = path.resolve(rootDir, resolve(params.path));
      let pdfDesign = await distillPdfDesign(pdfPath, { aesthetic: params.aesthetic !== false });
      try {
        const extractedText = await extractCleanerPdfText(pdfPath);
        pdfDesign = mergeCleanerPdfText(pdfDesign, extractedText);
      } catch (error: any) {
        logger.warn(`[MEDIA_CAPTURE] pdf_extract cleaner text fallback unavailable: ${error.message}`);
      }
      return { ...ctx, [params.export_as || 'last_pdf_design']: pdfDesign };
    }
    default: return ctx;
  }
}

async function opTransform(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = process.cwd();
  switch (op) {
    case 'pdf_to_pptx_design': {
      const pdfDesign = ctx[params.from || 'last_pdf_design'];
      if (!pdfDesign || typeof pdfDesign !== 'object') {
        throw new Error(`pdf_to_pptx_design could not find context key: ${params.from || 'last_pdf_design'}`);
      }
      const augmentedPdfDesign = await maybeAugmentPdfDesignWithImageOcr(pdfDesign as PdfDesignProtocol, params.hints);
      return {
        ...ctx,
        [params.export_as || 'last_pptx_design']: buildPptxProtocolFromPdfDesign(augmentedPdfDesign, params.hints),
        merged_output_format: 'pptx',
      };
    }
    case 'pdf_to_xlsx_design': {
      const pdfDesign = ctx[params.from || 'last_pdf_design'];
      if (!pdfDesign || typeof pdfDesign !== 'object') {
        throw new Error(`pdf_to_xlsx_design could not find context key: ${params.from || 'last_pdf_design'}`);
      }
      return {
        ...ctx,
        [params.export_as || 'last_xlsx_design']: buildXlsxProtocolFromPdfDesign(pdfDesign as PdfDesignProtocol, params.hints),
        merged_output_format: 'xlsx',
      };
    }
    case 'apply_theme': {
      const themes = loadThemeCatalog(rootDir);
      if (!themes || typeof themes !== 'object' || !themes.themes) {
        logger.warn('[MEDIA_TRANSFORM] theme catalog not found, skipping theme application');
        return ctx;
      }
      const themeName = resolve(params.theme) || themes.default_theme || 'kyberion-standard';
      const theme = themes.themes[themeName];
      if (!theme) {
        logger.warn(`[MEDIA_TRANSFORM] Theme "${themeName}" not found, available: ${Object.keys(themes.themes).join(', ')}`);
        return ctx;
      }
      return { ...ctx, active_theme: theme, active_theme_name: themeName };
    }
    case 'apply_pattern': {
      const patternPath = path.resolve(rootDir, resolve(params.pattern_path));
      if (!safeExistsSync(patternPath)) {
        throw new Error(`Design pattern not found: ${patternPath}`);
      }
      const pattern = JSON.parse(safeReadFile(patternPath, { encoding: 'utf8' }) as string);
      return { ...ctx, active_pattern: pattern, pattern_id: pattern.pattern_id };
    }
    case 'merge_content': {
      const pattern = ctx.active_pattern;
      const theme = ctx.active_theme;
      const contentData = resolve(params.content_data) || pattern?.content_data || [];
      const outputFormat = resolve(params.output_format) || pattern?.media_actuator_config?.engine || 'pptx';

      if (outputFormat === 'pptx') {
        const themeColors = theme?.colors || {};
        const activeMaster = ctx.active_pptx_master;
        const canvas = ctx.active_canvas || { w: 10, h: 5.625 };
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
          slides: contentData.map((data: any, idx: number) => buildPptxSlideFromPattern(rootDir, data, idx, theme, pattern, activeMaster, canvas)),
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
      const brief = normalizeProposalBrief(rawBrief);
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

      return {
        ...ctx,
        [params.export_as || 'document_outline']: outline,
      };
    }
    case 'brief_to_design_protocol': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief = params.brief && typeof params.brief === 'object' ? params.brief : ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`brief_to_design_protocol could not find context key: ${fromKey}`);
      }
      const compiled = compileBriefToDesignProtocol(rootDir, rawBrief);
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
        active_theme: ctx.active_theme || resolveNamedTheme(rootDir, storyline.recommended_theme) || ctx.active_theme,
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
        const activeTheme = ctx.active_theme || loadFallbackDrawioTheme(rootDir, brief.layout_template_id);
        nextCtx.last_drawio_document = generateDrawioDocument(brief.payload.graph, {
          title: brief.payload.title || brief.title || 'Diagram',
          theme: activeTheme,
          iconMap,
          iconRoot: params.icon_root ? path.resolve(rootDir, resolve(params.icon_root)) : undefined,
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
      const activeTheme = ctx.active_theme || loadFallbackDrawioTheme(rootDir, preferredTheme);
      const document = generateDrawioDocument(graph, {
        title: resolve(params.title) || graph.title || 'Architecture Diagram',
        theme: activeTheme,
        iconMap,
        iconRoot: params.icon_root ? path.resolve(rootDir, resolve(params.icon_root)) : undefined,
      });
      return {
        ...ctx,
        [params.export_as || 'last_drawio_document']: document,
        last_drawio_graph: graph,
      };
    }
    default:
      logger.warn(`[MEDIA_TRANSFORM] Unknown transform op: ${op}`);
      return ctx;
  }
}

async function opApply(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = process.cwd();
  switch (op) {
    case 'mermaid_render': {
      const outPath = path.resolve(rootDir, resolve(params.path));
      const source = resolveDiagramSource(rootDir, params, ctx, resolve);
      ensureParentDir(outPath);

      const tempDir = pathResolver.sharedTmp(`actuators/media-actuator/diagram_${Date.now()}`);
      safeMkdir(tempDir, { recursive: true });

      const inputPath = path.join(tempDir, 'diagram.mmd');
      safeWriteFile(inputPath, source);

      const args = ['-i', inputPath, '-o', outPath];
      const activeTheme = resolveDiagramTheme(params, ctx, resolve);
      const mermaidConfig = buildMermaidConfig(activeTheme, params.background_color ? resolve(params.background_color) : undefined);
      const configPath = path.join(tempDir, 'mermaid.config.json');
      safeWriteFile(configPath, JSON.stringify(mermaidConfig, null, 2));
      args.push('-c', configPath);

      if (params.width) args.push('-w', String(resolve(params.width)));
      if (params.height) args.push('-H', String(resolve(params.height)));
      if (params.background_color) args.push('-b', String(resolve(params.background_color)));

      safeExec('mmdc', args, { cwd: rootDir, timeoutMs: params.timeout_ms || 30000 });

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Mermaid rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'd2_render': {
      const outPath = path.resolve(rootDir, resolve(params.path));
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

      safeExec('d2', args, { cwd: rootDir, timeoutMs: params.timeout_ms || 30000 });

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
      const outPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      await renderDiagramDocumentBrief(rootDir, brief, outPath, params, ctx, resolve);
      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Diagram rendered from brief at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'pptx_render': {
      const protocol = ctx[params.design_from || 'last_pptx_design'];
      const outPath = path.resolve(rootDir, resolve(params.path || params.output_path));

      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });

      await generateNativePptx(protocol, outPath);

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] PPTX rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'pptx_patch': {
      const sourcePath = path.resolve(rootDir, resolve(params.source));
      const outPath = path.resolve(rootDir, resolve(params.path));
      const replacements = params.replacements || ctx[params.replacements_from || 'last_replacements'] || {};

      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });

      patchPptxText(sourcePath, outPath, replacements);

      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] PPTX patched at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'xlsx_render': {
      const xlsxProtocol = normalizeXlsxDesignProtocol(ctx[params.design_from || 'last_xlsx_design']);
      const xlsxOutPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      if (!safeExistsSync(path.dirname(xlsxOutPath))) safeMkdir(path.dirname(xlsxOutPath), { recursive: true });
      await generateNativeXlsx(xlsxProtocol, xlsxOutPath);
      const xlsxStats = safeStat(xlsxOutPath);
      logger.info(`✅ [MEDIA] XLSX rendered at: ${xlsxOutPath} (${xlsxStats.size} bytes).`);
      break;
    }
    case 'docx_render': {
      const docxProtocol = ctx[params.design_from || 'last_docx_design'];
      const docxOutPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      if (!safeExistsSync(path.dirname(docxOutPath))) safeMkdir(path.dirname(docxOutPath), { recursive: true });
      await generateNativeDocx(docxProtocol, docxOutPath);
      const docxStats = safeStat(docxOutPath);
      logger.info(`✅ [MEDIA] DOCX rendered at: ${docxOutPath} (${docxStats.size} bytes).`);
      break;
    }
    case 'pdf_render': {
      const pdfProtocol = ctx[params.design_from || 'last_pdf_design'];
      const pdfOutPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      if (!safeExistsSync(path.dirname(pdfOutPath))) safeMkdir(path.dirname(pdfOutPath), { recursive: true });
      await generateNativePdf(pdfProtocol, pdfOutPath, params.options);
      const pdfStats = safeStat(pdfOutPath);
      logger.info(`✅ [MEDIA] PDF rendered at: ${pdfOutPath} (${pdfStats.size} bytes).`);
      break;
    }
    case 'generate_document': {
      const fromKey = resolve(params.from) || 'last_json';
      const inlineData = params.data && typeof params.data === 'object' ? params.data : {};
      const source = params.brief && typeof params.brief === 'object' ? params.brief : (ctx[fromKey] && typeof ctx[fromKey] === 'object' ? ctx[fromKey] : {});
      const renderTarget = String(params.render_target || source.render_target || inlineData.render_target || '').trim();
      const profileId = String(params.profile_id || source.document_profile || inlineData.document_profile || '').trim();
      const brief = buildUnifiedDocumentBrief(rootDir, {
        profileId,
        renderTarget,
        source,
        data: inlineData,
      });
      const compiled = compileBriefToDesignProtocol(rootDir, brief);
      const outPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      await renderCompiledProtocol(compiled, outPath, params.options);
      const stats = safeStat(outPath);
      logger.info(`✅ [MEDIA] Unified document generated at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'write_file':
      safeWriteFile(path.resolve(rootDir, resolve(params.path)), ctx[params.from] || params.content);
      break;
    case 'drawio_write': {
      const outPath = path.resolve(rootDir, resolve(params.path));
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
    case 'log': logger.info(`[MEDIA_LOG] ${resolve(params.message)}`); break;
  }
  return ctx;
}

function ensureParentDir(targetPath: string): void {
  const parentDir = path.dirname(targetPath);
  if (!safeExistsSync(parentDir)) {
    safeMkdir(parentDir, { recursive: true });
  }
}

function deepMergeCatalog(base: any, next: any): any {
  if (Array.isArray(base) || Array.isArray(next)) {
    return cloneJsonValue(next);
  }
  if (!base || typeof base !== 'object') return cloneJsonValue(next);
  if (!next || typeof next !== 'object') return cloneJsonValue(next);
  const merged: Record<string, any> = { ...base };
  for (const [key, value] of Object.entries(next)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && merged[key] && typeof merged[key] === 'object' && !Array.isArray(merged[key])) {
      merged[key] = deepMergeCatalog(merged[key], value);
    } else {
      merged[key] = cloneJsonValue(value);
    }
  }
  return merged;
}

function readJsonFilesRecursively(dirPath: string): any[] {
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
    if (!entry.endsWith('.json')) continue;
    docs.push(JSON.parse(safeReadFile(fullPath, { encoding: 'utf8' }) as string));
  }
  return docs;
}

function loadJsonCatalog(rootDir: string, input: {
  directoryPath: string;
  filePath: string;
  fallback: any;
}): any {
  const dirPath = path.resolve(rootDir, input.directoryPath);
  const filePath = path.resolve(rootDir, input.filePath);
  const docs = readJsonFilesRecursively(dirPath);
  if (docs.length > 0) {
    return docs.reduce((acc, doc) => deepMergeCatalog(acc, doc), cloneJsonValue(input.fallback));
  }
  if (safeExistsSync(filePath)) {
    return JSON.parse(safeReadFile(filePath, { encoding: 'utf8' }) as string);
  }
  return cloneJsonValue(input.fallback);
}

function loadArtifactLibraryCatalog(rootDir: string): any {
  const dirPath = path.resolve(rootDir, 'knowledge/public/design-patterns/media-templates/artifact-library');
  const docs = readJsonFilesRecursively(dirPath);
  const fallback = { profiles: {} };
  if (docs.length === 0) {
    return fallback;
  }
  return docs.reduce((acc, doc) => {
    if (!doc || typeof doc !== 'object') return acc;
    return deepMergeCatalog(acc, { profiles: doc.profiles || {} });
  }, cloneJsonValue(fallback));
}

function loadDocumentCompositionCatalog(rootDir: string): any {
  const primaryCatalog = loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/document-composition-presets',
    filePath: 'knowledge/public/design-patterns/media-templates/document-composition-presets.json',
    fallback: { defaults: {}, profiles: {} },
  });
  const artifactLibraryCatalog = loadArtifactLibraryCatalog(rootDir);
  return {
    ...primaryCatalog,
    profiles: {
      ...(artifactLibraryCatalog.profiles || {}),
      ...(primaryCatalog.profiles || {}),
    },
  };
}

function loadThemeCatalog(rootDir: string): any {
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/themes',
    filePath: 'knowledge/public/design-patterns/media-templates/themes.json',
    fallback: { default_theme: 'kyberion-standard', themes: {} },
  });
}

function loadMediaDesignSystemsCatalog(rootDir: string): any {
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/media-design-systems',
    filePath: 'knowledge/public/design-patterns/media-templates/media-design-systems.json',
    fallback: { default_system: 'executive-standard', systems: {} },
  });
}

function loadImportedDesignMdIndex(rootDir: string): any {
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/design-md-catalog',
    filePath: 'knowledge/public/design-patterns/media-templates/design-md-catalog/index.json',
    fallback: { systems: [] },
  });
}

function normalizeDesignLookupKey(input: any): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function resolveDesignBindingHints(brief: any): {
  tenant_id?: string;
  client_key?: string;
  design_system_id?: string;
  design_reference?: string;
  theme?: string;
  branding?: Record<string, any>;
} {
  const direct = {
    tenant_id: String(brief?.tenant_id || brief?.payload?.tenant_id || '').trim() || undefined,
    client_key: String(brief?.client_key || brief?.payload?.client_key || '').trim() || undefined,
    design_system_id: String(brief?.design_system_id || brief?.payload?.design_system_id || '').trim() || undefined,
    design_reference: String(brief?.design_reference || brief?.payload?.design_reference || '').trim() || undefined,
    theme: String(brief?.theme || brief?.payload?.theme || '').trim() || undefined,
    branding: (brief?.branding && typeof brief.branding === 'object') ? brief.branding : ((brief?.payload?.branding && typeof brief.payload.branding === 'object') ? brief.payload.branding : {}),
  };
  const projectId = String(brief?.project_id || brief?.payload?.project_id || '').trim();
  const project = projectId ? loadProjectRecord(projectId) : null;
  const projectMeta = (project?.metadata && typeof project.metadata === 'object') ? project.metadata as Record<string, any> : {};
  const bindingIds = [
    ...((Array.isArray(project?.service_bindings) ? project!.service_bindings : []).map((value: any) => String(value))),
    ...((Array.isArray(brief?.service_binding_ids) ? brief.service_binding_ids : []).map((value: any) => String(value))),
    ...((Array.isArray(brief?.payload?.service_binding_ids) ? brief.payload.service_binding_ids : []).map((value: any) => String(value))),
  ].filter(Boolean);
  const bindings = bindingIds
    .map((bindingId) => loadServiceBindingRecord(bindingId))
    .filter((value): value is NonNullable<typeof value> => Boolean(value));
  const bindingMeta = bindings
    .map((binding) => (binding.metadata && typeof binding.metadata === 'object') ? binding.metadata as Record<string, any> : {})
    .find((meta) => Object.keys(meta).length > 0) || {};

  return {
    tenant_id: direct.tenant_id || String(projectMeta.tenant_id || bindingMeta.tenant_id || '').trim() || undefined,
    client_key: direct.client_key || String(projectMeta.client_key || bindingMeta.client_key || '').trim() || undefined,
    design_system_id: direct.design_system_id || String(projectMeta.design_system_id || bindingMeta.design_system_id || '').trim() || undefined,
    design_reference: direct.design_reference || String(projectMeta.design_reference || bindingMeta.design_reference || bindingMeta.design_system_slug || '').trim() || undefined,
    theme: direct.theme || String(projectMeta.theme || bindingMeta.theme || '').trim() || undefined,
    branding: {
      ...(projectMeta.branding || {}),
      ...(bindingMeta.branding || {}),
      ...(direct.branding || {}),
    },
  };
}

function resolveImportedDesignReference(rootDir: string, input: any): any | null {
  const catalog = loadImportedDesignMdIndex(rootDir);
  const candidates = [
    input?.design_reference,
    input?.client_key,
    input?.tenant_id,
    input?.client,
    input?.project_name,
    input?.project_id,
  ]
    .map((value: any) => normalizeDesignLookupKey(value))
    .filter(Boolean);
  if (candidates.length === 0) return null;
  const systems = Array.isArray(catalog.systems) ? catalog.systems : [];
  return systems.find((entry: any) => {
    const values = [
      entry?.design_system_id,
      entry?.theme_id,
      entry?.slug,
      entry?.name,
      entry?.description,
      entry?.category,
      ...(Array.isArray(entry?.keywords) ? entry.keywords : []),
    ].map(normalizeDesignLookupKey);
    return candidates.some((candidate) => values.some((value) => {
      if (!value) return false;
      if (value === candidate) return true;
      if (candidate.length >= 4 && value.includes(candidate)) return true;
      return false;
    }));
  }) || null;
}

function recommendImportedDesignReferences(rootDir: string, brief: any, limit = 3): any[] {
  const catalog = loadImportedDesignMdIndex(rootDir);
  const systems = Array.isArray(catalog.systems) ? catalog.systems : [];
  const haystack = normalizeDesignLookupKey([
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
  ].filter(Boolean).join(' '));

  if (!haystack) return [];

  const scored = systems.map((entry: any) => {
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
      else if (haystack.includes(term)) score += Math.min(6, Math.max(2, term.split(' ').length + 1));
      else if (term.includes(haystack)) score += 1;
    }
    return {
      ...entry,
      recommendation_score: score,
    };
  })
    .filter((entry: any) => entry.recommendation_score > 0)
    .sort((left: any, right: any) => {
      if (right.recommendation_score !== left.recommendation_score) return right.recommendation_score - left.recommendation_score;
      return String(left.design_system_id || '').localeCompare(String(right.design_system_id || ''));
    });

  return scored.slice(0, limit).map((entry: any) => ({
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

function resolveMediaDesignSystem(rootDir: string, brief: any): { designSystemId: string; system: any; tenantOverride: any; resolvedThemeName: string; branding: any; promptGuide: string[]; sourceDesign?: Record<string, any> | null; recommendations: any[] } {
  const catalog = loadMediaDesignSystemsCatalog(rootDir);
  const bindingHints = resolveDesignBindingHints(brief);
  const recommendations = recommendImportedDesignReferences(rootDir, brief);
  const explicit = String(bindingHints.design_system_id || '').trim();
  const resolveTenantOverride = (system: any) => {
    const tenantKey = normalizeDesignLookupKey(bindingHints.tenant_id || bindingHints.client_key || brief?.client || brief?.payload?.client);
    const overrides = system?.tenant_overrides || {};
    const matched = Object.entries(overrides).find(([overrideId, override]: any) => {
      if (normalizeDesignLookupKey(overrideId) === tenantKey) return true;
      return Array.isArray(override?.matchers) && override.matchers.some((matcher: string) => normalizeDesignLookupKey(matcher) === tenantKey);
    });
    return matched ? (matched[1] as any) : null;
  };
  const buildResult = (designSystemId: string, system: any) => {
    const tenantOverride = resolveTenantOverride(system);
    const promptGuide = Array.isArray(system?.metadata?.prompt_guide) ? system.metadata.prompt_guide : [];
    return {
      designSystemId,
      system,
      tenantOverride,
      resolvedThemeName: String(bindingHints.theme || tenantOverride?.theme || system?.theme || 'kyberion-standard'),
      branding: {
        ...(system?.branding || {}),
        ...(tenantOverride?.branding || {}),
        ...(bindingHints.branding || {}),
      },
      promptGuide,
      recommendations,
      sourceDesign: system?.metadata?.source_type === 'design-md' ? {
        source_type: system.metadata.source_type,
        source_repo: system.metadata.source_repo,
        source_path: system.metadata.source_path,
        slug: system.metadata.slug,
        category: system.metadata.category,
        description: system.metadata.description,
      } : null,
    };
  };
  if (explicit && catalog.systems?.[explicit]) {
    return buildResult(explicit, catalog.systems[explicit]);
  }
  const imported = resolveImportedDesignReference(rootDir, {
    ...bindingHints,
    client: brief?.client || brief?.payload?.client,
    project_name: brief?.project_name || brief?.payload?.project_name || brief?.name || brief?.payload?.name,
    project_id: brief?.project_id || brief?.payload?.project_id,
  });
  if (imported?.design_system_id && catalog.systems?.[imported.design_system_id]) {
    return buildResult(imported.design_system_id, catalog.systems[imported.design_system_id]);
  }
  const profileId = String(brief?.document_profile || '').trim();
  const matched = Object.entries(catalog.systems || {}).find(([, system]: any) =>
    Array.isArray(system?.profiles) && system.profiles.includes(profileId),
  );
  if (matched) {
    return buildResult(matched[0], matched[1]);
  }
  const fallbackId = String(catalog.default_system || 'executive-standard');
  return buildResult(fallbackId, catalog.systems?.[fallbackId] || {});
}

function loadSemanticRenderTokenCatalog(rootDir: string): any {
  return loadJsonCatalog(rootDir, {
    directoryPath: 'knowledge/public/design-patterns/media-templates/semantic-render-tokens',
    filePath: 'knowledge/public/design-patterns/media-templates/semantic-render-tokens.json',
    fallback: { defaults: { content: {} }, semantics: {}, signal_tones: {} },
  });
}

function resolveSemanticRenderTokens(rootDir: string, semanticType?: string, designSystemId?: string): any {
  const catalog = loadSemanticRenderTokenCatalog(rootDir);
  const key = String(semanticType || 'content').trim() || 'content';
  const designSystems = loadMediaDesignSystemsCatalog(rootDir);
  const systemOverrides = designSystemId
    ? designSystems.systems?.[designSystemId]?.semantic_overrides?.[key] || {}
    : {};
  return {
    ...(catalog.defaults?.content || {}),
    ...(catalog.semantics?.[key] || {}),
    ...systemOverrides,
  };
}

function resolveSemanticComponentRule(rootDir: string, semanticType: string | undefined, medium: string, component: string): any {
  const tokens = resolveSemanticRenderTokens(rootDir, semanticType);
  return {
    ...((tokens?.[medium] && tokens[medium][component]) ? tokens[medium][component] : {}),
  };
}

function resolveNamedTheme(rootDir: string, preferredTheme?: string): any {
  const catalog = loadThemeCatalog(rootDir);
  const themeName = String(preferredTheme || catalog.default_theme || 'kyberion-standard').trim();
  return catalog.themes?.[themeName] || catalog.themes?.[catalog.default_theme] || null;
}

function resolveDocumentCompositionPreset(rootDir: string, brief: any): { profileId: string; preset: any } {
  const catalog = loadDocumentCompositionCatalog(rootDir);
  const { designSystemId, resolvedThemeName, branding, promptGuide, sourceDesign, recommendations } = resolveMediaDesignSystem(rootDir, brief);
  const profileId = String(
    brief.document_profile ||
    catalog.defaults?.[brief.document_type] ||
    catalog.defaults?.[brief.artifact_family] ||
    '',
  ).trim();
  const preset = catalog.profiles?.[profileId];
  if (!preset) {
    return {
      profileId,
      preset: {
        narrative_pattern_id: 'generic-structured',
        design_system_id: designSystemId,
        recommended_theme: resolvedThemeName || 'kyberion-standard',
        branding,
        prompt_guide: promptGuide,
        source_design: sourceDesign,
        design_recommendations: recommendations,
        recommended_layout_template_id: brief.layout_template_id,
        sections: [],
      },
    };
  }
  return {
    profileId,
    preset: {
      ...preset,
      design_system_id: preset.design_system_id || designSystemId,
      recommended_theme: resolvedThemeName || preset.recommended_theme || 'kyberion-standard',
      branding: {
        ...(preset.branding || {}),
        ...(branding || {}),
      },
      prompt_guide: Array.isArray(preset.prompt_guide) && preset.prompt_guide.length > 0 ? preset.prompt_guide : promptGuide,
      source_design: preset.source_design || sourceDesign,
      design_recommendations: Array.isArray(preset.design_recommendations) && preset.design_recommendations.length > 0 ? preset.design_recommendations : recommendations,
    },
  };
}

function buildOutlineDrivenPptxProtocol(rootDir: string, outline: any): { protocol: any; theme: any; themeName: string } {
  const theme = resolveNamedTheme(rootDir, outline.recommended_theme);
  const themeColors = theme?.colors || {};
  const canvas = { w: 10, h: 5.625 };
  const contentData = outline.toc.map((entry: any) => ({
    title: entry.title,
    body: Array.isArray(entry.body) ? entry.body : [entry.objective].filter(Boolean),
    subtitle: entry.objective,
    visual: entry.visual || entry.supporting_visual,
    media_kind: entry.media_kind,
    layout_key: entry.layout_key,
    semantic_type: entry.semantic_type,
    design_system_id: outline.design_system_id,
    branding: outline.branding || {},
  }));
  const protocol = {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    metadata: {
      composition: outline,
      generationBoundary: outline.generation_boundary || buildMediaGenerationBoundary(outline),
      promptGuide: outline.prompt_guide || [],
      sourceDesign: outline.source_design || null,
      designRecommendations: outline.design_recommendations || [],
    },
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
      elements: [],
    },
    slides: contentData.map((data: any, idx: number) => buildPptxSlideFromPattern(rootDir, data, idx, theme, {}, null, canvas)),
  };
  return {
    protocol,
    theme,
    themeName: outline.recommended_theme,
  };
}

function buildPresentationPptxProtocol(rootDir: string, brief: any): { protocol: any; outline: any; theme: any; themeName: string } {
  const outline = buildProposalNarrativeOutline(rootDir, brief);
  const compiled = buildOutlineDrivenPptxProtocol(rootDir, outline);
  return {
    ...compiled,
    outline,
  };
}

type MediaBriefCategory = 'presentation' | 'document' | 'spreadsheet' | 'diagram';
type ProtocolKind = 'pptx' | 'docx' | 'pdf' | 'xlsx';
const LEGACY_MEDIA_OPS = new Set([
  'document_report_design_from_brief',
  'document_spreadsheet_design_from_brief',
  'document_diagram_render_from_brief',
]);

function warnLegacyMediaOp(op: string): void {
  if (!LEGACY_MEDIA_OPS.has(op)) return;
  logger.warn(
    `[MEDIA_COMPAT] ${op} is a compatibility adapter. Prefer document_outline_from_brief -> brief_to_design_protocol -> generate_document.`,
  );
}

function buildMediaGenerationBoundary(briefOrOutline: any): any {
  return {
    source_of_truth: {
      document_profile: String(briefOrOutline?.document_profile || ''),
      design_system_id: String(briefOrOutline?.design_system_id || ''),
      knowledge_controls: [
        'document_profile',
        'sections',
        'narrative_pattern_id',
        'layout_key',
        'media_kind',
        'semantic_type',
        'recommended_theme',
      ],
    },
    llm_zone: {
      allowed: [
        'normalize_intent_into_brief',
        'draft_section_objective',
        'draft_body_content',
        'draft_bullets_callouts_tables',
        'localize_operator_facing_text',
      ],
      forbidden: [
        'override_governed_sections',
        'invent_layout_coordinates',
        'invent_semantic_tokens',
        'write_renderer_specific_binary_contracts',
      ],
    },
    compiler_zone: {
      responsibilities: [
        'resolve_profile_and_sections_from_knowledge',
        'map_sections_to_outline',
        'map_outline_to_design_protocol',
        'fill_renderer_defaults_and_guards',
      ],
    },
    renderer_zone: {
      responsibilities: [
        'materialize_pptx_docx_pdf_xlsx_binary',
        'apply_format_specific_low_level_rules',
        'preserve_reproducibility',
      ],
    },
    rule: 'sections-first; document_type is fallback taxonomy; render_target chooses physical renderer last',
  };
}

function resolveMediaBriefCategory(rawBrief: any): MediaBriefCategory {
  if (!rawBrief || typeof rawBrief !== 'object') {
    throw new Error('resolveMediaBriefCategory: brief must be an object');
  }
  if (rawBrief.kind === 'proposal-brief') return 'presentation';
  const artifactFamily = String(rawBrief.artifact_family || '').trim();
  if (!rawBrief.kind && artifactFamily === 'presentation') return 'presentation';
  if (!rawBrief.kind && artifactFamily === 'document') return 'document';
  if (!rawBrief.kind && artifactFamily === 'spreadsheet') return 'spreadsheet';
  if (!rawBrief.kind && artifactFamily === 'diagram') return 'diagram';
  if (rawBrief.kind !== 'document-brief') {
    throw new Error(`Unsupported brief kind: ${String(rawBrief.kind || 'unknown')}`);
  }
  if (artifactFamily === 'presentation') return 'presentation';
  if (artifactFamily === 'document') return 'document';
  if (artifactFamily === 'spreadsheet') return 'spreadsheet';
  if (artifactFamily === 'diagram') return 'diagram';
  throw new Error(`Unsupported artifact_family in document-brief: ${artifactFamily || 'unknown'}`);
}

function normalizeBriefForCategory(rootDir: string, rawBrief: any): any {
  const category = resolveMediaBriefCategory(rawBrief);
  if (!rawBrief?.kind) return rawBrief;
  if (category === 'presentation') return normalizeProposalBrief(rawBrief);
  if (category === 'document') return normalizeReportDocumentBrief(rawBrief);
  if (category === 'spreadsheet') return normalizeSpreadsheetDocumentBrief(rootDir, rawBrief);
  return normalizeDiagramDocumentBrief(rawBrief);
}

function buildOutlineFromNormalizedBrief(rootDir: string, category: MediaBriefCategory, brief: any): any {
  const outlineBuilders: Record<MediaBriefCategory, (rootDir: string, brief: any) => any> = {
    presentation: buildProposalNarrativeOutline,
    document: buildReportNarrativeOutline,
    spreadsheet: buildSpreadsheetNarrativeOutline,
    diagram: buildDiagramNarrativeOutline,
  };
  return outlineBuilders[category](rootDir, brief);
}

function resolveObjectInput(ctx: any, params: any, resolve: Function, defaults: {
  paramKey?: string;
  fromKey?: string;
  opName: string;
}): any {
  const fromKey = resolve(defaults.fromKey || 'last_json');
  const inline = defaults.paramKey ? params[defaults.paramKey] : undefined;
  const value = inline && typeof inline === 'object' ? inline : ctx[fromKey];
  if (!value || typeof value !== 'object') {
    throw new Error(`${defaults.opName} could not find context key: ${fromKey}`);
  }
  return value;
}

function buildCompiledBriefContext(input: {
  rootDir: string;
  ctx: any;
  rawBrief: any;
  exportAs?: string;
  briefContextKey?: string;
}): any {
  const normalizedBrief = normalizeBriefForCategory(input.rootDir, input.rawBrief);
  const compiled = compileBriefToDesignProtocol(input.rootDir, normalizedBrief);
  return {
    ...input.ctx,
    active_theme: input.ctx.active_theme || resolveNamedTheme(input.rootDir, compiled.themeName) || input.ctx.active_theme,
    active_theme_name: input.ctx.active_theme_name || compiled.themeName,
    [input.exportAs || compiled.exportKey]: compiled.protocol,
    ...(input.briefContextKey ? { [input.briefContextKey]: normalizedBrief } : {}),
    document_outline: compiled.outline,
  };
}

async function renderCompiledProtocol(compiled: {
  protocol: any;
  protocolKind: ProtocolKind;
}, outPath: string, options?: any): Promise<void> {
  ensureParentDir(outPath);
  const renderers: Record<ProtocolKind, () => Promise<void>> = {
    pptx: async () => generateNativePptx(compiled.protocol, outPath),
    xlsx: async () => generateNativeXlsx(normalizeXlsxDesignProtocol(compiled.protocol), outPath),
    docx: async () => generateNativeDocx(compiled.protocol, outPath),
    pdf: async () => generateNativePdf(compiled.protocol, outPath, options),
  };
  const renderer = renderers[compiled.protocolKind];
  if (!renderer) {
    throw new Error(`Unsupported generated protocol kind: ${compiled.protocolKind}`);
  }
  await renderer();
}

async function renderDiagramDocumentBrief(rootDir: string, brief: any, outPath: string, params: any, ctx: any, resolve: Function): Promise<void> {
  ensureParentDir(outPath);
  const renderers: Record<string, () => Promise<void>> = {
    drawio: async () => {
      const iconMap = resolveDrawioIconMap(rootDir, params, resolve);
      const activeTheme = ctx.active_theme || loadFallbackDrawioTheme(rootDir, brief.layout_template_id);
      const document = generateDrawioDocument(brief.payload.graph, {
        title: brief.payload.title || brief.title || 'Diagram',
        theme: activeTheme,
        iconMap,
        iconRoot: params.icon_root ? path.resolve(rootDir, resolve(params.icon_root)) : undefined,
      });
      safeWriteFile(outPath, document);
    },
    mmd: async () => {
      const tempDir = pathResolver.sharedTmp(`actuators/media-actuator/diagram_${Date.now()}`);
      safeMkdir(tempDir, { recursive: true });
      const inputPath = path.join(tempDir, 'diagram.mmd');
      safeWriteFile(inputPath, brief.payload.source);
      const args = ['-i', inputPath, '-o', outPath];
      const activeTheme = ctx.active_theme || loadFallbackDrawioTheme(rootDir, brief.layout_template_id);
      const mermaidConfig = buildMermaidConfig(activeTheme, params.background_color ? resolve(params.background_color) : undefined);
      const configPath = path.join(tempDir, 'mermaid.config.json');
      safeWriteFile(configPath, JSON.stringify(mermaidConfig, null, 2));
      args.push('-c', configPath);
      if (params.width) args.push('-w', String(resolve(params.width)));
      if (params.height) args.push('-H', String(resolve(params.height)));
      if (params.background_color) args.push('-b', String(resolve(params.background_color)));
      safeExec('mmdc', args, { cwd: rootDir, timeoutMs: params.timeout_ms || 30000 });
    },
    d2: async () => {
      const tempDir = pathResolver.sharedTmp(`actuators/media-actuator/diagram_${Date.now()}`);
      safeMkdir(tempDir, { recursive: true });
      const inputPath = path.join(tempDir, 'diagram.d2');
      safeWriteFile(inputPath, brief.payload.source);
      const args = [inputPath, outPath];
      if (params.layout) args.push('--layout', String(resolve(params.layout)));
      if (params.theme_id) args.push('--theme', String(resolve(params.theme_id)));
      if (params.sketch) args.push('--sketch');
      if (params.pad) args.push('--pad', String(resolve(params.pad)));
      safeExec('d2', args, { cwd: rootDir, timeoutMs: params.timeout_ms || 30000 });
    },
  };
  const renderer = renderers[String(brief.render_target || '').trim()];
  if (!renderer) {
    throw new Error(`Unsupported diagram render_target: ${brief.render_target}`);
  }
  await renderer();
}

function compileBriefToDesignProtocol(rootDir: string, rawBrief: any): {
  protocol: any;
  outline: any;
  theme: any;
  themeName: string;
  protocolKind: ProtocolKind;
  exportKey: string;
} {
  const category = resolveMediaBriefCategory(rawBrief);
  const brief = normalizeBriefForCategory(rootDir, rawBrief);
  const outline = buildOutlineFromNormalizedBrief(rootDir, category, brief);
  const theme = resolveNamedTheme(rootDir, outline.recommended_theme);

  if (category === 'presentation') {
    const compiled = buildPresentationPptxProtocol(rootDir, brief);
    return {
      ...compiled,
      protocolKind: 'pptx',
      exportKey: 'last_pptx_design',
    };
  }

  if (category === 'document') {
    const compilers: Record<string, () => { protocol: any; protocolKind: ProtocolKind; exportKey: string }> = {
      pptx: () => ({
        protocol: buildOutlineDrivenPptxProtocol(rootDir, outline).protocol,
        protocolKind: 'pptx',
        exportKey: 'last_pptx_design',
      }),
      docx: () => ({
        protocol: buildReportDocxProtocol(rootDir, brief),
        protocolKind: 'docx',
        exportKey: 'last_docx_design',
      }),
      pdf: () => ({
        protocol: buildReportPdfProtocol(rootDir, brief),
        protocolKind: 'pdf',
        exportKey: 'last_pdf_design',
      }),
    };
    const compile = compilers[String(brief.render_target || '').trim()];
    if (!compile) {
      throw new Error(`Unsupported document render_target: ${String(brief.render_target || 'unknown')}`);
    }
    return {
      ...compile(),
      outline,
      theme,
      themeName: outline.recommended_theme,
    };
  }

  if (category === 'spreadsheet') {
    return {
      protocol: normalizeXlsxDesignProtocol(brief.payload.protocol || buildTrackerSpreadsheetProtocol(rootDir, brief)),
      outline,
      theme,
      themeName: outline.recommended_theme,
      protocolKind: 'xlsx',
      exportKey: 'last_xlsx_design',
    };
  }

  throw new Error(`Unsupported brief for compileBriefToDesignProtocol: ${String(rawBrief?.kind || 'unknown')}`);
}

function buildCompositionTokenMap(brief: any): Record<string, string> {
  return {
    title: String(brief.title || brief.payload?.title || 'Document'),
    client: String(brief.client || brief.payload?.client || ''),
    objective: String(brief.objective || brief.payload?.objective || ''),
    core_message: String(brief.story?.core_message || brief.payload?.story?.core_message || brief.objective || brief.payload?.objective || ''),
    closing_cta: String(brief.story?.closing_cta || brief.payload?.story?.closing_cta || ''),
    audience: Array.isArray(brief.audience || brief.payload?.audience)
      ? (brief.audience || brief.payload?.audience).join(', ')
      : '',
    tone: String(brief.story?.tone || brief.payload?.story?.tone || ''),
  };
}

function chooseDocumentSectionEvidence(index: number, brief: any): any {
  const evidence = Array.isArray(brief.evidence || brief.payload?.evidence) ? (brief.evidence || brief.payload?.evidence) : [];
  return evidence[index] || evidence[evidence.length - 1] || null;
}

function columnNumberToLetter(input: number): string {
  let n = Math.max(1, Math.floor(input));
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

function inferPrimitiveCellType(value: any): 'n' | 'b' | 'd' | 's' {
  if (typeof value === 'number') return 'n';
  if (typeof value === 'boolean') return 'b';
  if (value instanceof Date) return 'd';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) return 'd';
  return 's';
}

function buildSmartTableSheet(sheet: any, index: number): any {
  const smartTable = sheet?.smart_table;
  if (!smartTable || typeof smartTable !== 'object') return sheet;
  const headers = Array.isArray(smartTable.headers) ? smartTable.headers.map((value: any) => String(value)) : [];
  const rows = Array.isArray(smartTable.rows) ? smartTable.rows : [];
  if (headers.length === 0) return sheet;
  const dataRows = rows.map((row: any, rowIndex: number) => ({
    index: rowIndex + 2,
    cells: headers.map((header, columnIndex) => {
      const value = Array.isArray(row) ? row[columnIndex] : row?.[header];
      return {
        ref: `${columnNumberToLetter(columnIndex + 1)}${rowIndex + 2}`,
        type: inferPrimitiveCellType(value),
        value: value ?? '',
      };
    }),
  }));
  const normalizedRows = [
    {
      index: 1,
      cells: headers.map((header, columnIndex) => ({
        ref: `${columnNumberToLetter(columnIndex + 1)}1`,
        type: 's',
        value: header,
      })),
    },
    ...dataRows,
  ];
  const endCell = `${columnNumberToLetter(headers.length)}${Math.max(rows.length + 1, 1)}`;
  return {
    ...sheet,
    rows: normalizedRows,
    columns: Array.isArray(sheet?.columns) && sheet.columns.length > 0
      ? sheet.columns
      : headers.map((_: string, columnIndex: number) => ({ min: columnIndex + 1, max: columnIndex + 1, width: 18, customWidth: true })),
    tables: Array.isArray(sheet?.tables) && sheet.tables.length > 0
      ? sheet.tables
      : [{
          id: 1,
          name: `Table${index + 1}`,
          displayName: `Table${index + 1}`,
          ref: `A1:${endCell}`,
          headerRowCount: 1,
          totalsRowShown: false,
          columns: headers.map((header, columnIndex) => ({ id: columnIndex + 1, name: header })),
          styleInfo: {
            name: 'TableStyleMedium2',
            showRowStripes: true,
          },
        }],
    autoFilter: sheet?.autoFilter || { ref: `A1:${endCell}` },
    dimension: sheet?.dimension || `A1:${endCell}`,
  };
}

function normalizeXlsxDesignProtocol(protocol: any): any {
  if (!protocol || typeof protocol !== 'object') {
    throw new Error('normalizeXlsxDesignProtocol: protocol must be an object');
  }
  const sheets = Array.isArray(protocol.sheets) ? protocol.sheets : [];
  return {
    ...protocol,
    styles: {
      ...(protocol.styles || {}),
      fonts: Array.isArray(protocol.styles?.fonts) ? protocol.styles.fonts : [],
      fills: Array.isArray(protocol.styles?.fills) ? protocol.styles.fills : [],
      borders: Array.isArray(protocol.styles?.borders) ? protocol.styles.borders : [],
      numFmts: Array.isArray(protocol.styles?.numFmts) ? protocol.styles.numFmts : [],
      cellXfs: Array.isArray(protocol.styles?.cellXfs) ? protocol.styles.cellXfs : [],
      namedStyles: Array.isArray(protocol.styles?.namedStyles) ? protocol.styles.namedStyles : [],
      dxfs: Array.isArray(protocol.styles?.dxfs) ? protocol.styles.dxfs : [],
    },
    sharedStrings: Array.isArray(protocol.sharedStrings) ? protocol.sharedStrings : [],
    sharedStringsRich: Array.isArray(protocol.sharedStringsRich) ? protocol.sharedStringsRich : [],
    definedNames: Array.isArray(protocol.definedNames) ? protocol.definedNames : [],
    sheets: sheets.map((rawSheet: any, index: number) => {
      const sheet = buildSmartTableSheet(rawSheet, index);
      return {
        id: String(sheet?.id || `sheet${index + 1}`),
        name: String(sheet?.name || `Sheet ${index + 1}`),
        state: sheet?.state || 'visible',
        dimension: sheet?.dimension,
        sheetView: sheet?.sheetView || {},
        columns: Array.isArray(sheet?.columns) ? sheet.columns : [],
        rows: Array.isArray(sheet?.rows) ? sheet.rows : [],
        mergeCells: Array.isArray(sheet?.mergeCells) ? sheet.mergeCells : [],
        drawing: sheet?.drawing && typeof sheet.drawing === 'object'
          ? { ...sheet.drawing, elements: Array.isArray(sheet.drawing.elements) ? sheet.drawing.elements : [] }
          : undefined,
        tables: Array.isArray(sheet?.tables) ? sheet.tables : [],
        conditionalFormats: Array.isArray(sheet?.conditionalFormats) ? sheet.conditionalFormats : [],
        dataValidations: Array.isArray(sheet?.dataValidations) ? sheet.dataValidations : [],
        autoFilter: sheet?.autoFilter,
        pageSetup: sheet?.pageSetup,
        sheetPrXml: sheet?.sheetPrXml,
        extensions: sheet?.extensions,
      };
    }),
  };
}

function themeToPptxPalette(theme: any): any {
  const colors = theme?.colors || {};
  return {
    dk1: String(colors.primary || '#000000').replace('#', ''),
    dk2: String(colors.secondary || colors.text || '#44546A').replace('#', ''),
    lt1: String(colors.background || '#FFFFFF').replace('#', ''),
    lt2: String(colors.background || '#E7E6E6').replace('#', ''),
    accent1: String(colors.accent || '#38BDF8').replace('#', ''),
    accent2: String(colors.secondary || '#334155').replace('#', ''),
  };
}

function themeToDocxStyleHints(theme: any, locale?: string): { headingFont: string; bodyFont: string; accent: string } {
  const headingFont = normalizeFontFamily(
    locale?.startsWith('ja')
      ? theme?.fonts?.heading || 'Meiryo'
      : theme?.fonts?.heading || 'Aptos',
  );
  const bodyFont = normalizeFontFamily(
    locale?.startsWith('ja')
      ? theme?.fonts?.body || 'Meiryo'
      : theme?.fonts?.body || 'Aptos',
  );
  return {
    headingFont,
    bodyFont,
    accent: String(theme?.colors?.accent || '#2563eb').replace('#', ''),
  };
}

function resolveThemeColorRole(palette: any, accentHex: string, role?: string): string {
  switch (String(role || '').trim()) {
    case 'accent':
      return accentHex || palette.accent1 || '2563EB';
    case 'secondary':
      return palette.dk2 || palette.dk1 || '334155';
    case 'primary':
      return palette.dk1 || '111827';
    default:
      return palette.dk2 || palette.dk1 || accentHex || '334155';
  }
}

function resolveThemeHexColor(themeColors: any, role?: string, fallback = '#334155'): string {
  switch (String(role || '').trim()) {
    case 'accent':
      return String(themeColors.accent || fallback);
    case 'primary':
      return String(themeColors.primary || fallback);
    case 'secondary':
      return String(themeColors.secondary || themeColors.text || fallback);
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
    default:
      return String(themeColors.secondary || themeColors.text || fallback);
  }
}

function applyCompositionTemplate(template: any, tokens: Record<string, string>, fallback = ''): string {
  const source = typeof template === 'string' ? template : fallback;
  return source.replace(/{{\s*([\w-]+)\s*}}/g, (_, key) => tokens[key] || '');
}

function classifyRenderSemantic(layoutKey?: string, mediaKind?: string): string {
  const layout = String(layoutKey || '').trim();
  const media = String(mediaKind || '').trim();

  if (['cover-statement', 'doc-title'].includes(layout) || ['hero', 'title-page'].includes(media)) return 'hero';
  if (['title-body', 'doc-summary', 'sheet-overview'].includes(layout) || ['summary', 'dashboard'].includes(media)) return 'summary';
  if (['evidence-callout'].includes(layout) || ['evidence'].includes(media)) return 'evidence';
  if (['risk-controls'].includes(layout) || ['controls'].includes(media)) return 'control';
  if (['timeline-roadmap'].includes(layout) || ['timeline'].includes(media)) return 'roadmap';
  if (['decision-cta'].includes(layout) || ['cta'].includes(media)) return 'decision';
  if (['doc-appendix'].includes(layout) || ['appendix'].includes(media)) return 'appendix';
  if (['sheet-signals'].includes(layout) || ['signals'].includes(media)) return 'signals';
  if (['sheet-main-table'].includes(layout) || ['table'].includes(media)) return 'execution';
  if (['three-point-architecture', 'diagram-context', 'operating-model'].includes(layout) || ['architecture', 'diagram', 'model'].includes(media)) return 'architecture';
  return 'content';
}

function rankSignalTone(tone?: string): number {
  const key = String(tone || '').toLowerCase();
  const fallback: Record<string, number> = { danger: 0, critical: 0, high: 0, warning: 1, medium: 1, info: 2, success: 3, low: 3 };
  return fallback[key] ?? 2;
}

function chooseProposalSectionEvidence(sectionId: string, brief: any): any {
  const evidence = Array.isArray(brief.evidence) ? brief.evidence : [];
  const chapters = Array.isArray(brief.story?.chapters) ? brief.story.chapters : [];
  const lowerChapters = chapters.map((entry: string) => String(entry).toLowerCase());
  const keywordMap: Record<string, string[]> = {
    'why-change': ['why', 'change', 'pain', 'problem', 'now'],
    'target-outcome': ['target', 'journey', 'future', 'outcome', 'vision'],
    'solution-shape': ['solution', 'approach', 'shape', 'architecture'],
    'governance': ['governance', 'control', 'risk', 'operation'],
    'delivery-plan': ['delivery', 'plan', 'roadmap', 'phase'],
  };
  const keywords = keywordMap[sectionId] || [];
  const chapterIndex = lowerChapters.findIndex((chapter) => keywords.some((keyword) => chapter.includes(keyword)));
  if (chapterIndex >= 0 && evidence[chapterIndex]) return evidence[chapterIndex];
  if (sectionId === 'why-change') return evidence[0];
  if (sectionId === 'target-outcome') return evidence[1] || evidence[0];
  if (sectionId === 'solution-shape') return evidence[2] || evidence[1] || evidence[0];
  if (sectionId === 'governance') return evidence[2] || evidence[0];
  if (sectionId === 'delivery-plan') return evidence[3] || evidence[evidence.length - 1];
  return evidence[0];
}

function buildProposalNarrativeOutline(rootDir: string, brief: any): any {
  const { profileId, preset } = resolveDocumentCompositionPreset(rootDir, brief);
  const tokens = buildCompositionTokenMap(brief);
  const sections = Array.isArray(preset.sections) ? preset.sections : [];
  const requestedSections = Array.isArray(brief.required_sections) ? new Set(brief.required_sections.map((value: any) => String(value))) : null;
  const toc = sections
    .filter((section: any) => !requestedSections || requestedSections.size === 0 || requestedSections.has(section.section_id) || ['cover', 'decision'].includes(section.section_id))
    .map((section: any, index: number) => {
      const supporting = chooseProposalSectionEvidence(section.section_id, brief) || {};
      const chapter = Array.isArray(brief.story?.chapters) ? brief.story.chapters[index] : undefined;
      return {
        section_id: section.section_id,
        title: applyCompositionTemplate(section.title, tokens, chapter || section.section_id),
        objective: applyCompositionTemplate(section.objective, tokens, chapter || brief.objective || ''),
        body: [
          supporting.point || chapter || brief.story?.core_message || brief.objective,
          section.section_id === 'executive-summary' && tokens.audience ? `Audience: ${tokens.audience}` : undefined,
          section.section_id === 'decision' && tokens.tone ? `Tone: ${tokens.tone}` : undefined,
        ].filter(Boolean),
        visual: supporting.title || section.visual || 'supporting visual',
        media_kind: section.media_kind || 'content',
        layout_key: section.layout_key || 'title-body',
        semantic_type: classifyRenderSemantic(section.layout_key, section.media_kind),
      };
    });

  return {
    kind: 'document-outline-adf',
    artifact_family: brief.artifact_family,
    document_type: brief.document_type,
    document_profile: profileId,
    design_system_id: preset.design_system_id,
    branding: preset.branding || {},
    prompt_guide: Array.isArray(preset.prompt_guide) ? preset.prompt_guide : [],
    source_design: preset.source_design || null,
    design_recommendations: Array.isArray(preset.design_recommendations) ? preset.design_recommendations : [],
    narrative_pattern_id: preset.narrative_pattern_id || 'generic-structured',
    recommended_theme: preset.recommended_theme || 'kyberion-standard',
    recommended_layout_template_id: brief.layout_template_id || preset.recommended_layout_template_id,
    generation_boundary: buildMediaGenerationBoundary({
      document_profile: profileId,
      design_system_id: preset.design_system_id,
    }),
    toc,
  };
}

function buildReportNarrativeOutline(rootDir: string, brief: any): any {
  const { profileId, preset } = resolveDocumentCompositionPreset(rootDir, brief);
  const payloadSections = Array.isArray(brief.payload?.sections) ? brief.payload.sections : [];
  const presetSections = Array.isArray(preset.sections) ? preset.sections : [];
  const appendixPattern = /\b(appendix|appendices|annex|supplement|reference)\b/i;
  const tokens = buildCompositionTokenMap(brief);
  const chapters = Array.isArray(brief.story?.chapters || brief.payload?.story?.chapters)
    ? (brief.story?.chapters || brief.payload?.story?.chapters)
    : [];
  const sections = payloadSections.length > 0
    ? payloadSections.map((section: any) => ({
        section_id: String(section.heading || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        title: String(section.heading || 'Section'),
        objective: Array.isArray(section.body) ? String(section.body[0] || '') : '',
        body: [
          ...(Array.isArray(section.body) ? section.body.map((value: any) => String(value)) : []),
          ...(Array.isArray(section.bullets) ? section.bullets.map((value: any) => `- ${String(value)}`) : []),
        ].filter(Boolean),
        visual: Array.isArray(section.callouts) && section.callouts[0]?.title ? String(section.callouts[0].title) : undefined,
        media_kind: appendixPattern.test(String(section.heading || '')) ? 'appendix' : 'section-flow',
        layout_key: appendixPattern.test(String(section.heading || '')) ? 'doc-appendix' : 'doc-sections',
      }))
    : presetSections.map((section: any, index: number) => {
        const evidence = chooseDocumentSectionEvidence(index, brief);
        const chapter = String(chapters[index] || '').trim();
        const objective = applyCompositionTemplate(section.objective, tokens, chapter || brief.objective || section.title || '');
        const body = [
          chapter || objective || brief.objective || '',
          evidence?.point ? String(evidence.point) : '',
        ].filter(Boolean);
        return {
          section_id: String(section.section_id || 'section'),
          title: applyCompositionTemplate(section.title, tokens, section.title || 'Section'),
          objective: objective || chapter || brief.objective || '',
          body,
          visual: evidence?.title ? String(evidence.title) : undefined,
          media_kind: String(section.media_kind || 'section-flow'),
          layout_key: String(section.layout_key || 'doc-sections'),
        };
      });
  return {
    kind: 'document-outline-adf',
    artifact_family: brief.artifact_family,
    document_type: brief.document_type,
    document_profile: profileId,
    design_system_id: preset.design_system_id,
    branding: preset.branding || {},
    prompt_guide: Array.isArray(preset.prompt_guide) ? preset.prompt_guide : [],
    source_design: preset.source_design || null,
    design_recommendations: Array.isArray(preset.design_recommendations) ? preset.design_recommendations : [],
    narrative_pattern_id: preset.narrative_pattern_id || 'report-standard',
    recommended_theme: preset.recommended_theme || 'kyberion-standard',
    recommended_layout_template_id: brief.layout_template_id || preset.recommended_layout_template_id,
    generation_boundary: buildMediaGenerationBoundary({
      document_profile: profileId,
      design_system_id: preset.design_system_id,
    }),
    toc: [
      {
        section_id: 'title',
        title: brief.payload?.title || brief.title || 'Report',
        objective: brief.objective || brief.summary || '',
        body: [brief.objective || brief.summary || ''].filter(Boolean),
        visual: brief.title || 'overview',
        media_kind: 'title-page',
        layout_key: 'doc-title',
        semantic_type: classifyRenderSemantic('doc-title', 'title-page'),
      },
      ...((brief.payload?.summary || brief.summary) ? [{
        section_id: 'summary',
        title: 'Summary',
        objective: brief.payload?.summary || brief.summary || brief.objective || '',
        body: [brief.payload?.summary || brief.summary || brief.objective || ''].filter(Boolean),
        visual: chooseDocumentSectionEvidence(0, brief)?.title || 'summary',
        media_kind: 'summary',
        layout_key: 'doc-summary',
        semantic_type: classifyRenderSemantic('doc-summary', 'summary'),
      }] : []),
      ...sections.map((section: any) => ({
        section_id: String(section.section_id || 'section'),
        title: String(section.title || 'Section'),
        objective: String(section.objective || ''),
        body: Array.isArray(section.body) ? section.body : [section.objective].filter(Boolean),
        visual: section.visual,
        media_kind: String(section.media_kind || 'section-flow'),
        layout_key: String(section.layout_key || 'doc-sections'),
        semantic_type: classifyRenderSemantic(
          String(section.layout_key || 'doc-sections'),
          String(section.media_kind || 'section-flow'),
        ),
      })),
    ],
  };
}

function buildSpreadsheetNarrativeOutline(rootDir: string, brief: any): any {
  const { profileId, preset } = resolveDocumentCompositionPreset(rootDir, brief);
  const protocol = brief.payload?.protocol;
  const sheetNames = Array.isArray(protocol?.worksheets)
    ? protocol.worksheets.map((sheet: any) => String(sheet?.name || 'Sheet'))
    : [];
  const presetSections = Array.isArray(preset.sections) ? preset.sections : [];
  const sectionIndex = new Map<string, any>(
    presetSections.map((section: any) => [String(section.section_id || ''), section]),
  );
  return {
    kind: 'document-outline-adf',
    artifact_family: brief.artifact_family,
    document_type: brief.document_type,
    document_profile: profileId,
    design_system_id: preset.design_system_id,
    branding: preset.branding || {},
    prompt_guide: Array.isArray(preset.prompt_guide) ? preset.prompt_guide : [],
    source_design: preset.source_design || null,
    design_recommendations: Array.isArray(preset.design_recommendations) ? preset.design_recommendations : [],
    narrative_pattern_id: preset.narrative_pattern_id || 'operator-dashboard',
    recommended_theme: preset.recommended_theme || 'kyberion-standard',
    recommended_layout_template_id: brief.layout_template_id || preset.recommended_layout_template_id,
    generation_boundary: buildMediaGenerationBoundary({
      document_profile: profileId,
      design_system_id: preset.design_system_id,
    }),
    toc: [
      {
        section_id: 'overview',
        title: sectionIndex.get('overview')?.title || 'Overview',
        media_kind: sectionIndex.get('overview')?.media_kind || 'dashboard',
        layout_key: sectionIndex.get('overview')?.layout_key || 'sheet-overview',
        semantic_type: classifyRenderSemantic(sectionIndex.get('overview')?.layout_key || 'sheet-overview', sectionIndex.get('overview')?.media_kind || 'dashboard'),
      },
      {
        section_id: 'execution-board',
        title: sectionIndex.get('execution-board')?.title || 'Execution Board',
        media_kind: sectionIndex.get('execution-board')?.media_kind || 'table',
        layout_key: sectionIndex.get('execution-board')?.layout_key || 'sheet-main-table',
        semantic_type: classifyRenderSemantic(sectionIndex.get('execution-board')?.layout_key || 'sheet-main-table', sectionIndex.get('execution-board')?.media_kind || 'table'),
      },
      {
        section_id: 'signals',
        title: sectionIndex.get('signals')?.title || 'Signals and Risks',
        media_kind: sectionIndex.get('signals')?.media_kind || 'signals',
        layout_key: sectionIndex.get('signals')?.layout_key || 'sheet-signals',
        semantic_type: classifyRenderSemantic(sectionIndex.get('signals')?.layout_key || 'sheet-signals', sectionIndex.get('signals')?.media_kind || 'signals'),
      },
      ...sheetNames.map((name: string) => ({
        section_id: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
        title: name,
        media_kind: 'table',
        layout_key: 'sheet-main-table',
        semantic_type: classifyRenderSemantic('sheet-main-table', 'table'),
      })),
    ],
  };
}

function buildDiagramNarrativeOutline(rootDir: string, brief: any): any {
  const { profileId, preset } = resolveDocumentCompositionPreset(rootDir, brief);
  return {
    kind: 'document-outline-adf',
    artifact_family: brief.artifact_family,
    document_type: brief.document_type,
    document_profile: profileId,
    design_system_id: preset.design_system_id,
    branding: preset.branding || {},
    prompt_guide: Array.isArray(preset.prompt_guide) ? preset.prompt_guide : [],
    source_design: preset.source_design || null,
    design_recommendations: Array.isArray(preset.design_recommendations) ? preset.design_recommendations : [],
    narrative_pattern_id: preset.narrative_pattern_id || 'solution-overview',
    recommended_theme: preset.recommended_theme || brief.layout_template_id || 'aws-architecture',
    recommended_layout_template_id: brief.layout_template_id || preset.recommended_layout_template_id,
    generation_boundary: buildMediaGenerationBoundary({
      document_profile: profileId,
      design_system_id: preset.design_system_id,
    }),
    toc: [
      {
        section_id: 'system-context',
        title: brief.title || brief.payload?.title || 'Diagram',
        media_kind: 'diagram',
        layout_key: 'diagram-context',
        semantic_type: classifyRenderSemantic('diagram-context', 'diagram'),
      },
    ],
  };
}

function normalizeInvoiceDocumentBrief(input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Invoice document brief must be an object.');
  }

  if (input.kind !== 'document-brief') {
    throw new Error(`Unsupported document brief kind: ${String(input.kind || 'unknown')}`);
  }
  if (input.artifact_family !== 'document') {
    throw new Error(`Unsupported artifact_family in document-brief: ${String(input.artifact_family)}`);
  }
  if (input.document_type !== 'invoice') {
    throw new Error(`Unsupported document_type in document-brief: ${String(input.document_type)}`);
  }
  if (input.render_target !== 'pdf') {
    throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
  }
  if (!input.payload || typeof input.payload !== 'object') {
    throw new Error('document-brief for invoice requires an object payload.');
  }

  return {
    ...input.payload,
    artifact_family: input.artifact_family,
    document_type: input.document_type,
    document_profile: input.document_profile || 'qualified-invoice',
    render_target: input.render_target,
    locale: input.locale || 'ja-JP',
    layout_template_id: input.layout_template_id || input.payload.layout_template_id,
  };
}

function normalizeProposalBrief(input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Proposal brief must be an object.');
  }

  if (input.kind === 'document-brief') {
    if (input.artifact_family !== 'presentation') {
      throw new Error(`Unsupported artifact_family in document-brief: ${String(input.artifact_family)}`);
    }
    if (input.document_type !== 'proposal') {
      throw new Error(`Unsupported document_type in document-brief: ${String(input.document_type)}`);
    }
    if (input.render_target !== 'pptx') {
      throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
    }
    if (!input.payload || typeof input.payload !== 'object') {
      throw new Error('document-brief for proposal requires an object payload.');
    }

    return {
      ...input.payload,
      artifact_family: input.artifact_family,
      document_type: input.document_type,
      document_profile: input.document_profile || 'executive-proposal',
      render_target: input.render_target,
      locale: input.locale || 'en-US',
      layout_template_id: input.layout_template_id || input.payload.layout_template_id,
    };
  }

  if (input.kind === 'proposal-brief') {
    return {
      artifact_family: 'presentation',
      document_type: 'proposal',
      document_profile: input.document_profile || 'executive-proposal',
      render_target: input.render_target || 'pptx',
      locale: input.locale || 'en-US',
      layout_template_id: input.layout_template_id,
      ...input,
    };
  }

  throw new Error(`Unsupported proposal brief kind: ${String(input.kind || 'unknown')}`);
}

function buildUnifiedDocumentBrief(rootDir: string, input: {
  profileId?: string;
  renderTarget?: string;
  source?: any;
  data?: any;
}): any {
  const source = (input.source && typeof input.source === 'object') ? input.source : {};
  const data = (input.data && typeof input.data === 'object') ? input.data : {};
  const renderTarget = String(input.renderTarget || source.render_target || data.render_target || '').trim();
  const profileId = String(input.profileId || source.document_profile || data.document_profile || '').trim();
  const catalog = loadDocumentCompositionCatalog(rootDir);
  const profilePreset = profileId ? catalog.profiles?.[profileId] || null : null;
  const artifactFamily = String(
    source.artifact_family ||
    data.artifact_family ||
    profilePreset?.artifact_family ||
    (renderTarget === 'pptx' ? 'presentation' : renderTarget === 'xlsx' ? 'spreadsheet' : 'document'),
  ).trim();
  const documentType = String(
    source.document_type ||
    data.document_type ||
    profilePreset?.document_type ||
    (artifactFamily === 'presentation' ? 'proposal' : artifactFamily === 'spreadsheet' ? 'tracker' : 'report'),
  ).trim();

  if (!renderTarget) {
    throw new Error('generate_document requires render_target');
  }
  if (!profileId) {
    throw new Error('generate_document requires profile_id or document_profile');
  }

  if (artifactFamily === 'presentation') {
    return {
      kind: 'proposal-brief',
      artifact_family: 'presentation',
      document_type: documentType,
      document_profile: profileId,
      render_target: 'pptx',
      locale: source.locale || data.locale || 'en-US',
      layout_template_id: source.layout_template_id || data.layout_template_id,
      project_id: source.project_id || data.project_id,
      title: source.title || data.title || profileId,
      objective: source.objective || data.objective || '',
      client: source.client || data.client,
      story: source.story || data.story || {},
      evidence: source.evidence || data.evidence || [],
      payload: source.payload || data.payload,
    };
  }

  if (artifactFamily === 'spreadsheet') {
    return {
      kind: 'document-brief',
      artifact_family: 'spreadsheet',
      document_type: documentType,
      document_profile: profileId,
      render_target: 'xlsx',
      locale: source.locale || data.locale || 'en-US',
      layout_template_id: source.layout_template_id || data.layout_template_id,
      payload: source.payload || data.payload || data,
    };
  }

  return {
    kind: 'document-brief',
    artifact_family: 'document',
    document_type: documentType,
    document_profile: profileId,
    render_target: renderTarget,
    locale: source.locale || data.locale || 'en-US',
    layout_template_id: source.layout_template_id || data.layout_template_id,
    project_id: source.project_id || data.project_id,
    title: source.title || data.title,
    summary: source.summary || data.summary,
    payload: source.payload || data.payload || data,
  };
}

function normalizeDiagramDocumentBrief(input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Diagram document brief must be an object.');
  }

  if (input.kind !== 'document-brief') {
    throw new Error(`Unsupported diagram brief kind: ${String(input.kind || 'unknown')}`);
  }
  if (input.artifact_family !== 'diagram') {
    throw new Error(`Unsupported artifact_family in document-brief: ${String(input.artifact_family)}`);
  }
  if (!['mmd', 'd2', 'drawio'].includes(String(input.render_target))) {
    throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
  }
  if (!input.payload || typeof input.payload !== 'object') {
    throw new Error('document-brief for diagram requires an object payload.');
  }

  if (input.render_target === 'drawio') {
    if (!input.payload.graph || typeof input.payload.graph !== 'object') {
      throw new Error('document-brief for drawio requires payload.graph.');
    }
  } else if (typeof input.payload.source !== 'string' || !input.payload.source.trim()) {
    throw new Error(`document-brief for ${input.render_target} requires payload.source.`);
  }

  return {
    artifact_family: input.artifact_family,
    document_type: input.document_type,
    document_profile: input.document_profile || 'solution-overview',
    render_target: input.render_target,
    locale: input.locale || 'en-US',
    layout_template_id: input.layout_template_id,
    title: input.payload.title || input.title,
    payload: input.payload,
  };
}

function normalizeSpreadsheetDocumentBrief(rootDir: string, input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Spreadsheet document brief must be an object.');
  }
  if (input.kind !== 'document-brief') {
    throw new Error(`Unsupported spreadsheet brief kind: ${String(input.kind || 'unknown')}`);
  }
  if (input.artifact_family !== 'spreadsheet') {
    throw new Error(`Unsupported artifact_family in document-brief: ${String(input.artifact_family)}`);
  }
  if (input.render_target !== 'xlsx') {
    throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
  }
  if (!input.payload || typeof input.payload !== 'object') {
    throw new Error('document-brief for spreadsheet requires an object payload.');
  }

  let protocol = input.payload.protocol;
  if (!protocol && input.payload.protocol_path) {
    const protocolPath = path.resolve(rootDir, input.payload.protocol_path);
    protocol = JSON.parse(safeReadFile(protocolPath, { encoding: 'utf8' }) as string);
  }
  if (!protocol && (!Array.isArray(input.payload.columns) || !Array.isArray(input.payload.rows))) {
    throw new Error('document-brief for spreadsheet requires payload.protocol, payload.protocol_path, or semantic payload.columns + payload.rows.');
  }

  return {
    artifact_family: input.artifact_family,
    document_type: input.document_type,
    document_profile: input.document_profile || 'operator-tracker',
    render_target: input.render_target,
    locale: input.locale || 'en-US',
    layout_template_id: input.layout_template_id,
    payload: {
      ...input.payload,
      protocol,
    },
  };
}

function normalizeReportDocumentBrief(input: any): any {
  if (!input || typeof input !== 'object') {
    throw new Error('Report document brief must be an object.');
  }
  if (input.kind !== 'document-brief') {
    throw new Error(`Unsupported report brief kind: ${String(input.kind || 'unknown')}`);
  }
  if (input.artifact_family !== 'document') {
    throw new Error(`Unsupported artifact_family in document-brief: ${String(input.artifact_family)}`);
  }
  if (!['docx', 'pdf', 'pptx'].includes(String(input.render_target))) {
    throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
  }
  const payload = (input.payload && typeof input.payload === 'object') ? input.payload : {};

  return {
    artifact_family: input.artifact_family,
    document_type: input.document_type,
    document_profile: input.document_profile || 'summary-report',
    render_target: input.render_target,
    locale: input.locale || 'en-US',
    layout_template_id: input.layout_template_id,
    title: input.title,
    summary: input.summary,
    payload,
  };
}

function buildReportDocxProtocol(rootDir: string, brief: any): any {
  const outline = buildReportNarrativeOutline(rootDir, brief);
  const { preset } = resolveDocumentCompositionPreset(rootDir, brief);
  const { template } = resolveDocumentLayoutTemplate(rootDir, {
    document_type: 'report',
    layout_template_id: brief.layout_template_id,
  });
  const activeTheme = resolveNamedTheme(rootDir, preset?.recommended_theme);
  const themeHints = themeToDocxStyleHints(activeTheme, brief.locale);
  const palette = themeToPptxPalette(activeTheme);
  const docxLayout = template?.docx || {};
  const layoutProfileTemplate = docxLayout.layout_profile || {};
  const numberingPolicyTemplate = docxLayout.numbering_policy || {};
  const headingFont = normalizeFontFamily(
    brief.locale?.startsWith('ja')
      ? themeHints.headingFont || template?.fonts?.heading || 'Meiryo'
      : themeHints.headingFont || template?.fonts?.heading || 'Aptos',
  );
  const bodyFont = normalizeFontFamily(
    brief.locale?.startsWith('ja')
      ? themeHints.bodyFont || template?.fonts?.body || 'Meiryo'
      : themeHints.bodyFont || template?.fonts?.body || 'Aptos',
  );
  const appendixHeadingRule = resolveSemanticComponentRule(rootDir, 'appendix', 'docx', 'heading');
  const appendixBodyRule = resolveSemanticComponentRule(rootDir, 'appendix', 'docx', 'body');
  const evidenceCalloutTitleRule = resolveSemanticComponentRule(rootDir, 'evidence', 'docx', 'callout_title');
  const evidenceCalloutBodyRule = resolveSemanticComponentRule(rootDir, 'evidence', 'docx', 'callout_body');
  const tableCaptionRule = resolveSemanticComponentRule(rootDir, 'content', 'docx', 'table_caption');
  const bodyBlocks: any[] = [
    {
      type: 'paragraph',
      paragraph: {
        pPr: { pStyle: 'Heading1' },
        content: [{ type: 'run', run: { content: [{ type: 'text', text: brief.payload.title || 'Report' }] } }],
      },
    },
  ];

  if (brief.payload.summary) {
    bodyBlocks.push({
      type: 'paragraph',
      paragraph: {
        content: [{ type: 'run', run: { content: [{ type: 'text', text: brief.payload.summary }] } }],
      },
    });
  }

  for (const section of brief.payload.sections) {
    const sectionId = String(section.heading || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const sectionPlan = Array.isArray(outline.toc)
      ? outline.toc.find((entry: any) => entry.section_id === sectionId)
      : null;
    const headingStyle = sectionPlan?.layout_key === 'doc-appendix' ? 'Heading3' : 'Heading2';
    bodyBlocks.push({
      type: 'paragraph',
      paragraph: {
        pPr: { pStyle: headingStyle },
        content: [{ type: 'run', run: { content: [{ type: 'text', text: section.heading || 'Section' }] } }],
      },
    });

    if (Array.isArray(section.body)) {
      for (const paragraph of section.body) {
        bodyBlocks.push({
          type: 'paragraph',
          paragraph: {
            pPr: { pStyle: headingStyle === 'Heading3' ? 'AppendixBody' : 'Normal' },
            content: [{ type: 'run', run: { content: [{ type: 'text', text: String(paragraph) }] } }],
          },
        });
      }
    }

    if (Array.isArray(section.bullets)) {
      section.bullets.forEach((bullet: string) => {
        bodyBlocks.push({
          type: 'paragraph',
          paragraph: {
            pPr: { numPr: { ilvl: 0, numId: 1 } },
            content: [{ type: 'run', run: { content: [{ type: 'text', text: String(bullet) }] } }],
          },
        });
      });
    }

    if (Array.isArray(section.callouts)) {
      section.callouts.forEach((callout: any) => {
        const title = [callout.title, callout.tone ? `(${callout.tone})` : ''].filter(Boolean).join(' ');
        if (title) {
          bodyBlocks.push({
            type: 'paragraph',
            paragraph: {
              pPr: { pStyle: 'CalloutTitle' },
              content: [{
                type: 'run',
                run: {
                  rPr: { bold: true, color: { val: themeHints.accent || String(template?.colors?.accent || '#2563eb').replace('#', '') } },
                  content: [{ type: 'text', text: title }],
                },
              }],
            },
          });
        }
        if (callout.body) {
          bodyBlocks.push({
            type: 'paragraph',
            paragraph: {
              pPr: { pStyle: 'CalloutBody' },
              content: [{ type: 'run', run: { content: [{ type: 'text', text: String(callout.body) }] } }],
            },
          });
        }
      });
    }

    if (Array.isArray(section.tables)) {
      section.tables.forEach((table: any) => {
        if (table.title) {
          bodyBlocks.push({
            type: 'paragraph',
            paragraph: {
              pPr: { pStyle: 'TableCaption' },
              content: [{
                type: 'run',
                run: {
                  rPr: { bold: true },
                  content: [{ type: 'text', text: String(table.title) }],
                },
              }],
            },
          });
        }
        const columns = Array.isArray(table.columns) ? table.columns.map((value: any) => String(value)) : [];
        const rows = Array.isArray(table.rows) ? table.rows : [];
        if (columns.length === 0) {
          return;
        }
        const cellWidth = Math.floor(7500 / columns.length);
        bodyBlocks.push({
          type: 'table',
          table: {
            tblPr: {
              tblStyle: 'TableGrid',
              tblW: { w: 5000, type: 'pct' },
              tblBorders: {
                top: { val: 'single', sz: 4, color: 'CBD5E1' },
                left: { val: 'single', sz: 4, color: 'CBD5E1' },
                bottom: { val: 'single', sz: 4, color: 'CBD5E1' },
                right: { val: 'single', sz: 4, color: 'CBD5E1' },
                insideH: { val: 'single', sz: 4, color: 'CBD5E1' },
                insideV: { val: 'single', sz: 4, color: 'CBD5E1' },
              },
            },
            tblGrid: columns.map(() => cellWidth),
            rows: [
              {
                trPr: { tblHeader: true },
                cells: columns.map((column: string) => ({
                    tcPr: {
                      tcW: { w: cellWidth, type: 'dxa' },
                      shd: { val: 'clear', fill: palette.dk1 || String(template?.colors?.primary || '#1f2937').replace('#', '') },
                    },
                  content: [{
                    type: 'paragraph',
                    paragraph: {
                      content: [{
                        type: 'run',
                        run: {
                          rPr: { bold: true, color: { val: 'FFFFFF' } },
                          content: [{ type: 'text', text: column }],
                        },
                      }],
                    },
                  }],
                })),
              },
              ...rows.map((row: any) => {
                const values = Array.isArray(row)
                  ? row
                  : columns.map((column: string) => row?.[column] ?? '');
                return {
                  cells: values.map((value: any) => ({
                    tcPr: { tcW: { w: cellWidth, type: 'dxa' } },
                    content: [{
                      type: 'paragraph',
                      paragraph: {
                        content: [{
                          type: 'run',
                          run: { content: [{ type: 'text', text: String(value ?? '') }] },
                        }],
                      },
                    }],
                  })),
                };
              }),
            ],
          },
        });
      });
    }
  }

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    source: {
      format: 'markdown',
      title: brief.payload.title || 'Report',
      body: [
        brief.payload.summary || '',
        '',
        ...(Array.isArray(brief.payload.sections)
          ? brief.payload.sections.flatMap((section: any) => [
              section.heading || 'Section',
              ...(Array.isArray(section.body) ? section.body.map((paragraph: any) => String(paragraph)) : []),
              ...(Array.isArray(section.bullets) ? section.bullets.map((bullet: string) => `- ${bullet}`) : []),
              '',
            ])
          : []),
      ].join('\n').trim(),
    },
    theme: {
      colors: {
        dk1: palette.dk1 || '111827',
        dk2: palette.dk2 || palette.dk1 || '44546A',
        lt1: palette.lt1 || 'FFFFFF',
        lt2: palette.lt2 || palette.lt1 || 'E7E6E6',
        accent1: palette.accent1 || '2563EB',
        accent2: palette.accent2 || palette.dk2 || '334155',
      },
      majorFont: headingFont,
      minorFont: bodyFont,
    },
    layoutProfile: {
      fonts: {
        bodyJa: normalizeFontFamily(layoutProfileTemplate.fonts?.bodyJa || bodyFont),
        bodyEn: normalizeFontFamily(layoutProfileTemplate.fonts?.bodyEn || bodyFont),
        headingJa: normalizeFontFamily(layoutProfileTemplate.fonts?.headingJa || headingFont),
        headingEn: normalizeFontFamily(layoutProfileTemplate.fonts?.headingEn || headingFont),
      },
      sizes: {
        body: layoutProfileTemplate.sizes?.body || 11,
        heading1: layoutProfileTemplate.sizes?.heading1 || (docxLayout.title_font_size || 32) / 2,
        heading2: layoutProfileTemplate.sizes?.heading2 || (docxLayout.section_font_size || 26) / 2,
        heading3: layoutProfileTemplate.sizes?.heading3,
        heading4: layoutProfileTemplate.sizes?.heading4,
        heading5: layoutProfileTemplate.sizes?.heading5,
        code: layoutProfileTemplate.sizes?.code,
      },
      page: {
        width: layoutProfileTemplate.page?.width || docxLayout.page?.width || 11906,
        height: layoutProfileTemplate.page?.height || docxLayout.page?.height || 16838,
        marginTop: layoutProfileTemplate.page?.marginTop || docxLayout.page?.margin_top || 1440,
        marginRight: layoutProfileTemplate.page?.marginRight || docxLayout.page?.margin_right || 1440,
        marginBottom: layoutProfileTemplate.page?.marginBottom || docxLayout.page?.margin_bottom || 1440,
        marginLeft: layoutProfileTemplate.page?.marginLeft || docxLayout.page?.margin_left || 1440,
        marginHeader: layoutProfileTemplate.page?.marginHeader || docxLayout.page?.header || 720,
        marginFooter: layoutProfileTemplate.page?.marginFooter || docxLayout.page?.footer || 720,
        marginGutter: layoutProfileTemplate.page?.marginGutter,
      },
      indent: layoutProfileTemplate.indent,
      bullet: {
        level0: layoutProfileTemplate.bullet?.level0 || '•',
        level1: layoutProfileTemplate.bullet?.level1,
        level2: layoutProfileTemplate.bullet?.level2,
      },
    },
    numberingPolicy: {
      headings: {
        enabled: numberingPolicyTemplate.headings?.enabled ?? false,
        preserveExisting: numberingPolicyTemplate.headings?.preserveExisting ?? true,
        levelFormats: numberingPolicyTemplate.headings?.levelFormats,
      },
      figures: {
        enabled: numberingPolicyTemplate.figures?.enabled ?? true,
        format: numberingPolicyTemplate.figures?.format || 'chapter',
        prefix: numberingPolicyTemplate.figures?.prefix || 'Figure',
        chapterLevel: numberingPolicyTemplate.figures?.chapterLevel || 1,
        resetOnHeadingLevel: numberingPolicyTemplate.figures?.resetOnHeadingLevel || 1,
      },
      tables: {
        enabled: numberingPolicyTemplate.tables?.enabled ?? true,
        format: numberingPolicyTemplate.tables?.format || 'chapter',
        prefix: numberingPolicyTemplate.tables?.prefix || 'Table',
        chapterLevel: numberingPolicyTemplate.tables?.chapterLevel || 1,
        resetOnHeadingLevel: numberingPolicyTemplate.tables?.resetOnHeadingLevel || 1,
      },
    },
    styles: {
      docDefaults: {
        rPrDefault: { rFonts: { ascii: bodyFont, hAnsi: bodyFont, eastAsia: bodyFont }, sz: 22 },
      },
      definitions: [
        { styleId: 'Normal', type: 'paragraph', name: 'Normal', isDefault: true },
        {
          styleId: 'Heading1',
          type: 'paragraph',
          name: 'Heading 1',
          pPr: { spacing: { after: docxLayout.title_spacing_after || 160 } },
          rPr: { bold: true, sz: docxLayout.title_font_size || 32 },
        },
        {
          styleId: 'Heading2',
          type: 'paragraph',
          name: 'Heading 2',
          pPr: {
            spacing: {
              before: docxLayout.section_spacing_before || 120,
              after: docxLayout.section_spacing_after || 80,
            },
          },
          rPr: { bold: true, sz: docxLayout.section_font_size || 26 },
        },
        {
          styleId: 'Heading3',
          type: 'paragraph',
          name: 'Heading 3',
          pPr: {
            spacing: {
              before: appendixHeadingRule.spacing_before || ((docxLayout.section_spacing_before || 120) - 20),
              after: appendixHeadingRule.spacing_after || docxLayout.section_spacing_after || 80,
            },
          },
          rPr: {
            bold: appendixHeadingRule.bold ?? true,
            color: { val: resolveThemeColorRole(palette, themeHints.accent, appendixHeadingRule.color_role) },
            sz: appendixHeadingRule.font_size || Math.max((docxLayout.section_font_size || 26) - 2, 20),
          },
        },
        {
          styleId: 'CalloutTitle',
          type: 'paragraph',
          name: 'Callout Title',
          pPr: {
            spacing: {
              before: evidenceCalloutTitleRule.spacing_before || 80,
              after: evidenceCalloutTitleRule.spacing_after || 40,
            },
          },
          rPr: {
            bold: evidenceCalloutTitleRule.bold ?? true,
            color: { val: resolveThemeColorRole(palette, themeHints.accent, evidenceCalloutTitleRule.color_role) },
            sz: evidenceCalloutTitleRule.font_size || Math.max((docxLayout.section_font_size || 26) - 4, 18),
          },
        },
        {
          styleId: 'CalloutBody',
          type: 'paragraph',
          name: 'Callout Body',
          pPr: {
            spacing: {
              after: evidenceCalloutBodyRule.spacing_after || 80,
            },
          },
          rPr: {
            italics: evidenceCalloutBodyRule.italics ?? true,
            color: { val: resolveThemeColorRole(palette, themeHints.accent, evidenceCalloutBodyRule.color_role) },
            sz: evidenceCalloutBodyRule.font_size || 21,
          },
        },
        {
          styleId: 'TableCaption',
          type: 'paragraph',
          name: 'Table Caption',
          pPr: {
            spacing: {
              before: tableCaptionRule.spacing_before || 60,
              after: tableCaptionRule.spacing_after || 40,
            },
          },
          rPr: {
            bold: tableCaptionRule.bold ?? true,
            color: { val: resolveThemeColorRole(palette, themeHints.accent, tableCaptionRule.color_role) },
            sz: tableCaptionRule.font_size || 20,
          },
        },
        {
          styleId: 'AppendixBody',
          type: 'paragraph',
          name: 'Appendix Body',
          pPr: {
            spacing: {
              after: appendixBodyRule.spacing_after || 60,
            },
          },
          rPr: {
            color: { val: resolveThemeColorRole(palette, themeHints.accent, appendixBodyRule.color_role) },
            sz: appendixBodyRule.font_size || 20,
          },
        },
      ],
    },
    numbering: {
      abstractNums: [{ abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'bullet', lvlText: '•', jc: 'left' }] }],
      nums: [{ numId: 1, abstractNumId: 0 }],
    },
    metadata: {
      composition: outline,
      generationBoundary: outline.generation_boundary || buildMediaGenerationBoundary(outline),
      recommendedTheme: preset?.recommended_theme || 'kyberion-standard',
      branding: preset?.branding || {},
      sectionSemantics: Array.isArray(outline.toc)
        ? outline.toc.map((entry: any) => ({
            section_id: entry.section_id,
            layout_key: entry.layout_key,
            media_kind: entry.media_kind,
            semantic_type: entry.semantic_type || classifyRenderSemantic(entry.layout_key, entry.media_kind),
          }))
        : [],
    },
    body: bodyBlocks,
    sections: [{
      pgSz: {
        w: docxLayout.page?.width || 11906,
        h: docxLayout.page?.height || 16838,
      },
      pgMar: {
        top: docxLayout.page?.margin_top || 1440,
        right: docxLayout.page?.margin_right || 1440,
        bottom: docxLayout.page?.margin_bottom || 1440,
        left: docxLayout.page?.margin_left || 1440,
        header: docxLayout.page?.header || 720,
        footer: docxLayout.page?.footer || 720,
      },
    }],
    headersFooters: [],
    relationships: [],
  };
}

function chunkTextToBullets(input: string, maxItems = 5): string[] {
  return String(input || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\/(?:Span|P|Lbl|LBody|TT\d*|C\d+_\d+)\s*<<.*?>>BDC/gs, ' ')
    .replace(/\b(?:BDC|EMC|BT|ET|TJ|Tj|Tf|Td|Tm)\b/g, ' ')
    .replace(/<[\dA-Fa-f]{4,}>/g, ' ')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, maxItems);
}

function splitCleanPdfTextIntoPages(input: string): Array<{ pageNumber: number; text: string }> {
  const lines = String(input || '').split(/\n/);
  const pages: Array<{ pageNumber: number; text: string }> = [];
  let currentPage = 1;
  let buffer: string[] = [];

  const flush = () => {
    const text = buffer.join('\n').trim();
    if (text) {
      pages.push({ pageNumber: currentPage, text });
    }
    buffer = [];
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();
    const marker = line.match(/^--\s*(\d+)\s+of\s+\d+\s*--$/);
    if (marker) {
      flush();
      currentPage = Number(marker[1]) + 1;
      continue;
    }
    buffer.push(rawLine);
  }

  flush();
  return pages;
}

function buildGridPageSummary(pageText: string, maxItems = 8): string[] {
  const rawLines = String(pageText || '')
    .split(/\n+/)
    .map((line) => line.replace(/\r/g, '').trim())
    .filter(Boolean);

  const skipExact = new Set([
    'カテゴリ',
    '選択肢',
    '回答方法',
    '質問文',
    'タイミング',
    '（1/2）',
    '（2/2）',
    '(参考)プログラム内容や運営への学び・改善点 各セッション メンティー向け',
    '(参考)プログラム内容や運営への学び・改善点 各セッション 人事担当者向け',
    '(参考)プログラム内容や運営への学び・改善点 全体 人事担当者向け',
  ]);

  const transientPattern = /^(?:\d+|✓|自由回答|1~[256]|1~5|\+|\/|Skill-?|input|Ment|oring|#\d+|キック|オフ後|クロー|ジン|グ後|タイミング|カテゴリ|選択肢|回答方法|質問文|後)$/;
  const continuationPattern = /^(?:どの|程度|ですか|すか|そう答えた理由|ください|ない|役立つ|感じた|感じなかった|自由回答|✓|1~[256]|1~5|\+|\/|次の|本日の|また、|（|大変満足|かなり達成)/;

  const mergedLines: string[] = [];
  for (const raw of rawLines) {
    const line = raw.replace(/\t+/g, '\t').replace(/[ ]{2,}/g, ' ').trim();
    if (!line) continue;

    const prev = mergedLines[mergedLines.length - 1];
    const isContinuation =
      prev &&
      (
        !prev.includes('。') &&
        !prev.includes('？') &&
        !prev.includes('?') &&
        (line.length <= 14 || continuationPattern.test(line))
      );

    if (isContinuation) {
      mergedLines[mergedLines.length - 1] = `${prev} ${line}`.replace(/\s+/g, ' ').trim();
    } else {
      mergedLines.push(line);
    }
  }

  const summaries: string[] = [];
  for (const raw of mergedLines) {
    const line = raw.replace(/\s+/g, ' ').trim();
    if (!line || skipExact.has(line)) continue;
    if (line.includes('G=G') || line.includes('FúFÔ')) continue;
    if (!/[\u3040-\u30ff\u3400-\u9fff]/.test(line)) continue;
    if (transientPattern.test(line)) continue;

    const cols = raw
      .split('\t')
      .map((part) => part.replace(/\s+/g, ' ').trim())
      .filter(Boolean)
      .filter((part) => !skipExact.has(part))
      .filter((part) => !transientPattern.test(part));

    let summary = line;
    if (cols.length >= 2) {
      const question = cols.find((part) => /[。？?]|ですか|教えてください|ご記入ください|感じましたか|満足度/.test(part)) || cols[cols.length - 1];
      const option = cols.find((part) => /(?:1~[256]|1~5|自由回答|役立つ\/特に役立たない|感じた\/感じなかった|大変満足)/.test(part));
      const category = cols.find((part) => /(キックオフ|クロージング|メンタリング|スキルインプット|ラウンドテーブル|人事担当者|全体)/.test(part));
      summary = [category, question, option].filter(Boolean).join(' / ');
    }

    summary = summary
      .replace(/\s+\/\s+/g, ' / ')
      .replace(/\s+/g, ' ')
      .trim();

    if (summary.length < 12) continue;
    summaries.push(summary);
  }

  return Array.from(new Set(summaries)).slice(0, maxItems);
}

function mergeCleanerPdfText(pdfDesign: PdfDesignProtocol, extractedText: string): PdfDesignProtocol {
  const cleanText = String(extractedText || '')
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/g, '')
    .replace(/\r/g, '')
    .trim();
  if (!cleanText) return pdfDesign;
  const cleanedPages = splitCleanPdfTextIntoPages(cleanText).map((page, index) => {
    const existing = pdfDesign.content?.pages?.[index];
    return {
      pageNumber: page.pageNumber,
      width: existing?.width || 595,
      height: existing?.height || 842,
      text: page.text,
      elements: existing?.elements,
      images: existing?.images,
      vectors: existing?.vectors,
      annotations: existing?.annotations,
      markedContent: existing?.markedContent,
      layerName: existing?.layerName,
    };
  });
  return {
    ...pdfDesign,
    source: {
      ...pdfDesign.source,
      body: cleanText,
    },
    content: pdfDesign.content
      ? {
          ...pdfDesign.content,
          text: cleanText,
          pages: cleanedPages.length > 0 ? cleanedPages : pdfDesign.content.pages,
        }
      : {
          text: cleanText,
          pages: cleanedPages,
        },
  };
}

async function extractCleanerPdfText(pdfPath: string): Promise<string> {
  const data = safeReadFile(pdfPath, { encoding: null }) as Buffer;
  const parser = new PDFParse({ data });
  try {
    const result = await parser.getText();
    return String(result.text || '');
  } finally {
    await parser.destroy();
  }
}

function isRenderablePdfElementText(text: string | undefined): boolean {
  if (!text) return false;
  const normalized = normalizePdfElementText(text);
  if (!normalized) return false;
  if (/[\u0000-\u001F]/.test(normalized)) return false;
  if (looksLikeGarbledAscii(normalized)) return false;
  let weirdCount = 0;
  for (const ch of normalized) {
    const code = ch.charCodeAt(0);
    if ((code >= 0x80 && code <= 0x9f) || code === 0xfffd) weirdCount++;
  }
  return weirdCount / normalized.length < 0.15;
}

function looksLikeGarbledAscii(text: string): boolean {
  if (/[\u3040-\u30ff\u3400-\u9fff]/.test(text)) return false;
  if (/\s/.test(text)) return false;
  if (text.length < 5) return false;
  if (/(?:G.{0,2}){3,}/.test(text)) return true;
  if (/F[þûôóï]/.test(text)) return true;
  return false;
}

function normalizePdfElementText(text: string | undefined): string {
  if (!text) return '';
  return String(text)
    .replace(/\\([0-7]{1,3})/g, (_, octal: string) => {
      const value = parseInt(octal, 8);
      if (value === 0x95) return '•';
      if (value === 0x96) return '–';
      if (value === 0x97) return '—';
      return String.fromCharCode(value);
    })
    .replace(/[\uF09F\u2022\u2023\u25E6\u2043]/g, '•')
    .replace(/[‒–—]/g, '–')
    .replace(/\s+/g, ' ')
    .trim();
}

function finalizePdfLineText(parts: string[]): string {
  const repeatableOnce = new Set(['✓', '自由回答', '+', '/', '1~6', '1~5', '1~2', '後']);
  const tokens: string[] = [];
  const seenRepeatable = new Set<string>();
  for (const raw of parts) {
    const token = normalizePdfElementText(raw);
    if (!token) continue;
    if (tokens[tokens.length - 1] === token) continue;
    if (repeatableOnce.has(token)) {
      if (seenRepeatable.has(token)) continue;
      seenRepeatable.add(token);
    }
    tokens.push(token);
  }

  return tokens
    .join(' ')
    .replace(/\s+([,.;:、。])/g, '$1')
    .replace(/•\s+/g, '• ')
    .replace(/\(\s+/g, '(')
    .replace(/\s+\)/g, ')')
    .replace(/\s+/g, ' ')
    .trim();
}

function isRenderablePdfLineText(text: string): boolean {
  if (!text) return false;
  if (looksLikeGarbledAscii(text)) return false;
  if (/[F][þûôóï]/.test(text)) return false;
  if (/G[=;Q9T][A-Za-z0-9ŠVGx]+/.test(text)) return false;
  const japaneseCount = (text.match(/[\u3040-\u30ff\u3400-\u9fff]/g) || []).length;
  const symbolCount = (text.match(/[✓•+\/]/g) || []).length;
  if (japaneseCount === 0 && symbolCount >= 3) return false;
  return true;
}

function buildRenderablePdfLines(page: any) {
  const pageElements = Array.isArray(page?.elements) ? page.elements : [];
  const sorted = pageElements
    .filter((element: any) => (element.type === 'text' || element.type === 'heading') && isRenderablePdfElementText(element.text))
    .map((element: any) => ({
      ...element,
      text: normalizePdfElementText(element.text),
    }))
    .filter((element: any) => element.text)
    .sort((a: any, b: any) => (a.y - b.y) || (a.x - b.x));

  const lines: any[] = [];
  for (const element of sorted) {
    const previous = lines[lines.length - 1];
    const tolerance = Math.max(4, (element.fontSize || 12) * 0.45);
    if (!previous || Math.abs(previous.y - element.y) > tolerance) {
      lines.push({
        y: element.y,
        x: element.x,
        width: element.width || 0,
        height: element.height || 0,
        fontSize: element.fontSize || 12,
        type: element.type,
        parts: [element],
      });
      continue;
    }

    previous.parts.push(element);
    previous.y = Math.min(previous.y, element.y);
    previous.x = Math.min(previous.x, element.x);
    previous.width = Math.max(previous.width, (element.x + (element.width || 0)) - previous.x);
    previous.height = Math.max(previous.height, element.height || 0);
    previous.fontSize = Math.max(previous.fontSize, element.fontSize || 12);
    if (element.type === 'heading') previous.type = 'heading';
  }

  return lines
    .map((line) => {
      const text = finalizePdfLineText(
        line.parts
        .sort((a: any, b: any) => a.x - b.x)
        .map((part: any) => part.text),
      );
      return { ...line, text };
    })
    .filter((line) => line.text && line.text.length >= 2)
    .filter((line) => isRenderablePdfLineText(line.text))
    .filter((line) => {
      const normalized = line.text.replace(/\s+/g, '');
      return !/^[0-9]+$/.test(normalized) || line.type === 'heading';
    });
}

function isGridLikePdfPage(page: any): boolean {
  const pageElements = Array.isArray(page?.elements) ? page.elements : [];
  if (pageElements.length < 60) return false;

  const xBuckets = new Set(pageElements.map((element: any) => Math.round((element.x || 0) / 20)));
  const undefinedFontCount = pageElements.filter((element: any) => !element.fontName).length;
  const shortCount = pageElements.filter((element: any) => normalizePdfElementText(element.text).length <= 4).length;
  const shortRatio = pageElements.length > 0 ? shortCount / pageElements.length : 0;
  const undefinedFontRatio = pageElements.length > 0 ? undefinedFontCount / pageElements.length : 0;

  return xBuckets.size >= 18 && (shortRatio > 0.35 || undefinedFontRatio > 0.2);
}

function getPdfPageClips(page: any) {
  return Array.isArray(page?.elements)
    ? page.elements.filter((element: any) => element?.type === 'clip' && (element.width || 0) > 8 && (element.height || 0) > 8)
    : [];
}

function intersectsPdfRegion(
  left: number,
  top: number,
  width: number,
  height: number,
  region: { x?: number; y?: number; width?: number; height?: number },
): boolean {
  const right = left + width;
  const bottom = top + height;
  const regionLeft = region.x || 0;
  const regionTop = region.y || 0;
  const regionRight = regionLeft + (region.width || 0);
  const regionBottom = regionTop + (region.height || 0);
  return Math.min(right, regionRight) > Math.max(left, regionLeft)
    && Math.min(bottom, regionBottom) > Math.max(top, regionTop);
}

function buildPositionedSlideClipBlocksFromPdfPage(page: any, canvas: { w: number; h: number }) {
  const pageWidth = page?.width || 960;
  const pageHeight = page?.height || 540;
  const clips = getPdfPageClips(page);
  const rects = Array.isArray(page?.elements) ? page.elements.filter((element: any) => element?.type === 'rect') : [];
  const borders = Array.isArray(page?.elements) ? page.elements.filter((element: any) => element?.type === 'border') : [];
  const pageArea = pageWidth * pageHeight;

  return clips
    .filter((clip: any) => ((clip.width || 0) * (clip.height || 0)) < pageArea * 0.92)
    .map((clip: any, index: number) => {
      let bestRect: any = null;
      let bestArea = 0;
      for (const rect of rects) {
        const overlapLeft = Math.max(clip.x || 0, rect.x || 0);
        const overlapTop = Math.max(clip.y || 0, rect.y || 0);
        const overlapRight = Math.min((clip.x || 0) + (clip.width || 0), (rect.x || 0) + (rect.width || 0));
        const overlapBottom = Math.min((clip.y || 0) + (clip.height || 0), (rect.y || 0) + (rect.height || 0));
        const overlapWidth = overlapRight - overlapLeft;
        const overlapHeight = overlapBottom - overlapTop;
        if (overlapWidth <= 0 || overlapHeight <= 0) continue;
        const overlapArea = overlapWidth * overlapHeight;
        if (overlapArea > bestArea) {
          bestArea = overlapArea;
          bestRect = rect;
        }
      }
      let bestBorder: any = null;
      let bestBorderScore = -1;
      for (const border of borders) {
        const horizontal = (border.width || 0) >= (border.height || 0);
        const borderLeft = border.x || 0;
        const borderTop = border.y || 0;
        const borderRight = borderLeft + (border.width || 0);
        const borderBottom = borderTop + (border.height || 0);
        const clipLeft = clip.x || 0;
        const clipTop = clip.y || 0;
        const clipRight = clipLeft + (clip.width || 0);
        const clipBottom = clipTop + (clip.height || 0);
        const nearTop = horizontal && Math.abs(borderTop - clipTop) <= 2 && borderRight > clipLeft && borderLeft < clipRight;
        const nearBottom = horizontal && Math.abs(borderTop - clipBottom) <= 2 && borderRight > clipLeft && borderLeft < clipRight;
        const nearLeft = !horizontal && Math.abs(borderLeft - clipLeft) <= 2 && borderBottom > clipTop && borderTop < clipBottom;
        const nearRight = !horizontal && Math.abs(borderLeft - clipRight) <= 2 && borderBottom > clipTop && borderTop < clipBottom;
        if (!(nearTop || nearBottom || nearLeft || nearRight)) continue;
        const score = Math.max(border.width || 0, border.height || 0);
        if (score > bestBorderScore) {
          bestBorderScore = score;
          bestBorder = border;
        }
      }
      return {
        type: 'shape',
        id: `pdf-clip-${page.pageNumber || 0}-${index + 1}`,
        shapeType: 'rect',
        pos: {
          x: Number((((clip.x || 0) / pageWidth) * canvas.w).toFixed(3)),
          y: Number((((clip.y || 0) / pageHeight) * canvas.h).toFixed(3)),
          w: Number((Math.max(0.2, ((clip.width || 0) / pageWidth) * canvas.w)).toFixed(3)),
          h: Number((Math.max(0.2, ((clip.height || 0) / pageHeight) * canvas.h)).toFixed(3)),
        },
        style: {
          fill: (bestRect?.fillColor || 'F8FAFC').replace('#', ''),
          line: (bestBorder?.strokeColor || bestRect?.strokeColor || 'E2E8F0').replace('#', ''),
          lineWidth: bestBorder?.lineWidth || bestRect?.lineWidth || 1,
          opacity: bestRect?.opacity !== undefined ? Math.max(1, Math.min(100, Math.round(bestRect.opacity * 100))) : 16,
        },
      };
    });
}

function buildPositionedSlideElementsFromPdfPage(page: any, canvas: { w: number; h: number }) {
  const pageWidth = page?.width || 960;
  const pageHeight = page?.height || 540;
  if (isGridLikePdfPage(page)) return [];
  const clips = getPdfPageClips(page);
  const filteredPage = clips.length === 0 ? page : {
    ...page,
    elements: (Array.isArray(page?.elements) ? page.elements : []).filter((element: any) => (
      !['text', 'heading'].includes(element?.type)
      || clips.some((clip: any) => intersectsPdfRegion(element.x || 0, element.y || 0, element.width || 0, element.height || 0, clip))
    )),
  };
  const lines = buildRenderablePdfLines(filteredPage);
  const noisyPage = lines.length > 0 && lines.filter((line) => line.text.length < 6).length / lines.length > 0.45;
  if (noisyPage) return [];

  return lines
    .slice(0, 12)
    .map((line: any, index: number) => {
      const x = Number(((line.x / pageWidth) * canvas.w).toFixed(3));
      const y = Number(((line.y / pageHeight) * canvas.h).toFixed(3));
      const w = Number((Math.min(canvas.w - x - 0.2, Math.max(1.6, (line.width / pageWidth) * canvas.w))).toFixed(3));
      const h = Number((Math.max(0.32, (line.height / pageHeight) * canvas.h)).toFixed(3));
      const fontSize = Math.max(12, Math.min(24, Math.round((line.fontSize || 12) * 1.18)));
      return {
        type: 'text',
        id: `pdf-line-${page.pageNumber || 0}-${index + 1}`,
        pos: { x, y, w, h },
        text: line.text,
        style: {
          fontSize,
          bold: line.type === 'heading' || fontSize >= 18,
          color: line.type === 'heading' ? '1F2937' : '334155',
          fontFamily: 'Aptos',
          align: 'left',
          valign: 'top',
        },
      };
    });
}

function buildPositionedSlideImagesFromPdfPage(page: any, canvas: { w: number; h: number }) {
  const pageWidth = page?.width || 960;
  const pageHeight = page?.height || 540;
  const images = Array.isArray(page?.images) ? page.images : [];
  const clips = Array.isArray(page?.elements) ? page.elements.filter((element: any) => element?.type === 'clip') : [];

  const findBestClip = (image: any) => {
    const imageLeft = image.x || 0;
    const imageTop = image.y || 0;
    const imageRight = imageLeft + (image.width || 0);
    const imageBottom = imageTop + (image.height || 0);
    let bestClip: any = null;
    let bestArea = 0;
    for (const clip of clips) {
      const clipLeft = clip.x || 0;
      const clipTop = clip.y || 0;
      const clipRight = clipLeft + (clip.width || 0);
      const clipBottom = clipTop + (clip.height || 0);
      const overlapLeft = Math.max(imageLeft, clipLeft);
      const overlapTop = Math.max(imageTop, clipTop);
      const overlapRight = Math.min(imageRight, clipRight);
      const overlapBottom = Math.min(imageBottom, clipBottom);
      const overlapWidth = overlapRight - overlapLeft;
      const overlapHeight = overlapBottom - overlapTop;
      if (overlapWidth <= 0 || overlapHeight <= 0) continue;
      const overlapArea = overlapWidth * overlapHeight;
      if (overlapArea > bestArea) {
        bestArea = overlapArea;
        bestClip = {
          x: overlapLeft,
          y: overlapTop,
          width: overlapWidth,
          height: overlapHeight,
        };
      }
    }
    return bestClip;
  };

  return images
    .filter((image: any) => typeof image?.path === 'string' && image.path)
    .map((image: any, index: number) => {
      const clip = findBestClip(image);
      const visible = clip || image;
      const x = Number((((visible.x || 0) / pageWidth) * canvas.w).toFixed(3));
      const y = Number((((visible.y || 0) / pageHeight) * canvas.h).toFixed(3));
      const w = Number((Math.max(0.3, ((visible.width || 0) / pageWidth) * canvas.w)).toFixed(3));
      const h = Number((Math.max(0.3, ((visible.height || 0) / pageHeight) * canvas.h)).toFixed(3));
      const result: any = {
        type: 'image',
        id: `pdf-image-${page.pageNumber || 0}-${index + 1}`,
        pos: { x, y, w, h },
        imagePath: image.path,
      };
      if (clip) {
        const baseWidth = Math.max(1, image.width || 0);
        const baseHeight = Math.max(1, image.height || 0);
        result.crop = {
          left: Math.round((((clip.x - (image.x || 0)) / baseWidth) * 100000)),
          top: Math.round((((clip.y - (image.y || 0)) / baseHeight) * 100000)),
          right: Math.round(((((image.x || 0) + baseWidth - (clip.x + clip.width)) / baseWidth) * 100000)),
          bottom: Math.round(((((image.y || 0) + baseHeight - (clip.y + clip.height)) / baseHeight) * 100000)),
        };
      }
      return result;
    });
}

async function maybeAugmentPdfDesignWithImageOcr(pdfDesign: PdfDesignProtocol, hints?: PdfToPptxHints): Promise<PdfDesignProtocol> {
  const resolvedHints: PdfToPptxHints = {
    canvas: { ...DEFAULT_PDF_TO_PPTX_HINTS.canvas, ...(hints?.canvas || {}) },
    features: { ...DEFAULT_PDF_TO_PPTX_HINTS.features, ...(hints?.features || {}) },
    ocr: { ...DEFAULT_PDF_TO_PPTX_HINTS.ocr, ...(hints?.ocr || {}) },
    style: { ...DEFAULT_PDF_TO_PPTX_HINTS.style, ...(hints?.style || {}) },
    layout: { ...DEFAULT_PDF_TO_PPTX_HINTS.layout, ...(hints?.layout || {}) },
    theme: { ...DEFAULT_PDF_TO_PPTX_HINTS.theme, ...(hints?.theme || {}) },
  };
  if (!resolvedHints.features?.fullPageImageOcrOverlay) return pdfDesign;
  if (!Array.isArray(pdfDesign.content?.pages) || pdfDesign.content.pages.length === 0) return pdfDesign;

  let Tesseract: any;
  try {
    ({ default: Tesseract } = await import('tesseract.js'));
  } catch (error: any) {
    logger.warn(`[MEDIA_TRANSFORM] fullPageImageOcrOverlay unavailable: ${error.message}`);
    return pdfDesign;
  }

  const cloned = cloneJsonValue(pdfDesign as any) as PdfDesignProtocol;
  for (const page of cloned.content.pages as any[]) {
    const pageWidth = page?.width || 960;
    const pageHeight = page?.height || 540;
    const pageArea = pageWidth * pageHeight;
    const images = Array.isArray(page?.images) ? page.images : [];
    const dominantImage = images.find((image: any) => (((image.width || 0) * (image.height || 0)) >= pageArea * 0.85));
    const positionedTextElements = Array.isArray(page?.elements)
      ? page.elements.filter((element: any) => ['text', 'heading'].includes(element?.type))
      : [];
    const existingTextCount = positionedTextElements.length;
    const reliableTextCount = positionedTextElements.filter((element: any) => isLikelyReliablePdfText(String(element?.text || ''))).length;
    const hasMostlyUnreliableText = existingTextCount > 0 && (reliableTextCount / existingTextCount) < 0.35;
    const shouldRunOcr = existingTextCount <= 8 || reliableTextCount <= 3 || hasMostlyUnreliableText;
    if (Array.isArray(page?.ocrLines) && page.ocrLines.length > 0) continue;
    if (!dominantImage || !dominantImage.path || !shouldRunOcr) continue;
    try {
      const requestedLanguage = resolvedHints.ocr?.language || 'jpn+eng';
      let ocr: any;
      try {
        ocr = await Tesseract.recognize(dominantImage.path, requestedLanguage);
      } catch (error: any) {
        if (requestedLanguage !== 'eng') {
          logger.warn(`[MEDIA_TRANSFORM] OCR fallback to eng on page ${page.pageNumber}: ${error.message}`);
          ocr = await Tesseract.recognize(dominantImage.path, 'eng');
        } else {
          throw error;
        }
      }
      page.ocrLines = buildPdfPageOcrOverlayLines(page, dominantImage, ocr);
    } catch (error: any) {
      logger.warn(`[MEDIA_TRANSFORM] fullPageImageOcrOverlay failed on page ${page.pageNumber}: ${error.message}`);
    }
  }
  return cloned;
}

function isLikelyReliablePdfText(text: string): boolean {
  const value = String(text || '').replace(/\s+/g, ' ').trim();
  if (value.length < 2) return false;
  if (/[\u0000-\u001f\u007f-\u009f]/u.test(value)) return false;

  const meaningfulCount = Array.from(value).filter((char) => /[\p{L}\p{N}]/u.test(char)).length;
  if (meaningfulCount < Math.max(2, Math.ceil(value.length * 0.35))) return false;

  const asciiLetters = Array.from(value).filter((char) => /[A-Za-z]/.test(char));
  if (asciiLetters.length >= 4 && !/\s/.test(value)) {
    const frequency = new Map<string, number>();
    for (const letter of asciiLetters) {
      frequency.set(letter, (frequency.get(letter) || 0) + 1);
    }
    const dominantLetterRatio = Math.max(...frequency.values()) / asciiLetters.length;
    if (dominantLetterRatio >= 0.5) return false;
  }

  return true;
}

function buildPdfPageOcrOverlayLines(page: any, dominantImage: any, ocr: any): any[] {
  const ocrLines = Array.isArray(ocr?.data?.lines) ? ocr.data.lines : [];
  const fromLines = ocrLines
    .map((line: any, index: number) => mapOcrLineToPdfOverlay(page, line, index, ocr?.data?.confidence ?? 0))
    .filter(Boolean);
  if (fromLines.length > 0) return fromLines;

  const text = String(ocr?.data?.text || '').replace(/\r/g, '\n');
  const textLines = text
    .split('\n')
    .map((line) => line.replace(/\s+/g, ' ').trim())
    .filter((line) => line.length >= 2);
  if (textLines.length === 0) return [];

  const baseX = Math.max(12, Number(dominantImage?.x ?? 0) + 18);
  const baseY = Math.max(12, Number(dominantImage?.y ?? 0) + 18);
  const maxWidth = Math.max(60, Math.min(Number(dominantImage?.width ?? page?.width ?? 960) - 36, (page?.width || 960) - baseX - 12));
  const lineHeight = 18;
  const maxLines = 18;
  const fallbackConfidence = Number(ocr?.data?.confidence ?? 0);
  return textLines.slice(0, maxLines).map((line, index) => ({
    id: `pdf-ocr-${page?.pageNumber || 0}-${index + 1}`,
    type: index === 0 && line.length <= 40 ? 'heading' : 'text',
    x: baseX,
    y: baseY + index * (lineHeight + 4),
    width: maxWidth,
    height: lineHeight,
    text: line,
    fontSize: index === 0 && line.length <= 40 ? 18 : 14,
    confidence: fallbackConfidence,
  }));
}

function mapOcrLineToPdfOverlay(page: any, line: any, index: number, fallbackConfidence: number): any | null {
  const text = String(line?.text || '').replace(/\s+/g, ' ').trim();
  if (!text || text.length < 2) return null;
  const bbox = line?.bbox || {};
  const x0 = Number(bbox.x0 ?? 0);
  const y0 = Number(bbox.y0 ?? 0);
  const x1 = Number(bbox.x1 ?? x0);
  const y1 = Number(bbox.y1 ?? y0);
  const width = Math.max(1, x1 - x0);
  const height = Math.max(1, y1 - y0);
  const confidence = Number(line?.confidence ?? fallbackConfidence ?? 0);
  if (confidence < 35) return null;
  return {
    id: `pdf-ocr-${page?.pageNumber || 0}-${index + 1}`,
    type: height >= 18 ? 'heading' : 'text',
    x: x0,
    y: y0,
    width,
    height,
    text,
    fontSize: Math.max(10, Math.round(height * 0.9)),
    confidence,
  };
}

function buildPositionedSlideOcrElementsFromPdfPage(page: any, canvas: { w: number; h: number }) {
  const pageWidth = page?.width || 960;
  const pageHeight = page?.height || 540;
  const lines = Array.isArray(page?.ocrLines) ? page.ocrLines : [];
  return lines.slice(0, 8).map((line: any) => ({
    type: 'text',
    id: line.id,
    pos: {
      x: Number((((line.x || 0) / pageWidth) * canvas.w).toFixed(3)),
      y: Number((((line.y || 0) / pageHeight) * canvas.h).toFixed(3)),
      w: Number((Math.max(0.4, ((line.width || 0) / pageWidth) * canvas.w)).toFixed(3)),
      h: Number((Math.max(0.24, ((line.height || 0) / pageHeight) * canvas.h)).toFixed(3)),
    },
    text: line.text,
    style: {
      fontSize: Math.max(12, Math.min(24, Math.round(line.fontSize || 12))),
      bold: line.type === 'heading',
      color: line.type === 'heading' ? 'FFFFFF' : 'F8FAFC',
      fontFamily: 'Aptos',
      align: 'left',
      valign: 'top',
    },
  }));
}

interface PdfToPptxHints {
  canvas?: { fallbackW?: number; fallbackH?: number };
  features?: {
    fullPageImageOverlay?: boolean;
    fullPageImageOcrOverlay?: boolean;
  };
  ocr?: {
    language?: string;
  };
  style?: {
    fontFamily?: string;
    titleFontSize?: number;
    pageTitleFontSize?: number;
    bodyFontSize?: number;
    defaultTextColor?: string;
    bodyTextColor?: string;
  };
  layout?: {
    titlePos?: { x: number; y: number; w: number; h: number };
    pageTitlePos?: { x: number; y: number; w: number; h: number };
    bodyPos?: { x: number; y: number; w: number; h: number };
  };
  theme?: { dk1?: string; dk2?: string; lt1?: string; lt2?: string; accent1?: string; accent2?: string };
}

const DEFAULT_PDF_TO_PPTX_HINTS: PdfToPptxHints = {
  canvas: { fallbackW: 10, fallbackH: 5.625 },
  features: {
    fullPageImageOverlay: false,
    fullPageImageOcrOverlay: false,
  },
  ocr: {
    language: 'jpn+eng',
  },
  style: {
    fontFamily: 'Aptos',
    titleFontSize: 28,
    pageTitleFontSize: 24,
    bodyFontSize: 16,
    defaultTextColor: '1F2937',
    bodyTextColor: '334155',
  },
  layout: {
    titlePos: { x: 0.7, y: 0.7, w: 8.8, h: 0.8 },
    pageTitlePos: { x: 0.7, y: 0.6, w: 8.8, h: 0.7 },
    bodyPos: { x: 0.8, y: 1.5, w: 8.4, h: 3.6 },
  },
  theme: {
    dk1: '111827',
    dk2: '475569',
    lt1: 'FFFFFF',
    lt2: 'F8FAFC',
    accent1: '2563EB',
    accent2: '0F172A',
  },
};

interface PdfToXlsxHints {
  grid?: {
    clusterTolerance?: number;
    bgAreaThreshold?: number;
    rectMergeTolerance?: number;
    textCellTolerance?: number;
    borderSnapTolerance?: number;
    textLineTolerance?: number;
  };
  desk?: {
    columnsPerUnit?: number;
    smallGapRange?: [number, number];
    minSmallGapCount?: number;
    maxFillMergeExtraCols?: number;
  };
  columnWidths?: {
    breakpoints?: Array<{ maxPt: number; chars: number }>;
    defaultRatio?: number;
  };
  rowHeight?: {
    scaleFactor?: number;
    minimum?: number;
  };
  view?: {
    showGridLines?: boolean;
    zoomScale?: number;
  };
  pageSetup?: {
    orientation?: 'portrait' | 'landscape';
    paperSize?: number;
    scale?: number;
  };
  fonts?: {
    defaultName?: string;
    defaultSize?: number;
    defaultColor?: string;
  };
  theme?: {
    dk1?: string;
    lt1?: string;
    dk2?: string;
    lt2?: string;
    accent1?: string;
    accent2?: string;
  };
  alignment?: {
    horizontal?: 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
    vertical?: 'top' | 'center' | 'bottom' | 'justify' | 'distributed';
    wrapText?: boolean;
  };
  border?: {
    style?: 'thin' | 'medium' | 'thick' | 'double' | 'dotted' | 'dashed'
      | 'dashDot' | 'dashDotDot' | 'mediumDashed' | 'mediumDashDot'
      | 'mediumDashDotDot' | 'slantDashDot' | 'hair' | 'none';
    color?: string;
  };
  subMerge?: {
    minRowSpan?: number;
    textGapRows?: number;
  };
}

const DEFAULT_PDF_TO_XLSX_HINTS: Required<PdfToXlsxHints> = {
  grid: {
    clusterTolerance: 3,
    bgAreaThreshold: 0.25,
    rectMergeTolerance: 3,
    textCellTolerance: 2,
    borderSnapTolerance: 2,
    textLineTolerance: 2,
  },
  desk: {
    columnsPerUnit: 3,
    smallGapRange: [5, 15],
    minSmallGapCount: 3,
    maxFillMergeExtraCols: 1,
  },
  columnWidths: {
    breakpoints: [
      { maxPt: 5, chars: 1.9 },
      { maxPt: 10, chars: 3.1 },
      { maxPt: 15, chars: 4.4 },
    ],
    defaultRatio: 7,
  },
  rowHeight: {
    scaleFactor: 0.75,
    minimum: 12,
  },
  view: {
    showGridLines: false,
    zoomScale: 85,
  },
  pageSetup: {
    orientation: 'landscape',
    paperSize: 9,
    scale: 35,
  },
  fonts: {
    defaultName: 'Meiryo UI',
    defaultSize: 9,
    defaultColor: '#111827',
  },
  theme: {
    dk1: '000000',
    lt1: 'FFFFFF',
    dk2: '44546A',
    lt2: 'E7E6E6',
    accent1: '4472C4',
    accent2: 'ED7D31',
  },
  alignment: {
    horizontal: 'center',
    vertical: 'center',
    wrapText: true,
  },
  border: {
    style: 'thin',
    color: '#000000',
  },
  subMerge: {
    minRowSpan: 4,
    textGapRows: 2,
  },
};

function buildPptxProtocolFromPdfDesign(pdfDesign: PdfDesignProtocol, hints?: PdfToPptxHints): any {
  const resolvedHints: PdfToPptxHints = {
    canvas: { ...DEFAULT_PDF_TO_PPTX_HINTS.canvas, ...(hints?.canvas || {}) },
    features: { ...DEFAULT_PDF_TO_PPTX_HINTS.features, ...(hints?.features || {}) },
    ocr: { ...DEFAULT_PDF_TO_PPTX_HINTS.ocr, ...(hints?.ocr || {}) },
    style: { ...DEFAULT_PDF_TO_PPTX_HINTS.style, ...(hints?.style || {}) },
    layout: { ...DEFAULT_PDF_TO_PPTX_HINTS.layout, ...(hints?.layout || {}) },
    theme: { ...DEFAULT_PDF_TO_PPTX_HINTS.theme, ...(hints?.theme || {}) },
  };
  const title = pdfDesign.metadata?.title || pdfDesign.source?.title || 'PDF Conversion';
  const pageTexts = Array.isArray(pdfDesign.content?.pages) ? pdfDesign.content!.pages : [];
  const canvas = {
    w: Number(resolvedHints.canvas?.fallbackW || 10),
    h: Number(resolvedHints.canvas?.fallbackH || 5.625),
  };
  const summaryBullets = chunkTextToBullets(
    pageTexts.map((page) => page.text || '').join('\n').trim() || pdfDesign.content?.text || '',
    4,
  );

  const slides = [
    {
      id: 'pdf-title',
      elements: [
        {
          type: 'text',
          placeholderType: 'title',
          pos: resolvedHints.layout?.titlePos || DEFAULT_PDF_TO_PPTX_HINTS.layout!.titlePos!,
          text: title,
          style: {
            fontSize: resolvedHints.style?.titleFontSize || DEFAULT_PDF_TO_PPTX_HINTS.style!.titleFontSize!,
            bold: true,
            color: resolvedHints.style?.defaultTextColor || DEFAULT_PDF_TO_PPTX_HINTS.style!.defaultTextColor!,
            fontFamily: resolvedHints.style?.fontFamily || DEFAULT_PDF_TO_PPTX_HINTS.style!.fontFamily!,
            align: 'left',
          },
        },
        {
          type: 'text',
          placeholderType: 'body',
          pos: { x: 0.9, y: 1.9, w: 8.2, h: 2.8 },
          text: summaryBullets.length > 0 ? summaryBullets.map((item) => `• ${item}`).join('\n') : 'Converted from PDF design.',
          style: {
            fontSize: 18,
            color: resolvedHints.theme?.dk2 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.dk2!,
            fontFamily: resolvedHints.style?.fontFamily || DEFAULT_PDF_TO_PPTX_HINTS.style!.fontFamily!,
            align: 'left',
          },
        },
      ],
    },
    ...pageTexts.map((page, index) => {
      const pageArea = (page?.width || 960) * (page?.height || 540);
      const positionedClipBlocks = buildPositionedSlideClipBlocksFromPdfPage(page, canvas);
      const positionedElements = buildPositionedSlideElementsFromPdfPage(page, canvas);
      const positionedImages = buildPositionedSlideImagesFromPdfPage(page, canvas);
      const dominantBackgroundImage = resolvedHints.features?.fullPageImageOverlay
        ? (Array.isArray(page?.images) ? page.images.find((image: any) => (((image.width || 0) * (image.height || 0)) >= pageArea * 0.85)) : null)
        : null;
      const backgroundImageElement = dominantBackgroundImage
        ? {
            type: 'image',
            id: `pdf-page-bg-${index + 1}`,
            pos: { x: 0, y: 0, w: canvas.w, h: canvas.h },
            imagePath: dominantBackgroundImage.path,
          }
        : null;
      const overlayMode = Boolean(backgroundImageElement);
      const foregroundImages = dominantBackgroundImage
        ? positionedImages.filter((element: any) => element.imagePath !== dominantBackgroundImage.path)
        : positionedImages;
      const effectiveClipBlocks = overlayMode ? [] : positionedClipBlocks;
      const ocrOverlayElements = overlayMode ? buildPositionedSlideOcrElementsFromPdfPage(page, canvas) : [];
      const effectiveElements = overlayMode
        ? (ocrOverlayElements.length > 0
            ? ocrOverlayElements
            : positionedElements
                .filter((element: any) => element.type === 'text')
                .filter((element: any) => (element.style?.bold || 0) || (element.style?.fontSize || 0) >= 18 || (element.text || '').length >= 24)
                .slice(0, 6))
        : positionedElements;
      const fallbackBullets = isGridLikePdfPage(page)
        ? buildGridPageSummary(page.text || '', 8)
        : chunkTextToBullets(page.text || '', 8);
      return {
        id: `pdf-page-${index + 1}`,
        elements: effectiveElements.length > 0 || foregroundImages.length > 0 || Boolean(backgroundImageElement)
          ? [
              {
                type: 'text',
                placeholderType: 'title',
                pos: { x: 0.35, y: 0.25, w: 9.1, h: 0.45 },
                text: `Page ${page.pageNumber || index + 1}`,
                style: { fontSize: 14, bold: true, color: '64748B', fontFamily: 'Aptos', align: 'right' },
              },
              ...(backgroundImageElement ? [backgroundImageElement] : []),
              ...effectiveClipBlocks,
              ...foregroundImages,
              ...effectiveElements,
            ]
          : [
              {
                type: 'text',
                placeholderType: 'title',
                pos: resolvedHints.layout?.pageTitlePos || DEFAULT_PDF_TO_PPTX_HINTS.layout!.pageTitlePos!,
                text: `Page ${page.pageNumber || index + 1}`,
                style: {
                  fontSize: resolvedHints.style?.pageTitleFontSize || DEFAULT_PDF_TO_PPTX_HINTS.style!.pageTitleFontSize!,
                  bold: true,
                  color: resolvedHints.style?.defaultTextColor || DEFAULT_PDF_TO_PPTX_HINTS.style!.defaultTextColor!,
                  fontFamily: resolvedHints.style?.fontFamily || DEFAULT_PDF_TO_PPTX_HINTS.style!.fontFamily!,
                  align: 'left',
                },
              },
              {
                type: 'text',
                placeholderType: 'body',
                pos: resolvedHints.layout?.bodyPos || DEFAULT_PDF_TO_PPTX_HINTS.layout!.bodyPos!,
                text: fallbackBullets.join('\n') || '(No extractable page text)',
                style: {
                  fontSize: resolvedHints.style?.bodyFontSize || DEFAULT_PDF_TO_PPTX_HINTS.style!.bodyFontSize!,
                  color: resolvedHints.style?.bodyTextColor || DEFAULT_PDF_TO_PPTX_HINTS.style!.bodyTextColor!,
                  fontFamily: resolvedHints.style?.fontFamily || DEFAULT_PDF_TO_PPTX_HINTS.style!.fontFamily!,
                  align: 'left',
                },
              },
            ],
      };
    }),
  ];

  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    canvas,
    theme: {
      dk1: resolvedHints.theme?.dk1 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.dk1!,
      dk2: resolvedHints.theme?.dk2 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.dk2!,
      lt1: resolvedHints.theme?.lt1 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.lt1!,
      lt2: resolvedHints.theme?.lt2 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.lt2!,
      accent1: resolvedHints.theme?.accent1 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.accent1!,
      accent2: resolvedHints.theme?.accent2 || DEFAULT_PDF_TO_PPTX_HINTS.theme!.accent2!,
    },
    master: {
      elements: [],
    },
    slides,
  };
}

function getXlsxColLetter(columnIndex: number): string {
  let value = Math.max(1, Math.floor(columnIndex));
  let result = '';
  while (value > 0) {
    const remainder = (value - 1) % 26;
    result = String.fromCharCode(65 + remainder) + result;
    value = Math.floor((value - 1) / 26);
  }
  return result || 'A';
}

function buildXlsxProtocolFromPdfDesign(pdfDesign: PdfDesignProtocol, hints?: PdfToXlsxHints): any {
  const H = {
    grid: { ...DEFAULT_PDF_TO_XLSX_HINTS.grid, ...(hints?.grid || {}) },
    desk: { ...DEFAULT_PDF_TO_XLSX_HINTS.desk, ...(hints?.desk || {}) },
    columnWidths: {
      ...DEFAULT_PDF_TO_XLSX_HINTS.columnWidths,
      ...(hints?.columnWidths || {}),
      breakpoints: hints?.columnWidths?.breakpoints || DEFAULT_PDF_TO_XLSX_HINTS.columnWidths.breakpoints,
    },
    rowHeight: { ...DEFAULT_PDF_TO_XLSX_HINTS.rowHeight, ...(hints?.rowHeight || {}) },
    view: { ...DEFAULT_PDF_TO_XLSX_HINTS.view, ...(hints?.view || {}) },
    pageSetup: { ...DEFAULT_PDF_TO_XLSX_HINTS.pageSetup, ...(hints?.pageSetup || {}) },
    fonts: { ...DEFAULT_PDF_TO_XLSX_HINTS.fonts, ...(hints?.fonts || {}) },
    theme: { ...DEFAULT_PDF_TO_XLSX_HINTS.theme, ...(hints?.theme || {}) },
    alignment: { ...DEFAULT_PDF_TO_XLSX_HINTS.alignment, ...(hints?.alignment || {}) },
    border: { ...DEFAULT_PDF_TO_XLSX_HINTS.border, ...(hints?.border || {}) },
    subMerge: { ...DEFAULT_PDF_TO_XLSX_HINTS.subMerge, ...(hints?.subMerge || {}) },
  };

  const pages = Array.isArray(pdfDesign.content?.pages) ? pdfDesign.content.pages : [];
  const emptyProtocol = {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    theme: {
      name: 'PDF Import',
      colors: H.theme,
      majorFont: H.fonts.defaultName,
      minorFont: H.fonts.defaultName,
    },
    styles: {
      fonts: [],
      fills: [],
      borders: [],
      numFmts: [],
      cellXfs: [],
      namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0, style: {} }],
      dxfs: [],
    },
    sharedStrings: [],
    sharedStringsRich: [],
    definedNames: [],
    sheets: [],
  };
  if (pages.length === 0) return emptyProtocol;

  const clusterCoords = (values: number[], tolerance: number): number[] => {
    const sorted = [...new Set(values.filter((value) => Number.isFinite(value)))].sort((a, b) => a - b);
    if (sorted.length === 0) return [];
    const clusters: number[] = [sorted[0]];
    for (let index = 1; index < sorted.length; index += 1) {
      if (sorted[index] - clusters[clusters.length - 1] > tolerance) {
        clusters.push(sorted[index]);
      }
    }
    return clusters;
  };

  const snapToGrid = (value: number, bounds: number[]): number => {
    let bestIndex = 0;
    let bestDistance = Infinity;
    for (let index = 0; index < bounds.length; index += 1) {
      const distance = Math.abs(bounds[index] - value);
      if (distance < bestDistance) {
        bestDistance = distance;
        bestIndex = index;
      }
    }
    return bestIndex;
  };

  type StyleEntry = { fill?: string; fontSize?: number; fontColor?: string; borderKey?: string };
  const styleEntries: StyleEntry[] = [];
  const styleKeyToIndex = new Map<string, number>();
  const ensureCellStyle = (fill?: string, fontSize?: number, fontColor?: string, borderKey?: string): number => {
    const normalizedFill = fill ? fill.replace('#', '').toUpperCase() : '';
    const normalizedFontColor = fontColor ? fontColor.replace('#', '').toUpperCase() : '';
    const key = `${normalizedFill}|${fontSize || 0}|${normalizedFontColor}|${borderKey || ''}`;
    if (styleKeyToIndex.has(key)) return styleKeyToIndex.get(key)!;
    const index = styleEntries.length + 1;
    styleEntries.push({
      fill: normalizedFill || undefined,
      fontSize: fontSize || undefined,
      fontColor: normalizedFontColor || undefined,
      borderKey: borderKey || undefined,
    });
    styleKeyToIndex.set(key, index);
    return index;
  };

  const sheets = pages.map((page: any, pageIndex: number) => {
    const elements = Array.isArray(page?.elements) ? page.elements : [];
    const rects = elements.filter((element: any) => element.type === 'rect');
    const clips = elements.filter((element: any) => element.type === 'clip');
    const borders = elements.filter((element: any) => element.type === 'border');
    const texts = elements.filter((element: any) => (
      !['rect', 'line', 'ellipse', 'clip', 'border'].includes(element.type)
      && typeof element.text === 'string'
      && element.text.trim()
    ));

    const pageWidth = page?.width || 842;
    const pageHeight = page?.height || 595;
    const pageArea = pageWidth * pageHeight;

    const mergedRects: any[] = [];
    for (const rect of rects) {
      const existing = mergedRects.find((candidate: any) => (
        Math.abs(candidate.x - rect.x) < H.grid.rectMergeTolerance
        && Math.abs(candidate.y - rect.y) < H.grid.rectMergeTolerance
        && Math.abs(candidate.width - rect.width) < H.grid.rectMergeTolerance
        && Math.abs(candidate.height - rect.height) < H.grid.rectMergeTolerance
      ));
      if (existing) {
        if (rect.fillColor && !existing.fillColor) existing.fillColor = rect.fillColor;
        if (rect.strokeColor && !existing.strokeColor) existing.strokeColor = rect.strokeColor;
        continue;
      }
      mergedRects.push({ ...rect });
    }

    const cellRects = mergedRects.filter((rect: any) => ((rect.width || 0) * (rect.height || 0)) < pageArea * H.grid.bgAreaThreshold);
    const rawXValues: number[] = [];
    const rawYValues: number[] = [];

    borders.forEach((border: any) => {
      if ((border.width || 0) > (border.height || 0)) {
        rawYValues.push(Math.round(border.y || 0));
      } else {
        rawXValues.push(Math.round(border.x || 0));
      }
    });
    clips.forEach((clip: any) => {
      rawXValues.push(Math.round(clip.x || 0), Math.round((clip.x || 0) + (clip.width || 0)));
      rawYValues.push(Math.round(clip.y || 0), Math.round((clip.y || 0) + (clip.height || 0)));
    });
    cellRects.forEach((rect: any) => {
      rawXValues.push(Math.round(rect.x || 0), Math.round((rect.x || 0) + (rect.width || 0)));
      rawYValues.push(Math.round(rect.y || 0), Math.round((rect.y || 0) + (rect.height || 0)));
    });

    const baseYBounds = clusterCoords(rawYValues, H.grid.clusterTolerance);
    const sortedTexts = [...texts].sort((left: any, right: any) => (left.y || 0) - (right.y || 0));
    let lastAddedY = -Infinity;
    for (const text of sortedTexts) {
      const y = Math.round(text.y || 0);
      if (y - lastAddedY <= H.grid.clusterTolerance) continue;
      const above = baseYBounds.filter((bound) => bound <= y).pop();
      const below = baseYBounds.find((bound) => bound > y);
      if (above !== undefined && below !== undefined && y - above > H.grid.clusterTolerance && below - y > H.grid.clusterTolerance) {
        rawYValues.push(y);
      }
      lastAddedY = y;
    }

    let xBounds = clusterCoords(rawXValues, H.grid.clusterTolerance);
    const yBounds = clusterCoords(rawYValues, H.grid.clusterTolerance);

    if (xBounds.length > 5) {
      const xGaps = xBounds.slice(1).map((value, index) => value - xBounds[index]);
      const smallGaps = xGaps.filter((gap) => gap >= H.desk.smallGapRange[0] && gap <= H.desk.smallGapRange[1]);
      if (smallGaps.length >= H.desk.minSmallGapCount) {
        const medianSmall = [...smallGaps].sort((left, right) => left - right)[Math.floor(smallGaps.length / 2)];
        const extraBounds: number[] = [];
        for (let index = 0; index < xGaps.length; index += 1) {
          const gap = xGaps[index];
          if (gap >= medianSmall * 1.7 && gap <= medianSmall * 2.5) {
            extraBounds.push(Math.round(xBounds[index] + gap / 2));
          }
          if (gap >= medianSmall * 2.5 && gap <= medianSmall * 3.5) {
            extraBounds.push(Math.round(xBounds[index] + gap / 3));
            extraBounds.push(Math.round(xBounds[index] + (gap * 2) / 3));
          }
        }
        if (extraBounds.length > 0) {
          xBounds = clusterCoords([...rawXValues, ...extraBounds], H.grid.clusterTolerance);
        }
      }
    }

    if (xBounds.length < 2 || yBounds.length < 2) {
      const fallbackRows = texts.map((text: any, index: number) => ({
        index: index + 1,
        height: 18,
        customHeight: true,
        cells: [{
          ref: `A${index + 1}`,
          type: 'inlineStr',
          value: String(text.text || '').trim(),
          styleIndex: ensureCellStyle(undefined, text.fontSize, text.color, ''),
        }],
      }));
      return {
        id: `sheet${pageIndex + 1}`,
        name: `Page ${pageIndex + 1}`,
        state: 'visible',
        dimension: `A1:A${Math.max(1, fallbackRows.length)}`,
        sheetView: { showGridLines: H.view.showGridLines, zoomScale: H.view.zoomScale },
        pageSetup: { orientation: H.pageSetup.orientation, paperSize: H.pageSetup.paperSize, scale: H.pageSetup.scale },
        columns: [{ min: 1, max: 1, width: 42, customWidth: true }],
        rows: fallbackRows,
        mergeCells: [],
        tables: [],
        conditionalFormats: [],
        dataValidations: [],
      };
    }

    const columns = [];
    for (let index = 0; index < xBounds.length - 1; index += 1) {
      const widthPt = xBounds[index + 1] - xBounds[index];
      let widthChars = H.columnWidths.defaultRatio > 0
        ? Math.max(1.9, Number((widthPt / H.columnWidths.defaultRatio).toFixed(1)))
        : 2;
      for (const breakpoint of H.columnWidths.breakpoints) {
        if (widthPt <= breakpoint.maxPt) {
          widthChars = breakpoint.chars;
          break;
        }
      }
      columns.push({ min: index + 1, max: index + 1, width: widthChars, customWidth: true });
    }

    const numCols = xBounds.length - 1;
    const numRows = yBounds.length - 1;
    const occupied = Array.from({ length: numRows }, () => new Array(numCols).fill(false));
    const mergeCells: Array<{ ref: string }> = [];

    const xGapsForDesk = xBounds.slice(1).map((value, index) => value - xBounds[index]).filter((gap) => gap >= 5 && gap <= 15);
    const deskColCount = xGapsForDesk.length >= 3 ? H.desk.columnsPerUnit : 1;
    const maxMergeColsForFill = deskColCount + H.desk.maxFillMergeExtraCols;

    for (const rect of cellRects) {
      const isFillOnly = Boolean(rect.fillColor) && !cellRects.some((candidate: any) => (
        candidate !== rect
        && !candidate.fillColor
        && Math.abs((candidate.x || 0) - (rect.x || 0)) < H.grid.rectMergeTolerance
        && Math.abs((candidate.y || 0) - (rect.y || 0)) < H.grid.rectMergeTolerance
        && Math.abs((candidate.width || 0) - (rect.width || 0)) < H.grid.rectMergeTolerance
        && Math.abs((candidate.height || 0) - (rect.height || 0)) < H.grid.rectMergeTolerance
      ));
      const startCol = snapToGrid(Math.round(rect.x || 0), xBounds);
      const startRow = snapToGrid(Math.round(rect.y || 0), yBounds);
      const endCol = Math.min(snapToGrid(Math.round((rect.x || 0) + (rect.width || 0)), xBounds), numCols);
      const endRow = Math.min(snapToGrid(Math.round((rect.y || 0) + (rect.height || 0)), yBounds), numRows);
      if (startCol >= numCols || startRow >= numRows) continue;
      const spanCols = endCol - startCol;
      const spanRows = endRow - startRow;
      if (isFillOnly && spanCols > maxMergeColsForFill) continue;
      if (spanCols <= 1 && spanRows <= 1) continue;

      const subMergeRows: number[] = [startRow];
      if (spanRows > H.subMerge.minRowSpan) {
        const rectTexts = texts
          .filter((text: any) => {
            const x = text.x || 0;
            const y = text.y || 0;
            return x >= xBounds[startCol] - 5 && x < xBounds[endCol] + 5 && y >= yBounds[startRow] - 5 && y < yBounds[endRow] + 5;
          })
          .sort((left: any, right: any) => (left.y || 0) - (right.y || 0));
        let lastTextRow = startRow;
        for (const text of rectTexts) {
          const textRow = snapToGrid(Math.round(text.y || 0), yBounds);
          if (textRow > lastTextRow + H.subMerge.textGapRows && textRow > subMergeRows[subMergeRows.length - 1]) {
            subMergeRows.push(textRow);
          }
          lastTextRow = Math.max(lastTextRow, textRow);
        }
      }
      subMergeRows.push(endRow);

      for (let index = 0; index < subMergeRows.length - 1; index += 1) {
        const subStart = subMergeRows[index];
        const subEnd = subMergeRows[index + 1];
        if (subEnd <= subStart) continue;
        if (subEnd - subStart <= 1 && spanCols <= 1) continue;

        let canMerge = true;
        for (let row = subStart; row < subEnd && canMerge; row += 1) {
          for (let col = startCol; col < endCol && canMerge; col += 1) {
            if (occupied[row][col]) canMerge = false;
          }
        }
        if (!canMerge) continue;
        const startRef = `${getXlsxColLetter(startCol + 1)}${subStart + 1}`;
        const endRef = `${getXlsxColLetter(endCol)}${subEnd}`;
        mergeCells.push({ ref: `${startRef}:${endRef}` });
        for (let row = subStart; row < subEnd; row += 1) {
          for (let col = startCol; col < endCol; col += 1) {
            occupied[row][col] = true;
          }
        }
      }
    }

    const cellFillMap = new Map<string, string>();
    for (const rect of cellRects) {
      if (!rect.fillColor) continue;
      const startCol = snapToGrid(Math.round(rect.x || 0), xBounds);
      const startRow = snapToGrid(Math.round(rect.y || 0), yBounds);
      const endCol = Math.min(snapToGrid(Math.round((rect.x || 0) + (rect.width || 0)), xBounds), numCols);
      const endRow = Math.min(snapToGrid(Math.round((rect.y || 0) + (rect.height || 0)), yBounds), numRows);
      for (let row = startRow; row < endRow; row += 1) {
        for (let col = startCol; col < endCol; col += 1) {
          cellFillMap.set(`${row},${col}`, rect.fillColor);
        }
      }
    }

    type CellBorders = { top: boolean; bottom: boolean; left: boolean; right: boolean };
    const cellBorderMap = new Map<string, CellBorders>();
    const getCellBorders = (row: number, col: number): CellBorders => {
      const key = `${row},${col}`;
      if (!cellBorderMap.has(key)) {
        cellBorderMap.set(key, { top: false, bottom: false, left: false, right: false });
      }
      return cellBorderMap.get(key)!;
    };

    for (const border of borders) {
      if ((border.width || 0) > (border.height || 0)) {
        const borderY = Math.round(border.y || 0);
        const borderX1 = Math.round(border.x || 0);
        const borderX2 = Math.round((border.x || 0) + (border.width || 0));
        for (let row = 0; row < numRows; row += 1) {
          if (Math.abs(yBounds[row] - borderY) <= H.grid.borderSnapTolerance) {
            for (let col = 0; col < numCols; col += 1) {
              if (xBounds[col] >= borderX1 - H.grid.borderSnapTolerance && xBounds[col + 1] <= borderX2 + H.grid.borderSnapTolerance) {
                getCellBorders(row, col).top = true;
                if (row > 0) getCellBorders(row - 1, col).bottom = true;
              }
            }
          }
          if (Math.abs(yBounds[row + 1] - borderY) <= H.grid.borderSnapTolerance) {
            for (let col = 0; col < numCols; col += 1) {
              if (xBounds[col] >= borderX1 - H.grid.borderSnapTolerance && xBounds[col + 1] <= borderX2 + H.grid.borderSnapTolerance) {
                getCellBorders(row, col).bottom = true;
                if (row + 1 < numRows) getCellBorders(row + 1, col).top = true;
              }
            }
          }
        }
      } else {
        const borderX = Math.round(border.x || 0);
        const borderY1 = Math.round(border.y || 0);
        const borderY2 = Math.round((border.y || 0) + (border.height || 0));
        for (let col = 0; col < numCols; col += 1) {
          if (Math.abs(xBounds[col] - borderX) <= H.grid.borderSnapTolerance) {
            for (let row = 0; row < numRows; row += 1) {
              if (yBounds[row] >= borderY1 - H.grid.borderSnapTolerance && yBounds[row + 1] <= borderY2 + H.grid.borderSnapTolerance) {
                getCellBorders(row, col).left = true;
                if (col > 0) getCellBorders(row, col - 1).right = true;
              }
            }
          }
          if (Math.abs(xBounds[col + 1] - borderX) <= H.grid.borderSnapTolerance) {
            for (let row = 0; row < numRows; row += 1) {
              if (yBounds[row] >= borderY1 - H.grid.borderSnapTolerance && yBounds[row + 1] <= borderY2 + H.grid.borderSnapTolerance) {
                getCellBorders(row, col).right = true;
                if (col + 1 < numCols) getCellBorders(row, col + 1).left = true;
              }
            }
          }
        }
      }
    }

    const sheetRows: any[] = [];
    const usedTexts = new Set<number>();
    for (let rowIndex = 0; rowIndex < numRows; rowIndex += 1) {
      const rowY = yBounds[rowIndex];
      const rowHeight = yBounds[rowIndex + 1] - rowY;
      const cells: any[] = [];

      for (let colIndex = 0; colIndex < numCols; colIndex += 1) {
        const cellX = xBounds[colIndex];
        const cellWidth = xBounds[colIndex + 1] - cellX;
        const cellRef = `${getXlsxColLetter(colIndex + 1)}${rowIndex + 1}`;

        if (occupied[rowIndex][colIndex]) {
          const isMergeStart = mergeCells.some((merge) => merge.ref.startsWith(`${cellRef}:`));
          if (!isMergeStart) {
            cells.push({ ref: cellRef, styleIndex: 0 });
            continue;
          }
        }

        let searchEndX = cellX + cellWidth;
        let searchEndY = rowY + rowHeight;
        const merge = mergeCells.find((candidate) => candidate.ref.startsWith(`${cellRef}:`));
        if (merge) {
          const endParts = merge.ref.split(':')[1]?.match(/^([A-Z]+)(\d+)$/);
          if (endParts) {
            let endColNumber = 0;
            for (let index = 0; index < endParts[1].length; index += 1) {
              endColNumber = endColNumber * 26 + endParts[1].charCodeAt(index) - 64;
            }
            const endRowNumber = Number.parseInt(endParts[2], 10);
            if (endColNumber <= xBounds.length - 1) searchEndX = xBounds[endColNumber];
            if (endRowNumber <= yBounds.length - 1) searchEndY = yBounds[endRowNumber];
          }
        }

        const cellTexts = texts
          .map((text: any, textIndex: number) => ({ text, textIndex }))
          .filter(({ text, textIndex }) => {
            if (usedTexts.has(textIndex)) return false;
            return (text.x || 0) >= cellX - H.grid.textCellTolerance
              && (text.x || 0) < searchEndX + H.grid.textCellTolerance
              && (text.y || 0) >= rowY - H.grid.textCellTolerance
              && (text.y || 0) < searchEndY + H.grid.textCellTolerance;
          })
          .sort((left, right) => {
            const deltaY = (left.text.y || 0) - (right.text.y || 0);
            return Math.abs(deltaY) > 3 ? deltaY : (left.text.x || 0) - (right.text.x || 0);
          });

        let cellValue = '';
        let lastY = -Infinity;
        for (const { text } of cellTexts) {
          const y = text.y || 0;
          if (!cellValue) {
            cellValue = text.text || '';
          } else if (Math.abs(y - lastY) <= H.grid.textLineTolerance) {
            cellValue += ` ${text.text || ''}`;
          } else {
            cellValue += `\n${text.text || ''}`;
          }
          lastY = y;
        }
        cellValue = cellValue.trim();
        cellTexts.forEach(({ textIndex }) => usedTexts.add(textIndex));

        const dominantFontSize = cellTexts.map(({ text }) => text.fontSize).find((value) => Number.isFinite(value));
        const dominantFontColor = cellTexts.map(({ text }) => text.color).find((value) => typeof value === 'string');
        const fillColor = cellFillMap.get(`${rowIndex},${colIndex}`);
        const cellBorders = cellBorderMap.get(`${rowIndex},${colIndex}`);
        const borderKey = cellBorders
          ? `${cellBorders.top ? 'T' : ''}${cellBorders.bottom ? 'B' : ''}${cellBorders.left ? 'L' : ''}${cellBorders.right ? 'R' : ''}`
          : '';
        const hasStyle = fillColor || dominantFontSize || dominantFontColor || borderKey;
        const styleIndex = hasStyle ? ensureCellStyle(fillColor, dominantFontSize, dominantFontColor, borderKey) : 0;

        cells.push({
          ref: cellRef,
          value: cellValue || undefined,
          type: cellValue ? 'inlineStr' : undefined,
          styleIndex,
        });
      }

      sheetRows.push({
        index: rowIndex + 1,
        height: Math.max(H.rowHeight.minimum, Math.round(rowHeight * H.rowHeight.scaleFactor)),
        customHeight: true,
        cells,
      });
    }

    const lastColLetter = getXlsxColLetter(numCols);
    return {
      id: `sheet${pageIndex + 1}`,
      name: `Page ${pageIndex + 1}`,
      state: 'visible',
      dimension: `A1:${lastColLetter}${numRows}`,
      sheetView: { showGridLines: H.view.showGridLines, zoomScale: H.view.zoomScale },
      pageSetup: { orientation: H.pageSetup.orientation, paperSize: H.pageSetup.paperSize, scale: H.pageSetup.scale },
      columns,
      rows: sheetRows,
      mergeCells,
      tables: [],
      conditionalFormats: [],
      dataValidations: [],
    };
  });

  const defaultFont = { name: H.fonts.defaultName, size: H.fonts.defaultSize, color: { rgb: H.fonts.defaultColor } };
  const noBorder = {};
  const noFill = { patternType: 'none' as const };
  const grayFill = { patternType: 'gray125' as const };
  const thinSide = { style: H.border.style, color: { rgb: H.border.color } };

  const fonts: any[] = [defaultFont];
  const fills: any[] = [noFill, grayFill];
  const borders: any[] = [noBorder];
  const cellXfs: any[] = [{
    font: defaultFont,
    fill: noFill,
    border: noBorder,
    alignment: {
      horizontal: H.alignment.horizontal,
      vertical: H.alignment.vertical,
      wrapText: H.alignment.wrapText,
    },
  }];

  const fontCache = new Map<string, any>();
  fontCache.set(`${H.fonts.defaultSize}|${H.fonts.defaultColor.replace('#', '').toUpperCase()}`, defaultFont);
  const fillCache = new Map<string, any>();
  fillCache.set('', noFill);
  const borderCache = new Map<string, any>();
  borderCache.set('', noBorder);

  const resolveBorder = (key: string): any => {
    if (!key) return noBorder;
    if (borderCache.has(key)) return borderCache.get(key)!;
    const border: any = {};
    if (key.includes('T')) border.top = thinSide;
    if (key.includes('B')) border.bottom = thinSide;
    if (key.includes('L')) border.left = thinSide;
    if (key.includes('R')) border.right = thinSide;
    borderCache.set(key, border);
    borders.push(border);
    return border;
  };

  for (const entry of styleEntries) {
    const fontKey = `${entry.fontSize || H.fonts.defaultSize}|${entry.fontColor || H.fonts.defaultColor.replace('#', '').toUpperCase()}`;
    let font = fontCache.get(fontKey);
    if (!font) {
      font = {
        name: H.fonts.defaultName,
        size: entry.fontSize || H.fonts.defaultSize,
        color: { rgb: entry.fontColor ? `#${entry.fontColor}` : H.fonts.defaultColor },
      };
      fontCache.set(fontKey, font);
      fonts.push(font);
    }

    const fillKey = entry.fill || '';
    let fill = fillCache.get(fillKey);
    if (!fill) {
      fill = { patternType: 'solid' as const, fgColor: { rgb: `#${entry.fill}` } };
      fillCache.set(fillKey, fill);
      fills.push(fill);
    }

    cellXfs.push({
      font,
      fill,
      border: resolveBorder(entry.borderKey || ''),
      alignment: {
        horizontal: H.alignment.horizontal,
        vertical: H.alignment.vertical,
        wrapText: H.alignment.wrapText,
      },
    });
  }

  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    theme: {
      name: 'PDF Import',
      colors: H.theme,
      majorFont: H.fonts.defaultName,
      minorFont: H.fonts.defaultName,
    },
    styles: {
      fonts,
      fills,
      borders,
      numFmts: [],
      cellXfs,
      namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0, style: {} }],
      dxfs: [],
    },
    sharedStrings: [],
    sharedStringsRich: [],
    definedNames: [],
    sheets,
  };
}

function buildReportPdfProtocol(rootDir: string, brief: any): any {
  const outline = buildReportNarrativeOutline(rootDir, brief);
  const { preset } = resolveDocumentCompositionPreset(rootDir, brief);
  const { template, templateId } = resolveDocumentLayoutTemplate(rootDir, {
    document_type: 'report',
    layout_template_id: brief.layout_template_id,
  });
  const activeTheme = resolveNamedTheme(rootDir, preset?.recommended_theme);
  const pdfLayout = template?.pdf || {};
  const hexToPdfRgb = (hex: string | undefined, fallback: [number, number, number]): [number, number, number] => {
    if (!hex || typeof hex !== 'string') return fallback;
    const normalized = hex.replace('#', '').trim();
    if (normalized.length !== 6) return fallback;
    const r = Number.parseInt(normalized.slice(0, 2), 16);
    const g = Number.parseInt(normalized.slice(2, 4), 16);
    const b = Number.parseInt(normalized.slice(4, 6), 16);
    if ([r, g, b].some((value) => Number.isNaN(value))) return fallback;
    return [r / 255, g / 255, b / 255];
  };
  const tableStyle = pdfLayout.table || {};
  const tableWidth = Number(tableStyle.width || 490);
  const headerFill = hexToPdfRgb(tableStyle.header_fill, hexToPdfRgb(activeTheme?.colors?.primary, [0.12, 0.16, 0.22]));
  const gridStroke = hexToPdfRgb(tableStyle.grid_stroke, [0.8, 0.84, 0.89]);
  const outerStroke = hexToPdfRgb(tableStyle.outer_stroke, [0.58, 0.64, 0.72]);
  const zebraFill = hexToPdfRgb(tableStyle.zebra_fill, [0.97, 0.98, 0.99]);
  const showZebra = tableStyle.show_zebra !== false;
  const accentFill = hexToPdfRgb(activeTheme?.colors?.accent, [0.93, 0.96, 1.0]);
  const themePrimary = String(activeTheme?.colors?.primary || template?.colors?.primary || '#1f2937');
  const themeSecondary = String(activeTheme?.colors?.secondary || template?.colors?.secondary || '#4b5563');
  const themeAccent = String(activeTheme?.colors?.accent || template?.colors?.accent || '#2563eb');
  const themeBackground = String(activeTheme?.colors?.background || '#ffffff');
  const vectors: any[] = [];
  const bodySections = [
    brief.payload.title || 'Report',
    brief.payload.summary || '',
    ...brief.payload.sections.flatMap((section: any) => [
      section.heading || 'Section',
      ...(Array.isArray(section.body) ? section.body : []),
      ...(Array.isArray(section.bullets) ? section.bullets.map((item: string) => `- ${item}`) : []),
    ]),
  ].filter(Boolean);

  const elements: any[] = [
    {
      type: 'text',
      x: pdfLayout.title_x || pdfLayout.margin_left || 48,
      y: pdfLayout.title_y || 42,
      text: brief.payload.title || 'Report',
      fontSize: pdfLayout.title_font_size || 22,
    },
  ];

  let cursorY = (pdfLayout.title_y || 42) + 42;
  if (brief.payload.summary) {
    elements.push({
      type: 'text',
      x: pdfLayout.margin_left || 48,
      y: cursorY,
      text: brief.payload.summary,
      fontSize: pdfLayout.summary_font_size || 11,
    });
    cursorY += pdfLayout.summary_gap || 30;
  }

  for (const section of brief.payload.sections) {
    const sectionId = String(section.heading || 'section').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const sectionPlan = Array.isArray(outline.toc)
      ? outline.toc.find((entry: any) => entry.section_id === sectionId)
      : null;
    const semanticType = sectionPlan?.semantic_type || classifyRenderSemantic(sectionPlan?.layout_key, sectionPlan?.media_kind);
    const semanticTokens = resolveSemanticRenderTokens(rootDir, semanticType);
    const pdfTokens = semanticTokens.pdf || {};
    const isAppendix = semanticType === 'appendix';
    const sectionHeaderColor = pdfTokens.header_color === 'secondary'
      ? hexToPdfRgb(themeSecondary, [0.3, 0.34, 0.39])
      : pdfTokens.header_color === 'accent'
        ? hexToPdfRgb(themeAccent, [0.15, 0.39, 0.92])
        : hexToPdfRgb(themePrimary, [0.12, 0.16, 0.22]);
    const sectionBodyX = pdfTokens.body_x === 'margin' ? (pdfLayout.margin_left || 48) : (pdfLayout.content_x || 56);
    const bodyFontSize = (pdfLayout.body_font_size || 10) + Number(pdfTokens.body_font_size_delta || 0);
    const blockFill = pdfTokens.block_fill === 'primary'
      ? headerFill
      : pdfTokens.block_fill === 'accent'
        ? accentFill
        : null;
    elements.push({
      type: 'text',
      x: pdfLayout.margin_left || 48,
      y: cursorY,
      text: section.heading || 'Section',
      fontSize: isAppendix ? Math.max((pdfLayout.section_font_size || 14) - 2, 11) : (pdfLayout.section_font_size || 14),
      color: sectionHeaderColor,
    });
    cursorY += 22;
    if (blockFill) {
      const blockHeight = Math.max(
        (Array.isArray(section.body) ? section.body.length : 0) * (pdfLayout.line_height || 16) + 18,
        26,
      );
      vectors.push({
        shape: {
          kind: 'rect',
          x: (pdfLayout.margin_left || 48) - 8,
          y: cursorY - 8,
          width: 490,
          height: blockHeight,
        },
        fillColor: blockFill,
        fillOpacity: Number(pdfTokens.block_opacity || 0),
      });
    }
    if (Array.isArray(section.body)) {
      for (const paragraph of section.body) {
        elements.push({
          type: 'text',
          x: sectionBodyX,
          y: cursorY,
          text: String(paragraph),
          fontSize: bodyFontSize,
        });
        cursorY += pdfLayout.line_height || 16;
      }
    }
    if (Array.isArray(section.bullets)) {
      for (const bullet of section.bullets) {
        elements.push({
          type: 'text',
          x: pdfLayout.bullet_x || 64,
          y: cursorY,
          text: `• ${String(bullet)}`,
          fontSize: pdfLayout.body_font_size || 10,
        });
        cursorY += pdfLayout.line_height || 16;
      }
    }
    if (Array.isArray(section.callouts)) {
      for (const callout of section.callouts) {
        const title = [callout.title, callout.tone ? `(${callout.tone})` : ''].filter(Boolean).join(' ');
        const calloutBoxY = cursorY - 4;
        const calloutBoxHeight = callout.body ? (pdfLayout.line_height || 16) * 2 : (pdfLayout.line_height || 16) + 4;
        vectors.push({
          shape: {
            kind: 'rect',
            x: (pdfLayout.callout_x || 64) - 8,
            y: calloutBoxY,
            width: 470,
            height: calloutBoxHeight,
          },
          fillColor: pdfTokens.callout_fill === 'primary' ? headerFill : accentFill,
          fillOpacity: Number(pdfTokens.callout_opacity ?? 0.7),
        });
        if (title) {
          elements.push({
            type: 'text',
            x: pdfLayout.callout_x || 64,
            y: cursorY,
            text: title,
            fontSize: pdfLayout.callout_title_font_size || 11,
          });
          cursorY += pdfLayout.line_height || 16;
        }
        if (callout.body) {
          elements.push({
            type: 'text',
            x: pdfLayout.callout_x || 64,
            y: cursorY,
            text: String(callout.body),
            fontSize: pdfLayout.body_font_size || 10,
          });
          cursorY += pdfLayout.line_height || 16;
        }
        cursorY += pdfLayout.callout_gap || 18;
      }
    }
    if (Array.isArray(section.tables)) {
      for (const table of section.tables) {
        if (table.title) {
          elements.push({
            type: 'text',
            x: pdfLayout.table_x || 56,
            y: cursorY,
            text: String(table.title),
            fontSize: pdfLayout.table_title_font_size || 11,
          });
          cursorY += pdfLayout.line_height || 16;
        }
        const columns = Array.isArray(table.columns) ? table.columns.map((value: any) => String(value)) : [];
        const rows = Array.isArray(table.rows) ? table.rows : [];
        if (columns.length > 0) {
          const tableX = pdfLayout.table_x || 56;
          const columnWidth = tableWidth / columns.length;
          const tableHeaderY = cursorY - 4;
          const rowHeight = pdfLayout.line_height || 16;
          const tableHeight = rowHeight + 4 + (rows.length * rowHeight);
          vectors.push({
            shape: {
              kind: 'rect',
              x: tableX - 4,
              y: tableHeaderY,
              width: tableWidth,
              height: rowHeight + 4,
            },
            fillColor: headerFill,
            fillOpacity: 0.95,
          });
          vectors.push({
            shape: {
              kind: 'rect',
              x: tableX - 4,
              y: tableHeaderY,
              width: tableWidth,
              height: tableHeight,
            },
            strokeColor: outerStroke,
            lineWidth: 0.7,
          });
          columns.forEach((column: string, index: number) => {
            if (index > 0) {
              vectors.push({
                shape: {
                  kind: 'line',
                  x1: tableX + columnWidth * index - 4,
                  y1: tableHeaderY,
                  x2: tableX + columnWidth * index - 4,
                  y2: tableHeaderY + tableHeight,
                },
                strokeColor: gridStroke,
                lineWidth: 0.4,
              });
            }
            elements.push({
              type: 'text',
              x: tableX + (columnWidth * index) + 4,
              y: cursorY,
              text: column,
              fontSize: pdfLayout.body_font_size || 10,
            });
          });
          cursorY += rowHeight;
          rows.forEach((row: any, rowIndex: number) => {
            const values = Array.isArray(row)
              ? row
              : columns.map((column: string) => row?.[column] ?? '');
            if (showZebra && rowIndex % 2 === 1) {
              vectors.push({
                shape: {
                  kind: 'rect',
                  x: tableX - 4,
                  y: cursorY - 4,
                  width: tableWidth,
                  height: rowHeight,
                },
                fillColor: zebraFill,
                fillOpacity: 0.6,
              });
            }
            vectors.push({
              shape: {
                kind: 'line',
                x1: tableX - 4,
                y1: cursorY - 2,
                x2: tableX + tableWidth - 4,
                y2: cursorY - 2,
              },
              strokeColor: gridStroke,
              lineWidth: 0.5,
            });
            values.forEach((value: any, index: number) => {
              elements.push({
                type: 'text',
                x: tableX + (columnWidth * index) + 4,
                y: cursorY,
                text: String(value ?? ''),
                fontSize: pdfLayout.body_font_size || 10,
              });
            });
            cursorY += rowHeight;
          });
          cursorY += pdfLayout.table_gap || 22;
        }
      }
    }
    cursorY += pdfLayout.section_gap || 10;
  }

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    source: {
      format: 'markdown',
      title: brief.payload.title || 'Report',
      body: bodySections.join('\n'),
    },
    metadata: {
      title: brief.payload.title || 'Report',
      subject: brief.document_profile || 'summary-report',
      author: 'Kyberion Media-Actuator',
      creationDate: new Date().toISOString(),
      composition: outline,
      generationBoundary: outline.generation_boundary || buildMediaGenerationBoundary(outline),
      recommendedTheme: preset?.recommended_theme || 'kyberion-standard',
      branding: preset?.branding || {},
      sectionSemantics: Array.isArray(outline.toc)
        ? outline.toc.map((entry: any) => ({
            section_id: entry.section_id,
            layout_key: entry.layout_key,
            media_kind: entry.media_kind,
            semantic_type: entry.semantic_type || classifyRenderSemantic(entry.layout_key, entry.media_kind),
          }))
        : [],
    },
    content: {
      text: bodySections.join('\n'),
      pages: [{ pageNumber: 1, width: 595, height: 842, text: '', vectors }],
    },
    aesthetic: {
      layout: 'single-column',
      elements,
      colors: [themePrimary, themeSecondary, themeAccent],
      fonts: [brief.locale?.startsWith('ja') ? 'HeiseiKakuGo-W5' : 'Helvetica'],
      branding: {
        logoPresence: Boolean(preset?.branding?.logo_url || activeTheme?.assets?.logo_url),
        logoUrl: preset?.branding?.logo_url || activeTheme?.assets?.logo_url || null,
        brandName: preset?.branding?.brand_name || brief.payload?.client || brief.client || null,
        primaryColor: themePrimary,
        secondaryColor: themeSecondary,
        backgroundColor: themeBackground,
        tone: preset?.branding?.tone || 'professional',
      },
      templateId,
    },
    renderOptions: {
      compress: true,
      unicode: true,
      xmpMetadata: true,
      tagged: false,
      linearize: false,
      objectStreams: false,
    },
  };
}

function buildTrackerSpreadsheetProtocol(rootDir: string, brief: any): any {
  const outline = buildSpreadsheetNarrativeOutline(rootDir, brief);
  const { preset } = resolveDocumentCompositionPreset(rootDir, brief);
  const semanticCatalog = loadSemanticRenderTokenCatalog(rootDir);
  const { template } = resolveDocumentLayoutTemplate(rootDir, {
    document_type: 'tracker',
    layout_template_id: brief.layout_template_id,
  });
  const activeTheme = resolveNamedTheme(rootDir, preset?.recommended_theme);
  const colors = {
    ...(template?.colors || {}),
    ...(activeTheme?.colors || {}),
  };
  const layout = template?.layout || {};
  const toneCatalog = template?.tones?.states || {};
  const validationDefaults = template?.validation_defaults || {};
  const conditionalDefaults = template?.conditional_format_defaults || {};
  const title = brief.payload.title || 'Tracker';
  const subtitle = brief.payload.subtitle || '';
  const summaryCards = Array.isArray(brief.payload.summary_cards) ? brief.payload.summary_cards : [];
  const columns = Array.isArray(brief.payload.columns) ? brief.payload.columns : [];
  const rows = Array.isArray(brief.payload.rows) ? brief.payload.rows : [];
  const headers = columns.map((column: any) => String(column.label || column.key || 'Column'));
  const widths = columns.map((column: any) => Number(column.width || layout.default_column_width || 18));
  const lastColumnLetter = String.fromCharCode(64 + Math.max(headers.length, 1));
  const summaryRowIndex = summaryCards.length > 0 ? 3 : 0;
  const headerRowIndex = summaryCards.length > 0 ? 4 : 3;
  const dataStartIndex = headerRowIndex + 1;
  const rowToneKey = typeof brief.payload.row_tone_key === 'string' ? brief.payload.row_tone_key : '';
  const rowTones = brief.payload.row_tones && typeof brief.payload.row_tones === 'object'
    ? brief.payload.row_tones
    : {};
  const boardSection = Array.isArray(outline.toc)
    ? outline.toc.find((entry: any) => entry.section_id === 'execution-board')
    : null;
  const overviewSection = Array.isArray(outline.toc)
    ? outline.toc.find((entry: any) => entry.section_id === 'overview')
    : null;
  const signalsSection = Array.isArray(outline.toc)
    ? outline.toc.find((entry: any) => entry.section_id === 'signals')
    : null;

  const styleMap = {
    base: 0,
    title: 1,
    subtitle: 2,
    header: 3,
    section: 4,
    info: 5,
    success: 6,
    warning: 7,
    danger: 8,
    body: 9,
  } as const;

  const toneToStyle = (tone?: string) => {
    switch (tone) {
      case 'success': return styleMap.success;
      case 'warning': return styleMap.warning;
      case 'danger': return styleMap.danger;
      case 'info': return styleMap.info;
      default: return styleMap.info;
    }
  };

  const sheetRows: any[] = [
    {
      index: 1,
      height: layout.title_row_height || 30,
      customHeight: true,
      cells: [{ ref: 'A1', type: 's', value: title, styleIndex: styleMap.title }],
    },
  ];

  if (subtitle) {
    sheetRows.push({
      index: 2,
      height: layout.subtitle_row_height || 20,
      customHeight: true,
      cells: [{ ref: 'A2', type: 's', value: subtitle, styleIndex: styleMap.subtitle }],
    });
  }

  if (summaryCards.length > 0) {
    const cells: any[] = [];
    summaryCards.forEach((card: any, index: number) => {
      const colOffset = index * 2;
      const cellRef = `${String.fromCharCode(65 + colOffset)}3`;
      cells.push({
        ref: cellRef,
        type: 's',
        value: `${card.label} ${card.value}`,
        styleIndex: toneToStyle(card.tone),
      });
    });
    sheetRows.push({ index: 3, height: layout.summary_row_height || 20, customHeight: true, cells });
  }

  sheetRows.push({
    index: headerRowIndex,
    height: layout.header_row_height || 22,
    customHeight: true,
    cells: headers.map((label, index) => ({
      ref: `${String.fromCharCode(65 + index)}${headerRowIndex}`,
      type: 's',
      value: label,
      styleIndex: styleMap.header,
    })),
  });

  rows.forEach((row: any, rowIndex: number) => {
    const excelRow = dataStartIndex + rowIndex;
    const rowToneValue = rowToneKey ? String(row[rowToneKey] ?? '') : '';
    const resolvedTone = rowToneValue && rowTones[rowToneValue]
      ? String(rowTones[rowToneValue])
      : '';
    const styleIndex = resolvedTone
      ? toneToStyle(resolvedTone)
      : (layout.banded_rows === false ? styleMap.base : (rowIndex % 2 === 0 ? styleMap.body : styleMap.base));
    sheetRows.push({
      index: excelRow,
      height: layout.data_row_height || 20,
      customHeight: Boolean(layout.data_row_height),
      cells: columns.map((column: any, columnIndex: number) => ({
        ref: `${String.fromCharCode(65 + columnIndex)}${excelRow}`,
        type: 's',
        value: String(row[column.key] ?? ''),
        styleIndex,
      })),
    });
  });

  const dataValidations = columns
    .map((column: any, index: number) => {
      const validationKey = String(column.validation_key || column.key || '');
      const validation = column.validation || validationDefaults[validationKey];
      if (!validation || validation.type !== 'list' || !Array.isArray(validation.values) || validation.values.length === 0) {
        return null;
      }
      const colLetter = String.fromCharCode(65 + index);
      return {
        sqref: `${colLetter}${dataStartIndex}:${colLetter}${Math.max(dataStartIndex + rows.length - 1, dataStartIndex)}`,
        type: 'list',
        formula1: `"${validation.values.join(',')}"`,
        showErrorMessage: true,
        errorTitle: validation.errorTitle || `Invalid ${headers[index] || validationKey}`,
        error: validation.error || `Use one of: ${validation.values.join(', ')}`,
      };
    })
    .filter(Boolean);

  const dxfs: any[] = [];
  const conditionalFormats: any[] = [];
  const conditionalStatus = conditionalDefaults[rowToneKey] || conditionalDefaults.status;
  if (rowToneKey && conditionalStatus?.tones && rows.length > 0) {
    const toneEntries = Object.entries(conditionalStatus.tones as Record<string, string>);
    const keyColumnIndex = columns.findIndex((column: any) => String(column.key) === String(conditionalStatus.key_column || rowToneKey));
    const keyColumnLetter = keyColumnIndex >= 0 ? String.fromCharCode(65 + keyColumnIndex) : '';
    if (keyColumnLetter) {
      const startDxfIndex = dxfs.length;
      for (const [, toneName] of toneEntries) {
        if (toneName === 'success') {
          dxfs.push({
            font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#166534' } },
            fill: { patternType: 'solid', fgColor: { rgb: colors.success || '#DCFCE7' }, bgColor: { rgb: colors.success || '#DCFCE7' } },
          });
        } else if (toneName === 'warning') {
          dxfs.push({
            font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#92400E' } },
            fill: { patternType: 'solid', fgColor: { rgb: colors.warning || '#FEF3C7' }, bgColor: { rgb: colors.warning || '#FEF3C7' } },
          });
        } else if (toneName === 'danger') {
          dxfs.push({
            font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#991B1B' } },
            fill: { patternType: 'solid', fgColor: { rgb: colors.danger || '#FEE2E2' }, bgColor: { rgb: colors.danger || '#FEE2E2' } },
          });
        } else {
          dxfs.push({
            font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#111827' } },
            fill: { patternType: 'solid', fgColor: { rgb: colors.info || '#DBEAFE' }, bgColor: { rgb: colors.info || '#DBEAFE' } },
          });
        }
      }
      conditionalFormats.push({
        sqref: `A${dataStartIndex}:${lastColumnLetter}${Math.max(dataStartIndex + rows.length - 1, dataStartIndex)}`,
        rules: toneEntries.map(([matchValue], offset) => ({
          type: 'expression',
          priority: offset + 1,
          dxfId: startDxfIndex + offset,
          formula: `$${keyColumnLetter}${dataStartIndex}=\"${matchValue}\"`,
        })),
      });
    }
  }

  const overdueRule = conditionalDefaults.overdue_finish;
  if (overdueRule && rows.length > 0) {
    const dueColumnIndex = columns.findIndex((column: any) => String(column.key) === String(overdueRule.key_column || 'finish'));
    const statusColumnIndex = columns.findIndex((column: any) => String(column.key) === String(overdueRule.status_column || rowToneKey || 'status'));
    if (dueColumnIndex >= 0 && statusColumnIndex >= 0) {
      const dueLetter = String.fromCharCode(65 + dueColumnIndex);
      const statusLetter = String.fromCharCode(65 + statusColumnIndex);
      const doneValues = Array.isArray(overdueRule.done_values) ? overdueRule.done_values : ['Done'];
      const doneExpr = doneValues.map((value: string) => `$${statusLetter}${dataStartIndex}=\"${value}\"`).join(',');
      const overdueDxfId = dxfs.length;
      dxfs.push({
        font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#7F1D1D' } },
        fill: { patternType: 'solid', fgColor: { rgb: '#FECACA' }, bgColor: { rgb: '#FECACA' } },
      });
      conditionalFormats.push({
        sqref: `A${dataStartIndex}:${lastColumnLetter}${Math.max(dataStartIndex + rows.length - 1, dataStartIndex)}`,
        rules: [{
          type: 'expression',
          priority: conditionalFormats.reduce((count, item) => count + item.rules.length, 0) + 1,
          dxfId: overdueDxfId,
          formula: `AND(DATEVALUE($${dueLetter}${dataStartIndex})<TODAY(),NOT(OR(${doneExpr})))`,
        }],
      });
    }
  }

  const defaultTone = String(template?.tones?.default || 'info');
  const infoTextColor = String(toneCatalog.info?.text_color || '#111827');
  const successTextColor = String(toneCatalog.success?.text_color || '#166534');
  const warningTextColor = String(toneCatalog.warning?.text_color || '#92400E');
  const dangerTextColor = String(toneCatalog.danger?.text_color || '#991B1B');
  const summaryLastColumnLetter = String.fromCharCode(64 + Math.max(summaryCards.length, 1));
  const overviewRows: any[] = [
    {
      index: 1,
      height: layout.title_row_height || 30,
      customHeight: true,
      cells: [{ ref: 'A1', type: 's', value: overviewSection?.title || 'Overview', styleIndex: styleMap.title }],
    },
  ];
  if (summaryCards.length > 0) {
    summaryCards.forEach((card: any, index: number) => {
      const rowIndex = index + 3;
      overviewRows.push({
        index: rowIndex,
        height: layout.summary_row_height || 20,
        customHeight: true,
        cells: [
          { ref: `A${rowIndex}`, type: 's', value: String(card.label || 'Metric'), styleIndex: styleMap.header },
          { ref: `B${rowIndex}`, type: 's', value: String(card.value || ''), styleIndex: toneToStyle(card.tone) },
        ],
      });
    });
  } else {
    overviewRows.push({
      index: 3,
      height: layout.summary_row_height || 20,
      customHeight: true,
      cells: [{ ref: 'A3', type: 's', value: 'No summary cards provided.', styleIndex: styleMap.body }],
    });
  }
  const signalRowsSource = rows.filter((row: any) => {
    const tone = rowToneKey ? String(row[rowToneKey] ?? '') : '';
    const status = String(row.status ?? '');
    return ['warning', 'danger'].includes(String(rowTones[tone] || tone).toLowerCase()) || /risk|blocked|late|issue/i.test(status);
  });
  const explicitSignalEntries = [
    ...(Array.isArray(brief.payload.signals) ? brief.payload.signals.map((entry: any) => ({ ...entry, signalType: 'signal' })) : []),
    ...(Array.isArray(brief.payload.risks) ? brief.payload.risks.map((entry: any) => ({ ...entry, signalType: 'risk' })) : []),
    ...(Array.isArray(brief.payload.incidents) ? brief.payload.incidents.map((entry: any) => ({ ...entry, signalType: 'incident' })) : []),
    ...(Array.isArray(brief.payload.controls) ? brief.payload.controls.map((entry: any) => ({ ...entry, signalType: 'control' })) : []),
  ];
  const normalizedSignalEntries = explicitSignalEntries.map((entry: any) => ({
    task: String(entry.title || entry.name || entry.control || entry.risk || entry.incident || entry.summary || 'Signal'),
    owner: String(entry.owner || entry.assignee || entry.team || entry.function || ''),
    status: String(entry.status || entry.severity || entry.tone || entry.state || entry.signalType || ''),
    tone: String(entry.tone || entry.severity || (entry.signalType === 'risk' ? 'warning' : entry.signalType === 'incident' ? 'danger' : 'info')),
  }));
  const signalRows: any[] = [
    {
      index: 1,
      height: layout.title_row_height || 30,
      customHeight: true,
      cells: [{ ref: 'A1', type: 's', value: signalsSection?.title || 'Signals and Risks', styleIndex: styleMap.title }],
    },
    {
      index: 3,
      height: layout.header_row_height || 22,
      customHeight: true,
      cells: [
        { ref: 'A3', type: 's', value: 'Task', styleIndex: styleMap.header },
        { ref: 'B3', type: 's', value: 'Owner', styleIndex: styleMap.header },
        { ref: 'C3', type: 's', value: 'Status', styleIndex: styleMap.header },
      ],
    },
  ];
  const combinedSignalEntries = [
    ...normalizedSignalEntries,
    ...signalRowsSource.map((row: any) => {
      const tone = rowToneKey ? String(row[rowToneKey] ?? '') : '';
      const resolvedTone = tone && rowTones[tone] ? String(rowTones[tone]) : tone;
      return {
        task: String(row.task ?? row.title ?? ''),
        owner: String(row.owner ?? ''),
        status: String(row.status ?? ''),
        tone: resolvedTone || 'warning',
      };
    }),
  ].sort((left, right) => {
    const signalTones = semanticCatalog.signal_tones || {};
    const leftRank = signalTones[String(left.tone || '').toLowerCase()] ?? rankSignalTone(left.tone);
    const rightRank = signalTones[String(right.tone || '').toLowerCase()] ?? rankSignalTone(right.tone);
    const toneDelta = leftRank - rightRank;
    if (toneDelta !== 0) return toneDelta;
    return String(left.task || '').localeCompare(String(right.task || ''));
  });
  if (combinedSignalEntries.length === 0) {
    signalRows.push({
      index: 4,
      height: layout.data_row_height || 20,
      customHeight: Boolean(layout.data_row_height),
      cells: [{ ref: 'A4', type: 's', value: 'No elevated signals detected.', styleIndex: styleMap.body }],
    });
  } else {
    combinedSignalEntries.forEach((row: any, index: number) => {
      signalRows.push({
        index: 4 + index,
        height: layout.data_row_height || 20,
        customHeight: Boolean(layout.data_row_height),
        cells: [
          { ref: `A${4 + index}`, type: 's', value: String(row.task ?? row.title ?? ''), styleIndex: toneToStyle(String(row.tone || 'info')) },
          { ref: `B${4 + index}`, type: 's', value: String(row.owner ?? ''), styleIndex: toneToStyle(String(row.tone || 'info')) },
          { ref: `C${4 + index}`, type: 's', value: String(row.status ?? ''), styleIndex: toneToStyle(String(row.tone || 'info')) },
        ],
      });
    });
  }

  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    theme: {
      name: 'Tracker Theme',
      colors: {
        dk1: String(colors.primary || '#0F172A').replace('#', ''),
        lt1: String(colors.background || '#FFFFFF').replace('#', ''),
        dk2: String(colors.secondary || '#334155').replace('#', ''),
        lt2: String(colors.muted || '#F8FAFC').replace('#', ''),
        accent1: String(colors.accent || '#2563EB').replace('#', ''),
        accent2: String(colors.secondary || '#334155').replace('#', ''),
        accent3: '7C3AED',
        accent4: 'EA580C',
        accent5: 'DC2626',
        accent6: '65A30D',
      },
      majorFont: template?.fonts?.heading || 'Aptos',
      minorFont: template?.fonts?.body || 'Aptos',
    },
    styles: {
      fonts: [
        { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: colors.text || '#111827' } },
        { name: template?.fonts?.heading || 'Aptos', size: 22, bold: true, color: { rgb: '#FFFFFF' } },
        { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: '#E2E8F0' } },
      ],
      fills: [
        { patternType: 'none' },
        { patternType: 'gray125' },
        { patternType: 'solid', fgColor: { rgb: colors.primary || '#0F172A' } },
        { patternType: 'solid', fgColor: { rgb: colors.info || '#DBEAFE' } },
        { patternType: 'solid', fgColor: { rgb: colors.success || '#DCFCE7' } },
        { patternType: 'solid', fgColor: { rgb: colors.warning || '#FEF3C7' } },
        { patternType: 'solid', fgColor: { rgb: colors.danger || '#FEE2E2' } },
        { patternType: 'solid', fgColor: { rgb: colors.muted || '#F8FAFC' } },
      ],
      borders: [
        {},
        {
          left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } },
          right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } },
          top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } },
          bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } },
        },
      ],
      numFmts: [],
      cellXfs: [
        { font: { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: colors.text || '#111827' } }, fill: { patternType: 'none' }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } } },
        { font: { name: template?.fonts?.heading || 'Aptos', size: 22, bold: true, color: { rgb: '#FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.primary || '#0F172A' } }, border: {}, alignment: { horizontal: 'left', vertical: 'center' } },
        { font: { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: '#E2E8F0' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.primary || '#0F172A' } }, border: {}, alignment: { horizontal: 'left', vertical: 'center' } },
        { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.primary || '#0F172A' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { horizontal: 'center', vertical: 'center' } },
        { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: infoTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.info?.fill || defaultTone)] || colors.info || '#DBEAFE' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
        { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: infoTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.info?.fill || defaultTone)] || colors.info || '#DBEAFE' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
        { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: successTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.success?.fill || 'success')] || colors.success || '#DCFCE7' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
        { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: warningTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.warning?.fill || 'warning')] || colors.warning || '#FEF3C7' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
        { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: dangerTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.danger?.fill || 'danger')] || colors.danger || '#FEE2E2' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
        { font: { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: colors.secondary || '#334155' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.muted || '#F8FAFC' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
      ],
      namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0 }],
      dxfs,
    },
    sharedStrings: [],
    sharedStringsRich: [],
    definedNames: [],
    workbookProperties: { defaultThemeVersion: 164011 },
    metadata: {
      title,
      subject: brief.document_profile || 'operator-tracker',
      composition: outline,
      generationBoundary: outline.generation_boundary || buildMediaGenerationBoundary(outline),
      recommendedTheme: preset?.recommended_theme || 'kyberion-standard',
      branding: preset?.branding || {},
      sheetRoles: [
        { role: 'overview', title: overviewSection?.title || 'Overview' },
        { role: 'execution-board', title: boardSection?.title || 'Execution Board' },
        { role: 'signals', title: signalsSection?.title || 'Signals and Risks' },
      ],
      sheetSemantics: [
        {
          role: 'overview',
          layout_key: overviewSection?.layout_key || 'sheet-overview',
          media_kind: overviewSection?.media_kind || 'dashboard',
          semantic_type: classifyRenderSemantic(overviewSection?.layout_key || 'sheet-overview', overviewSection?.media_kind || 'dashboard'),
        },
        {
          role: 'execution-board',
          layout_key: boardSection?.layout_key || 'sheet-main-table',
          media_kind: boardSection?.media_kind || 'table',
          semantic_type: classifyRenderSemantic(boardSection?.layout_key || 'sheet-main-table', boardSection?.media_kind || 'table'),
        },
        {
          role: 'signals',
          layout_key: signalsSection?.layout_key || 'sheet-signals',
          media_kind: signalsSection?.media_kind || 'signals',
          semantic_type: classifyRenderSemantic(signalsSection?.layout_key || 'sheet-signals', signalsSection?.media_kind || 'signals'),
        },
      ],
    },
    sheets: [
      {
        id: 'sheet-overview',
        name: overviewSection?.title || 'Overview',
        dimension: `A1:B${Math.max(overviewRows.length, 1)}`,
        sheetView: { showGridLines: false, zoomScale: layout.zoom_scale || 95, frozenRows: 1 },
        columns: [
          { min: 1, max: 1, width: 28, customWidth: true },
          { min: 2, max: 2, width: 18, customWidth: true },
        ],
        rows: overviewRows,
        mergeCells: [{ ref: `A1:${summaryLastColumnLetter === 'A' ? 'B' : summaryLastColumnLetter}1` }],
        tables: [],
        conditionalFormats: [],
        dataValidations: [],
        pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
      },
      {
        id: 'sheet1',
        name: brief.payload.sheet_name || boardSection?.title || 'Tracker',
        dimension: `A1:${lastColumnLetter}${Math.max(sheetRows.length, 1)}`,
        sheetView: { showGridLines: false, zoomScale: layout.zoom_scale || 95, frozenRows: layout.freeze_header === false ? 0 : headerRowIndex },
        columns: widths.map((width: number, index: number) => ({ min: index + 1, max: index + 1, width, customWidth: true })),
        rows: sheetRows,
        mergeCells: subtitle ? [{ ref: `A1:${lastColumnLetter}1` }, { ref: `A2:${lastColumnLetter}2` }] : [{ ref: `A1:${lastColumnLetter}1` }],
        tables: [],
        conditionalFormats,
        dataValidations,
        autoFilter: { ref: `A${headerRowIndex}:${lastColumnLetter}${Math.max(dataStartIndex + rows.length - 1, headerRowIndex)}` },
        pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
      },
      {
        id: 'sheet-signals',
        name: signalsSection?.title || 'Signals and Risks',
        dimension: `A1:C${Math.max(signalRows.length, 1)}`,
        sheetView: { showGridLines: false, zoomScale: layout.zoom_scale || 95, frozenRows: 3 },
        columns: [
          { min: 1, max: 1, width: 32, customWidth: true },
          { min: 2, max: 2, width: 18, customWidth: true },
          { min: 3, max: 3, width: 18, customWidth: true },
        ],
        rows: signalRows,
        mergeCells: [{ ref: 'A1:C1' }],
        tables: [],
        conditionalFormats: [],
        dataValidations: [],
        pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
      },
    ],
  };
}

function resolveDocumentLayoutTemplate(rootDir: string, brief: any): { templateId: string; template: any } {
  const catalogPath = path.resolve(rootDir, 'knowledge/public/design-patterns/media-templates/document-layouts.json');
  if (!safeExistsSync(catalogPath)) {
    throw new Error(`Document layout catalog not found: ${catalogPath}`);
  }

  const catalog = JSON.parse(safeReadFile(catalogPath, { encoding: 'utf8' }) as string);
  const documentType = brief.document_type || 'invoice';
  const documentCatalog = catalog.documents?.[documentType];
  if (!documentCatalog) {
    throw new Error(`Document layout family not found: ${documentType}`);
  }

  const templateId = brief.layout_template_id || documentCatalog.default_template;
  const template = documentCatalog.templates?.[templateId];
  if (!template) {
    throw new Error(`Document layout template not found: ${templateId}`);
  }

  return { templateId, template };
}

function buildDocumentPdfProtocol(rawBrief: any): any {
  const brief = normalizeInvoiceDocumentBrief(rawBrief);
  if (brief.document_type !== 'invoice') {
    throw new Error(`Unsupported document_type for document_pdf_from_brief: ${brief.document_type}`);
  }
  if (brief.render_target && brief.render_target !== 'pdf') {
    throw new Error(`Unsupported render_target for document_pdf_from_brief: ${brief.render_target}`);
  }
  if (brief.document_profile !== 'qualified-invoice') {
    throw new Error(`Unsupported invoice document_profile: ${brief.document_profile}`);
  }

  const items = Array.isArray(brief.items) ? brief.items : [];
  if (items.length === 0) {
    throw new Error('document_pdf_from_brief requires at least one invoice item.');
  }

  const grouped = new Map<number, { taxableAmount: number; taxAmount: number }>();
  const roundingMode = typeof brief.tax_rounding === 'string' ? brief.tax_rounding : 'round';
  let subtotal = 0;

  const itemLines = items.map((item: any, index: number) => {
    const quantity = Number(item.quantity || 0);
    const unitPrice = Number(item.unit_price_ex_tax || 0);
    const rate = Number(item.tax_rate || 0);
    const lineSubtotal = quantity * unitPrice;
    subtotal += lineSubtotal;

    const current = grouped.get(rate) || { taxableAmount: 0, taxAmount: 0 };
    current.taxableAmount += lineSubtotal;
    grouped.set(rate, current);

    const annotations = [
      item.unit ? `${quantity}${item.unit}` : `${quantity}`,
      `単価 ${formatJpy(unitPrice)}`,
      `税率 ${rate}%`,
      item.reduced_tax_rate ? '※軽減税率対象' : '',
      item.service_period ? `対象期間: ${item.service_period}` : '',
      item.transaction_note || '',
    ].filter(Boolean);

    return `${index + 1}. ${item.description}\n   ${annotations.join(' / ')}\n   金額(税抜): ${formatJpy(lineSubtotal)}`;
  });

  let totalTax = 0;
  const taxSummaryLines = Array.from(grouped.entries())
    .sort((a, b) => a[0] - b[0])
    .map(([rate, summary]) => {
      summary.taxAmount = applyRounding(summary.taxableAmount * (rate / 100), roundingMode);
      totalTax += summary.taxAmount;
      return `- ${rate}%対象: ${formatJpy(summary.taxableAmount)} / 税額: ${formatJpy(summary.taxAmount)}`;
    });

  const totalAmount = subtotal + totalTax;
  const issuerLines = [
    brief.issuer?.name,
    brief.issuer?.registration_number ? `登録番号: ${brief.issuer.registration_number}` : '',
    brief.issuer?.postal_code ? `郵便番号: ${brief.issuer.postal_code}` : '',
    brief.issuer?.address || '',
    brief.issuer?.contact ? `担当: ${brief.issuer.contact}` : '',
    brief.issuer?.phone ? `電話: ${brief.issuer.phone}` : '',
    brief.issuer?.email ? `メール: ${brief.issuer.email}` : '',
  ].filter(Boolean);

  const recipientLines = [
    brief.recipient?.name,
    brief.recipient?.department ? brief.recipient.department : '',
    brief.recipient?.contact ? `担当: ${brief.recipient.contact}` : '',
    brief.recipient?.address || '',
  ].filter(Boolean);

  const paymentLines = brief.payment ? [
    brief.payment.method ? `支払方法: ${brief.payment.method}` : '',
    brief.payment.bank_name ? `銀行名: ${brief.payment.bank_name}` : '',
    brief.payment.branch_name ? `支店名: ${brief.payment.branch_name}` : '',
    brief.payment.account_type ? `口座種別: ${brief.payment.account_type}` : '',
    brief.payment.account_number ? `口座番号: ${brief.payment.account_number}` : '',
    brief.payment.account_name ? `口座名義: ${brief.payment.account_name}` : '',
    brief.payment.transfer_fee_policy || '',
  ].filter(Boolean) : [];

  const noteLines = Array.isArray(brief.notes) ? brief.notes.filter(Boolean) : [];
  const { templateId, template } = resolveDocumentLayoutTemplate(process.cwd(), brief);
  const pageWidth = Number(template.page?.width || 595);
  const pageHeight = Number(template.page?.height || 842);
  const left = Number(template.page?.left || 48);
  const right = Number(template.page?.right || 547);
  const accent = (template.colors?.accent || [0.15, 0.29, 0.45]) as [number, number, number];
  const light = (template.colors?.light || [0.94, 0.96, 0.98]) as [number, number, number];
  const border = (template.colors?.border || [0.74, 0.79, 0.84]) as [number, number, number];
  const labels = template.labels || {};
  const recipientBlock = template.blocks?.recipient || {};
  const issuerBlock = template.blocks?.issuer || {};
  const amountBlock = template.blocks?.amount || {};
  const tableBlock = template.blocks?.table || {};
  const taxSummaryBlock = template.blocks?.tax_summary || {};
  const paymentBlock = template.blocks?.payment || {};
  const notesBlock = template.blocks?.notes || {};
  const elements: Array<{ type: 'text'; x: number; y: number; text: string; fontSize?: number }> = [];
  const vectors: any[] = [];

  const pushText = (x: number, y: number, text: string, fontSize = 10) => {
    elements.push({ type: 'text', x, y, text, fontSize });
  };
  const wrapLines = (text: string, maxUnits: number): string[] => {
    if (!text) return [];
    const lines: string[] = [];
    let current = '';
    let units = 0;
    for (const ch of text) {
      const next = ch.charCodeAt(0) > 127 ? 1 : 0.55;
      if (current && units + next > maxUnits) {
        lines.push(current);
        current = ch;
        units = next;
      } else {
        current += ch;
        units += next;
      }
    }
    if (current) lines.push(current);
    return lines;
  };
  const pushWrappedLines = (x: number, startY: number, lines: string[], fontSize: number, maxUnits: number, lineHeight = 14) => {
    let y = startY;
    for (const line of lines) {
      for (const wrapped of wrapLines(line, maxUnits)) {
        pushText(x, y, wrapped, fontSize);
        y += lineHeight;
      }
    }
    return y;
  };
  const pushSectionBand = (x: number, y: number, width: number, label: string) => {
    vectors.push({
      shape: { kind: 'rect', x, y, width, height: 18 },
      fillColor: light,
    });
    pushText(x + 6, y + 13, label, 10);
  };

  pushText(left, 42, labels.title || '請求書', 22);
  pushText(390, 42, `${labels.invoice_number || '請求書番号'}: ${brief.invoice_number}`, 10);
  pushText(390, 58, `${labels.issue_date || '発行日'}: ${brief.issue_date}`, 10);
  pushText(390, 74, `${labels.transaction_date || '取引日'}: ${brief.transaction_date}`, 10);
  if (brief.due_date) pushText(390, 90, `${labels.due_date || '支払期日'}: ${brief.due_date}`, 10);
  if (brief.subject) pushText(left, 78, `${labels.subject || '件名'}: ${brief.subject}`, 11);

  const recipientX = Number(recipientBlock.x || left);
  const recipientY = Number(recipientBlock.y || 110);
  const recipientWidth = Number(recipientBlock.width || 235);
  const recipientHeight = Number(recipientBlock.height || 104);
  const issuerX = Number(issuerBlock.x || 312);
  const issuerY = Number(issuerBlock.y || 110);
  const issuerWidth = Number(issuerBlock.width || 235);
  const issuerHeight = Number(issuerBlock.height || 122);

  vectors.push({ shape: { kind: 'rect', x: recipientX, y: recipientY, width: recipientWidth, height: recipientHeight }, strokeColor: border, lineWidth: 0.8 });
  vectors.push({ shape: { kind: 'rect', x: issuerX, y: issuerY, width: issuerWidth, height: issuerHeight }, strokeColor: border, lineWidth: 0.8 });
  pushSectionBand(recipientX, recipientY, recipientWidth, labels.recipient || '請求先');
  pushSectionBand(issuerX, issuerY, issuerWidth, labels.issuer || '発行者');
  pushWrappedLines(recipientX + 8, recipientY + 26, recipientLines.slice(0, 1), Number(recipientBlock.name_font_size || 11), Number(recipientBlock.name_max_units || 18), Number(recipientBlock.name_line_height || 15));
  pushWrappedLines(recipientX + 8, recipientY + 43, recipientLines.slice(1), Number(recipientBlock.body_font_size || 10), Number(recipientBlock.body_max_units || 20), Number(recipientBlock.body_line_height || 14));
  pushWrappedLines(issuerX + 8, issuerY + 26, issuerLines.slice(0, 1), Number(issuerBlock.name_font_size || 11), Number(issuerBlock.name_max_units || 17), Number(issuerBlock.name_line_height || 15));
  pushWrappedLines(issuerX + 8, issuerY + 43, issuerLines.slice(1, 1 + Number(issuerBlock.body_line_limit || 4)), Number(issuerBlock.body_font_size || 9), Number(issuerBlock.body_max_units || 21), Number(issuerBlock.body_line_height || 13));

  const tableWidth = right - left;

  vectors.push({
    shape: {
      kind: 'rect',
      x: Number(amountBlock.x || left),
      y: Number(amountBlock.y || 246),
      width: Number(amountBlock.width || tableWidth),
      height: Number(amountBlock.height || 48),
    },
    fillColor: light,
    strokeColor: border,
    lineWidth: 0.8,
  });
  pushText(Number(amountBlock.label_x || left + 8), Number(amountBlock.label_y || 264), labels.amount_due || '御請求金額（税込）', Number(amountBlock.label_font_size || 12));
  pushText(Number(amountBlock.value_x || 380), Number(amountBlock.value_y || 266), formatJpy(totalAmount), Number(amountBlock.value_font_size || 18));

  const tableTop = Number(tableBlock.top || 314);
  const rowHeight = Number(tableBlock.row_height || 22);
  const descX = Number(tableBlock.description_x || left);
  const qtyX = Number(tableBlock.quantity_x || 328);
  const unitPriceX = Number(tableBlock.unit_price_x || 378);
  const taxRateX = Number(tableBlock.tax_rate_x || 450);
  const amountX = Number(tableBlock.amount_x || 494);
  const tableRows = items.length + 1;

  vectors.push({ shape: { kind: 'rect', x: left, y: tableTop, width: tableWidth, height: rowHeight }, fillColor: accent });
  [
    [labels.table_description || '内容', descX + 6],
    [labels.table_quantity || '数量', qtyX + 6],
    [labels.table_unit_price || '単価(税抜)', unitPriceX + 6],
    [labels.table_tax_rate || '税率', taxRateX + 6],
    [labels.table_amount || '金額(税抜)', amountX + 6],
  ].forEach(([label, x]) => pushText(Number(x), tableTop + 15, String(label), Number(tableBlock.header_font_size || 10)));
  vectors.push({
    shape: { kind: 'rect', x: left, y: tableTop, width: tableWidth, height: rowHeight * (tableRows + 1) },
    strokeColor: border,
    lineWidth: 0.8,
  });
  [qtyX, unitPriceX, taxRateX, amountX].forEach((x) => {
    vectors.push({
      shape: { kind: 'line', x1: x, y1: tableTop, x2: x, y2: tableTop + rowHeight * (tableRows + 1) },
      strokeColor: border,
      lineWidth: 0.8,
    });
  });
  for (let row = 1; row <= tableRows; row++) {
    const y = tableTop + rowHeight * row;
    vectors.push({
      shape: { kind: 'line', x1: left, y1: y, x2: right, y2: y },
      strokeColor: border,
      lineWidth: 0.6,
    });
  }
  items.forEach((item: any, index: number) => {
    const y = tableTop + rowHeight * (index + 1) + 15;
    const quantity = Number(item.quantity || 0);
    const lineSubtotal = quantity * Number(item.unit_price_ex_tax || 0);
    const desc = `${item.description}${item.service_period ? ` (${item.service_period})` : ''}${item.reduced_tax_rate ? ' ※軽減税率' : ''}`;
    pushText(descX + 6, y, wrapLines(desc, Number(tableBlock.description_max_units || 28))[0] || desc, Number(tableBlock.body_font_size || 9));
    pushText(qtyX + 6, y, item.unit ? `${quantity}${item.unit}` : String(quantity), Number(tableBlock.body_font_size || 9));
    pushText(unitPriceX + 6, y, formatJpy(Number(item.unit_price_ex_tax || 0)), Number(tableBlock.body_font_size || 9));
    pushText(taxRateX + 6, y, `${item.tax_rate}%`, Number(tableBlock.body_font_size || 9));
    pushText(amountX + 6, y, formatJpy(lineSubtotal), Number(tableBlock.body_font_size || 9));
  });

  const summaryTop = tableTop + rowHeight * (tableRows + 1) + 20;
  const taxSummaryX = Number(taxSummaryBlock.x || left);
  const taxSummaryWidth = Number(taxSummaryBlock.width || 240);
  const taxSummaryHeight = Number(taxSummaryBlock.height || 82);
  const paymentX = Number(paymentBlock.x || 312);
  const paymentWidth = Number(paymentBlock.width || 235);
  const paymentHeight = Number(paymentBlock.height || 120);

  pushSectionBand(taxSummaryX, summaryTop, taxSummaryWidth, labels.tax_summary || '税率別集計');
  vectors.push({ shape: { kind: 'rect', x: taxSummaryX, y: summaryTop, width: taxSummaryWidth, height: taxSummaryHeight }, strokeColor: border, lineWidth: 0.8 });
  taxSummaryLines.forEach((line, index) => pushText(taxSummaryX + 8, summaryTop + 24 + index * 15, line, 9));
  pushText(taxSummaryX + 8, summaryTop + 58, `小計(税抜): ${formatJpy(subtotal)}`, 10);
  pushText(taxSummaryX + 8, summaryTop + 73, `消費税額計: ${formatJpy(totalTax)}`, 10);

  pushSectionBand(paymentX, summaryTop, paymentWidth, labels.payment || 'お支払い情報');
  vectors.push({ shape: { kind: 'rect', x: paymentX, y: summaryTop, width: paymentWidth, height: paymentHeight }, strokeColor: border, lineWidth: 0.8 });
  paymentLines.forEach((line, index) => pushText(paymentX + 8, summaryTop + 24 + index * 15, line, 9));

  const notesTop = summaryTop + Math.max(taxSummaryHeight, paymentHeight) + 20;
  pushSectionBand(left, notesTop, tableWidth, labels.notes || '備考');
  vectors.push({ shape: { kind: 'rect', x: left, y: notesTop, width: tableWidth, height: Number(notesBlock.height || 110) }, strokeColor: border, lineWidth: 0.8 });
  pushWrappedLines(left + 8, notesTop + 24, noteLines, Number(notesBlock.body_font_size || 9), Number(notesBlock.body_max_units || 48), Number(notesBlock.body_line_height || 14));
  pushText(left + 8, notesTop + 56, labels.invoice_requirements || '【適格請求書の主な記載事項】', 9);
  [
    '・発行事業者名および登録番号',
    '・取引年月日',
    '・取引内容（軽減税率対象である旨を含む）',
    '・税率ごとに区分した対価の額および適用税率',
    '・税率ごとに区分した消費税額等',
    '・書類の交付を受ける事業者の氏名又は名称',
  ].forEach((line, index) => pushText(left + 10, notesTop + 72 + index * 12, line, 8));

  const bodySections = [
    '請求書',
    '',
    `請求書番号: ${brief.invoice_number}`,
    `発行日: ${brief.issue_date}`,
    `取引日: ${brief.transaction_date}`,
    brief.due_date ? `支払期日: ${brief.due_date}` : '',
    brief.subject ? `件名: ${brief.subject}` : '',
    '',
    '請求元',
    ...issuerLines,
    '',
    '請求先',
    ...recipientLines,
    '',
    '明細',
    ...itemLines,
    '',
    '税率別集計',
    ...taxSummaryLines,
    '',
    `小計(税抜): ${formatJpy(subtotal)}`,
    `消費税額計: ${formatJpy(totalTax)}`,
    `合計請求額: ${formatJpy(totalAmount)}`,
    '',
    ...(paymentLines.length ? ['お支払い情報', ...paymentLines, ''] : []),
    ...(noteLines.length ? ['備考', ...noteLines, ''] : []),
    '【適格請求書の記載事項】',
    '- 適格請求書発行事業者名および登録番号',
    '- 取引年月日',
    '- 取引内容（軽減税率対象である旨を含む）',
    '- 税率ごとに区分した対価の額および適用税率',
    '- 税率ごとに区分した消費税額等',
    '- 書類の交付を受ける事業者の氏名又は名称',
  ].filter(Boolean);

  return {
    version: '1.0.0',
    generatedAt: new Date().toISOString(),
    source: {
      format: 'markdown',
      title: `請求書 ${brief.invoice_number}`,
      body: bodySections.join('\n'),
    },
    metadata: {
      title: `請求書 ${brief.invoice_number}`,
      subject: brief.subject || '日本向け請求書',
      author: brief.issuer?.name || 'Kyberion Media-Actuator',
      creationDate: new Date().toISOString(),
    },
    content: {
      text: bodySections.join('\n'),
      pages: [
        {
          pageNumber: 1,
          width: pageWidth,
          height: pageHeight,
          text: '',
          vectors,
        },
      ],
    },
    aesthetic: {
      layout: 'single-column',
      elements,
      colors: ['#264a73', '#f0f4f9', '#bfc9d6', '#1f2b3a'],
      fonts: ['HeiseiKakuGo-W5'],
      branding: {
        logoPresence: false,
        primaryColor: '#264a73',
        tone: 'professional',
      },
      templateId,
    },
    renderOptions: {
      compress: true,
      unicode: true,
      xmpMetadata: true,
      tagged: false,
      linearize: false,
      objectStreams: false,
    },
  };
}

function formatJpy(value: number): string {
  return new Intl.NumberFormat('ja-JP', {
    style: 'currency',
    currency: 'JPY',
    maximumFractionDigits: 0,
  }).format(Number.isFinite(value) ? value : 0);
}

function applyRounding(value: number, mode: string): number {
  switch (mode) {
    case 'floor':
      return Math.floor(value);
    case 'ceil':
      return Math.ceil(value);
    default:
      return Math.round(value);
  }
}

function resolveDiagramSource(rootDir: string, params: any, ctx: any, resolve: Function): string {
  const inlineSource = resolve(params.source);
  if (typeof inlineSource === 'string' && inlineSource.trim()) {
    return inlineSource;
  }

  if (params.from) {
    const ctxValue = ctx[params.from];
    if (typeof ctxValue === 'string' && ctxValue.trim()) {
      return ctxValue;
    }
  }

  if (params.input_path) {
    const inputPath = path.resolve(rootDir, resolve(params.input_path));
    return safeReadFile(inputPath, { encoding: 'utf8' }) as string;
  }

  throw new Error('Missing diagram source. Provide one of: params.source, params.from, params.input_path');
}

function resolveDiagramTheme(params: any, ctx: any, resolve: Function): any {
  if (params.theme && ctx.themes?.[params.theme]) {
    return ctx.themes[params.theme];
  }

  if (ctx.active_theme) {
    return ctx.active_theme;
  }

  return {
    colors: {
      primary: '#0f172a',
      secondary: '#334155',
      accent: '#38bdf8',
      background: '#ffffff',
      text: '#1e293b',
    },
    fonts: {
      heading: 'Inter, sans-serif',
      body: 'System-ui, sans-serif',
    },
  };
}

function buildMermaidConfig(theme: any, backgroundColor?: string): Record<string, any> {
  const colors = theme?.colors || {};
  const fonts = theme?.fonts || {};
  const textColor = colors.text || colors.secondary || '#1e293b';
  const primaryColor = colors.accent || '#38bdf8';
  const lineColor = colors.primary || '#0f172a';

  return {
    theme: 'base',
    look: 'classic',
    background: backgroundColor || colors.background || '#ffffff',
    themeVariables: {
      background: backgroundColor || colors.background || '#ffffff',
      primaryColor,
      primaryTextColor: textColor,
      primaryBorderColor: lineColor,
      lineColor,
      secondaryColor: colors.secondary || '#334155',
      tertiaryColor: colors.background || '#ffffff',
      mainBkg: colors.background || '#ffffff',
      textColor,
      fontFamily: fonts.body || fonts.heading || 'Arial, sans-serif',
    },
  };
}

function resolveGraphDefinition(rootDir: string, params: any, ctx: any, resolve: Function): any {
  if (params.from && ctx[params.from]) {
    return ctx[params.from];
  }

  const inlineGraph = resolve(params.graph);
  if (inlineGraph && typeof inlineGraph === 'object') {
    return inlineGraph;
  }

  if (params.input_path) {
    const inputPath = path.resolve(rootDir, resolve(params.input_path));
    return JSON.parse(safeReadFile(inputPath, { encoding: 'utf8' }) as string);
  }

  throw new Error('drawio_from_graph requires params.from, params.graph, or params.input_path');
}

function resolveDrawioIconMap(rootDir: string, params: any, resolve: Function): any {
  const mapPath = params.icon_map_path
    ? path.resolve(rootDir, resolve(params.icon_map_path))
    : path.resolve(rootDir, 'knowledge/public/design-patterns/media-templates/aws-drawio-icon-map.json');

  if (!safeExistsSync(mapPath)) {
    return { resources: {} };
  }

  return JSON.parse(safeReadFile(mapPath, { encoding: 'utf8' }) as string);
}

function loadFallbackDrawioTheme(rootDir: string, preferredTheme?: string): any {
  const themes = loadThemeCatalog(rootDir);
  if (!themes || typeof themes !== 'object' || !themes.themes) {
    return {
      colors: {
        primary: '#232f3e',
        secondary: '#4b5563',
        accent: '#ff9900',
        background: '#ffffff',
        text: '#111827',
      },
      fonts: {
        heading: 'Arial, sans-serif',
        body: 'Arial, sans-serif',
      },
    };
  }
  return themes.themes?.[preferredTheme || ''] || themes.themes?.['aws-architecture'] || themes.themes?.['kyberion-sovereign'] || themes.themes?.['kyberion-standard'];
}

function generateDrawioDocument(
  graph: any,
  options: {
    title: string;
    theme: any;
    iconMap: any;
    iconRoot?: string;
  },
): string {
  const nodes = Array.isArray(graph?.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph?.edges) ? graph.edges : [];
  const colors = options.theme?.colors || {};
  const fonts = options.theme?.fonts || {};
  const nodeMap = new Map<string, any>(nodes.map((node: any) => [node.id, node]));
  const childrenByParent = new Map<string, any[]>();
  const roots: any[] = [];
  const direction = graph?.render_hints?.direction || 'LR';

  for (const node of nodes) {
    const parentId = node.parent;
    if (parentId && nodeMap.has(parentId)) {
      const bucket = childrenByParent.get(parentId) || [];
      bucket.push(node);
      childrenByParent.set(parentId, bucket);
    } else {
      roots.push(node);
    }
  }

  const cellXml: string[] = ['<mxCell id="0"/>', '<mxCell id="1" parent="0"/>'];
  const geometry = new Map<string, { x: number; y: number; width: number; height: number }>();
  let cursorX = 40;
  let cursorY = 40;
  const groupOrder = ['edge', 'web', 'application', 'app', 'data', 'database', 'network', 'security', 'module', 'control', 'state'];
  const groupPriority = new Map(groupOrder.map((group, index) => [group, index]));

  const layoutNode = (node: any, depth: number, parentX: number, parentY: number): { width: number; height: number } => {
    const nodeChildren = childrenByParent.get(node.id) || [];
    const { width: preferredWidth, height: preferredHeight } = resolveDrawioNodeSize(node);
    const shouldTreatAsContainer = nodeChildren.length > 0 || node?.render_hints?.container === true || Boolean(node?.boundary && !node?.parent);
    if (!shouldTreatAsContainer) {
      const width = preferredWidth;
      const height = preferredHeight;
      const x = depth === 0 ? cursorX : parentX;
      const y = depth === 0 ? cursorY : parentY;
      geometry.set(node.id, { x, y, width, height });
      if (depth === 0) {
        if (direction === 'TB' || direction === 'BT') cursorY += height + 80;
        else cursorX += width + 80;
      }
      return { width, height };
    }

    const childContainers: any[] = [];
    const leafChildren: any[] = [];
    for (const child of nodeChildren) {
      const childHasChildren = (childrenByParent.get(child.id) || []).length > 0 || child?.render_hints?.container === true || Boolean(child?.boundary && !child?.parent);
      if (childHasChildren) childContainers.push(child);
      else leafChildren.push(child);
    }

      const groupedLeaves = new Map<string, any[]>();
      for (const child of leafChildren) {
      const group = typeof child?.render_hints?.semantic_tier === 'string' && child.render_hints.semantic_tier.trim()
        ? child.render_hints.semantic_tier.trim()
        : typeof child?.group === 'string' && child.group.trim()
          ? child.group.trim()
          : 'application';
      const bucket = groupedLeaves.get(group) || [];
      bucket.push(child);
      groupedLeaves.set(group, bucket);
    }

    const sortedGroups = [...groupedLeaves.keys()].sort((left, right) => {
      const leftRank = groupPriority.has(left) ? groupPriority.get(left)! : groupOrder.length;
      const rightRank = groupPriority.has(right) ? groupPriority.get(right)! : groupOrder.length;
      return leftRank === rightRank ? left.localeCompare(right) : leftRank - rightRank;
    });

    let innerY = parentY + 70;
    let maxBottom = parentY + 180;
    let maxRight = parentX + 260;
    const columnGap = 44;
    const rowGap = 24;
    const bucketHeaderHeight = 22;

    if (sortedGroups.length > 0) {
      let bucketX = parentX + 30;
      for (const group of sortedGroups) {
        const children = (groupedLeaves.get(group) || []).sort(compareDrawioLeafNodes);
        let bucketY = innerY + bucketHeaderHeight;
        let bucketMaxRight = bucketX;
        for (const child of children) {
          const childBox = layoutNode(child, depth + 1, bucketX, bucketY);
          const childGeo = geometry.get(child.id)!;
          bucketY += childBox.height + rowGap;
          bucketMaxRight = Math.max(bucketMaxRight, childGeo.x + childGeo.width);
          maxBottom = Math.max(maxBottom, childGeo.y + childGeo.height + 30);
          maxRight = Math.max(maxRight, childGeo.x + childGeo.width + 30);
        }
        bucketX = bucketMaxRight + columnGap;
      }
      innerY = maxBottom + 20;
    }

    if (childContainers.length > 0) {
      let containerX = parentX + 30;
      for (const child of childContainers.sort(compareDrawioNodesByTier)) {
        const childBox = layoutNode(child, depth + 1, containerX, innerY);
        const childGeo = geometry.get(child.id)!;
        containerX += childBox.width + 30;
        maxBottom = Math.max(maxBottom, childGeo.y + childGeo.height + 30);
        maxRight = Math.max(maxRight, childGeo.x + childGeo.width + 30);
      }
    }

    const width = Math.max(260, maxRight - parentX);
    const height = Math.max(180, maxBottom - parentY);
    const x = depth === 0 ? cursorX : parentX;
    const y = depth === 0 ? cursorY : parentY;
    geometry.set(node.id, { x, y, width, height });
    if (depth === 0) {
      if (direction === 'TB' || direction === 'BT') cursorY += height + 80;
      else cursorX += width + 80;
    }
    return { width, height };
  };

  for (const root of roots) {
    layoutNode(root, 0, cursorX, cursorY);
  }

  const sortedNodes = [...nodes].sort((left, right) => {
    const leftIsContainer = ((childrenByParent.get(left.id) || []).length > 0 || left?.render_hints?.container === true || Boolean(left?.boundary && !left?.parent)) ? 1 : 0;
    const rightIsContainer = ((childrenByParent.get(right.id) || []).length > 0 || right?.render_hints?.container === true || Boolean(right?.boundary && !right?.parent)) ? 1 : 0;
    if (leftIsContainer !== rightIsContainer) {
      return rightIsContainer - leftIsContainer;
    }
    const leftDepth = drawioNodeDepth(left, nodeMap);
    const rightDepth = drawioNodeDepth(right, nodeMap);
    return leftDepth === rightDepth ? left.id.localeCompare(right.id) : leftDepth - rightDepth;
  });

  for (const node of sortedNodes) {
    const geo = geometry.get(node.id) || { x: 40, y: 40, width: 160, height: 120 };
    const hasChildren = (childrenByParent.get(node.id) || []).length > 0 || node?.render_hints?.container === true || Boolean(node?.boundary && !node?.parent);
    const parentId = node.parent && nodeMap.has(node.parent) ? node.parent : '1';
    const parentGeo = parentId !== '1' ? geometry.get(parentId) : undefined;
    const relativeX = parentGeo ? Math.max(0, geo.x - parentGeo.x) : geo.x;
    const relativeY = parentGeo ? Math.max(0, geo.y - parentGeo.y) : geo.y;
    const style = buildDrawioNodeStyle(node, hasChildren, options, colors, fonts);
    const label = escapeXml(node.name || node.id);
    cellXml.push(
      `<mxCell id="${escapeXml(node.id)}" value="${label}" style="${escapeXml(style)}" vertex="1" parent="${escapeXml(parentId)}">` +
        `<mxGeometry x="${relativeX}" y="${relativeY}" width="${geo.width}" height="${geo.height}" as="geometry"/>` +
      `</mxCell>`,
    );
  }

  edges.forEach((edge: any, index: number) => {
    const sourceNode = nodeMap.get(edge.from);
    const targetNode = nodeMap.get(edge.to);
    const sourceTier = String(sourceNode?.render_hints?.semantic_tier || sourceNode?.group || '').toLowerCase();
    const targetTier = String(targetNode?.render_hints?.semantic_tier || targetNode?.group || '').toLowerCase();
    const styleParts = [
      'edgeStyle=orthogonalEdgeStyle',
      'rounded=1',
      'orthogonalLoop=1',
      'jettySize=auto',
      'html=1',
      `strokeColor=${colors.primary || '#232f3e'}`,
      `fontColor=${colors.text || '#111827'}`,
      `fontFamily=${normalizeFontFamily(fonts.body || fonts.heading || 'Arial')}`,
    ];
    if (edge.label === 'uses') {
      styleParts.push('dashed=1', 'strokeOpacity=55');
    }
    if (edge.label === 'source') {
      styleParts.push(
        'dashed=1',
        `strokeColor=${colors.accent || '#ff9900'}`,
        'strokeWidth=2',
        'endArrow=open',
        'endFill=0',
        'labelBackgroundColor=#FFF7ED',
      );
    }
    if (edge.label === 'expands') {
      styleParts.push(
        'dashed=1',
        'dashPattern=8 4',
        `strokeColor=${colors.secondary || '#4b5563'}`,
        'strokeWidth=2',
        'endArrow=block',
        'endFill=1',
        'labelBackgroundColor=#EFF6FF',
      );
    }
    const horizontalTiers = new Set(['edge', 'web', 'application', 'app', 'data', 'security']);
    if (sourceTier === 'security' && ['web', 'application', 'app'].includes(targetTier)) {
      styleParts.push('exitX=0', 'exitY=0.5', 'entryX=1', 'entryY=0.5');
    } else if (horizontalTiers.has(sourceTier) && horizontalTiers.has(targetTier) && sourceTier !== targetTier) {
      styleParts.push('exitX=1', 'exitY=0.5', 'entryX=0', 'entryY=0.5');
    }
    const style = styleParts.join(';');
    const label = edge.label ? ` value="${escapeXml(edge.label)}"` : '';
    cellXml.push(
      `<mxCell id="edge-${index + 1}"${label} style="${escapeXml(style)}" edge="1" parent="1" source="${escapeXml(edge.from)}" target="${escapeXml(edge.to)}">` +
        '<mxGeometry relative="1" as="geometry"/>' +
      '</mxCell>',
    );
  });

  const diagramId = createHash('sha1').update(JSON.stringify(graph)).digest('hex').slice(0, 12);
  return [
    `<mxfile host="kyberion" modified="${new Date().toISOString()}" agent="Kyberion Media-Actuator" version="1.0.0" type="device">`,
    `  <diagram id="${diagramId}" name="${escapeXml(options.title)}" compressed="false">`,
    '    <mxGraphModel dx="1600" dy="1200" grid="1" gridSize="10" guides="1" tooltips="1" connect="1" arrows="1" fold="1" page="1" pageScale="1" pageWidth="1920" pageHeight="1080" math="0" shadow="0">',
    '      <root>',
    ...cellXml.map((line) => `        ${line}`),
    '      </root>',
    '    </mxGraphModel>',
    '  </diagram>',
    '</mxfile>',
  ].join('\n');
}

function buildDrawioNodeStyle(
  node: any,
  isContainer: boolean,
  options: { iconMap: any; iconRoot?: string },
  colors: Record<string, string>,
  fonts: Record<string, string>,
): string {
  const resourceKey = node.icon_key || node.type;
  const resourceEntry = options.iconMap?.resources?.[resourceKey] || options.iconMap?.resources?.[node.type] || options.iconMap?.resources?.default || {};
  const background = resourceEntry.fillColor || colors.background || '#ffffff';
  const stroke = resourceEntry.strokeColor || colors.primary || '#232f3e';
  const accent = resourceEntry.accentColor || colors.accent || '#ff9900';
  const fontFamily = normalizeFontFamily(fonts.body || fonts.heading || 'Arial');

  if (isContainer) {
    const boundaryPalette = resolveDrawioBoundaryPalette(node, background, stroke);
    const boundaryIcon = resolveDrawioBoundaryIcon(node, options.iconRoot);
    return [
      'swimlane',
      'html=1',
      'rounded=1',
      'whiteSpace=wrap',
      'horizontal=1',
      'startSize=28',
      'container=1',
      `fillColor=${boundaryPalette.fill}`,
      `strokeColor=${boundaryPalette.stroke}`,
      `fontColor=${colors.text || '#111827'}`,
      `fontFamily=${fontFamily}`,
      'fontStyle=1',
      ...(boundaryIcon ? [
        `image=${boundaryIcon}`,
        'align=left',
        'verticalAlign=middle',
        'spacingLeft=40',
        'spacing=8',
      ] : []),
    ].join(';');
  }

  const embeddedIcon = resolveEmbeddedIcon(resourceKey, resourceEntry, options.iconRoot);
  if (embeddedIcon) {
    return [
      'shape=image',
      'html=1',
      'verticalLabelPosition=bottom',
      'verticalAlign=top',
      'imageAspect=0',
      'aspect=fixed',
      'align=center',
      'labelBackgroundColor=none',
      `fontColor=${colors.text || '#111827'}`,
      `fontFamily=${fontFamily}`,
      `image=${embeddedIcon}`,
    ].join(';');
  }

  return [
    'rounded=1',
    'whiteSpace=wrap',
    'html=1',
    'arcSize=12',
    `fillColor=${background}`,
    `strokeColor=${stroke}`,
    `fontColor=${colors.text || '#111827'}`,
    `fontFamily=${fontFamily}`,
    `gradientColor=${accent}`,
  ].join(';');
}

function resolveDrawioBoundaryIcon(node: any, iconRoot?: string): string | null {
  const boundary = String(node?.boundary || '');
  const name = String(node?.name || '').toLowerCase();
  const tier = String(node?.render_hints?.semantic_tier || '').toLowerCase();
  const candidates =
    boundary === 'account' || node?.type === 'aws_account' ? [
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Account_32.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Account_32.svg',
    ] :
    boundary === 'region' || node?.type === 'aws_region' ? [
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Region_32.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Region_32.svg',
    ] :
    boundary === 'vpc' || node?.type === 'aws_vpc' ? [
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Virtual-private-cloud-VPC_32.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Virtual-private-cloud-VPC_32.svg',
    ] :
    boundary === 'subnet' || node?.type === 'aws_subnet' ? (
      name.includes('public') ? [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Public-subnet_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Public-subnet_32.svg',
      ] : [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Private-subnet_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Private-subnet_32.svg',
      ]
    ) :
    boundary === 'az' || node?.type === 'aws_availability_zone' ? [
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud_32.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud_32.svg',
    ] :
    boundary === 'scope' ? (
      tier === 'state' || tier === 'data' ? [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Corporate-data-center_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Corporate-data-center_32.svg',
      ] :
      tier === 'web' || tier === 'module' ? [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Server-contents_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Server-contents_32.svg',
      ] : [
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud-logo_32.png',
        'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud-logo_32.svg',
      ]
    ) :
    [];

  for (const candidate of candidates) {
    const absolutePath = iconRoot
      ? path.resolve(iconRoot, candidate)
      : path.resolve(process.cwd(), candidate);
    if (!safeExistsSync(absolutePath)) continue;
    const buffer = safeReadFile(absolutePath, { encoding: null }) as Buffer;
    const extension = path.extname(absolutePath).toLowerCase();
    const mimeType = extension === '.svg' ? 'image/svg+xml' : extension === '.png' ? 'image/png' : null;
    if (!mimeType) continue;
    return `data:${mimeType},${buffer.toString('base64')}`;
  }
  return null;
}

function resolveDrawioBoundaryPalette(
  node: any,
  fallbackFill: string,
  fallbackStroke: string,
): { fill: string; stroke: string } {
  const boundary = String(node?.boundary || '');
  const type = String(node?.type || '');
  const tier = String(node?.render_hints?.semantic_tier || '').trim().toLowerCase();
  const laneName = String(node?.name || '').trim().toLowerCase();
  switch (boundary || type) {
    case 'account':
    case 'aws_account':
      return { fill: '#F8FAFC', stroke: '#0F172A' };
    case 'region':
    case 'aws_region':
      return { fill: '#EFF6FF', stroke: '#1D4ED8' };
    case 'vpc':
    case 'aws_vpc':
      return { fill: '#FFF7ED', stroke: '#C2410C' };
    case 'az':
    case 'aws_availability_zone':
      return { fill: '#F9FAFB', stroke: '#6B7280' };
    case 'subnet':
    case 'aws_subnet': {
      const name = String(node?.name || '').toLowerCase();
      if (name.includes('public')) return { fill: '#ECFDF5', stroke: '#059669' };
      if (name.includes('data')) return { fill: '#FEF2F2', stroke: '#DC2626' };
      return { fill: '#FFF7ED', stroke: '#EA580C' };
    }
    case 'lane':
      switch (tier || laneName) {
        case 'edge':
          return { fill: '#ECFDF5', stroke: '#059669' };
        case 'network':
          return { fill: '#F0F9FF', stroke: '#0284C7' };
        case 'web':
        case 'application':
        case 'app':
          return { fill: '#FFF7ED', stroke: '#EA580C' };
        case 'security':
          return { fill: '#FEF2F2', stroke: '#DC2626' };
        case 'data':
        case 'database':
          return { fill: '#EFF6FF', stroke: '#2563EB' };
        case 'control':
        case 'state':
          return { fill: '#F8FAFC', stroke: '#64748B' };
        default:
          return { fill: '#FFFFFF', stroke: '#94A3B8' };
      }
    case 'scope':
      switch (tier || laneName) {
        case 'state':
          return { fill: '#F8FAFC', stroke: '#475569' };
        case 'data':
          return { fill: '#EFF6FF', stroke: '#2563EB' };
        case 'web':
        case 'module':
          return { fill: '#FFF7ED', stroke: '#C2410C' };
        case 'network':
          return { fill: '#F0F9FF', stroke: '#0284C7' };
        default:
          return { fill: '#FFFFFF', stroke: '#232F3E' };
      }
    default:
      return { fill: fallbackFill, stroke: fallbackStroke };
  }
}

function resolveDrawioNodeSize(node: any): { width: number; height: number } {
  const explicitWidth = Number(node?.render_hints?.preferred_width || 0);
  const explicitHeight = Number(node?.render_hints?.preferred_height || 0);
  if (explicitWidth > 0 && explicitHeight > 0) {
    return { width: explicitWidth, height: explicitHeight };
  }

  const tier = typeof node?.render_hints?.semantic_tier === 'string' ? node.render_hints.semantic_tier : '';
  if (node?.type === 'terraform_module') {
    return { width: 196, height: 112 };
  }
  if (tier === 'edge' || tier === 'data') {
    return { width: 92, height: 92 };
  }
  if (tier === 'security' || tier === 'control' || tier === 'network') {
    return { width: 80, height: 80 };
  }
  if (tier === 'web' || tier === 'application' || tier === 'app') {
    return { width: 88, height: 88 };
  }
  return { width: 160, height: 120 };
}

function resolveEmbeddedIcon(resourceType: string, entry: any, iconRoot?: string): string | null {
  const candidates = [
    entry?.asset_path,
    ...(Array.isArray(entry?.asset_candidates) ? entry.asset_candidates : []),
    ...awsIconCandidatesForResourceType(resourceType),
  ]
    .filter(Boolean)
    .sort((left, right) => iconCandidatePriority(String(left)) - iconCandidatePriority(String(right)));

  for (const candidate of candidates) {
    const absolutePath = iconRoot
      ? path.resolve(iconRoot, candidate)
      : path.resolve(process.cwd(), candidate);
    if (!safeExistsSync(absolutePath)) {
      continue;
    }

    const buffer = safeReadFile(absolutePath, { encoding: null }) as Buffer;
    const extension = path.extname(absolutePath).toLowerCase();
    const mimeType = extension === '.svg' ? 'image/svg+xml' : extension === '.png' ? 'image/png' : null;
    if (!mimeType) {
      continue;
    }
    return `data:${mimeType},${buffer.toString('base64')}`;
  }

  if (typeof entry?.data_uri === 'string' && entry.data_uri.startsWith('data:')) {
    return entry.data_uri;
  }

  return null;
}

function iconCandidatePriority(candidate: string): number {
  const normalized = candidate.toLowerCase();
  if (normalized.endsWith('.png')) return 0;
  if (normalized.endsWith('.svg')) return 1;
  return 2;
}

function compareDrawioNodesByTier(left: any, right: any): number {
  const leftTier = typeof left?.render_hints?.semantic_tier === 'string' ? left.render_hints.semantic_tier : '';
  const rightTier = typeof right?.render_hints?.semantic_tier === 'string' ? right.render_hints.semantic_tier : '';
  const tierOrder = ['network', 'edge', 'web', 'application', 'app', 'data', 'database', 'security', 'module', 'control', 'state'];
  const leftRank = leftTier ? Math.max(0, tierOrder.indexOf(leftTier)) : tierOrder.length;
  const rightRank = rightTier ? Math.max(0, tierOrder.indexOf(rightTier)) : tierOrder.length;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  return String(left?.name || left?.id).localeCompare(String(right?.name || right?.id));
}

function drawioNodeDepth(node: any, nodeMap: Map<string, any>): number {
  let depth = 0;
  let current = node;
  const seen = new Set<string>();
  while (current?.parent && nodeMap.has(current.parent) && !seen.has(current.parent)) {
    seen.add(current.parent);
    depth += 1;
    current = nodeMap.get(current.parent);
  }
  return depth;
}

function compareDrawioLeafNodes(left: any, right: any): number {
  const leftType = String(left?.type || '');
  const rightType = String(right?.type || '');
  const leftName = String(left?.name || left?.id);
  const rightName = String(right?.name || right?.id);
  const leftRelatedSg = String(left?.render_hints?.related_security_group || '');
  const rightRelatedSg = String(right?.render_hints?.related_security_group || '');
  const leftClusterKey = String(left?.render_hints?.cluster_key || '');
  const rightClusterKey = String(right?.render_hints?.cluster_key || '');
  const typeOrder = [
    'aws_provider',
    'aws_availability_zones',
    'terraform_remote_state',
    'aws_internet_gateway',
    'aws_nat_gateway',
    'aws_route_table',
    'aws_security_group',
    'aws_security_group_rule',
    'aws_elb',
    'aws_lb',
    'aws_launch_configuration',
    'aws_autoscaling_group',
    'aws_db_instance',
    'aws_rds_instance',
    'aws_s3_bucket',
  ];
  const leftRank = typeOrder.includes(leftType) ? typeOrder.indexOf(leftType) : typeOrder.length;
  const rightRank = typeOrder.includes(rightType) ? typeOrder.indexOf(rightType) : typeOrder.length;
  if (leftRank !== rightRank) {
    return leftRank - rightRank;
  }
  if (leftClusterKey && rightClusterKey && leftClusterKey !== rightClusterKey) {
    return leftClusterKey.localeCompare(rightClusterKey);
  }
  if (leftClusterKey && !rightClusterKey) {
    return -1;
  }
  if (!leftClusterKey && rightClusterKey) {
    return 1;
  }
  if (leftType === 'aws_security_group' && rightType === 'aws_security_group_rule' && rightRelatedSg.includes(`aws_security_group.${leftName}`)) {
    return -1;
  }
  if (leftType === 'aws_security_group_rule' && rightType === 'aws_security_group' && leftRelatedSg.includes(`aws_security_group.${rightName}`)) {
    return 1;
  }
  if (leftType === 'aws_security_group_rule' && rightType === 'aws_security_group_rule' && leftRelatedSg !== rightRelatedSg) {
    return leftRelatedSg.localeCompare(rightRelatedSg);
  }
  return leftName.localeCompare(rightName);
}

function awsIconCandidatesForResourceType(resourceType: string): string[] {
  const exactMap: Record<string, string[]> = {
    aws_provider: [
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Compute_32.png',
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Compute_32.svg',
    ],
    aws_vpc: [
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_Virtual-private-cloud-VPC_48.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Virtual-private-cloud-VPC_32.svg',
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_Virtual-private-cloud-VPC_48.svg',
    ],
    aws_subnet: [
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Public-subnet_32.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Private-subnet_32.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Public-subnet_32.svg',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Private-subnet_32.svg',
    ],
    aws_region: [
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Region_32.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Region_32.svg',
    ],
    aws_internet_gateway: [
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_Internet-Gateway_48.png',
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_Internet-Gateway_48.svg',
    ],
    aws_nat_gateway: [
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_NAT-Gateway_48.png',
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-VPC_NAT-Gateway_48.svg',
    ],
    aws_route_table: [
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-Route-53_Route-Table_48.png',
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Networking-Content-Delivery/Res_Amazon-Route-53_Route-Table_48.svg',
    ],
    aws_availability_zones: [
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud_32.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/AWS-Cloud_32.svg',
    ],
    aws_lb: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Networking-Content-Delivery/48/Arch_Elastic-Load-Balancing_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Networking-Content-Delivery/48/Arch_Elastic-Load-Balancing_48.svg',
    ],
    aws_elb: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Networking-Content-Delivery/48/Arch_Elastic-Load-Balancing_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Networking-Content-Delivery/48/Arch_Elastic-Load-Balancing_48.svg',
    ],
    aws_instance: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2_48.svg',
    ],
    aws_launch_configuration: [
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/EC2-instance-contents_32.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2_48.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/EC2-instance-contents_32.svg',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2_48.svg',
    ],
    aws_autoscaling_group: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2-Auto-Scaling_48.png',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Auto-Scaling-group_32.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2-Auto-Scaling_48.svg',
      'active/shared/assets/aws-icons/Architecture-Group-Icons_01302026/Auto-Scaling-group_32.svg',
    ],
    aws_rds_instance: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Databases/48/Arch_Amazon-RDS_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Databases/48/Arch_Amazon-RDS_48.svg',
    ],
    aws_db_instance: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Databases/48/Arch_Amazon-RDS_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Databases/48/Arch_Amazon-RDS_48.svg',
    ],
    aws_s3_bucket: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Storage/48/Arch_Amazon-Simple-Storage-Service_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Storage/48/Arch_Amazon-Simple-Storage-Service_48.svg',
    ],
    aws_cloudwatch_metric_alarm: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Management-Tools/48/Arch_Amazon-CloudWatch_48.png',
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Management-Governance/Res_Amazon-CloudWatch_Alarm_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Management-Tools/48/Arch_Amazon-CloudWatch_48.svg',
      'active/shared/assets/aws-icons/Resource-Icons_01302026/Res_Management-Governance/Res_Amazon-CloudWatch_Alarm_48.svg',
    ],
    terraform_remote_state: [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Storage/48/Arch_Amazon-Simple-Storage-Service_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Storage/48/Arch_Amazon-Simple-Storage-Service_48.svg',
    ],
    aws_security_group: [
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.png',
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.svg',
    ],
    aws_security_group_rule: [
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.png',
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.svg',
    ],
  };

  if (exactMap[resourceType]) {
    return exactMap[resourceType];
  }

  if (resourceType.startsWith('aws_iam_')) {
    return [
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.png',
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.svg',
    ];
  }

  if (resourceType.includes('cloudwatch')) {
    return [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Management-Tools/48/Arch_Amazon-CloudWatch_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Management-Tools/48/Arch_Amazon-CloudWatch_48.svg',
    ];
  }

  if (resourceType.includes('security_group')) {
    return [
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.png',
      'active/shared/assets/aws-icons/Category-Icons_01302026/Arch-Category_32/Arch-Category_Security-Identity_32.svg',
    ];
  }

  if (resourceType.includes('autoscaling')) {
    return [
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2-Auto-Scaling_48.png',
      'active/shared/assets/aws-icons/Architecture-Service-Icons_01302026/Arch_Compute/48/Arch_Amazon-EC2-Auto-Scaling_48.svg',
    ];
  }

  return [];
}

function normalizeFontFamily(input: string): string {
  return input.split(',')[0].trim();
}

function deriveThemeFromPptxDesign(design: any, explicitName?: string): Record<string, any> {
  const palette = design?.theme || {};
  const slideElements = Array.isArray(design?.slides) ? design.slides.flatMap((slide: any) => slide?.elements || []) : [];
  const titleFont = pickFontFromElements(design?.master?.elements, ['title', 'ctrTitle']);
  const bodyFont = pickFontFromElements(design?.master?.elements, ['body', 'subTitle']);
  const slideTitleFont = pickFontFromElements(slideElements, ['title', 'ctrTitle']);
  const slideBodyFont = pickFontFromElements(slideElements, ['body', 'subTitle']);
  const fallbackFont = pickFontFromElements(slideElements, []);

  return {
    name: explicitName || 'pptx-extracted-theme',
    colors: {
      primary: normalizeHexColor(palette.dk1 || palette.tx1 || palette.accent2 || palette.accent1, '#1F2937'),
      secondary: normalizeHexColor(palette.dk2 || palette.tx2 || palette.accent2 || palette.accent3, '#4B5563'),
      accent: normalizeHexColor(palette.accent1 || palette.hlink || palette.accent2, '#2563EB'),
      background: normalizeHexColor(palette.lt1 || palette.bg1 || palette.lt2, '#FFFFFF'),
      text: normalizeHexColor(palette.tx1 || palette.dk1 || palette.dk2, '#111827'),
    },
    fonts: {
      heading: titleFont || slideTitleFont || fallbackFont || 'Aptos, sans-serif',
      body: bodyFont || slideBodyFont || fallbackFont || 'Aptos, sans-serif',
    },
  };
}

function pickFontFromElements(elements: any[] | undefined, placeholderTypes: string[]): string | undefined {
  if (!Array.isArray(elements)) {
    return undefined;
  }

  const candidates = placeholderTypes.length > 0
    ? elements.filter((element) => placeholderTypes.includes(element?.placeholderType))
    : elements;

  for (const element of candidates) {
    if (typeof element?.style?.fontFamily === 'string' && element.style.fontFamily.trim()) {
      return element.style.fontFamily.trim();
    }

    if (Array.isArray(element?.textRuns)) {
      for (const run of element.textRuns) {
        if (typeof run?.options?.fontFamily === 'string' && run.options.fontFamily.trim()) {
          return run.options.fontFamily.trim();
        }
      }
    }
  }

  return undefined;
}

function normalizeHexColor(value: string | undefined, fallback: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    return fallback;
  }

  const normalized = value.trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{6}$/.test(normalized)) {
    return `#${normalized.toUpperCase()}`;
  }
  if (/^[0-9a-fA-F]{8}$/.test(normalized)) {
    return `#${normalized.slice(2).toUpperCase()}`;
  }
  return fallback;
}

function escapeXml(input: string): string {
  return String(input)
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : '';
const modulePath = fileURLToPath(import.meta.url);

if (entrypoint && modulePath === entrypoint) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
