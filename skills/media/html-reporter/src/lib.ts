const { marked } = require('marked');
import { DocumentArtifact } from '@agent/core/shared-business-types';

export interface ReportConfig {
  title: string;
  lang?: string;
  styles?: string;
}

export const DEFAULT_STYLES = `
    body { font-family: sans-serif; max-width: 800px; margin: 0 auto; padding: 2rem; line-height: 1.6; }
    h1, h2, h3 { color: #333; }
    code { background: #f4f4f4; padding: 0.2rem 0.4rem; border-radius: 4px; }
    pre { background: #f4f4f4; padding: 1rem; overflow-x: auto; }
    table { border-collapse: collapse; width: 100%; margin-bottom: 1rem; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #f2f2f2; }
`;

export function escapeHTML(str: string): string {
  return str.replace(
    /[&<>"']/g,
    (m) =>
      ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;',
      })[m] || m
  );
}

/**
 * Generates an HTML DocumentArtifact from a Markdown DocumentArtifact.
 */
export async function generateHTMLArtifact(
  input: DocumentArtifact,
  config: Partial<ReportConfig> = {}
): Promise<DocumentArtifact> {
  const body = await marked.parse(input.body);
  const title = escapeHTML(config.title || input.title);
  const lang = config.lang || 'ja';
  const styles = config.styles || DEFAULT_STYLES;

  const html = `
<!DOCTYPE html>
<html lang="${lang}">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <meta http-equiv="X-UA-Compatible" content="ie=edge">
    <title>${title}</title>
    <style>
${styles}
    </style>
</head>
<body>
    <main>
        ${body}
    </main>
</body>
</html>`.trim();

  return {
    title,
    body: html,
    format: 'html',
    metadata: { source: input.title, lang },
  };
}
