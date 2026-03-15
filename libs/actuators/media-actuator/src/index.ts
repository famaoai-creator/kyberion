import { logger, safeReadFile, safeWriteFile, safeMkdir, safeExistsSync, derivePipelineStatus, pathResolver } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import * as fs from 'node:fs'; // Only for fs.statSync in render operations
import { execSync } from 'node:child_process';
import * as excelUtils from '@agent/shared-media';
import * as pptxUtils from '@agent/core/src/pptx-utils.js';
import * as xlsxUtils from '@agent/core/src/xlsx-utils.js';
import * as docxUtils from '@agent/core/src/docx-utils.js';
import * as pdfUtils from '@agent/core/src/pdf-utils.js';

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
      const pdfDesign = await pdfUtils.distillPdfDesign(pdfPath, { aesthetic: params.aesthetic !== false });
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
      const contentData = params.content_data || pattern?.content_data || [];
      const outputFormat = resolve(params.output_format) || pattern?.media_actuator_config?.engine || 'pptx';

      if (outputFormat === 'pptx') {
        const themeColors = theme?.colors || {};
        const protocol: any = {
          version: '3.0.0',
          generatedAt: new Date().toISOString(),
          canvas: { w: 10, h: 5.625 },
          theme: {
            dk1: (themeColors.primary || '#000000').replace('#', ''),
            lt1: (themeColors.background || '#FFFFFF').replace('#', ''),
            accent1: (themeColors.accent || '#38BDF8').replace('#', ''),
          },
          master: { elements: [] },
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
    default:
      logger.warn(`[MEDIA_TRANSFORM] Unknown transform op: ${op}`);
      return ctx;
  }
}

async function opApply(op: string, params: any, ctx: any, resolve: Function) {
  const rootDir = process.cwd();
  switch (op) {
    case 'pptx_render': {
      const protocol = ctx[params.design_from || 'last_pptx_design'];
      const outPath = path.resolve(rootDir, resolve(params.path));

      if (!safeExistsSync(path.dirname(outPath))) safeMkdir(path.dirname(outPath), { recursive: true });

      const { generateNativePptx } = await import('@agent/core/src/native-pptx-engine/engine.js');
      await generateNativePptx(protocol, outPath);

      const stats = fs.statSync(outPath);
      logger.info(`✅ [MEDIA] PPTX rendered at: ${outPath} (${stats.size} bytes).`);
      break;
    }
    case 'xlsx_render': {
      const xlsxProtocol = ctx[params.design_from || 'last_xlsx_design'];
      const xlsxOutPath = path.resolve(rootDir, resolve(params.path));
      if (!safeExistsSync(path.dirname(xlsxOutPath))) safeMkdir(path.dirname(xlsxOutPath), { recursive: true });
      const { generateNativeXlsx } = await import('@agent/core/src/native-xlsx-engine/engine.js');
      await generateNativeXlsx(xlsxProtocol, xlsxOutPath);
      const xlsxStats = fs.statSync(xlsxOutPath);
      logger.info(`✅ [MEDIA] XLSX rendered at: ${xlsxOutPath} (${xlsxStats.size} bytes).`);
      break;
    }
    case 'docx_render': {
      const docxProtocol = ctx[params.design_from || 'last_docx_design'];
      const docxOutPath = path.resolve(rootDir, resolve(params.path));
      if (!safeExistsSync(path.dirname(docxOutPath))) safeMkdir(path.dirname(docxOutPath), { recursive: true });
      const { generateNativeDocx } = await import('@agent/core/src/native-docx-engine/engine.js');
      await generateNativeDocx(docxProtocol, docxOutPath);
      const docxStats = fs.statSync(docxOutPath);
      logger.info(`✅ [MEDIA] DOCX rendered at: ${docxOutPath} (${docxStats.size} bytes).`);
      break;
    }
    case 'pdf_render': {
      const pdfProtocol = ctx[params.design_from || 'last_pdf_design'];
      const pdfOutPath = path.resolve(rootDir, resolve(params.path));
      if (!safeExistsSync(path.dirname(pdfOutPath))) safeMkdir(path.dirname(pdfOutPath), { recursive: true });
      const { generateNativePdf } = await import('@agent/core/src/native-pdf-engine/engine.js');
      await generateNativePdf(pdfProtocol, pdfOutPath, params.options);
      const pdfStats = fs.statSync(pdfOutPath);
      logger.info(`✅ [MEDIA] PDF rendered at: ${pdfOutPath} (${pdfStats.size} bytes).`);
      break;
    }
    case 'write_file':
      safeWriteFile(path.resolve(rootDir, resolve(params.path)), ctx[params.from] || params.content);
      break;
    case 'log': logger.info(`[MEDIA_LOG] ${resolve(params.message)}`); break;
  }
  return ctx;
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputContent = safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string;
  const result = await handleAction(JSON.parse(inputContent));
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}

export { handleAction };
