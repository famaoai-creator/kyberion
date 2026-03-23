import { generateNativeXlsx, safeExistsSync, safeMkdir, safeReadFile } from '@agent/core';
import type {
  XlsxCell,
  XlsxCellStyle,
  XlsxColor,
  XlsxConditionalFormat,
  XlsxDataValidation,
  XlsxDesignProtocol,
  XlsxMergeCell,
  XlsxWorksheet,
} from '../libs/core/src/types/xlsx-protocol.js';
import * as path from 'node:path';

interface TemplateSpec {
  pattern_id: string;
  title: string;
  pattern_path: string;
  output: string;
}

interface TemplateLibrary {
  library_id: string;
  templates: TemplateSpec[];
}

type Palette = {
  primary: string;
  secondary: string;
  accent: string;
  accentSoft: string;
  success: string;
  warning: string;
  danger: string;
  muted: string;
  border: string;
  text: string;
  subtext: string;
  surface: string;
};

const palettes: Record<string, Palette> = {
  executive: {
    primary: '#111827',
    secondary: '#1F2937',
    accent: '#2563EB',
    accentSoft: '#DBEAFE',
    success: '#DCFCE7',
    warning: '#FEF3C7',
    danger: '#FEE2E2',
    muted: '#F8FAFC',
    border: '#CBD5E1',
    text: '#111827',
    subtext: '#475569',
    surface: '#FFFFFF',
  },
  operator: {
    primary: '#0F172A',
    secondary: '#334155',
    accent: '#0EA5E9',
    accentSoft: '#E0F2FE',
    success: '#DCFCE7',
    warning: '#FEF3C7',
    danger: '#FEE2E2',
    muted: '#F8FAFC',
    border: '#CBD5E1',
    text: '#0F172A',
    subtext: '#475569',
    surface: '#FFFFFF',
  },
  finance: {
    primary: '#431407',
    secondary: '#7C2D12',
    accent: '#C2410C',
    accentSoft: '#FFEDD5',
    success: '#DCFCE7',
    warning: '#FEF3C7',
    danger: '#FEE2E2',
    muted: '#FFFBEB',
    border: '#E5E7EB',
    text: '#431407',
    subtext: '#7C2D12',
    surface: '#FFFFFF',
  },
};

const thinBorder = (color: string) => ({
  left: { style: 'thin' as const, color: { rgb: color } },
  right: { style: 'thin' as const, color: { rgb: color } },
  top: { style: 'thin' as const, color: { rgb: color } },
  bottom: { style: 'thin' as const, color: { rgb: color } },
});

function rgb(value: string): XlsxColor {
  return { rgb: value };
}

function colLetter(index: number): string {
  let result = '';
  let current = index;
  while (current > 0) {
    current -= 1;
    result = String.fromCharCode(65 + (current % 26)) + result;
    current = Math.floor(current / 26);
  }
  return result;
}

function textCell(ref: string, value: string | number, styleIndex: number, type: XlsxCell['type'] = 's'): XlsxCell {
  return { ref, type, value, styleIndex };
}

