/**
 * Spreadsheet Design Protocol (ADF)
 * A structured representation of XLSX visual design, following the PPTX protocol pattern.
 * Based on ECMA-376 Part 1 SpreadsheetML (Chapter 18) and Open-XML-SDK schemas.
 */

// ─── Style Primitives ────────────────────────────────────────

export interface XlsxColor {
  rgb?: string;       // #RRGGBB hex
  theme?: number;     // Theme color index
  tint?: number;      // Tint modifier (-1.0 to 1.0)
  indexed?: number;   // Legacy indexed color
  auto?: boolean;
}

export interface XlsxFont {
  name?: string;
  size?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean | 'single' | 'double';
  strike?: boolean;
  color?: XlsxColor;
  family?: number;
  scheme?: 'major' | 'minor' | 'none';
  vertAlign?: 'superscript' | 'subscript';
}

export interface XlsxFill {
  patternType?: 'none' | 'solid' | 'gray125' | 'darkGray' | 'mediumGray' | 'lightGray'
    | 'darkHorizontal' | 'darkVertical' | 'darkDown' | 'darkUp' | 'darkGrid' | 'darkTrellis'
    | 'lightHorizontal' | 'lightVertical' | 'lightDown' | 'lightUp' | 'lightGrid' | 'lightTrellis';
  fgColor?: XlsxColor;
  bgColor?: XlsxColor;
  gradient?: {
    type: 'linear' | 'path';
    degree?: number;
    stops: Array<{ position: number; color: XlsxColor }>;
  };
}

export interface XlsxBorderEdge {
  style?: 'thin' | 'medium' | 'thick' | 'double' | 'dotted' | 'dashed'
    | 'dashDot' | 'dashDotDot' | 'mediumDashed' | 'mediumDashDot'
    | 'mediumDashDotDot' | 'slantDashDot' | 'hair' | 'none';
  color?: XlsxColor;
}

export interface XlsxBorder {
  left?: XlsxBorderEdge;
  right?: XlsxBorderEdge;
  top?: XlsxBorderEdge;
  bottom?: XlsxBorderEdge;
  diagonal?: XlsxBorderEdge;
  diagonalUp?: boolean;
  diagonalDown?: boolean;
}

export interface XlsxAlignment {
  horizontal?: 'general' | 'left' | 'center' | 'right' | 'fill' | 'justify' | 'centerContinuous' | 'distributed';
  vertical?: 'top' | 'center' | 'bottom' | 'justify' | 'distributed';
  wrapText?: boolean;
  shrinkToFit?: boolean;
  textRotation?: number;  // 0-180 or 255 for vertical
  indent?: number;
  readingOrder?: number;
}

export interface XlsxNumberFormat {
  id: number;
  formatCode: string;
}

// ─── Cell Style (composite of font/fill/border/alignment/numFmt) ──

export interface XlsxCellStyle {
  font?: XlsxFont;
  fill?: XlsxFill;
  border?: XlsxBorder;
  alignment?: XlsxAlignment;
  numFmt?: XlsxNumberFormat;
  protection?: { locked?: boolean; hidden?: boolean };
  // Raw XML preservation for fidelity
  xfXml?: string;
}

// ─── Named Styles ────────────────────────────────────────────

export interface XlsxNamedStyle {
  name: string;
  xfId: number;
  builtinId?: number;
  style: XlsxCellStyle;
}

// ─── Rich Text Run ───────────────────────────────────────────

export interface XlsxTextRun {
  text: string;
  font?: XlsxFont;
}

// ─── Cell ────────────────────────────────────────────────────

export interface XlsxCell {
  ref: string;            // e.g. "A1"
  type?: 's' | 'n' | 'b' | 'e' | 'str' | 'inlineStr' | 'd';
  value?: string | number | boolean;
  formula?: string;
  richText?: XlsxTextRun[];
  styleIndex?: number;    // Index into styles array
  // Raw XML preservation
  rawXml?: string;
}

// ─── Row ─────────────────────────────────────────────────────

export interface XlsxRow {
  index: number;          // 1-based row number
  height?: number;        // Row height in points
  customHeight?: boolean;
  hidden?: boolean;
  outlineLevel?: number;
  collapsed?: boolean;
  styleIndex?: number;
  cells: XlsxCell[];
}

// ─── Column Definition ───────────────────────────────────────

export interface XlsxColumn {
  min: number;            // 1-based start column
  max: number;            // 1-based end column
  width?: number;         // Column width in character units
  customWidth?: boolean;
  hidden?: boolean;
  outlineLevel?: number;
  collapsed?: boolean;
  styleIndex?: number;
  bestFit?: boolean;
}

// ─── Merge Cell ──────────────────────────────────────────────

export interface XlsxMergeCell {
  ref: string;            // e.g. "A1:C3"
}

// ─── Conditional Formatting ──────────────────────────────────

export interface XlsxDxfStyle {
  font?: XlsxFont;
  fill?: XlsxFill;
  border?: XlsxBorder;
  numFmt?: XlsxNumberFormat;
  alignment?: XlsxAlignment;
}

export interface XlsxConditionalFormat {
  sqref: string;
  rules: Array<{
    type: string;
    priority: number;
    operator?: string;
    dxfId?: number;
    formula?: string;
    style?: XlsxCellStyle;
    rawXml?: string;
  }>;
}

// ─── Data Validation ─────────────────────────────────────────

