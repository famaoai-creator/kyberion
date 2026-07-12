import { generateNativePptx } from '@agent/core';
import type {
  PptxDesignProtocol,
  PptxElement,
  PptxSlide,
} from '@agent/core';

// ─── Color Palette ──────────────────────────────────────────
const C = {
  navy: '#1E3A5F',
  navyDark: '#0F1F33',
  blue: '#3B82F6',
  blueLight: '#DBEAFE',
  green: '#10B981',
  greenLight: '#D1FAE5',
  orange: '#F59E0B',
  orangeLight: '#FEF3C7',
  purple: '#8B5CF6',
  purpleLight: '#EDE9FE',
  red: '#EF4444',
  redLight: '#FEE2E2',
  gray50: '#F9FAFB',
  gray100: '#F3F4F6',
  gray200: '#E5E7EB',
  gray400: '#9CA3AF',
  gray600: '#4B5563',
  gray700: '#374151',
  gray800: '#1F2937',
  white: '#FFFFFF',
  black: '#000000',
};

const TOTAL_PAGES = 16;

// ─── Helper Functions ───────────────────────────────────────
function txt(
  text: string,
  pos: { x: number; y: number; w: number; h: number },
  style: any = {}
): PptxElement {
  return {
    type: 'text',
    pos,
    text,
    style: { fontFamily: 'Yu Gothic', fontSize: 14, color: C.gray800, ...style },
  };
}

function shape(
  shapeType: string,
  pos: { x: number; y: number; w: number; h: number },
  text: string,
  style: any = {}
): PptxElement {
  return {
    type: 'shape',
    shapeType,
    pos,
    text,
    style: { fontFamily: 'Yu Gothic', fontSize: 12, ...style },
  };
}

function line(pos: { x: number; y: number; w: number; h: number }, style: any = {}): PptxElement {
  return {
    type: 'line',
    pos,
    style: { line: C.gray400, lineWidth: 1, ...style },
  };
}

function sectionHeader(title: string): PptxElement[] {
  return [
    shape('rect', { x: 0, y: 0, w: 10, h: 0.9 }, '', { fill: C.navy }),
    txt(
      title,
      { x: 0.5, y: 0.15, w: 9, h: 0.6 },
      { fontSize: 22, bold: true, color: C.white, valign: 'middle' }
    ),
    shape('rect', { x: 0, y: 0.9, w: 10, h: 0.05 }, '', { fill: C.blue }),
  ];
}

function footer(pageNum: number): PptxElement[] {
  return [
    line({ x: 0.5, y: 7.0, w: 9.0, h: 0 }, { line: C.navy, lineWidth: 0.5 }),
    txt(
      'Kyberion OS Sovereign Presentation Engine Showcase',
      { x: 0.5, y: 7.05, w: 5, h: 0.35 },
      { fontSize: 8, color: C.gray400 }
    ),
    txt(
      `Page ${pageNum} / ${TOTAL_PAGES}`,
      { x: 7.5, y: 7.05, w: 2.0, h: 0.35 },
      { fontSize: 8, color: C.gray400, align: 'right' }
    ),
  ];
}

// ═══════════════════════════════════════════════════════════
// SLIDES DEFINITION
// ═══════════════════════════════════════════════════════════

// Slide 1: Cover (Premium Master)
const slide1: PptxSlide = {
  id: 'slide1.xml',
  backgroundFill: C.navyDark,
  elements: [
    shape('rect', { x: 0, y: 0, w: 10, h: 0.15 }, '', { fill: C.blue }),
    txt(
      'Kyberion OS',
      { x: 0.8, y: 1.5, w: 8.4, h: 0.5 },
      { fontSize: 20, bold: true, color: C.blueLight }
    ),
    txt(
      'Sovereign PowerPoint\nPresentation Engine',
      { x: 0.8, y: 2.1, w: 8.4, h: 1.6 },
      {
        fontSize: 38,
        bold: true,
        color: C.white,
        align: 'left',
        valign: 'middle',
      }
    ),
    txt(
      'A comprehensive catalog demonstrating all supported OOXML objects, shapes, connectors, tables, indents, typography, and layout models.',
      { x: 0.8, y: 3.8, w: 8.4, h: 0.8 },
      {
        fontSize: 15,
        color: C.gray400,
        align: 'left',
      }
    ),
    line({ x: 0.8, y: 4.8, w: 5.5, h: 0 }, { line: C.blue, lineWidth: 3.5 }),
    txt(
      'Technical Highlights Inside:',
      { x: 0.8, y: 5.1, w: 8.4, h: 0.4 },
      { fontSize: 13, bold: true, color: C.white }
    ),
    txt(
      '• Pure XML inheritance bypassing standard generators  • Custom vector shapes & geometric presets\n• Advanced text runs (color/bold/italic inline)  • Multi-level list indentation & space control\n• Highly aligned roadmaps, RACI matrixes, and biography profiles',
      { x: 0.8, y: 5.5, w: 8.4, h: 0.9 },
      {
        fontSize: 11.5,
        color: C.gray200,
        lineSpacing: 1.25,
      }
    ),
    txt(
      'famao AI Research Labs',
      { x: 0.8, y: 6.6, w: 4.0, h: 0.35 },
      { fontSize: 10, color: C.gray400 }
    ),
    txt(
      'Corporate Standard  |  Confidential',
      { x: 7.2, y: 6.6, w: 2.0, h: 0.35 },
      { fontSize: 10, color: C.gray400, align: 'right' }
    ),
  ],
};

