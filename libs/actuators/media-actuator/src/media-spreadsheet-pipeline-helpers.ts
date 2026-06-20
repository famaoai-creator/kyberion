import {
  buildMediaGenerationBoundary,
  buildSpreadsheetNarrativeOutline,
  classifyRenderSemantic,
  rankSignalTone,
} from './media-document-helpers.js';
import {
  loadMediaSignalEntryPolicyCatalog,
  loadTrackerSheetPolicyCatalog,
  resolveDocumentContentsLabel,
  resolveSpreadsheetStyleIndex,
  resolveMediaToneStyle,
} from '@agent/core';

export interface MediaSpreadsheetPipelineDeps {
  resolveNamedTheme: (rootDir: string, preferredTheme?: string) => any;
  resolveDocumentCompositionPreset: (rootDir: string, brief: any) => { profileId: string; preset: any };
  resolveDocumentLayoutTemplate: (rootDir: string, brief: any) => { templateId: string; template: any };
  loadSemanticRenderTokenCatalog: (rootDir: string) => any;
}

export function columnNumberToLetter(input: number): string {
  let n = Math.max(1, Math.floor(input));
  let out = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    out = String.fromCharCode(65 + rem) + out;
    n = Math.floor((n - 1) / 26);
  }
  return out;
}

export function inferPrimitiveCellType(value: any): 'n' | 'b' | 'd' | 's' {
  if (typeof value === 'number') return 'n';
  if (typeof value === 'boolean') return 'b';
  if (value instanceof Date) return 'd';
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value)) return 'd';
  return 's';
}

export function buildSmartTableSheet(sheet: any, index: number): any {
  const smartTable = sheet?.smart_table;
  if (!smartTable || typeof smartTable !== 'object') return sheet;
  const headers = Array.isArray(smartTable.headers) ? smartTable.headers.map((value: any) => String(value)) : [];
  const rows = Array.isArray(smartTable.rows) ? smartTable.rows : [];
  if (headers.length === 0) return sheet;
  const dataRows = rows.map((row: any, rowIndex: number) => ({
    index: rowIndex + 2,
    cells: headers.map((header, columnIndex) => {
      const value = Array.isArray(row) ? row[columnIndex] : row?.[header];
      return {
        ref: `${columnNumberToLetter(columnIndex + 1)}${rowIndex + 2}`,
        type: inferPrimitiveCellType(value),
        value: value ?? '',
      };
    }),
  }));
  const normalizedRows = [
    {
      index: 1,
      cells: headers.map((header, columnIndex) => ({
        ref: `${columnNumberToLetter(columnIndex + 1)}1`,
        type: 's',
        value: header,
      })),
    },
    ...dataRows,
  ];
  const endCell = `${columnNumberToLetter(headers.length)}${Math.max(rows.length + 1, 1)}`;
  return {
    ...sheet,
    rows: normalizedRows,
    columns: Array.isArray(sheet?.columns) && sheet.columns.length > 0
      ? sheet.columns
      : headers.map((_: string, columnIndex: number) => ({ min: columnIndex + 1, max: columnIndex + 1, width: 18, customWidth: true })),
    tables: Array.isArray(sheet?.tables) && sheet.tables.length > 0
      ? sheet.tables
      : [{
          id: 1,
          name: `Table${index + 1}`,
          displayName: `Table${index + 1}`,
          ref: `A1:${endCell}`,
          headerRowCount: 1,
          totalsRowShown: false,
          columns: headers.map((header, columnIndex) => ({ id: columnIndex + 1, name: header })),
          styleInfo: {
            name: 'TableStyleMedium2',
            showRowStripes: true,
          },
        }],
    autoFilter: sheet?.autoFilter || { ref: `A1:${endCell}` },
    dimension: sheet?.dimension || `A1:${endCell}`,
  };
}

