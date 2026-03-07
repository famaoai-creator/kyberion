import { marked } from 'marked';
import HTMLtoDOCX from 'html-to-docx';
import { DocumentArtifact } from '@agent/core/shared-business-types';

export interface WordMasterSpecs {
  master_name: string;
  typography: {
    body: { font: string; size: number; line_height: string; color: string };
    heading_1: { size: number; alignment: string; color: string };
    heading_2: { size: number; border_bottom: string; color: string };
  };
  table_style: {
    header_bg: string;
    border_color: string;
  };
  layout: {
    margins: { top: number; right?: number; bottom?: number; left?: number };
  };
}

/**
 * Generates a Word document buffer from Markdown.
 */
export async function generateWordArtifact(
  artifact: DocumentArtifact,
  specs: WordMasterSpecs
): Promise<Buffer> {
  try {
    const t = specs.typography;
    const htmlBody = await marked.parse(artifact.body || '');

    const fullHtml = `<!DOCTYPE html>
      <html lang="ja">
      <head>
        <meta charset="UTF-8">
        <style>
          body { font-family: ${t.body.font}; font-size: ${t.body.size}pt; line-height: ${t.body.line_height}; color: ${t.body.color}; }
          h1 { font-size: ${t.heading_1.size}pt; text-align: ${t.heading_1.alignment}; color: ${t.heading_1.color}; }
          h2 { font-size: ${t.heading_2.size}pt; border-bottom: ${t.heading_2.border_bottom}; color: ${t.heading_2.color}; margin-top: 30px; }
          table { width: 100%; border-collapse: collapse; }
          th { background-color: ${specs.table_style.header_bg}; border: 1px solid ${specs.table_style.border_color}; padding: 8px; }
          td { border: 1px solid ${specs.table_style.border_color}; padding: 8px; }
        </style>
      </head>
      <body>${htmlBody}</body>
      </html>`;

    const options = {
      title: artifact.title,
      margins: specs.layout.margins,
      fontSize: t.body.size * 2, // html-to-docx points
    };

    return await HTMLtoDOCX(fullHtml, null, options);
  } catch (err: any) {
    throw new Error(`Word generation failed: ${err.message}`);
  }
}

/**
 * Wrapper for the CLI.
 */
export async function generateWordContent(markdown: string, specs: WordMasterSpecs): Promise<Buffer> {
  const artifact: DocumentArtifact = {
    title: 'Document',
    body: markdown,
    format: 'markdown',
  };
  return await generateWordArtifact(artifact, specs);
}
