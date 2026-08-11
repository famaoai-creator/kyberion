# mission-alignment-gate — ミッションのアラインメント承認ゲート

③アラインメントで整理したミッションブリーフを共有の `approval-store` に結び付け、既存のレビューサーフェスで人間の承認を受ける仕組み。HTML はブリーフの描画層であり、承認の正本ではない。正本は承認リクエストの決定と、リクエストに記録されたブリーフの `payloadHash` である。

## フロー

```
③アラインメント / planning
 1) 意図→測定可能ゴールを整理し mission-brief.json を作る
 2) mission_controller create で planned 状態のミッション容器を作る
 3) mission_controller plan-tasks --refresh-catalog でタスクを計画
 4) mission_alignment_request.js で brief のハッシュ付き approval-store リクエストを作る
 5) serve-brief.ts または別の承認サーフェスで表示・編集・コメント・音声入力を提供
 6) 人間の決定を共有 approval-store に保存する
 7) mission_controller gate-pass <ID> ALIGNMENT_APPROVED で厳格な command_succeeds ゲートを評価
④実行
 8) 最初のゲート通過で planned → active に遷移し、計画済みタスクを実行する
```

**承認の正本**: `approval-store` の `mission_gate` リクエストと決定、および brief のハッシュ。サーフェスは描画・入力のための renderer であり、HTML の `data-decision` やローカルファイルは正本ではない。

**作成と承認**: `mission_controller create` はブラウザから実行せず、監査可能なセッションで明示的に実行する。`create` は `planned` の容器を作るだけで、承認前に実行を始めない。既存の `start` は即時 active 化のライフサイクル操作なので、この承認フローでは使わない。最初の `ALIGNMENT_APPROVED` gate-pass がミッションを `active` にする。

## 使い方

```bash
# 1) planned 状態のミッションを作成（プロジェクトのソース変更や実行はしない）
node dist/scripts/mission_controller.js create <MISSION_ID> --persona <P> --tier <T> --project-id ... --project-path ... --track-id ... --track-type ... --lifecycle-model ...

# 2) タスク計画をカタログから確定
node dist/scripts/mission_controller.js plan-tasks <MISSION_ID> --refresh-catalog

# 3) brief と共有 approval-store のリクエストを作成
node dist/scripts/mission_alignment_request.js --mission <MISSION_ID>

# 4) canonical mission surface で配信（localhost=🎤可）
KYBERION_PERSONA=<persona> node_modules/.bin/tsx scripts/mission-alignment-gate/serve-brief.ts --mission <MISSION_ID> --port 8137
#   → http://127.0.0.1:8137/ で ✏️/💬/🎤 → ✅承認 or ✏️要修正

# 5) approval-store を正本として strict gate を評価
node dist/scripts/mission_controller.js gate-pass <MISSION_ID> ALIGNMENT_APPROVED
```

### 補助・互換コマンド

```bash
# 静的プレビュー。承認状態は作らず、ゲート判定にも使わない
node_modules/.bin/tsx scripts/mission-alignment-gate/render-brief.ts <mission-brief.json> [out.html]

# 旧静的HTMLフローの判断表示。HTML の data-decision は正本ではないため、mission gate の判定には使わない
node_modules/.bin/tsx scripts/mission-alignment-gate/read-decision.ts <out.html> <mission-brief.json>

# 任意HTMLの一般レビュー/保存。mission gate の approval-store とは別用途
KYBERION_PERSONA=<persona> node_modules/.bin/tsx scripts/report-review/server.ts <out.html> 8137
```

`serve-brief.ts` は mission gate の標準サーフェスである。新しい人間向け UI を追加する場合も、専用の承認ストアや独自決裁 API を作らず、既存の approval-store に `mission_gate` リクエストを載せる。

## mission-brief.json スキーマ（`mission-brief.example.json` 参照）

| キー                                                             | 内容                                                  |
| ---------------------------------------------------------------- | ----------------------------------------------------- |
| `missionId`                                                      | ミッションID（起動コマンドに使用）                    |
| `title` / `intent`                                               | タイトル / 意図・背景                                 |
| `persona` / `tier`                                               | 起動ペルソナ / ティア(confidential\|public\|personal) |
| `sovereignSwitch`                                                | `governance-first` \| `autonomous-yolo`               |
| `victoryConditions[]`                                            | 測定可能なゴール                                      |
| `scope.in[]` / `scope.out[]`                                     | 対象 / 対象外                                         |
| `flow[]`                                                         | `{step,title,detail,pipeline}` 実行の流れ             |
| `roles[]`                                                        | `{who,role}` 体制                                     |
| `deliverables[]`                                                 | 成果物                                                |
| `risks[]`                                                        | `{risk,level,mitigation}`                             |
| `openItems[]`                                                    | 未決事項                                              |
| `gate`                                                           | `{sudoGate,riskLevel,approvalRequired}`               |
| `estimate`                                                       | `{effort,cost}`                                       |
| `projectId`/`projectPath`/`trackId`/`trackType`/`lifecycleModel` | mission_controller create の named options            |

## 依存

- `scripts/report-review/`（レビュー/音声/描画レイヤ）を流用。決裁の書き込み口は共有 `approval-store`。
- ファイルI/Oは `@agent/core/secure-io`。confidential出力/保存には適切な `KYBERION_PERSONA`。
- ゲート定義は `humanConfirmed` の自動充足に依存せず、ハッシュと approval-store を確認する `command_succeeds` を使う。
