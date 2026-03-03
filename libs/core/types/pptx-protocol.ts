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
  align?: 'left' | 'center' | 'right';
  valign?: 'top' | 'middle' | 'bottom';
  headArrow?: boolean;
  tailArrow?: boolean;
  margin?: [number, number, number, number];
}

export interface PptxElement {
  type: 'shape' | 'text' | 'line' | 'image';
  name?: string;
  pos: PptxPos;
  text?: string;
  style?: PptxStyle;
  imagePath?: string;
}

export interface PptxSlideDef {
  id: string;
  background?: string;
  elements: PptxElement[];
}

export interface PptxDesignProtocol {
  version: string;
  generatedAt: string;
  canvas: { w: number; h: number };
  theme: { [key: string]: string };
  master: { elements: PptxElement[] };
  slides: PptxSlideDef[];
}
