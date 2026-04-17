import { generateNativePptx, pathResolver, safeExistsSync, safeMkdir } from '@agent/core';
import type { PptxDesignProtocol, PptxElement, PptxSlide } from '../libs/core/src/types/pptx-protocol.js';
import * as path from 'node:path';

type SlideSpec = {
  title: string;
  bullets: string[];
  note: string;
};

const C = {
  navy: '#183B56',
  navyDark: '#0B2239',
  azure: '#1D4ED8',
  sky: '#DCEBFF',
  teal: '#0F766E',
  mint: '#D9F3EF',
  amber: '#B45309',
  amberLight: '#FDE7C7',
  aws: '#FF9900',
  cloud: '#EAF3FF',
  slate50: '#F8FAFC',
  slate100: '#F1F5F9',
  slate200: '#CBD5E1',
  slate400: '#94A3B8',
  slate600: '#475569',
  slate700: '#334155',
  slate800: '#1E293B',
  white: '#FFFFFF',
};

const OUTLINE: SlideSpec[] = [
  { title: '1. 表紙', bullets: ['勘定系システム 非機能要件定義書', '対象: AWS基盤', '対象読者: 開発・インフラ'], note: '本資料の目的と対象範囲を明示する。' },
  { title: '2. 本資料の位置づけ', bullets: ['設計・実装の前提条件を定義', '可用性・性能・運用を対象', '機能要件は別資料を参照'], note: '非機能要件の役割を整理する。' },
  { title: '3. 目的', bullets: ['安定稼働を継続的に確保', '障害時の影響を最小化', '監査・統制に耐える基盤を実現'], note: '勘定系に求められる狙いを簡潔に示す。' },
  { title: '4. 対象範囲', bullets: ['アプリ実行基盤', 'ネットワーク・セキュリティ', '運用監視・バックアップ・DR'], note: 'カバーする領域を明確化する。' },
  { title: '5. 前提条件', bullets: ['AWS上に新規構築', '24x365運用を想定', '重要データを継続保護'], note: '設計前提を固定して議論を揃える。' },
  { title: '6. 用語・定義', bullets: ['RTO/RPOの定義', '本番・待機系の定義', '障害・停止・劣化の区別'], note: '要件解釈のぶれを防ぐ。' },
  { title: '7. システム特性', bullets: ['高信頼・低遅延が必須', 'ピーク時の安定性重視', '変更管理を厳格に運用'], note: '勘定系の特性を前提に置く。' },
  { title: '8. 非機能優先順位', bullets: ['可用性を最優先', '次に性能・保全性', 'セキュリティと監査性を常時確保'], note: 'トレードオフ判断の軸を示す。' },
  { title: '9. 全体アーキテクチャ', bullets: ['マルチAZを基本構成', '管理系と業務系を分離', '外部連携は境界で制御'], note: '全体像を俯瞰できるようにする。' },
  { title: '10. AWS利用方針', bullets: ['マネージドサービスを優先', '標準機能で統制を強化', '例外採用は審査制'], note: 'AWS採用の基本方針を定義する。' },
  { title: '11. 可用性目標', bullets: ['SLA/SLOを明文化', '単一障害点を排除', '計画停止を最小化'], note: '可用性の数値と考え方を定める。' },
  { title: '12. 障害許容設計', bullets: ['AZ障害で継続可能', '一部機能停止でも業務継続', '復旧手順を標準化'], note: '想定障害と継続方針を整理する。' },
  { title: '13. 性能目標', bullets: ['主要API応答時間を定義', 'バッチ処理の締切時刻を定義', 'ピーク時遅延を監視'], note: '性能要件を具体的にする。' },
  { title: '14. スループット要件', bullets: ['時間帯別処理件数を定義', '同時接続数を想定', '外部接続の上限を管理'], note: '処理量の前提を可視化する。' },
  { title: '15. スケーラビリティ方針', bullets: ['水平スケールを基本', '閾値で自動拡張', '段階的増強を可能にする'], note: '将来増加への対応方針を定める。' },
  { title: '16. キャパシティ管理', bullets: ['日次で使用率を確認', '月次で余力を評価', '増設判断の基準を設定'], note: '容量不足を事前に防ぐ。' },
  { title: '17. IAM基本方針', bullets: ['最小権限を徹底', '人とシステムを分離', '権限付与は申請制'], note: 'アクセス統制の基本線を示す。' },
  { title: '18. 認証・認可', bullets: ['強固な認証を必須化', 'ロールベースで制御', '特権操作を限定'], note: '認証と認可の要件を整理する。' },
  { title: '19. 特権ID管理', bullets: ['管理者IDを分離', '利用時は申請・記録', '常用IDでの特権利用禁止'], note: '特権乱用を防ぐ運用を定義する。' },
  { title: '20. 暗号化方針', bullets: ['保存データを暗号化', '通信をTLSで保護', '鍵は統制下で管理'], note: 'データ保護の基本方針を示す。' },
  { title: '21. 鍵管理', bullets: ['KMSで鍵を管理', 'ローテーションを定期実施', '鍵アクセスを監査'], note: '鍵の運用ルールを明確にする。' },
  { title: '22. ネットワーク分離', bullets: ['本番・検証を分離', '公開系と内部系を分離', 'ルート制御を明示'], note: 'ネットワーク境界を厳格にする。' },
  { title: '23. VPC設計', bullets: ['AZ跨ぎでサブネット配置', '用途別にサブネット分割', '不要な経路は閉塞'], note: 'AWSネットワークの基本構成を定める。' },
  { title: '24. 入口・出口制御', bullets: ['WAFで不正通信を遮断', 'SG/NACLで層別防御', '外部通信先を限定'], note: '境界防御の要件を整理する。' },
  { title: '25. 監視方針', bullets: ['死活・性能・業務指標を監視', '閾値超過で即通知', 'アラートは重要度別に分類'], note: '監視対象と通知方針を定義する。' },
  { title: '26. ログ管理', bullets: ['操作ログを保全', 'アプリ・OS・NWログを集約', '検索性と保管期限を定義'], note: '証跡確保と調査性を担保する。' },
  { title: '27. メトリクス/KPI', bullets: ['応答時間とエラー率', 'CPU・メモリ・IOPS', '業務件数と滞留件数'], note: '運用判断に使う指標を定める。' },
  { title: '28. 運用体制', bullets: ['一次・二次対応を定義', '24時間の連絡経路を整備', '役割分担を文書化'], note: '運用責任を明確にする。' },
  { title: '29. 障害対応', bullets: ['検知から初動までを標準化', '切り戻し手順を用意', '原因分析の期限を設定'], note: '障害時の動きを具体化する。' },
  { title: '30. 定期保守', bullets: ['メンテ時間帯を固定', 'パッチ適用手順を整備', '影響範囲を事前通知'], note: '計画保守の制御方針を示す。' },
  { title: '31. バックアップ方針', bullets: ['世代管理を実施', '日次・週次で保全', '復元試験を定期実施'], note: 'バックアップの基本要件を定める。' },
  { title: '32. リストア要件', bullets: ['復元単位を明確化', '復元時間を定義', '手順書を最新版に維持'], note: '復旧可能性を要件として明確化する。' },
  { title: '33. DR方針', bullets: ['別リージョンで待機', '災害時の切替手順を定義', '復旧優先順位を決める'], note: '災害対策の基本方針を示す。' },
  { title: '34. DR目標値', bullets: ['RTOを業務別に設定', 'RPOをデータ別に設定', '目標未達時の代替運用を定義'], note: 'DRの定量目標を置く。' },
  { title: '35. リジリエンス', bullets: ['局所障害を吸収', '依存先障害を隔離', 'フェイルオーバーを自動化'], note: '障害耐性を構造として持たせる。' },
  { title: '36. デプロイ方針', bullets: ['自動デプロイを基本', '段階リリースを採用', '本番反映は承認制'], note: '安全なリリース運用を定義する。' },
  { title: '37. CI/CD要件', bullets: ['ビルドの再現性を確保', '静的解析を必須化', 'デプロイ履歴を保管'], note: '変更を管理可能な形で流す。' },
  { title: '38. 構成管理', bullets: ['IaCで構成を管理', '差分をコードで追跡', '手作業変更を禁止'], note: '構成逸脱を抑制する。' },
  { title: '39. テスト方針', bullets: ['性能・負荷試験を実施', '障害復旧試験を実施', '運用受入試験を必須化'], note: '非機能の検証観点を定義する。' },
  { title: '40. セキュリティ試験', bullets: ['脆弱性診断を定期実施', '権限設定の点検を実施', '外部接続の確認を実施'], note: 'セキュリティ妥当性を検証する。' },
  { title: '41. データ要件', bullets: ['整合性を最優先', '更新順序を保証', 'データ欠損を許容しない'], note: '勘定系データの重要性を反映する。' },
  { title: '42. データ保管', bullets: ['保持期間を定義', '世代保管を明確化', '削除証跡を残す'], note: '保存と削除の統制を定める。' },
  { title: '43. データ連携', bullets: ['連携方式を標準化', '再送制御を実装', '重複排除を考慮'], note: '外部連携の安定性を確保する。' },
  { title: '44. 移行方針', bullets: ['段階移行を前提', '並行稼働を計画', '切替条件を事前定義'], note: '移行時のリスクを抑える。' },
  { title: '45. 移行検証', bullets: ['データ突合を実施', '性能劣化を確認', '戻し手順を検証'], note: '移行の妥当性を確認する。' },
  { title: '46. コンプライアンス', bullets: ['監査証跡を保持', '権限分離を徹底', '規程違反を検知'], note: '統制・監査対応を前提に置く。' },
  { title: '47. コスト管理', bullets: ['月次コストを可視化', 'リソース停止を自動化', '過剰構成を抑制'], note: '安定性を損なわずに費用を管理する。' },
  { title: '48. リスクと課題', bullets: ['性能余裕の不足', '運用属人化', 'DR訓練不足'], note: '主要リスクを先に把握する。' },
  { title: '49. ロードマップ', bullets: ['要件確定', '詳細設計・構築・試験', '運用開始後の継続改善'], note: '導入から定着までの流れを示す。' },
  { title: '50. 付録', bullets: ['RTO/RPO一覧', '監視項目一覧', '運用手順・連絡先一覧'], note: '詳細資料への参照先をまとめる。' },
];

