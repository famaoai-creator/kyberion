/**
 * Excel Utilities - Advanced Design Distillation and Tailored Re-generation.
 */
import * as ExcelJS from 'exceljs';
import { ExcelDesignProtocol } from './types/excel-protocol.js';
/**
 * Distills an Excel file into a portable Design Protocol (ADF).
 */
export declare function distillExcelDesign(filePath: string): Promise<ExcelDesignProtocol>;
/**
 * Re-generates Excel from dynamic data using a Design Protocol as a "template".
 */
export declare function generateExcelWithDesign(data: any[][], protocol: ExcelDesignProtocol, sheetName?: string, headerRowIdx?: number, dataRowIdx?: number): Promise<ExcelJS.Workbook>;
//# sourceMappingURL=excel-utils.d.ts.map