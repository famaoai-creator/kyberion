/**
 * Devin 評価プロジェクト 計画書 (PowerPoint)
 * Native PPTX Engine を使用
 */
import { generateNativePptx } from '../engine.js';
import type { PptxDesignProtocol, PptxElement, PptxSlide, PptxTextRun } from '../../types/pptx-protocol.js';

// ─── Color Palette ──────────────────────────────────────────
const C = {
  navy:      '#1E3A5F',
  navyDark:  '#0F1F33',
  blue:      '#3B82F6',
  blueLight: '#DBEAFE',
  green:     '#10B981',
  greenLight:'#D1FAE5',
  orange:    '#F59E0B',
  orangeLight:'#FEF3C7',
  purple:    '#8B5CF6',
  purpleLight:'#EDE9FE',
  red:       '#EF4444',
  redLight:  '#FEE2E2',
  gray50:    '#F9FAFB',
  gray100:   '#F3F4F6',
  gray200:   '#E5E7EB',
  gray400:   '#9CA3AF',
  gray600:   '#4B5563',
  gray700:   '#374151',
  gray800:   '#1F2937',
  white:     '#FFFFFF',
  black:     '#000000',
};

// ─── Helper: Simple text element ────────────────────────────
function txt(text: string, pos: {x:number,y:number,w:number,h:number}, style: any = {}): PptxElement {
  return { type: 'text', pos, text, style: { fontFamily: 'Yu Gothic', fontSize: 14, color: C.gray800, ...style } };
}

function shape(shapeType: string, pos: {x:number,y:number,w:number,h:number}, text: string, style: any = {}): PptxElement {
  return { type: 'shape', shapeType, pos, text, style: { fontFamily: 'Yu Gothic', fontSize: 12, ...style } };
}

function line(pos: {x:number,y:number,w:number,h:number}, style: any = {}): PptxElement {
  return { type: 'line', pos, style: { line: C.gray200, lineWidth: 1, ...style } };
}

// ─── Reusable: Page footer ──────────────────────────────────
function footer(pageNum: number): PptxElement[] {
  return [
    line({ x: 0.4, y: 7.05, w: 9.2, h: 0 }, { line: C.navy, lineWidth: 0.5 }),
    txt('Devin 評価プロジェクト計画書', { x: 0.4, y: 7.1, w: 5, h: 0.3 }, { fontSize: 8, color: C.gray400 }),
    txt(`Confidential  |  ${pageNum}`, { x: 7, y: 7.1, w: 2.6, h: 0.3 }, { fontSize: 8, color: C.gray400, align: 'right' }),
  ];
}

// ─── Reusable: Section header bar ───────────────────────────
function sectionHeader(title: string): PptxElement[] {
  return [
    shape('rect', { x: 0, y: 0, w: 10, h: 0.9 }, '', { fill: C.navy }),
    txt(title, { x: 0.5, y: 0.15, w: 9, h: 0.6 }, { fontSize: 22, bold: true, color: C.white }),
    shape('rect', { x: 0, y: 0.9, w: 10, h: 0.06 }, '', { fill: C.blue }),
  ];
}

// ═══════════════════════════════════════════════════════════
// SLIDE 1: タイトルスライド
// ═══════════════════════════════════════════════════════════
const slide1: PptxSlide = {
  id: 'slide1.xml',
  backgroundFill: C.navyDark,
  elements: [
    // Accent bar top
    shape('rect', { x: 0, y: 0, w: 10, h: 0.08 }, '', { fill: C.blue }),
    // Title
    txt('Devin 評価プロジェクト', { x: 1, y: 2.0, w: 8, h: 1.0 }, {
      fontSize: 40, bold: true, color: C.white, align: 'center',
    }),
    txt('プロジェクト計画書', { x: 1, y: 2.9, w: 8, h: 0.7 }, {
      fontSize: 28, color: C.blueLight, align: 'center',
    }),
    // Divider line
    line({ x: 3, y: 3.8, w: 4, h: 0 }, { line: C.blue, lineWidth: 2 }),
    // Info
    txt('2026年3月16日 ～ 4月10日', { x: 1, y: 4.2, w: 8, h: 0.5 }, {
      fontSize: 16, color: C.gray200, align: 'center',
    }),
    txt('プロジェクトオーナー: 市村', { x: 1, y: 4.7, w: 8, h: 0.4 }, {
      fontSize: 14, color: C.gray400, align: 'center',
    }),
    // Bottom accent
    shape('rect', { x: 0, y: 7.42, w: 10, h: 0.08 }, '', { fill: C.blue }),
    // Company
    txt('famao AI', { x: 0.5, y: 6.8, w: 2, h: 0.3 }, {
      fontSize: 10, color: C.gray400,
    }),
    txt('Confidential', { x: 7.5, y: 6.8, w: 2, h: 0.3 }, {
      fontSize: 10, color: C.gray400, align: 'right',
    }),
  ],
};

