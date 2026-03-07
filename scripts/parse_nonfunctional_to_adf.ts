import * as fs from 'node:fs';
import * as path from 'node:path';

const mdPath = path.join(process.cwd(), 'knowledge/nonfunctional/nonfunctional_requirements.md');
const content = fs.readFileSync(mdPath, 'utf8');

function parseMarkdownTables(content: string) {
  const sections = content.split('\n## ');
  const sheets: any[] = [];

  sections.slice(1).forEach(section => {
    const lines = section.split('\n');
    const title = lines[0].trim();
    const rows: string[][] = [];

    let tableStarted = false;
    lines.forEach(line => {
      if (line.includes('|') && line.includes('ID')) {
        tableStarted = true;
        // Header
        const headers = line.split('|').filter(c => c.trim()).map(c => c.trim());
        rows.push(headers);
      } else if (tableStarted && line.includes('|') && !line.includes('---')) {
        const cells = line.split('|').filter(c => c.trim()).map(c => c.trim().replace(/\*\*/g, ''));
        rows.push(cells);
      } else if (tableStarted && !line.includes('|')) {
        tableStarted = false;
      }
    });

    if (rows.length > 0) {
      sheets.push({
        name: title.substring(0, 31), // Excel sheet name limit
        rows: rows
      });
    }
  });

  return sheets;
}

const sheets = parseMarkdownTables(content);
const adf = {
  sheets: sheets,
  specs: {
    master_name: 'Kyberion-Standard',
    layout: { hide_gridlines: false, default_column_width: 25 },
    styles: {
      header: { font: { bold: true, color: { argb: 'FFFFFFFF' } }, fill: { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF4472C4' } } }
    }
  }
};

fs.writeFileSync('scratch/nonfunctional_adf.json', JSON.stringify(adf, null, 2));
console.log('ADF generated at scratch/nonfunctional_adf.json');
