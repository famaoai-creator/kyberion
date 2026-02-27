import { execSync } from 'node:child_process';
import * as path from 'node:path';

export function routeDocumentGeneration(
  format: string,
  input: string,
  output: string,
  rootDir: string
): string {
  const map: Record<string, string> = {
    pdf: 'media/pdf-composer/scripts/compose.cjs',
    html: 'media/html-reporter/scripts/report.cjs',
    docx: 'media/word-artisan/scripts/convert.cjs',
    xlsx: 'media/excel-artisan/scripts/html_to_excel.cjs',
    pptx: 'media/ppt-artisan/scripts/convert.cjs',
  };

  const scriptRelPath = map[format];
  if (!scriptRelPath) throw new Error('Unsupported format: ' + format);

  const scriptPath = path.join(rootDir, 'skills', scriptRelPath);
  const command = 'node "' + scriptPath + '" --input "' + input + '" --out "' + output + '"';

  return execSync(command, { encoding: 'utf8' });
}
