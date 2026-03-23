/**
 * PowerPoint Design Protocol (ADF)
 * A structured representation of PPTX visual design, capturing the heritage chain.
 */

export interface PptxPos {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface PptxGradientStop {
  position: number;  // 0-100000
  color: string;
}

export interface PptxShadow {
  type?: 'outer' | 'inner';
  blur?: number;     // EMU
  dist?: number;     // EMU
  dir?: number;      // angle in 60000ths of a degree
  color?: string;
  opacity?: number;  // 0-100
}

export interface PptxStyle {
  fill?: string;
  gradientFill?: { angle?: number; stops: PptxGradientStop[] };
  line?: string;
  lineWidth?: number;
  lineDash?: 'solid' | 'dot' | 'dash' | 'lgDash' | 'dashDot' | 'lgDashDot' | 'lgDashDotDot';
  color?: string;
  fontSize?: number;
  fontFamily?: string;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right' | 'justify';
  valign?: 'top' | 'middle' | 'bottom';
  headArrow?: boolean;
  tailArrow?: boolean;
  rotate?: number;
  opacity?: number;
  margin?: [number, number, number, number];
  shadow?: PptxShadow;
  cornerRadius?: number;  // EMU
  lineSpacing?: number;   // percentage (e.g. 115 = 115%)
  spaceBefore?: number;   // points
  spaceAfter?: number;    // points
  bullet?: {
    type: 'char' | 'autoNum' | 'none';
    char?: string;       // e.g. '•', '→', '■'
    numFormat?: string;  // e.g. 'arabicPeriod', 'romanUcPeriod'
    startAt?: number;
    color?: string;
    size?: number;       // percentage relative to text (e.g. 100)
    font?: string;       // font for bullet char
    indent?: number;     // hanging indent in inches
    level?: number;      // 0-8 indent level
  };
}

export interface PptxSmartArtData {
  dataXml?: string;
  layoutXml?: string;
  colorsXml?: string;
  quickStyleXml?: string;
  rels?: { [id: string]: { type: string, target: string } };
}

export interface PptxChartData {
  chartXml?: string;
  workbookBlob?: string; // Base64 encoded or path to extracted XLSX
  workbookTarget?: string;
  rels?: { [id: string]: { type: string, target: string } };
}

export interface PptxElement {
  type: 'shape' | 'text' | 'line' | 'image' | 'table' | 'smartart' | 'chart' | 'raw';
  name?: string;
  placeholderType?: 'title' | 'body' | 'ctrTitle' | 'subTitle' | 'dt' | 'ftr' | 'sldNum';
  pos: PptxPos;
  text?: string;
  style?: PptxStyle;
  imagePath?: string;
  imageData?: string;   // Base64-encoded image binary (for lossless round-trip without external files)
  shapeType?: string;
  rows?: string[][];
  colWidths?: number[];
  tableData?: (string | number | boolean | null)[][];
  textRuns?: PptxTextRun[];
  extensions?: string;
  cNvPrXml?: string;    // Raw <p:cNvPr> including extensions (creationId, etc.)
  cNvSpPrXml?: string;  // Raw <p:cNvSpPr> (contains spLocks, etc.)
  cNvCxnSpPrXml?: string;  // Raw <p:cNvCxnSpPr> for connectors (stCxn/endCxn)
  blipFillXml?: string;    // Raw <p:blipFill> for images (preserves crop, effects)
  nvPrXml?: string;     // Raw <p:nvPr> for placeholder + extensions
  spPrXml?: string;
  styleXml?: string;
  bodyPrXml?: string;
  lstStyleXml?: string;
  pXmlLst?: string[];
  smartArtData?: PptxSmartArtData;
  chartData?: PptxChartData;
  autofit?: 'normal' | 'shrink' | 'none';
  textColumns?: number;
  crop?: { top?: number; right?: number; bottom?: number; left?: number }; // percentages (0-100000)
  custGeomXml?: string;  // Raw <a:custGeom> XML for freeform shapes
  altText?: string;
  linkTarget?: string;
  rawXml?: string;
  rawRels?: { [oldId: string]: string };
}

export interface PptxTextRun {
  text: string;
  options?: {
    color?: string;
    fontSize?: number;
    fontFamily?: string;
    bold?: boolean;
    italic?: boolean;
    underline?: boolean;
    strike?: boolean;
    highlight?: string;
    linkTarget?: string;
  };
}

export interface PptxSlide {
  id: string;
  background?: string;
  backgroundFill?: string;
  bgXml?: string;
  transitionXml?: string;
  notesXml?: string;
  elements: PptxElement[];
  extensions?: string;
  layoutIndex?: number;  // 1-based index into layouts; defaults to 1 for first slide, 2 for others
  rawSlideXml?: string;  // Full raw slide XML for fallback reconstruction
  rawSlideRelsXml?: string;  // Full raw slide rels XML
}

export interface PptxLayoutRaw {
  name: string;           // e.g. "Title Slide", "Two Content"
  type?: string;          // OOXML layout type attribute, e.g. "title", "obj", "twoObj"
  xml: string;            // Full raw slideLayout XML content
  relsXml?: string;       // Raw .rels XML for this layout
}

export interface PptxMasterRaw {
  xml: string;            // Full raw slideMaster XML content
  relsXml?: string;       // Raw .rels XML for this master
  themeXml?: string;      // Associated theme XML (theme2.xml, etc.)
}

export interface PptxMasterMedia {
  fileName: string;       // e.g. "image1.png"
  data: string;           // Base64-encoded binary
}

export interface PptxDesignProtocol {
  version: string;
  generatedAt: string;
  canvas: { w: number, h: number };
  theme: { [key: string]: string };
  extensions?: string;
  master: {
    elements: PptxElement[],       // Master elements + layout placeholder elements (merged)
    masterOnlyCount?: number,      // Number of elements that belong to the master itself (rest are from layouts)
    extensions?: string,
    bgXml?: string,
    clrMapXml?: string,            // <p:clrMap> element
    txStylesXml?: string,          // <p:txStyles> element
  };
  slides: PptxSlide[];

  // Raw passthrough fields for faithful master/theme/layout round-trip
  rawThemeXml?: string;
  rawMasterXml?: string;
  rawMasterRelsXml?: string;
  rawLayouts?: PptxLayoutRaw[];
  rawMasters?: PptxMasterRaw[];     // All slide masters (index 0 = slideMaster1)
  masterMedia?: PptxMasterMedia[];

  // Complete passthrough: all non-slide ZIP entries (base64 encoded)
  // Keys are entry names (e.g. "ppt/slideMasters/slideMaster2.xml"), values are base64 data.
  // When present, the engine injects these directly instead of generating from semantic fields.
  rawParts?: { [entryName: string]: string };
}
