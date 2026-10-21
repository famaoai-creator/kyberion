/**
 * Replace one slide of an existing deck with N generated slides that inherit
 * the deck's look: the template slide's head shapes (title / subtitle
 * placeholders) and its slide layout are reused, and semantic blocks are laid
 * out top-down in the body zone underneath with colours and fonts from a
 * design theme. The package is rewritten so that PowerPoint opens it without
 * a repair prompt (fresh slide ids and relationship ids, content types,
 * notes kept only on the first slide, stale change history and every part only
 * the replaced slide used removed), and the result goes through the
 * `assertPptxPackageWrite` gate.
 */
import {
  collectRelationshipRefs,
  parseRelationships,
  partText,
  readAttr,
  readPptxParts,
  relsPartFor,
  resolveRelTarget,
  writePptxParts,
  type PptxRelationship,
  assertPptxPackageWrite,
  isPlaceholderTarget,
  parseSldIdEntries,
  sourcePartForRels,
  type PptxPackageCheckLevel,
} from './pptx-package.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface ReplaceSlidesTheme {
  /** 6-digit hex without '#'. */
  primary: string;
  accent: string;
  pale: string;
  muted: string;
  negative: string;
  text: string;
  /** Text colour on primary / accent fills. */
  onPrimary: string;
  fontLatin?: string;
  fontEa?: string;
}

export type SlideBlock =
  | { type: 'lead'; text: string }
  | { type: 'kpi_band'; items: Array<{ label: string; value: string; note?: string }> }
  | { type: 'labeled_rows'; title?: string; rows: Array<{ label: string; text: string }> }
  | {
      type: 'stage_columns';
      items: Array<{ when: string; title: string; items?: string[] }>;
      emphasis_first?: boolean;
    }
  | { type: 'card_row'; title?: string; items: Array<{ title: string; text: string }> }
  | {
      type: 'trend_chart';
      x_label?: string;
      y_label?: string;
      series: Array<{
        label: string;
        trend?: 'rising' | 'flat';
        style?: 'dashed' | 'solid';
        tone?: 'negative' | 'primary';
      }>;
    }
  | { type: 'bullets'; title?: string; items: string[] }
  | { type: 'columns'; ratio?: [number, number]; left: SlideBlock[]; right: SlideBlock[] };

export interface ReplacementSlide {
  subtitle?: string;
  blocks: SlideBlock[];
}

export interface ReplaceSlidesSpec {
  replace_index: number;
  template_index?: number;
  subtitle_shape?: string | number;
  theme: ReplaceSlidesTheme;
  slides: ReplacementSlide[];
  /** Write gate level (default error): only defects this write introduces refuse it. */
  package_check?: PptxPackageCheckLevel;
}

export interface ReplaceSlidesResult {
  buffer: Buffer;
  slide_parts: string[];
  removed_parts: string[];
  body_zone: { x: number; y: number; w: number; h: number };
}

// ---------------------------------------------------------------------------
// Theme resolution
// ---------------------------------------------------------------------------

