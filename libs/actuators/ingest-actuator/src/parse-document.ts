/**
 * DA-04 ingest:parse_document — unstructured document → unified ingest IR.
 *
 * Pure capture: reads the raw input (file path / base64 / text), parses it
 * with the vendored libraries (mammoth for docx, pdf-parse for pdf, exceljs
 * for xlsx, the native PPTX engine for pptx, a minimal deterministic
 * converter for html — turndown is not vendored) and returns the
 * intermediate representation. PPTX image OCR is opt-in (`ocr: true`) and
 * local-only: board and report decks carry their figures as pasted images. Never writes into
 * knowledge/ — the knowledge landing is DA-05's ingest:commit.
 *
 * content_sha256 is computed over the RAW input bytes (before any parsing)
 * so ingest:dedup can detect exact re-ingests of the same source document.
 */

import * as path from 'node:path';
import { createHash } from 'node:crypto';
import mammoth from 'mammoth';
import ExcelJS from 'exceljs';
import { pathResolver } from '@agent/core/path-resolver';
import { assertReadableOfficeBytes, readDocument } from '@agent/core/document-reader';
import { parseSafeJsonInput } from '@agent/core/foundation';
import {
  assertSafeRepositoryPath,
  safeExistsSync,
  safeLstat,
  safeReadFile,
} from '@agent/core/secure-io';
import { htmlToMarkdown } from '@agent/core/html-to-markdown';

export type IngestFormat =
  'docx' | 'pdf' | 'xlsx' | 'pptx' | 'html' | 'slack_thread' | 'markdown' | 'text';

export interface IngestSourceMeta {
  source_system?: string;
  source_id?: string;
  source_url?: string;
  source_version?: string;
  retrieved_at?: string;
}

export interface IngestSection {
  heading: string;
  level: number;
  text: string;
}

export interface IngestTable {
  name?: string;
  markdown: string;
}

export interface IngestIr {
  title?: string;
  text_markdown: string;
  sections?: IngestSection[];
  tables?: IngestTable[];
  meta: IngestSourceMeta & {
    format: IngestFormat;
    content_sha256: string;
    char_count: number;
  };
}

export interface ParseDocumentInput {
  source_path?: string;
  content_base64?: string;
  content_text?: string;
  format: IngestFormat;
  source_meta?: IngestSourceMeta;
  /** pptx/pdf/docx: OCR embedded images (local providers only). */
  ocr?: boolean;
}

interface SlackMessage {
  user?: string;
  ts?: string;
  text?: string;
}

// mammoth's bundled .d.ts predates its own convertToMarkdown export (present
// in lib/index.js since 1.x) — augment locally, same as media-actuator.
type MammothWithMarkdown = typeof mammoth & {
  convertToMarkdown: (
    input: { buffer: Buffer },
    options?: { convertImage?: unknown }
  ) => Promise<{ value: string; messages: unknown[] }>;
};

function resolveRawBytes(input: ParseDocumentInput): Buffer {
  if (input.source_path) {
    const absPath = assertSafeRepositoryPath(pathResolver.rootResolve(input.source_path), {
      allowMissingLeaf: true,
    });
    if (!safeExistsSync(absPath)) {
      throw new Error(`ingest:parse_document — source_path not found: ${absPath}`);
    }
    if (!safeLstat(absPath).isFile()) {
      throw new Error(`ingest:parse_document — source_path must be a regular file: ${absPath}`);
    }
    return safeReadFile(absPath, { encoding: null }) as Buffer;
  }
  if (input.content_base64) {
    return Buffer.from(input.content_base64, 'base64');
  }
  if (input.content_text !== undefined) {
    return Buffer.from(input.content_text, 'utf8');
  }
  throw new Error(
    'ingest:parse_document — one of source_path, content_base64 or content_text is required'
  );
}