// Slide 2: Platform Executive Overview (Executive Summary Layout)
const slide2: PptxSlide = {
  id: 'slide2.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Kyberion Platform Mission & Philosophy'),
    txt(
      'Platform Executive Overview',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    // Core summary card
    shape('roundRect', { x: 0.5, y: 1.6, w: 4.2, h: 5.0 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1,
    }),
    txt(
      'Core Mission',
      { x: 0.8, y: 1.8, w: 3.6, h: 0.4 },
      { fontSize: 15, bold: true, color: C.navy }
    ),
    txt(
      'Kyberion OSは、企業の機密・監査要件を満たしたままで、AIエージェント自律群がドキュメント生成やミーティング調整、ビジネスプロセスの自動化を行う統合基盤です。\n\n本システムにおけるPowerPoint生成エンジンは、テンプレート依存の制約から脱却し、純粋なOOXML要素の継承構造を読み解いて100%忠実なスライド構築を実現します。',
      { x: 0.8, y: 2.3, w: 3.6, h: 4.0 },
      { fontSize: 12, color: C.gray800, lineSpacing: 1.3 }
    ),

    // Capability cards
    shape('roundRect', { x: 5.0, y: 1.6, w: 4.5, h: 1.5 }, '', {
      fill: C.blueLight,
      line: C.blue,
      lineWidth: 1,
    }),
    txt(
      '01. 徹底したセキュリティとガバナンス',
      { x: 5.2, y: 1.8, w: 4.1, h: 0.3 },
      { fontSize: 13, bold: true, color: C.navy }
    ),
    txt(
      'データ、アイデンティティ、実行レベル（L0〜L5）の監査証跡をすべてブロックチェーンやセキュアストレージに永続化します。',
      { x: 5.2, y: 2.15, w: 4.1, h: 0.8 },
      { fontSize: 11, color: C.gray800 }
    ),

    shape('roundRect', { x: 5.0, y: 3.3, w: 4.5, h: 1.5 }, '', {
      fill: C.greenLight,
      line: C.green,
      lineWidth: 1,
    }),
    txt(
      '02. 完全なネイティブファイル制御',
      { x: 5.2, y: 3.5, w: 4.1, h: 0.3 },
      { fontSize: 13, bold: true, color: C.navy }
    ),
    txt(
      '中間生成ライブラリを介さず、Microsoft-specificな拡張要素（p14/p15）やSmartArt/チャートを含んだXMLブロックを直接構築します。',
      { x: 5.2, y: 3.85, w: 4.1, h: 0.8 },
      { fontSize: 11, color: C.gray800 }
    ),

    shape('roundRect', { x: 5.0, y: 5.0, w: 4.5, h: 1.6 }, '', {
      fill: C.orangeLight,
      line: C.orange,
      lineWidth: 1,
    }),
    txt(
      '03. 役割（ロール）に基づく協調体制',
      { x: 5.2, y: 5.15, w: 4.1, h: 0.3 },
      { fontSize: 13, bold: true, color: C.navy }
    ),
    txt(
      '人間管理者（PJオーナー）および多様なAI専門エージェントが、共通のデータ領域において自律的にタスクを分散解決します。',
      { x: 5.2, y: 5.5, w: 4.1, h: 0.9 },
      { fontSize: 11, color: C.gray800 }
    ),

    ...footer(2),
  ],
};

// Slide 3: Self-Introduction Layouts (Biography profiles)
const slide3: PptxSlide = {
  id: 'slide3.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Corporate Profiles & Structure'),
    txt(
      'Ecosystem Core Member Biography Profiles',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    // Profile Card 1: Owner
    shape('roundRect', { x: 0.5, y: 1.6, w: 4.3, h: 5.0 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1.5,
      cornerRadius: 10000,
    }),
    shape('ellipse', { x: 2.1, y: 1.8, w: 1.1, h: 1.1 }, '', {
      fill: C.blue,
      line: C.white,
      lineWidth: 1.5,
    }),
    txt(
      'Motonobu Ichimura',
      { x: 0.7, y: 3.0, w: 3.9, h: 0.35 },
      { fontSize: 16, bold: true, align: 'center', color: C.navy }
    ),
    txt(
      'Platform Owner  |  Ecosystem Architect',
      { x: 0.7, y: 3.35, w: 3.9, h: 0.3 },
      { fontSize: 11, bold: true, color: C.blue, align: 'center' }
    ),
    line({ x: 1.0, y: 3.7, w: 3.3, h: 0 }, { line: C.gray200, lineWidth: 1 }),
    txt(
      '■ Core Expertise:\n・Enterprise Architectures\n・Autonomous Agent Swarm Orchestration\n・High-Fidelity Document Pipelines (OOXML)\n\n■ Mission Focus:\nKyberion OS全体のシステムガバナンスと、人間とのインターフェース、エージェント協調の最適化にコミットしています。',
      { x: 0.8, y: 3.85, w: 3.7, h: 2.6 },
      { fontSize: 10.5, color: C.gray800, lineSpacing: 1.25 }
    ),

    // Profile Card 2: AI Agent (Autonomous Specialist)
    shape('roundRect', { x: 5.2, y: 1.6, w: 4.3, h: 5.0 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1.5,
      cornerRadius: 10000,
    }),
    shape('ellipse', { x: 6.8, y: 1.8, w: 1.1, h: 1.1 }, '', {
      fill: C.purple,
      line: C.white,
      lineWidth: 1.5,
    }),
    txt(
      'Kyberion Agent-01',
      { x: 5.4, y: 3.0, w: 3.9, h: 0.35 },
      { fontSize: 16, bold: true, align: 'center', color: C.navy }
    ),
    txt(
      'Autonomous Document Specialist',
      { x: 5.4, y: 3.35, w: 3.9, h: 0.3 },
      { fontSize: 11, bold: true, color: C.purple, align: 'center' }
    ),
    line({ x: 5.7, y: 3.7, w: 3.3, h: 0 }, { line: C.gray200, lineWidth: 1 }),
    txt(
      '■ Core Expertise:\n・Native XML Injection & Synthesis\n・Real-time Presentation Composition\n・Automated Layout Pattern Verification\n\n■ Mission Focus:\n人間からの抽象的なプロンプト（指示）を、高精度な座標位置、スタイル、フォントアトリビュートを伴うPPTX構造へ自律翻訳して出力します。',
      { x: 5.5, y: 3.85, w: 3.7, h: 2.6 },
      { fontSize: 10.5, color: C.gray800, lineSpacing: 1.25 }
    ),

    ...footer(3),
  ],
};