// ═══════════════════════════════════════════════════════════
// SLIDE 2: プロジェクト概要
// ═══════════════════════════════════════════════════════════
const slide2: PptxSlide = {
  id: 'slide2.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('1. プロジェクト概要'),
    // Overview table
    {
      type: 'table',
      pos: { x: 0.5, y: 1.3, w: 9, h: 2.8 },
      rows: [
        ['項目', '内容'],
        ['プロジェクト名', 'Devin 評価プロジェクト'],
        ['目的', 'AIソフトウェアエンジニア「Devin」の実務適用可能性を3つの開発プロジェクトで評価'],
        ['期間', '2026年3月16日 ～ 4月10日（約1ヶ月）'],
        ['PJオーナー', '市村'],
        ['メンバー', '冨永、藤澤、坂本、進藤、都竹（計5名）'],
        ['成果物', '評価レポート（品質・速度・コストの観点で総合評価）'],
      ],
      colWidths: [2.2, 6.8],
    },
    // Key objective boxes
    txt('評価の3観点', { x: 0.5, y: 4.5, w: 9, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy }),
    // Box 1: Quality
    shape('roundRect', { x: 0.5, y: 5.0, w: 2.7, h: 1.6 }, '', { fill: C.blueLight, line: C.blue, lineWidth: 1 }),
    txt('品質', { x: 0.5, y: 5.1, w: 2.7, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy, align: 'center' }),
    txt('コード品質\nバグ発生率\nベストプラクティス準拠', { x: 0.7, y: 5.5, w: 2.3, h: 1.0 }, { fontSize: 11, color: C.gray700, align: 'center' }),
    // Box 2: Speed
    shape('roundRect', { x: 3.65, y: 5.0, w: 2.7, h: 1.6 }, '', { fill: C.greenLight, line: C.green, lineWidth: 1 }),
    txt('速度', { x: 3.65, y: 5.1, w: 2.7, h: 0.4 }, { fontSize: 16, bold: true, color: C.green, align: 'center' }),
    txt('開発速度\nタスク完了時間\n人手との比較', { x: 3.85, y: 5.5, w: 2.3, h: 1.0 }, { fontSize: 11, color: C.gray700, align: 'center' }),
    // Box 3: Cost
    shape('roundRect', { x: 6.8, y: 5.0, w: 2.7, h: 1.6 }, '', { fill: C.orangeLight, line: C.orange, lineWidth: 1 }),
    txt('コスト', { x: 6.8, y: 5.1, w: 2.7, h: 0.4 }, { fontSize: 16, bold: true, color: C.orange, align: 'center' }),
    txt('API利用コスト\nROI分析\n導入コスト試算', { x: 7.0, y: 5.5, w: 2.3, h: 1.0 }, { fontSize: 11, color: C.gray700, align: 'center' }),
    ...footer(2),
  ],
};

