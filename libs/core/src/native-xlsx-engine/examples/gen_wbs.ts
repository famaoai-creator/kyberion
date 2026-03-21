/**
 * Devin 評価プロジェクト WBS 生成
 * Media Actuator native-xlsx-engine を使用
 * 予実管理対応版: 実績開始/実績終了 + 条件付き書式（ステータスで色変更）
 */
import { generateNativeXlsx } from '../engine.js';
import type { XlsxDesignProtocol, XlsxRow, XlsxCell, XlsxCellStyle, XlsxFont, XlsxFill, XlsxBorder, XlsxMergeCell, XlsxColumn, XlsxDxfStyle, XlsxConditionalFormat } from '../../types/xlsx-protocol.js';

// ─── Date Helpers ───────────────────────────────────────────
const businessDays: string[] = [];
const bdLabels: string[] = [];
const startDate = new Date(2026, 2, 16); // 2026-03-16 Mon

for (let d = new Date(startDate); d <= new Date(2026, 3, 10); d.setDate(d.getDate() + 1)) {
  const dow = d.getDay();
  if (dow === 0 || dow === 6) continue;
  businessDays.push(`${d.getMonth() + 1}/${d.getDate()}`);
  bdLabels.push(`${d.getMonth() + 1}/${d.getDate()}`);
}

function dayIndex(m: number, d: number): number {
  const label = `${m}/${d}`;
  return businessDays.indexOf(label);
}

// ─── Task Data ──────────────────────────────────────────────
interface Task {
  no: string;
  phase: string;
  name: string;
  owner: string;
  start: [number, number]; // [month, day]
  end: [number, number];
  status: string;
  ganttStyle: number; // style index for gantt bar
  isPhase?: boolean;
}

const tasks: Task[] = [
  // Phase 1: 計画・準備
  { no: '1', phase: '計画・準備', name: '', owner: '', start: [3,16], end: [3,20], status: '', ganttStyle: 7, isPhase: true },
  { no: '1.1', phase: '', name: 'キックオフ会議', owner: '市村', start: [3,16], end: [3,16], status: '未着手', ganttStyle: 7 },
  { no: '1.2', phase: '', name: '評価計画書作成', owner: '冨永', start: [3,16], end: [3,17], status: '未着手', ganttStyle: 7 },
  { no: '1.3', phase: '', name: '評価基準・評価観点の定義', owner: '藤澤', start: [3,16], end: [3,18], status: '未着手', ganttStyle: 7 },
  { no: '1.4', phase: '', name: 'Devin評価環境セットアップ', owner: '坂本', start: [3,17], end: [3,19], status: '未着手', ganttStyle: 7 },
  { no: '1.5', phase: '', name: '対象プロジェクト要件整理', owner: '進藤/都竹', start: [3,18], end: [3,20], status: '未着手', ganttStyle: 7 },

  // Phase 2: PJ1
  { no: '2', phase: 'PJ1: Webアプリ開発', name: '', owner: '', start: [3,23], end: [3,27], status: '', ganttStyle: 4, isPhase: true },
  { no: '2.1', phase: '', name: 'PJ1 要件定義・Devinへの指示作成', owner: '冨永', start: [3,23], end: [3,24], status: '未着手', ganttStyle: 4 },
  { no: '2.2', phase: '', name: 'PJ1 Devin実行・動作観察', owner: '冨永', start: [3,24], end: [3,25], status: '未着手', ganttStyle: 4 },
  { no: '2.3', phase: '', name: 'PJ1 生成コード品質レビュー', owner: '冨永/藤澤', start: [3,25], end: [3,26], status: '未着手', ganttStyle: 4 },
  { no: '2.4', phase: '', name: 'PJ1 テスト実行・結果記録', owner: '冨永', start: [3,26], end: [3,27], status: '未着手', ganttStyle: 4 },

  // Phase 3: PJ2
  { no: '3', phase: 'PJ2: API基盤構築', name: '', owner: '', start: [3,27], end: [4,2], status: '', ganttStyle: 5, isPhase: true },
  { no: '3.1', phase: '', name: 'PJ2 要件定義・Devinへの指示作成', owner: '坂本', start: [3,27], end: [3,30], status: '未着手', ganttStyle: 5 },
  { no: '3.2', phase: '', name: 'PJ2 Devin実行・動作観察', owner: '坂本', start: [3,30], end: [3,31], status: '未着手', ganttStyle: 5 },
  { no: '3.3', phase: '', name: 'PJ2 生成コード品質レビュー', owner: '坂本/進藤', start: [3,31], end: [4,1], status: '未着手', ganttStyle: 5 },
  { no: '3.4', phase: '', name: 'PJ2 テスト実行・結果記録', owner: '坂本', start: [4,1], end: [4,2], status: '未着手', ganttStyle: 5 },

  // Phase 4: PJ3
  { no: '4', phase: 'PJ3: データ分析ダッシュボード', name: '', owner: '', start: [4,1], end: [4,7], status: '', ganttStyle: 6, isPhase: true },
  { no: '4.1', phase: '', name: 'PJ3 要件定義・Devinへの指示作成', owner: '都竹', start: [4,1], end: [4,2], status: '未着手', ganttStyle: 6 },
  { no: '4.2', phase: '', name: 'PJ3 Devin実行・動作観察', owner: '都竹', start: [4,2], end: [4,3], status: '未着手', ganttStyle: 6 },
  { no: '4.3', phase: '', name: 'PJ3 生成コード品質レビュー', owner: '都竹/藤澤', start: [4,3], end: [4,6], status: '未着手', ganttStyle: 6 },
  { no: '4.4', phase: '', name: 'PJ3 テスト実行・結果記録', owner: '都竹', start: [4,6], end: [4,7], status: '未着手', ganttStyle: 6 },

  // Phase 5: 分析・レポート
  { no: '5', phase: '分析・レポート', name: '', owner: '', start: [4,6], end: [4,10], status: '', ganttStyle: 8, isPhase: true },
  { no: '5.1', phase: '', name: '個別PJ評価結果まとめ', owner: '冨永/坂本/都竹', start: [4,6], end: [4,7], status: '未着手', ganttStyle: 8 },
  { no: '5.2', phase: '', name: '総合評価分析（品質・速度・コスト）', owner: '藤澤', start: [4,7], end: [4,8], status: '未着手', ganttStyle: 8 },
  { no: '5.3', phase: '', name: '評価レポート作成', owner: '進藤', start: [4,8], end: [4,9], status: '未着手', ganttStyle: 8 },
  { no: '5.4', phase: '', name: 'レポートレビュー・承認', owner: '市村', start: [4,9], end: [4,9], status: '未着手', ganttStyle: 8 },
  { no: '5.5', phase: '', name: '最終報告会', owner: '全員', start: [4,10], end: [4,10], status: '未着手', ganttStyle: 8 },
];

