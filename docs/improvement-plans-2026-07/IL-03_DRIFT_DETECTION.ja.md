# IL-03: インテントドリフト検出の是正 — 起点比較・全経路 baseline・実行中ゲート

> 優先度: P1 / 規模: M / 依存: IL-01(実 goal)、IL-02(相関)/ 関連: MO-02(フェーズゲート — ドリフトゲートはその 1 種として組み込む)
>
> **なぜ重要か**: INTENT_LOOP_CONCEPT §6 の中核主張は「ドリフトは**実行後でなく実行中に**検知する」。現状の実装はこの主張を満たさず、しかも既存ゲートは実質 no-op で「守っているつもり」状態。

## 背景と課題

ドリフト検出が「遅く・間違った対象を・実質無効に」測っている。

- **finish 時のみ**: `evaluateMissionIntentDrift` の呼び出しは `finishMission`(`mission-lifecycle.ts:229`)の 1 箇所だけ。実行中の検知は無い。
- **直近2スナップショット比較**: `evaluateIntentDriftGate` は最後の 2 スナップショットを比較(`intent-snapshot-store.ts:142-143`)しており、**起点のユーザー intent と比較していない**。これはゲート自身の説明「originating user intent からドリフトしていないこと」(`mission-review-gate-registry.json:68`)と矛盾。
- **no-op 化**: finish はまず「最新スナップショットの goal をコピーした」delivery スナップショットを出す(`mission-lifecycle.ts:223-228`)ので from≈to → ドリフトほぼゼロ → ゲートが無意味。
- **baseline が偽物**: 中間スナップショットは汎用テキスト(intake は `visionRef || "Start mission ..."`、`mission-creation.ts:311`、worker 遷移は "progressing through {phase}"、`mission-orchestration-worker.ts:60`)。本物のユーザー発話を baseline 化するのは Slack worker 経路の `emitWorkerKickoffSnapshot`(`:75-92`)だけで、通常のサーフェス→CLI ミッション経路では baseline が作られない。
- **ゲートに評価器が無い**: `INTENT_DRIFT` ゲート(`registry:67`、standard/strict で必須)は `summarizeReviewGateVerdicts` に専用評価器が配線されておらず(`evaluateArtifactBundleGate` のみ存在、`mission-review-gates.ts:180`)、宣言されているが実行時ブロッカーとして機能しない。

## ゴール(受入条件)

1. ドリフトが**起点 intent(最初の user_prompt スナップショット = IL-01 の実 goal)と現在**を比較する(直近2比較の廃止)。
2. **全ミッション入口**で本物の baseline スナップショット(実発話/実 goal)が作られる(Slack worker 経路限定を解消)。
3. finish が最新 goal をコピーする no-op(`mission-lifecycle.ts:223-228`)をやめ、ドリフトゲートが実際に効く。
4. `INTENT_DRIFT` ゲートに評価器が配線され、**フェーズ遷移時(実行中)**に評価される。閾値超過時は MO-02 の circuit breaker(Alignment 差し戻し + オーナー通知)に接続。
5. ドリフト検知は「意図的なスコープ変更」と「逸脱」を区別できる(承認されたスコープ変更は baseline を更新)。

## 実装タスク

### Task 1: baseline スナップショットの全経路生成 — `claude-sonnet-4`

1. `emitWorkerKickoffSnapshot`(`mission-orchestration-worker.ts:75-92`)相当の「実発話を IntentBody として baseline 化」を、全ミッション入口(サーフェス→CLI 経路の `mission_controller create`、IL-01 で渡る実 goal を使用)で行う。intake の汎用テキスト(`mission-creation.ts:311`)を実 goal に置換。
2. baseline スナップショットに `kind: 'origin'` を明示し、以降の比較の固定基準にする。
3. テスト: 各入口で origin スナップショットが実 goal で作られること。

### Task 2: ドリフト比較を起点基準に — `claude-sonnet-4`

1. `evaluateIntentDriftGate`(`intent-snapshot-store.ts:142-143`)を「origin スナップショット vs 現在」比較に変更。直近2比較は廃止。
2. finish の delivery スナップショット生成(`mission-lifecycle.ts:223-228`)が最新 goal をコピーする挙動をやめ、実際の成果/最終状態を反映したスナップショットにする(from=origin, to=delivery で真のドリフトが出る)。
3. テスト: origin と乖離した delivery でドリフトが検出されること、一致で低ドリフト。

### Task 3: 実行中ゲートの配線 — `claude-sonnet-4`

1. `INTENT_DRIFT` ゲートの評価器を `summarizeReviewGateVerdicts`(`mission-review-gates.ts`)に配線(`evaluateArtifactBundleGate` と並ぶ形)。
2. MO-02 のフェーズ exit ゲート評価に `INTENT_DRIFT` を組み込み、**フェーズ遷移ごと**に評価。閾値超過は MO-02 の circuit breaker(realign)へ。閾値は `mission-review-gate-registry.json` の設定に従う。
3. finish 時だけでなく実行中に効くことを E2E(stub)で確認: 途中でスコープが逸脱するシナリオ → 遷移時にブロック。

### Task 4: 承認されたスコープ変更の扱い — `claude-sonnet-4`

1. ユーザー/オーナーが明示的にスコープを変更した場合(承認経由)、origin baseline を更新して「正当な変更はドリフト扱いしない」経路を設ける。変更は監査に記録。
2. テスト: 承認スコープ変更後はドリフトが解消、無承認の逸脱は検知継続。

## リスクと注意

- ドリフト検出の実効化は**進行中ミッションを止め得る**。閾値は保守的に始め、まず warn(検知を記録・通知するがブロックしない)で観測 → enforce。MO-02 の circuit breaker と同じ段階導入。
- ドリフト判定が LLM を使う場合、stub backend では形骸化する。テストは判定応答を fixture 注入。判定コストが高いので、フェーズ遷移時のみ(全ステップでなく)評価する。
- 「逸脱」と「深化(同じ goal のより詳細な達成)」を誤判定しないよう、比較は goal.success_condition 充足方向の変化を見る(表層テキスト差分でなく)。IL-04 の完了突合と判定ロジックを共有する。
