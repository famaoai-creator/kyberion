/**
 * Native PDF Engine
 * Generates PDF files from PdfDesignProtocol (ADF) using Puppeteer.
 * Follows the same architecture pattern as native-pptx-engine / native-xlsx-engine.
 *
 * Unlike Office formats (PPTX/XLSX/DOCX) which are ZIP+XML,
 * PDF generation delegates to a headless browser for high-fidelity rendering.
 */
import * as fs from 'fs';
import * as path from 'path';
import type { PdfDesignProtocol, PdfCompositionOptions } from '../types/pdf-protocol';

/**
 * Generate a PDF from a PdfDesignProtocol.
 * Converts source (Markdown or HTML) to PDF via Puppeteer.
 */
export async function generateNativePdf(
  protocol: PdfDesignProtocol,
  outputPath: string,
  optionOverrides?: Partial<PdfCompositionOptions>
): Promise<void> {
  if (!protocol?.source?.body) {
    throw new Error('generateNativePdf: protocol must have source.body content');
  }

  const dir = path.dirname(outputPath);
  if (!fs.existsSync(dir)) {
    throw new Error(`generateNativePdf: output directory does not exist: ${dir}`);
  }

  // Merge composition options: protocol-level → overrides → defaults
  const opts: PdfCompositionOptions = {
    format: 'A4',
    margin: { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
    printBackground: true,
    ...protocol.compositionOptions,
    ...optionOverrides,
    outputPath, // Always use the provided outputPath
  };

  // Convert source body to HTML
  let htmlBody: string;
  if (protocol.source.format === 'html') {
    htmlBody = protocol.source.body;
  } else {
    // Markdown → HTML
    const { marked } = await import('marked');
    htmlBody = await marked.parse(protocol.source.body);
  }

  // Build full HTML document
  const cssStyle = opts.theme?.body || getDefaultCss();
  const htmlContent = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8">
  <style>${cssStyle}</style>
</head>
<body>
  ${htmlBody}
</body>
</html>`;

  // Render via Puppeteer
  const puppeteer = await import('puppeteer');
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });
    await page.pdf({
      path: opts.outputPath,
      format: opts.format || 'A4',
      margin: opts.margin,
      printBackground: opts.printBackground !== false,
      landscape: opts.landscape || false,
      headerTemplate: opts.headerHtml || '',
      footerTemplate: opts.footerHtml || '',
      displayHeaderFooter: !!(opts.headerHtml || opts.footerHtml),
    });
  } finally {
    await browser.close();
  }
}

/**
 * Default CSS for professional-looking PDF output.
 */
function getDefaultCss(): string {
  return `
    body {
      font-family: 'Noto Sans JP', 'Hiragino Kaku Gothic ProN', 'Yu Gothic', sans-serif;
      font-size: 11pt;
      line-height: 1.6;
      color: #1a1a1a;
    }
    h1 { font-size: 22pt; margin-top: 0; border-bottom: 2px solid #2563eb; padding-bottom: 8px; }
    h2 { font-size: 16pt; margin-top: 24px; color: #1e3a5f; }
    h3 { font-size: 13pt; margin-top: 16px; }
    table { border-collapse: collapse; width: 100%; margin: 12px 0; }
    th, td { border: 1px solid #d5dbdb; padding: 6px 10px; text-align: left; }
    th { background-color: #232f3e; color: #fff; font-weight: bold; }
    tr:nth-child(even) td { background-color: #f4f7f9; }
    code { background: #f0f0f0; padding: 2px 4px; border-radius: 3px; font-size: 10pt; }
    pre { background: #f8f9fa; border: 1px solid #e0e0e0; padding: 12px; border-radius: 4px; overflow-x: auto; }
    blockquote { border-left: 4px solid #2563eb; margin: 12px 0; padding: 8px 16px; background: #f8f9fa; }
    a { color: #2563eb; }
  `;
}