// ─── Style Definitions ──────────────────────────────────────

const fonts: XlsxFont[] = [
  { name: 'Yu Gothic', size: 10, scheme: 'minor' },                              // 0: default
  { name: 'Yu Gothic', size: 10, bold: true, color: { rgb: '#FFFFFF' } },         // 1: bold white
  { name: 'Yu Gothic', size: 10, bold: true, color: { rgb: '#1F2937' } },         // 2: bold dark
  { name: 'Yu Gothic', size: 10, color: { rgb: '#374151' } },                     // 3: normal dark
  { name: 'Yu Gothic', size: 14, bold: true, color: { rgb: '#1E3A5F' } },         // 4: title
  { name: 'Yu Gothic', size: 9, color: { rgb: '#6B7280' } },                      // 5: small gray
  { name: 'Yu Gothic', size: 9, bold: true, color: { rgb: '#FFFFFF' } },          // 6: small bold white
];

const fills: XlsxFill[] = [
  { patternType: 'none' },                                                        // 0: none
  { patternType: 'gray125' },                                                     // 1: gray125
  { patternType: 'solid', fgColor: { rgb: '#1E3A5F' } },                          // 2: header dark blue
  { patternType: 'solid', fgColor: { rgb: '#DBEAFE' } },                          // 3: phase light blue
  { patternType: 'solid', fgColor: { rgb: '#10B981' } },                          // 4: gantt PJ1 green
  { patternType: 'solid', fgColor: { rgb: '#3B82F6' } },                          // 5: gantt PJ2 blue
  { patternType: 'solid', fgColor: { rgb: '#F59E0B' } },                          // 6: gantt PJ3 orange
  { patternType: 'solid', fgColor: { rgb: '#8B5CF6' } },                          // 7: gantt planning purple
  { patternType: 'solid', fgColor: { rgb: '#EF4444' } },                          // 8: gantt report red
  { patternType: 'solid', fgColor: { rgb: '#F3F4F6' } },                          // 9: date header light gray
  { patternType: 'solid', fgColor: { rgb: '#E0E7FF' } },                          // 10: week header indigo light
  { patternType: 'solid', fgColor: { rgb: '#FFFFFF' } },                          // 11: white
];

