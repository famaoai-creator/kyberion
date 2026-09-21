#!/usr/bin/env node
// 文書テンプレート抽出: 登録済みソースから記載項目・順序・デザインを抽出しプロファイル化する.
// 使い方:
//   node scripts/doc-templates/extract-profile.mjs --id <template-id>
// 入力: registry.json が指す sources/<id>.(pdf|docx|xlsx)
// 出力: knowledge/product/sales/doc-templates/profiles/<id>.profile.json
//
// 抽出ロジックは自前実装を持たない。media-actuator と同じ正本
//（libs/core の distillDocxDesign / distillPdfDesign / distillXlsxDesign）
// を直接呼び出す。pipeline JSON は使わない。
import { createRequire } from 'node:module';
import path from 'node:path';

const ROOT = new URL('../..', import.meta.url).pathname.replace(/\/$/, '');
const REG_DIR = path.join(ROOT, 'knowledge/product/sales/doc-templates');
const require = createRequire(import.meta.url);
const { readJson } = require('@agent/core/foundation');
const { safeExistsSync, safeMkdir, safeWriteFile } = require('@agent/core/secure-io');
const { distillDocxDesign } = require(path.join(ROOT, 'libs/core/dist/docx-utils.js'));
const { distillPdfDesign } = require(path.join(ROOT, 'libs/core/dist/src/pdf-utils.js'));
const { distillXlsxDesign } = require(path.join(ROOT, 'libs/core/dist/src/xlsx-utils.js'));

function isWithin(candidate, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

// 記載項目の検出パターン（ラベル → 正規化フィールド名）
const FIELD_PATTERNS = [
  [/御見積書|見積書/, 'doc_title'],
  [/宛名|宛先|御中/, 'recipient'],
  [/件\s*名|表\s*題/, 'subject'],
  [/見積番号|見積No|No\./, 'quote_number'],
  [/発行日|見積日|日\s*付/, 'issue_date'],
  [/有効期限/, 'valid_until'],
  [/納\s*期/, 'due_date'],
  [/支払条件|支払サイト/, 'payment_terms'],
  [/支払方法|お支払/, 'payment_method'],
  [/振込先|口座|銀行/, 'bank_info'],
  [/品名|品目|項目|内訳|摘要/, 'items_table'],
  [/数量/, 'item_quantity'],
  [/単価/, 'item_unit_price'],
  [/金額/, 'item_amount'],
  [/小計/, 'subtotal'],
  [/消費税/, 'tax'],
  [/合計|御請求金額|請求金額/, 'total'],
  [/備考|特記事項/, 'notes'],
  [/登録番号|インボイス/, 'reg_number'],
  [/担当|営業|連絡先|TEL|電話|Email|メール/, 'issuer_contact'],
  [/押印|印$/, 'seal_box'],
  [/承認/, 'approval_box'],
];

function detectFields(lines) {
  const fields = [];
  const seen = new Set();
  lines.forEach((line, idx) => {
    for (const [re, key] of FIELD_PATTERNS) {
      if (re.test(line) && !seen.has(key)) {
        seen.add(key);
        fields.push({ key, label: line.trim().slice(0, 60), line: idx + 1 });
      }
    }
  });
  return fields;
}

// ---- docx: 正本 DocxDesignProtocol から本文行・見出し・表を拾う ----

function collectRunText(content) {
  const out = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'text' && typeof node.text === 'string') {
      out.push(node.text);
      return;
    }
    // run 配下（run.content）も辿る。pPr（スタイル指定）は本文でないため除外。
    for (const [k, v] of Object.entries(node)) {
      if (k === 'pPr' || k === 'type' || k === 'text') continue;
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  (Array.isArray(content) ? content : [content]).forEach(walk);
  return out.join('').trim();
}

function cellParagraphs(cell) {
  const paras = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'paragraph' && node.paragraph) {
      paras.push(node.paragraph);
      return;
    }
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object') walk(v);
    }
  };
  walk(cell);
  return paras;
}

function extractDocxLines(design) {
  const lines = [];
  const headingStyles = new Set();
  let tableCount = 0;
  const tableCols = [];
  for (const el of design.body ?? []) {
    if (el.type === 'paragraph' && el.paragraph) {
      const style = el.paragraph?.pPr?.pStyle;
      if (/^Heading[0-9]$/.test(String(style))) headingStyles.add(style);
      const text = collectRunText(el.paragraph.content);
      if (text) lines.push(text);
    } else if (el.type === 'table' && el.table) {
      tableCount += 1;
      const rows = el.table.rows ?? [];
      let maxCols = 0;
      for (const row of rows) {
        const cells = row.cells ?? row.children ?? [];
        const cellTexts = [];
        const list = Array.isArray(cells) ? cells : Object.values(cells);
        for (const cell of list) {
          const t = cellParagraphs(cell)
            .map((p) => collectRunText(p.content))
            .filter(Boolean)
            .join('／');
          cellTexts.push(t);
        }
        maxCols = Math.max(maxCols, cellTexts.length);
        const rowText = cellTexts.filter(Boolean).join('｜');
        if (rowText) lines.push(rowText);
      }
      tableCols.push(maxCols);
    }
  }
  return { lines, headingStyles: [...headingStyles], tableCount, tableCols };
}

