import {
  logger,
  safeReadFile,
  safeWriteFile,
  safeMkdir,
  safeExistsSync,
  safeExec,
  derivePipelineStatus,
  pathResolver,
  pptxUtils,
  xlsxUtils,
  docxUtils,
  distillPdfDesign,
  generateNativePptx,
  patchPptxText,
  generateNativeXlsx,
  generateNativeDocx,
  generateNativePdf,
  resolveRef,
  handleStepError,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs'; // Only for fs.statSync in render operations
import * as excelUtils from '@agent/shared-media';
import type { PdfDesignProtocol } from '@agent/core/src/types/pdf-protocol.js';
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

function buildPptxSlideFromPattern(data: any, idx: number, theme: any, pattern: any, activeMaster: any, canvas: any) {
  const themeColors = theme?.colors || {};
  const pageLayouts = pattern?.page_layouts || {};
  const pageLayoutId = data.page_layout || data.page_layout_id || data.layout_id;
  const pageLayout = pageLayoutId ? pageLayouts[pageLayoutId] : undefined;
  const placeholderConfig = pageLayout?.placeholders || {};
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
        align: 'center',
      },
    }, placeholderConfig.title);
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
        fontSize: 18,
        color: (themeColors.secondary || '#334155').replace('#', ''),
        fontFamily: theme?.fonts?.body?.split(',')[0] || 'System-ui',
        align: 'left',
        valign: 'top',
      },
    }, placeholderConfig.body);
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
        fill: 'F1F5F9',
        color: '64748B',
        fontSize: 12,
        italic: true,
        align: 'center',
        valign: 'middle',
      },
    }, placeholderConfig.visual);
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
      return {
        ...ctx,
        [params.export_as || 'last_pptx_design']: buildPptxProtocolFromPdfDesign(pdfDesign as PdfDesignProtocol),
        merged_output_format: 'pptx',
      };
    }
    case 'apply_theme': {
      const themesPath = path.resolve(rootDir, 'knowledge/public/design-patterns/media-templates/themes.json');
      if (!safeExistsSync(themesPath)) {
        logger.warn('[MEDIA_TRANSFORM] themes.json not found, skipping theme application');
        return ctx;
      }
      const themes = JSON.parse(safeReadFile(themesPath, { encoding: 'utf8' }) as string);
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
          slides: contentData.map((data: any, idx: number) => buildPptxSlideFromPattern(data, idx, theme, pattern, activeMaster, canvas)),
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

      const chapters = Array.isArray(brief.story?.chapters) ? brief.story.chapters : [];
      const evidence = Array.isArray(brief.evidence) ? brief.evidence : [];
      const slides = [
        {
          id: 'cover',
          title: brief.title || 'Proposal',
          objective: brief.story?.core_message || brief.objective || 'Proposal overview',
          body: [
            `${brief.client || 'Client'} proposal`,
            ...(Array.isArray(brief.audience) ? [`Audience: ${brief.audience.join(', ')}`] : []),
          ],
          visual: 'cover statement',
        },
        ...chapters.map((chapter: string, idx: number) => ({
          id: `chapter_${idx + 1}`,
          title: chapter,
          objective: chapter,
          body: [
            brief.story?.core_message || brief.objective || 'Core proposal message',
            evidence[idx]?.point || `Key point for ${chapter}`,
          ],
          visual: evidence[idx]?.title || 'supporting visual',
        })),
        {
          id: 'next_steps',
          title: 'Next Steps',
          objective: brief.story?.closing_cta || 'Agree next action',
          body: [
            brief.story?.closing_cta || 'Confirm scope and move to execution planning',
            `Tone: ${brief.story?.tone || 'professional'}`,
          ],
          visual: 'timeline / next action',
        },
      ];

      return {
        ...ctx,
        [params.export_as || 'proposal_storyline']: {
          kind: 'proposal-storyline-adf',
          title: brief.title || 'Proposal',
          client: brief.client,
          core_message: brief.story?.core_message,
          document_profile: brief.document_profile,
          layout_template_id: brief.layout_template_id,
          slides,
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
      }));

      return {
        ...ctx,
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
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief = ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`document_spreadsheet_design_from_brief could not find context key: ${fromKey}`);
      }

      const brief = normalizeSpreadsheetDocumentBrief(rootDir, rawBrief);
      return {
        ...ctx,
        [params.export_as || 'last_xlsx_design']: brief.payload.protocol || buildTrackerSpreadsheetProtocol(rootDir, brief),
        document_spreadsheet_brief: brief,
      };
    }
    case 'document_report_design_from_brief': {
      const fromKey = resolve(params.from) || 'last_json';
      const rawBrief = ctx[fromKey];
      if (!rawBrief || typeof rawBrief !== 'object') {
        throw new Error(`document_report_design_from_brief could not find context key: ${fromKey}`);
      }

      const brief = normalizeReportDocumentBrief(rawBrief);
      if (brief.render_target === 'docx') {
        return {
          ...ctx,
          [params.export_as || 'last_docx_design']: buildReportDocxProtocol(rootDir, brief),
          document_report_brief: brief,
        };
      }

      if (brief.render_target === 'pdf') {
        return {
          ...ctx,
          [params.export_as || 'last_pdf_design']: buildReportPdfProtocol(rootDir, brief),
          document_report_brief: brief,
        };
      }

      throw new Error(`Unsupported report render_target: ${brief.render_target}`);
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

      const stats = fs.statSync(outPath);
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

      const stats = fs.statSync(outPath);
      logger.info(`✅ [MEDIA] D2 rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'pptx_render': {
      const protocol = ctx[params.design_from || 'last_pptx_design'];
      const outPath = path.resolve(rootDir, resolve(params.path || params.output_path));

      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });

      await generateNativePptx(protocol, outPath);

      const stats = fs.statSync(outPath);
      logger.info(`✅ [MEDIA] PPTX rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'pptx_patch': {
      const sourcePath = path.resolve(rootDir, resolve(params.source));
      const outPath = path.resolve(rootDir, resolve(params.path));
      const replacements = params.replacements || ctx[params.replacements_from || 'last_replacements'] || {};

      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });

      patchPptxText(sourcePath, outPath, replacements);

      const stats = fs.statSync(outPath);
      logger.info(`✅ [MEDIA] PPTX patched at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'xlsx_render': {
      const xlsxProtocol = ctx[params.design_from || 'last_xlsx_design'];
      const xlsxOutPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      if (!safeExistsSync(path.dirname(xlsxOutPath))) safeMkdir(path.dirname(xlsxOutPath), { recursive: true });
      await generateNativeXlsx(xlsxProtocol, xlsxOutPath);
      const xlsxStats = fs.statSync(xlsxOutPath);
      logger.info(`✅ [MEDIA] XLSX rendered at: ${xlsxOutPath} (${xlsxStats.size} bytes).`);
      break;
    }
    case 'docx_render': {
      const docxProtocol = ctx[params.design_from || 'last_docx_design'];
      const docxOutPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      if (!safeExistsSync(path.dirname(docxOutPath))) safeMkdir(path.dirname(docxOutPath), { recursive: true });
      await generateNativeDocx(docxProtocol, docxOutPath);
      const docxStats = fs.statSync(docxOutPath);
      logger.info(`✅ [MEDIA] DOCX rendered at: ${docxOutPath} (${docxStats.size} bytes).`);
      break;
    }
    case 'pdf_render': {
      const pdfProtocol = ctx[params.design_from || 'last_pdf_design'];
      const pdfOutPath = path.resolve(rootDir, resolve(params.path || params.output_path));
      if (!safeExistsSync(path.dirname(pdfOutPath))) safeMkdir(path.dirname(pdfOutPath), { recursive: true });
      await generateNativePdf(pdfProtocol, pdfOutPath, params.options);
      const pdfStats = fs.statSync(pdfOutPath);
      logger.info(`✅ [MEDIA] PDF rendered at: ${pdfOutPath} (${pdfStats.size} bytes).`);
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
      const stats = fs.statSync(outPath);
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
  if (input.document_type !== 'report') {
    throw new Error(`Unsupported document_type in document-brief: ${String(input.document_type)}`);
  }
  if (!['docx', 'pdf'].includes(String(input.render_target))) {
    throw new Error(`Unsupported render_target in document-brief: ${String(input.render_target)}`);
  }
  if (!input.payload || typeof input.payload !== 'object') {
    throw new Error('document-brief for report requires an object payload.');
  }
  if (!Array.isArray(input.payload.sections) || input.payload.sections.length === 0) {
    throw new Error('document-brief for report requires payload.sections.');
  }

  return {
    artifact_family: input.artifact_family,
    document_type: input.document_type,
    document_profile: input.document_profile || 'summary-report',
    render_target: input.render_target,
    locale: input.locale || 'en-US',
    layout_template_id: input.layout_template_id,
    payload: input.payload,
  };
}

function buildReportDocxProtocol(rootDir: string, brief: any): any {
  const { template } = resolveDocumentLayoutTemplate(rootDir, {
    document_type: 'report',
    layout_template_id: brief.layout_template_id,
  });
  const docxLayout = template?.docx || {};
  const layoutProfileTemplate = docxLayout.layout_profile || {};
  const numberingPolicyTemplate = docxLayout.numbering_policy || {};
  const headingFont = normalizeFontFamily(
    brief.locale?.startsWith('ja')
      ? template?.fonts?.heading || 'Meiryo'
      : template?.fonts?.heading || 'Aptos',
  );
  const bodyFont = normalizeFontFamily(
    brief.locale?.startsWith('ja')
      ? template?.fonts?.body || 'Meiryo'
      : template?.fonts?.body || 'Aptos',
  );
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
    bodyBlocks.push({
      type: 'paragraph',
      paragraph: {
        pPr: { pStyle: 'Heading2' },
        content: [{ type: 'run', run: { content: [{ type: 'text', text: section.heading || 'Section' }] } }],
      },
    });

    if (Array.isArray(section.body)) {
      for (const paragraph of section.body) {
        bodyBlocks.push({
          type: 'paragraph',
          paragraph: {
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
              content: [{
                type: 'run',
                run: {
                  rPr: { bold: true, color: { val: String(template?.colors?.accent || '#2563eb').replace('#', '') } },
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
                    shd: { val: 'clear', fill: String(template?.colors?.primary || '#1f2937').replace('#', '') },
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
      colors: { dk1: '111827', lt1: 'FFFFFF', accent1: '2563EB' },
      majorFont: headingFont,
      minorFont: headingFont,
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
      ],
    },
    numbering: {
      abstractNums: [{ abstractNumId: 0, levels: [{ ilvl: 0, numFmt: 'bullet', lvlText: '•', jc: 'left' }] }],
      nums: [{ numId: 1, abstractNumId: 0 }],
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

function buildPositionedSlideElementsFromPdfPage(page: any, canvas: { w: number; h: number }) {
  const pageWidth = page?.width || 960;
  const pageHeight = page?.height || 540;
  if (isGridLikePdfPage(page)) return [];
  const lines = buildRenderablePdfLines(page);
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

function buildPptxProtocolFromPdfDesign(pdfDesign: PdfDesignProtocol): any {
  const title = pdfDesign.metadata?.title || pdfDesign.source?.title || 'PDF Conversion';
  const pageTexts = Array.isArray(pdfDesign.content?.pages) ? pdfDesign.content!.pages : [];
  const canvas = { w: 10, h: 5.625 };
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
          pos: { x: 0.7, y: 0.7, w: 8.8, h: 0.8 },
          text: title,
          style: { fontSize: 28, bold: true, color: '1F2937', fontFamily: 'Aptos', align: 'left' },
        },
        {
          type: 'text',
          placeholderType: 'body',
          pos: { x: 0.9, y: 1.9, w: 8.2, h: 2.8 },
          text: summaryBullets.length > 0 ? summaryBullets.map((item) => `• ${item}`).join('\n') : 'Converted from PDF design.',
          style: { fontSize: 18, color: '475569', fontFamily: 'Aptos', align: 'left' },
        },
      ],
    },
    ...pageTexts.map((page, index) => {
      const positionedElements = buildPositionedSlideElementsFromPdfPage(page, canvas);
      const fallbackBullets = isGridLikePdfPage(page)
        ? buildGridPageSummary(page.text || '', 8)
        : chunkTextToBullets(page.text || '', 8);
      return {
        id: `pdf-page-${index + 1}`,
        elements: positionedElements.length > 0
          ? [
              {
                type: 'text',
                placeholderType: 'title',
                pos: { x: 0.35, y: 0.25, w: 9.1, h: 0.45 },
                text: `Page ${page.pageNumber || index + 1}`,
                style: { fontSize: 14, bold: true, color: '64748B', fontFamily: 'Aptos', align: 'right' },
              },
              ...positionedElements,
            ]
          : [
              {
                type: 'text',
                placeholderType: 'title',
                pos: { x: 0.7, y: 0.6, w: 8.8, h: 0.7 },
                text: `Page ${page.pageNumber || index + 1}`,
                style: { fontSize: 24, bold: true, color: '1F2937', fontFamily: 'Aptos', align: 'left' },
              },
              {
                type: 'text',
                placeholderType: 'body',
                pos: { x: 0.8, y: 1.5, w: 8.4, h: 3.6 },
                text: fallbackBullets.join('\n') || '(No extractable page text)',
                style: { fontSize: 16, color: '334155', fontFamily: 'Aptos', align: 'left' },
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
      dk1: '111827',
      dk2: '475569',
      lt1: 'FFFFFF',
      lt2: 'F8FAFC',
      accent1: '2563EB',
      accent2: '0F172A',
    },
    master: {
      elements: [],
    },
    slides,
  };
}

function buildReportPdfProtocol(rootDir: string, brief: any): any {
  const { template, templateId } = resolveDocumentLayoutTemplate(rootDir, {
    document_type: 'report',
    layout_template_id: brief.layout_template_id,
  });
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
  const headerFill = hexToPdfRgb(tableStyle.header_fill, [0.12, 0.16, 0.22]);
  const gridStroke = hexToPdfRgb(tableStyle.grid_stroke, [0.8, 0.84, 0.89]);
  const outerStroke = hexToPdfRgb(tableStyle.outer_stroke, [0.58, 0.64, 0.72]);
  const zebraFill = hexToPdfRgb(tableStyle.zebra_fill, [0.97, 0.98, 0.99]);
  const showZebra = tableStyle.show_zebra !== false;
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
    elements.push({
      type: 'text',
      x: pdfLayout.margin_left || 48,
      y: cursorY,
      text: section.heading || 'Section',
      fontSize: pdfLayout.section_font_size || 14,
    });
    cursorY += 22;
    if (Array.isArray(section.body)) {
      for (const paragraph of section.body) {
        elements.push({
          type: 'text',
          x: pdfLayout.content_x || 56,
          y: cursorY,
          text: String(paragraph),
          fontSize: pdfLayout.body_font_size || 10,
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
          fillColor: [0.93, 0.96, 1.0],
          fillOpacity: 0.7,
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
    },
    content: {
      text: bodySections.join('\n'),
      pages: [{ pageNumber: 1, width: 595, height: 842, text: '', vectors }],
    },
    aesthetic: {
      layout: 'single-column',
      elements,
      colors: [template?.colors?.primary || '#1f2937', template?.colors?.secondary || '#4b5563', template?.colors?.accent || '#2563eb'],
      fonts: [brief.locale?.startsWith('ja') ? 'HeiseiKakuGo-W5' : 'Helvetica'],
      branding: { logoPresence: false, primaryColor: '#1f2937', tone: 'professional' },
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
  const { template } = resolveDocumentLayoutTemplate(rootDir, {
    document_type: 'tracker',
    layout_template_id: brief.layout_template_id,
  });
  const colors = template?.colors || {};
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
    sheets: [
      {
        id: 'sheet1',
        name: brief.payload.sheet_name || 'Tracker',
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
  const themesPath = path.resolve(rootDir, 'knowledge/public/design-patterns/media-templates/themes.json');
  if (!safeExistsSync(themesPath)) {
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

  const themes = JSON.parse(safeReadFile(themesPath, { encoding: 'utf8' }) as string);
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
