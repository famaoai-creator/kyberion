# SU-02: ライブミッション監視と実行中介入

> 優先度: P1 / 規模: M / 依存: MO-02(ゲート)、AA-04(会話/介入の伝達)、UX-02(進捗) / 関連: CHRONOS_A2UI_SPEC の `kb-intervention-panel`/`kb-status-orbit`
>
> **なぜ重要か**: 「暴走したエージェントを止める・止まっている質問に答える・軌道修正する」はオペレータの中核ジョブ。現状これができず、意図された介入 UI が**描画されるが配線されていない**(死んでいる)。

## 背景と課題

- **mission_control に介入操作が無い**: 提供されるのは `resume/refresh_team/prewarm_team/staff_team/finish` のみ(`api/intelligence/route.ts:2028`)。**pause も cancel/abort も「エージェントの質問に答える」も無い**。
- **意図された介入パネルが inert**: A2UI 仕様は `kb-intervention-panel`(options + isBlocking で操作者に入力/承認を促す、`CHRONOS_A2UI_SPEC.md:73-78`)を定義するが、実装 `KbInterventionPanel` は option ボタンに **onClick/ハンドラが無く純粋に装飾**(`A2UIComponentLibrary.tsx:486-509`)。`kb-status-orbit`(intent→plan→state→result のライフサイクル可視化)もミッションに使われず、`MissionIntelligence` が独自のテキストを手組み(`:2675-2692`)。
- **ライブ監視が薄い**: ミッションの生きた状態は 10 秒ポーリングのボード件数 + メッセージスレッドのみ(`MissionIntelligence.tsx:1126-1235`)。

## ゴール(受入条件)

1. 単一ミッションの**ライブビュー**が、現在フェーズ・実行中タスク・進捗・直近イベントを(UX-02 の進捗基盤 + SSE で)リアルタイム表示する。`kb-status-orbit` を実データに配線。
2. **実行中介入操作**: pause(新規 dispatch 停止)、cancel/abort(承認付き)、そして**エージェントの blocking 質問へのインライン回答**(`kb-intervention-panel` を配線)。
3. 介入がバックエンドに伝わる: pause/cancel は MO の worker に、質問回答は AA-04 の会話/needs 経路に接続。
4. 介入は監査記録され、SA-05 の kill-switch(isolate)とも連携。

## 実装タスク

### Task 1: mission_control への介入操作追加 — `claude-sonnet-4`

1. `api/intelligence/route.ts` の `mission_control`(`:2028`)に `pause`/`cancel` を追加。pause は worker の dispatch を停止(MO-03 の並列ディスパッチャに停止フラグ)、cancel は承認必須(SA-05)+ 実行中タスクの安全な打ち切り(AA-01 の crash/timeout 経路を流用)。
2. mission state に paused/cancelled を反映し、resume(既存)で再開。
3. テスト: pause → dispatch 停止、resume → 再開、cancel → 承認後に停止。

### Task 2: kb-intervention-panel の配線 — `claude-sonnet-4`

1. `KbInterventionPanel`(`A2UIComponentLibrary.tsx:486-509`)の option ボタンに onClick を実装し、選択を `api/intelligence` の新 op(`intervention_respond`)へ送る。
2. エージェントが blocking 質問(AA-04 の `needs`、question-resolver の OIP)を出したとき、それを intervention panel として提示し、回答を会話/needs 解決経路(AA-04 Task 3)へ戻す。isBlocking の semantics(回答まで当該タスクを待機)を実装。
3. テスト: blocking 質問 → パネル表示 → 回答 → タスク継続。

### Task 3: ライブビューと kb-status-orbit — `claude-sonnet-4`

1. 単一ミッションのライブビューを FocusedOperatorView に追加(または既存を拡張): 現在フェーズ(MO-01 のプロセステンプレート)・実行中タスク・進捗(UX-02)・直近イベント(AA-05 の mission flow)を SSE で更新。
2. `kb-status-orbit`(`CHRONOS_A2UI_SPEC.md:48-53`)を intent→plan→state→result の実データに配線し、手組みテキスト(`MissionIntelligence.tsx:2675-2692`)を置換。
3. テスト: ライフサイクルの各段が orbit に反映されること。

### Task 4: 監査・kill-switch 連携 — `claude-haiku`

- pause/cancel/intervention を監査チェーン(SA-01)へ記録し、SA-05 の kill-switch の isolate と UI 操作を接続(オペレータが手動で isolate/kill を発火できる導線、kill は承認必須)。

## リスクと注意

- cancel/abort は実行中の外部副作用(ファイル書き込み・送信)を中途半端に残し得る。安全な打ち切り点(タスク境界)でのみ停止し、進行中のアクチュエータ呼び出しは完了を待つか明示的にロールバック方針を示す。
- pause 中の long-lived runtime のアイドル回収(AA-01)と競合しないよう、paused は idle-reap の例外にする。
- 介入操作は localadmin ロール限定(既存の権限モデル `api/intelligence/route.ts:1573` を踏襲)。

## 実装メモ 追記 (2026-07-06)

- SR-01 にて介入配線を実装: `A2UIRenderer` に `onAction` コールバックを追加し、`kb-intervention-panel` のボタンが `approval_id` → `/api/intelligence action=approval_decision`、`mission_id` → `action=intervention_respond` を実行するようになった(`page.tsx handleA2UIComponentAction`)。plan-preview の確認事項パネルはクリックで依頼文に回答欄を追記。`kb-artifact-tile` は open/preview で mission-asset を開く。
