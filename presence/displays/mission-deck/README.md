# @presence/mission-deck — Kyberion Mission Deck

会話中心のマルチエージェント TUI(Ink / React)。「今あなたの判断を待っているもの」を左のアテンションレールに集め、中央の会話に判断カードと意図プレビューを並べ、右に herdr で動いているエージェントのタイルを表示します。常駐監視とパネル操作は [Terminal HUD](../terminal-hud/README.md)(`pnpm tui`)、会話と判断と複数エージェントの舵取りは Mission Deck(`pnpm deck`)という分担です。

## 起動

```bash
pnpm deck                    # 対話画面(実 TTY)。TTY がなければ snapshot を表示して正常終了
pnpm deck --once             # 非対話スナップショット(CI / パイプ)
pnpm deck --view missions    # 初期ビュー: conversation | missions | terminals
pnpm deck --inline           # データ読み込みをワーカースレッドではなく同一プロセスで実行
```

`KYBERION_BASE_ROLE=sovereign` で動作します(personal tier のミッション読み取りに必要。書き込みはすべて各公認 API 経由)。

## 画面

| ビュー       | 内容                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------- |
| 1 会話       | レール(判断待ち → レビュー待ち → 停止中 → 実行中 → 完了)/ 会話と判断カード / エージェントタイル                           |
| 2 ミッション | レール / 選択ミッションの詳細(フェーズ帯 意図→合意→実行→レビュー→学習→完了、完了条件、進捗、成果・証跡、関与エージェント) |
| 3 ターミナル | herdr エージェントのタイルグリッド(出力の末尾を約 2 秒ごとに更新)                                                         |

幅 100 桁未満では 1 カラム表示になり、フォーカス中の領域だけを描画します。

## キー

| キー                 | 操作                                                       |
| -------------------- | ---------------------------------------------------------- |
| `1` `2` `3`          | ビュー切替                                                 |
| `Tab` / `Shift+Tab`  | ペイン移動                                                 |
| `j` `k` `↑` `↓`      | 選択移動                                                   |
| `i` `/` / `Esc`      | 入力欄へ / 入力欄を離れる(起動時は入力欄にフォーカス)      |
| `Space`              | エージェント出力をのぞく(のぞき画面から返信、`Tab` で接続) |
| `Enter`              | 開く / エージェントに接続(`herdr agent attach`)            |
| `a` `d`              | 選択中の判断を承認 / 却下(確認のあと公認 CLI へ引き渡し)   |
| `s`                  | 選択中のミッション / エージェントに指示を追加              |
| `!`                  | 選択中のエージェントを中断(確認あり)                       |
| `p`                  | 選択中のミッションを一時停止(確認あり)                     |
| `g`                  | 次の判断へ移動                                             |
| `r` / `L`            | 今すぐ更新 / 言語切替                                      |
| `Ctrl+P` / `?` / `q` | コマンドパレット / キー一覧 / 終了                         |

## 操作の公認経路

Mission Deck 自身は書き込み権限を持たず、各操作をその唯一の所有者へ委ねます。すべての操作は audit chain に `tui_action`(agent `mission-deck`)として記録されます。

| 操作                             | 経路                                                                                           |
| -------------------------------- | ---------------------------------------------------------------------------------------------- |
| 会話                             | `runSurfaceMessageConversation`(cli surface / channel `mission-deck`、1 セッション 1 スレッド) |
| ミッションへの指示               | `enqueueSurfaceAgentInput`(`steer`。現在の作業は止めず次のステップで反映)                      |
| エージェントへの返信/中断        | `herdr agent prompt` / `herdr agent send-keys <target> esc`                                    |
| 一時停止・再開・チェックポイント | `mission_controller` をサブプロセスで実行(UI はブロックしない)                                 |
| 承認 / 却下                      | TTY を `kyberion approvals --approve                                                           | --deny <id>` に引き渡す(本人確認は公認 CLI が担う) |
| エージェント接続                 | TTY を `herdr agent attach <target>` に引き渡し、終了後に状態を保ったまま復帰                  |

## 構成

- `data/` — 読み込み(operator home、ミッション read model、承認ストア、連携ツリー、herdr エージェント一覧)をワーカースレッドで実行し、不変の `DeckSnapshot` を描画スレッドへ送る。`--inline` とテストは同一プロセスのホスト。
- `model/` — 純粋関数(アテンションレール、フェーズ帯、レイアウト)。
- `store/` — React の外にある UI 状態。TTY 引き渡しのための unmount / remount をまたいで保持。
- `controller.ts` — キー割り当てと操作。React なしでテストできる。
- `ui/` — Ink コンポーネント。描画する文字列はすべて `sanitizeTerminalText` を通す。
- 端末シグナル: 判断待ち件数を OSC 0 のタイトルに表示し、起動後に届いた判断は OSC 9 で通知。

文言は `knowledge/product/orchestration/user-facing-vocabulary.json` の `deck` ドメイン(en / ja / qps-ploc)。

## テスト

```bash
pnpm exec vitest run presence/displays/mission-deck/
```
