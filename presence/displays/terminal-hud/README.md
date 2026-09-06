# @presence/terminal-hud — Kyberion Terminal HUD

Kyberion のフルスクリーン対話型 TUI（Ink / React）。起動直後は `Operator Cockpit` が Mission・承認・成果物・次アクションを要約し、入力欄を会話の主入口にします。8 パネルは詳細確認・操作用のドリルダウンです。

## 起動

```bash
pnpm tui        # 本番 (dist から / 要 pnpm build)
pnpm tui:once   # 非対話スナップショット (CI / non-TTY)
pnpm tui:dev    # ソース実行 (@agent/core の dist は事前ビルドが必要)
```

`pnpm tui` は実 TTY では対話画面を起動し、CI・パイプ・IDE のタスク実行など TTY がない場合は自動的に snapshot を表示して正常終了します。raw mode が使えない環境でも起動エラーにはなりません。

画面上部は `KYBERION / Terminal HUD`、現在のパネル、デーモン状態を表示します。その下の `Operator Cockpit` に現在の運用状態、承認待ち、ブロック、次アクション、ローカル operator / tenant scope を表示します。中央が選択中のデータ、下部が質問・コマンド入力とショートカットです。

すべて `KYBERION_PERSONA=sovereign` で動作する（personal tier ミッションの読み取りに必要。書き込みは各公認 API 経由）。

## パネル

| キー | パネル                         | 主な操作                                                                                                              |
| ---- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------- |
| 1    | ミッション                     | s 開始 / p 一時停止 / u 再開 / c チェックポイント / V 検証 / F 完了 / X 中止（mission_controller を subprocess 実行） |
| 2    | タスク（work items）           | c 引き受け / x 解放 / s 状態変更（work-coordination API 直呼び。解放は HUD 保持リースのみ）                           |
| 3    | スケジュール                   | e on/off / R 今すぐ実行 / x 削除（実行は run_pipeline.js を managed process で分離起動）                              |
| 4    | プロセス（surfaces + daemons） | s 起動 / x 停止 / R repair（surface_runtime.js を worker persona で実行）                                             |
| 5    | エージェント連携               | R ランタイム再起動 / X 停止 / E supervisor daemon 起動（daemon は heartbeat が healthy の時のみ IPC、自動起動しない） |
| 6    | 統計                           | metrics 履歴・trace tail・リソース使用・退行検出（表示のみ）                                                          |
| 7    | プロフィール                   | operator / onboarding / NHI identities / 組織（read-only）                                                            |
| 8    | 設定                           | 推論バックエンド・顧客・ロケール（L でセッション内切替。永続変更は CLI 誘導）                                         |

グローバル: `[` `]` / Tab 巡回, `Enter` 詳細, `j/k` 移動, `r` 再読込, `?` ヘルプ, `q` 終了。

## 入力欄

- 起動時は入力欄にフォーカス済みです。自由文は `runSurfaceMessageConversation`（cli surface / channel `terminal-hud`）経由で推論バックエンドへ。`Esc` でパネル操作に戻り、`i` / `/` で再フォーカスできます。
- 入力中は全 surface 共通の Intent Resolution Contract のプレビュー（意図、実行形状、成果形状、権限境界、不足情報）を表示します。送信後も同じ gateway 結果を保持し、プレビューは実行経路の承認・ADF・mission gate を置き換えません。
- `:` でコマンドパレット（whitelist 動詞のみ、任意シェル不可）: `:panel` `:mission` `:task` `:schedule` `:surface`。
- 入力欄フォーカス中は `Ctrl+V`、パネル操作中は `v` で push-to-talk 音声入力: mic-capture（ffmpeg/arecord）→ STT ブリッジ → 入力欄へ転記（自動送信しない）。STT/mic 不在時は理由を表示して劣化。

## 設計上の制約

- ファイル I/O は `@agent/core/secure-io` のみ（eslint 強制）。
- ミッション変更は mission_controller subprocess、surface は surface_runtime subprocess、work item / schedule は公認関数、runtime は supervisor IPC。
- 全書き込みアクションは auditChain に記録（`KYBERION_TUI_DISABLE_AUDIT=1` はテスト専用）。
- データ更新は chokidar watch + interval フォールバック、JSONL は byte-cap 付き bounded tail。
- ミッション/サーフェス操作の subprocess は同期実行のため、完了まで UI がブロックされる（数秒程度）。

## テスト

```bash
pnpm test -- --suite tui
```

hermetic: work-coordination は namespace 分離、exec は注入スタブ、mic は fixture command 再生、STT はテストブリッジ登録。