const thinBorder = { style: 'thin' as const, color: { rgb: '#D1D5DB' } };
const borders: XlsxBorder[] = [
  {},                                                                              // 0: none
  { left: thinBorder, right: thinBorder, top: thinBorder, bottom: thinBorder },   // 1: thin all
];

// cellXfs: [fontId, fillId, borderId, alignment?]
const cellXfs: XlsxCellStyle[] = [
  { font: fonts[0], fill: fills[0], border: borders[0] },                                                   // 0: default
  { font: fonts[1], fill: fills[2], border: borders[1], alignment: { horizontal: 'center', vertical: 'center', wrapText: true } }, // 1: header
  { font: fonts[2], fill: fills[3], border: borders[1], alignment: { vertical: 'center' } },                // 2: phase row
  { font: fonts[3], fill: fills[11], border: borders[1], alignment: { vertical: 'center', wrapText: true } }, // 3: task row
  { font: fonts[0], fill: fills[4], border: borders[1] },                                                   // 4: gantt PJ1
  { font: fonts[0], fill: fills[5], border: borders[1] },                                                   // 5: gantt PJ2
  { font: fonts[0], fill: fills[6], border: borders[1] },                                                   // 6: gantt PJ3
  { font: fonts[0], fill: fills[7], border: borders[1] },                                                   // 7: gantt planning
  { font: fonts[0], fill: fills[8], border: borders[1] },                                                   // 8: gantt report
  { font: fonts[0], fill: fills[11], border: borders[1] },                                                  // 9: gantt empty
  { font: fonts[6], fill: fills[2], border: borders[1], alignment: { horizontal: 'center', vertical: 'center', textRotation: 90 } }, // 10: date header vertical
  { font: fonts[1], fill: fills[2], border: borders[1], alignment: { horizontal: 'center', vertical: 'center' } }, // 11: week header merged
  { font: fonts[3], fill: fills[11], border: borders[1], alignment: { horizontal: 'center', vertical: 'center' } }, // 12: task center
  { font: fonts[4], fill: fills[0], border: borders[0], alignment: { vertical: 'center' } },                // 13: title
  { font: fonts[5], fill: fills[0], border: borders[0] },                                                   // 14: subtitle info
  { font: fonts[2], fill: fills[3], border: borders[1], alignment: { horizontal: 'center', vertical: 'center' } }, // 15: phase center
];

// ─── DXF Styles for Conditional Formatting ──────────────────
// DXF 0: 完了 — green background + strikethrough font + gray text
// DXF 1: 進行中 — light blue background
// DXF 2: 保留 — yellow background
// DXF 3: レビュー中 — light purple background
const dxfs: XlsxDxfStyle[] = [
  { // 0: 完了
    font: { strike: true, color: { rgb: '#6B7280' } },
    fill: { patternType: 'solid', fgColor: { rgb: '#D1FAE5' }, bgColor: { rgb: '#D1FAE5' } },
  },
  { // 1: 進行中
    font: { bold: true, color: { rgb: '#1E40AF' } },
    fill: { patternType: 'solid', fgColor: { rgb: '#DBEAFE' }, bgColor: { rgb: '#DBEAFE' } },
  },
  { // 2: 保留
    font: { color: { rgb: '#92400E' } },
    fill: { patternType: 'solid', fgColor: { rgb: '#FEF3C7' }, bgColor: { rgb: '#FEF3C7' } },
  },
  { // 3: レビュー中
    font: { color: { rgb: '#6B21A8' } },
    fill: { patternType: 'solid', fgColor: { rgb: '#EDE9FE' }, bgColor: { rgb: '#EDE9FE' } },
  },
];

// ─── Build Sheet ────────────────────────────────────────────

function colRef(c: number): string {
  let result = '';
  let n = c;
  while (n > 0) {
    n--;
    result = String.fromCharCode(65 + (n % 26)) + result;
    n = Math.floor(n / 26);
  }
  return result;
}

// Column layout:
// A=No, B=フェーズ, C=タスク名, D=担当者, E=予定開始, F=予定終了,
// G=実績開始, H=実績終了, I=状況, J+...=Gantt
const GANTT_START_COL = 10; // Column J

