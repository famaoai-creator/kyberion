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

export interface PptxStyle {
  fill?: string;
  line?: string;
  lineWidth?: number;
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
  shapeType?: string;
  rows?: string[][];
  colWidths?: number[];
  tableData?: any[][];
  textRuns?: PptxTextRun[];
  extensions?: string;
  spPrXml?: string;
  styleXml?: string;
  bodyPrXml?: string;
  lstStyleXml?: string;
  pXmlLst?: string[];
  smartArtData?: PptxSmartArtData;
  chartData?: PptxChartData;
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
}

export interface PptxDesignProtocol {
  version: string;
  generatedAt: string;
  canvas: { w: number, h: number };
  theme: { [key: string]: string };
  extensions?: string;
  master: { 
    elements: PptxElement[],
    extensions?: string,
    bgXml?: string
  };
  slides: PptxSlide[];
}
