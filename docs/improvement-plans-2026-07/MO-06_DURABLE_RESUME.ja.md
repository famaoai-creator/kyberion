# MO-06: 調整の永続化と決定論的レジューム

> 優先度: P1 / 規模: S〜M / 依存: MO-03(リース片寄せ)と併走可
>
> **参考にしたハーネス原則(Fable 5)**: 長い作業は**ジャーナル**に各ステップの実結果を記録し、再開時は「変わっていない接頭辞はキャッシュから即返し、最初に変わった箇所から生実行」する。再開は人間の記憶や「物理状態を確認してね」という注意書きではなく、**記録からの機械的な再構築**であるべき。イベントは冪等に再適用できる形で永続化する。

## 背景と課題

- **調整バスがメモリ内のみ**: `MissionCoordinationBus` はプレーン配列にメッセージを保持(`libs/core/mission-coordination-bus.ts:31`)。プロセス終了で inbox/handoff/review が消える。設計文書は append-only JSONL を要求している(`agent-mission-control-model.md:214-224`)のに反する。※耐久なのは別系統の `mission-task-events.ts` JSONL と work-coordination JSONL のみ。
- **レジュームが儀式的**: `resume` は git branch の checkout + focus 再設定 + RESUME 履歴追記(60 秒の冪等窓、`mission-maintenance.ts:232-300,213-230`)までで、**orchestration イベント連鎖は再構築されない**。flight recorder(`LATEST_TASK.json`)は「物理状態を確認して続けよ」という人間向け警告(`:270-273`)。worker の `resume` は `mission_controller start` を叩き直すだけ(`mission-orchestration-worker.ts:855-856`)。
- 24h+ 走行・中断耐性は製品の中核主張(per-mission Git はそのためにある)なのに、**プロセス再起動でオーケストレーション状態が落ちる**のは主張と実装の乖離。

## ゴール(受入条件)

1. 調整バスのメッセージが append-only JSONL に永続化され、プロセス再起動後も inbox/handoff/review が復元される。
2. orchestration イベント(issue/kickoff/followup/…)の enqueue と処理完了が journal に記録され、**resume 時に「最後に完了したイベントの次」から自動再開**される(再 enqueue)。処理済みイベントの再適用は冪等(スキップ)。
3. 実行中だった dispatch タスク(リース保持中)は resume 時に検出され、(a) 応答未受領なら再発行 or blocked 化の判断がリースの期限から決まる、(b) 二重実行が起きない。
4. `LATEST_TASK.json` の人間向け警告は残しつつ、機械的再開が既定になる。

## 実装タスク

### Task 1: 調整バスの JSONL 永続化 — `claude-sonnet-4`

1. `mission-coordination-bus.ts` の格納層を `missions/<id>/coordination/bus.jsonl` への append + 起動時ロードに変更する(書式は `mission-task-events.ts` の既存 JSONL 規約に合わせる)。書き込みは secure-io 経由・ミッションロック下。
2. メモリ配列は読み出しキャッシュとして残し、既存 API 互換を維持。サイズ上限(例: 10,000 行)到達時のローテーションを入れる。
3. unit test: 再起動シミュレーション(新インスタンスでロード)で全メッセージ復元。

### Task 2: orchestration イベント journal — `claude-sonnet-4`

1. `enqueueMissionOrchestrationEvent` と各ハンドラ完了時に `missions/<id>/coordination/orchestration-journal.jsonl` へ `{event, status: enqueued|completed|failed, ts, payload_hash}` を追記する。
2. `resume` フロー(`mission-maintenance.ts` と worker の `handleMissionControlRequested` resume)に journal 読取を追加: 最後の `completed` イベントを特定し、その次のイベントを再 enqueue する。`enqueued` のまま `completed` が無いイベントは失敗扱いで再実行(ハンドラ側の冪等性は Task 3)。
3. E2E テスト(stub): kickoff 完了直後に「再起動」→ resume → followup から再開されること。

### Task 3: ハンドラの冪等化と実行中タスクの回収 — `claude-sonnet-4`

1. 各イベントハンドラの冒頭に「既に成果が存在する場合はスキップ」ガードを入れる(kickoff: PLAN.md 存在 / followup: 全タスク終端 / distill: distill 済みフラグ)。既存の成果物存在チェックを流用し、二重実行で壊れないことをテストで固定。
2. resume 時、work-coordination のリース(MO-03 Task 3)を走査: リース期限切れの `requested` タスクは再発行キューへ、期限内は応答待ち継続。再発行時は同一 task_id の attempt を増分し、受入ゲートで旧応答との二重完了を防ぐ。
3. テスト: リース期限切れ再発行 / 期限内待機の分岐。

### Task 4: 運用確認 — `claude-haiku`

- `mission_controller resume` の出力に「journal から再開: 次イベント=X / 回収タスク=N 件」を表示し、`docs/OPERATOR_UX_GUIDE.md` の resume 節を現実に合わせて更新する。

## リスクと注意

- journal の再適用は**副作用のあるハンドラ**(Slack 通知、A2A 発行)を重複発火させ得る。Task 3 の冪等ガードを通知系にも適用する(同一 event+payload_hash の通知は 1 回)。
- ミッションディレクトリは per-mission git 配下にあるため、journal/bus の高頻度追記が checkpoint コミットを肥大化させる。`coordination/` を mission git の `.gitignore` に入れるか checkpoint 対象から除外するかを既存規約(evidence の扱い)に合わせて決め、判断を記録する。