function createStyles(palette: Palette) {
  const border = thinBorder(palette.border);
  const cellXfs: XlsxCellStyle[] = [
    { font: { name: 'Aptos', size: 10, color: rgb(palette.text) }, fill: { patternType: 'none' }, border: {} },
    { font: { name: 'Aptos Display', size: 22, bold: true, color: rgb('#FFFFFF') }, fill: { patternType: 'solid', fgColor: rgb(palette.primary) }, border: {}, alignment: { horizontal: 'left', vertical: 'center' } },
    { font: { name: 'Aptos', size: 10, color: rgb('#E2E8F0') }, fill: { patternType: 'solid', fgColor: rgb(palette.primary) }, border: {}, alignment: { horizontal: 'left', vertical: 'center' } },
    { font: { name: 'Aptos', size: 10, bold: true, color: rgb(palette.accent) }, fill: { patternType: 'none' }, border: {}, alignment: { horizontal: 'left', vertical: 'center' } },
    { font: { name: 'Aptos', size: 10, bold: true, color: rgb('#FFFFFF') }, fill: { patternType: 'solid', fgColor: rgb(palette.secondary) }, border, alignment: { horizontal: 'center', vertical: 'center' } },
    { font: { name: 'Aptos', size: 10, color: rgb(palette.text) }, fill: { patternType: 'solid', fgColor: rgb(palette.surface) }, border, alignment: { vertical: 'center', wrapText: true } },
    { font: { name: 'Aptos', size: 10, color: rgb(palette.subtext) }, fill: { patternType: 'solid', fgColor: rgb(palette.muted) }, border, alignment: { vertical: 'center', wrapText: true } },
    { font: { name: 'Aptos', size: 11, bold: true, color: rgb('#1E3A8A') }, fill: { patternType: 'solid', fgColor: rgb(palette.accentSoft) }, border, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } },
    { font: { name: 'Aptos', size: 11, bold: true, color: rgb('#166534') }, fill: { patternType: 'solid', fgColor: rgb(palette.success) }, border, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } },
    { font: { name: 'Aptos', size: 11, bold: true, color: rgb('#92400E') }, fill: { patternType: 'solid', fgColor: rgb(palette.warning) }, border, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } },
    { font: { name: 'Aptos', size: 11, bold: true, color: rgb('#991B1B') }, fill: { patternType: 'solid', fgColor: rgb(palette.danger) }, border, alignment: { horizontal: 'center', vertical: 'center', wrapText: true } },
    { font: { name: 'Aptos', size: 10, bold: true, color: rgb(palette.text) }, fill: { patternType: 'solid', fgColor: rgb(palette.muted) }, border, alignment: { horizontal: 'left', vertical: 'center' } },
    { font: { name: 'Aptos', size: 10, bold: true, color: rgb(palette.text) }, fill: { patternType: 'solid', fgColor: rgb('#EEF2FF') }, border, alignment: { horizontal: 'left', vertical: 'center' } },
    { font: { name: 'Aptos', size: 10, bold: true, color: rgb(palette.text) }, fill: { patternType: 'solid', fgColor: rgb('#ECFEFF') }, border, alignment: { horizontal: 'left', vertical: 'center' } },
  ];
  const dxfs = [
    { font: { name: 'Aptos', size: 10, bold: true, color: rgb('#166534') }, fill: { patternType: 'solid', fgColor: rgb(palette.success), bgColor: rgb(palette.success) } },
    { font: { name: 'Aptos', size: 10, bold: true, color: rgb('#1D4ED8') }, fill: { patternType: 'solid', fgColor: rgb(palette.accentSoft), bgColor: rgb(palette.accentSoft) } },
    { font: { name: 'Aptos', size: 10, bold: true, color: rgb('#92400E') }, fill: { patternType: 'solid', fgColor: rgb(palette.warning), bgColor: rgb(palette.warning) } },
    { font: { name: 'Aptos', size: 10, bold: true, color: rgb('#991B1B') }, fill: { patternType: 'solid', fgColor: rgb(palette.danger), bgColor: rgb(palette.danger) } },
  ];
  return {
    fonts: [
      { name: 'Aptos', size: 10, color: rgb(palette.text) },
      { name: 'Aptos Display', size: 22, bold: true, color: rgb('#FFFFFF') },
      { name: 'Aptos', size: 10, color: rgb('#E2E8F0') },
    ],
    fills: [
      { patternType: 'none' },
      { patternType: 'gray125' },
      { patternType: 'solid', fgColor: rgb(palette.primary) },
      { patternType: 'solid', fgColor: rgb(palette.accentSoft) },
      { patternType: 'solid', fgColor: rgb(palette.success) },
      { patternType: 'solid', fgColor: rgb(palette.warning) },
      { patternType: 'solid', fgColor: rgb(palette.danger) },
      { patternType: 'solid', fgColor: rgb(palette.muted) },
    ],
    borders: [{}, border],
    numFmts: [],
    cellXfs,
    namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0 }],
    dxfs,
    map: {
      base: 0,
      title: 1,
      subtitle: 2,
      label: 3,
      header: 4,
      body: 5,
      muted: 6,
      cardInfo: 7,
      cardSuccess: 8,
      cardWarning: 9,
      cardDanger: 10,
      section: 11,
      sectionAlt: 12,
      sectionSoft: 13,
    },
  };
}

function baseProtocol(name: string, palette: Palette, sheets: XlsxWorksheet[]): XlsxDesignProtocol {
  const styles = createStyles(palette);
  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    theme: {
      name,
      colors: {
        dk1: palette.primary.replace('#', ''),
        lt1: palette.surface.replace('#', ''),
        dk2: palette.secondary.replace('#', ''),
        lt2: palette.muted.replace('#', ''),
        accent1: palette.accent.replace('#', ''),
        accent2: palette.secondary.replace('#', ''),
        accent3: '7C3AED',
        accent4: 'EA580C',
        accent5: 'DC2626',
        accent6: '65A30D',
      },
      majorFont: 'Aptos Display',
      minorFont: 'Aptos',
    },
    styles: {
      fonts: styles.fonts,
      fills: styles.fills,
      borders: styles.borders,
      numFmts: styles.numFmts,
      cellXfs: styles.cellXfs,
      namedStyles: styles.namedStyles,
      dxfs: styles.dxfs,
    },
    sharedStrings: [],
    sharedStringsRich: [],
    definedNames: [],
    workbookProperties: { defaultThemeVersion: 164011 },
    sheets,
  };
}

