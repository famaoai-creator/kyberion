# SU-01: オペレータホームとゴール表明→プラン承認の操作面

> 優先度: P1 / 規模: L(フェーズ分割) / 依存: IL-01/IL-04(ゴール貫通・突合)、MO-01(プロセステンプレート) / 関連: POST_ONBOARDING_UX_ROADMAP #1/#4、USER_EXPERIENCE_CONTRACT の Clarification/Execution-Preview shape、DS-01(トークン)
>
> **なぜ重要か**: これが製品の中核ループ(intent→plan→result)の操作面。現状その入口は浮遊チャットの二値 yes/no 確認だけで、プランを見て・調整して・承認する操作面が存在しない。「毎日開く価値のある UI」の第一要件。
>
> **オーナーシップ(2026-07-03 レビュー)**: chronos のミッション作成二値確認(`api/agent/route.ts:1167-1215`)の置換は**本計画が単独オーナー**(構造化プラン承認 UI に置換)。UX-04 の同コード変更はここに統合され、UX-04 は Slack/CLI/破壊的操作の確認統一に集中する。受理語パーサの共通化は UX-04 と共有。

## 背景と課題

- **ゴール表明の入口が浮遊チャットのみ**: `SovereignChat` が唯一の自由入力口(`components/SovereignChat.tsx`)。エージェントがミッション提案を返し、`はい`/`お願いします` の**二値確認**でミッション発行(`api/agent/route.ts:1148-1215`)。`mission_type`/`tier`/`persona` はバッジ表示されるが**編集不可**、構造化プラン preview も無い。
- **契約が定める対話 shape が操作面を持たない**: USER_EXPERIENCE_CONTRACT の Clarification / Execution-Preview(依頼理解・不足情報・実行計画・期待成果物を**着手前**に提示)は、良くてチャットの自由文でしか存在しない(`:38-68`)。
- **オペレータホームが存在しない**: chronos のホームヒーローは web-design-system のショーケース(`app/page.tsx:412-476`)で、オペレータ状態(ready/blocked/needs-approval)ではない。POST_ONBOARDING_UX_ROADMAP #1(単一画面ホーム)#4(推奨初回ミッション)は未実装で、FirstRunBanner の静的チェックリスト(`FirstRunBanner.tsx:73-78`)止まり。

## ゴール(受入条件)

1. **オペレータホーム**が新設され、開くと「今の状態(ready/blocked/needs-approval の件数)・実行中ミッション・推奨される次の一手」が 1 画面で見える(design-system ショーケースを日常運用画面に置換、ショーケースは別ページへ退避)。
2. **ゴール表明サーフェス**(チャット埋め込みでなく第一級)で、自由文の依頼 → 解釈された goal(IL-01)+ 実行計画 preview(shape/チーム/フェーズ/期待成果物)を**着手前**に表示。
3. プランを**編集して承認**できる: mission_type/tier/persona、含めるフェーズ、成果物の要件を調整してから authorize。二値 yes/no を廃止。
4. 承認された goal が IL-01 の goal 貫通経路でミッションに渡る(UI とバックエンドの goal が一致)。
5. 推奨初回ミッション(vision/tenant/service readiness ベース、POST_ONBOARDING #4)がホームに提案として出る。

## 実装タスク

### Task 1: プラン preview API とゴール解釈の露出 — `claude-sonnet-4`

1. 既存の intent compile(`intent-contract.ts` の compile 経路)を叩いて「解釈された goal + shape + 想定チーム/フェーズ(MO-01 のプロセステンプレート)+ 期待成果物」を返す API(`app/api/plan-preview`)を追加する。**この時点では実行しない**(preview のみ)。
2. IL-04 の goal 合意ハンドシェイクのバックエンド(`deriveIntentDeliveryDecision` の実配線)と接続。
3. テスト: 代表依頼で plan preview が構造化されて返ること。

### Task 2: ゴール表明・プラン承認 UI — `claude-sonnet-4`

1. 第一級の「依頼を伝える」入力 → plan-preview 表示 → 編集可能フィールド(type/tier/persona/フェーズ/成果物要件)→「承認して開始」ボタン、の画面を新設(USER_EXPERIENCE_CONTRACT の Execution-Preview shape の操作面)。
2. 承認で IL-01 の goal 貫通経路(`mission_controller create` に実 goal + 編集後パラメータ)へ。二値 yes/no 経路(`api/agent/route.ts:1170-1215`)はこの構造化承認へ移行。
3. 明確化が必要な場合(clarification_needed)は不足情報を同画面で埋める(Clarification shape)。
4. UX-03(言語)・UX-05(語彙)・DS-01(トークン)準拠。テスト: preview→編集→承認→ミッション作成で編集値が反映されること。

### Task 3: オペレータホーム — `claude-sonnet-4`

1. 新ホーム: ready/blocked/needs-approval のサマリ(既存の operator-console `lib/operator-console.ts` のデータ源を活用)、実行中ミッション一覧、推奨次アクション、コスト当日累計(OP-01)、承認保留(SU-04 と連携)。
2. 現ヒーロー(design-system ショーケース、`page.tsx:412-476`)は `/design-system` 等へ退避。
3. 推奨初回ミッション(POST_ONBOARDING #4): vision/tenant/service readiness から 1 つ提案し、Task 2 のプラン承認へ繋ぐ。
4. テスト: ホームが状態を正しく集約表示すること。

### Task 4: 連携ドキュメント — `claude-haiku`

- POST_ONBOARDING_UX_ROADMAP の #1/#4 に「SU-01 として実装」とステータス追記。CHRONOS_A2UI_SPEC の `kb-status-orbit`(lifecycle 可視化)をホーム/プラン画面で使う方針を追記(SU-02 と共有)。

## リスクと注意

- 大規模 UI 追加。**フェーズ分割**(Task 1 preview API → Task 2 承認 UI → Task 3 ホーム)で各々独立に価値を出す。一度に全画面を作らない(POST_ONBOARDING の non-goal「全画面を一度に作らない」を尊重)。
- プラン編集で危険なパラメータ(高権限 persona 等)を選べる場合、SA-05 の承認ゲートを通す。
- ゴール表明 UI とチャットの役割分担を明確に(チャットは対話継続、ゴール表明は構造化着手)。両者が競合しないよう入口を整理する。