// ═══════════════════════════════════════════════════════════
// SLIDE 3: 体制図
// ═══════════════════════════════════════════════════════════
const slide3: PptxSlide = {
  id: 'slide3.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('2. プロジェクト体制'),
    // PJ Owner box
    shape('roundRect', { x: 3.5, y: 1.4, w: 3, h: 0.7 }, '市村（PJオーナー）', {
      fill: C.navy, color: C.white, fontSize: 14, bold: true, align: 'center', valign: 'middle',
    }),
    // Connector line down
    line({ x: 5, y: 2.1, w: 0, h: 0.5 }, { line: C.navy, lineWidth: 2 }),
    // Horizontal connector
    line({ x: 1.5, y: 2.6, w: 7, h: 0 }, { line: C.navy, lineWidth: 2 }),
    // Vertical connectors to each member
    line({ x: 1.5, y: 2.6, w: 0, h: 0.4 }, { line: C.navy, lineWidth: 1.5 }),
    line({ x: 3.25, y: 2.6, w: 0, h: 0.4 }, { line: C.navy, lineWidth: 1.5 }),
    line({ x: 5, y: 2.6, w: 0, h: 0.4 }, { line: C.navy, lineWidth: 1.5 }),
    line({ x: 6.75, y: 2.6, w: 0, h: 0.4 }, { line: C.navy, lineWidth: 1.5 }),
    line({ x: 8.5, y: 2.6, w: 0, h: 0.4 }, { line: C.navy, lineWidth: 1.5 }),
    // Member boxes
    shape('roundRect', { x: 0.5, y: 3.0, w: 2, h: 0.7 }, '冨永', {
      fill: C.green, color: C.white, fontSize: 13, bold: true, align: 'center', valign: 'middle',
    }),
    shape('roundRect', { x: 2.25, y: 3.0, w: 2, h: 0.7 }, '藤澤', {
      fill: C.blue, color: C.white, fontSize: 13, bold: true, align: 'center', valign: 'middle',
    }),
    shape('roundRect', { x: 4, y: 3.0, w: 2, h: 0.7 }, '坂本', {
      fill: C.purple, color: C.white, fontSize: 13, bold: true, align: 'center', valign: 'middle',
    }),
    shape('roundRect', { x: 5.75, y: 3.0, w: 2, h: 0.7 }, '進藤', {
      fill: C.orange, color: C.white, fontSize: 13, bold: true, align: 'center', valign: 'middle',
    }),
    shape('roundRect', { x: 7.5, y: 3.0, w: 2, h: 0.7 }, '都竹', {
      fill: C.red, color: C.white, fontSize: 13, bold: true, align: 'center', valign: 'middle',
    }),
    // Role descriptions
    shape('roundRect', { x: 0.5, y: 3.85, w: 2, h: 0.6 }, 'PJ1担当', {
      fill: C.greenLight, color: C.gray700, fontSize: 10, align: 'center', valign: 'middle',
    }),
    shape('roundRect', { x: 2.25, y: 3.85, w: 2, h: 0.6 }, '評価基準策定\nレビュー担当', {
      fill: C.blueLight, color: C.gray700, fontSize: 10, align: 'center', valign: 'middle',
    }),
    shape('roundRect', { x: 4, y: 3.85, w: 2, h: 0.6 }, 'PJ2担当', {
      fill: C.purpleLight, color: C.gray700, fontSize: 10, align: 'center', valign: 'middle',
    }),
    shape('roundRect', { x: 5.75, y: 3.85, w: 2, h: 0.6 }, '要件整理\nレポート作成', {
      fill: C.orangeLight, color: C.gray700, fontSize: 10, align: 'center', valign: 'middle',
    }),
    shape('roundRect', { x: 7.5, y: 3.85, w: 2, h: 0.6 }, 'PJ3担当', {
      fill: C.redLight, color: C.gray700, fontSize: 10, align: 'center', valign: 'middle',
    }),
    // RACI table
    txt('RACI マトリクス', { x: 0.5, y: 4.8, w: 4, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy }),
    {
      type: 'table',
      pos: { x: 0.5, y: 5.2, w: 9, h: 1.5 },
      rows: [
        ['フェーズ', '市村', '冨永', '藤澤', '坂本', '進藤', '都竹'],
        ['計画・準備', 'A', 'R', 'R', 'R', 'R', 'C'],
        ['PJ1: Webアプリ', 'I', 'R/A', 'C', 'I', 'I', 'I'],
        ['PJ2: API基盤', 'I', 'I', 'C', 'R/A', 'C', 'I'],
        ['PJ3: ダッシュボード', 'I', 'I', 'C', 'I', 'I', 'R/A'],
        ['分析・レポート', 'A', 'C', 'R', 'C', 'R', 'C'],
      ],
      colWidths: [2.4, 1.1, 1.1, 1.1, 1.1, 1.1, 1.1],
    },
    ...footer(3),
  ],
};

