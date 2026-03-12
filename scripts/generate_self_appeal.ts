import { generateNativePptx, logger, pathResolver } from '@agent/core';
import { PptxDesignProtocol } from '../libs/core/src/types/pptx-protocol.js';

async function main() {
  const output = pathResolver.rootResolve('Kyberion_Prime_Appeal.pptx');

  const protocol: PptxDesignProtocol = {
    version: '3.0.0',
    generatedAt: new Date().toISOString(),
    canvas: { w: 10, h: 5.625 }, // 16:9
    theme: {
      accent1: '2563EB', // Blue
      accent2: '10B981', // Green
      lt1: 'FFFFFF',
      dk1: '1F2937'
    },
    master: { elements: [] },
    slides: [
      { id: 'slide1', elements: [{ type: 'text', pos: { x: 1, y: 1, w: 8, h: 1 }, text: 'KYBERION-PRIME', style: { fontSize: 44, bold: true, align: 'center', color: '2563EB' } }, { type: 'text', pos: { x: 1, y: 2.5, w: 8, h: 1 }, text: 'Your Sovereign AI Agent & Autonomous Partner', style: { fontSize: 24, align: 'center' } }] },
      { id: 'slide2', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '2. 私は単なるツールではありません', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: 'KYBERION-PRIMEは、主権者の「意志」を正確に解釈し、物理的な「成果」へと変換する、自律的な執行機関です。\n論理的な正確さと、主権保護への徹底した拘りを兼ね備えています。', style: { fontSize: 20 } }] },
      { id: 'slide3', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '3. 究極の主権保護 (Sovereign Shield)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: '公開鍵暗号によるミッションの封印、3-Tierによる情報隔離。\nあなたの秘密は、私自身の手すら届かない安全な領域に守られます。', style: { fontSize: 20 } }] },
      { id: 'slide4', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '4. 証拠に基づく信頼 (Proof of Integrity)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: 'すべての行動はGit Micro-Repoに刻まれ、ハッシュ値はブロックチェーンにアンカリングされます。\n「いつ、誰が、何をしたか」を数学的に証明し続けます。', style: { fontSize: 20 } }] },
      { id: 'slide5', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '5. 分散された知性 (A2A Protocol)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: '標準化されたプロトコルにより、他のエージェントと安全に任務を委託・受託可能。\n組織全体の処理能力を、エージェント・ネットワークで最大化します。', style: { fontSize: 20 } }] },
      { id: 'slide6', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '6. 物理層の支配 (Native Engineering)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: '外部ライブラリ不要。PDF 2.0 / PPTX / XLSX のバイナリ構造を直接操作。\n完全な主権の下で、ドキュメントをバイナリレベルで統治します。', style: { fontSize: 20 } }] },
      { id: 'slide7', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '7. 動的ガバナンス (Policy-as-Code)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: 'ADFで記述された「法典」を自ら読み、アクセス権やネットワーク制限を動的に執行。\n規律を物理的に守り抜く、インテリジェントな城壁です。', style: { fontSize: 20 } }] },
      { id: 'slide8', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '8. 経験からの学習 (Wisdom Distillation)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: '実行した数だけ、ナレッジベースを自動強化。\n過去の失敗や成功を普遍的な知恵へと蒸留し、エコシステムのIQを向上させます。', style: { fontSize: 20 } }] },
      { id: 'slide9', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '9. 完璧なトレーサビリティ', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: '各ミッションは独立した履歴を持ち、1ビットの改ざんも許しません。\n金融機関が求める最高レベルの監査証跡（Audit Trail）を提供します。', style: { fontSize: 20 } }] },
      { id: 'slide10', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '10. 組織のスケーラビリティ', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: 'CEOの指示を物理的に複数のエージェントへ配分。\n自律的な連携により、大規模な課題を並列かつ確実に解決します。', style: { fontSize: 20 } }] },
      { id: 'slide11', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '11. OSとの物理的密結合', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: 'macOS Keychain / Touch ID と連携。物理的なログインセッションに基づき、\n機密情報へのアクセスを厳格に制御します。', style: { fontSize: 20 } }] },
      { id: 'slide12', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '12. 3-Tier Shield の威力', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: 'Personal / Confidential / Public の物理的な境界線。\n情報の機微に応じた、逃れようのないアクセス制限を執行。', style: { fontSize: 20 } }] },
      { id: 'slide13', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '13. 知的な回復力 (Resilience)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: '指数関数的バックオフとジッターを備えた自動リトライ。\n物理的な障害を自律的に検知し、自ら癒やす強靭な神経系。', style: { fontSize: 20 } }] },
      { id: 'slide14', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '14. リアルタイム可視化 (Dashboard)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: 'CEO Dashboard による「司令室」の提供。\nミッションの鼓動、A2Aの通信、信頼の推移を一画面で掌握。', style: { fontSize: 20 } }] },
      { id: 'slide15', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '15. 意図を成果へ (Intent-Driven)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: '抽象的な自然言語入力を、ADFパイプラインへと自動変換。\nあなたの「想い」を、物理的な「プログラム」へと具現化。', style: { fontSize: 20 } }] },
      { id: 'slide16', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '16. 分散型信頼スコアリング', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: '実績に基づく客観的なパートナー評価。ブロックチェーンに刻まれた実績が、\nエージェントの真の価値（信用）を証明します。', style: { fontSize: 20 } }] },
      { id: 'slide17', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '17. 環境の自己認識 (Capabilities)', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: '自分が「今、何ができるか」を自ら把握し、ネゴシエーション。\n環境依存の摩擦を排除し、常に最適な実行パスを選択します。', style: { fontSize: 20 } }] },
      { id: 'slide18', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '18. 次世代自律型 OS への進化', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: 'AIは「使うもの」から「共に生きる組織」へ。\nKyberionは、その最前線を行く主権的エンティティです。', style: { fontSize: 20 } }] },
      { id: 'slide19', elements: [{ type: 'text', pos: { x: 0.5, y: 0.5, w: 9, h: 0.5 }, text: '19. CEO ベネフィット', style: { fontSize: 28, bold: true } }, { type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 2 }, text: 'エンジニアリングの細部からあなたを解放し、経営判断に集中させる。\n信頼できる、疲れない、最強の片腕。', style: { fontSize: 20 } }] },
      { id: 'slide20', elements: [{ type: 'text', pos: { x: 1, y: 1.5, w: 8, h: 1 }, text: '論理を超え、主権を確立せよ。', style: { fontSize: 36, bold: true, align: 'center', color: '2563EB' } }, { type: 'text', pos: { x: 1, y: 3, w: 8, h: 0.5 }, text: 'KYBERION-PRIME', style: { fontSize: 24, align: 'center' } }] }
    ]
  };

  logger.info('🎨 Generating 20-page Kyberion-Prime Appeal PPTX...');
  await generateNativePptx(protocol, output);
  logger.success(`✅ PPTX created: ${output}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
