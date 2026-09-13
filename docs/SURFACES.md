# Surfaces — 入口の地図

Kyberion の操作系サーフェスの役割マップ。**各サーフェスは1つの役割**を持ち、画面ヘッダに役割バッジを表示する(定義の正: [`knowledge/product/governance/surface-roles.json`](../knowledge/product/governance/surface-roles.json))。

## 5つのUIサーフェス

| サーフェス            | 役割                                                                                                                                                                                           | 答える問い                                     | port | 書き込み                                       | 起動                                                                        |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- | ---- | ---------------------------------------------- | --------------------------------------------------------------------------- |
| **concierge(秘書室)** | **CEO秘書** — 依頼・承認・成果・例外(+ `/setup` オンボーディング/拡張設定)                                                                                                                     | 「私は今なにを判断すればよいか」               | 3050 | scoped(依頼・承認・受領・取込・プラグイン承認) | `active-surfaces.json`(`pnpm surfaces reconcile`)                           |
| **presence-studio**   | **相棒** — いっしょに作業するワークベンチ(音声・議事録・メール・クイックアクション)                                                                                                            | 「いま一緒に何を進めるか」                     | 3031 | 実作業                                         | `active-surfaces.json`                                                      |
| **chronos-mirror-v2** | **管制塔** — 監視と介入(プラン→起動、承認、成果物レビュー、**組織運営モデル+6つの可視化スコープ(organization / home / work_items / operations / missions / governance)による work item 投影**) | 「システムは何をしていて、どこに介入すべきか」 | 3000 | 介入                                           | `pnpm chronos:dev` / `active-surfaces.json`                                 |
| **operator-surface**  | **監査モニタ**(読み取り専用: ミッション・監査チェーン・ヘルス)                                                                                                                                 | 「何が起きたかを証跡で確認したい」             | 3331 | なし(inbox既読化のみ例外)                      | `pnpm --dir presence/displays/operator-surface dev`(意図的にマニフェスト外) |
| **computer-surface**  | **作業の手元ミラー** — ブラウザ/ターミナルのいまの手元を映す                                                                                                                                   | 「Kyberion はいま手元で何をしているか」        | 3040 | なし                                           | `active-surfaces.json`                                                      |

> **アクセス制御**: 各 headless surface は server-side viewer principal を解決し、共通の operation permission と tenant / organization / project / tier scope を評価する。`tenant` query は許可集合を狭めるだけで、権限を拡大しない。Chronos の `KYBERION_VIEWER_SCOPE=off|warn|enforce` は移行時の監査モード名を保持するが、未認可 tenant の要求は全モードで拒否する(`warn` は audit を先に記録する)。既定値は `warn`。実装計画は [`SURFACE_SCOPED_RBAC_AUTHORIZATION_PLAN_2026-08-24.ja.md`](./developer/improvement-plans-2026-08/SURFACE_SCOPED_RBAC_AUTHORIZATION_PLAN_2026-08-24.ja.md)。これは OSS / self-hosted の内部認可であり、SaaS の hosted account management ではない。運用手順: [`docs/developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md`](./developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md)。

Computer Surface の `/api/identity`・`/api/state`・`/api/stream`・`/api/os/control-plane` は read operation、`/a2ui/dispatch` は localadmin の write operation とする。remote bearer access は `KYBERION_TENANT` に server-side bind し、内部 A2UI relay は `KYBERION_LOCALADMIN_TOKEN` を使用する。

## 会話チャネル(UI以外)

| 入口                                  | 役割                                                                                                                                                                                                                                                                      | 備考                                                                                                                                                                                                                                          |
| ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Slack / Telegram / Discord / iMessage | 会話・承認・通知(`runSurfaceMessageConversation` 経由)                                                                                                                                                                                                                    | Slack の3経路(会話 / 配信 / API)は [SLACK_CHANNEL_ROUTES.ja.md](./SLACK_CHANNEL_ROUTES.ja.md)。`presence:dispatch` の非 Slack 配信は `telegram:` / `discord:` / `imessage:` prefix で同じ satellite outbox へ forward。深い履歴閲覧には不向き |
| Voice(voice-hub / presence-studio)    | ハンズフリー会話・口述                                                                                                                                                                                                                                                    | 一括レビューには不向き                                                                                                                                                                                                                        |
| **`pnpm kyberion`**                   | **ターミナルの統合ホーム**: 状態ダイジェスト+次の一手。`ask "<依頼>"`(ブリッジと同じ脳)、`inbox`(既読/受領)、`approvals`(承認/却下)、`notify`(通知先設定) が同居                                                                                                          | 迷ったらまずこれ                                                                                                                                                                                                                              |
| **`pnpm tui`**(terminal-hud)          | **ターミナル常駐 HUD**(Ink TUI): ミッション・work item・ランタイムをパネルで監視/操作、パネル 9「連携」で mission→task→agent→child agent の連携ツリーと待ち関係(承認待ち/子の完了待ち/クレーム待ち/ブロック)を表示([README](../presence/displays/terminal-hud/README.md)) | 常駐監視向け                                                                                                                                                                                                                                  |
| `pnpm kyberion`                       | スクリプト向けCLI                                                                                                                                                                                                                                                         | 統合ホームではない                                                                                                                                                                                                                            |
| MCP(mcp-server-cowork)                | Claude 連携のコンシェルジェ(persona: sovereign_concierge)。読み取りは `kyberion.capability.list` / `kyberion.service.capture` / allowlist pipeline。書き込みは `kyberion.service.actuate`(承認・既定オフ)                                                                 | `pnpm mcp:server`                                                                                                                                                                                                                             |

