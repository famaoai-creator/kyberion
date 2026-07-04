# UX-04: 承認・確認フローの統一

> 優先度: P1 / 規模: M / 依存: なし / 関連: [USER_EXPERIENCE_CONTRACT](../../USER_EXPERIENCE_CONTRACT.md) §承認(:190-193)

## 背景と課題

「リスクのある操作をユーザーが承認する」という中核体験が、面ごとにバラバラの UI・語彙・厳格さで実装されている。

- **CLI の approve 動詞が 3 流派**:
  - `scripts/cli.ts:325,1375` — `approve <id> [channel]` / `reject <id> [channel]`(動詞=決定)
  - `scripts/control_plane_cli.ts:571-574` — `presence approve <requestId> <approved|rejected>`(決定が位置引数)
  - `scripts/control_plane_cli.ts:688-699` — `chronos approve <requestId> <storageChannel> <channel> <approved|rejected>`(**無名の位置引数4つ**)
- **「魔法の言葉」確認**: ミッション作成の確認が、Slack(`satellites/slack-bridge/src/index.ts:338`)と chronos(`api/agent/route.ts:1167,1205`)で「`はい` または `お願いします` と入力せよ」方式。英語ロケールの応答文の中でも日本語の魔法語を要求する。同じ slack-bridge 内の承認は Block Kit ボタン(`:294-303,398-421`)で、**同一面内でも不統一**。
- **破壊的操作に確認が無い**(chronos): `MissionIntelligence.tsx` の `remediateLease`(`:1244`)、`clearOutboxMessage`(`:1272`)、`runMissionControl`(`:1298`)、seed 昇格(`:1321,1343`)が 1 クリック即時実行。赤色表示(`:837-842`)のみで確認ダイアログ・undo 無し(`confirm(` の grep ヒットゼロ)。
- **承認時に「何が起きるか」が見えない**: `cli.ts` の `printApprovalRequests`(`:1092-1126`)は id/種別/リスク/理由のみで、UX 契約が要求する「待つ/拒否した場合の帰結」「ブロック解除の具体アクション」(`USER_EXPERIENCE_CONTRACT.md:190-193`)を表示しない。
- **監査の主体が固定文字列**: `cli.ts:1146-1149` が `decidedBy: 'sovereign-user'`, `authMethod: 'manual'` を誰が実行しても記録する。オンボーディング済み identity 名が使われない。
- **チャネル格差**: 承認フローは Slack のみボタン、Telegram/Discord/iMessage には承認・ミッション提案フローが**存在しない**。

## ゴール(受入条件)

1. CLI の承認は `approve <id>` / `reject <id>` の 1 流派に統一される(旧形式は 1 リリース間エイリアスとして警告付きで残す)。
2. 「魔法の言葉」確認が、選択肢提示方式(ボタンのある面はボタン、無い面は `1) 実行する 2) やめる` の番号選択 or `yes/はい` 両対応)に置き換わる。
3. 破壊的操作(lease 修復・outbox 削除・mission 停止・seed 昇格)に確認ステップが入る。
4. 承認提示に「承認すると何が起きる / 待つとどうなる / 拒否するとどうなる」が含まれる。
5. `decidedBy` に onboarding identity の名前が記録される。

## 実装タスク

### Task 1: 承認提示データの拡充 — `claude-sonnet-4`

1. 承認リクエストの生成側(approval-actuator / 承認キューの型)を確認し、`expected_outcome` / `consequence_if_rejected` / `consequence_if_waiting` フィールドの有無を棚卸しする(`control_plane_cli.ts:566-568` は `expected_outcome` を一部表示しており、型は部分的に存在する見込み)。
2. 欠けているフィールドを承認リクエスト型に追加し、主要な承認発行元(risky アクション実行時)で値を埋める。値が無い場合の既定文言(「この操作は保留のまま実行されません」等)を語彙カタログに追加。
3. `cli.ts` の `printApprovalRequests` と slack の `buildSlackApprovalBlocks` に 3 情報の表示を追加。

### Task 2: CLI 動詞の統一 — `claude-sonnet-4`

1. `control_plane_cli.ts` の presence / chronos 承認を `approve <requestId> [--channel <ch>] [--storage <ch>]` / `reject <requestId> ...` の名前付きフラグ形式へ変更する(位置引数 4 連は廃止)。
2. 旧形式は検出時に「新形式へ移行してください」の警告 + 動作継続のエイリアスとして 1 リリース残す。`docs/OPERATOR_UX_GUIDE.md` の該当記述を更新。
3. 3 CLI の approve 系コマンドのヘルプ文言を統一(UX-03 の文言表に含める)。

### Task 3: 魔法の言葉の置換 — `claude-sonnet-4`

1. chronos(`api/agent/route.ts:1167,1205`): ミッション作成確認を、応答内の確認ボタン(既存の approval ブロック UI を流用)に変更する。ボタンを出せない経路では「1) 作成する 2) やめる」の番号選択+`yes/はい/1` の寛容な受理にする。
2. slack-bridge(`:338`): 同一ファイル内の Block Kit 承認ボタン(`:294-303`)を流用してミッション提案もボタン化する。
3. 受理語のパースは 1 箇所(`libs/core` の共通関数)にまとめ、locale 別の受理語(yes/y/はい/1 等)をテストで固定する。

### Task 4: chronos 破壊的操作の確認ステップ — `claude-sonnet-4`

1. `MissionIntelligence.tsx` に軽量の確認モーダル(対象名・操作内容・取り消し可否を表示、`実行` / `キャンセル`)を追加し、`:1244,1272,1298,1321,1343` の 5 操作に適用する。
2. `actionButtonClass('risky')` の操作は全て確認必須とする規約をコンポーネントのコメントに明記。
3. chronos の既存テストに「確認モーダル経由でのみ実行される」テストを追加。

### Task 5: 監査主体の記録 — `claude-sonnet-4`

- `cli.ts:1146-1149` の `decidedBy` を onboarding identity(`my-identity.json` の名前。取得は secure-io 経由、未設定時は従来の `'sovereign-user'` にフォールバック)にする。既存の監査ログ読み手が固定値に依存していないか grep で確認する。

### Task 6: チャネル格差の記録(実装はしない)— `claude-haiku`

- Telegram/Discord/iMessage に承認フローが無い事実と、「承認が必要な操作はこれらのチャネルでは提案のみ行い、承認は Slack/chronos/CLI へ誘導する」現状動作を `docs/OPERATOR_UX_GUIDE.md` に明記する(実装での均質化は将来判断)。

## リスクと注意

- 確認ステップの追加は操作回数を増やす。**read-only 操作や低リスク操作には付けない**(risky 分類のみ)。
- 旧 CLI 形式を使う自動化(パイプラインや docs のサンプル)が無いか、Task 2 で `grep -rn "chronos approve" docs/ pipelines/ knowledge/product/` を実行して確認・追従する。

## 実装メモ

- 2026-07-04: `presence/displays/chronos-mirror-v2/src/components/MissionIntelligence.tsx` に risky action confirmation modal を追加し、runtime lease 修復・outbox clear・mission seed promote・mission/surface risky actions を確認経由に切り替えた。`buildDangerousActionPrompt()` を純関数として切り出し、ヘルパーテストで文言を固定した。
