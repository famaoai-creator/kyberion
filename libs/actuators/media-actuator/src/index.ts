import { logger, safeReadFile, safeWriteFile, excelUtils, pptxUtils } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { extract } from './artisan/extraction-engine.js';
import { generateWordContent } from './artisan/word-engine.js';
import { marked } from 'marked';
import puppeteer from 'puppeteer';

/**
 * Media-Actuator v1.6.0
 * The Unified Media Intelligence Engine.
 * Powered by Kyberion Core Design Protocols (Excel/PPTX/PDF/Word).
 */

interface MediaAction {
  action: 'render' | 'convert' | 'assemble' | 'gif' | 'extract';
  type?: 'mermaid' | 'pdf' | 'excel' | 'ppt' | 'html' | 'word';
  input_path?: string;
  output_path: string;
  data?: any; // Full ADF data (e.g., ExcelDesignProtocol or PptxDesignProtocol)
  options?: any;
}

async function handleAction(input: MediaAction) {
  const resolvedInput = input.input_path ? path.resolve(process.cwd(), input.input_path) : '';
  const resolvedOutput = input.output_path ? path.resolve(process.cwd(), input.output_path) : '';

  if (resolvedOutput && !fs.existsSync(path.dirname(resolvedOutput))) {
    fs.mkdirSync(path.dirname(resolvedOutput), { recursive: true });
  }

  const markdownContent = resolvedInput && fs.existsSync(resolvedInput) ? fs.readFileSync(resolvedInput, 'utf8') : (input.data?.markdown || '');

  switch (input.action) {
    case 'extract':
      if (input.type === 'excel') {
        logger.info(`🧠 [MEDIA] Distilling Excel design from: ${input.input_path}`);
        return await excelUtils.distillExcelDesign(resolvedInput);
      }
      if (input.type === 'ppt') {
        logger.info(`🧠 [MEDIA] Distilling PPTX design from: ${input.input_path}`);
        return await pptxUtils.distillPptxDesign(resolvedInput);
      }
      logger.info(`🔍 [MEDIA] Extracting layers from: ${input.input_path}`);
      return await extract(resolvedInput, input.options?.mode || 'all');

    case 'assemble':
    case 'render':
      if (input.type === 'excel') {
        logger.info(`📊 [MEDIA] Generating high-fidelity Excel using Design Protocol: ${input.output_path}`);
        const workbook = await excelUtils.generateExcelWithDesign(
          input.data.dynamic_data || [],
          input.data.protocol,
          input.data.sheet_name,
          input.data.header_idx,
          input.data.data_idx
        );
        await workbook.xlsx.writeFile(resolvedOutput);
        return { status: 'success', path: input.output_path };
      }
      
      if (input.type === 'ppt') {
        logger.info(`🎭 [MEDIA] Generating high-fidelity PPT using Design Protocol: ${input.output_path}`);
        const pptx = await pptxUtils.generatePptxWithDesign(input.data.protocol, input.data.assets_dir || './assets');
        await pptx.writeFile({ fileName: resolvedOutput });
        return { status: 'success', path: input.output_path };
      }

      if (input.type === 'word') {
        logger.info(`📝 [MEDIA] Generating high-fidelity Word: ${input.output_path}`);
        const buffer = await generateWordContent(markdownContent, input.data?.specs || {
          master_name: 'Standard',
          typography: {
            body: { font: 'Arial', size: 11, line_height: '1.5', color: '#000000' },
            heading_1: { size: 18, alignment: 'center', color: '#2E75B5' },
            heading_2: { size: 14, border_bottom: '1px solid #BDD7EE', color: '#2E75B5' }
          },
          table_style: { header_bg: '#DDEBF7', border_color: '#9BC2E6' },
          layout: { margins: { top: 720, right: 720, bottom: 720, left: 720 } }
        });
        fs.writeFileSync(resolvedOutput, buffer);
        return { status: 'success', path: input.output_path };
      }

      if (input.type === 'pdf') {
        logger.info(`📄 [MEDIA] Generating PDF via Puppeteer: ${input.output_path}`);
        const html = await marked.parse(markdownContent);
        const fullHtml = `<html><head><style>
          body { font-family: sans-serif; padding: 40px; line-height: 1.6; }
          table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
          th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
          th { background-color: #f4f4f4; }
          h1, h2 { color: #2E75B5; }
        </style></head><body>${html}</body></html>`;
        
        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
        await page.pdf({ path: resolvedOutput, format: 'A4', printBackground: true });
        await browser.close();
        return { status: 'success', path: input.output_path };
      }
      break;

    default:
      throw new Error(`Unsupported action: ${input.action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs()
    .option('input', {
      alias: 'i',
      type: 'string',
      description: 'Path to ADF JSON input',
      required: true
    })
    .parseSync();

  const inputData = JSON.parse(fs.readFileSync(path.resolve(process.cwd(), argv.input as string), 'utf8')) as MediaAction;
  const result = await handleAction(inputData);
  
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