function txt(text: string, pos: { x: number; y: number; w: number; h: number }, style: any = {}): PptxElement {
  return {
    type: 'text',
    pos,
    text,
    style: { fontFamily: 'Yu Gothic', fontSize: 14, color: C.slate800, ...style },
  };
}

function shape(shapeType: string, pos: { x: number; y: number; w: number; h: number }, text = '', style: any = {}): PptxElement {
  return {
    type: 'shape',
    shapeType,
    pos,
    text,
    style: { fontFamily: 'Yu Gothic', fontSize: 12, ...style },
  };
}

function line(pos: { x: number; y: number; w: number; h: number }, style: any = {}): PptxElement {
  return { type: 'line', pos, style: { line: C.slate200, lineWidth: 1, ...style } };
}

function sectionName(page: number): string {
  if (page <= 10) return 'Overview';
  if (page <= 16) return 'Reliability';
  if (page <= 24) return 'Security';
  if (page <= 38) return 'Operations';
  if (page <= 45) return 'Data & Migration';
  return 'Governance';
}

function sectionColor(page: number): string {
  if (page <= 10) return C.azure;
  if (page <= 16) return C.teal;
  if (page <= 24) return C.aws;
  if (page <= 38) return C.navy;
  if (page <= 45) return C.amber;
  return C.slate700;
}

