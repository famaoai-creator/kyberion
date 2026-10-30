/**
 * PDF outline / annotation / AcroForm / Form XObject distill (PdfCraft-aligned).
 */
import type {
  PdfAcroForm,
  PdfAnnotation,
  PdfFormField,
  PdfOutlineItem,
} from '../../contracts/pdf-protocol.js';

export type PdfStructureHost = {
  readonly str: string;
  getFullObject(id: number): string | null;
  resolveKids(parentId: number): number[];
  scanLeafPageIdsDirect(): number[];
  readPdfInfoString(source: string, name: string): string | undefined;
  decodeInfoLiteralString(input: string): string;
  decodeHexString(hex: string, fontObjectId?: number): string;
  decodeStream(id: number): string | null;
  parseTextOperators(content: string): string[];
};

export function extractOutlines(host: PdfStructureHost): PdfOutlineItem[] | undefined {
  const rootMatch = host.str.match(/\/Root\s+(\d+)\s+0\s+R/);
  if (!rootMatch) return undefined;
  const rootObj = host.getFullObject(parseInt(rootMatch[1], 10));
  if (!rootObj) return undefined;
  const outlinesRef = rootObj.match(/\/Outlines\s+(\d+)\s+0\s+R/);
  if (!outlinesRef) return undefined;
  const outlinesObj = host.getFullObject(parseInt(outlinesRef[1], 10));
  if (!outlinesObj) return undefined;
  const first = outlinesObj.match(/\/First\s+(\d+)\s+0\s+R/);
  if (!first) return undefined;

  const pagesRefMatch = rootObj.match(/\/Pages\s+(\d+)\s+0\s+R/);
  let leafPageIds = pagesRefMatch ? host.resolveKids(parseInt(pagesRefMatch[1], 10)) : [];
  if (leafPageIds.length === 0) leafPageIds = host.scanLeafPageIdsDirect();
  const pageIdToIndex = new Map<number, number>();
  leafPageIds.forEach((id, i) => pageIdToIndex.set(id, i));

  const items = walkOutlineSiblings(host, parseInt(first[1], 10), pageIdToIndex, 0);
  return items.length > 0 ? items : undefined;
}

/** Catalog `/AcroForm` field list (names / values / types). */
export function extractAcroForm(host: PdfStructureHost): PdfAcroForm | undefined {
  const rootMatch = host.str.match(/\/Root\s+(\d+)\s+0\s+R/);
  if (!rootMatch) return undefined;
  const rootObj = host.getFullObject(parseInt(rootMatch[1], 10));
  if (!rootObj) return undefined;
  const acroRef = rootObj.match(/\/AcroForm\s+(\d+)\s+0\s+R/);
  const acroObj = acroRef
    ? host.getFullObject(parseInt(acroRef[1], 10))
    : /\/AcroForm\s*<</.test(rootObj)
      ? rootObj.match(/\/AcroForm\s*(<<[\s\S]*?>>)/)?.[1]
      : undefined;
  if (!acroObj) return undefined;

  const fields: PdfFormField[] = [];
  const fieldsBlock = typeof acroObj === 'string' ? acroObj : '';
  const arrayMatch = fieldsBlock.match(/\/Fields\s*\[([^\]]*)\]/);
  if (arrayMatch) {
    const refs = arrayMatch[1].match(/(\d+)\s+0\s+R/g) || [];
    for (const ref of refs) {
      fields.push(...collectAcroFields(host, parseInt(ref, 10), ''));
    }
  }
  if (fields.length === 0) return undefined;

  const needAppearances = /\/NeedAppearances\s+true\b/.test(fieldsBlock);
  const defaultDA = host.readPdfInfoString(fieldsBlock, 'DA');
  return {
    fields,
    needAppearances: needAppearances || undefined,
    defaultDA,
  };
}
function walkOutlineSiblings(
  host: PdfStructureHost,
  firstId: number,
  pageIdToIndex: Map<number, number>,
  depth: number
): PdfOutlineItem[] {
  if (depth > 32) return [];
  const items: PdfOutlineItem[] = [];
  let id: number | undefined = firstId;
  const seen = new Set<number>();
  while (id !== undefined && !seen.has(id)) {
    seen.add(id);
    const obj = host.getFullObject(id);
    if (!obj) break;
    const title = host.readPdfInfoString(obj, 'Title') ?? '';
    const dest = resolveOutlineDest(host, obj, pageIdToIndex);
    const childFirst = obj.match(/\/First\s+(\d+)\s+0\s+R/);
    const children = childFirst
      ? walkOutlineSiblings(host, parseInt(childFirst[1], 10), pageIdToIndex, depth + 1)
      : undefined;
    const countMatch = obj.match(/\/Count\s+(-?\d+)/);
    const closed = countMatch ? parseInt(countMatch[1], 10) < 0 : undefined;
    if (title || dest || children?.length) {
      items.push({
        title,
        pageIndex: dest?.pageIndex ?? 0,
        top: dest?.top,
        zoom: dest?.zoom,
        children: children?.length ? children : undefined,
        closed: closed || undefined,
      });
    }
    const next = obj.match(/\/Next\s+(\d+)\s+0\s+R/);
    id = next ? parseInt(next[1], 10) : undefined;
  }
  return items;
}