function summarizeDocxDesign(design, stats) {
  const theme = design.theme ?? {};
  const colors = theme.colors ?? {};
  const pgSz = design.sections?.[0]?.pgSz ?? {};
  return {
    engine: 'libs/core distillDocxDesign（media-actuator と同一の正本）',
    fonts: [theme.majorFont, theme.minorFont].filter(Boolean),
    colors: Object.fromEntries(
      Object.entries(colors)
        .filter(([k]) => /^accent|^hlink/i.test(k))
        .slice(0, 8)
    ),
    headingStyles: stats.headingStyles,
    tableCount: stats.tableCount,
    tableCols: stats.tableCols,
    page: { orient: pgSz.orient, w: pgSz.w, h: pgSz.h },
    styleCount: Array.isArray(design.styles) ? design.styles.length : 0,
  };
}

// ---- pdf / xlsx: 正本プロトコルから本文行を拾う ----

function extractPdfLines(design) {
  const pages = design.content?.pages ?? [];
  const full = design.content?.text ?? pages.map((p) => p.text ?? '').join('\n');
  return {
    lines: String(full)
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean),
    summary: {
      engine: 'libs/core distillPdfDesign（media-actuator と同一の正本）',
      pages: pages.length || design.metadata?.pageCount || 1,
      title: design.metadata?.title,
      hasOutlines: (design.outlines ?? []).length > 0,
    },
  };
}

function extractXlsxLines(design) {
  const sheets = design.sheets ?? design.worksheets ?? [];
  const lines = [];
  const names = [];
  for (const sh of sheets) {
    names.push(sh.name ?? sh.title ?? 'sheet');
    const rows = sh.rows ?? sh.data ?? [];
    for (const row of (Array.isArray(rows) ? rows : []).slice(0, 30)) {
      const cells = row.cells ?? row.values ?? row;
      const list = Array.isArray(cells) ? cells : Object.values(cells ?? {});
      const t = list
        .map((c) => String(c?.text ?? c?.value ?? c ?? '').trim())
        .filter(Boolean)
        .join('｜');
      if (t) lines.push(t);
    }
  }
  if (!lines.length) {
    // 構造が想定外の場合は本文候補を汎用走査（キー名は除外し値のみ）
    const seen = new Set();
    const walk = (node, depth = 0) => {
      if (depth > 6 || seen.has(node)) return;
      if (typeof node === 'string' && /[一-龯ぁ-んァ-ン]/.test(node) && node.trim().length >= 2) {
        lines.push(node.trim().slice(0, 80));
        return;
      }
      if (node && typeof node === 'object') {
        seen.add(node);
        for (const [k, v] of Object.entries(node)) {
          if (/^(name|id|type|style|font|color|rawXml)$/i.test(k)) continue;
          if (Array.isArray(v)) v.forEach((i) => walk(i, depth + 1));
          else if (typeof v === 'object') walk(v, depth + 1);
          else if (typeof v === 'string') walk(v, depth + 1);
        }
      }
    };
    walk(design);
  }
  return {
    lines: [...new Set(lines)].slice(0, 200),
    summary: {
      engine: 'libs/core distillXlsxDesign（media-actuator と同一の正本）',
      sheets: names,
    },
  };
}

function arg(name) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const id = arg('id');
if (!id) {
  console.error('usage: extract-profile.mjs --id <template-id>');
  process.exit(1);
}
const registry = readJson(path.join(REG_DIR, 'registry.json'));
const entry = registry.find((r) => r.id === id);
if (!entry) {
  console.error(`not registered: ${id}`);
  process.exit(1);
}
const abs = path.join(ROOT, entry.file);
if (!isWithin(abs, path.join(REG_DIR, 'sources'))) {
  console.error(
    `registry entry must point into the shared template sources directory: ${entry.file}`
  );
  process.exit(1);
}
if (!safeExistsSync(abs)) {
  console.error(`source missing: ${entry.file}`);
  process.exit(1);
}
const ext = path.extname(abs).toLowerCase();

let lines;
let designSummary;
if (ext === '.docx') {
  const design = await distillDocxDesign(abs);
  const stats = extractDocxLines(design);
  lines = stats.lines;
  designSummary = summarizeDocxDesign(design, stats);
} else if (ext === '.pdf') {
  const design = await distillPdfDesign(abs);
  ({ lines, summary: designSummary } = extractPdfLines(design));
} else {
  const design = await distillXlsxDesign(abs);
  ({ lines, summary: designSummary } = extractXlsxLines(design));
}

const fields = detectFields(lines);
const profile = {
  template_id: id,
  kind: entry.kind,
  source: { file: entry.file, sha256: entry.sha256, ext },
  extracted_at: new Date(Date.now()).toISOString(),
  section_order: fields.map((f) => f.key),
  fields,
  design: designSummary,
  text_preview: lines.slice(0, 40),
  warnings: [],
  coverage: { detected: fields.length, patterns: FIELD_PATTERNS.length },
};

safeMkdir(path.join(REG_DIR, 'profiles'), { recursive: true });
const outPath = path.join(REG_DIR, 'profiles', `${id}.profile.json`);
safeWriteFile(outPath, JSON.stringify(profile, null, 2) + '\n');
console.log(
  JSON.stringify({
    profile: path.relative(ROOT, outPath),
    fields: fields.map((f) => f.key),
    design: designSummary,
  })
);