function footer(pageNum: number): PptxElement[] {
  return [
    line({ x: 0.5, y: 7.02, w: 9.0, h: 0 }, { line: C.slate200, lineWidth: 0.6 }),
    txt('勘定系システム 非機能要件定義書 | AWS基盤', { x: 0.55, y: 7.08, w: 5.4, h: 0.18 }, { fontSize: 8, color: C.slate400 }),
    txt(`p.${pageNum}`, { x: 8.7, y: 7.06, w: 0.6, h: 0.18 }, { fontSize: 9, color: C.slate600, align: 'right' }),
  ];
}

function bulletBlock(bullets: string[]): PptxElement[] {
  const baseY = 2.05;
  return bullets.flatMap((bullet, index) => {
    const y = baseY + index * 1.05;
    return [
      shape('roundRect', { x: 0.8, y: y + 0.04, w: 0.28, h: 0.28 }, '', { fill: C.aws, line: C.aws }),
      txt(bullet, { x: 1.18, y, w: 4.35, h: 0.58 }, {
        fontSize: 20,
        bold: true,
        color: C.slate800,
      }),
    ];
  });
}

function genericSlide(spec: SlideSpec, pageNum: number): PptxSlide {
  const accent = sectionColor(pageNum);
  const section = sectionName(pageNum);
  return {
    id: `slide${pageNum}.xml`,
    backgroundFill: C.white,
    elements: [
      shape('rect', { x: 0, y: 0, w: 10, h: 0.82 }, '', { fill: C.navyDark }),
      shape('rect', { x: 0, y: 0.82, w: 10, h: 0.08 }, '', { fill: accent }),
      txt(spec.title, { x: 0.62, y: 0.18, w: 6.7, h: 0.35 }, { fontSize: 24, bold: true, color: C.white }),
      shape('roundRect', { x: 7.55, y: 0.18, w: 1.8, h: 0.34 }, section, { fill: C.white, color: accent, bold: true, fontSize: 11, align: 'center', valign: 'middle' }),

      shape('roundRect', { x: 0.55, y: 1.2, w: 5.45, h: 5.45 }, '', { fill: C.slate50, line: C.cloud, lineWidth: 1.2 }),
      txt('主要要件', { x: 0.8, y: 1.48, w: 2.0, h: 0.3 }, { fontSize: 14, bold: true, color: accent }),
      ...bulletBlock(spec.bullets),

      shape('roundRect', { x: 6.22, y: 1.2, w: 3.18, h: 2.0 }, '', { fill: pageNum % 2 === 0 ? C.cloud : C.mint, line: accent, lineWidth: 1.2 }),
      txt('設計メモ', { x: 6.5, y: 1.46, w: 1.3, h: 0.24 }, { fontSize: 14, bold: true, color: accent }),
      txt(spec.note, { x: 6.5, y: 1.8, w: 2.55, h: 1.0 }, { fontSize: 14, color: C.slate700, lineSpacing: 115 }),

      shape('roundRect', { x: 6.22, y: 3.45, w: 3.18, h: 1.38 }, '', { fill: C.white, line: C.slate200, lineWidth: 1 }),
      txt('AWS前提', { x: 6.5, y: 3.7, w: 1.2, h: 0.2 }, { fontSize: 13, bold: true, color: C.aws }),
      txt('Multi-AZ / 最小権限 / 監視自動化', { x: 6.5, y: 4.02, w: 2.45, h: 0.5 }, { fontSize: 13, color: C.slate700 }),

      shape('roundRect', { x: 6.22, y: 5.08, w: 3.18, h: 1.57 }, '', { fill: C.amberLight, line: C.amber, lineWidth: 1 }),
      txt('レビュー観点', { x: 6.5, y: 5.34, w: 1.6, h: 0.22 }, { fontSize: 13, bold: true, color: C.amber }),
      txt(`開発・インフラ視点で\n実装可能性と運用性を確認`, { x: 6.5, y: 5.66, w: 2.5, h: 0.64 }, { fontSize: 13, color: C.slate700 }),

      ...footer(pageNum),
    ],
  };
}

