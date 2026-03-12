import { generateNativePdf, logger, pathResolver } from '@agent/core';
import { PdfDesignProtocol } from '../libs/core/src/types/pdf-protocol.js';

async function main() {
  const output = pathResolver.rootResolve('Kyberion_Sovereign_OS.pdf');

  const protocol: PdfDesignProtocol = {
    version: '4.0.0',
    generatedAt: new Date().toISOString(),
    source: {
      format: 'markdown' as any,
      title: 'Kyberion: The Sovereign Operating Ecosystem',
      body: 'Presentation Content'
    },
    metadata: {
      title: 'Kyberion: The Sovereign Operating Ecosystem',
      author: 'KYBERION-PRIME',
      producer: 'Kyberion Native PDF 2.0 Engine'
    },
    content: {
      text: 'Kyberion Presentation',
      pages: [
        { pageNumber: 1, width: 842, height: 595, text: "1. Kyberion Sovereign Ecosystem\n\n主権者の意志を具現化する、次世代の自律型OS。\n論理を尽くし、意志で決断し、エンジニアリングの摩擦をゼロにする。" },
        { pageNumber: 2, width: 842, height: 595, text: "2. Vision: 北極星の指針\n\n「論理は衛生要因。ビジョンはコンパス。」\n金融ソフトウェア開発のリーダーとしての意志を、システムの全神経系に注入。" },
        { pageNumber: 3, width: 842, height: 595, text: "3. The Problem: ブラックボックスのAI\n\n従来のAIエージェントは、何をしたかの証拠が残らず、\n機密情報の扱いが不透明で、統治が困難であった。" },
        { pageNumber: 4, width: 842, height: 595, text: "4. The Solution: 主権型OSの誕生\n\nKyberionは、実行履歴、ナレッジ、通信のすべてを\n物理的な規律（ADFとGit）で統治する自律的なパートナーである。" },
        { pageNumber: 5, width: 842, height: 595, text: "5. Core Principle: 憲章（AGENTS.md）\n\nすべての行動は憲章によって定義される。\n物理的整合性の維持、再発明の禁止、主権者第一主義。" },
        { pageNumber: 6, width: 842, height: 595, text: "6. 3-Tier Model: 物理的隔離\n\n- Personal: 主権者の魂（秘密鍵、ビジョン）\n- Confidential: 組織の機密（ビジネスロジック）\n- Public: 共通プロトコルと共有の知恵" },
        { pageNumber: 7, width: 842, height: 595, text: "7. Mission Control: KSMC v2.0\n\nすべての変更は「任務（Mission）」として管理される。\n独立したMicro-Gitリポジトリにより、改ざん不能な全履歴を保持。" },
        { pageNumber: 8, width: 842, height: 595, text: "8. The Soul: アイデンティティの注入\n\nオンボーディング時に主権者の役割とドメインを学習。\nエージェント自身も「KYBERION-PRIME」として名を授かる。" },
        { pageNumber: 9, width: 842, height: 595, text: "9. A2A Protocol: エージェント間協調\n\nADF Envelopeを用いた標準化された通信。\n他者への任務委託（Delegate）と、成果の安全な統合（Import）。" },
        { pageNumber: 10, width: 842, height: 595, text: "10. Dynamic Trust: 動的信頼スコア\n\n検証結果、遅延、精度に基づくエージェントの自動評価。\n信頼不足の相手には機密アクセスを自動遮断するガードレール。" },
        { pageNumber: 11, width: 842, height: 595, text: "11. Sovereign Seal: 主権的封印\n\n任務完了時にAES-256 + RSAハイブリッド暗号でアーカイブ。\n秘密鍵がなければ、プロセスの詳細は主権者以外には閲覧不能。" },
        { pageNumber: 12, width: 842, height: 595, text: "12. Blockchain Anchor: 不変の刻印\n\nミッションのハッシュ値をブロックチェーンへアンカリング。\n数学的に「その時点での真実」を固定し、永遠に証明可能にする。" },
        { pageNumber: 13, width: 842, height: 595, text: "13. OS Integration: Keychainの守護\n\nRSA秘密鍵のパスフレーズをmacOS Keychainで管理。\n生体認証やOSログインなしでは、封印を解くことは物理的に不可能。" },
        { pageNumber: 14, width: 842, height: 595, text: "14. Capability Discovery: 環境の自己認識\n\n各アクチュエータが能力を自己申告。\nOSやツールの有無を実行前に自動ネゴシエーションし、摩擦を回避。" },
        { pageNumber: 15, width: 842, height: 595, text: "15. Mission Scheduler: 時間の統治\n\n優先順位と依存関係（Prerequisites）に基づく待機キュー。\n最適な順序でミッションを自動ディスパッチする自律エンジン。" },
        { pageNumber: 16, width: 842, height: 595, text: "16. Observability: CEO Dashboard\n\nTUIベースの司令室。アクティブな任務、A2Aの動き、\n信頼スコアの変動をリアルタイムに一画面で俯瞰。" },
        { pageNumber: 17, width: 842, height: 595, text: "17. Resilience: 知的な回復力\n\n指数関数的バックオフとジッターを備えた自動リトライ。\n物理的なつまずきを自律的に乗り越える、強靭な神経系。" },
        { pageNumber: 18, width: 842, height: 595, text: "18. Knowledge Syndication: 知の連邦\n\n知恵を検証可能なパッケージ（KKP）としてエクスポート。\n他者からの知見を安全に検証し、組織知として動的に取り込む。" },
        { pageNumber: 19, width: 842, height: 595, text: "19. Native Engineering: 自前バイナリ操作\n\n外部ライブラリに頼らず、PDF / PPTX / XLSX を生成・解析。\n完全な主権の下で、ドキュメントをバイナリレベルで支配。" },
        { pageNumber: 20, width: 842, height: 595, text: "20. Conclusion: 統治の未来\n\nKyberionは、単なる道具ではない。\n主権者の意志を守り、進化し続けるデジタル・エンティティである。" }
      ]
    }
  };

  logger.info('🎨 Generating 20-page Kyberion Presentation PDF...');
  await generateNativePdf(protocol, output);
  logger.success(`✅ Presentation created: ${output}`);
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