export interface XlsxDataValidation {
  sqref: string;
  type?: 'list' | 'whole' | 'decimal' | 'date' | 'time' | 'textLength' | 'custom';
  operator?: string;
  formula1?: string;
  formula2?: string;
  showDropDown?: boolean;
  showErrorMessage?: boolean;
  errorTitle?: string;
  error?: string;
  rawXml?: string;
}

// ─── Drawing (Shapes, Charts, Images in worksheet) ──────────

export interface XlsxDrawingAnchor {
  type: 'twoCellAnchor' | 'oneCellAnchor' | 'absoluteAnchor';
  from?: { col: number; colOffset: number; row: number; rowOffset: number };
  to?: { col: number; colOffset: number; row: number; rowOffset: number };
  pos?: { x: number; y: number };
  ext?: { cx: number; cy: number };
}

export interface XlsxDrawingElement {
  type: 'shape' | 'image' | 'chart' | 'group' | 'connector';
  name?: string;
  anchor: XlsxDrawingAnchor;
  text?: string;
  textRuns?: XlsxTextRun[];
  imagePath?: string;
  imageData?: string;   // Base64-encoded image binary (for lossless round-trip)
  chartXml?: string;
  shapeType?: string;
  style?: {
    fill?: XlsxColor;
    line?: { color?: XlsxColor; width?: number };
    font?: XlsxFont;
  };
  // Raw XML preservation
  spPrXml?: string;
  txBodyXml?: string;
  rawXml?: string;
  rawRels?: { [oldId: string]: string };
}

export interface XlsxDrawing {
  elements: XlsxDrawingElement[];
  rawXml?: string;
}

// ─── Table (structured table within worksheet) ───────────────

export interface XlsxTableColumn {
  id: number;
  name: string;
  totalsRowFunction?: string;
  totalsRowLabel?: string;
}

export interface XlsxTable {
  id: number;
  name: string;
  displayName: string;
  ref: string;           // e.g. "A1:D10"
  totalsRowShown?: boolean;
  headerRowCount?: number;
  columns: XlsxTableColumn[];
  styleInfo?: {
    name: string;
    showFirstColumn?: boolean;
    showLastColumn?: boolean;
    showRowStripes?: boolean;
    showColumnStripes?: boolean;
  };
  rawXml?: string;
}

// ─── Sheet View ──────────────────────────────────────────────

export interface XlsxSheetView {
  tabSelected?: boolean;
  showGridLines?: boolean;
  showRowColHeaders?: boolean;
  zoomScale?: number;
  frozenRows?: number;
  frozenCols?: number;
  rawXml?: string;
}

// ─── Page Setup ──────────────────────────────────────────────

export interface XlsxPageSetup {
  paperSize?: number;
  orientation?: 'portrait' | 'landscape';
  scale?: number;
  fitToWidth?: number;
  fitToHeight?: number;
  margins?: {
    top: number; bottom: number;
    left: number; right: number;
    header: number; footer: number;
  };
  rawXml?: string;
}

// ─── Auto Filter ─────────────────────────────────────────────

export interface XlsxAutoFilter {
  ref: string;
  rawXml?: string;
}

// ─── Worksheet ───────────────────────────────────────────────

export interface XlsxWorksheet {
  id: string;             // e.g. "sheet1"
  name: string;           // Tab name
  state?: 'visible' | 'hidden' | 'veryHidden';
  dimension?: string;     // Used range, e.g. "A1:Z100"
  sheetView?: XlsxSheetView;
  columns: XlsxColumn[];
  rows: XlsxRow[];
  mergeCells: XlsxMergeCell[];
  drawing?: XlsxDrawing;
  tables: XlsxTable[];
  conditionalFormats: XlsxConditionalFormat[];
  dataValidations: XlsxDataValidation[];
  autoFilter?: XlsxAutoFilter;
  pageSetup?: XlsxPageSetup;
  // Raw XML preservation
  sheetPrXml?: string;
  extensions?: string;
}

// ─── Theme ───────────────────────────────────────────────────

export interface XlsxTheme {
  name?: string;
  colors: { [key: string]: string };  // dk1, lt1, dk2, lt2, accent1-6, hlink, folHlink
  majorFont?: string;
  minorFont?: string;
  rawXml?: string;
}

// ─── Defined Name ────────────────────────────────────────────

export interface XlsxDefinedName {
  name: string;
  value: string;         // e.g. "Sheet1!$A$1:$D$10"
  localSheetId?: number;
  hidden?: boolean;
}

// ─── Workbook Properties ─────────────────────────────────────

export interface XlsxWorkbookProperties {
  date1904?: boolean;
  defaultThemeVersion?: number;
  rawXml?: string;
}

// ─── Root Protocol ───────────────────────────────────────────

export interface XlsxDesignProtocol {
  version: string;
  generatedAt: string;
  theme: XlsxTheme;
  styles: {
    fonts: XlsxFont[];
    fills: XlsxFill[];
    borders: XlsxBorder[];
    numFmts: XlsxNumberFormat[];
    cellXfs: XlsxCellStyle[];       // Cell format index table
    namedStyles: XlsxNamedStyle[];
    dxfs?: XlsxDxfStyle[];          // Differential formatting (for conditional formatting)
    tableStyles?: string[];
    rawStylesXml?: string;          // Full styles.xml preservation
  };
  sharedStrings: string[];           // SST table (plain text)
  sharedStringsRich?: XlsxTextRun[][];  // Rich text SST entries
  workbookProperties?: XlsxWorkbookProperties;
  definedNames: XlsxDefinedName[];
  sheets: XlsxWorksheet[];
  extensions?: string;
}
