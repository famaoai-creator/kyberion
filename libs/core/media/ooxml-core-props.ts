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

/** Strip XML/HTML tags with a linear scan (no regex — avoids ReDoS / incomplete sanitizers). */
function stripXmlTags(value: string): string {
  let out = '';
  let inTag = false;
  for (let i = 0; i < value.length; i += 1) {
    const ch = value[i];
    if (ch === '<') {
      inTag = true;
      continue;
    }
    if (ch === '>') {
      inTag = false;
      continue;
    }
    if (!inTag) out += ch;
  }
  return out;
}

/**
 * Find `<dc:name>…</dc:name>` (optional prefix) via index scans.
 * OOXML core props are small; avoid nested/backtracking regexes on zip input.
 */
function readDcElement(coreXml: string, localName: string): string | undefined {
  const lower = coreXml.toLowerCase();
  const bare = localName.toLowerCase();
  // Prefer namespaced Dublin Core; fall back to unprefixed.
  const openCandidates = [`<dc:${bare}`, `<${bare}`];
  let openAt = -1;
  let openToken = '';
  for (const token of openCandidates) {
    let from = 0;
    while (from < lower.length) {
      const idx = lower.indexOf(token, from);
      if (idx === -1) break;
      const after = lower[idx + token.length];
      // Require tag boundary: end of name, then space/>/attributes — not `titleFoo`.
      if (after === undefined || after === '>' || after === '/' || /\s/.test(after)) {
        openAt = idx;
        openToken = token;
        break;
      }
      from = idx + token.length;
    }
    if (openAt !== -1) break;
  }
  if (openAt === -1) return undefined;

  const openEnd = coreXml.indexOf('>', openAt);
  if (openEnd === -1) return undefined;
  // Self-closing / empty element.
  if (coreXml[openEnd - 1] === '/') return undefined;

  const closeToken = openToken.startsWith('<dc:') ? `</dc:${bare}>` : `</${bare}>`;
  const closeAt = lower.indexOf(closeToken, openEnd + 1);
  if (closeAt === -1) return undefined;

  const text = decodeEntities(stripXmlTags(coreXml.slice(openEnd + 1, closeAt))).trim();
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