// Columns
const columns: XlsxColumn[] = [
  { min: 1, max: 1, width: 6, customWidth: true },     // A: No
  { min: 2, max: 2, width: 22, customWidth: true },    // B: フェーズ
  { min: 3, max: 3, width: 34, customWidth: true },    // C: タスク名
  { min: 4, max: 4, width: 14, customWidth: true },    // D: 担当者
  { min: 5, max: 5, width: 11, customWidth: true },    // E: 予定開始
  { min: 6, max: 6, width: 11, customWidth: true },    // F: 予定終了
  { min: 7, max: 7, width: 11, customWidth: true },    // G: 実績開始
  { min: 8, max: 8, width: 11, customWidth: true },    // H: 実績終了
  { min: 9, max: 9, width: 10, customWidth: true },    // I: 状況
];
// Gantt day columns
for (let i = 0; i < businessDays.length; i++) {
  columns.push({ min: GANTT_START_COL + i, max: GANTT_START_COL + i, width: 4, customWidth: true });
}

const rows: XlsxRow[] = [];
const mergeCells: XlsxMergeCell[] = [];

// Row 1: Title
rows.push({
  index: 1,
  height: 30,
  customHeight: true,
  cells: [
    { ref: 'A1', type: 's', value: 'Devin 評価プロジェクト WBS', styleIndex: 13 },
  ],
});
mergeCells.push({ ref: `A1:H1` });

// Row 2: Project info
rows.push({
  index: 2,
  height: 18,
  customHeight: true,
  cells: [
    { ref: 'A2', type: 's', value: 'PJ オーナー: 市村　｜　期間: 2026/3/16 ～ 4/10　｜　成果物: 評価レポート', styleIndex: 14 },
  ],
});
mergeCells.push({ ref: `A2:H2` });

// Row 3: Week headers (merged across Gantt columns)
const weekRanges = [
  { label: 'W1 (3/16-3/20)', start: 0, end: 4 },
  { label: 'W2 (3/23-3/27)', start: 5, end: 9 },
  { label: 'W3 (3/30-4/3)', start: 10, end: 14 },
  { label: 'W4 (4/6-4/10)', start: 15, end: 19 },
];

const row3Cells: XlsxCell[] = [
  { ref: 'A3', type: 's', value: '', styleIndex: 1 },
  { ref: 'B3', type: 's', value: '', styleIndex: 1 },
  { ref: 'C3', type: 's', value: '', styleIndex: 1 },
  { ref: 'D3', type: 's', value: '', styleIndex: 1 },
  { ref: 'E3', type: 's', value: '予定', styleIndex: 11 },
  { ref: 'F3', type: 's', value: '', styleIndex: 11 },
  { ref: 'G3', type: 's', value: '実績', styleIndex: 11 },
  { ref: 'H3', type: 's', value: '', styleIndex: 11 },
  { ref: 'I3', type: 's', value: '', styleIndex: 1 },
];
// Merge 予定 (E3:F3) and 実績 (G3:H3)
mergeCells.push({ ref: 'E3:F3' });
mergeCells.push({ ref: 'G3:H3' });

for (const week of weekRanges) {
  const startCol = GANTT_START_COL + week.start;
  const endCol = GANTT_START_COL + week.end;
  const startRef = colRef(startCol);
  const endRef = colRef(endCol);
  row3Cells.push({ ref: `${startRef}3`, type: 's', value: week.label, styleIndex: 11 });
  for (let c = startCol + 1; c <= endCol; c++) {
    row3Cells.push({ ref: `${colRef(c)}3`, type: 's', value: '', styleIndex: 11 });
  }
  mergeCells.push({ ref: `${startRef}3:${endRef}3` });
}
rows.push({ index: 3, height: 22, customHeight: true, cells: row3Cells });

// Row 4: Column headers + date headers
const row4Cells: XlsxCell[] = [
  { ref: 'A4', type: 's', value: 'No', styleIndex: 1 },
  { ref: 'B4', type: 's', value: 'フェーズ', styleIndex: 1 },
  { ref: 'C4', type: 's', value: 'タスク名', styleIndex: 1 },
  { ref: 'D4', type: 's', value: '担当者', styleIndex: 1 },
  { ref: 'E4', type: 's', value: '開始日', styleIndex: 1 },
  { ref: 'F4', type: 's', value: '終了日', styleIndex: 1 },
  { ref: 'G4', type: 's', value: '開始日', styleIndex: 1 },
  { ref: 'H4', type: 's', value: '終了日', styleIndex: 1 },
  { ref: 'I4', type: 's', value: '状況', styleIndex: 1 },
];
for (let i = 0; i < businessDays.length; i++) {
  const c = GANTT_START_COL + i;
  row4Cells.push({ ref: `${colRef(c)}4`, type: 's', value: bdLabels[i], styleIndex: 10 });
}
rows.push({ index: 4, height: 50, customHeight: true, cells: row4Cells });

