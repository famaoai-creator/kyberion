/**
 * Document Design Protocol (ADF)
 * A structured representation of DOCX visual design, following the PPTX/XLSX protocol pattern.
 * Based on ECMA-376 Part 1 WordprocessingML (Chapter 17) and Open-XML-SDK schemas.
 */

// ─── Color ──────────────────────────────────────────────────

export interface DocxColor {
  val?: string;        // Hex RGB (e.g. "FF0000")
  theme?: string;      // Theme color name
  themeShade?: string;  // Shade modifier
  themeTint?: string;   // Tint modifier
}

// ─── Border ─────────────────────────────────────────────────

export interface DocxBorderEdge {
  val?: 'none' | 'single' | 'thick' | 'double' | 'dotted' | 'dashed'
    | 'dashSmallGap' | 'dotDash' | 'dotDotDash' | 'triple' | 'thinThickSmallGap'
    | 'thickThinSmallGap' | 'thinThickThinSmallGap' | 'thinThickMediumGap'
    | 'thickThinMediumGap' | 'thinThickThinMediumGap' | 'thinThickLargeGap'
    | 'thickThinLargeGap' | 'thinThickThinLargeGap' | 'wave' | 'doubleWave'
    | 'dashDotStroked' | 'threeDEmboss' | 'threeDEngrave' | 'outset' | 'inset';
  sz?: number;         // Border width in eighths of a point
  space?: number;      // Spacing in points
  color?: string;      // Hex RGB
}

// ─── Shading ────────────────────────────────────────────────

export interface DocxShading {
  val?: string;        // Pattern (e.g. "clear", "solid")
  color?: string;      // Pattern color
  fill?: string;       // Background fill color (hex RGB)
}

// ─── Run Properties ─────────────────────────────────────────

export interface DocxRunProperties {
  rStyle?: string;     // Character style ID
  rFonts?: {
    ascii?: string;
    hAnsi?: string;
    eastAsia?: string;
    cs?: string;
  };
  bold?: boolean;
  italic?: boolean;
  underline?: string;  // 'single' | 'double' | 'thick' | 'dotted' | 'dash' | 'wave' | 'none'
  strike?: boolean;
  dstrike?: boolean;
  color?: DocxColor;
  sz?: number;         // Font size in half-points (24 = 12pt)
  szCs?: number;       // Complex script font size
  highlight?: string;  // Highlight color name
  shd?: DocxShading;
  vertAlign?: 'superscript' | 'subscript' | 'baseline';
  spacing?: number;    // Letter spacing in twips
  outline?: boolean;
  shadow?: boolean;
  emboss?: boolean;
  imprint?: boolean;
  vanish?: boolean;    // Hidden text
  rawXml?: string;
}

// ─── Paragraph Properties ───────────────────────────────────

export interface DocxParagraphProperties {
  pStyle?: string;     // Paragraph style ID
  jc?: 'left' | 'center' | 'right' | 'both' | 'distribute';
  ind?: {
    left?: number;     // Twips
    right?: number;
    firstLine?: number;
    hanging?: number;
  };
  spacing?: {
    before?: number;   // Twips
    after?: number;
    line?: number;     // Line spacing (240 = single)
    lineRule?: 'auto' | 'exact' | 'atLeast';
  };
  numPr?: {
    ilvl: number;      // Indentation level
    numId: number;     // Numbering definition ID
  };
  pBdr?: {
    top?: DocxBorderEdge;
    bottom?: DocxBorderEdge;
    left?: DocxBorderEdge;
    right?: DocxBorderEdge;
    between?: DocxBorderEdge;
  };
  shd?: DocxShading;
  keepNext?: boolean;
  keepLines?: boolean;
  pageBreakBefore?: boolean;
  widowControl?: boolean;
  outlineLevel?: number;
  rPr?: DocxRunProperties;  // Default run properties for paragraph
  sectPr?: DocxSectionProperties;  // Section break (multi-section documents)
  rawXml?: string;
}

// ─── Text Run ───────────────────────────────────────────────

export interface DocxRun {
  rPr?: DocxRunProperties;
  content: DocxRunContent[];
}

export type DocxRunContent =
  | { type: 'text'; text: string }
  | { type: 'break'; breakType?: 'page' | 'column' | 'textWrapping' }
  | { type: 'tab' }
  | { type: 'drawing'; drawing: DocxDrawing }
  | { type: 'fieldChar'; fldCharType: 'begin' | 'separate' | 'end' }
  | { type: 'instrText'; text: string }
  | { type: 'sym'; font: string; char: string }
  | { type: 'rawXml'; xml: string };

