"use strict";
/**
 * Excel Utilities - Advanced Design Distillation and Tailored Re-generation.
 */
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.distillExcelDesign = distillExcelDesign;
exports.generateExcelWithDesign = generateExcelWithDesign;
const ExcelJS = __importStar(require("exceljs"));
const excel_theme_resolver_js_1 = require("./excel-theme-resolver.js");
/**
 * Distills an Excel file into a portable Design Protocol (ADF).
 */
async function distillExcelDesign(filePath) {
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(filePath);
    const theme = await (0, excel_theme_resolver_js_1.extractThemePalette)(filePath);
    const protocol = {
        version: '1.0.0',
        generatedAt: new Date().toISOString(),
        theme: theme,
        sheets: []
    };
    workbook.eachSheet((sheet) => {
        const sheetInfo = {
            name: sheet.name,
            columns: [],
            rows: [],
            merges: [],
            autoFilter: sheet.autoFilter ? JSON.stringify(sheet.autoFilter) : undefined,
            views: sheet.views
        };
        // Extract columns
        for (let i = 1; i <= (sheet.columnCount || 0); i++) {
            const col = sheet.getColumn(i);
            sheetInfo.columns.push({ index: i, width: col.width || 12 });
        }
        // Extract merges
        const internalSheet = sheet;
        if (internalSheet._merges) {
            sheetInfo.merges = Object.keys(internalSheet._merges).map(key => internalSheet._merges[key].model);
        }
        // Extract styles
        sheet.eachRow({ includeEmpty: true }, (row, rowNumber) => {
            if (rowNumber > 100)
                return;
            const rowInfo = { number: rowNumber, height: row.height, cells: {} };
            row.eachCell({ includeEmpty: true }, (cell, colNumber) => {
                rowInfo.cells[colNumber] = {
                    value: cell.value,
                    style: JSON.parse(JSON.stringify(cell.style))
                };
            });
            sheetInfo.rows.push(rowInfo);
        });
        protocol.sheets.push(sheetInfo);
    });
    return protocol;
}
/**
 * Re-generates Excel from dynamic data using a Design Protocol as a "template".
 */
async function generateExcelWithDesign(data, protocol, sheetName = 'Output', headerRowIdx = 1, dataRowIdx = 2) {
    const workbook = new ExcelJS.Workbook();
    // Refined: Ensure we have at least one sheet definition
    const templateSheet = protocol?.sheets?.find(s => s.name === sheetName) ||
        (protocol?.sheets && protocol.sheets.length > 0 ? protocol.sheets[0] : null);
    const sheet = workbook.addWorksheet(templateSheet?.name || sheetName || 'Sheet1');
    // Apply column widths (Defensive)
    if (templateSheet && templateSheet.columns && Array.isArray(templateSheet.columns)) {
        sheet.columns = templateSheet.columns.map((c) => ({ width: c.width || 15 }));
    }
    else if (data && data.length > 0 && Array.isArray(data[0])) {
        sheet.columns = data[0].map(() => ({ width: 25 }));
    }
    // Resolve Theme Colors Helper
    const resolveStyle = (style) => {
        if (!style)
            return style;
        try {
            const s = JSON.parse(JSON.stringify(style));
            if (s.fill && s.fill.fgColor && s.fill.fgColor.theme !== undefined && protocol?.theme) {
                const argb = protocol.theme[s.fill.fgColor.theme];
                if (argb)
                    s.fill.fgColor = { argb };
            }
            return s;
        }
        catch (e) {
            return style;
        }
    };
    const headerRowDef = templateSheet?.rows?.find((r) => r.number === headerRowIdx);
    const dataRowDef = templateSheet?.rows?.find((r) => r.number === dataRowIdx);
    // Apply dynamic data
    if (Array.isArray(data)) {
        data.forEach((rowData, idx) => {
            const rowNumber = headerRowIdx + idx;
            const targetRow = sheet.getRow(rowNumber);
            if (Array.isArray(rowData)) {
                rowData.forEach((val, cIdx) => {
                    const cell = targetRow.getCell(cIdx + 1);
                    cell.value = val;
                    const templateRow = (idx === 0) ? headerRowDef : dataRowDef;
                    if (templateRow && templateRow.cells && templateRow.cells[cIdx + 1]) {
                        cell.style = resolveStyle(templateRow.cells[cIdx + 1].style);
                    }
                });
            }
        });
    }
    return workbook;
}
//# sourceMappingURL=excel-utils.js.map