function titleSlide(): PptxSlide {
  return {
    id: 'slide1.xml',
    backgroundFill: C.navyDark,
    elements: [
      shape('rect', { x: 0, y: 0, w: 10, h: 0.12 }, '', { fill: C.aws }),
      shape('rect', { x: 0, y: 7.38, w: 10, h: 0.12 }, '', { fill: C.azure }),
      txt('勘定系システム', { x: 0.8, y: 1.6, w: 8.4, h: 0.5 }, { fontSize: 22, bold: true, color: C.sky, align: 'center' }),
      txt('非機能要件定義書', { x: 0.8, y: 2.2, w: 8.4, h: 0.8 }, { fontSize: 36, bold: true, color: C.white, align: 'center' }),
      txt('AWS基盤 | 開発・インフラ向け | 約50ページドラフト', { x: 1.1, y: 3.25, w: 7.8, h: 0.4 }, { fontSize: 16, color: C.slate200, align: 'center' }),
      shape('roundRect', { x: 2.1, y: 4.15, w: 5.8, h: 1.42 }, '', { fill: '#12304B', line: C.azure, lineWidth: 1.2 }),
      txt('前提', { x: 2.45, y: 4.42, w: 1.0, h: 0.22 }, { fontSize: 13, bold: true, color: C.aws }),
      txt('元資料なしのため、勘定系の一般的な高信頼要件とAWS標準設計原則を基に初版を構成', { x: 2.45, y: 4.75, w: 5.0, h: 0.5 }, { fontSize: 14, color: C.white, lineSpacing: 118 }),
      txt('Generated by Kyberion', { x: 0.6, y: 6.85, w: 2.4, h: 0.2 }, { fontSize: 9, color: C.slate400 }),
      txt(new Date().toISOString().slice(0, 10), { x: 7.5, y: 6.85, w: 1.9, h: 0.2 }, { fontSize: 9, color: C.slate400, align: 'right' }),
    ],
  };
}

function buildProtocol(): PptxDesignProtocol {
  const slides = OUTLINE.map((spec, index) => (index === 0 ? titleSlide() : genericSlide(spec, index + 1)));
  return {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    canvas: { w: 10, h: 7.5 },
    theme: {
      dk1: '0B2239',
      lt1: 'FFFFFF',
      dk2: '1E293B',
      lt2: 'F1F5F9',
      accent1: '1D4ED8',
      accent2: '0F766E',
      accent3: 'FF9900',
      accent4: 'B45309',
      accent5: '183B56',
      accent6: '94A3B8',
      hlink: '1D4ED8',
      folHlink: '0F766E',
    },
    master: { elements: [] },
    slides,
  };
}

async function main() {
  const protocol = buildProtocol();
  const outputPath = pathResolver.sharedTmp('media/accounting-nfr-aws-deck.pptx');
  const outputDir = path.dirname(outputPath);
  if (!safeExistsSync(outputDir)) {
    safeMkdir(outputDir, { recursive: true });
  }
  await generateNativePptx(protocol, outputPath);
  console.log(JSON.stringify({
    outputPath,
    slides: protocol.slides.length,
    title: '勘定系システム 非機能要件定義書',
  }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