function buildExecutiveDashboard(): XlsxDesignProtocol {
  const palette = palettes.executive;
  const styles = createStyles(palette).map;
  const rows = [
    { index: 1, height: 32, customHeight: true, cells: [textCell('A1', 'Executive Dashboard', styles.title)] },
    { index: 2, height: 20, customHeight: true, cells: [textCell('A2', 'Leadership overview / portfolio posture / key decisions', styles.subtitle)] },
    { index: 3, height: 16, customHeight: true, cells: [textCell('A3', 'BOARD SNAPSHOT', styles.label)] },
    { index: 4, height: 24, customHeight: true, cells: [
      textCell('A4', 'Revenue\n$4.8M', styles.cardInfo),
      textCell('C4', 'Margin\n38%', styles.cardSuccess),
      textCell('E4', 'At Risk\n3 items', styles.cardWarning),
      textCell('G4', 'Escalations\n1 open', styles.cardDanger),
    ] },
    { index: 6, height: 22, customHeight: true, cells: [
      textCell('A6', 'Portfolio', styles.header),
      textCell('B6', 'Owner', styles.header),
      textCell('C6', 'Stage', styles.header),
      textCell('D6', 'Health', styles.header),
      textCell('E6', 'Delivery', styles.header),
      textCell('F6', 'Revenue', styles.header),
      textCell('G6', 'Decision', styles.header),
      textCell('H6', 'Notes', styles.header),
    ] },
    { index: 7, cells: [textCell('A7', 'Northstar rollout', styles.body), textCell('B7', 'COO', styles.body), textCell('C7', 'Scale', styles.body), textCell('D7', 'Green', styles.body), textCell('E7', 'On track', styles.body), textCell('F7', '$1.2M', styles.body), textCell('G7', 'Approve capacity', styles.body), textCell('H7', 'Expansion motion is ahead of plan.', styles.body)] },
    { index: 8, cells: [textCell('A8', 'Data platform refresh', styles.body), textCell('B8', 'CTO', styles.body), textCell('C8', 'Migration', styles.body), textCell('D8', 'Watch', styles.body), textCell('E8', 'Vendor risk', styles.body), textCell('F8', '$0.9M', styles.body), textCell('G8', 'Confirm backup path', styles.body), textCell('H8', 'One dependency cluster is still unresolved.', styles.body)] },
    { index: 9, cells: [textCell('A9', 'Advisory upsell wave', styles.body), textCell('B9', 'CRO', styles.body), textCell('C9', 'Close', styles.body), textCell('D9', 'Green', styles.body), textCell('E9', 'Ahead', styles.body), textCell('F9', '$0.6M', styles.body), textCell('G9', 'Keep pacing', styles.body), textCell('H9', 'Strong sponsor engagement across top accounts.', styles.body)] },
    { index: 10, cells: [textCell('A10', 'Internal AI operating model', styles.body), textCell('B10', 'Ops Lead', styles.body), textCell('C10', 'Pilot', styles.body), textCell('D10', 'Red', styles.body), textCell('E10', 'Slipping', styles.body), textCell('F10', '$0.2M', styles.body), textCell('G10', 'Reset launch', styles.body), textCell('H10', 'Needs scope reduction and one temporary hire.', styles.body)] },
    { index: 12, height: 20, customHeight: true, cells: [textCell('A12', 'Decision Notes', styles.section)] },
    { index: 13, height: 42, customHeight: true, cells: [textCell('A13', '1. Approve capacity for rollout support.\n2. Decide by March 31, 2026 whether to de-risk the migration path.\n3. Shift one launch to Q3 if staffing remains constrained.', styles.body)] },
  ];
  const sheet: XlsxWorksheet = {
    id: 'sheet1',
    name: 'Summary',
    dimension: 'A1:H13',
    sheetView: { showGridLines: false, zoomScale: 95, frozenRows: 6 },
    columns: [
      { min: 1, max: 1, width: 24, customWidth: true },
      { min: 2, max: 2, width: 14, customWidth: true },
      { min: 3, max: 3, width: 12, customWidth: true },
      { min: 4, max: 4, width: 10, customWidth: true },
      { min: 5, max: 5, width: 14, customWidth: true },
      { min: 6, max: 6, width: 12, customWidth: true },
      { min: 7, max: 7, width: 18, customWidth: true },
      { min: 8, max: 8, width: 34, customWidth: true },
    ],
    rows,
    mergeCells: [
      { ref: 'A1:H1' }, { ref: 'A2:H2' }, { ref: 'A3:H3' },
      { ref: 'A4:B5' }, { ref: 'C4:D5' }, { ref: 'E4:F5' }, { ref: 'G4:H5' },
      { ref: 'A12:H12' }, { ref: 'A13:H13' },
    ],
    tables: [],
    conditionalFormats: [{
      sqref: 'A7:H10',
      rules: [
        { type: 'expression', priority: 1, dxfId: 0, formula: '$D7="Green"' },
        { type: 'expression', priority: 2, dxfId: 2, formula: '$D7="Watch"' },
        { type: 'expression', priority: 3, dxfId: 3, formula: '$D7="Red"' },
      ],
    }],
    dataValidations: [],
    autoFilter: { ref: 'A6:H10' },
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  };
  const notes: XlsxWorksheet = {
    id: 'sheet2',
    name: 'Notes',
    dimension: 'A1:F8',
    sheetView: { showGridLines: false, zoomScale: 95 },
    columns: [
      { min: 1, max: 1, width: 20, customWidth: true },
      { min: 2, max: 2, width: 18, customWidth: true },
      { min: 3, max: 3, width: 18, customWidth: true },
      { min: 4, max: 4, width: 18, customWidth: true },
      { min: 5, max: 5, width: 18, customWidth: true },
      { min: 6, max: 6, width: 24, customWidth: true },
    ],
    rows: [
      { index: 1, height: 30, customHeight: true, cells: [textCell('A1', 'Decision Log', styles.title)] },
      { index: 2, height: 18, customHeight: true, cells: [textCell('A2', 'Supporting assumptions and next review dates', styles.subtitle)] },
      { index: 4, height: 22, customHeight: true, cells: [textCell('A4', 'Decision', styles.header), textCell('B4', 'Owner', styles.header), textCell('C4', 'Due', styles.header), textCell('D4', 'Impact', styles.header), textCell('E4', 'Status', styles.header), textCell('F4', 'Context', styles.header)] },
      { index: 5, cells: [textCell('A5', 'Capacity approval', styles.body), textCell('B5', 'COO', styles.body), textCell('C5', '2026-03-31', styles.body), textCell('D5', 'High', styles.body), textCell('E5', 'Pending', styles.body), textCell('F5', 'Needed to protect launch quality.', styles.body)] },
      { index: 6, cells: [textCell('A6', 'Migration backup path', styles.body), textCell('B6', 'CTO', styles.body), textCell('C6', '2026-04-05', styles.body), textCell('D6', 'Medium', styles.body), textCell('E6', 'Open', styles.body), textCell('F6', 'Vendor alternative should be validated before commitment.', styles.body)] },
    ],
    mergeCells: [{ ref: 'A1:F1' }, { ref: 'A2:F2' }],
    tables: [],
    conditionalFormats: [],
    dataValidations: [],
    autoFilter: { ref: 'A4:F6' },
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  };
  return baseProtocol('Executive Dashboard', palette, [sheet, notes]);
}