// ═══════════════════════════════════════════════════════════
// SLIDE 4: スケジュール概要
// ═══════════════════════════════════════════════════════════
const slide4: PptxSlide = {
  id: 'slide4.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('3. スケジュール'),
    // Timeline visual
    txt('全体スケジュール（4週間）', { x: 0.5, y: 1.2, w: 9, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy }),
    // Week labels
    txt('W1: 3/16-20', { x: 0.5, y: 1.7, w: 2.1, h: 0.3 }, { fontSize: 11, bold: true, color: C.gray600, align: 'center' }),
    txt('W2: 3/23-27', { x: 2.75, y: 1.7, w: 2.1, h: 0.3 }, { fontSize: 11, bold: true, color: C.gray600, align: 'center' }),
    txt('W3: 3/30-4/3', { x: 5.0, y: 1.7, w: 2.1, h: 0.3 }, { fontSize: 11, bold: true, color: C.gray600, align: 'center' }),
    txt('W4: 4/6-10', { x: 7.25, y: 1.7, w: 2.25, h: 0.3 }, { fontSize: 11, bold: true, color: C.gray600, align: 'center' }),
    // Timeline bars
    // Phase 1: 計画・準備 (W1)
    shape('roundRect', { x: 0.5, y: 2.2, w: 2.1, h: 0.6 }, '計画・準備', {
      fill: C.purple, color: C.white, fontSize: 12, bold: true, align: 'center', valign: 'middle',
    }),
    // Phase 2: PJ1 (W2)
    shape('roundRect', { x: 2.75, y: 3.0, w: 2.1, h: 0.6 }, 'PJ1: Webアプリ', {
      fill: C.green, color: C.white, fontSize: 12, bold: true, align: 'center', valign: 'middle',
    }),
    // Phase 3: PJ2 (W2-W3)
    shape('roundRect', { x: 3.5, y: 3.8, w: 2.8, h: 0.6 }, 'PJ2: API基盤', {
      fill: C.blue, color: C.white, fontSize: 12, bold: true, align: 'center', valign: 'middle',
    }),
    // Phase 4: PJ3 (W3-W4)
    shape('roundRect', { x: 5.5, y: 4.6, w: 2.8, h: 0.6 }, 'PJ3: ダッシュボード', {
      fill: C.orange, color: C.white, fontSize: 12, bold: true, align: 'center', valign: 'middle',
    }),
    // Phase 5: 分析・レポート (W4)
    shape('roundRect', { x: 7.25, y: 5.4, w: 2.25, h: 0.6 }, '分析・レポート', {
      fill: C.red, color: C.white, fontSize: 12, bold: true, align: 'center', valign: 'middle',
    }),
    // Arrows between phases
    shape('rightArrow', { x: 2.65, y: 2.3, w: 0.25, h: 0.4 }, '', { fill: C.gray400 }),
    shape('rightArrow', { x: 4.85, y: 3.1, w: 0.25, h: 0.4 }, '', { fill: C.gray400 }),
    shape('rightArrow', { x: 6.3, y: 3.9, w: 0.25, h: 0.4 }, '', { fill: C.gray400 }),
    shape('rightArrow', { x: 8.3, y: 4.7, w: 0.25, h: 0.4 }, '', { fill: C.gray400 }),
    // Milestone table
    txt('主要マイルストーン', { x: 0.5, y: 6.1, w: 4, h: 0.35 }, { fontSize: 14, bold: true, color: C.navy }),
    {
      type: 'table',
      pos: { x: 0.5, y: 6.45, w: 9, h: 0.5 },
      rows: [
        ['日付', 'マイルストーン', '承認者'],
        ['3/16', 'キックオフ完了', '市村'],
        ['3/27', 'PJ1 評価完了', '市村'],
        ['4/7', '全PJ 評価完了', '市村'],
        ['4/10', '最終報告会', '市村'],
      ],
      colWidths: [1.5, 5.5, 2],
    },
    ...footer(4),
  ],
};

