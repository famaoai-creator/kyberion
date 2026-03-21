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
  generateNativeXlsx,
  generateNativeDocx,
  generateNativePdf,
} from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs'; // Only for fs.statSync in render operations
import * as excelUtils from '@agent/shared-media';

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
      }
      results.push({ op: step.op, status: 'success' });
    } catch (err: any) {
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
      const pdfDesign = await distillPdfDesign(pdfPath, { aesthetic: params.aesthetic !== false });
      return { ...ctx, [params.export_as || 'last_pdf_design']: pdfDesign };
    }
    default: return ctx;
  }
}

async function opTransform(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = process.cwd();
  switch (op) {
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
          slides: contentData.map((data: any, idx: number) => {
            const elements: any[] = [];
            // Title
            if (data.title) {
              elements.push({
                type: 'text',
                placeholderType: 'title',
                pos: { x: 0.5, y: 0.5, w: 9, h: 1 },
                text: data.title,
                style: {
                  fontSize: 32, bold: true,
                  color: (themeColors.text || '#000000').replace('#', ''),
                  fontFamily: theme?.fonts?.heading?.split(',')[0] || 'Inter',
                  align: 'center',
                },
              });
            }
            // Body / Subtitle
            const bodyText = Array.isArray(data.body) ? data.body.join('\n') : (data.subtitle || data.body || '');
            if (bodyText) {
              elements.push({
                type: 'text',
                placeholderType: 'body',
                pos: { x: 1, y: 1.8, w: 8, h: 2.8 },
                text: bodyText,
                style: {
                  fontSize: 18,
                  color: (themeColors.secondary || '#334155').replace('#', ''),
                  fontFamily: theme?.fonts?.body?.split(',')[0] || 'System-ui',
                  align: 'left', valign: 'top',
                },
              });
            }
            // Visual placeholder
            if (data.visual) {
              elements.push({
                type: 'shape', shapeType: 'rect',
                pos: { x: 1, y: 4.6, w: 8, h: 0.5 },
                text: `[Visual: ${data.visual}]`,
                style: { fill: 'F1F5F9', color: '64748B', fontSize: 12, italic: true, align: 'center', valign: 'middle' },
              });
            }
            return { id: `slide${idx + 1}`, elements };
          }),
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
      const brief = ctx[fromKey];
      if (!brief || typeof brief !== 'object') {
        throw new Error(`proposal_storyline_from_brief could not find context key: ${fromKey}`);
      }

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
      const outPath = path.resolve(rootDir, resolve(params.path));

      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });

      await generateNativePptx(protocol, outPath);

      const stats = fs.statSync(outPath);
      logger.info(`✅ [MEDIA] PPTX rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'xlsx_render': {
      const xlsxProtocol = ctx[params.design_from || 'last_xlsx_design'];
      const xlsxOutPath = path.resolve(rootDir, resolve(params.path));
      if (!safeExistsSync(path.dirname(xlsxOutPath))) safeMkdir(path.dirname(xlsxOutPath), { recursive: true });
      await generateNativeXlsx(xlsxProtocol, xlsxOutPath);
      const xlsxStats = fs.statSync(xlsxOutPath);
      logger.info(`✅ [MEDIA] XLSX rendered at: ${xlsxOutPath} (${xlsxStats.size} bytes).`);
      break;
    }
    case 'docx_render': {
      const docxProtocol = ctx[params.design_from || 'last_docx_design'];
      const docxOutPath = path.resolve(rootDir, resolve(params.path));
      if (!safeExistsSync(path.dirname(docxOutPath))) safeMkdir(path.dirname(docxOutPath), { recursive: true });
      await generateNativeDocx(docxProtocol, docxOutPath);
      const docxStats = fs.statSync(docxOutPath);
      logger.info(`✅ [MEDIA] DOCX rendered at: ${docxOutPath} (${docxStats.size} bytes).`);
      break;
    }
    case 'pdf_render': {
      const pdfProtocol = ctx[params.design_from || 'last_pdf_design'];
      const pdfOutPath = path.resolve(rootDir, resolve(params.path));
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
  const nodeMap = new Map(nodes.map((node: any) => [node.id, node]));
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

  const layoutNode = (node: any, depth: number, parentX: number, parentY: number): { width: number; height: number } => {
    const nodeChildren = childrenByParent.get(node.id) || [];
    const preferredWidth = Number(node?.render_hints?.preferred_width || 160);
    const preferredHeight = Number(node?.render_hints?.preferred_height || 120);
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

    let innerX = parentX + 30;
    let maxBottom = parentY + 90;
    let maxRight = parentX + 260;
    for (const child of nodeChildren) {
      const childBox = layoutNode(child, depth + 1, innerX, parentY + 70);
      const childGeo = geometry.get(child.id)!;
      innerX += childBox.width + 30;
      maxBottom = Math.max(maxBottom, childGeo.y + childGeo.height + 30);
      maxRight = Math.max(maxRight, childGeo.x + childGeo.width + 30);
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
    return leftIsContainer === rightIsContainer ? left.id.localeCompare(right.id) : rightIsContainer - leftIsContainer;
  });

  for (const node of sortedNodes) {
    const geo = geometry.get(node.id) || { x: 40, y: 40, width: 160, height: 120 };
    const hasChildren = (childrenByParent.get(node.id) || []).length > 0 || node?.render_hints?.container === true || Boolean(node?.boundary && !node?.parent);
    const parentId = node.parent && nodeMap.has(node.parent) ? node.parent : '1';
    const style = buildDrawioNodeStyle(node, hasChildren, options, colors, fonts);
    const label = escapeXml(node.name || node.id);
    cellXml.push(
      `<mxCell id="${escapeXml(node.id)}" value="${label}" style="${escapeXml(style)}" vertex="1" parent="${escapeXml(parentId)}">` +
        `<mxGeometry x="${geo.x}" y="${geo.y}" width="${geo.width}" height="${geo.height}" as="geometry"/>` +
      `</mxCell>`,
    );
  }

  edges.forEach((edge: any, index: number) => {
    const style = [
      'edgeStyle=orthogonalEdgeStyle',
      'rounded=1',
      'orthogonalLoop=1',
      'jettySize=auto',
      'html=1',
      `strokeColor=${colors.primary || '#232f3e'}`,
      `fontColor=${colors.text || '#111827'}`,
      `fontFamily=${normalizeFontFamily(fonts.body || fonts.heading || 'Arial')}`,
    ].join(';');
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
    `  <diagram id="${diagramId}" name="${escapeXml(options.title)}">`,
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
    return [
      'swimlane',
      'html=1',
      'rounded=1',
      'whiteSpace=wrap',
      'horizontal=0',
      'startSize=28',
      'container=1',
      `fillColor=${background}`,
      `strokeColor=${stroke}`,
      `fontColor=${colors.text || '#111827'}`,
      `fontFamily=${fontFamily}`,
      'fontStyle=1',
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

function resolveEmbeddedIcon(resourceType: string, entry: any, iconRoot?: string): string | null {
  const candidates = [
    entry?.asset_path,
    ...(Array.isArray(entry?.asset_candidates) ? entry.asset_candidates : []),
  ].filter(Boolean);

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
    return `data:${mimeType};base64,${buffer.toString('base64')}`;
  }

  if (typeof entry?.data_uri === 'string' && entry.data_uri.startsWith('data:')) {
    return entry.data_uri;
  }

  return null;
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