function buildOpsTracker(): XlsxDesignProtocol {
  const palette = palettes.operator;
  const styles = createStyles(palette).map;
  const validations: XlsxDataValidation[] = [
    { sqref: 'G6:G12', type: 'list', formula1: '"Done,In Progress,Watch,Blocked"', showErrorMessage: true, errorTitle: 'Invalid Status', error: 'Use one of: Done, In Progress, Watch, Blocked' },
    { sqref: 'H6:H12', type: 'list', formula1: '"P1,P2,P3"', showErrorMessage: true, errorTitle: 'Invalid Priority', error: 'Use one of: P1, P2, P3' },
  ];
  const cond: XlsxConditionalFormat[] = [{
    sqref: 'A6:I12',
    rules: [
      { type: 'expression', priority: 1, dxfId: 0, formula: '$G6="Done"' },
      { type: 'expression', priority: 2, dxfId: 1, formula: '$G6="In Progress"' },
      { type: 'expression', priority: 3, dxfId: 2, formula: '$G6="Watch"' },
      { type: 'expression', priority: 4, dxfId: 3, formula: '$G6="Blocked"' },
    ],
  }];
  const sheet: XlsxWorksheet = {
    id: 'sheet1',
    name: 'Tracker',
    dimension: 'A1:I14',
    sheetView: { showGridLines: false, zoomScale: 92, frozenRows: 5 },
    columns: [
      { min: 1, max: 1, width: 12, customWidth: true },
      { min: 2, max: 2, width: 18, customWidth: true },
      { min: 3, max: 3, width: 34, customWidth: true },
      { min: 4, max: 4, width: 16, customWidth: true },
      { min: 5, max: 5, width: 12, customWidth: true },
      { min: 6, max: 6, width: 12, customWidth: true },
      { min: 7, max: 7, width: 14, customWidth: true },
      { min: 8, max: 8, width: 10, customWidth: true },
      { min: 9, max: 9, width: 26, customWidth: true },
    ],
    rows: [
      { index: 1, height: 32, customHeight: true, cells: [textCell('A1', 'Operations Tracker', styles.title)] },
      { index: 2, height: 20, customHeight: true, cells: [textCell('A2', 'Daily control sheet / governed statuses / weekly review cadence', styles.subtitle)] },
      { index: 3, height: 20, customHeight: true, cells: [textCell('A3', 'Open 7', styles.cardInfo), textCell('C3', 'Done 12', styles.cardSuccess), textCell('E3', 'Watch 3', styles.cardWarning), textCell('G3', 'Blocked 1', styles.cardDanger)] },
      { index: 4, height: 18, customHeight: true, cells: [textCell('A4', 'TRACKER OVERVIEW', styles.label)] },
      { index: 5, height: 22, customHeight: true, cells: [textCell('A5', 'Stream', styles.header), textCell('B5', 'Work Item', styles.header), textCell('C5', 'Summary', styles.header), textCell('D5', 'Owner', styles.header), textCell('E5', 'Start', styles.header), textCell('F5', 'Due', styles.header), textCell('G5', 'Status', styles.header), textCell('H5', 'Priority', styles.header), textCell('I5', 'Next Action', styles.header)] },
      { index: 6, cells: [textCell('A6', 'Core', styles.body), textCell('B6', 'OPS-01', styles.body), textCell('C6', 'Standardize intake prompts across recurring requests.', styles.body), textCell('D6', 'Ayaka', styles.body), textCell('E6', '2026-03-24', styles.body), textCell('F6', '2026-03-29', styles.body), textCell('G6', 'In Progress', styles.body), textCell('H6', 'P1', styles.body), textCell('I6', 'Finalize operator checklist.', styles.body)] },
      { index: 7, cells: [textCell('A7', 'Core', styles.body), textCell('B7', 'OPS-02', styles.body), textCell('C7', 'Roll out mission-ready spreadsheet templates.', styles.body), textCell('D7', 'Toma', styles.body), textCell('E7', '2026-03-25', styles.body), textCell('F7', '2026-03-31', styles.body), textCell('G7', 'Watch', styles.body), textCell('H7', 'P2', styles.body), textCell('I7', 'Confirm workbook QA path.', styles.body)] },
      { index: 8, cells: [textCell('A8', 'Reporting', styles.body), textCell('B8', 'REP-01', styles.body), textCell('C8', 'Align KPI definitions for weekly leadership rollup.', styles.body), textCell('D8', 'Mina', styles.body), textCell('E8', '2026-03-23', styles.body), textCell('F8', '2026-03-28', styles.body), textCell('G8', 'Done', styles.body), textCell('H8', 'P2', styles.body), textCell('I8', 'Hand off to dashboard owner.', styles.body)] },
      { index: 9, cells: [textCell('A9', 'Reporting', styles.body), textCell('B9', 'REP-02', styles.body), textCell('C9', 'Document variance rules for monthly close.', styles.body), textCell('D9', 'Ken', styles.body), textCell('E9', '2026-03-26', styles.body), textCell('F9', '2026-04-01', styles.body), textCell('G9', 'Blocked', styles.body), textCell('H9', 'P1', styles.body), textCell('I9', 'Waiting on finance review.', styles.body)] },
      { index: 10, cells: [textCell('A10', 'Enablement', styles.body), textCell('B10', 'EN-01', styles.body), textCell('C10', 'Train operators on status and review conventions.', styles.body), textCell('D10', 'Ryo', styles.body), textCell('E10', '2026-03-27', styles.body), textCell('F10', '2026-04-03', styles.body), textCell('G10', 'In Progress', styles.body), textCell('H10', 'P3', styles.body), textCell('I10', 'Schedule the second cohort.', styles.body)] },
      { index: 11, cells: [textCell('A11', 'Enablement', styles.body), textCell('B11', 'EN-02', styles.body), textCell('C11', 'Publish a reference library for workbook patterns.', styles.body), textCell('D11', 'Aya', styles.body), textCell('E11', '2026-03-28', styles.body), textCell('F11', '2026-04-04', styles.body), textCell('G11', 'Done', styles.body), textCell('H11', 'P3', styles.body), textCell('I11', 'Shared to the knowledge base.', styles.body)] },
      { index: 12, cells: [textCell('A12', 'Governance', styles.body), textCell('B12', 'GOV-01', styles.body), textCell('C12', 'Confirm weekly review owner and escalation rules.', styles.body), textCell('D12', 'Nao', styles.body), textCell('E12', '2026-03-24', styles.body), textCell('F12', '2026-03-30', styles.body), textCell('G12', 'Watch', styles.body), textCell('H12', 'P1', styles.body), textCell('I12', 'Needs sponsor confirmation.', styles.body)] },
      { index: 14, height: 18, customHeight: true, cells: [textCell('A14', 'Meaning colors: green=done, blue=in progress, amber=watch, red=blocked.', styles.sectionSoft)] },
    ],
    mergeCells: [{ ref: 'A1:I1' }, { ref: 'A2:I2' }, { ref: 'A3:B4' }, { ref: 'C3:D4' }, { ref: 'E3:F4' }, { ref: 'G3:H4' }, { ref: 'A14:I14' }],
    tables: [],
    conditionalFormats: cond,
    dataValidations: validations,
    autoFilter: { ref: 'A5:I12' },
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  };
  return baseProtocol('Operations Tracker', palette, [sheet]);
}