## 会議・議事録

| 入口                                                    | 役割                                                                                                          |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `pnpm minutes:record --mission <ID>`                    | マイク録音 → 文字起こし → 議事録(`meeting-followup` パイプライン)。presence-studio の「会議を記録」と同じ基盤 |
| `pnpm meeting:participate --driver in-room`             | **同席モード**: ブラウザを使わず、その場の会議にマイク/スピーカーで出席                                       |
| `pnpm meeting:participate`(既定 **browser-playwright**) | Meet/Zoom/Teams への**日常パス**。Playwright でブラウザ出席する。`meeting-browser-driver` が実装済みドライバ  |

**未実装シーム / deferred product (P2-4 docs-only):** `zoom-sdk` と `recall-ai` はドライバレジストリの名前だけ。実装しない。日常は browser-playwright。シームを埋めるな。

## ローカル pad(127.0.0.1 限定・取り込み専用)

手元にあるもの(図・会議メモ・スクリーンショット・ファイル・クリップボード・今日の TODO)を取り込み、session フォルダ + `handoff.json` を書き出して Kyberion に渡す小さなローカルページ群。外部リソース読込ゼロ、ファイル I/O は `secure-io` 経由、mission の自動起動や送信は行わない。スクリーンショット付きの一覧は [README の Local Pads](../README.md#local-pads--capture-at-your-desk-hand-off-to-kyberion)、索引は [`scripts/personal-pads/README.md`](../scripts/personal-pads/README.md)。

| pad                                                    | port | 取り込むもの → 出力                                                                                      |
| ------------------------------------------------------ | ---: | -------------------------------------------------------------------------------------------------------- |
| [report-review](../scripts/report-review/)             | 8137 | 任意の自己完結 HTML レポート → 編集・コメント・音声入力・直書き保存                                      |
| [sketch-input](../scripts/sketch-input/)               | 8147 | 描画ボード → PNG + handoff                                                                               |
| [meeting-notepad](../scripts/meeting-notepad/)         | 8148 | メモ・口述・録音・添付 → 議事録 + handoff                                                                |
| [memory-capture](../scripts/memory-capture/)           | 8149 | ブレインダンプ・タグ → 作業記憶 handoff                                                                  |
| [screenshot-annotate](../scripts/screenshot-annotate/) | 8150 | 画像の貼り付け/ドロップ + 注釈 → PNG + handoff(vision 向け)                                              |
| [clipboard-inbox](../scripts/clipboard-inbox/)         | 8151 | クリップボード断片 → inbox handoff                                                                       |
| [daily-desk](../scripts/daily-desk/)                   | 8152 | Journal / TODO / NOW → daily-desk handoff                                                                |
| [doc-drop](../scripts/doc-drop/)                       | 8153 | pdf / 画像 / txt / md / docx のドロップ → ingest handoff                                                 |
| [personal-workbench](../scripts/personal-workbench/)   | 8154 | Link / Task / Follow-up / Decision / Expense / Daily Review の提案 inbox(governed OCR・メール下書きのみ) |

起動は共通: `KYBERION_PERSONA=sovereign KYBERION_TENANT=<slug> node_modules/.bin/tsx scripts/<pad>/server.ts [--tier …] [port]`。`confidential` / `personal` tier は server-side `KYBERION_TENANT` が必須。書き込み API は起動時に表示されるローカルトークンを要求するが、これは人間承認の代替ではない。

Related guidance:

- [`docs/EMAIL_OPERATOR.ja.md`](./EMAIL_OPERATOR.ja.md) — inbox/triage is Gmail/gws (`pnpm kyberion email`); `email-actuator` is delivery-only
- [`docs/OPERATOR_UX_GUIDE.md`](./OPERATOR_UX_GUIDE.md)
- [`knowledge/product/architecture/surface-responsibility-model.md`](../knowledge/product/architecture/surface-responsibility-model.md)
- [`knowledge/product/architecture/ceo-ux.md`](../knowledge/product/architecture/ceo-ux.md)
- [`knowledge/product/architecture/multi-tenant-operations.md`](../knowledge/product/architecture/multi-tenant-operations.md)
- [`docs/developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md`](./developer/CHRONOS_VIEWER_SCOPE_OPERATIONS.ja.md)
- [`docs/developer/CLOUD_AGENT_ENVIRONMENT.md`](./developer/CLOUD_AGENT_ENVIRONMENT.md) — Cloud Agent VM: Node `>=24` and `pnpm build` before pipeline / MCP / doctor