export function normalizeXlsxDesignProtocol(protocol: any): any {
  if (!protocol || typeof protocol !== 'object') {
    throw new Error('normalizeXlsxDesignProtocol: protocol must be an object');
  }
  const sheets = Array.isArray(protocol.sheets) ? protocol.sheets : [];
  return {
    ...protocol,
    styles: {
      ...(protocol.styles || {}),
      fonts: Array.isArray(protocol.styles?.fonts) ? protocol.styles.fonts : [],
      fills: Array.isArray(protocol.styles?.fills) ? protocol.styles.fills : [],
      borders: Array.isArray(protocol.styles?.borders) ? protocol.styles.borders : [],
      numFmts: Array.isArray(protocol.styles?.numFmts) ? protocol.styles.numFmts : [],
      cellXfs: Array.isArray(protocol.styles?.cellXfs) ? protocol.styles.cellXfs : [],
      namedStyles: Array.isArray(protocol.styles?.namedStyles) ? protocol.styles.namedStyles : [],
      dxfs: Array.isArray(protocol.styles?.dxfs) ? protocol.styles.dxfs : [],
    },
    sharedStrings: Array.isArray(protocol.sharedStrings) ? protocol.sharedStrings : [],
    sharedStringsRich: Array.isArray(protocol.sharedStringsRich) ? protocol.sharedStringsRich : [],
    definedNames: Array.isArray(protocol.definedNames) ? protocol.definedNames : [],
    sheets: sheets.map((rawSheet: any, index: number) => {
      const sheet = buildSmartTableSheet(rawSheet, index);
      return {
        id: String(sheet?.id || `sheet${index + 1}`),
        name: String(sheet?.name || `Sheet ${index + 1}`),
        state: sheet?.state || 'visible',
        dimension: sheet?.dimension,
        sheetView: sheet?.sheetView || {},
        columns: Array.isArray(sheet?.columns) ? sheet.columns : [],
        rows: Array.isArray(sheet?.rows) ? sheet.rows : [],
        mergeCells: Array.isArray(sheet?.mergeCells) ? sheet.mergeCells : [],
        drawing: sheet?.drawing && typeof sheet.drawing === 'object'
          ? { ...sheet.drawing, elements: Array.isArray(sheet.drawing.elements) ? sheet.drawing.elements : [] }
          : undefined,
        tables: Array.isArray(sheet?.tables) ? sheet.tables : [],
        conditionalFormats: Array.isArray(sheet?.conditionalFormats) ? sheet.conditionalFormats : [],
        dataValidations: Array.isArray(sheet?.dataValidations) ? sheet.dataValidations : [],
        autoFilter: sheet?.autoFilter,
        pageSetup: sheet?.pageSetup,
        sheetPrXml: sheet?.sheetPrXml,
        extensions: sheet?.extensions,
      };
    }),
  };
}