function buildQbrWorkbook(): XlsxDesignProtocol {
  const palette = palettes.executive;
  const styles = createStyles(palette).map;
  const summary: XlsxWorksheet = {
    id: 'sheet1',
    name: 'Summary',
    dimension: 'A1:H12',
    sheetView: { showGridLines: false, zoomScale: 95, frozenRows: 6 },
    columns: [
      { min: 1, max: 1, width: 24, customWidth: true }, { min: 2, max: 2, width: 18, customWidth: true },
      { min: 3, max: 3, width: 12, customWidth: true }, { min: 4, max: 4, width: 12, customWidth: true },
      { min: 5, max: 5, width: 12, customWidth: true }, { min: 6, max: 6, width: 14, customWidth: true },
      { min: 7, max: 7, width: 14, customWidth: true }, { min: 8, max: 8, width: 28, customWidth: true },
    ],
    rows: [
      { index: 1, height: 32, customHeight: true, cells: [textCell('A1', 'Quarterly Business Review', styles.title)] },
      { index: 2, height: 20, customHeight: true, cells: [textCell('A2', 'Performance summary / KPI detail / risks and asks', styles.subtitle)] },
      { index: 3, height: 16, customHeight: true, cells: [textCell('A3', 'QBR SUMMARY', styles.label)] },
      { index: 4, height: 24, customHeight: true, cells: [textCell('A4', 'NRR\n118%', styles.cardSuccess), textCell('C4', 'NPS\n54', styles.cardInfo), textCell('E4', 'SLA\n99.5%', styles.cardSuccess), textCell('G4', 'Risks\n2 open', styles.cardWarning)] },
      { index: 6, height: 22, customHeight: true, cells: [textCell('A6', 'Initiative', styles.header), textCell('B6', 'Owner', styles.header), textCell('C6', 'Quarter Goal', styles.header), textCell('D6', 'Actual', styles.header), textCell('E6', 'Health', styles.header), textCell('F6', 'Renewal', styles.header), textCell('G6', 'Expansion', styles.header), textCell('H6', 'Notes', styles.header)] },
      { index: 7, cells: [textCell('A7', 'Enterprise success pod', styles.body), textCell('B7', 'CS Lead', styles.body), textCell('C7', 'Retain top 20', styles.body), textCell('D7', '19 retained', styles.body), textCell('E7', 'Green', styles.body), textCell('F7', '96%', styles.body), textCell('G7', '$220K', styles.body), textCell('H7', 'Strong sponsor alignment.', styles.body)] },
      { index: 8, cells: [textCell('A8', 'Mid-market onboarding', styles.body), textCell('B8', 'Ops Lead', styles.body), textCell('C8', 'Reduce setup time', styles.body), textCell('D8', '-18%', styles.body), textCell('E8', 'Green', styles.body), textCell('F8', '93%', styles.body), textCell('G8', '$140K', styles.body), textCell('H8', 'Reusable templates accelerated adoption.', styles.body)] },
      { index: 9, cells: [textCell('A9', 'Analytics rollout', styles.body), textCell('B9', 'Product', styles.body), textCell('C9', '3 lighthouse accounts', styles.body), textCell('D9', '2 complete', styles.body), textCell('E9', 'Watch', styles.body), textCell('F9', 'n/a', styles.body), textCell('G9', '$60K', styles.body), textCell('H9', 'One deployment depends on data model cleanup.', styles.body)] },
      { index: 11, height: 18, customHeight: true, cells: [textCell('A11', 'Ask: protect implementation headcount and maintain analytics rollout scope through Q3.', styles.section)] },
      { index: 12, height: 18, customHeight: true, cells: [textCell('A12', 'Prepared for sponsor review on March 29, 2026.', styles.muted)] },
    ],
    mergeCells: [{ ref: 'A1:H1' }, { ref: 'A2:H2' }, { ref: 'A3:H3' }, { ref: 'A4:B5' }, { ref: 'C4:D5' }, { ref: 'E4:F5' }, { ref: 'G4:H5' }, { ref: 'A11:H11' }, { ref: 'A12:H12' }],
    tables: [],
    conditionalFormats: [{ sqref: 'A7:H9', rules: [{ type: 'expression', priority: 1, dxfId: 0, formula: '$E7="Green"' }, { type: 'expression', priority: 2, dxfId: 2, formula: '$E7="Watch"' }, { type: 'expression', priority: 3, dxfId: 3, formula: '$E7="Red"' }] }],
    dataValidations: [],
    autoFilter: { ref: 'A6:H9' },
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  };
  const details: XlsxWorksheet = {
    id: 'sheet2',
    name: 'KPI Detail',
    dimension: 'A1:F10',
    sheetView: { showGridLines: false, zoomScale: 95, frozenRows: 4 },
    columns: [
      { min: 1, max: 1, width: 20, customWidth: true }, { min: 2, max: 2, width: 16, customWidth: true },
      { min: 3, max: 3, width: 16, customWidth: true }, { min: 4, max: 4, width: 16, customWidth: true },
      { min: 5, max: 5, width: 16, customWidth: true }, { min: 6, max: 6, width: 24, customWidth: true },
    ],
    rows: [
      { index: 1, height: 30, customHeight: true, cells: [textCell('A1', 'KPI Detail', styles.title)] },
      { index: 2, height: 18, customHeight: true, cells: [textCell('A2', 'Metric trends and commentary', styles.subtitle)] },
      { index: 4, height: 22, customHeight: true, cells: [textCell('A4', 'Metric', styles.header), textCell('B4', 'Q-1', styles.header), textCell('C4', 'Q', styles.header), textCell('D4', 'Target', styles.header), textCell('E4', 'Variance', styles.header), textCell('F4', 'Commentary', styles.header)] },
      { index: 5, cells: [textCell('A5', 'Net Revenue Retention', styles.body), textCell('B5', '114%', styles.body), textCell('C5', '118%', styles.body), textCell('D5', '116%', styles.body), textCell('E5', '+2 pts', styles.body), textCell('F5', 'Expansion outpaced churn assumptions.', styles.body)] },
      { index: 6, cells: [textCell('A6', 'NPS', styles.body), textCell('B6', '49', styles.body), textCell('C6', '54', styles.body), textCell('D6', '52', styles.body), textCell('E6', '+2', styles.body), textCell('F6', 'Improved implementation quality reduced friction.', styles.body)] },
      { index: 7, cells: [textCell('A7', 'Implementation SLA', styles.body), textCell('B7', '98.8%', styles.body), textCell('C7', '99.5%', styles.body), textCell('D7', '99.0%', styles.body), textCell('E7', '+0.5 pts', styles.body), textCell('F7', 'Runbook discipline improved consistency.', styles.body)] },
      { index: 8, cells: [textCell('A8', 'Setup time', styles.body), textCell('B8', '14 days', styles.body), textCell('C8', '11.5 days', styles.body), textCell('D8', '12 days', styles.body), textCell('E8', '-0.5 day', styles.body), textCell('F8', 'Templates removed repeat admin work.', styles.body)] },
    ],
    mergeCells: [{ ref: 'A1:F1' }, { ref: 'A2:F2' }],
    tables: [],
    conditionalFormats: [],
    dataValidations: [],
    autoFilter: { ref: 'A4:F8' },
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  };
  const risks: XlsxWorksheet = {
    id: 'sheet3',
    name: 'Risks',
    dimension: 'A1:G8',
    sheetView: { showGridLines: false, zoomScale: 95, frozenRows: 4 },
    columns: [
      { min: 1, max: 1, width: 14, customWidth: true }, { min: 2, max: 2, width: 30, customWidth: true },
      { min: 3, max: 3, width: 12, customWidth: true }, { min: 4, max: 4, width: 12, customWidth: true },
      { min: 5, max: 5, width: 12, customWidth: true }, { min: 6, max: 6, width: 14, customWidth: true }, { min: 7, max: 7, width: 28, customWidth: true },
    ],
    rows: [
      { index: 1, height: 30, customHeight: true, cells: [textCell('A1', 'Risks and Asks', styles.title)] },
      { index: 2, height: 18, customHeight: true, cells: [textCell('A2', 'Items requiring sponsor visibility or intervention', styles.subtitle)] },
      { index: 4, height: 22, customHeight: true, cells: [textCell('A4', 'Type', styles.header), textCell('B4', 'Item', styles.header), textCell('C4', 'Owner', styles.header), textCell('D4', 'Impact', styles.header), textCell('E4', 'Status', styles.header), textCell('F4', 'Due', styles.header), textCell('G4', 'Response', styles.header)] },
      { index: 5, cells: [textCell('A5', 'Risk', styles.body), textCell('B5', 'Analytics dependency may delay one lighthouse account.', styles.body), textCell('C5', 'Product', styles.body), textCell('D5', 'High', styles.body), textCell('E5', 'Open', styles.body), textCell('F5', '2026-04-02', styles.body), textCell('G5', 'Prioritize schema cleanup and stage the release.', styles.body)] },
      { index: 6, cells: [textCell('A6', 'Ask', styles.body), textCell('B6', 'Protect one implementation hire through Q3.', styles.body), textCell('C6', 'COO', styles.body), textCell('D6', 'Medium', styles.body), textCell('E6', 'Pending', styles.body), textCell('F6', '2026-03-31', styles.body), textCell('G6', 'Prevents SLA regression during expansion.', styles.body)] },
    ],
    mergeCells: [{ ref: 'A1:G1' }, { ref: 'A2:G2' }],
    tables: [],
    conditionalFormats: [],
    dataValidations: [],
    autoFilter: { ref: 'A4:G6' },
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  };
  return baseProtocol('QBR Workbook', palette, [summary, details, risks]);
}