function resolveOutlineDest(
  host: PdfStructureHost,
  obj: string,
  pageIdToIndex: Map<number, number>
): { pageIndex: number; top?: number; zoom?: number } | undefined {
  // Inline: /Dest [pageId 0 R /XYZ …]
  let destBlock = obj.match(/\/Dest\s*\[([^\]]*)\]/)?.[1];
  if (!destBlock) {
    const destRef = obj.match(/\/Dest\s+(\d+)\s+0\s+R/);
    if (destRef) {
      const destObj = host.getFullObject(parseInt(destRef[1], 10)) || '';
      destBlock = destObj.match(/\[([^\]]*)\]/)?.[1] ?? destObj;
    }
  }
  // /A << /S /GoTo /D [page …] >>
  if (!destBlock) {
    const action = obj.match(/\/A\s*<<([\s\S]*?)>>/);
    if (action) {
      destBlock = action[1].match(/\/D\s*\[([^\]]*)\]/)?.[1];
    }
  }
  if (!destBlock) return undefined;
  const pageRef = destBlock.match(/(\d+)\s+0\s+R/);
  if (!pageRef) return undefined;
  const pageId = parseInt(pageRef[1], 10);
  const pageIndex = pageIdToIndex.get(pageId) ?? 0;
  const xyz = destBlock.match(/\/XYZ\s+(\S+)\s+(\S+)\s+(\S+)/);
  const top =
    xyz && xyz[2] !== 'null' && Number.isFinite(Number(xyz[2])) ? Number(xyz[2]) : undefined;
  const zoom =
    xyz && xyz[3] !== 'null' && Number.isFinite(Number(xyz[3])) ? Number(xyz[3]) : undefined;
  return { pageIndex, top, zoom };
}

function collectAcroFields(host: PdfStructureHost, id: number, parentName: string): PdfFormField[] {
  const obj = host.getFullObject(id);
  if (!obj) return [];
  const partial = host.readPdfInfoString(obj, 'T') ?? '';
  const name = parentName ? (partial ? `${parentName}.${partial}` : parentName) : partial;
  const kids = obj.match(/\/Kids\s*\[([^\]]*)\]/);
  if (kids && !/\/FT\s*\//.test(obj)) {
    const out: PdfFormField[] = [];
    for (const ref of kids[1].match(/(\d+)\s+0\s+R/g) || []) {
      out.push(...collectAcroFields(host, parseInt(ref, 10), name));
    }
    return out;
  }
  const field = parseAcroFieldDict(host, obj, id, name);
  return field ? [field] : [];
}

