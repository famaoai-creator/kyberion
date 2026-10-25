/**
 * Read package core properties (`docProps/core.xml`) from an OOXML zip
 * (docx / pptx / xlsx). Shared by `kyberion read` so File → Properties titles
 * surface the same way PDF Info / XMP titles do.
 */
import AdmZip from 'adm-zip';
import { decodeEntities } from '../text-escaping.js';

/** Writer placeholders — never treat these as a real document title. */
export const OOXML_PLACEHOLDER_TITLES = new Set([
  '',
  'Kyberion Native Document',
  'Kyberion Native Presentation',
  'Kyberion Native Spreadsheet',
]);

export interface OoxmlCoreProperties {
  title?: string;
  /** Present for callers that need it; `kyberion read` does not surface creator (often a person). */
  creator?: string;
  subject?: string;
}

function readDcElement(coreXml: string, localName: string): string | undefined {
  const match = coreXml.match(
    new RegExp(`<(?:\\w+:)?${localName}\\b[^>]*>([\\s\\S]*?)</(?:\\w+:)?${localName}>`, 'i')
  );
  if (!match) return undefined;
  const text = decodeEntities(match[1].replace(/<[^>]+>/g, '')).trim();
  return text || undefined;
}

/** Parse a `docProps/core.xml` body into plain fields. */
export function parseOoxmlCorePropertiesXml(coreXml: string): OoxmlCoreProperties {
  const result: OoxmlCoreProperties = {};
  const title = readDcElement(coreXml, 'title');
  if (title && !OOXML_PLACEHOLDER_TITLES.has(title)) result.title = title;
  const creator = readDcElement(coreXml, 'creator');
  if (creator) result.creator = creator;
  const subject = readDcElement(coreXml, 'subject');
  if (subject) result.subject = subject;
  return result;
}

/** Read core properties from OOXML package bytes. Missing / corrupt → `{}`. */
export function extractOoxmlCoreProperties(raw: Buffer): OoxmlCoreProperties {
  try {
    const zip = new AdmZip(raw);
    const entry =
      zip.getEntry('docProps/core.xml') ||
      zip.getEntry('/docProps/core.xml') ||
      zip.getEntry('docProps\\core.xml');
    if (!entry) return {};
    return parseOoxmlCorePropertiesXml(entry.getData().toString('utf8'));
  } catch {
    return {};
  }
}

/** Real document title from package properties, or `undefined`. */
export function extractOoxmlCoreTitle(raw: Buffer): string | undefined {
  return extractOoxmlCoreProperties(raw).title;
}