// ═══════════════════════════════════════════════════════════
// SLIDE 5: 評価対象プロジェクト詳細
// ═══════════════════════════════════════════════════════════
const slide5: PptxSlide = {
  id: 'slide5.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('4. 評価対象プロジェクト'),
    // PJ1
    shape('roundRect', { x: 0.5, y: 1.3, w: 2.8, h: 5.5 }, '', { fill: C.gray50, line: C.green, lineWidth: 2 }),
    shape('rect', { x: 0.5, y: 1.3, w: 2.8, h: 0.55 }, 'PJ1: Webアプリ開発', {
      fill: C.green, color: C.white, fontSize: 13, bold: true, align: 'center', valign: 'middle',
    }),
    txt('担当: 冨永', { x: 0.7, y: 1.95, w: 2.4, h: 0.3 }, { fontSize: 11, bold: true, color: C.green }),
    txt('概要\nReactベースのWebアプリケーションをDevinに開発させ、コード品質と開発速度を評価', {
      x: 0.7, y: 2.3, w: 2.4, h: 1.2,
    }, { fontSize: 10, color: C.gray700 }),
    txt('評価ポイント\n・フロントエンド品質\n・コンポーネント設計\n・テストカバレッジ\n・UI/UX準拠度', {
      x: 0.7, y: 3.5, w: 2.4, h: 1.5,
    }, { fontSize: 10, color: C.gray700 }),
    txt('期間: 3/23 - 3/27', { x: 0.7, y: 5.1, w: 2.4, h: 0.3 }, { fontSize: 10, color: C.gray600 }),
    // PJ2
    shape('roundRect', { x: 3.6, y: 1.3, w: 2.8, h: 5.5 }, '', { fill: C.gray50, line: C.blue, lineWidth: 2 }),
    shape('rect', { x: 3.6, y: 1.3, w: 2.8, h: 0.55 }, 'PJ2: API基盤構築', {
      fill: C.blue, color: C.white, fontSize: 13, bold: true, align: 'center', valign: 'middle',
    }),
    txt('担当: 坂本', { x: 3.8, y: 1.95, w: 2.4, h: 0.3 }, { fontSize: 11, bold: true, color: C.blue }),
    txt('概要\nREST/GraphQL APIサーバーをDevinに構築させ、アーキテクチャ設計力を評価', {
      x: 3.8, y: 2.3, w: 2.4, h: 1.2,
    }, { fontSize: 10, color: C.gray700 }),
    txt('評価ポイント\n・API設計品質\n・エラーハンドリング\n・セキュリティ対策\n・パフォーマンス', {
      x: 3.8, y: 3.5, w: 2.4, h: 1.5,
    }, { fontSize: 10, color: C.gray700 }),
    txt('期間: 3/27 - 4/2', { x: 3.8, y: 5.1, w: 2.4, h: 0.3 }, { fontSize: 10, color: C.gray600 }),
    // PJ3
    shape('roundRect', { x: 6.7, y: 1.3, w: 2.8, h: 5.5 }, '', { fill: C.gray50, line: C.orange, lineWidth: 2 }),
    shape('rect', { x: 6.7, y: 1.3, w: 2.8, h: 0.55 }, 'PJ3: データ分析', {
      fill: C.orange, color: C.white, fontSize: 13, bold: true, align: 'center', valign: 'middle',
    }),
    txt('担当: 都竹', { x: 6.9, y: 1.95, w: 2.4, h: 0.3 }, { fontSize: 11, bold: true, color: C.orange }),
    txt('概要\nデータ分析ダッシュボードをDevinに構築させ、データ処理と可視化能力を評価', {
      x: 6.9, y: 2.3, w: 2.4, h: 1.2,
    }, { fontSize: 10, color: C.gray700 }),
    txt('評価ポイント\n・データ処理正確性\n・可視化品質\n・パフォーマンス\n・ユーザビリティ', {
      x: 6.9, y: 3.5, w: 2.4, h: 1.5,
    }, { fontSize: 10, color: C.gray700 }),
    txt('期間: 4/1 - 4/7', { x: 6.9, y: 5.1, w: 2.4, h: 0.3 }, { fontSize: 10, color: C.gray600 }),
    ...footer(5),
  ],
};