function parseAcroFieldDict(
  host: PdfStructureHost,
  obj: string,
  id: number,
  name: string
): PdfFormField | null {
  if (!name && !/\/FT\s*\//.test(obj)) return null;

  const ft = obj.match(/\/FT\s*\/([A-Za-z]+)/)?.[1] ?? 'Tx';
  let type: PdfFormField['type'] = 'text';
  if (ft === 'Btn') {
    const flags = parseInt(obj.match(/\/Ff\s+(\d+)/)?.[1] ?? '0', 10);
    type = flags & 65536 ? 'button' : flags & 32768 ? 'radio' : 'checkbox';
  } else if (ft === 'Ch') {
    const flags = parseInt(obj.match(/\/Ff\s+(\d+)/)?.[1] ?? '0', 10);
    type = flags & 131072 ? 'listbox' : 'dropdown';
  } else if (ft === 'Sig') type = 'signature';

  const value =
    host.readPdfInfoString(obj, 'V') ??
    (obj.match(/\/V\s*\/([A-Za-z0-9_.+-]+)/)?.[1]
      ? `/${obj.match(/\/V\s*\/([A-Za-z0-9_.+-]+)/)![1]}`
      : undefined);
  const defaultValue = host.readPdfInfoString(obj, 'DV');
  const tooltip = host.readPdfInfoString(obj, 'TU');
  const rectMatch = obj.match(
    /\/Rect\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/
  );
  const rect: [number, number, number, number] = rectMatch
    ? [
        parseFloat(rectMatch[1]),
        parseFloat(rectMatch[2]),
        parseFloat(rectMatch[3]) - parseFloat(rectMatch[1]),
        parseFloat(rectMatch[4]) - parseFloat(rectMatch[2]),
      ]
    : [0, 0, 0, 0];

  const options: string[] = [];
  const optBlock = obj.match(/\/Opt\s*\[([\s\S]*?)\]/);
  if (optBlock) {
    const lit = optBlock[1].matchAll(/\((?:\\.|[^\\)])*\)|<[^>]+>/g);
    for (const m of lit) {
      const raw = m[0];
      if (raw.startsWith('(')) options.push(host.decodeInfoLiteralString(raw.slice(1, -1)));
      else options.push(host.decodeHexString(raw.slice(1, -1)));
    }
  }

  const checked =
    type === 'checkbox' || type === 'radio'
      ? value !== undefined && value !== '/Off' && value !== 'Off'
      : undefined;

  return {
    name: name || `field_${id}`,
    type,
    rect,
    value,
    defaultValue,
    tooltip,
    options: options.length ? options : undefined,
    checked,
    flags: parseInt(obj.match(/\/Ff\s+(\d+)/)?.[1] ?? '', 10) || undefined,
    defaultAppearance: host.readPdfInfoString(obj, 'DA'),
  };
}

export function extractPageAnnotations(
  host: PdfStructureHost,
  pageObj: string,
  pageHeight: number,
  pageIdToIndex: Map<number, number>
): PdfAnnotation[] {
  const annots: PdfAnnotation[] = [];
  const arrayMatch = pageObj.match(/\/Annots\s*\[([^\]]*)\]/);
  const singleRef = pageObj.match(/\/Annots\s+(\d+)\s+0\s+R/);
  const refIds: number[] = [];
  if (arrayMatch) {
    for (const m of arrayMatch[1].matchAll(/(\d+)\s+0\s+R/g)) {
      refIds.push(parseInt(m[1], 10));
    }
  } else if (singleRef) {
    const arrObj = host.getFullObject(parseInt(singleRef[1], 10)) || '';
    for (const m of arrObj.matchAll(/(\d+)\s+0\s+R/g)) {
      refIds.push(parseInt(m[1], 10));
    }
    // Some writers store the array as the object body itself: `[ … ]`
    if (refIds.length === 0) {
      for (const m of (arrObj.match(/\[([^\]]*)\]/)?.[1] || '').matchAll(/(\d+)\s+0\s+R/g)) {
        refIds.push(parseInt(m[1], 10));
      }
    }
  }

  for (const aid of refIds) {
    const ann = parseAnnotation(host, aid, pageHeight, pageIdToIndex);
    if (ann) annots.push(ann);
  }
  return annots;
}

