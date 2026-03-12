/**
 * Relationship (.rels) generators for XLSX packages
 */

const NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const RT = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';

export function generateGlobalRels(): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS}">
  <Relationship Id="rId1" Type="${RT}/officeDocument" Target="xl/workbook.xml"/>
  <Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="${RT}/extended-properties" Target="docProps/app.xml"/>
</Relationships>`;
}

export function generateWorkbookRels(sheetCount: number): string {
  let rId = 1;
  let rels = '';
  for (let i = 1; i <= sheetCount; i++) {
    rels += `  <Relationship Id="rId${rId++}" Type="${RT}/worksheet" Target="worksheets/sheet${i}.xml"/>\n`;
  }
  rels += `  <Relationship Id="rId${rId++}" Type="${RT}/theme" Target="theme/theme1.xml"/>\n`;
  rels += `  <Relationship Id="rId${rId++}" Type="${RT}/styles" Target="styles.xml"/>\n`;
  rels += `  <Relationship Id="rId${rId++}" Type="${RT}/sharedStrings" Target="sharedStrings.xml"/>\n`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS}">
${rels}</Relationships>`;
}

export function generateSheetRels(extras: Array<{ id: string; type: string; target: string }>): string {
  if (extras.length === 0) return '';
  let rels = '';
  for (const ex of extras) {
    rels += `  <Relationship Id="${ex.id}" Type="${RT}/${ex.type}" Target="${ex.target}"/>\n`;
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="${NS}">
${rels}</Relationships>`;
}