// ═══════════════════════════════════════════════════════════
// SLIDE 6: 評価基準・方法
// ═══════════════════════════════════════════════════════════
const slide6: PptxSlide = {
  id: 'slide6.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('5. 評価基準・評価方法'),
    // Scoring table
    txt('評価スコアリング基準', { x: 0.5, y: 1.2, w: 9, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy }),
    {
      type: 'table',
      pos: { x: 0.5, y: 1.7, w: 9, h: 2 },
      rows: [
        ['評価観点', '評価項目', '配点', '評価方法'],
        ['コード品質 (40%)', 'コーディング規約準拠', '10', '静的解析ツール (ESLint/SonarQube)'],
        ['', 'バグ・脆弱性', '15', 'テスト実行 + セキュリティスキャン'],
        ['', 'アーキテクチャ設計', '15', '専門家レビュー（藤澤）'],
        ['開発速度 (30%)', 'タスク完了時間', '15', '作業時間計測 vs 人手見積'],
        ['', '手戻り回数', '15', 'Devin再指示回数の記録'],
        ['コスト (30%)', 'API利用料金', '15', 'Devin課金実績'],
        ['', 'ROI', '15', '人件費比較による試算'],
      ],
      colWidths: [1.8, 2.2, 0.8, 4.2],
    },
    // Process flow
    txt('評価プロセスフロー', { x: 0.5, y: 4.3, w: 9, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy }),
    // Step boxes
    shape('roundRect', { x: 0.3, y: 4.85, w: 1.7, h: 1.1 }, '1. 要件定義\n& 指示作成', {
      fill: C.navy, color: C.white, fontSize: 11, bold: true, align: 'center', valign: 'middle',
    }),
    shape('rightArrow', { x: 2.05, y: 5.1, w: 0.3, h: 0.5 }, '', { fill: C.blue }),
    shape('roundRect', { x: 2.4, y: 4.85, w: 1.7, h: 1.1 }, '2. Devin\n実行・観察', {
      fill: C.blue, color: C.white, fontSize: 11, bold: true, align: 'center', valign: 'middle',
    }),
    shape('rightArrow', { x: 4.15, y: 5.1, w: 0.3, h: 0.5 }, '', { fill: C.blue }),
    shape('roundRect', { x: 4.5, y: 4.85, w: 1.7, h: 1.1 }, '3. コード\n品質レビュー', {
      fill: C.green, color: C.white, fontSize: 11, bold: true, align: 'center', valign: 'middle',
    }),
    shape('rightArrow', { x: 6.25, y: 5.1, w: 0.3, h: 0.5 }, '', { fill: C.blue }),
    shape('roundRect', { x: 6.6, y: 4.85, w: 1.7, h: 1.1 }, '4. テスト\n& 記録', {
      fill: C.orange, color: C.white, fontSize: 11, bold: true, align: 'center', valign: 'middle',
    }),
    shape('rightArrow', { x: 8.35, y: 5.1, w: 0.3, h: 0.5 }, '', { fill: C.blue }),
    shape('roundRect', { x: 8.7, y: 4.85, w: 1, h: 1.1 }, '5. 評価\nレポート', {
      fill: C.red, color: C.white, fontSize: 11, bold: true, align: 'center', valign: 'middle',
    }),
    // Notes
    txt('※ 各PJで上記プロセスを実施し、最終的に3PJ分の結果を統合して総合評価を行う', {
      x: 0.5, y: 6.2, w: 9, h: 0.3,
    }, { fontSize: 10, italic: true, color: C.gray600 }),
    ...footer(6),
  ],
};