function buildBudgetVsActual(): XlsxDesignProtocol {
  const palette = palettes.finance;
  const styles = createStyles(palette).map;
  const summary: XlsxWorksheet = {
    id: 'sheet1',
    name: 'Summary',
    dimension: 'A1:G11',
    sheetView: { showGridLines: false, zoomScale: 95, frozenRows: 6 },
    columns: [
      { min: 1, max: 1, width: 22, customWidth: true }, { min: 2, max: 2, width: 14, customWidth: true },
      { min: 3, max: 3, width: 14, customWidth: true }, { min: 4, max: 4, width: 14, customWidth: true },
      { min: 5, max: 5, width: 14, customWidth: true }, { min: 6, max: 6, width: 12, customWidth: true }, { min: 7, max: 7, width: 28, customWidth: true },
    ],
    rows: [
      { index: 1, height: 32, customHeight: true, cells: [textCell('A1', 'Budget vs Actual', styles.title)] },
      { index: 2, height: 20, customHeight: true, cells: [textCell('A2', 'Monthly variance review / account-level drilldown / assumption log', styles.subtitle)] },
      { index: 3, height: 16, customHeight: true, cells: [textCell('A3', 'VARIANCE SUMMARY', styles.label)] },
      { index: 4, height: 24, customHeight: true, cells: [textCell('A4', 'Budget\n$2.4M', styles.cardInfo), textCell('C4', 'Actual\n$2.31M', styles.cardSuccess), textCell('E4', 'Variance\n-$90K', styles.cardWarning)] },
      { index: 6, height: 22, customHeight: true, cells: [textCell('A6', 'Account', styles.header), textCell('B6', 'Budget', styles.header), textCell('C6', 'Actual', styles.header), textCell('D6', 'Variance', styles.header), textCell('E6', 'Variance %', styles.header), textCell('F6', 'Status', styles.header), textCell('G6', 'Commentary', styles.header)] },
      { index: 7, cells: [textCell('A7', 'People', styles.body), textCell('B7', '$980K', styles.body), textCell('C7', '$1.02M', styles.body), textCell('D7', '$40K', styles.body), textCell('E7', '4.1%', styles.body), textCell('F7', 'Watch', styles.body), textCell('G7', 'Temporary contractor load drove the delta.', styles.body)] },
      { index: 8, cells: [textCell('A8', 'Software', styles.body), textCell('B8', '$420K', styles.body), textCell('C8', '$401K', styles.body), textCell('D8', '-$19K', styles.body), textCell('E8', '-4.5%', styles.body), textCell('F8', 'Good', styles.body), textCell('G8', 'Vendor consolidation reduced spend.', styles.body)] },
      { index: 9, cells: [textCell('A9', 'Advisory', styles.body), textCell('B9', '$610K', styles.body), textCell('C9', '$575K', styles.body), textCell('D9', '-$35K', styles.body), textCell('E9', '-5.7%', styles.body), textCell('F9', 'Good', styles.body), textCell('G9', 'Pacing remains below plan but within range.', styles.body)] },
      { index: 10, cells: [textCell('A10', 'Facilities', styles.body), textCell('B10', '$390K', styles.body), textCell('C10', '$314K', styles.body), textCell('D10', '-$76K', styles.body), textCell('E10', '-19.5%', styles.body), textCell('F10', 'Good', styles.body), textCell('G10', 'Office utilization stayed below forecast.', styles.body)] },
    ],
    mergeCells: [{ ref: 'A1:G1' }, { ref: 'A2:G2' }, { ref: 'A3:G3' }, { ref: 'A4:B5' }, { ref: 'C4:D5' }, { ref: 'E4:F5' }],
    tables: [],
    conditionalFormats: [{ sqref: 'A7:G10', rules: [{ type: 'expression', priority: 1, dxfId: 0, formula: '$F7="Good"' }, { type: 'expression', priority: 2, dxfId: 2, formula: '$F7="Watch"' }, { type: 'expression', priority: 3, dxfId: 3, formula: '$F7="Risk"' }] }],
    dataValidations: [],
    autoFilter: { ref: 'A6:G10' },
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  };
  const detail: XlsxWorksheet = {
    id: 'sheet2',
    name: 'Account Detail',
    dimension: 'A1:H9',
    sheetView: { showGridLines: false, zoomScale: 95, frozenRows: 4 },
    columns: [
      { min: 1, max: 1, width: 16, customWidth: true }, { min: 2, max: 2, width: 26, customWidth: true }, { min: 3, max: 3, width: 14, customWidth: true }, { min: 4, max: 4, width: 14, customWidth: true }, { min: 5, max: 5, width: 14, customWidth: true }, { min: 6, max: 6, width: 14, customWidth: true }, { min: 7, max: 7, width: 12, customWidth: true }, { min: 8, max: 8, width: 24, customWidth: true },
    ],
    rows: [
      { index: 1, height: 30, customHeight: true, cells: [textCell('A1', 'Account Detail', styles.title)] },
      { index: 2, height: 18, customHeight: true, cells: [textCell('A2', 'Detailed monthly line items for review', styles.subtitle)] },
      { index: 4, height: 22, customHeight: true, cells: [textCell('A4', 'Account', styles.header), textCell('B4', 'Line Item', styles.header), textCell('C4', 'Jan', styles.header), textCell('D4', 'Feb', styles.header), textCell('E4', 'Mar', styles.header), textCell('F4', 'Quarter Total', styles.header), textCell('G4', 'Status', styles.header), textCell('H4', 'Commentary', styles.header)] },
      { index: 5, cells: [textCell('A5', 'People', styles.body), textCell('B5', 'Contractors', styles.body), textCell('C5', '$110K', styles.body), textCell('D5', '$118K', styles.body), textCell('E5', '$125K', styles.body), textCell('F5', '$353K', styles.body), textCell('G5', 'Watch', styles.body), textCell('H5', 'Backfilled one program gap.', styles.body)] },
      { index: 6, cells: [textCell('A6', 'Software', styles.body), textCell('B6', 'Infrastructure', styles.body), textCell('C6', '$132K', styles.body), textCell('D6', '$135K', styles.body), textCell('E6', '$134K', styles.body), textCell('F6', '$401K', styles.body), textCell('G6', 'Good', styles.body), textCell('H6', 'Stable after license optimization.', styles.body)] },
      { index: 7, cells: [textCell('A7', 'Advisory', styles.body), textCell('B7', 'External services', styles.body), textCell('C7', '$205K', styles.body), textCell('D7', '$188K', styles.body), textCell('E7', '$182K', styles.body), textCell('F7', '$575K', styles.body), textCell('G7', 'Good', styles.body), textCell('H7', 'Demand slightly below forecast.', styles.body)] },
    ],
    mergeCells: [{ ref: 'A1:H1' }, { ref: 'A2:H2' }],
    tables: [],
    conditionalFormats: [],
    dataValidations: [],
    autoFilter: { ref: 'A4:H7' },
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  };
  const assumptions: XlsxWorksheet = {
    id: 'sheet3',
    name: 'Assumptions',
    dimension: 'A1:F7',
    sheetView: { showGridLines: false, zoomScale: 95, frozenRows: 4 },
    columns: [
      { min: 1, max: 1, width: 14, customWidth: true }, { min: 2, max: 2, width: 34, customWidth: true }, { min: 3, max: 3, width: 14, customWidth: true }, { min: 4, max: 4, width: 14, customWidth: true }, { min: 5, max: 5, width: 14, customWidth: true }, { min: 6, max: 6, width: 30, customWidth: true },
    ],
    rows: [
      { index: 1, height: 30, customHeight: true, cells: [textCell('A1', 'Assumptions Log', styles.title)] },
      { index: 2, height: 18, customHeight: true, cells: [textCell('A2', 'Key assumptions behind the monthly plan', styles.subtitle)] },
      { index: 4, height: 22, customHeight: true, cells: [textCell('A4', 'ID', styles.header), textCell('B4', 'Assumption', styles.header), textCell('C4', 'Owner', styles.header), textCell('D4', 'Last Review', styles.header), textCell('E4', 'Status', styles.header), textCell('F4', 'Implication', styles.header)] },
      { index: 5, cells: [textCell('A5', 'A-01', styles.body), textCell('B5', 'Contractor demand tapers in April.', styles.body), textCell('C5', 'Finance', styles.body), textCell('D5', '2026-03-27', styles.body), textCell('E5', 'Watch', styles.body), textCell('F5', 'If extended, people variance widens.', styles.body)] },
      { index: 6, cells: [textCell('A6', 'A-02', styles.body), textCell('B6', 'Software license base remains flat through quarter close.', styles.body), textCell('C6', 'Ops', styles.body), textCell('D6', '2026-03-28', styles.body), textCell('E6', 'Good', styles.body), textCell('F6', 'Supports current savings assumption.', styles.body)] },
    ],
    mergeCells: [{ ref: 'A1:F1' }, { ref: 'A2:F2' }],
    tables: [],
    conditionalFormats: [],
    dataValidations: [],
    autoFilter: { ref: 'A4:F6' },
    pageSetup: { orientation: 'landscape', fitToWidth: 1, fitToHeight: 0 },
  };
  return baseProtocol('Budget vs Actual', palette, [summary, detail, assumptions]);
}

function buildProtocol(patternId: string): XlsxDesignProtocol {
  switch (patternId) {
    case 'XLSX-EXEC-DASHBOARD-01': return buildExecutiveDashboard();
    case 'XLSX-OPS-TRACKER-01': return buildOpsTracker();
    case 'XLSX-QBR-WORKBOOK-01': return buildQbrWorkbook();
    case 'XLSX-BUDGET-ACTUAL-01': return buildBudgetVsActual();
    default: throw new Error(`Unsupported workbook pattern: ${patternId}`);
  }
}

async function main() {
  const manifestPath = path.resolve(process.cwd(), 'knowledge/public/design-patterns/spreadsheet/xlsx-template-library.json');
  const manifest = JSON.parse(safeReadFile(manifestPath, { encoding: 'utf8' }) as string) as TemplateLibrary;
  for (const template of manifest.templates) {
    const outputDir = path.dirname(path.resolve(process.cwd(), template.output));
    if (!safeExistsSync(outputDir)) safeMkdir(outputDir, { recursive: true });
    const protocol = buildProtocol(template.pattern_id);
    await generateNativeXlsx(protocol, path.resolve(process.cwd(), template.output));
  }
}

main().catch((error) => {
  console.error(error.message);
  process.exit(1);
});
