import { execFileSync } from 'node:child_process';
import { xlsxUtils } from '@agent/core';
import type { Aesthetic, ExtractionMode, ExtractionOptions, ExtractionResult } from './extraction-engine.js';
import { collectXmlCaptures } from './xml-utils.js';

export async function processXlsx(
  filePath: string,
  mode: ExtractionMode,
  result: ExtractionResult,
  options: ExtractionOptions = {},
) {
  const workbook = readWorkbook(filePath);

  if (mode === 'content' || mode === 'all') {
    result.layers.content = extractContent(workbook, filePath);
  }

  if (mode === 'metadata' || mode === 'all') {
    result.layers.metadata = extractMetadata(workbook, filePath);
  }

  if (mode === 'aesthetic' || mode === 'all') {
    result.layers.aesthetic = extractAesthetic(filePath);
  }

  if (mode === 'raw' || options.preserveRaw) {
    result.layers.raw = await xlsxUtils.distillXlsxDesign(filePath);
  }
}

type WorkbookSheet = {
  name: string;
  path: string;
};

type WorkbookInfo = {
  sheets: WorkbookSheet[];
  creator?: string;
  lastModifiedBy?: string;
  created?: string;
  modified?: string;
  company?: string;
  subject?: string;
  title?: string;
};

type SharedStrings = string[];

type ParsedSheet = {
  name: string;
  rows: string[][];
};

function readWorkbook(filePath: string): WorkbookInfo {
  const workbookXml = readZipEntryText(filePath, 'xl/workbook.xml');
  const workbookRelsXml = readZipEntryText(filePath, 'xl/_rels/workbook.xml.rels');
  const corePropsXml = readZipEntryText(filePath, 'docProps/core.xml');
  const appPropsXml = readZipEntryText(filePath, 'docProps/app.xml');

  const relTargets = new Map<string, string>();
  for (const match of workbookRelsXml.matchAll(/<Relationship[^>]*Id="([^"]+)"[^>]*Target="([^"]+)"/g)) {
    relTargets.set(match[1], match[2]);
  }

  const sheets: WorkbookSheet[] = [];
  for (const match of workbookXml.matchAll(/<sheet[^>]*name="([^"]+)"[^>]*r:id="([^"]+)"/g)) {
    const target = relTargets.get(match[2]);
    if (!target) continue;
    sheets.push({
      name: decodeXmlText(match[1]),
      path: target.startsWith('xl/') ? target : `xl/${target.replace(/^\/+/, '')}`,
    });
  }

  return {
    sheets,
    creator: firstCapture(corePropsXml, /<dc:creator>([\s\S]*?)<\/dc:creator>/),
    lastModifiedBy: firstCapture(corePropsXml, /<cp:lastModifiedBy>([\s\S]*?)<\/cp:lastModifiedBy>/),
    created: firstCapture(corePropsXml, /<dcterms:created[^>]*>([\s\S]*?)<\/dcterms:created>/),
    modified: firstCapture(corePropsXml, /<dcterms:modified[^>]*>([\s\S]*?)<\/dcterms:modified>/),
    company: firstCapture(appPropsXml, /<Company>([\s\S]*?)<\/Company>/),
    subject: firstCapture(corePropsXml, /<dc:subject>([\s\S]*?)<\/dc:subject>/),
    title: firstCapture(corePropsXml, /<dc:title>([\s\S]*?)<\/dc:title>/),
  };
}

function extractContent(workbook: WorkbookInfo, filePath: string): string {
  return workbook.sheets
    .map(sheet => {
      const parsed = parseSheet(filePath, sheet);
      return [`### Sheet: ${sheet.name}`, '', ...parsed.rows.map(rowToCsv)].join('\n');
    })
    .join('\n\n')
    .trim();
}

function extractMetadata(workbook: WorkbookInfo, filePath: string) {
  return {
    sheets: workbook.sheets.map(sheet => sheet.name),
    props: {
      creator: workbook.creator,
      lastModifiedBy: workbook.lastModifiedBy,
      created: workbook.created,
      modified: workbook.modified,
      company: workbook.company,
      subject: workbook.subject,
      title: workbook.title,
    },
    workbook: {
      definedNames: collectXmlCaptures(readZipEntryText(filePath, 'xl/workbook.xml'), /<definedName[^>]*>([\s\S]*?)<\/definedName>/g).map(decodeXmlText),
    },
  };
}