// ─── Drawing (inline/anchored images and shapes) ────────────

export interface DocxDrawing {
  type: 'inline' | 'anchor';
  name?: string;
  description?: string;
  extent?: { cx: number; cy: number };  // EMUs
  // Anchor-specific
  positionH?: { relativeFrom: string; offset?: number };
  positionV?: { relativeFrom: string; offset?: number };
  behindDoc?: boolean;
  wrapType?: 'none' | 'square' | 'tight' | 'through' | 'topAndBottom';
  // Image reference
  imageRId?: string;
  imagePath?: string;
  imageData?: string;   // Base64-encoded image binary (for lossless round-trip)
  // Shape properties
  spPrXml?: string;
  rawXml?: string;
}

// ─── Hyperlink ──────────────────────────────────────────────

export interface DocxHyperlink {
  rId?: string;
  anchor?: string;
  runs: DocxRun[];
}

// ─── Bookmark ───────────────────────────────────────────────

export interface DocxBookmark {
  id: number;
  name: string;
}

// ─── Paragraph ──────────────────────────────────────────────

export type DocxParagraphContent =
  | { type: 'run'; run: DocxRun }
  | { type: 'hyperlink'; hyperlink: DocxHyperlink }
  | { type: 'bookmarkStart'; bookmark: DocxBookmark }
  | { type: 'bookmarkEnd'; id: number }
  | { type: 'rawXml'; xml: string };

export interface DocxParagraph {
  pPr?: DocxParagraphProperties;
  content: DocxParagraphContent[];
  rawXml?: string;
}

// ─── Table ──────────────────────────────────────────────────

export interface DocxTableProperties {
  tblStyle?: string;
  tblW?: { w: number; type: 'auto' | 'dxa' | 'pct' | 'nil' };
  tblInd?: { w: number; type: string };
  tblBorders?: {
    top?: DocxBorderEdge;
    left?: DocxBorderEdge;
    bottom?: DocxBorderEdge;
    right?: DocxBorderEdge;
    insideH?: DocxBorderEdge;
    insideV?: DocxBorderEdge;
  };
  tblCellMar?: {
    top?: number;
    left?: number;
    bottom?: number;
    right?: number;
  };
  jc?: string;
  rawXml?: string;
}

export interface DocxTableCellProperties {
  tcW?: { w: number; type: 'auto' | 'dxa' | 'pct' | 'nil' };
  vMerge?: 'restart' | 'continue' | undefined;
  hMerge?: 'restart' | 'continue' | undefined;
  gridSpan?: number;
  shd?: DocxShading;
  vAlign?: 'top' | 'center' | 'bottom';
  tcBorders?: {
    top?: DocxBorderEdge;
    left?: DocxBorderEdge;
    bottom?: DocxBorderEdge;
    right?: DocxBorderEdge;
  };
  rawXml?: string;
}

export interface DocxTableCell {
  tcPr?: DocxTableCellProperties;
  content: DocxBlockContent[];  // Cells contain paragraphs/tables
}

export interface DocxTableRow {
  trPr?: {
    trHeight?: { val: number; hRule?: 'atLeast' | 'exact' | 'auto' };
    tblHeader?: boolean;  // Header row repeated on each page
    rawXml?: string;
  };
  cells: DocxTableCell[];
}

export interface DocxTable {
  tblPr?: DocxTableProperties;
  tblGrid: number[];           // Column widths in twips
  rows: DocxTableRow[];
  rawXml?: string;
}

// ─── Body Content (block-level) ─────────────────────────────

export type DocxBlockContent =
  | { type: 'paragraph'; paragraph: DocxParagraph }
  | { type: 'table'; table: DocxTable }
  | { type: 'sdt'; content: DocxBlockContent[]; rawXml?: string }
  | { type: 'rawXml'; xml: string };

// ─── Section Properties ─────────────────────────────────────

export interface DocxSectionProperties {
  pgSz?: {
    w: number;         // Page width in twips
    h: number;         // Page height in twips
    orient?: 'portrait' | 'landscape';
  };
  pgMar?: {
    top: number;
    right: number;
    bottom: number;
    left: number;
    header: number;
    footer: number;
    gutter?: number;
  };
  headerRefs?: Array<{ type: 'default' | 'first' | 'even'; rId: string }>;
  footerRefs?: Array<{ type: 'default' | 'first' | 'even'; rId: string }>;
  pgNumType?: { start?: number; fmt?: string };
  cols?: { num?: number; space?: number; sep?: boolean };
  docGrid?: { linePitch?: number; type?: string };
  titlePg?: boolean;   // Different first page header/footer
  rawXml?: string;
}

