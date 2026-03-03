/**
 * Excel Design Protocol (ADF)
 * A structured representation of Excel visual design, independent of the original binary file.
 */

export interface ColorScheme {
  [index: number]: string; // theme index -> ARGB
}

export interface CellDesign {
  font?: any;
  fill?: any;
  border?: any;
  alignment?: any;
}

export interface RowDesign {
  number: number;
  height?: number;
  // A row can have a 'role' (e.g., header, data, footer) to be reused for dynamic data.
  role?: 'header' | 'data' | 'footer';
  cells: {
    [col: number]: {
      value?: any;
      style?: CellDesign;
    }
  };
}

export interface ColumnDesign {
  index: number;
  width?: number;
}

export interface SheetDesign {
  name: string;
  columns: ColumnDesign[];
  rows: RowDesign[];
  merges: string[]; // e.g., ["A1:B2"]
  autoFilter?: string;
  views?: any[];
}

export interface ExcelDesignProtocol {
  version: string;
  generatedAt: string;
  theme: ColorScheme;
  sheets: SheetDesign[];
}
