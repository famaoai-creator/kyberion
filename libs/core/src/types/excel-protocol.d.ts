/**
 * Excel Design Protocol (ADF)
 * A structured representation of Excel visual design, independent of the original binary file.
 */
export interface ColorScheme {
    [index: number]: string;
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
    role?: 'header' | 'data' | 'footer';
    cells: {
        [col: number]: {
            value?: any;
            style?: CellDesign;
        };
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
    merges: string[];
    autoFilter?: string;
    views?: any[];
}
export interface ExcelDesignProtocol {
    version: string;
    generatedAt: string;
    theme: ColorScheme;
    sheets: SheetDesign[];
}
//# sourceMappingURL=excel-protocol.d.ts.map