// Merge header rows 3-4 for A,B,C,D,I columns
mergeCells.push({ ref: 'A3:A4' });
mergeCells.push({ ref: 'B3:B4' });
mergeCells.push({ ref: 'C3:C4' });
mergeCells.push({ ref: 'D3:D4' });
mergeCells.push({ ref: 'I3:I4' });

// Data rows
let rowNum = 5;

// Track which rows are task rows (non-phase) for conditional formatting sqref
const taskDataRows: number[] = [];

for (let ti = 0; ti < tasks.length; ti++) {
  const task = tasks[ti];
  const isPhase = task.isPhase;
  const style = isPhase ? 2 : 3;
  const centerStyle = isPhase ? 15 : 12;

  const startLabel = `${task.start[0]}/${task.start[1]}`;
  const endLabel = `${task.end[0]}/${task.end[1]}`;

  const cells: XlsxCell[] = [
    { ref: `A${rowNum}`, type: 's', value: task.no, styleIndex: centerStyle },
    { ref: `B${rowNum}`, type: 's', value: isPhase ? task.phase : '', styleIndex: style },
    { ref: `C${rowNum}`, type: 's', value: isPhase ? task.phase : task.name, styleIndex: style },
    { ref: `D${rowNum}`, type: 's', value: task.owner, styleIndex: centerStyle },
    { ref: `E${rowNum}`, type: 's', value: startLabel, styleIndex: centerStyle },
    { ref: `F${rowNum}`, type: 's', value: endLabel, styleIndex: centerStyle },
    { ref: `G${rowNum}`, type: 's', value: '', styleIndex: centerStyle },   // 実績開始 (empty)
    { ref: `H${rowNum}`, type: 's', value: '', styleIndex: centerStyle },   // 実績終了 (empty)
    { ref: `I${rowNum}`, type: 's', value: task.status, styleIndex: centerStyle },   // 状況
  ];

  // Gantt bar cells
  const startIdx = dayIndex(task.start[0], task.start[1]);
  const endIdx = dayIndex(task.end[0], task.end[1]);

  for (let i = 0; i < businessDays.length; i++) {
    const c = GANTT_START_COL + i;
    const inRange = i >= startIdx && i <= endIdx;
    cells.push({
      ref: `${colRef(c)}${rowNum}`,
      type: 's',
      value: '',
      styleIndex: inRange ? task.ganttStyle : 9,
    });
  }

  // Phase row merges B:C
  if (isPhase) {
    mergeCells.push({ ref: `B${rowNum}:C${rowNum}` });
  } else {
    taskDataRows.push(rowNum);
  }

  rows.push({
    index: rowNum,
    height: isPhase ? 24 : 20,
    customHeight: true,
    cells,
  });

  rowNum++;
}

// ─── Conditional Formatting ─────────────────────────────────
// Build sqref for all task data rows (A:I range per row)
const lastGanttCol = colRef(GANTT_START_COL + businessDays.length - 1);
const cfSqref = taskDataRows.map(r => `A${r}:${lastGanttCol}${r}`).join(' ');

// Status column is I (column 9)
// Formula references $I5 (absolute column, relative row) — Excel adjusts per row
const firstTaskRow = taskDataRows[0]; // first non-phase data row
const conditionalFormats: XlsxConditionalFormat[] = [
  {
    sqref: cfSqref,
    rules: [
      { type: 'expression', priority: 1, dxfId: 0, formula: `$I${firstTaskRow}="完了"` },
      { type: 'expression', priority: 2, dxfId: 1, formula: `$I${firstTaskRow}="進行中"` },
      { type: 'expression', priority: 3, dxfId: 2, formula: `$I${firstTaskRow}="保留"` },
      { type: 'expression', priority: 4, dxfId: 3, formula: `$I${firstTaskRow}="レビュー中"` },
    ],
  },
];

