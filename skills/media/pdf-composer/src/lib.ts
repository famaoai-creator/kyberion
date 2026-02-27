import fs from 'fs';
import puppeteer from 'puppeteer';
import { marked } from 'marked';
import { DocumentArtifact } from '@agent/core/shared-business-types';

export interface PDFOptions {
  outputPath: string;
  theme?: DocumentArtifact; // Shared artifact for CSS
  format?: puppeteer.PaperFormat;
  margin?: { top: string; bottom: string; left: string; right: string };
}

export interface PDFResult {
  output: string;
  theme: string;
}

/**
 * composes a PDF from a DocumentArtifact (Markdown or HTML).
 */
export async function composePDF(
  artifact: DocumentArtifact,
  options: PDFOptions
): Promise<PDFResult> {
  let htmlBody = '';
  if (artifact.format === 'html') {
    htmlBody = artifact.body;
  } else {
    htmlBody = await marked.parse(artifact.body);
  }

  const cssStyle = options.theme ? options.theme.body : '';

  const htmlContent = `
<!DOCTYPE html>
<html>
<head>
    <meta charset="UTF-8">
    <style>${cssStyle}</style>
</head>
<body>
    ${htmlBody}
</body>
</html>`;

  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setContent(htmlContent, { waitUntil: 'networkidle0' });

    await page.pdf({
      path: options.outputPath,
      format: options.format || 'A4',
      margin: options.margin || { top: '20mm', bottom: '20mm', left: '20mm', right: '20mm' },
      printBackground: true,
    });

    return {
      output: options.outputPath,
      theme: options.theme ? options.theme.title : 'default',
    };
  } finally {
    await browser.close();
  }
}