/** Collapse 3+ blank-separated runs and trim — keeps goldens stable. */
function normalizeMarkdown(markdown: string): string {
  return markdown
    .replace(/\r\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function extractTitle(markdown: string): string | undefined {
  for (const line of markdown.split('\n')) {
    const match = /^#\s+(.+)$/.exec(line.trim());
    if (match) return match[1].trim();
  }
  return undefined;
}

function extractSections(markdown: string): IngestSection[] | undefined {
  const sections: IngestSection[] = [];
  let current: IngestSection | null = null;
  for (const line of markdown.split('\n')) {
    const match = /^(#{1,6})\s+(.+)$/.exec(line);
    if (match) {
      if (current) {
        current.text = current.text.trim();
        sections.push(current);
      }
      current = { heading: match[2].trim(), level: match[1].length, text: '' };
      continue;
    }
    if (current) current.text += `${line}\n`;
  }
  if (current) {
    current.text = current.text.trim();
    sections.push(current);
  }
  return sections.length > 0 ? sections : undefined;
}

/**
 * Fallback docx reader (mammoth) for documents the native reader rejects.
 * Images become `[image]` markers instead of mammoth's default base64 data
 * URIs (one image-heavy document once produced an 11 MB card).
 */
async function parseDocx(raw: Buffer): Promise<string> {
  const convertImage = mammoth.images.imgElement(async () => ({ src: 'kyberion-docx-image' }));
  try {
    const result = await (mammoth as MammothWithMarkdown).convertToMarkdown(
      { buffer: raw },
      { convertImage }
    );
    return result.value.replace(/!\[[^\]]*\]\(kyberion-docx-image\)/g, '_[image]_');
  } catch {
    const result = await mammoth.extractRawText({ buffer: raw });
    return result.value;
  }
}

function excelCellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return '';
  if (value instanceof Date) return value.toISOString();
  if (typeof value === 'object') {
    const rich = value as { richText?: Array<{ text?: string }> };
    if (Array.isArray(rich.richText)) {
      return rich.richText.map((run) => String(run.text ?? '')).join('');
    }
    const formula = value as { result?: unknown };
    if (formula.result !== undefined) return excelCellText(formula.result as ExcelJS.CellValue);
    const hyperlink = value as { text?: unknown };
    if (hyperlink.text !== undefined) return String(hyperlink.text);
    return JSON.stringify(value);
  }
  return String(value);
}

async function parseXlsx(raw: Buffer): Promise<{ markdown: string; tables: IngestTable[] }> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(raw as unknown as ArrayBuffer);
  const tables: IngestTable[] = [];
  const chunks: string[] = [];
  workbook.eachSheet((sheet) => {
    const rows: string[][] = [];
    sheet.eachRow({ includeEmpty: false }, (row) => {
      const cells: string[] = [];
      for (let col = 1; col <= sheet.columnCount; col += 1) {
        const cell = row.getCell(col);
        // exceljs reports a merged range's value on every cell of the range;
        // only the top-left master keeps it, so a banner row is not repeated
        // across every column.
        const isMergedSlave = cell.isMerged && cell.master && cell.master.address !== cell.address;
        cells.push(
          isMergedSlave
            ? ''
            : excelCellText(cell.value).replace(/\r?\n/g, '<br>').replace(/\|/g, '\\|')
        );
      }
      rows.push(cells);
    });
    if (rows.length === 0) return;
    const width = Math.max(...rows.map((row) => row.length));
    const pad = (row: string[]) => Array.from({ length: width }, (_, i) => row[i] ?? '');
    const lines = [
      `| ${pad(rows[0]).join(' | ')} |`,
      `| ${Array.from({ length: width }, () => '---').join(' | ')} |`,
      ...rows.slice(1).map((row) => `| ${pad(row).join(' | ')} |`),
    ];
    const markdown = lines.join('\n');
    tables.push({ name: sheet.name, markdown });
    const hidden = sheet.state === 'hidden' || sheet.state === 'veryHidden';
    chunks.push(`## ${sheet.name}${hidden ? ' (hidden sheet)' : ''}\n\n${markdown}`);
  });
  return { markdown: chunks.join('\n\n'), tables };
}