function hex(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  let text = value.trim().replace(/^#/u, '');
  if (/^[0-9a-fA-F]{3}$/u.test(text)) {
    text = text
      .split('')
      .map((c) => c + c)
      .join('');
  }
  return /^[0-9a-fA-F]{6}$/u.test(text) ? text.toUpperCase() : undefined;
}

/** Mix a colour towards white by `amount` (0..1). */
function tint(color: string, amount: number): string {
  const channels = [0, 2, 4].map((i) => parseInt(color.slice(i, i + 2), 16));
  return channels
    .map((c) => Math.round(c + (255 - c) * amount))
    .map((c) => c.toString(16).padStart(2, '0'))
    .join('')
    .toUpperCase();
}

const GENERIC_FONT_FAMILIES = new Set([
  'sans-serif',
  'serif',
  'monospace',
  'system-ui',
  'cursive',
  'fantasy',
  '-apple-system',
]);
const EAST_ASIAN_FONT =
  /JP|CJK|SC|TC|KR|Gothic|Mincho|Meiryo|Yu |Hiragino|MS P?Gothic|Noto Sans (?:JP|SC|TC|KR)/u;

function fontFamilies(value: unknown): string[] {
  if (typeof value !== 'string') return [];
  return value
    .split(',')
    .map((family) => family.trim().replace(/^['"]|['"]$/gu, ''))
    .filter((family) => family && !GENERIC_FONT_FAMILIES.has(family.toLowerCase()));
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** Pull `{colors, fonts}` out of a media theme, a tenant theme pack (`{theme: {...}}`), or a flat colour map. */
function themeParts(input: unknown): {
  colors: Record<string, unknown>;
  fonts: Record<string, unknown>;
} {
  const record = asRecord(input) ?? {};
  const nested = asRecord(record.theme);
  const source = nested && (nested.colors || nested.fonts) ? nested : record;
  return {
    colors: asRecord(source.colors) ?? source,
    fonts: asRecord(source.fonts) ?? {},
  };
}

/**
 * Map a repository theme (media theme catalog entry, tenant `design/theme.json`
 * pack, or a flat `{primary, accent, ...}` map) onto the block palette. Keys
 * missing from `input` fall back to `fallback` (the default media theme), then
 * to values derived from the primary / accent colours.
 */
export function resolveReplaceSlidesTheme(input: unknown, fallback?: unknown): ReplaceSlidesTheme {
  const primaryParts = themeParts(input);
  const fallbackParts = themeParts(fallback);
  const pick = (...keys: string[]) => {
    for (const parts of [primaryParts, fallbackParts]) {
      for (const key of keys) {
        const value = hex(parts.colors[key]);
        if (value) return value;
      }
    }
    return undefined;
  };
  const primary = pick('primary', 'text') ?? '000000';
  const accent = pick('accent', 'secondary', 'primary') ?? primary;
  const fonts = [primaryParts.fonts, fallbackParts.fonts].flatMap((fontMap) => [
    ...fontFamilies(fontMap.latin),
    ...fontFamilies(fontMap.body),
    ...fontFamilies(fontMap.heading),
  ]);
  const eaFonts = [primaryParts.fonts, fallbackParts.fonts].flatMap((fontMap) =>
    fontFamilies(fontMap.ea)
  );
  const fontLatin = fonts[0];
  const fontEa = eaFonts[0] ?? fonts.find((family) => EAST_ASIAN_FONT.test(family)) ?? fontLatin;
  return {
    primary,
    accent,
    pale: pick('pale', 'surface') ?? tint(accent, 0.88),
    muted: pick('muted', 'muted_text', 'secondary') ?? primary,
    negative: pick('negative', 'danger') ?? accent,
    text: pick('text', 'primary') ?? primary,
    onPrimary: pick('on_primary', 'background') ?? tint(primary, 1),
    ...(fontLatin ? { fontLatin } : {}),
    ...(fontEa ? { fontEa } : {}),
  };
}

// ---------------------------------------------------------------------------
// XML helpers
// ---------------------------------------------------------------------------

const EMU_PER_PT = 12700;
const SLIDE_REL_TYPE = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide';
const SLIDE_CONTENT_TYPE = 'application/vnd.openxmlformats-officedocument.presentationml.slide+xml';

function esc(text: string): string {
  return text
    .replace(/&/gu, '&amp;')
    .replace(/</gu, '&lt;')
    .replace(/>/gu, '&gt;')
    .replace(/"/gu, '&quot;');
}

interface XmlChild {
  start: number;
  end: number;
  name: string;
}

/** Find the end of the tag starting at `lt` (index of the closing '>'), honouring quoted attribute values. */
function tagEnd(xml: string, lt: number): number {
  let quote: string | null = null;
  for (let i = lt + 1; i < xml.length; i += 1) {
    const char = xml[i];
    if (quote) {
      if (char === quote) quote = null;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (char === '>') {
      return i;
    }
  }
  return -1;
}

/** Direct child elements of the range [from, to). */
function scanChildren(xml: string, from: number, to: number): XmlChild[] {
  const children: XmlChild[] = [];
  let depth = 0;
  let current: { start: number; name: string } | null = null;
  let i = from;
  while (i < to) {
    const lt = xml.indexOf('<', i);
    if (lt < 0 || lt >= to) break;
    if (xml.startsWith('<!--', lt)) {
      i = xml.indexOf('-->', lt) + 3;
      continue;
    }
    if (xml.startsWith('<?', lt)) {
      i = xml.indexOf('?>', lt) + 2;
      continue;
    }
    const gt = tagEnd(xml, lt);
    if (gt < 0) break;
    const tag = xml.slice(lt, gt + 1);
    const name = tag.match(/^<\/?([^\s/>]+)/u)?.[1] ?? '';
    if (tag.startsWith('</')) {
      depth -= 1;
      if (depth === 0 && current) {
        children.push({ start: current.start, end: gt + 1, name: current.name });
        current = null;
      }
    } else if (tag.endsWith('/>')) {
      if (depth === 0) children.push({ start: lt, end: gt + 1, name });
    } else {
      if (depth === 0) current = { start: lt, name };
      depth += 1;
    }
    i = gt + 1;
  }
  return children;
}

interface Geometry {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface ShapeInfo {
  xml: string;
  name: string;
  id?: string;
  shapeName?: string;
  phType?: string;
  phIdx?: string;
  geometry?: Geometry;
}

function spTreeRange(xml: string): { contentStart: number; contentEnd: number } {
  const open = xml.indexOf('<p:spTree');
  const contentEnd = xml.lastIndexOf('</p:spTree>');
  if (open < 0 || contentEnd < 0) throw new Error('slide XML has no <p:spTree>');
  return { contentStart: tagEnd(xml, open) + 1, contentEnd };
}

function readGeometry(xml: string): Geometry | undefined {
  const off = xml.match(/<a:off\b[^>]*\/>/u)?.[0];
  const ext = xml.match(/<a:ext\b[^>]*\bcx="[^"]*"[^>]*\/>/u)?.[0];
  if (!off || !ext) return undefined;
  const values = [readAttr(off, 'x'), readAttr(off, 'y'), readAttr(ext, 'cx'), readAttr(ext, 'cy')];
  const numbers = values.map((value) => Number(value));
  if (numbers.some((n) => !Number.isFinite(n))) return undefined;
  const [x, y, w, h] = numbers as [number, number, number, number];
  return { x, y, w, h };
}

function describeShape(xml: string, name: string): ShapeInfo {
  const nvEnd = xml.indexOf('</p:nv');
  const nv = nvEnd >= 0 ? xml.slice(0, nvEnd) : xml;
  const cNvPr = nv.match(/<p:cNvPr\b[^>]*>/u)?.[0];
  const ph = nv.match(/<p:ph\b[^>]*>/u)?.[0];
  return {
    xml,
    name,
    id: cNvPr ? readAttr(cNvPr, 'id') : undefined,
    shapeName: cNvPr ? readAttr(cNvPr, 'name') : undefined,
    phType: ph ? (readAttr(ph, 'type') ?? 'obj') : undefined,
    phIdx: ph ? readAttr(ph, 'idx') : undefined,
    geometry: readGeometry(xml),
  };
}

function shapesOf(xml: string): {
  shapes: ShapeInfo[];
  groupProps: string;
  range: ReturnType<typeof spTreeRange>;
} {
  const range = spTreeRange(xml);
  const children = scanChildren(xml, range.contentStart, range.contentEnd);
  const groupProps = children
    .filter((child) => child.name === 'p:nvGrpSpPr' || child.name === 'p:grpSpPr')
    .map((child) => xml.slice(child.start, child.end))
    .join('');
  const shapes = children
    .filter((child) => child.name !== 'p:nvGrpSpPr' && child.name !== 'p:grpSpPr')
    .map((child) => describeShape(xml.slice(child.start, child.end), child.name));
  return { shapes, groupProps, range };
}

const MASTER_PH_TYPE: Record<string, string> = {
  ctrTitle: 'title',
  title: 'title',
  subTitle: 'body',
  obj: 'body',
  body: 'body',
};

/** Fill a placeholder's missing geometry from the layout, then the master. */
function inheritGeometry(
  shape: ShapeInfo,
  layout: ShapeInfo[],
  master: ShapeInfo[]
): Geometry | undefined {
  if (shape.geometry || !shape.phType) return shape.geometry;
  const fromLayout =
    (shape.phIdx && layout.find((s) => s.phIdx === shape.phIdx && s.geometry)) ||
    layout.find((s) => s.phType === shape.phType && s.geometry);
  if (fromLayout?.geometry) return fromLayout.geometry;
  const masterType = MASTER_PH_TYPE[shape.phType] ?? shape.phType;
  return master.find(
    (s) => (MASTER_PH_TYPE[s.phType ?? ''] ?? s.phType) === masterType && s.geometry
  )?.geometry;
}

// ---------------------------------------------------------------------------
// Text and shape builders
// ---------------------------------------------------------------------------

interface Run {
  t: string;
  sz: number;
  b?: boolean;
  color: string;
}

interface Para {
  runs: Run[];
  algn?: 'l' | 'ctr' | 'r';
  bullet?: boolean;
  spcBef?: number;
}

interface BoxSpec extends Geometry {
  paras: Para[];
  fill?: string;
  line?: string;
  geom?: string;
  anchor?: 't' | 'ctr' | 'b';
  inset?: number;
}

const DEFAULT_INSET = 91440;

class SlideCanvas {
  private nextId: number;
  readonly parts: string[] = [];

  constructor(
    firstId: number,
    private readonly theme: ReplaceSlidesTheme
  ) {
    this.nextId = firstId;
  }

  P(t: string, o: Partial<Omit<Run, 't'>> & Omit<Para, 'runs'> = {}): Para {
    return {
      runs: [{ t, sz: o.sz ?? 1400, b: o.b, color: o.color ?? this.theme.text }],
      algn: o.algn,
      bullet: o.bullet,
      spcBef: o.spcBef,
    };
  }

  private font(): string {
    const { fontLatin, fontEa } = this.theme;
    return `${fontLatin ? `<a:latin typeface="${esc(fontLatin)}"/>` : ''}${fontEa ? `<a:ea typeface="${esc(fontEa)}"/>` : ''}`;
  }

  private para(p: Para): string {
    const spacing = p.spcBef ? `<a:spcBef><a:spcPts val="${p.spcBef}"/></a:spcBef>` : '';
    const ppr = p.bullet
      ? `<a:pPr marL="228600" indent="-228600" algn="${p.algn ?? 'l'}">${spacing}<a:buFont typeface="Arial"/><a:buChar char="&#8226;"/></a:pPr>`
      : `<a:pPr algn="${p.algn ?? 'l'}">${spacing}<a:buNone/></a:pPr>`;
    const runs = p.runs
      .map(
        (r) =>
          `<a:r><a:rPr sz="${r.sz}" b="${r.b ? 1 : 0}" dirty="0"><a:solidFill><a:srgbClr val="${r.color}"/></a:solidFill>${this.font()}</a:rPr><a:t>${esc(r.t)}</a:t></a:r>`
      )
      .join('');
    return `<a:p>${ppr}${runs}</a:p>`;
  }

  box(b: BoxSpec): void {
    const id = this.nextId++;
    const fill = b.fill ? `<a:solidFill><a:srgbClr val="${b.fill}"/></a:solidFill>` : '<a:noFill/>';
    const ln = b.line
      ? `<a:ln w="12700"><a:solidFill><a:srgbClr val="${b.line}"/></a:solidFill></a:ln>`
      : '<a:ln><a:noFill/></a:ln>';
    const ins = b.inset ?? DEFAULT_INSET;
    // A text body must hold at least one <a:p>; an empty one makes PowerPoint demand a repair.
    const paragraphs = b.paras.length
      ? b.paras.map((p) => this.para(p)).join('')
      : '<a:p><a:endParaRPr dirty="0"/></a:p>';
    this.parts.push(
      `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="Shape ${id}"/><p:cNvSpPr${b.fill || b.geom ? '' : ' txBox="1"'}/><p:nvPr/></p:nvSpPr><p:spPr><a:xfrm><a:off x="${Math.round(b.x)}" y="${Math.round(b.y)}"/><a:ext cx="${Math.round(b.w)}" cy="${Math.round(b.h)}"/></a:xfrm><a:prstGeom prst="${b.geom ?? 'rect'}"><a:avLst/></a:prstGeom>${fill}${ln}</p:spPr><p:txBody><a:bodyPr wrap="square" lIns="${ins}" tIns="${ins / 2}" rIns="${ins}" bIns="${ins / 2}" anchor="${b.anchor ?? 't'}" rtlCol="0"><a:noAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
    );
  }

  line(
    x1: number,
    y1: number,
    x2: number,
    y2: number,
    color: string,
    opts: { w?: number; dash?: boolean; arrow?: boolean } = {}
  ): void {
    const id = this.nextId++;
    const flipV = y2 < y1;
    const [ox, oy] = [Math.round(Math.min(x1, x2)), Math.round(Math.min(y1, y2))];
    const [cx, cy] = [Math.round(Math.abs(x2 - x1)), Math.round(Math.abs(y2 - y1))];
    this.parts.push(
      `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="Line ${id}"/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${flipV ? ' flipV="1"' : ''}><a:off x="${ox}" y="${oy}"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${opts.w ?? 12700}"><a:solidFill><a:srgbClr val="${color}"/></a:solidFill>${opts.dash ? '<a:prstDash val="dash"/>' : ''}<a:tailEnd type="${opts.arrow ? 'triangle' : 'none'}"/></a:ln></p:spPr></p:cxnSp>`
    );
  }
}

function isWide(char: string): boolean {
  const code = char.codePointAt(0) ?? 0;
  return code >= 0x1100 && !(code >= 0xff61 && code <= 0xff9f);
}

/** Rough wrapped height of paragraphs in a box of width `w` (EMU). */
function textHeight(paras: Para[], w: number, inset = DEFAULT_INSET): number {
  const inner = Math.max(1, w - 2 * inset);
  let h = inset;
  for (const p of paras) {
    const indent = p.bullet ? 228600 : 0;
    let lineHeight = 0;
    let width = 0;
    for (const run of p.runs) {
      const em = run.sz / 100;
      lineHeight = Math.max(lineHeight, em * 1.25 * EMU_PER_PT);
      for (const char of run.t) width += (isWide(char) ? em : em * 0.55) * EMU_PER_PT;
    }
    const lines = Math.max(1, Math.ceil(width / Math.max(1, inner - indent)));
    h += lines * lineHeight + ((p.spcBef ?? 0) / 100) * EMU_PER_PT;
  }
  return Math.ceil(h);
}

// ---------------------------------------------------------------------------
// Blocks: intrinsic height + render
// ---------------------------------------------------------------------------

const CARD_GAP = 196000;
const TITLE_ROW = 400000;
const COLUMN_GAP = 200000;
const DEFAULT_BLOCK_GAP = 180000;
const MIN_BLOCK_GAP = 60000;

interface BlockLayout {
  height: number;
  render: (canvas: SlideCanvas, x: number, y: number) => void;
}

function stack(layouts: BlockLayout[], gap: number): BlockLayout {
  const height =
    layouts.reduce((sum, layout) => sum + layout.height, 0) + Math.max(0, layouts.length - 1) * gap;
  return {
    height,
    render: (canvas, x, y) => {
      let cursor = y;
      for (const layout of layouts) {
        layout.render(canvas, x, cursor);
        cursor += layout.height + gap;
      }
    },
  };
}

function requireArray<T>(value: unknown, label: string): T[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`pptx_replace_slides: ${label} must be a non-empty array`);
  }
  return value as T[];
}

function titleRow(
  theme: ReplaceSlidesTheme,
  title: string | undefined,
  w: number,
  probe: SlideCanvas
): BlockLayout | undefined {
  if (!title) return undefined;
  const para = probe.P(title, { sz: 1500, b: true, color: theme.text });
  const height = Math.max(TITLE_ROW, textHeight([para], w));
  return {
    height,
    render: (c, x, y) => c.box({ x, y, w, h: height, paras: [para], anchor: 'ctr' }),
  };
}

function layoutBlock(
  block: SlideBlock,
  w: number,
  theme: ReplaceSlidesTheme,
  probe: SlideCanvas,
  where: string
): BlockLayout {
  const P = probe.P.bind(probe);
  switch (block?.type) {
    case 'lead': {
      const para = P(String(block.text ?? ''), { sz: 1800, b: true, color: theme.primary });
      const textH = Math.max(460000, textHeight([para], w));
      return {
        height: textH + 40000,
        render: (c, x, y) => {
          c.box({ x, y, w, h: textH, paras: [para], anchor: 'ctr' });
          c.line(x, y + textH + 20000, x + w, y + textH + 20000, theme.accent, { w: 19050 });
        },
      };
    }
    case 'kpi_band': {
      const items = requireArray<{ label: string; value: string; note?: string }>(
        block.items,
        `${where}.items`
      );
      const cardW = (w - (items.length - 1) * CARD_GAP) / items.length;
      const paras = items.map((item) => [
        P(String(item.label ?? ''), { sz: 1300, color: theme.muted, algn: 'ctr' }),
        P(String(item.value ?? ''), { sz: 2800, b: true, color: theme.primary, algn: 'ctr' }),
        ...(item.note ? [P(String(item.note), { sz: 1200, color: theme.muted, algn: 'ctr' })] : []),
      ]);
      const height = Math.max(1180000, ...paras.map((p) => textHeight(p, cardW)));
      return {
        height,
        render: (c, x, y) =>
          paras.forEach((p, i) =>
            c.box({
              x: x + i * (cardW + CARD_GAP),
              y,
              w: cardW,
              h: height,
              fill: theme.pale,
              anchor: 'ctr',
              paras: p,
            })
          ),
      };
    }
    case 'labeled_rows': {
      const rows = requireArray<{ label: string; text: string }>(block.rows, `${where}.rows`);
      // Fit the longest label (14pt) on one line, keeping at least 60% of the width for text.
      const longestLabel = Math.max(
        0,
        ...rows.map((row) =>
          [...String(row.label ?? '')].reduce((n, ch) => n + (isWide(ch) ? 14 : 14 * 0.55), 0)
        )
      );
      const labelW = Math.min(
        Math.max(2600000, longestLabel * EMU_PER_PT + 2 * DEFAULT_INSET + 60000),
        w * 0.4
      );
      const textW = w - labelW - 100000;
      const rowLayouts: BlockLayout[] = rows.map((row) => {
        const label = P(String(row.label ?? ''), {
          sz: 1400,
          b: true,
          color: theme.onPrimary,
          algn: 'ctr',
        });
        const text = P(String(row.text ?? ''), { sz: 1400 });
        const height = Math.max(520000, textHeight([label], labelW), textHeight([text], textW));
        return {
          height,
          render: (c, x, y) => {
            c.box({
              x,
              y,
              w: labelW,
              h: height,
              fill: theme.accent,
              anchor: 'ctr',
              paras: [label],
            });
            c.box({ x: x + labelW + 100000, y, w: textW, h: height, anchor: 'ctr', paras: [text] });
          },
        };
      });
      const title = titleRow(theme, block.title, w, probe);
      return stack([...(title ? [title] : []), ...rowLayouts], 120000);
    }
    case 'stage_columns': {
      const items = requireArray<{ when: string; title: string; items?: string[] }>(
        block.items,
        `${where}.items`
      );
      const colW = (w - (items.length - 1) * CARD_GAP) / items.length;
      const headerH = 420000;
      const bodies = items.map((item) => [
        P(String(item.title ?? ''), { sz: 1600, b: true, color: theme.primary, spcBef: 400 }),
        ...(Array.isArray(item.items) ? item.items : []).map((t) =>
          P(String(t), { sz: 1300, bullet: true, spcBef: 600 })
        ),
      ]);
      const bodyH = Math.max(1200000, ...bodies.map((p) => textHeight(p, colW)));
      return {
        height: headerH + 60000 + bodyH,
        render: (c, x, y) =>
          items.forEach((item, i) => {
            const cx = x + i * (colW + CARD_GAP);
            c.box({
              x: cx,
              y,
              w: colW,
              h: headerH,
              fill: i === 0 && block.emphasis_first !== false ? theme.primary : theme.accent,
              geom: 'homePlate',
              anchor: 'ctr',
              paras: [P(String(item.when ?? ''), { sz: 1300, b: true, color: theme.onPrimary })],
            });
            c.box({
              x: cx,
              y: y + headerH + 60000,
              w: colW,
              h: bodyH,
              fill: theme.pale,
              paras: bodies[i]!,
            });
          }),
      };
    }
    case 'card_row': {
      const items = requireArray<{ title: string; text: string }>(block.items, `${where}.items`);
      const cardW = (w - (items.length - 1) * CARD_GAP) / items.length;
      const paras = items.map((item) => [
        P(String(item.title ?? ''), { sz: 1300, b: true, color: theme.primary }),
        P(String(item.text ?? ''), { sz: 1200, color: theme.muted }),
      ]);
      const cardH = Math.max(700000, ...paras.map((p) => textHeight(p, cardW)));
      const cards: BlockLayout = {
        height: cardH,
        render: (c, x, y) =>
          paras.forEach((p, i) =>
            c.box({
              x: x + i * (cardW + CARD_GAP),
              y,
              w: cardW,
              h: cardH,
              line: theme.accent,
              paras: p,
            })
          ),
      };
      const title = titleRow(theme, block.title, w, probe);
      return stack([...(title ? [title] : []), cards], 40000);
    }
    case 'bullets': {
      const items = requireArray<string>(block.items, `${where}.items`);
      const paras = items.map((t) => P(String(t), { sz: 1400, bullet: true, spcBef: 400 }));
      const height = textHeight(paras, w);
      const body: BlockLayout = {
        height,
        render: (c, x, y) => c.box({ x, y, w, h: height, paras }),
      };
      const title = titleRow(theme, block.title, w, probe);
      return stack([...(title ? [title] : []), body], 40000);
    }
    case 'trend_chart': {
      const series = requireArray<Extract<SlideBlock, { type: 'trend_chart' }>['series'][number]>(
        block.series,
        `${where}.series`
      );
      const height = Math.round(Math.min(2600000, Math.max(1800000, w * 0.55)));
      return {
        height,
        render: (c, x, y) => renderTrendChart(c, theme, { ...block, series }, x, y, w, height),
      };
    }
    case 'columns': {
      const ratio = Array.isArray(block.ratio) && block.ratio.length === 2 ? block.ratio : [1, 1];
      const [a, b] = ratio.map((n) => (Number(n) > 0 ? Number(n) : 1)) as [number, number];
      const leftW = ((w - COLUMN_GAP) * a) / (a + b);
      const rightW = w - COLUMN_GAP - leftW;
      const left = stack(
        requireArray<SlideBlock>(block.left, `${where}.left`).map((child, i) =>
          layoutBlock(child, leftW, theme, probe, `${where}.left[${i}]`)
        ),
        DEFAULT_BLOCK_GAP
      );
      const right = stack(
        requireArray<SlideBlock>(block.right, `${where}.right`).map((child, i) =>
          layoutBlock(child, rightW, theme, probe, `${where}.right[${i}]`)
        ),
        DEFAULT_BLOCK_GAP
      );
      return {
        height: Math.max(left.height, right.height),
        render: (c, x, y) => {
          left.render(c, x, y);
          right.render(c, x + leftW + COLUMN_GAP, y);
        },
      };
    }
    default:
      throw new Error(
        `pptx_replace_slides: unknown block type '${String((block as { type?: unknown })?.type)}' at ${where} — supported: lead, kpi_band, labeled_rows, stage_columns, card_row, trend_chart, bullets, columns`
      );
  }
}

function renderTrendChart(
  c: SlideCanvas,
  theme: ReplaceSlidesTheme,
  block: Extract<SlideBlock, { type: 'trend_chart' }>,
  x: number,
  y: number,
  w: number,
  h: number
): void {
  c.box({ x, y, w, h, fill: theme.pale, paras: [] });
  const ox = x + w * 0.11;
  const oy = y + h * 0.84;
  const ax = x + w * 0.945;
  const ay = y + h * 0.1;
  c.line(ox, oy, ax, oy, theme.muted, { arrow: true });
  c.line(ox, oy, ox, ay, theme.muted, { arrow: true });
  if (block.x_label) {
    c.box({
      x: ax - w * 0.45,
      y: oy + 20000,
      w: w * 0.45,
      h: 300000,
      paras: [c.P(block.x_label, { sz: 1100, color: theme.muted, algn: 'r' })],
    });
  }
  if (block.y_label) {
    c.box({
      x: x + 20000,
      y: ay - 60000,
      w: Math.max(200000, ox - x - 30000),
      h: h * 0.35,
      // The gutter left of the axis is narrow; no insets so short words do not break.
      inset: 0,
      paras: block.y_label.split('\n').map((t) => c.P(t, { sz: 1100, color: theme.muted })),
    });
  }
  let rising = 0;
  let flat = 0;
  for (const s of block.series) {
    const color = s.tone === 'negative' ? theme.negative : theme.primary;
    const dashed = s.style === 'dashed';
    const lineOpts = { w: dashed ? 28575 : 38100, dash: dashed, arrow: !dashed };
    const x1 = ox + 60000;
    const x2 = ax - 200000;
    let y1: number;
    let y2: number;
    let labelY: number;
    if (s.trend === 'flat') {
      y1 = oy - h * (0.2 + flat * 0.1);
      y2 = oy - h * (0.27 + flat * 0.1);
      labelY = y2 - 380000;
      flat += 1;
    } else {
      y1 = oy - h * (0.115 + rising * 0.08);
      y2 = ay + h * (0.1 + rising * 0.08);
      labelY = ay + h * 0.046 + rising * 320000;
      rising += 1;
    }
    c.line(x1, y1, x2, y2, color, lineOpts);
    c.box({
      x: ox + w * 0.3,
      y: labelY,
      w: w * 0.55,
      h: 300000,
      paras: [c.P(s.label, { sz: 1150, b: true, color })],
    });
  }
}

// ---------------------------------------------------------------------------
// Head shapes and subtitle replacement
// ---------------------------------------------------------------------------

function replaceShapeText(shapeXml: string, text: string): string {
  const bodyMatch = shapeXml.match(/<p:txBody>([\s\S]*?)<\/p:txBody>/u);
  if (!bodyMatch) {
    throw new Error('pptx_replace_slides: subtitle_shape has no text body to replace');
  }
  const inner = bodyMatch[1]!;
  const firstPara = inner.search(/<a:p[\s>]/u);
  const head = firstPara >= 0 ? inner.slice(0, firstPara) : inner;
  const para =
    firstPara >= 0 ? (inner.slice(firstPara).match(/<a:p[\s>][\s\S]*?<\/a:p>/u)?.[0] ?? '') : '';
  const pPr = para.match(/<a:pPr\b[^>]*\/>|<a:pPr\b[^>]*>[\s\S]*?<\/a:pPr>/u)?.[0] ?? '';
  const endPara =
    para.match(/<a:endParaRPr\b[^>]*\/>|<a:endParaRPr\b[^>]*>[\s\S]*?<\/a:endParaRPr>/u)?.[0] ?? '';
  const firstRun = para.match(/<a:r>([\s\S]*?)<\/a:r>/u)?.[1] ?? '';
  const rPr =
    firstRun.match(/<a:rPr\b[^>]*\/>|<a:rPr\b[^>]*>[\s\S]*?<\/a:rPr>/u)?.[0] ??
    endPara.replace(/^<a:endParaRPr/u, '<a:rPr').replace(/<\/a:endParaRPr>$/u, '</a:rPr>');
  const newPara = `<a:p>${pPr}<a:r>${rPr}<a:t>${esc(text)}</a:t></a:r>${endPara}</a:p>`;
  return shapeXml.replace(bodyMatch[0], `<p:txBody>${head}${newPara}</p:txBody>`);
}

function setShapeWidth(shapeXml: string, width: number): string {
  return shapeXml.replace(
    /(<a:ext\b[^>]*\bcx=")(\d+)(")/u,
    (_m, a: string, _cx: string, b: string) => `${a}${Math.round(width)}${b}`
  );
}

const FOOTER_PH_TYPES = new Set(['dt', 'ftr', 'sldNum']);

/** True when a layout / master shape renders anything (text, fill, outline, picture). */
function drawsSomething(shape: ShapeInfo): boolean {
  if (shape.name !== 'p:sp') return true;
  if (/<a:t>[^<]*\S[^<]*<\/a:t>/u.test(shape.xml) || /<a:fld\b/u.test(shape.xml)) return true;
  if (/<a:fillRef idx="[1-9]/u.test(shape.xml)) return true;
  const spPr = shape.xml.match(/<p:spPr\b[\s\S]*?<\/p:spPr>/u)?.[0] ?? '';
  const line = spPr.match(/<a:ln\b[\s\S]*?<\/a:ln>/u)?.[0] ?? '';
  if (/<a:(?:solidFill|gradFill|blipFill|pattFill)\b/u.test(spPr.replace(line, ''))) return true;
  return /<a:(?:solidFill|gradFill)\b/u.test(line);
}

function matchesShape(shape: ShapeInfo, selector: string | number): boolean {
  const key = String(selector);
  return shape.shapeName === key || shape.id === key;
}

// ---------------------------------------------------------------------------
// Package rewrite
// ---------------------------------------------------------------------------

function fail(what: string, why: string, next: string, evidence: string): never {
  throw new Error(`pptx_replace_slides: ${what} — ${why} | next: ${next} | evidence: ${evidence}`);
}

function relsXml(rels: PptxRelationship[]): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels
    .map((rel) => rel.raw)
    .join('')}</Relationships>`;
}

function withRelId(rel: PptxRelationship, id: string): PptxRelationship {
  return { ...rel, id, raw: rel.raw.replace(/\sId="[^"]*"/u, ` Id="${id}"`) };
}

function maxRid(ids: Iterable<string>): number {
  let max = 0;
  for (const id of ids) {
    const n = Number(id.match(/^rId(\d+)$/u)?.[1] ?? 0);
    if (n > max) max = n;
  }
  return max;
}

const COMMENT_REL_TYPE = /\/(?:comments|modernComment|threadedComment|commentAuthors)$/iu;

/** Internal parts transitively reachable from a rels part, skipping relationships `skip` rejects. */
function reachableFromRels(
  parts: Map<string, Buffer>,
  startRels: string,
  skip: (rel: PptxRelationship) => boolean
): Set<string> {
  const found = new Set<string>();
  const queue = [startRels];
  while (queue.length) {
    const relsPart = queue.shift()!;
    for (const rel of parseRelationships(partText(parts, relsPart) ?? '')) {
      if (rel.external || isPlaceholderTarget(rel.target) || skip(rel)) continue;
      const target = resolveRelTarget(relsPart, rel.target);
      if (found.has(target) || !parts.has(target) || STRUCTURAL_PART.test(target)) continue;
      found.add(target);
      queue.push(relsPartFor(target));
    }
  }
  return found;
}

/** Parts that are never removed by slide cleanup even when a slide links to them. */
const STRUCTURAL_PART =
  /^ppt\/(?:presentation\.xml|slides\/|slideLayouts\/|slideMasters\/|notesMasters\/|handoutMasters\/|theme\/)/u;

function stripSlideExtras(xml: string): string {
  // Animation timing refers to shape ids of the template slide that no longer exist.
  let out = xml.replace(/<p:timing\b[\s\S]*?<\/p:timing>/u, '');
  // Relationship-bearing extensions (modern comments p188:commentRel, ...) point
  // at parts that belong to the template slide; a generated slide must not share them.
  out = out.replace(
    /<p:ext\b[^>]*>(?:(?!<\/p:ext>)[\s\S])*?\sr:[A-Za-z]+="[^"]*"[\s\S]*?<\/p:ext>/gu,
    ''
  );
  // The p14:creationId identifies the template slide; a clone must not reuse it.
  out = out.replace(/<p:ext uri="\{BB962C8B-B14F-4D97-AF65-F5344CB8AC3E\}">[\s\S]*?<\/p:ext>/u, '');
  out = out.replace(/<p:extLst>\s*<\/p:extLst>/u, '');
  return out;
}

export function replacePptxSlides(source: Buffer, spec: ReplaceSlidesSpec): ReplaceSlidesResult {
  const parts = readPptxParts(source, 'pptx_replace_slides');
  const presentationXml = partText(parts, 'ppt/presentation.xml');
  const presRelsXml = partText(parts, 'ppt/_rels/presentation.xml.rels');
  const contentTypesXml = partText(parts, '[Content_Types].xml');
  if (!presentationXml || !presRelsXml || !contentTypesXml) {
    fail(
      'source is not a presentation package',
      'ppt/presentation.xml, its rels or [Content_Types].xml is missing',
      'pass a .pptx deck',
      'required parts absent'
    );
  }
  if (!Array.isArray(spec.slides) || spec.slides.length === 0) {
    fail(
      'no replacement slides',
      'slides must be a non-empty array',
      'pass slides: [{ subtitle, blocks: [...] }]',
      `slides=${JSON.stringify(spec.slides)}`
    );
  }

  const presRels = parseRelationships(presRelsXml);
  const sldIdLst = presentationXml.match(/<p:sldIdLst>([\s\S]*?)<\/p:sldIdLst>/u);
  const sldIdEntries = parseSldIdEntries(sldIdLst?.[1] ?? '');
  if (!sldIdEntries) {
    fail(
      'cannot read the slide list',
      '<p:sldIdLst> holds <p:sldId> elements that could not be parsed',
      'repair the source deck (media:pptx_package_check shows the defect)',
      (sldIdLst?.[1] ?? '').slice(0, 200)
    );
  }
  const sldIds = sldIdEntries.map((raw) => ({
    raw,
    id: Number(readAttr(raw, 'id')),
    rid: readAttr(raw, 'r:id') ?? '',
  }));
  const slidePartAt = (index: number, label: string): string => {
    const entry = sldIds[index - 1];
    if (!Number.isInteger(index) || !entry) {
      fail(
        `${label} ${index} is out of range`,
        `the deck has ${sldIds.length} slide(s)`,
        `use a 1-based index between 1 and ${sldIds.length}`,
        `sldIdLst entries=${sldIds.length}`
      );
    }
    const rel = presRels.find((r) => r.id === entry.rid);
    if (!rel)
      fail(
        `slide ${index} has no relationship`,
        `${entry.rid} is missing from presentation.xml.rels`,
        'repair the source deck',
        entry.raw
      );
    return resolveRelTarget('ppt/_rels/presentation.xml.rels', rel.target);
  };
  const replaceIndex = Number(spec.replace_index);
  const templateIndex = Number(spec.template_index ?? spec.replace_index);
  const replacedPart = slidePartAt(replaceIndex, 'replace_index');
  const templatePart = slidePartAt(templateIndex, 'template_index');

  const templateXml = partText(parts, templatePart)!;
  const templateRels = parseRelationships(partText(parts, relsPartFor(templatePart)) ?? '');
  const replacedRels = parseRelationships(partText(parts, relsPartFor(replacedPart)) ?? '');
  const layoutRel = templateRels.find((rel) => rel.type.endsWith('/slideLayout'));
  if (!layoutRel)
    fail(
      'template slide has no layout',
      `${relsPartFor(templatePart)} lacks a slideLayout relationship`,
      'choose another template_index',
      templatePart
    );
  const layoutPart = resolveRelTarget(relsPartFor(templatePart), layoutRel.target);
  const layoutRels = parseRelationships(partText(parts, relsPartFor(layoutPart)) ?? '');
  const masterRel = layoutRels.find((rel) => rel.type.endsWith('/slideMaster'));
  const masterPart = masterRel
    ? resolveRelTarget(relsPartFor(layoutPart), masterRel.target)
    : undefined;
  const layoutShapes = partText(parts, layoutPart)
    ? shapesOf(partText(parts, layoutPart)!).shapes
    : [];
  const masterShapes =
    masterPart && partText(parts, masterPart) ? shapesOf(partText(parts, masterPart)!).shapes : [];

  // --- Geometry: slide size, head shapes, body zone -------------------------
  const sldSz = presentationXml.match(/<p:sldSz\b[^>]*>/u)?.[0] ?? '';
  const W = Number(readAttr(sldSz, 'cx')) || 12192000;
  const H = Number(readAttr(sldSz, 'cy')) || 6858000;
  const template = shapesOf(templateXml);
  for (const shape of template.shapes)
    shape.geometry = inheritGeometry(shape, layoutShapes, masterShapes);

  const subtitleShape =
    spec.subtitle_shape !== undefined && spec.subtitle_shape !== ''
      ? template.shapes.find((shape) => matchesShape(shape, spec.subtitle_shape!))
      : undefined;
  if (spec.subtitle_shape !== undefined && spec.subtitle_shape !== '' && !subtitleShape) {
    fail(
      `subtitle_shape '${spec.subtitle_shape}' not found`,
      'no shape on the template slide has that name or cNvPr id',
      'use one of the listed shape names / ids',
      template.shapes.map((s) => `${s.id}:${s.shapeName}`).join(', ')
    );
  }
  if (!subtitleShape && spec.slides.some((slide) => slide.subtitle)) {
    fail(
      'subtitle given without subtitle_shape',
      'the writer does not guess which template shape carries the subtitle',
      'pass subtitle_shape (shape name or cNvPr id)',
      template.shapes.map((s) => `${s.id}:${s.shapeName}`).join(', ')
    );
  }

  const anchors = template.shapes.filter(
    (shape) =>
      shape.geometry &&
      (shape.phType === 'title' || shape.phType === 'ctrTitle' || shape === subtitleShape)
  );
  const headLimit = anchors.length
    ? Math.max(...anchors.map((shape) => shape.geometry!.y + shape.geometry!.h))
    : H * 0.2;
  const head = template.shapes.filter(
    (shape) =>
      shape.geometry &&
      (anchors.includes(shape) ||
        (anchors.length
          ? shape.geometry.y < headLimit
          : shape.geometry.y + shape.geometry.h <= headLimit))
  );
  const headBottom = head.length
    ? Math.max(...head.map((s) => s.geometry!.y + s.geometry!.h))
    : H * 0.08;
  const left = Math.min(
    Math.max(head.length ? Math.min(...head.map((s) => s.geometry!.x)) : W * 0.046, W * 0.03),
    W * 0.12
  );
  // Footer marks: visible non-placeholder decoration of the layout / master in
  // the bottom band, plus the template slide's own footer placeholders (which
  // are carried over). Master footer placeholders only render when a slide
  // has them, and empty text boxes draw nothing, so neither limits the zone.
  const footer = template.shapes.filter(
    (shape) => shape.geometry && shape.phType && FOOTER_PH_TYPES.has(shape.phType)
  );
  const footerTops = [
    ...[...layoutShapes, ...masterShapes].filter(
      (shape) =>
        shape.geometry && !shape.phType && shape.geometry.y >= H * 0.8 && drawsSomething(shape)
    ),
    ...footer,
  ].map((shape) => shape.geometry!.y);
  const bottom = Math.min(
    H * 0.95,
    footerTops.length ? Math.min(...footerTops) - H * 0.01 : H * 0.95
  );
  const zone = {
    x: Math.round(left),
    y: Math.round(headBottom + H * 0.02),
    w: Math.round(W - 2 * left),
    h: 0,
  };
  zone.h = Math.round(bottom - zone.y);
  if (zone.h <= 0) {
    fail(
      'no body zone below the template head',
      'the head shapes reach the footer area',
      'choose a template slide with a shorter title area',
      `head bottom=${headBottom}, footer limit=${bottom}`
    );
  }

  // --- Build slide XML ----------------------------------------------------
  const headIds = head.map((shape) => Number(shape.id) || 0);
  const firstBodyId =
    Math.max(
      1,
      ...headIds,
      ...[...templateXml.matchAll(/<p:cNvPr\b[^>]*\bid="(\d+)"/gu)].map((m) => Number(m[1]))
    ) + 1;
  const prefix = templateXml.slice(0, template.range.contentStart);
  const suffix = stripSlideExtras(templateXml.slice(template.range.contentEnd));

  const slideXmls = spec.slides.map((slide, slideIndex) => {
    const blocks = requireArray<SlideBlock>(slide?.blocks, `slides[${slideIndex}].blocks`);
    const canvas = new SlideCanvas(firstBodyId, spec.theme);
    const layouts = blocks.map((block, i) =>
      layoutBlock(block, zone.w, spec.theme, canvas, `slides[${slideIndex}].blocks[${i}]`)
    );
    const sum = layouts.reduce((total, layout) => total + layout.height, 0);
    let gap = DEFAULT_BLOCK_GAP;
    if (sum + gap * (layouts.length - 1) > zone.h) {
      gap = layouts.length > 1 ? (zone.h - sum) / (layouts.length - 1) : 0;
      if (sum > zone.h || gap < MIN_BLOCK_GAP) {
        fail(
          `slide ${slideIndex + 1} overflows the body zone`,
          `blocks need ${sum + MIN_BLOCK_GAP * Math.max(0, layouts.length - 1)} EMU but the zone below the template head is ${zone.h} EMU`,
          'move blocks to another slide, shorten the text, or drop a block',
          layouts.map((layout, i) => `${blocks[i]!.type}=${layout.height}`).join(', ')
        );
      }
    }
    let cursor = zone.y;
    layouts.forEach((layout) => {
      layout.render(canvas, zone.x, cursor);
      cursor += layout.height + gap;
    });
    const headXml = template.shapes
      .filter((shape) => head.includes(shape) || footer.includes(shape))
      .map((shape) => {
        if (shape !== subtitleShape) return shape.xml;
        let xml =
          slide.subtitle !== undefined
            ? replaceShapeText(shape.xml, String(slide.subtitle))
            : shape.xml;
        const g = shape.geometry!;
        const blockers = head
          .filter(
            (other) =>
              other !== shape &&
              other.geometry!.x > g.x &&
              other.geometry!.y < g.y + g.h &&
              other.geometry!.y + other.geometry!.h > g.y
          )
          .map((other) => other.geometry!.x - 50000);
        const limit = Math.min(zone.x + zone.w, ...blockers);
        if (/<a:ext\b[^>]*\bcx=/u.test(xml) && limit - g.x > g.w)
          xml = setShapeWidth(xml, limit - g.x);
        return xml;
      })
      .join('');
    return `${prefix}${template.groupProps}${headXml}${canvas.parts.join('')}${suffix}`;
  });

  // --- Part names ---------------------------------------------------------
  const slideNumbers = [...parts.keys()]
    .map((name) => Number(name.match(/^ppt\/slides\/slide(\d+)\.xml$/u)?.[1] ?? 0))
    .filter((n) => n > 0);
  let nextSlideNumber = Math.max(0, ...slideNumbers) + 1;
  const slideParts = spec.slides.map((_, i) =>
    i === 0 ? replacedPart : `ppt/slides/slide${nextSlideNumber++}.xml`
  );

  // --- Slide parts + rels -------------------------------------------------
  const removedParts: string[] = [];
  const notesRel = replacedRels.find((rel) => rel.type.endsWith('/notesSlide'));
  // Everything only the replaced slide reached (charts and their embedded
  // workbooks, SmartArt, OLE objects, comments, tags, media, ...) is a removal
  // candidate; the layout chain and the kept notes slide are not.
  const cleanupCandidates = reachableFromRels(
    parts,
    relsPartFor(replacedPart),
    (rel) => rel.type.endsWith('/slideLayout') || rel.type.endsWith('/notesSlide')
  );
  slideXmls.forEach((xml, i) => {
    const refs = collectRelationshipRefs(xml);
    // Comments belong to the template slide's content, never to a generated slide.
    const rels = templateRels.filter(
      (rel) => rel === layoutRel || (refs.has(rel.id) && !COMMENT_REL_TYPE.test(rel.type))
    );
    if (i === 0 && notesRel) {
      const used = new Set(rels.map((rel) => rel.id));
      rels.push(used.has(notesRel.id) ? withRelId(notesRel, `rId${maxRid(used) + 1}`) : notesRel);
    }
    parts.set(slideParts[i]!, Buffer.from(xml, 'utf8'));
    parts.set(relsPartFor(slideParts[i]!), Buffer.from(relsXml(rels), 'utf8'));
  });

  // --- presentation.xml + rels -------------------------------------------
  const replacedEntry = sldIds[replaceIndex - 1]!;
  let nextSldId = Math.max(255, ...sldIds.map((entry) => entry.id).filter(Number.isFinite)) + 1;
  let nextRid = maxRid(presRels.map((rel) => rel.id)) + 1;
  const added = slideParts.slice(1).map((part) => ({
    part,
    id: nextSldId++,
    rid: `rId${nextRid++}`,
  }));
  let newPresentation = presentationXml.replace(
    replacedEntry.raw,
    replacedEntry.raw +
      added.map((entry) => `<p:sldId id="${entry.id}" r:id="${entry.rid}"/>`).join('')
  );
  // Keep slide sections complete: new slides join the replaced slide's section.
  newPresentation = newPresentation.replace(
    new RegExp(`<p14:sldId id="${replacedEntry.id}"\\s*/>`, 'u'),
    (match) => match + added.map((entry) => `<p14:sldId id="${entry.id}"/>`).join('')
  );
  parts.set('ppt/presentation.xml', Buffer.from(newPresentation, 'utf8'));
  const newPresRels = presRelsXml.replace(
    /<\/Relationships>\s*$/u,
    `${added.map((entry) => `<Relationship Id="${entry.rid}" Type="${SLIDE_REL_TYPE}" Target="${entry.part.replace(/^ppt\//u, '')}"/>`).join('')}</Relationships>`
  );
  parts.set('ppt/_rels/presentation.xml.rels', Buffer.from(newPresRels, 'utf8'));

  // --- Content types ------------------------------------------------------
  let contentTypes = contentTypesXml.replace(
    /<\/Types>\s*$/u,
    `${added.map((entry) => `<Override PartName="/${entry.part}" ContentType="${SLIDE_CONTENT_TYPE}"/>`).join('')}</Types>`
  );

  // --- Stale change history ------------------------------------------------
  for (const name of [...parts.keys()]) {
    if (name.startsWith('ppt/changesInfos/')) {
      parts.delete(name);
      removedParts.push(name);
    }
  }
  if (removedParts.length) {
    for (const name of [...parts.keys()].filter((n) => n.endsWith('.rels'))) {
      const xml = parts.get(name)!.toString('utf8');
      const kept = parseRelationships(xml).filter(
        (rel) => rel.external || !resolveRelTarget(name, rel.target).startsWith('ppt/changesInfos/')
      );
      if (kept.length !== parseRelationships(xml).length) {
        const cleaned = xml.replace(/<Relationship\b[^>]*?\/?>/gu, (raw) =>
          kept.some((rel) => rel.raw === raw) ? raw : ''
        );
        parts.set(name, Buffer.from(cleaned, 'utf8'));
      }
    }
  }

  // --- Parts only the replaced slide used ----------------------------------
  // Repeat until stable: dropping a chart unreferences its embedded workbook.
  for (let changed = true; changed;) {
    changed = false;
    const referenced = new Set<string>();
    for (const [name, data] of parts) {
      if (!name.endsWith('.rels')) continue;
      const source = sourcePartForRels(name);
      if (source && !parts.has(source)) continue;
      for (const rel of parseRelationships(data.toString('utf8'))) {
        if (rel.external || isPlaceholderTarget(rel.target)) continue;
        referenced.add(resolveRelTarget(name, rel.target));
      }
    }
    for (const candidate of cleanupCandidates) {
      if (!parts.has(candidate) || referenced.has(candidate)) continue;
      parts.delete(candidate);
      parts.delete(relsPartFor(candidate));
      removedParts.push(candidate);
      changed = true;
    }
  }
  contentTypes = contentTypes.replace(/<Override\b[^>]*\/>/gu, (override) => {
    const partName = (readAttr(override, 'PartName') ?? '').replace(/^\//u, '');
    return removedParts.includes(partName) ? '' : override;
  });
  parts.set('[Content_Types].xml', Buffer.from(contentTypes, 'utf8'));

  const buffer = writePptxParts(parts);
  // The replaced slide is rewritten wholesale: its old defects excuse nothing.
  const overwritten = new Set([replacedPart, relsPartFor(replacedPart)]);
  assertPptxPackageWrite(buffer, 'pptx_replace_slides', {
    baseline: source,
    level: spec.package_check,
    partMap: (part) => (overwritten.has(part) || removedParts.includes(part) ? undefined : part),
  });
  return { buffer, slide_parts: slideParts, removed_parts: removedParts.sort(), body_zone: zone };
}