export function createMediaSpreadsheetPipelineHelpers(deps: MediaSpreadsheetPipelineDeps) {
  function buildTrackerSpreadsheetProtocol(rootDir: string, brief: any): any {
    const outline = buildSpreadsheetNarrativeOutline(rootDir, brief, deps.resolveDocumentCompositionPreset);
    const { preset } = deps.resolveDocumentCompositionPreset(rootDir, brief);
    const semanticCatalog = deps.loadSemanticRenderTokenCatalog(rootDir);
    const signalEntryPolicy = loadMediaSignalEntryPolicyCatalog();
    const trackerSheetPolicy = loadTrackerSheetPolicyCatalog();
    const { template } = deps.resolveDocumentLayoutTemplate(rootDir, {
      document_type: 'tracker',
      layout_template_id: brief.layout_template_id,
    });
    const activeTheme = deps.resolveNamedTheme(rootDir, preset?.recommended_theme);
    const colors = {
      ...(template?.colors || {}),
      ...(activeTheme?.colors || {}),
    };
    const layout = template?.layout || {};
    const toneCatalog = template?.tones?.states || {};
    const validationDefaults = template?.validation_defaults || {};
    const conditionalDefaults = template?.conditional_format_defaults || {};
    const title = brief.payload.title || 'Tracker';
    const subtitle = brief.payload.subtitle || '';
    const summaryCards = Array.isArray(brief.payload.summary_cards) ? brief.payload.summary_cards : [];
    const columns = Array.isArray(brief.payload.columns) ? brief.payload.columns : [];
    const rows = Array.isArray(brief.payload.rows) ? brief.payload.rows : [];
    const headers = columns.map((column: any) => String(column.label || column.key || 'Column'));
    const widths = columns.map((column: any) => Number(column.width || layout.default_column_width || 18));
    const lastColumnLetter = String.fromCharCode(64 + Math.max(headers.length, 1));
    const summaryRowIndex = summaryCards.length > 0 ? 3 : 0;
    const headerRowIndex = summaryCards.length > 0 ? 4 : 3;
    const dataStartIndex = headerRowIndex + 1;
    const rowToneKey = typeof brief.payload.row_tone_key === 'string' ? brief.payload.row_tone_key : '';
    const rowTones = brief.payload.row_tones && typeof brief.payload.row_tones === 'object'
      ? brief.payload.row_tones
      : {};
    const boardSection = Array.isArray(outline.toc)
      ? outline.toc.find((entry: any) => entry.section_id === 'execution-board')
      : null;
    const overviewSection = Array.isArray(outline.toc)
      ? outline.toc.find((entry: any) => entry.section_id === 'overview')
      : null;
    const signalsSection = Array.isArray(outline.toc)
      ? outline.toc.find((entry: any) => entry.section_id === 'signals')
      : null;

    const styleMap = {
      base: resolveSpreadsheetStyleIndex('base'),
      title: resolveSpreadsheetStyleIndex('title'),
      subtitle: resolveSpreadsheetStyleIndex('subtitle'),
      header: resolveSpreadsheetStyleIndex('header'),
      section: resolveSpreadsheetStyleIndex('section'),
      info: resolveSpreadsheetStyleIndex('info'),
      success: resolveSpreadsheetStyleIndex('success'),
      warning: resolveSpreadsheetStyleIndex('warning'),
      danger: resolveSpreadsheetStyleIndex('danger'),
      body: resolveSpreadsheetStyleIndex('body'),
    } as const;

    const toneToStyle = (tone?: string) => styleMap[resolveMediaToneStyle(tone)];

    const sheetRows: any[] = [
      {
        index: 1,
        height: layout.title_row_height || 30,
        customHeight: true,
        cells: [{ ref: 'A1', type: 's', value: title, styleIndex: styleMap.title }],
      },
    ];

    if (subtitle) {
      sheetRows.push({
        index: 2,
        height: layout.subtitle_row_height || 20,
        customHeight: true,
        cells: [{ ref: 'A2', type: 's', value: subtitle, styleIndex: styleMap.subtitle }],
      });
    }

    if (summaryCards.length > 0) {
      const cells: any[] = [];
      summaryCards.forEach((card: any, index: number) => {
        const colOffset = index * 2;
        const cellRef = `${String.fromCharCode(65 + colOffset)}3`;
        cells.push({
          ref: cellRef,
          type: 's',
          value: `${card.label} ${card.value}`,
          styleIndex: toneToStyle(card.tone),
        });
      });
      sheetRows.push({ index: 3, height: layout.summary_row_height || 20, customHeight: true, cells });
    }

    sheetRows.push({
      index: headerRowIndex,
      height: layout.header_row_height || 22,
      customHeight: true,
      cells: headers.map((label, index) => ({
        ref: `${String.fromCharCode(65 + index)}${headerRowIndex}`,
        type: 's',
        value: label,
        styleIndex: styleMap.header,
      })),
    });

    rows.forEach((row: any, rowIndex: number) => {
      const excelRow = dataStartIndex + rowIndex;
      const rowToneValue = rowToneKey ? String(row[rowToneKey] ?? '') : '';
      const resolvedTone = rowToneValue && rowTones[rowToneValue]
        ? String(rowTones[rowToneValue])
        : '';
      const styleIndex = resolvedTone
        ? toneToStyle(resolvedTone)
        : (layout.banded_rows === false ? styleMap.base : (rowIndex % 2 === 0 ? styleMap.body : styleMap.base));
      sheetRows.push({
        index: excelRow,
        height: layout.data_row_height || 20,
        customHeight: Boolean(layout.data_row_height),
        cells: columns.map((column: any, columnIndex: number) => ({
          ref: `${String.fromCharCode(65 + columnIndex)}${excelRow}`,
          type: 's',
          value: String(row[column.key] ?? ''),
          styleIndex,
        })),
      });
    });

    const dataValidations = columns
      .map((column: any, index: number) => {
        const validationKey = String(column.validation_key || column.key || '');
        const validation = column.validation || validationDefaults[validationKey];
        if (!validation || validation.type !== 'list' || !Array.isArray(validation.values) || validation.values.length === 0) {
          return null;
        }
        const colLetter = String.fromCharCode(65 + index);
        return {
          sqref: `${colLetter}${dataStartIndex}:${colLetter}${Math.max(dataStartIndex + rows.length - 1, dataStartIndex)}`,
          type: 'list',
          formula1: `"${validation.values.join(',')}"`,
          showErrorMessage: true,
          errorTitle: validation.errorTitle || `Invalid ${headers[index] || validationKey}`,
          error: validation.error || `Use one of: ${validation.values.join(', ')}`,
        };
      })
      .filter(Boolean);

    const dxfs: any[] = [];
    const conditionalFormats: any[] = [];
    const conditionalStatus = conditionalDefaults[rowToneKey] || conditionalDefaults.status;
    if (rowToneKey && conditionalStatus?.tones && rows.length > 0) {
      const toneEntries = Object.entries(conditionalStatus.tones as Record<string, string>);
      const keyColumnIndex = columns.findIndex((column: any) => String(column.key) === String(conditionalStatus.key_column || rowToneKey));
      const keyColumnLetter = keyColumnIndex >= 0 ? String.fromCharCode(65 + keyColumnIndex) : '';
      if (keyColumnLetter) {
        const startDxfIndex = dxfs.length;
        for (const [, toneName] of toneEntries) {
          if (toneName === 'success') {
            dxfs.push({
              font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#166534' } },
              fill: { patternType: 'solid', fgColor: { rgb: colors.success || '#DCFCE7' }, bgColor: { rgb: colors.success || '#DCFCE7' } },
            });
          } else if (toneName === 'warning') {
            dxfs.push({
              font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#92400E' } },
              fill: { patternType: 'solid', fgColor: { rgb: colors.warning || '#FEF3C7' }, bgColor: { rgb: colors.warning || '#FEF3C7' } },
            });
          } else if (toneName === 'danger') {
            dxfs.push({
              font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#991B1B' } },
              fill: { patternType: 'solid', fgColor: { rgb: colors.danger || '#FEE2E2' }, bgColor: { rgb: colors.danger || '#FEE2E2' } },
            });
          } else {
            dxfs.push({
              font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#111827' } },
              fill: { patternType: 'solid', fgColor: { rgb: colors.info || '#DBEAFE' }, bgColor: { rgb: colors.info || '#DBEAFE' } },
            });
          }
        }
        conditionalFormats.push({
          sqref: `A${dataStartIndex}:${lastColumnLetter}${Math.max(dataStartIndex + rows.length - 1, dataStartIndex)}`,
          rules: toneEntries.map(([matchValue], offset) => ({
            type: 'expression',
            priority: offset + 1,
            dxfId: startDxfIndex + offset,
            formula: `$${keyColumnLetter}${dataStartIndex}="${matchValue}"`,
          })),
        });
      }
    }

    const overdueRule = conditionalDefaults.overdue_finish;
    if (overdueRule && rows.length > 0) {
      const dueColumnIndex = columns.findIndex((column: any) => String(column.key) === String(overdueRule.key_column || 'finish'));
      const statusColumnIndex = columns.findIndex((column: any) => String(column.key) === String(overdueRule.status_column || rowToneKey || 'status'));
      if (dueColumnIndex >= 0 && statusColumnIndex >= 0) {
        const dueLetter = String.fromCharCode(65 + dueColumnIndex);
        const statusLetter = String.fromCharCode(65 + statusColumnIndex);
        const doneValues = Array.isArray(overdueRule.done_values) ? overdueRule.done_values : ['Done'];
        const doneExpr = doneValues.map((value: string) => `$${statusLetter}${dataStartIndex}="${value}"`).join(',');
        const overdueDxfId = dxfs.length;
        dxfs.push({
          font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#7F1D1D' } },
          fill: { patternType: 'solid', fgColor: { rgb: '#FECACA' }, bgColor: { rgb: '#FECACA' } },
        });
        conditionalFormats.push({
          sqref: `A${dataStartIndex}:${lastColumnLetter}${Math.max(dataStartIndex + rows.length - 1, dataStartIndex)}`,
          rules: [{
            type: 'expression',
            priority: conditionalFormats.reduce((count, item) => count + item.rules.length, 0) + 1,
            dxfId: overdueDxfId,
            formula: `AND(DATEVALUE($${dueLetter}${dataStartIndex})<TODAY(),NOT(OR(${doneExpr})))`,
          }],
        });
      }
    }

    const defaultTone = String(template?.tones?.default || 'info');
    const infoTextColor = String(toneCatalog.info?.text_color || '#111827');
    const successTextColor = String(toneCatalog.success?.text_color || '#166534');
    const warningTextColor = String(toneCatalog.warning?.text_color || '#92400E');
    const dangerTextColor = String(toneCatalog.danger?.text_color || '#991B1B');
    const summaryLastColumnLetter = String.fromCharCode(64 + Math.max(summaryCards.length, 1));
    const overviewRows: any[] = [
      {
        index: 1,
        height: layout.title_row_height || 30,
        customHeight: true,
        cells: [{ ref: 'A1', type: 's', value: overviewSection?.title || trackerSheetPolicy.sheet_titles.overview, styleIndex: styleMap.title }],
      },
    ];
    if (summaryCards.length > 0) {
      summaryCards.forEach((card: any, index: number) => {
        const rowIndex = index + 3;
        overviewRows.push({
          index: rowIndex,
          height: layout.summary_row_height || 20,
          customHeight: true,
          cells: [
            { ref: `A${rowIndex}`, type: 's', value: String(card.label || 'Metric'), styleIndex: styleMap.header },
            { ref: `B${rowIndex}`, type: 's', value: String(card.value || ''), styleIndex: toneToStyle(card.tone) },
          ],
        });
      });
    } else {
      overviewRows.push({
        index: 3,
        height: layout.summary_row_height || 20,
        customHeight: true,
        cells: [{ ref: 'A3', type: 's', value: trackerSheetPolicy.summary_empty_message, styleIndex: styleMap.body }],
      });
    }
    const signalRowsSource = rows.filter((row: any) => {
      const tone = rowToneKey ? String(row[rowToneKey] ?? '') : '';
      const status = String(row.status ?? '');
      return signalEntryPolicy.elevated_tones.includes(String(rowTones[tone] || tone).toLowerCase())
        || signalEntryPolicy.elevated_status_keywords.some((keyword) => status.toLowerCase().includes(keyword));
    });
    const pickFirstFieldValue = (entry: any, fields: string[]): string => {
      for (const field of fields) {
        const value = entry?.[field];
        if (value !== undefined && value !== null && String(value).trim()) {
          return String(value);
        }
      }
      return '';
    };
    const explicitSignalEntries = signalEntryPolicy.entry_types.flatMap((entryType) => {
      const payloadEntries = Array.isArray(brief.payload?.[entryType.source_key]) ? brief.payload[entryType.source_key] : [];
      return payloadEntries.map((entry: any) => ({ ...entry, signalType: entryType.signal_type, signalPolicy: entryType }));
    });
    const normalizedSignalEntries = explicitSignalEntries.map((entry: any) => ({
      task: pickFirstFieldValue(entry, entry.signalPolicy.title_fields) || 'Signal',
      owner: pickFirstFieldValue(entry, entry.signalPolicy.owner_fields),
      status: pickFirstFieldValue(entry, entry.signalPolicy.status_fields) || entry.signalType,
      tone: String(entry.tone || entry.severity || entry.signalPolicy.default_tone || 'info'),
    }));
    const signalRows: any[] = [
      {
        index: 1,
        height: layout.title_row_height || 30,
        customHeight: true,
        cells: [{ ref: 'A1', type: 's', value: signalsSection?.title || signalEntryPolicy.sheet_title, styleIndex: styleMap.title }],
      },
      {
        index: 3,
        height: layout.header_row_height || 22,
        customHeight: true,
        cells: [
          { ref: 'A3', type: 's', value: signalEntryPolicy.columns[0] || 'Task', styleIndex: styleMap.header },
          { ref: 'B3', type: 's', value: signalEntryPolicy.columns[1] || 'Owner', styleIndex: styleMap.header },
          { ref: 'C3', type: 's', value: signalEntryPolicy.columns[2] || 'Status', styleIndex: styleMap.header },
        ],
      },
    ];
    const combinedSignalEntries = [
      ...normalizedSignalEntries,
      ...signalRowsSource.map((row: any) => {
        const tone = rowToneKey ? String(row[rowToneKey] ?? '') : '';
        const resolvedTone = tone && rowTones[tone] ? String(rowTones[tone]) : tone;
        return {
          task: String(row.task ?? row.title ?? ''),
          owner: String(row.owner ?? ''),
          status: String(row.status ?? ''),
          tone: resolvedTone || 'warning',
        };
      }),
    ].sort((left, right) => {
      const signalTones = semanticCatalog.signal_tones || {};
      const leftRank = signalTones[String(left.tone || '').toLowerCase()] ?? rankSignalTone(left.tone);
      const rightRank = signalTones[String(right.tone || '').toLowerCase()] ?? rankSignalTone(right.tone);
      const toneDelta = leftRank - rightRank;
      if (toneDelta !== 0) return toneDelta;
      return String(left.task || '').localeCompare(String(right.task || ''));
    });
    if (combinedSignalEntries.length === 0) {
      signalRows.push({
        index: 4,
        height: layout.data_row_height || 20,
        customHeight: Boolean(layout.data_row_height),
        cells: [{ ref: 'A4', type: 's', value: signalEntryPolicy.empty_message, styleIndex: styleMap.body }],
      });
    } else {
      combinedSignalEntries.forEach((row: any, index: number) => {
        signalRows.push({
          index: 4 + index,
          height: layout.data_row_height || 20,
          customHeight: Boolean(layout.data_row_height),
          cells: [
            { ref: `A${4 + index}`, type: 's', value: String(row.task ?? row.title ?? ''), styleIndex: toneToStyle(String(row.tone || 'info')) },
            { ref: `B${4 + index}`, type: 's', value: String(row.owner ?? ''), styleIndex: toneToStyle(String(row.tone || 'info')) },
            { ref: `C${4 + index}`, type: 's', value: String(row.status ?? ''), styleIndex: toneToStyle(String(row.tone || 'info')) },
          ],
        });
      });
    }

    return {
      version: '3.0.0',
      generatedAt: new Date().toISOString(),
      theme: {
        name: 'Tracker Theme',
        colors: {
          dk1: String(colors.primary || '#0F172A').replace('#', ''),
          lt1: String(colors.background || '#FFFFFF').replace('#', ''),
          dk2: String(colors.secondary || '#334155').replace('#', ''),
          lt2: String(colors.muted || '#F8FAFC').replace('#', ''),
          accent1: String(colors.accent || '#2563EB').replace('#', ''),
          accent2: String(colors.secondary || '#334155').replace('#', ''),
          accent3: '7C3AED',
          accent4: 'EA580C',
          accent5: 'DC2626',
          accent6: '65A30D',
        },
        majorFont: template?.fonts?.heading || 'Aptos',
        minorFont: template?.fonts?.body || 'Aptos',
      },
      styles: {
        fonts: [
          { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: colors.text || '#111827' } },
          { name: template?.fonts?.heading || 'Aptos', size: 22, bold: true, color: { rgb: '#FFFFFF' } },
          { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: '#E2E8F0' } },
        ],
        fills: [
          { patternType: 'none' },
          { patternType: 'gray125' },
          { patternType: 'solid', fgColor: { rgb: colors.primary || '#0F172A' } },
          { patternType: 'solid', fgColor: { rgb: colors.info || '#DBEAFE' } },
          { patternType: 'solid', fgColor: { rgb: colors.success || '#DCFCE7' } },
          { patternType: 'solid', fgColor: { rgb: colors.warning || '#FEF3C7' } },
          { patternType: 'solid', fgColor: { rgb: colors.danger || '#FEE2E2' } },
          { patternType: 'solid', fgColor: { rgb: colors.muted || '#F8FAFC' } },
        ],
        borders: [
          {},
          {
            left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } },
            right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } },
            top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } },
            bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } },
          },
        ],
        numFmts: [],
        cellXfs: [
          { font: { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: colors.text || '#111827' } }, fill: { patternType: 'none' }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } } },
          { font: { name: template?.fonts?.heading || 'Aptos', size: 22, bold: true, color: { rgb: '#FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.primary || '#0F172A' } }, border: {}, alignment: { horizontal: 'left', vertical: 'center' } },
          { font: { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: '#E2E8F0' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.primary || '#0F172A' } }, border: {}, alignment: { horizontal: 'left', vertical: 'center' } },
          { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: '#FFFFFF' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.primary || '#0F172A' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { horizontal: 'center', vertical: 'center' } },
          { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: infoTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.info?.fill || defaultTone)] || colors.info || '#DBEAFE' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
          { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: infoTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.info?.fill || defaultTone)] || colors.info || '#DBEAFE' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
          { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: successTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.success?.fill || 'success')] || colors.success || '#DCFCE7' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
          { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: warningTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.warning?.fill || 'warning')] || colors.warning || '#FEF3C7' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
          { font: { name: template?.fonts?.body || 'Aptos', size: 10, bold: true, color: { rgb: dangerTextColor } }, fill: { patternType: 'solid', fgColor: { rgb: colors[String(toneCatalog.danger?.fill || 'danger')] || colors.danger || '#FEE2E2' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
          { font: { name: template?.fonts?.body || 'Aptos', size: 10, color: { rgb: colors.secondary || '#334155' } }, fill: { patternType: 'solid', fgColor: { rgb: colors.muted || '#F8FAFC' } }, border: { left: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, right: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, top: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } }, bottom: { style: 'thin', color: { rgb: colors.border || '#CBD5E1' } } }, alignment: { vertical: 'center' } },
        ],
        namedStyles: [{ name: 'Normal', xfId: 0, builtinId: 0 }],
        dxfs,
      },
      sharedStrings: [],
      sharedStringsRich: [],
      definedNames: [],
      workbookProperties: { defaultThemeVersion: 164011 },
      metadata: {
        title,
        subject: brief.document_profile || 'operator-tracker',
        composition: outline,
        generationBoundary: outline.generation_boundary || buildMediaGenerationBoundary(outline),
        recommendedTheme: preset?.recommended_theme || 'kyberion-standard',
        branding: preset?.branding || {},
        sheetRoles: [
          { role: 'overview', title: overviewSection?.title || trackerSheetPolicy.sheet_titles.overview },
          { role: 'execution-board', title: boardSection?.title || trackerSheetPolicy.sheet_titles.execution_board },
          { role: 'signals', title: signalsSection?.title || signalEntryPolicy.sheet_title },
        ],
        sheetSemantics: [
          {
            role: 'overview',
            layout_key: overviewSection?.layout_key || 'sheet-overview',
            media_kind: overviewSection?.media_kind || 'dashboard',
            semantic_type: classifyRenderSemantic(overviewSection?.layout_key || 'sheet-overview', overviewSection?.media_kind || 'dashboard'),
          },
          {
            role: 'execution-board',
            layout_key: boardSection?.layout_key || 'sheet-main-table',
            media_kind: boardSection?.media_kind || 'table',
            semantic_type: classifyRenderSemantic(boardSection?.layout_key || 'sheet-main-table', boardSection?.media_kind || 'table'),
          },
          {
            role: 'signals',
            layout_key: signalsSection?.layout_key || 'sheet-signals',
            media_kind: signalsSection?.media_kind || 'signals',
            semantic_type: classifyRenderSemantic(signalsSection?.layout_key || 'sheet-signals', signalsSection?.media_kind || 'signals'),
          },
        ],
      },
      sheets: [
        {
          id: 'sheet-overview',
          name: overviewSection?.title || trackerSheetPolicy.sheet_titles.overview,
          dimension: `A1:B${Math.max(overviewRows.length, 1)}`,
          sheetView: { showGridLines: false, zoomScale: layout.zoom_scale || 95, frozenRows: 1 },
          columns: [
            { width: widths[0] || 24 },
            { width: widths[1] || 18 },
          ],
          rows: overviewRows,
          conditionalFormats: [],
          dataValidations: [],
        },
      {
          id: 'sheet1',
          name: boardSection?.title || trackerSheetPolicy.sheet_titles.execution_board,
          dimension: `${summaryCards.length > 0 ? 'A3' : 'A1'}:${lastColumnLetter}${Math.max(sheetRows[sheetRows.length - 1]?.index || 1, 1)}`,
          sheetView: { showGridLines: false, zoomScale: layout.zoom_scale || 95, frozenRows: headerRowIndex },
          columns: columns.map((column: any, index: number) => ({
            width: widths[index] || Number(layout.default_column_width || 18),
          })),
          rows: sheetRows,
          conditionalFormats,
          dataValidations,
        },
        {
          id: 'sheet-signals',
          name: signalsSection?.title || signalEntryPolicy.sheet_title,
          dimension: `A1:C${Math.max(signalRows.length, 1)}`,
          sheetView: { showGridLines: false, zoomScale: layout.zoom_scale || 95, frozenRows: 3 },
          columns: [
            { width: 26 },
            { width: 20 },
            { width: 16 },
          ],
          rows: signalRows,
          conditionalFormats: [],
          dataValidations: [],
        },
      ],
    };
  }

  return {
    buildTrackerSpreadsheetProtocol,
  };
}