/**
 * pdf / pptx / docx / xlsx go through the shared document reader
 * (@agent/core/document-reader) — the same path as `pnpm kyberion read` and
 * media:document_digest. mammoth / exceljs remain only as a fallback for a
 * docx / xlsx the native reader rejects.
 */
async function readOfficeDocument(
  raw: Buffer,
  format: 'docx' | 'pdf' | 'xlsx' | 'pptx',
  ocr: boolean
): Promise<{ markdown: string; tables: IngestTable[]; title?: string }> {
  try {
    const result = await readDocument(raw, format, { ocr });
    return { markdown: result.markdown, tables: result.tables, title: result.title };
  } catch (error) {
    if (format === 'docx') {
      const markdown = await parseDocx(raw);
      return { markdown, tables: [], title: extractTitle(markdown) };
    }
    if (format === 'xlsx') return parseXlsx(raw);
    throw error;
  }
}

function parseSlackThread(raw: Buffer): string {
  let messages: SlackMessage[];
  try {
    const parsed = parseSafeJsonInput(raw.toString('utf8'), 'ingest slack thread');
    if (!Array.isArray(parsed)) throw new Error('not an array');
    messages = parsed as SlackMessage[];
  } catch (error) {
    throw new Error(
      `ingest:parse_document — slack_thread input must be a JSON array of {user, ts, text}: ${(error as Error).message}`
    );
  }
  // Chronological transcript. Stable sort: equal ts keeps input order.
  const ordered = [...messages].sort(
    (left, right) => Number.parseFloat(left.ts ?? '0') - Number.parseFloat(right.ts ?? '0')
  );
  const lines = ordered.map((message) => {
    const text = String(message.text ?? '')
      .replace(/\r\n/g, '\n')
      .replace(/\n/g, '\n  ');
    return `- **${String(message.user ?? 'unknown')}** [${String(message.ts ?? '')}]: ${text}`;
  });
  return lines.join('\n');
}

export async function parseDocument(input: ParseDocumentInput): Promise<IngestIr> {
  if (!input || typeof input.format !== 'string') {
    throw new Error('ingest:parse_document — format is required');
  }
  const raw = resolveRawBytes(input);
  assertReadableOfficeBytes(raw, input.format);
  const contentSha256 = createHash('sha256').update(raw).digest('hex');

  let textMarkdown: string;
  let tables: IngestTable[] | undefined;
  let title: string | undefined;

  switch (input.format) {
    case 'docx':
    case 'pdf':
    case 'xlsx':
    case 'pptx': {
      const parsed = await readOfficeDocument(raw, input.format, input.ocr === true);
      textMarkdown = normalizeMarkdown(parsed.markdown);
      tables = parsed.tables.length > 0 ? parsed.tables : undefined;
      title = parsed.title;
      break;
    }
    case 'html':
      textMarkdown = normalizeMarkdown(htmlToMarkdown(raw.toString('utf8')));
      title = extractTitle(textMarkdown);
      break;
    case 'slack_thread':
      textMarkdown = normalizeMarkdown(parseSlackThread(raw));
      break;
    case 'markdown':
      textMarkdown = normalizeMarkdown(raw.toString('utf8'));
      title = extractTitle(textMarkdown);
      break;
    case 'text':
      textMarkdown = normalizeMarkdown(raw.toString('utf8'));
      break;
    default:
      throw new Error(`ingest:parse_document — unsupported format: ${String(input.format)}`);
  }

  // xlsx/text never contain an H1 to extract a title from (xlsx headings are
  // per-sheet `##`), so fall back to the source file name — otherwise
  // ingest:normalize_card rejects the card for a missing required title.
  if (title === undefined && input.source_path) {
    title = path.basename(input.source_path, path.extname(input.source_path));
  }

  const sections = extractSections(textMarkdown);
  return {
    ...(title !== undefined ? { title } : {}),
    text_markdown: textMarkdown,
    ...(sections ? { sections } : {}),
    ...(tables ? { tables } : {}),
    meta: {
      ...(input.source_meta ?? {}),
      format: input.format,
      content_sha256: contentSha256,
      char_count: textMarkdown.length,
    },
  };
}
