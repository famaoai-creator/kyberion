# Surfaces — 入口の地図

Kyberion の操作系サーフェスの役割マップ。**各サーフェスは1つの役割**を持ち、画面ヘッダに役割バッジを表示する(定義の正: [`knowledge/product/governance/surface-roles.json`](../knowledge/product/governance/surface-roles.json))。

## 5つのUIサーフェス

| サーフェス            | 役割                                                                                                  | 答える問い                                     | port | 書き込み                  | 起動                                                                        |
| --------------------- | ----------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---- | ------------------------- | --------------------------------------------------------------------------- |
| **concierge(秘書室)** | **CEO秘書** — 依頼・承認・成果・例外(+ `/setup` オンボーディング/拡張設定)                            | 「私は今なにを判断すればよいか」               | 3050 | 承認/受領のみ             | `active-surfaces.json`(`pnpm surfaces:reconcile`)                           |
| **presence-studio**   | **相棒** — いっしょに作業するワークベンチ(音声・議事録・メール・クイックアクション)                   | 「いま一緒に何を進めるか」                     | 3031 | 実作業                    | `active-surfaces.json`                                                      |
| **chronos-mirror-v2** | **管制塔** — 監視と介入(プラン→起動、承認、成果物レビュー、**エージェント活動ボード+work item 看板**) | 「システムは何をしていて、どこに介入すべきか」 | 3000 | 介入                      | `pnpm chronos:dev` / `active-surfaces.json`                                 |
| **operator-surface**  | **監査モニタ**(読み取り専用: ミッション・監査チェーン・ヘルス)                                        | 「何が起きたかを証跡で確認したい」             | 3331 | なし(inbox既読化のみ例外) | `pnpm --dir presence/displays/operator-surface dev`(意図的にマニフェスト外) |
| **computer-surface**  | **作業の手元ミラー** — ブラウザ/ターミナルのいまの手元を映す                                          | 「Kyberion はいま手元で何をしているか」        | 3040 | なし                      | `active-surfaces.json`                                                      |

## 会話チャネル(UI以外)

| 入口                                  | 役割                                                                                                                                                             | 備考                   |
| ------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------- |
| Slack / Telegram / Discord / iMessage | 会話・承認・通知(`runSurfaceMessageConversation` 経由)                                                                                                           | 深い履歴閲覧には不向き |
| Voice(voice-hub / presence-studio)    | ハンズフリー会話・口述                                                                                                                                           | 一括レビューには不向き |
| **`pnpm kyberion`**                   | **ターミナルの統合ホーム**: 状態ダイジェスト+次の一手。`ask "<依頼>"`(ブリッジと同じ脳)、`inbox`(既読/受領)、`approvals`(承認/却下)、`notify`(通知先設定) が同居 | 迷ったらまずこれ       |
| `pnpm cli`                            | スクリプト向けCLI                                                                                                                                                | 統合ホームではない     |
| MCP(mcp-server-cowork)                | Claude 連携のコンシェルジェ(persona: sovereign_concierge)                                                                                                        |                        |

## 会議・議事録

| 入口                                                | 役割                                                                                                          |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm minutes:record --mission <ID>`                | マイク録音 → 文字起こし → 議事録(`meeting-followup` パイプライン)。presence-studio の「会議を記録」と同じ基盤 |
| `pnpm meeting:participate --driver in-room`         | **同席モード**: ブラウザを使わず、その場の会議にマイク/スピーカーで出席                                       |
| `pnpm meeting:participate`(既定 browser-playwright) | Meet/Zoom/Teams へのブラウザ経由出席                                                                          |

将来ドライバ(未実装・シームのみ): `zoom-sdk`、`recall-ai`。

Related guidance:

- [`docs/OPERATOR_UX_GUIDE.md`](./OPERATOR_UX_GUIDE.md)
- [`knowledge/product/architecture/surface-responsibility-model.md`](../knowledge/product/architecture/surface-responsibility-model.md)
- [`knowledge/product/architecture/ceo-ux.md`](../knowledge/product/architecture/ceo-ux.md)