function parseAnnotation(
  host: PdfStructureHost,
  id: number,
  pageHeight: number,
  pageIdToIndex: Map<number, number>
): PdfAnnotation | null {
  const obj = host.getFullObject(id);
  if (!obj) return null;
  const subtype = obj.match(/\/Subtype\s*\/([A-Za-z]+)/)?.[1];
  if (!subtype) return null;
  const rectMatch = obj.match(
    /\/Rect\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/
  );
  if (!rectMatch) return null;
  const llx = parseFloat(rectMatch[1]);
  const lly = parseFloat(rectMatch[2]);
  const urx = parseFloat(rectMatch[3]);
  const ury = parseFloat(rectMatch[4]);
  const rect: [number, number, number, number] = [
    llx,
    Math.max(0, pageHeight - ury),
    Math.max(0, urx - llx),
    Math.max(0, ury - lly),
  ];
  const borderWidth = parseFloat(
    obj.match(/\/Border\s*\[\s*\d+(?:\.\d+)?\s+\d+(?:\.\d+)?\s+(\d+(?:\.\d+)?)/)?.[1] ?? ''
  );
  const colorMatch = obj.match(
    /\/C\s*\[\s*(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s+(-?\d+(?:\.\d+)?)\s*\]/
  );
  const color: [number, number, number] | undefined = colorMatch
    ? [parseFloat(colorMatch[1]), parseFloat(colorMatch[2]), parseFloat(colorMatch[3])]
    : undefined;
  const opacity = parseFloat(obj.match(/\/CA\s+(\d+(?:\.\d+)?)/)?.[1] ?? '');
  const base = {
    rect,
    color,
    borderWidth: Number.isFinite(borderWidth) ? borderWidth : undefined,
    opacity: Number.isFinite(opacity) ? opacity : undefined,
  };

  if (subtype === 'Link') {
    // `/S /URI` is a name token — only accept `/URI (…)` / `/URI <…>` string values.
    let uri: string | undefined;
    const uriLit = obj.match(/\/URI\s*\(((?:\\.|[^\\)])*)\)/);
    if (uriLit) uri = host.decodeInfoLiteralString(uriLit[1]);
    else {
      const uriHex = obj.match(/\/URI\s*<([^>]*)>/);
      if (uriHex) uri = host.decodeHexString(uriHex[1]);
    }
    let pageTarget: number | undefined;
    const dest = obj.match(/\/Dest\s*\[(\d+)\s+0\s+R/);
    if (dest) pageTarget = pageIdToIndex.get(parseInt(dest[1], 10));
    return { type: 'Link', ...base, uri, pageTarget };
  }
  if (subtype === 'Text') {
    return {
      type: 'Text',
      ...base,
      content: host.readPdfInfoString(obj, 'Contents') ?? '',
      title: host.readPdfInfoString(obj, 'T'),
    };
  }
  if (subtype === 'Square' || subtype === 'Circle') {
    return { type: subtype, ...base, title: host.readPdfInfoString(obj, 'T') };
  }
  if (subtype === 'Highlight') {
    return { type: 'Highlight', ...base };
  }
  return null;
}

export function extractFormResources(host: PdfStructureHost, obj: string): Map<string, number> {
  const resources = new Map<string, number>();
  let xObjectSection = obj.match(/\/XObject\s*<<([\s\S]*?)>>/);
  if (!xObjectSection) {
    const resRef = obj.match(/\/Resources\s+(\d+)\s+0\s+R/);
    if (resRef) {
      const resObj = host.getFullObject(parseInt(resRef[1], 10));
      if (resObj) xObjectSection = resObj.match(/\/XObject\s*<<([\s\S]*?)>>/);
    }
  }
  if (!xObjectSection) return resources;
  const refRegex = /\/([A-Za-z0-9_.-]+)\s+(\d+)\s+0\s+R/g;
  let match: RegExpExecArray | null;
  while ((match = refRegex.exec(xObjectSection[1])) !== null) {
    const objectId = parseInt(match[2], 10);
    const formObj = host.getFullObject(objectId);
    if (formObj && /\/Subtype\s*\/Form\b/.test(formObj)) {
      resources.set(match[1], objectId);
    }
  }
  return resources;
}

export function extractFormXObjectText(
  host: PdfStructureHost,
  content: string,
  formResources: Map<string, number>,
  depth: number
): string[] {
  if (depth > 4) return [];
  const parts: string[] = [];
  const doRegex = /\/([A-Za-z0-9_.-]+)\s+Do\b/g;
  let match: RegExpExecArray | null;
  while ((match = doRegex.exec(content)) !== null) {
    const objectId = formResources.get(match[1]);
    if (!objectId) continue;
    const decoded = host.decodeStream(objectId);
    if (!decoded) continue;
    const text = host.parseTextOperators(decoded).join(' ').trim();
    if (text) parts.push(text);
    const nested = extractFormResources(host, host.getFullObject(objectId) || '');
    if (nested.size > 0) {
      parts.push(...extractFormXObjectText(host, decoded, nested, depth + 1));
    }
  }
  return parts;
}