// ═══════════════════════════════════════════════════════════
// SLIDE 7: リスクと対策
// ═══════════════════════════════════════════════════════════
const slide7: PptxSlide = {
  id: 'slide7.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('6. リスク管理'),
    {
      type: 'table',
      pos: { x: 0.5, y: 1.3, w: 9, h: 3.5 },
      rows: [
        ['#', 'リスク項目', '影響度', '発生確率', '対策'],
        ['R1', 'Devinの出力品質が想定以下', '高', '中', 'プロンプト改善テンプレートを事前準備\n評価基準の下限ラインを明確化'],
        ['R2', 'APIコスト超過', '中', '中', '日次コスト監視、上限アラート設定\n予算超過時はスコープ調整'],
        ['R3', 'メンバーのDevin習熟不足', '中', '低', 'W1で操作トレーニング実施\nナレッジ共有チャンネル開設'],
        ['R4', 'スケジュール遅延', '高', '低', 'WBSによる進捗管理\nバッファ日程の確保（各PJ +1日）'],
        ['R5', 'セキュリティ懸念', '高', '低', 'サンドボックス環境でのみ実行\n機密データの投入禁止'],
      ],
      colWidths: [0.5, 2.5, 1, 1, 4],
    },
    // Risk matrix visual
    txt('リスクマップ', { x: 0.5, y: 5.2, w: 4, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy }),
    // Y-axis label
    txt('影\n響\n度', { x: 0.3, y: 5.7, w: 0.35, h: 1.5 }, { fontSize: 10, bold: true, color: C.gray600, align: 'center' }),
    // Grid
    shape('rect', { x: 0.7, y: 5.7, w: 1.5, h: 0.75 }, '', { fill: C.orangeLight, line: C.gray200, lineWidth: 0.5 }),
    shape('rect', { x: 2.2, y: 5.7, w: 1.5, h: 0.75 }, '', { fill: C.redLight, line: C.gray200, lineWidth: 0.5 }),
    shape('rect', { x: 0.7, y: 6.45, w: 1.5, h: 0.5 }, '', { fill: C.greenLight, line: C.gray200, lineWidth: 0.5 }),
    shape('rect', { x: 2.2, y: 6.45, w: 1.5, h: 0.5 }, '', { fill: C.orangeLight, line: C.gray200, lineWidth: 0.5 }),
    // Labels
    txt('低', { x: 0.7, y: 6.95, w: 1.5, h: 0.25 }, { fontSize: 9, color: C.gray600, align: 'center' }),
    txt('高', { x: 2.2, y: 6.95, w: 1.5, h: 0.25 }, { fontSize: 9, color: C.gray600, align: 'center' }),
    txt('発生確率', { x: 1.2, y: 7.15, w: 1.5, h: 0.25 }, { fontSize: 9, bold: true, color: C.gray600, align: 'center' }),
    // Risk dots
    txt('R1', { x: 2.6, y: 5.85, w: 0.5, h: 0.4 }, { fontSize: 11, bold: true, color: C.red, align: 'center' }),
    txt('R2', { x: 2.3, y: 6.5, w: 0.5, h: 0.35 }, { fontSize: 11, bold: true, color: C.orange, align: 'center' }),
    txt('R3', { x: 0.9, y: 6.5, w: 0.5, h: 0.35 }, { fontSize: 11, bold: true, color: C.green, align: 'center' }),
    txt('R4 R5', { x: 0.85, y: 5.9, w: 0.9, h: 0.35 }, { fontSize: 11, bold: true, color: C.orange, align: 'center' }),

    // Communication plan (right side)
    txt('コミュニケーション計画', { x: 5.0, y: 5.2, w: 4.5, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy }),
    {
      type: 'table',
      pos: { x: 5.0, y: 5.65, w: 4.5, h: 1.5 },
      rows: [
        ['頻度', '内容', '参加者'],
        ['日次', '進捗Slack報告', '全メンバー'],
        ['週次', 'レビュー会議（30分）', '全メンバー'],
        ['随時', '課題エスカレーション', 'PJオーナー'],
      ],
      colWidths: [0.9, 2, 1.6],
    },
    ...footer(7),
  ],
};

