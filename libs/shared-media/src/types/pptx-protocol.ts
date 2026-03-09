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
  fill?: string | { transparent: boolean };
  line?: string;
  lineWidth?: number;
  color?: string;
  fontSize?: number;
  bold?: boolean;
  italic?: boolean;
  underline?: boolean;
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  headArrow?: boolean;
  tailArrow?: boolean;
  margin?: [number, number, number, number];
  isConnector?: boolean;
}

export interface PptxTextRun {
  text: string;
  options?: Partial<PptxStyle>;
}

export interface PptxElement {
  type: 'shape' | 'text' | 'line' | 'image' | 'table';
  name?: string;
  pos: PptxPos;
  text?: string;
  textRuns?: PptxTextRun[]; // For rich text
  style?: PptxStyle;
  imagePath?: string;
  tableData?: (string | { text: string; options: PptxStyle })[][]; // For tables
}

export interface PptxSlideDef {
  id: string;
  background?: string | { color: string };
  elements: PptxElement[];
}

export interface PptxDesignProtocol {
  version: string;
  generatedAt: string;
  canvas: { w: number; h: number };
  theme: { [key: string]: string };
  master: { 
    background?: string | { color: string };
    elements: PptxElement[] 
  };
  slides: PptxSlideDef[];
}