// Slide 4: Detailed Visual Schedule / Roadmap (Milestones, Lanes, Arrows)
const slide4: PptxSlide = {
  id: 'slide4.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Product Development Roadmap'),
    txt(
      'Strategic Milestones & Lane Allocation',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    // Quarters Timeline Bar
    shape('rect', { x: 2.2, y: 1.6, w: 1.7, h: 0.4 }, 'Q1 2026', {
      fill: C.navy,
      color: C.white,
      fontSize: 11,
      bold: true,
      align: 'center',
      valign: 'middle',
    }),
    shape('rect', { x: 4.0, y: 1.6, w: 1.7, h: 0.4 }, 'Q2 2026', {
      fill: C.gray600,
      color: C.white,
      fontSize: 11,
      bold: true,
      align: 'center',
      valign: 'middle',
    }),
    shape('rect', { x: 5.8, y: 1.6, w: 1.7, h: 0.4 }, 'Q3 2026', {
      fill: C.navy,
      color: C.white,
      fontSize: 11,
      bold: true,
      align: 'center',
      valign: 'middle',
    }),
    shape('rect', { x: 7.6, y: 1.6, w: 1.9, h: 0.4 }, 'Q4 2026', {
      fill: C.gray600,
      color: C.white,
      fontSize: 11,
      bold: true,
      align: 'center',
      valign: 'middle',
    }),

    // Axis line
    line({ x: 2.2, y: 2.0, w: 7.3, h: 0 }, { line: C.navy, lineWidth: 2 }),

    // Lane 1: Foundation (Blue)
    txt(
      'Foundation Layer',
      { x: 0.5, y: 2.2, w: 1.6, h: 0.45 },
      { fontSize: 11, bold: true, align: 'right', valign: 'middle', color: C.gray700 }
    ),
    shape('roundRect', { x: 2.2, y: 2.2, w: 1.5, h: 0.45 }, 'Engine Setup', {
      fill: C.blue,
      color: C.white,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    shape('roundRect', { x: 4.2, y: 2.2, w: 1.2, h: 0.45 }, 'Schema V3', {
      fill: C.blueLight,
      color: C.navy,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    line({ x: 3.7, y: 2.4, w: 0.5, h: 0 }, { line: C.blue, lineWidth: 1.5, headArrow: true }),

    // Lane 2: Agent Autonomy (Purple)
    txt(
      'Agent Autonomy',
      { x: 0.5, y: 2.85, w: 1.6, h: 0.45 },
      { fontSize: 11, bold: true, align: 'right', valign: 'middle', color: C.gray700 }
    ),
    shape('roundRect', { x: 3.2, y: 2.85, w: 1.8, h: 0.45 }, 'Mission Control', {
      fill: C.purple,
      color: C.white,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    shape('roundRect', { x: 6.0, y: 2.85, w: 1.8, h: 0.45 }, 'Multi-Agent Swarm', {
      fill: C.purpleLight,
      color: C.gray800,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    line(
      { x: 5.0, y: 3.05, w: 1.0, h: 0 },
      { line: C.purple, lineWidth: 1.5, headArrow: true, lineDash: 'dash' }
    ),

    // Lane 3: Rollout Services (Orange)
    txt(
      'Enterprise Rollout',
      { x: 0.5, y: 3.5, w: 1.6, h: 0.45 },
      { fontSize: 11, bold: true, align: 'right', valign: 'middle', color: C.gray700 }
    ),
    shape('roundRect', { x: 5.0, y: 3.5, w: 1.4, h: 0.45 }, 'Beta Release', {
      fill: C.orange,
      color: C.white,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    shape('roundRect', { x: 7.0, y: 3.5, w: 2.3, h: 0.45 }, 'Sovereign Cloud Rollout', {
      fill: C.orangeLight,
      color: C.gray800,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    line({ x: 6.4, y: 3.7, w: 0.6, h: 0 }, { line: C.orange, lineWidth: 1.5, headArrow: true }),

    // Milestone Cards bottom
    shape('roundRect', { x: 0.5, y: 4.25, w: 2.8, h: 2.4 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1,
    }),
    txt(
      'Milestone 1: Security',
      { x: 0.7, y: 4.4, w: 2.4, h: 0.35 },
      { fontSize: 12, bold: true, color: C.navy }
    ),
    txt(
      '全ドキュメント生成履歴の暗号署名、およびブロックチェーン（監査用）アンカー処理を完全稼働。',
      { x: 0.7, y: 4.8, w: 2.4, h: 1.7 },
      { fontSize: 9.5, color: C.gray600, lineSpacing: 1.2 }
    ),

    shape('roundRect', { x: 3.6, y: 4.25, w: 2.8, h: 2.4 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1,
    }),
    txt(
      'Milestone 2: Swarms',
      { x: 3.8, y: 4.4, w: 2.4, h: 0.35 },
      { fontSize: 12, bold: true, color: C.navy }
    ),
    txt(
      '複数エージェントによるタスク競合防止のための分散ロック機構（分散リース）の検証完了。',
      { x: 3.8, y: 4.8, w: 2.4, h: 1.7 },
      { fontSize: 9.5, color: C.gray600, lineSpacing: 1.2 }
    ),

    shape('roundRect', { x: 6.7, y: 4.25, w: 2.8, h: 2.4 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1,
    }),
    txt(
      'Milestone 3: Sovereign',
      { x: 6.9, y: 4.4, w: 2.4, h: 0.35 },
      { fontSize: 12, bold: true, color: C.navy }
    ),
    txt(
      '外部ネットワーク非依存、ローカルの機密推論環境下のみで100%整合性を維持するデプロイメントの成立。',
      { x: 6.9, y: 4.8, w: 2.4, h: 1.7 },
      { fontSize: 9.5, color: C.gray600, lineSpacing: 1.2 }
    ),

    ...footer(4),
  ],
};

// Slide 5: Shape Master Museum (Vector shapes)
const slide5: PptxSlide = {
  id: 'slide5.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Vector Geometry Museum'),
    txt(
      'Exhibition of All Core Supported Shapes',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    // Row 1
    shape('rect', { x: 0.5, y: 1.6, w: 2.0, h: 1.1 }, 'Rectangle (rect)', {
      fill: C.blue,
      color: C.white,
      align: 'center',
      valign: 'middle',
    }),
    shape('roundRect', { x: 2.8, y: 1.6, w: 2.0, h: 1.1 }, 'Rounded Rectangle (roundRect)', {
      fill: C.green,
      color: C.white,
      align: 'center',
      valign: 'middle',
    }),
    shape('ellipse', { x: 5.1, y: 1.6, w: 2.0, h: 1.1 }, 'Ellipse (ellipse)', {
      fill: C.orange,
      color: C.white,
      align: 'center',
      valign: 'middle',
    }),
    shape('triangle', { x: 7.4, y: 1.6, w: 2.1, h: 1.1 }, 'Triangle (triangle)', {
      fill: C.purple,
      color: C.white,
      align: 'center',
      valign: 'middle',
    }),

    // Row 2
    shape('diamond', { x: 0.5, y: 3.0, w: 2.0, h: 1.1 }, 'Diamond (diamond)', {
      fill: C.red,
      color: C.white,
      align: 'center',
      valign: 'middle',
    }),
    shape('cube', { x: 2.8, y: 3.0, w: 2.0, h: 1.1 }, 'Cube (cube)', {
      fill: C.blueLight,
      color: C.navy,
      align: 'center',
      valign: 'middle',
      line: C.blue,
    }),
    shape('hexagon', { x: 5.1, y: 3.0, w: 2.0, h: 1.1 }, 'Hexagon (hexagon)', {
      fill: C.greenLight,
      color: C.gray800,
      align: 'center',
      valign: 'middle',
    }),
    shape('star5', { x: 7.4, y: 3.0, w: 2.1, h: 1.1 }, '5-Point Star (star5)', {
      fill: C.orangeLight,
      color: C.gray800,
      align: 'center',
      valign: 'middle',
    }),

    txt(
      'Borders, Custom Radiuses & Rotation',
      { x: 0.5, y: 4.3, w: 9.0, h: 0.4 },
      { fontSize: 15, bold: true, color: C.navy }
    ),

    // Custom borders / rotation
    shape('roundRect', { x: 0.5, y: 4.8, w: 2.6, h: 1.8 }, 'Thick Custom Dotted Border', {
      fill: C.white,
      line: C.red,
      lineWidth: 3.5,
      lineDash: 'dot',
      color: C.gray800,
      align: 'center',
      valign: 'middle',
    }),

    shape('roundRect', { x: 3.7, y: 4.8, w: 2.6, h: 1.8 }, 'Corner Radius (EMU 50000) & Shadow', {
      fill: C.white,
      line: C.blue,
      lineWidth: 1.5,
      cornerRadius: 50000,
      color: C.gray800,
      align: 'center',
      valign: 'middle',
      shadow: {
        type: 'outer',
        blur: 160000,
        dist: 90000,
        dir: 5400000,
        color: '#000000',
        opacity: 25,
      },
    }),

    shape('diamond', { x: 6.9, y: 4.8, w: 2.6, h: 1.8 }, 'Rotated 30° / Translucent', {
      fill: C.purple,
      opacity: 0.75,
      color: C.white,
      align: 'center',
      valign: 'middle',
      rotate: 30,
    }),

    ...footer(5),
  ],
};

// Slide 6: Connectors and Flows
const slide6: PptxSlide = {
  id: 'slide6.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Dynamic Flowcharts & Networks'),
    txt(
      'Connector Network Flow & Custom Arrowheads',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    // Block 1
    shape('roundRect', { x: 0.5, y: 1.8, w: 2.2, h: 0.8 }, 'Inbound Request', {
      fill: C.navy,
      color: C.white,
      bold: true,
      align: 'center',
      valign: 'middle',
    }),

    // Connector 1 -> 2
    line({ x: 2.7, y: 2.2, w: 1.2, h: 0 }, { line: C.navy, lineWidth: 2, headArrow: true }),

    // Block 2: Decision
    shape('diamond', { x: 3.9, y: 1.5, w: 2.2, h: 1.4 }, 'Validate\nContract?', {
      fill: C.orange,
      color: C.white,
      bold: true,
      align: 'center',
      valign: 'middle',
    }),

    // Connector 2 -> 3 (Yes, horizontal)
    line({ x: 6.1, y: 2.2, w: 1.2, h: 0 }, { line: C.green, lineWidth: 2, headArrow: true }),
    txt('YES', { x: 6.3, y: 1.9, w: 0.8, h: 0.3 }, { fontSize: 11, bold: true, color: C.green }),

    // Block 3: Success
    shape('roundRect', { x: 7.3, y: 1.8, w: 2.2, h: 0.8 }, 'Commit & Execute', {
      fill: C.green,
      color: C.white,
      bold: true,
      align: 'center',
      valign: 'middle',
    }),

    // Connector 2 -> 4 (No, vertical down)
    line(
      { x: 5.0, y: 2.9, w: 0, h: 1.1 },
      { line: C.red, lineWidth: 2, headArrow: true, lineDash: 'dash' }
    ),
    txt(
      'NO / INVALID',
      { x: 5.2, y: 3.3, w: 1.5, h: 0.3 },
      { fontSize: 11, bold: true, color: C.red }
    ),

    // Block 4: Fail / Repair
    shape('roundRect', { x: 3.9, y: 4.0, w: 2.2, h: 0.8 }, 'Auto-Repair Swarm', {
      fill: C.red,
      color: C.white,
      bold: true,
      align: 'center',
      valign: 'middle',
    }),

    // Back loop Connector 4 -> 1
    line(
      { x: 3.9, y: 4.4, w: -2.3, h: -1.8 },
      { line: C.purple, lineWidth: 1.5, headArrow: true, lineDash: 'dashDot' }
    ),
    txt(
      'Retry Loop',
      { x: 1.8, y: 3.8, w: 1.2, h: 0.3 },
      { fontSize: 10, bold: true, color: C.purple, rotate: 38 }
    ),

    // Sub note
    shape('rect', { x: 0.5, y: 5.3, w: 9.0, h: 1.3 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1,
    }),
    txt(
      '■ Natively Controlled Connectors Features:',
      { x: 0.7, y: 5.45, w: 8.6, h: 0.3 },
      { fontSize: 11, bold: true, color: C.navy }
    ),
    txt(
      '・直線の幾何学的な結線座標（x, y, w, h）を自動計算し、直感的なダイアグラム構成を実現します。\n・矢印の形状、太さ、色、およびダッシュパターン（破線・一点鎖線など）を個別スタイル定義としてフルサポート。',
      { x: 0.7, y: 5.75, w: 8.6, h: 0.7 },
      { fontSize: 10.5, color: C.gray700, lineSpacing: 1.25 }
    ),

    ...footer(6),
  ],
};

// Slide 7: Advanced Tables & Grids (Spreadsheet details)
const slide7: PptxSlide = {
  id: 'slide7.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Advanced Data Tables & Matrices'),
    txt(
      'Structured Matrices with Individual Column Controls',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    {
      type: 'table',
      pos: { x: 0.5, y: 1.7, w: 9.0, h: 4.6 },
      rows: [
        ['Process Stream', 'Input Data Scope', 'AI Agent Role Owner', 'Governance Verification'],
        [
          'ADF Pipeline Exec',
          'JSON execution contracts (.json)',
          'Orchestrator-Actuator',
          'Schema valid & signed',
        ],
        [
          'Audit Ledger anchoring',
          'SHA-256 process traces',
          'Blockchain-Actuator',
          'Immutable Merkle-root commit',
        ],
        [
          'Meeting Transcription',
          'Audio Bus streaming recording',
          'Meeting-Browser-Driver',
          'Operator explicit consent',
        ],
        [
          'PDF / Report compilation',
          'Structured text brief schemas',
          'Media-Actuator (Report)',
          'L4 automated visual review',
        ],
        [
          'Physical UI Browser test',
          'Playwright session screenshots',
          'Browser-Actuator',
          'Full SRE security sandbox',
        ],
        [
          'Core Knowledge Distillation',
          'Confidential files directories',
          'Wisdom-Actuator',
          'Tier segregation checks',
        ],
      ],
      colWidths: [2.2, 2.5, 2.2, 2.1],
    },

    ...footer(7),
  ],
};

// Slide 8: Rich Inline Typography (Text runs & multi-font / JP support)
const slide8: PptxSlide = {
  id: 'slide8.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Sovereign Typography & Japanese Runs'),
    txt(
      'Inline Rich-Text Runs & Double-byte Multi-font Integrity',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    {
      type: 'text',
      pos: { x: 0.5, y: 1.7, w: 9.0, h: 4.8 },
      textRuns: [
        { text: '1. 単一のテキストボックス内に、独立した異なるスタイル属性を持つ「' },
        {
          text: '複数のテキストラン（Text Runs）',
          options: { bold: true, color: C.blue, fontSize: 15 },
        },
        { text: '」をシームレスに混在させてレイアウト可能です。\n\n' },
        { text: '2. 例として：このランは「' },
        { text: 'ボールド（太字）', options: { bold: true, color: C.navy } },
        { text: '」であり、このランは「' },
        { text: 'イタリック（斜体）', options: { italic: true, color: C.orange } },
        { text: '」、このランには「' },
        { text: '下線（Underline）', options: { underline: true, color: C.green } },
        { text: '」と「' },
        { text: '打ち消し線（Strike）', options: { strike: true, color: C.red } },
        { text: '」が同時に適用されています。\n\n' },
        { text: '3. さらに、部分的なフォントサイズの変更（' },
        { text: '18ptの大文字', options: { fontSize: 18, bold: true, color: C.purple } },
        { text: ' など）や、背景色のマーカーハイライト（' },
        { text: 'イエローのハイライト背景', options: { highlight: '#FFFF00', bold: true } },
        { text: '）が自在に表現可能です。\n\n' },
        {
          text: '4. 日本語（ダブルバイト文字）と英語のフォントファミリーの分離整合性も保たれます（例: ',
        },
        { text: 'MS-Gothic', options: { fontFamily: 'MS Gothic', bold: true } },
        { text: ' や ' },
        { text: 'Times New Roman', options: { fontFamily: 'Times New Roman', italic: true } },
        { text: ' などの混在環境でも文字化けやズレは一切発生しません）。' },
      ],
      style: {
        fontFamily: 'Yu Gothic',
        fontSize: 13,
        color: C.gray800,
        fill: C.gray50,
        line: C.gray200,
        lineWidth: 1.5,
        margin: [0.25, 0.25, 0.25, 0.25],
        lineSpacing: 1.3,
      },
    },

    ...footer(8),
  ],
};

// Slide 9: Bullet points, Multi-Level Indents, Margins & Spacings
const slide9: PptxSlide = {
  id: 'slide9.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Structured Indents & Bullet Hierarchies'),
    txt(
      'Multi-Level Nesting, Hanging Indents & Line Spacing',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    {
      type: 'text',
      pos: { x: 0.5, y: 1.7, w: 9.0, h: 4.8 },
      textRuns: [
        { text: '■ Level 0 (Hanging Indent 0.25") — Root Category Bullet Point\n' },
        { text: '→ Level 1 (Hanging Indent 0.5", level 1) — Nested Detail Bullet Point\n' },
        {
          text: '• Level 2 (Hanging Indent 0.75", level 2) — Inner Specifications / Checkpoints\n',
        },
        { text: '1. Auto-Number List (arabicPeriod, level 0) — Sequential step 1\n' },
        { text: '2. Auto-Number List (arabicPeriod, level 0) — Sequential step 2\n' },
        {
          text: 'Paragraph spacings (spaceBefore, spaceAfter) and precise spacing percentage are perfectly controlled to eliminate any typical browser layout overflow defects.',
        },
      ],
      style: {
        fontFamily: 'Yu Gothic',
        fontSize: 13.5,
        color: C.gray800,
        bullet: {
          type: 'char',
          char: '■',
          color: C.navy,
          size: 100,
          indent: 0.25,
          level: 0,
        },
        lineSpacing: 1.35,
        spaceBefore: 8,
        spaceAfter: 8,
      },
    },

    ...footer(9),
  ],
};

// Slide 10: System Architecture Diagram (ブロック構成図)
const slide10: PptxSlide = {
  id: 'slide10.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('System Architecture Diagram'),
    txt(
      'Kyberion Platform Components & Data Protection Segregation',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    // Outer Boundary box (Sovereign Cloud)
    shape('roundRect', { x: 0.4, y: 1.6, w: 9.2, h: 5.1 }, '', {
      fill: C.gray50,
      line: C.blue,
      lineWidth: 2,
      lineDash: 'dash',
    }),
    txt(
      'Kyberion OS Sovereign Security Boundary (Strict Local Execution & Sandbox)',
      { x: 0.6, y: 1.7, w: 8.8, h: 0.35 },
      { fontSize: 11, bold: true, color: C.navy }
    ),

    // 3 Major Blocks
    // Block A: Human Interaction (Left)
    shape('roundRect', { x: 0.8, y: 2.2, w: 2.5, h: 4.1 }, '', {
      fill: C.blueLight,
      line: C.blue,
      lineWidth: 1.5,
    }),
    txt(
      'Human Interface',
      { x: 1.0, y: 2.4, w: 2.1, h: 0.35 },
      { fontSize: 13, bold: true, color: C.navy, align: 'center' }
    ),
    shape('rect', { x: 1.0, y: 2.9, w: 2.1, h: 0.7 }, 'Developer CLI\n(agy)', {
      fill: C.white,
      line: C.gray400,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    shape('rect', { x: 1.0, y: 3.8, w: 2.1, h: 0.7 }, 'Sovereign Web UI\n(Dashboard)', {
      fill: C.white,
      line: C.gray400,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    shape('rect', { x: 1.0, y: 4.7, w: 2.1, h: 0.7 }, 'Mission Control API\n(TypeScript)', {
      fill: C.white,
      line: C.gray400,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),

    // Connector Left -> Middle
    line({ x: 3.3, y: 4.25, w: 0.6, h: 0 }, { line: C.blue, lineWidth: 2, headArrow: true }),

    // Block B: Core Engine & Swarms (Middle)
    shape('roundRect', { x: 3.9, y: 2.2, w: 2.5, h: 4.1 }, '', {
      fill: C.purpleLight,
      line: C.purple,
      lineWidth: 1.5,
    }),
    txt(
      'Core Orchestration',
      { x: 4.1, y: 2.4, w: 2.1, h: 0.35 },
      { fontSize: 13, bold: true, color: C.navy, align: 'center' }
    ),
    shape(
      'rect',
      { x: 4.1, y: 2.9, w: 2.1, h: 0.7 },
      'ADF Contract Engine\n(Preflight & Execution)',
      { fill: C.white, line: C.gray400, fontSize: 10, align: 'center', valign: 'middle' }
    ),
    shape(
      'rect',
      { x: 4.1, y: 3.8, w: 2.1, h: 0.7 },
      'Autonomous Swarms\n(Self / Research Agents)',
      { fill: C.white, line: C.gray400, fontSize: 10, align: 'center', valign: 'middle' }
    ),
    shape('rect', { x: 4.1, y: 4.7, w: 2.1, h: 0.7 }, 'Secure I/O Layer\n(Path & Access Guard)', {
      fill: C.white,
      line: C.gray400,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),

    // Connector Middle -> Right
    line({ x: 6.4, y: 4.25, w: 0.6, h: 0 }, { line: C.purple, lineWidth: 2, headArrow: true }),

    // Block C: Security & Storage Tiers (Right)
    shape('roundRect', { x: 7.0, y: 2.2, w: 2.2, h: 4.1 }, '', {
      fill: C.greenLight,
      line: C.green,
      lineWidth: 1.5,
    }),
    txt(
      'Data Sovereignty',
      { x: 7.1, y: 2.4, w: 2.0, h: 0.35 },
      { fontSize: 13, bold: true, color: C.navy, align: 'center' }
    ),
    shape('rect', { x: 7.2, y: 2.9, w: 1.8, h: 0.7 }, 'Personal Data\n(Local Knowledge)', {
      fill: C.white,
      line: C.gray400,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    shape('rect', { x: 7.2, y: 3.8, w: 1.8, h: 0.7 }, 'Confidential Vault\n(Project Scope)', {
      fill: C.white,
      line: C.gray400,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),
    shape('rect', { x: 7.2, y: 4.7, w: 1.8, h: 0.7 }, 'Audit Ledger\n(Blockchain Anchor)', {
      fill: C.white,
      line: C.gray400,
      fontSize: 10,
      align: 'center',
      valign: 'middle',
    }),

    ...footer(10),
  ],
};

// Slide 11: RACI Matrix (高度なテーブルと文字配置の組み合わせ)
const slide11: PptxSlide = {
  id: 'slide11.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Governance RACI Responsibility Matrix'),
    txt(
      'Core Platform Operations & Agent Responsibility Assignment',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    {
      type: 'table',
      pos: { x: 0.5, y: 1.6, w: 9.0, h: 4.7 },
      rows: [
        [
          'Platform Activity / Task',
          'Human Owner',
          'Orchestrator Agent',
          'Research Agent',
          'Security Auditor',
        ],
        [
          'Define Mission Objectives',
          'Accountable (A)',
          'Consulted (C)',
          'Informed (I)',
          'Informed (I)',
        ],
        [
          'Draft ADF Contracts',
          'Consulted (C)',
          'Responsible (R)',
          'Consulted (C)',
          'Informed (I)',
        ],
        [
          'Preflight Schema Validation',
          'Informed (I)',
          'Responsible (R)',
          'Informed (I)',
          'Accountable (A)',
        ],
        [
          'Secure Path Execution',
          'Informed (I)',
          'Responsible (R)',
          'Informed (I)',
          'Accountable (A)',
        ],
        [
          'Deep Repository Research',
          'Informed (I)',
          'Consulted (C)',
          'Responsible (R)',
          'Informed (I)',
        ],
        [
          'Immutability Ledger Logging',
          'Informed (I)',
          'Responsible (R)',
          'Informed (I)',
          'Accountable (A)',
        ],
        [
          'Sign & Close Mission Gate',
          'Accountable (A)',
          'Responsible (R)',
          'Informed (I)',
          'Responsible (R)',
        ],
      ],
      colWidths: [2.6, 1.6, 1.6, 1.6, 1.6],
    },

    ...footer(11),
  ],
};

// Slide 12: Feature & Engine Capabilities Comparison (詳細比較マトリクス)
const slide12: PptxSlide = {
  id: 'slide12.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Engine Capabilities Comparison'),
    txt(
      'Kyberion Sovereign Engine vs Standard Legacy Builders',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    {
      type: 'table',
      pos: { x: 0.5, y: 1.6, w: 9.0, h: 4.3 },
      rows: [
        [
          'Presentation Feature',
          'Standard PPTX Libs',
          'Kyberion Sovereign Engine',
          'Sovereign Benefit',
        ],
        [
          'Raw OOXML Generation',
          '✗ (High Overhead)',
          '✔ (Pure Native XML)',
          'Ultra-fast, zero extra dependencies',
        ],
        [
          'Geometric Vector Presets',
          'Limited to rect/ellipse',
          '✔ (All 150+ MS Shape presets)',
          'Flawless native rendering without distortion',
        ],
        [
          'Rich Multi-style Run',
          '✗ (One style per block)',
          '✔ (Unlimited inline text runs)',
          'Double-byte JP/EN fonts match perfectly',
        ],
        [
          'Advanced Connections',
          '✗ (Hardcoded coords)',
          '✔ (Geometric autocalc + anchors)',
          'Fluid network flowcharts & UML layout',
        ],
        [
          'List & Hanging Indents',
          '✗ (Buggy bullet layouts)',
          '✔ (Precise point indents & spacing)',
          'Pixel-level layout matching enterprise standard',
        ],
        [
          'Sandbox Path Security',
          '✗ (Arbitrary local I/O)',
          '✔ (Restricted Secure I/O)',
          'Enterprise auditing, zero leakage risk',
        ],
      ],
      colWidths: [2.3, 2.1, 2.4, 2.2],
    },

    shape('roundRect', { x: 0.5, y: 6.0, w: 9.0, h: 0.8 }, '', {
      fill: C.blueLight,
      line: C.blue,
      lineWidth: 1,
    }),
    txt(
      'Summary Verdict:',
      { x: 0.7, y: 6.1, w: 1.5, h: 0.35 },
      { fontSize: 11, bold: true, color: C.navy }
    ),
    txt(
      'Kyberion Sovereign Engine achieves pure compliance by directly manipulating PowerPoint underlying ZIP structures, eliminating intermediate abstraction translation bugs.',
      { x: 2.2, y: 6.1, w: 7.1, h: 0.6 },
      { fontSize: 10, color: C.gray800 }
    ),

    ...footer(12),
  ],
};

// Slide 13: KPI Dashboard / Statistical Highlights (巨大数字と進捗インジケーター)
const slide13: PptxSlide = {
  id: 'slide13.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Sovereign Execution Performance KPI'),
    txt(
      'Quantitative Metrics demonstrating Generation Efficiency & Compliance',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    // KPI Card 1: Generation Speed
    shape('roundRect', { x: 0.5, y: 1.7, w: 2.8, h: 3.5 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1.5,
    }),
    txt(
      '99.2%',
      { x: 0.5, y: 2.0, w: 2.8, h: 0.8 },
      { fontSize: 36, bold: true, color: C.blue, align: 'center' }
    ),
    txt(
      'GENERATION SUCCESS RATE',
      { x: 0.7, y: 2.9, w: 2.4, h: 0.3 },
      { fontSize: 10, bold: true, color: C.gray600, align: 'center' }
    ),
    line({ x: 0.9, y: 3.3, w: 2.0, h: 0 }, { line: C.gray200, lineWidth: 1 }),
    txt(
      '1,000回以上の連続パフォーマンステストにおいて、OOXMLパースエラーおよび座標衝突を完全回避。高度な自動リカバリ機構を実証。',
      { x: 0.7, y: 3.5, w: 2.4, h: 1.5 },
      { fontSize: 9.5, color: C.gray700, lineSpacing: 1.2 }
    ),

    // KPI Card 2: Security Level
    shape('roundRect', { x: 3.6, y: 1.7, w: 2.8, h: 3.5 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1.5,
    }),
    txt(
      'L5',
      { x: 3.6, y: 2.0, w: 2.8, h: 0.8 },
      { fontSize: 36, bold: true, color: C.purple, align: 'center' }
    ),
    txt(
      'MAX SECURE TRUST LEVEL',
      { x: 3.8, y: 2.9, w: 2.4, h: 0.3 },
      { fontSize: 10, bold: true, color: C.gray600, align: 'center' }
    ),
    line({ x: 4.0, y: 3.3, w: 2.0, h: 0 }, { line: C.gray200, lineWidth: 1 }),
    txt(
      '機密度の高いパーソナルおよびConfidential層データを完全に分離制御。エージェント間通信を含め、すべてのI/Oへのリアルタイム監査を確立。',
      { x: 3.8, y: 3.5, w: 2.4, h: 1.5 },
      { fontSize: 9.5, color: C.gray700, lineSpacing: 1.2 }
    ),

    // KPI Card 3: Execution Time
    shape('roundRect', { x: 6.7, y: 1.7, w: 2.8, h: 3.5 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1.5,
    }),
    txt(
      '< 1.2s',
      { x: 6.7, y: 2.0, w: 2.8, h: 0.8 },
      { fontSize: 36, bold: true, color: C.green, align: 'center' }
    ),
    txt(
      'AVERAGE BUILD SPEED',
      { x: 6.9, y: 2.9, w: 2.4, h: 0.3 },
      { fontSize: 10, bold: true, color: C.gray600, align: 'center' }
    ),
    line({ x: 7.1, y: 3.3, w: 2.0, h: 0 }, { line: C.gray200, lineWidth: 1 }),
    txt(
      '中間抽象化ライブラリのオーバーヘッドが一切ないため、15枚以上の高密度スライドであっても、1.2秒未満のミリ秒オーダーで即時合成を完了。',
      { x: 6.9, y: 3.5, w: 2.4, h: 1.5 },
      { fontSize: 9.5, color: C.gray700, lineSpacing: 1.2 }
    ),

    // Visual Bar: Progress representation
    txt(
      'Platform Security Compliance Index Score:',
      { x: 0.5, y: 5.5, w: 4.0, h: 0.35 },
      { fontSize: 11, bold: true, color: C.navy }
    ),
    shape('rect', { x: 0.5, y: 5.9, w: 9.0, h: 0.4 }, '', { fill: C.gray100 }),
    shape('rect', { x: 0.5, y: 5.9, w: 8.5, h: 0.4 }, '95% Standard Achieved (Fully Compliant)', {
      fill: C.green,
      color: C.white,
      fontSize: 10,
      bold: true,
      valign: 'middle',
      align: 'center',
    }),

    ...footer(13),
  ],
};

// Slide 14: Cross-functional Workflow (部門をまたぐワークフロー/スイムレーン)
const slide14: PptxSlide = {
  id: 'slide14.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Cross-Functional Execution Pipeline'),
    txt(
      'Swarm Integration Workflow across Multi-layer Security Tiers',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    // Swimlane Headers
    shape('rect', { x: 0.5, y: 1.6, w: 2.0, h: 1.5 }, 'Personal Tier\n(Local User Knowledge)', {
      fill: C.blueLight,
      color: C.navy,
      fontSize: 10,
      bold: true,
      align: 'center',
      valign: 'middle',
      line: C.blue,
    }),
    shape('rect', { x: 0.5, y: 3.25, w: 2.0, h: 1.5 }, 'Confidential Tier\n(Project Core Vault)', {
      fill: C.purpleLight,
      color: C.navy,
      fontSize: 10,
      bold: true,
      align: 'center',
      valign: 'middle',
      line: C.purple,
    }),
    shape('rect', { x: 0.5, y: 4.9, w: 2.0, h: 1.5 }, 'Public Tier\n(Export Deliverable)', {
      fill: C.greenLight,
      color: C.navy,
      fontSize: 10,
      bold: true,
      align: 'center',
      valign: 'middle',
      line: C.green,
    }),

    // Step 1 (Top lane)
    shape(
      'roundRect',
      { x: 2.8, y: 1.95, w: 1.8, h: 0.8 },
      'Collect Personal Brief\n& Setup Identity',
      {
        fill: C.white,
        line: C.blue,
        lineWidth: 1.5,
        fontSize: 9,
        align: 'center',
        valign: 'middle',
      }
    ),

    // Connector 1 -> 2 (Diag Down)
    line(
      { x: 4.6, y: 2.35, w: 0.6, h: 1.15 },
      { line: C.blue, lineWidth: 1.5, headArrow: true, lineDash: 'dash' }
    ),

    // Step 2 (Middle lane)
    shape(
      'roundRect',
      { x: 5.2, y: 3.6, w: 1.8, h: 0.8 },
      'Validate ADF Contract\nagainst Schemas',
      {
        fill: C.white,
        line: C.purple,
        lineWidth: 1.5,
        fontSize: 9,
        align: 'center',
        valign: 'middle',
      }
    ),

    // Connector 2 -> 3 (Diag Down)
    line(
      { x: 7.0, y: 4.0, w: 0.6, h: 1.15 },
      { line: C.purple, lineWidth: 1.5, headArrow: true, lineDash: 'dash' }
    ),

    // Step 3 (Bottom lane)
    shape(
      'roundRect',
      { x: 7.6, y: 5.25, w: 1.8, h: 0.8 },
      'Synthesize Native PPTX\n& Expose File',
      { fill: C.green, color: C.white, bold: true, fontSize: 9, align: 'center', valign: 'middle' }
    ),

    // Background horizontal divider lines for lanes
    line({ x: 0.5, y: 3.17, w: 9.0, h: 0 }, { line: C.gray200, lineWidth: 1 }),
    line({ x: 0.5, y: 4.82, w: 9.0, h: 0 }, { line: C.gray200, lineWidth: 1 }),

    ...footer(14),
  ],
};

// Slide 15: Developer Quickstart Guide (コードブロック、実用マニュアル)
const slide15: PptxSlide = {
  id: 'slide15.xml',
  backgroundFill: C.white,
  elements: [
    ...sectionHeader('Developer Quickstart Guide'),
    txt(
      'Minimal ADF Schema Example & CLI Commands to Boot Engine',
      { x: 0.5, y: 1.1, w: 9.0, h: 0.4 },
      { fontSize: 16, bold: true, color: C.navy }
    ),

    // Code Block Shape
    shape('rect', { x: 0.5, y: 1.6, w: 4.3, h: 4.8 }, '', {
      fill: C.gray800,
      line: C.navy,
      lineWidth: 1,
    }),
    txt(
      "// ADF Protocol Instantiation\nconst protocol: PptxDesignProtocol = {\n  version: '3.0.0',\n  canvas: { w: 10, h: 7.5 },\n  theme: {\n    dk1: '0F1F33', lt1: 'FFFFFF',\n    accent1: '3B82F6', accent2: '10B981'\n  },\n  slides: [{\n    id: 'slide1.xml',\n    backgroundFill: '#FFFFFF',\n    elements: [{\n      type: 'text',\n      pos: { x: 1, y: 1, w: 5, h: 1 },\n      text: 'Hello World'\n    }]\n  }]\n};",
      { x: 0.6, y: 1.7, w: 4.1, h: 4.6 },
      {
        fontFamily: 'Courier New',
        fontSize: 10,
        color: C.greenLight,
        lineSpacing: 1.15,
      }
    ),

    // Commands Block
    shape('roundRect', { x: 5.1, y: 1.6, w: 4.4, h: 4.8 }, '', {
      fill: C.gray50,
      line: C.gray200,
      lineWidth: 1.5,
    }),
    txt(
      'CLI Execution Interface',
      { x: 5.4, y: 1.8, w: 3.8, h: 0.35 },
      { fontSize: 14, bold: true, color: C.navy }
    ),

    txt(
      '$ pnpm install\n\n$ pnpm run build:repo\n\n$ node dist/scripts/generate_all_objects_layout_sample.js',
      { x: 5.4, y: 2.3, w: 3.8, h: 1.2 },
      {
        fontFamily: 'Courier New',
        fontSize: 11,
        color: C.navy,
        fill: C.gray200,
        margin: [0.15, 0.15, 0.15, 0.15],
      }
    ),

    txt(
      '■ Setup Requirements:\n・Node.js v18+\n・TypeScript 5.x with ESNext ESM setup\n・pnpm Workspace Monorepo resolved dependencies\n\n■ Deliverable Output:\nSuccessful compiler generates output locally within: \n`active/shared/tmp/all_objects_layout_sample.pptx` \nwhich adheres strictly to OOXML ECMA-376 ISO standards.',
      { x: 5.4, y: 3.6, w: 3.8, h: 2.6 },
      { fontSize: 11, color: C.gray700, lineSpacing: 1.2 }
    ),

    ...footer(15),
  ],
};

// Slide 16: Conclusion & Call to Action (CTA Cover)
const slide16: PptxSlide = {
  id: 'slide16.xml',
  backgroundFill: C.navyDark,
  elements: [
    shape('rect', { x: 0, y: 0, w: 10, h: 0.15 }, '', { fill: C.blue }),
    txt(
      'End of Showcase',
      { x: 1.0, y: 1.8, w: 8.0, h: 0.5 },
      { fontSize: 18, bold: true, color: C.blueLight, align: 'center' }
    ),
    txt(
      'Empower Your Agency Workflows',
      { x: 1.0, y: 2.4, w: 8.0, h: 1.2 },
      {
        fontSize: 36,
        bold: true,
        color: C.white,
        align: 'center',
        valign: 'middle',
      }
    ),
    txt(
      'Kyberion OS Sovereign Presentation Engine delivers verified corporate standard visuals natively, immutably, and flawlessly under strict local guidelines.',
      { x: 1.5, y: 3.7, w: 7.0, h: 0.8 },
      {
        fontSize: 13.5,
        color: C.gray400,
        align: 'center',
      }
    ),

    // Centered Blue CTA Box
    shape('roundRect', { x: 2.8, y: 4.8, w: 4.4, h: 0.9 }, 'Access Developer Docs: doc.famao.ai', {
      fill: C.blue,
      color: C.white,
      fontSize: 14,
      bold: true,
      align: 'center',
      valign: 'middle',
      shadow: {
        type: 'outer',
        blur: 150000,
        dist: 70000,
        dir: 5400000,
        color: '#000000',
        opacity: 35,
      },
    }),

    txt(
      'famao AI  |  Governed Execution Platform',
      { x: 1.0, y: 6.6, w: 8.0, h: 0.35 },
      { fontSize: 10, color: C.gray400, align: 'center' }
    ),
  ],
};

// ═══════════════════════════════════════════════════════════
// COMPILE & WRITE PROTOCOL
// ═══════════════════════════════════════════════════════════
const protocol: PptxDesignProtocol = {
  version: '3.0.0',
  generatedAt: new Date().toISOString(),
  canvas: { w: 10, h: 7.5 },
  theme: {
    dk1: '0F1F33',
    lt1: 'FFFFFF',
    dk2: '1E3A5F',
    lt2: 'F3F4F6',
    accent1: '3B82F6',
    accent2: '10B981',
    accent3: 'F59E0B',
    accent4: '8B5CF6',
    accent5: 'EF4444',
    accent6: '4B5563',
    hlink: '3B82F6',
    folHlink: '8B5CF6',
  },
  master: { elements: [] },
  slides: [
    slide1,
    slide2,
    slide3,
    slide4,
    slide5,
    slide6,
    slide7,
    slide8,
    slide9,
    slide10,
    slide11,
    slide12,
    slide13,
    slide14,
    slide15,
    slide16,
  ],
};

async function main() {
  const outPath = 'active/shared/tmp/all_objects_layout_sample.pptx';
  console.log(
    'Generating premium masterclass PowerPoint presentation (16 slides comprehensive museum)...'
  );
  try {
    await generateNativePptx(protocol, outPath);
    console.log(`Successfully generated PowerPoint file at: ${outPath}`);
  } catch (error) {
    console.error('Error during generation:', error);
    process.exit(1);
  }
}

main();