function extractAesthetic(filePath: string): Aesthetic {
  return {
    layout: 'grid',
    branding: { logo_presence: false, tone: 'technical' },
    table_styles: Array.from(collectTableStyles(filePath)),
  };
}

function collectTableStyles(filePath: string): Set<string> {
  const tableStyles = new Set<string>();
  const stylesXml = readZipEntryText(filePath, 'xl/styles.xml');
  if (!stylesXml) return tableStyles;

  for (const styleName of collectXmlCaptures(stylesXml, /defaultTableStyle="([^"]+)"/g)) {
    tableStyles.add(styleName);
  }

  for (const styleName of collectXmlCaptures(stylesXml, /<tableStyle name="([^"]+)"/g)) {
    tableStyles.add(styleName);
  }

  return tableStyles;
}

function parseSheet(filePath: string, sheet: WorkbookSheet): ParsedSheet {
  const sheetXml = readZipEntryText(filePath, sheet.path);
  if (!sheetXml) {
    return { name: sheet.name, rows: [] };
  }

  const sharedStrings = readSharedStrings(filePath);
  const rowMatches = [...sheetXml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)];
  const rows = rowMatches.map(match => parseRow(match[1] ?? '', sharedStrings));

  return { name: sheet.name, rows };
}

function readSharedStrings(filePath: string): SharedStrings {
  const sharedXml = readZipEntryText(filePath, 'xl/sharedStrings.xml');
  if (!sharedXml) return [];

  return [...sharedXml.matchAll(/<si[\s\S]*?<\/si>/g)].map(match => {
    const block = match[0] ?? '';
    const textParts = collectXmlCaptures(block, /<t[^>]*>([\s\S]*?)<\/t>/g).map(decodeXmlText);
    return textParts.join('');
  });
}

function parseRow(rowXml: string, sharedStrings: SharedStrings): string[] {
  const cells: Array<{ index: number; value: string }> = [];
  for (const match of rowXml.matchAll(/<c([^>]*)>([\s\S]*?)<\/c>/g)) {
    const attrs = match[1] ?? '';
    const body = match[2] ?? '';
    const ref = firstCapture(attrs, /r="([A-Z]+)(\d+)"/) ?? firstCapture(match[0] ?? '', /r="([A-Z]+)(\d+)"/);
    if (!ref) continue;
    const columnIndex = columnLettersToNumber(ref);
    cells.push({ index: columnIndex, value: parseCellValue(attrs, body, sharedStrings) });
  }

  const row: string[] = [];
  for (const cell of cells) {
    row[cell.index - 1] = cell.value;
  }
  return row;
}

function parseCellValue(attrs: string, body: string, sharedStrings: SharedStrings): string {
  const cellType = firstCapture(attrs, /t="([^"]+)"/);
  if (cellType === 'inlineStr') {
    return collectXmlCaptures(body, /<t[^>]*>([\s\S]*?)<\/t>/g).map(decodeXmlText).join('');
  }

  const rawValue = firstCapture(body, /<v>([\s\S]*?)<\/v>/);
  if (rawValue === undefined) {
    return collectXmlCaptures(body, /<t[^>]*>([\s\S]*?)<\/t>/g).map(decodeXmlText).join('');
  }

  if (cellType === 's') {
    const sharedIndex = Number.parseInt(rawValue, 10);
    return sharedStrings[sharedIndex] ?? '';
  }

  return decodeXmlText(rawValue);
}

function rowToCsv(cells: string[]): string {
  return cells.map(cell => csvEscape(cell ?? '')).join(',');
}

function csvEscape(value: string): string {
  if (value === '') return '';
  if (/[",\n\r]/.test(value)) return `"${value.replace(/"/g, '""')}"`;
  return value;
}

function readZipEntryText(filePath: string, entryName: string): string {
  try {
    return execFileSync('unzip', ['-p', filePath, entryName], {
      encoding: 'utf8',
      maxBuffer: 20 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).toString();
  } catch {
    return '';
  }
}

function firstCapture(xml: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(xml);
  return match?.[1];
}

function decodeXmlText(value: string): string {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'");
}

function columnLettersToNumber(ref: string): number {
  const letters = ref.match(/^[A-Z]+/)?.[0] ?? '';
  let value = 0;
  for (const char of letters) {
    value = value * 26 + (char.charCodeAt(0) - 64);
  }
  return value;
}
