import { marked } from 'marked';
import HTMLtoDOCX from 'html-to-docx';
import { DocumentArtifact } from '@agent/core/shared-business-types';

export interface TypographyElement {
  font?: string;
  size: number;
  line_height?: string;
  color?: string;
  alignment?: string;
  border_bottom?: string;
}

export interface WordMasterSpecs {
  master_name: string;
  typography: {
    body: TypographyElement;
    heading_1: TypographyElement;
    heading_2: TypographyElement;
  };
  table_style: {
    header_bg: string;
    border_color: string;
  };
  layout: any;
}

/**
 * Generates a Word document Buffer from a DocumentArtifact (Markdown).
 */
export async function generateWordArtifact(
  artifact: DocumentArtifact,
  specs: WordMasterSpecs
): Promise<Buffer> {
  const htmlBody = await marked.parse(artifact.body);
  const t = specs.typography;

  const fullHtml = `<!DOCTYPE html>
    <html lang="ja">
    <head>
      <meta charset="UTF-8">
      <style>
        body { font-family: ${t.body.font || 'Arial'}, serif; font-size: ${t.body.size}pt; line-height: ${t.body.line_height || '1.5'}; color: ${t.body.color || '#000'}; }
        h1 { font-size: ${t.heading_1.size}pt; text-align: ${t.heading_1.alignment || 'left'}; color: ${t.heading_1.color || '#000'}; }
        h2 { font-size: ${t.heading_2.size}pt; border-bottom: ${t.heading_2.border_bottom || 'none'}; color: ${t.heading_2.color || '#000'}; margin-top: 30px; }
        table { width: 100%; border-collapse: collapse; }
        th { background-color: ${specs.table_style.header_bg}; border: 1px solid ${specs.table_style.border_color}; padding: 8px; }
        td { border: 1px solid ${specs.table_style.border_color}; padding: 8px; }
      </style>
    </head>
    <body>${htmlBody}</body>
    </html>`;

  try {
    const fileBuffer = await HTMLtoDOCX(fullHtml, null, {
      title: artifact.title,
      ...specs.layout,
      fontSize: Math.max(8, Math.min(72, t.body.size || 11)) * 2,
    });
    return fileBuffer as Buffer;
  } catch (err: any) {
    throw new Error(`Word generation failed: ${err.message}`);
  }
}
