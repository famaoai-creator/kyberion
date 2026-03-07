import { logger, safeReadFile, safeWriteFile, excelUtils, pptxUtils, safeMkdir } from '@agent/core';
import { createStandardYargs } from '@agent/core/cli-utils';
import * as path from 'node:path';
import { extract } from './artisan/extraction-engine.js';
import { generateWordContent } from './artisan/word-engine.js';
import { marked } from 'marked';
import puppeteer from 'puppeteer';

/**
 * Media-Actuator v1.8.0 [SECURE-IO ENFORCED]
 * Strictly compliant with Layer 2 (Shield).
 */

interface MediaAction {
  action: 'render' | 'convert' | 'assemble' | 'gif' | 'extract';
  type?: 'mermaid' | 'pdf' | 'excel' | 'ppt' | 'html' | 'word';
  input_path?: string;
  output_path: string;
  data?: any;
  options?: any;
}

async function handleAction(input: MediaAction) {
  const resolvedInput = input.input_path ? path.resolve(process.cwd(), input.input_path) : '';
  const resolvedOutput = input.output_path ? path.resolve(process.cwd(), input.output_path) : '';

  if (resolvedOutput) {
    safeMkdir(path.dirname(resolvedOutput));
  }

  const markdownContent = (resolvedInput) ? (safeReadFile(resolvedInput, { encoding: 'utf8' }) as string) : (input.data?.markdown || '');

  switch (input.action) {
    case 'assemble':
    case 'render':
      if (input.type === 'excel') {
        logger.info(`📊 [MEDIA] Generating Excel: ${input.output_path}`);
        const dynamicData = input.data.dynamic_data || input.data.rows || [];
        const protocol = input.data.protocol || { version: '1.0.0', theme: {}, sheets: input.data.sheets || [] };
        const workbook = await excelUtils.generateExcelWithDesign(dynamicData, protocol, input.data.sheet_name || 'Sheet1');
        await workbook.xlsx.writeFile(resolvedOutput);
        return { status: 'success', path: input.output_path };
      }
      
      if (input.type === 'pdf') {
        logger.info(`📄 [MEDIA] Generating PDF: ${input.output_path}`);
        const html = await marked.parse(markdownContent);
        const fullHtml = `<html><head><style>body { font-family: sans-serif; padding: 40px; }</style></head><body>${html}</body></html>`;
        const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
        const page = await browser.newPage();
        await page.setContent(fullHtml, { waitUntil: 'networkidle0' });
        await page.pdf({ path: resolvedOutput, format: 'A4', printBackground: true });
        await browser.close();
        return { status: 'success', path: input.output_path };
      }

      if (input.type === 'word') {
        logger.info(`📝 [MEDIA] Generating Word: ${input.output_path}`);
        const buffer = await generateWordContent(markdownContent, input.data?.specs || {});
        safeWriteFile(resolvedOutput, buffer);
        return { status: 'success', path: input.output_path };
      }
      break;

    case 'extract':
      if (input.type === 'excel') return await excelUtils.distillExcelDesign(resolvedInput);
      if (input.type === 'ppt') return await pptxUtils.distillPptxDesign(resolvedInput);
      return await extract(resolvedInput, input.options?.mode || 'all');

    default:
      throw new Error(`Unsupported action: ${input.action}`);
  }
}

const main = async () => {
  const argv = await createStandardYargs().option('input', { alias: 'i', type: 'string', required: true }).parseSync();
  const inputData = JSON.parse(safeReadFile(path.resolve(process.cwd(), argv.input as string), { encoding: 'utf8' }) as string) as MediaAction;
  const result = await handleAction(inputData);
  console.log(JSON.stringify(result, null, 2));
};

if (require.main === module) {
  main().catch(err => {
    logger.error(err.message);
    process.exit(1);
  });
}