// ─── Legend row ──────────────────────────────────────────────
rowNum += 1;
rows.push({
  index: rowNum,
  height: 18,
  customHeight: true,
  cells: [
    { ref: `A${rowNum}`, type: 's', value: '【凡例】', styleIndex: 14 },
    { ref: `B${rowNum}`, type: 's', value: '', styleIndex: 7 },
    { ref: `C${rowNum}`, type: 's', value: '計画・準備', styleIndex: 14 },
    { ref: `D${rowNum}`, type: 's', value: '', styleIndex: 4 },
    { ref: `E${rowNum}`, type: 's', value: 'PJ1', styleIndex: 14 },
    { ref: `F${rowNum}`, type: 's', value: '', styleIndex: 5 },
    { ref: `G${rowNum}`, type: 's', value: 'PJ2', styleIndex: 14 },
    { ref: `H${rowNum}`, type: 's', value: '', styleIndex: 6 },
    { ref: `I${rowNum}`, type: 's', value: 'PJ3', styleIndex: 14 },
    { ref: `${colRef(GANTT_START_COL)}${rowNum}`, type: 's', value: '', styleIndex: 8 },
    { ref: `${colRef(GANTT_START_COL + 1)}${rowNum}`, type: 's', value: '分析・レポート', styleIndex: 14 },
  ],
});

// ─── Status legend row ──────────────────────────────────────
rowNum += 1;
rows.push({
  index: rowNum,
  height: 18,
  customHeight: true,
  cells: [
    { ref: `A${rowNum}`, type: 's', value: '【ステータス色】', styleIndex: 14 },
    { ref: `C${rowNum}`, type: 's', value: '完了 → 緑 + 取消線', styleIndex: 14 },
    { ref: `E${rowNum}`, type: 's', value: '進行中 → 青', styleIndex: 14 },
    { ref: `G${rowNum}`, type: 's', value: '保留 → 黄', styleIndex: 14 },
    { ref: `I${rowNum}`, type: 's', value: 'レビュー中 → 紫', styleIndex: 14 },
  ],
});

// ─── Build Data Validation sqref for status column (I) ──────
const dvSqref = taskDataRows.map(r => `I${r}`).join(' ');

// ─── Build Protocol ─────────────────────────────────────────

const lastCol = colRef(GANTT_START_COL + businessDays.length - 1);
const dimension = `A1:${lastCol}${rowNum}`;

const protocol: XlsxDesignProtocol = {
  version: '1.0.0',
  generatedAt: new Date().toISOString(),
  theme: {
    colors: {
      dk1: '000000', lt1: 'FFFFFF', dk2: '1F2937', lt2: 'E5E7EB',
      accent1: '1E3A5F', accent2: '10B981', accent3: '3B82F6',
      accent4: 'F59E0B', accent5: '8B5CF6', accent6: 'EF4444',
      hlink: '2563EB', folHlink: '7C3AED',
    },
  },
  styles: {
    fonts,
    fills,
    borders,
    numFmts: [],
    cellXfs,
    dxfs,
    namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0, style: cellXfs[0] }],
  },
  sharedStrings: [],
  definedNames: [],
  sheets: [{
    id: 'sheet1',
    name: 'WBS',
    state: 'visible',
    dimension,
    sheetView: {
      tabSelected: true,
      zoomScale: 85,
      frozenRows: 4,
      frozenCols: 3,
    },
    columns,
    rows,
    mergeCells,
    tables: [],
    conditionalFormats,
    dataValidations: [{
      sqref: dvSqref,
      type: 'list',
      showDropDown: false,
      showErrorMessage: true,
      errorTitle: 'ステータスエラー',
      error: 'リストから選択してください',
      formula1: '"未着手,進行中,レビュー中,完了,保留"',
    }],
    pageSetup: {
      orientation: 'landscape',
      paperSize: 9, // A4
      fitToWidth: 1,
      fitToHeight: 0,
      scale: 65,
    },
  }],
};

// ─── Generate ───────────────────────────────────────────────

const outputPath = '/Users/motonobu.ichimura/Downloads/Devin評価PJ_WBS.xlsx';

async function main() {
  await generateNativeXlsx(protocol, outputPath);
  console.log(`✅ WBS generated: ${outputPath}`);

  // Verify
  const { distillXlsxDesign } = await import('../../xlsx-utils.js');
  const verify = await distillXlsxDesign(outputPath);
  console.log(`   Sheets: ${verify.sheets.length}, Rows: ${verify.sheets[0].rows.length}, MergeCells: ${verify.sheets[0].mergeCells.length}`);
  console.log(`   Columns: ${verify.sheets[0].columns.length}, Dimension: ${verify.sheets[0].dimension}`);
  console.log(`   ConditionalFormats: ${verify.sheets[0].conditionalFormats.length}`);
}

main();