// ═══════════════════════════════════════════════════════════
// SLIDE 8: 成果物・次のステップ
// ═══════════════════════════════════════════════════════════
const slide8: PptxSlide = {
  id: 'slide8.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('7. 成果物と次のステップ'),
    // Deliverables
    txt('成果物一覧', { x: 0.5, y: 1.2, w: 9, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy }),
    {
      type: 'table',
      pos: { x: 0.5, y: 1.7, w: 9, h: 1.8 },
      rows: [
        ['#', '成果物', '作成者', '期限', '承認者'],
        ['D1', '評価計画書（本資料）', '冨永', '3/17', '市村'],
        ['D2', '評価基準定義書', '藤澤', '3/18', '市村'],
        ['D3', 'PJ別評価結果シート（×3）', '各PJ担当', '4/7', '藤澤'],
        ['D4', '総合評価レポート', '進藤', '4/9', '市村'],
        ['D5', '最終報告プレゼンテーション', '進藤', '4/10', '市村'],
      ],
      colWidths: [0.5, 3.5, 1.5, 1, 2.5],
    },
    // Next steps
    txt('承認事項・次のステップ', { x: 0.5, y: 4.0, w: 9, h: 0.4 }, { fontSize: 16, bold: true, color: C.navy }),
    // Checklist items
    shape('roundRect', { x: 0.5, y: 4.5, w: 4.2, h: 2.3 }, '', { fill: C.blueLight, line: C.blue, lineWidth: 1 }),
    txt('承認事項', { x: 0.7, y: 4.6, w: 3.8, h: 0.35 }, { fontSize: 14, bold: true, color: C.navy }),
    txt('☐ プロジェクト計画の承認\n☐ 予算（Devin APIコスト）の承認\n☐ 評価基準・配点の合意\n☐ メンバーアサインの確定\n☐ 評価環境の準備確認', {
      x: 0.7, y: 5.0, w: 3.8, h: 1.7,
    }, { fontSize: 12, color: C.gray700 }),

    shape('roundRect', { x: 5.3, y: 4.5, w: 4.2, h: 2.3 }, '', { fill: C.greenLight, line: C.green, lineWidth: 1 }),
    txt('次のアクション', { x: 5.5, y: 4.6, w: 3.8, h: 0.35 }, { fontSize: 14, bold: true, color: C.green }),
    txt('1. 本計画書のレビュー・承認\n2. Devin環境セットアップ（坂本）\n3. 評価基準の詳細化（藤澤）\n4. 各PJ要件の事前整理\n5. 3/16 キックオフ会議', {
      x: 5.5, y: 5.0, w: 3.8, h: 1.7,
    }, { fontSize: 12, color: C.gray700 }),
    ...footer(8),
  ],
};

// ═══════════════════════════════════════════════════════════
// Build Protocol
// ═══════════════════════════════════════════════════════════
const protocol: PptxDesignProtocol = {
  version: '3.0.0',
  generatedAt: new Date().toISOString(),
  canvas: { w: 10, h: 7.5 },
  theme: {
    dk1: '000000', lt1: 'FFFFFF', dk2: '1F2937', lt2: 'E5E7EB',
    accent1: '1E3A5F', accent2: '10B981', accent3: '3B82F6',
    accent4: 'F59E0B', accent5: '8B5CF6', accent6: 'EF4444',
    hlink: '2563EB', folHlink: '7C3AED',
  },
  master: { elements: [] },
  slides: [slide1, slide2, slide3, slide4, slide5, slide6, slide7, slide8],
};

// ─── Generate ───────────────────────────────────────────────
const outputPath = '/Users/motonobu.ichimura/Downloads/Devin評価PJ_計画書.pptx';

async function main() {
  await generateNativePptx(protocol, outputPath);
  console.log(`✅ Project Plan generated: ${outputPath}`);
  console.log(`   Slides: ${protocol.slides.length}`);
}

main();