// ─── Header / Footer ───────────────────────────────────────

export interface DocxHeaderFooter {
  type: 'header' | 'footer';
  rId: string;
  headerType: 'default' | 'first' | 'even';
  content: DocxBlockContent[];
  rawXml?: string;
}

// ─── Style Definition ───────────────────────────────────────

export interface DocxStyleDef {
  styleId: string;
  type: 'paragraph' | 'character' | 'table' | 'numbering';
  name: string;
  basedOn?: string;
  next?: string;
  link?: string;
  isDefault?: boolean;
  uiPriority?: number;
  semiHidden?: boolean;
  unhideWhenUsed?: boolean;
  pPr?: DocxParagraphProperties;
  rPr?: DocxRunProperties;
  tblPr?: DocxTableProperties;
  rawXml?: string;
}

// ─── Numbering Definition ───────────────────────────────────

export interface DocxAbstractNum {
  abstractNumId: number;
  levels: Array<{
    ilvl: number;
    numFmt: string;    // 'decimal' | 'bullet' | 'lowerLetter' | etc.
    lvlText: string;   // e.g. "%1." or "●"
    start?: number;
    jc?: string;
    pPr?: DocxParagraphProperties;
    rPr?: DocxRunProperties;
    rawXml?: string;
  }>;
  rawXml?: string;
}

export interface DocxNum {
  numId: number;
  abstractNumId: number;
  overrides?: Array<{
    ilvl: number;
    startOverride?: number;
  }>;
}

// ─── Theme ──────────────────────────────────────────────────

export interface DocxTheme {
  name?: string;
  colors: { [key: string]: string };  // dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink
  majorFont?: string;
  minorFont?: string;
  rawXml?: string;
}

// ─── Source / Layout / Numbering Semantics ─────────────────

export interface DocxSourceDescriptor {
  format: 'markdown' | 'html' | 'text' | 'docx';
  body?: string;
  title?: string;
  path?: string;
  basePath?: string;
}

export interface DocxLayoutProfile {
  fonts?: {
    bodyJa?: string;
    bodyEn?: string;
    headingJa?: string;
    headingEn?: string;
  };
  sizes?: {
    body?: number;       // pt
    heading1?: number;   // pt
    heading2?: number;
    heading3?: number;
    heading4?: number;
    heading5?: number;
    code?: number;
  };
  page?: {
    width?: number;      // twips
    height?: number;     // twips
    marginTop?: number;
    marginRight?: number;
    marginBottom?: number;
    marginLeft?: number;
    marginHeader?: number;
    marginFooter?: number;
    marginGutter?: number;
  };
  indent?: {
    bodyLeft?: number;         // twips
    bodyFirstLine?: number;    // twips
    bodyRight?: number;        // twips
    bodyLeftChars?: number;    // Word char unit x100
    heading4Left?: number;     // twips
    heading4Hanging?: number;  // twips
  };
  bullet?: {
    level0?: string;
    level1?: string;
    level2?: string;
  };
}

export interface DocxNumberingPolicy {
  headings?: {
    enabled?: boolean;
    preserveExisting?: boolean;
    levelFormats?: Array<'decimal' | 'decimal-dot' | 'paren-decimal' | 'circled-decimal'>;
  };
  figures?: {
    enabled?: boolean;
    format?: 'sequential' | 'chapter';
    prefix?: string;
    chapterLevel?: number;
    resetOnHeadingLevel?: number;
  };
  tables?: {
    enabled?: boolean;
    format?: 'sequential' | 'chapter';
    prefix?: string;
    chapterLevel?: number;
    resetOnHeadingLevel?: number;
  };
}

// ─── Root Protocol ──────────────────────────────────────────

export interface DocxDesignProtocol {
  version: string;
  generatedAt: string;
  source?: DocxSourceDescriptor;
  theme: DocxTheme;
  layoutProfile?: DocxLayoutProfile;
  numberingPolicy?: DocxNumberingPolicy;
  styles: {
    docDefaults?: {
      rPrDefault?: DocxRunProperties;
      pPrDefault?: DocxParagraphProperties;
    };
    definitions: DocxStyleDef[];
    rawXml?: string;
  };
  numbering?: {
    abstractNums: DocxAbstractNum[];
    nums: DocxNum[];
    rawXml?: string;
  };
  body: DocxBlockContent[];
  sections: DocxSectionProperties[];
  headersFooters: DocxHeaderFooter[];
  relationships: Array<{ id: string; type: string; target: string; targetMode?: string }>;
  extensions?: string;
}
