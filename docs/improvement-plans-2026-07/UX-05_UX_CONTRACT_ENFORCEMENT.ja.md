# UX-05: UX 契約の code 化 — USER_EXPERIENCE_CONTRACT をドキュメントから強制へ

> 優先度: P2 / 規模: M / 依存: UX-03(語彙配線)推奨 / 関連: UX-01, UX-04

## 背景と課題

[USER_EXPERIENCE_CONTRACT.md](../../USER_EXPERIENCE_CONTRACT.md) は「内部語彙を露出しない」「readiness は平易な言葉で」等を定めるが、**契約は文書のままで、コードによる強制がほぼ無い**。

- バリデータ `validateSurfaceUxContract`(`libs/core/surface-ux-contract.ts:44`)は実装・テスト済みだが、ランタイム呼び出しは 1 箇所のみ(`surface-runtime-orchestrator.ts:1834`。コメント自身が「以前は実装されテストされたが呼ばれていなかった」と認めている `:1830`)。しかもその 1 箇所も **logger.warn のみの非ブロッキング**(`:1835-1838`)で、違反文言はそのまま配信される。
- 対象は会話面(`runSurfaceMessageConversation`)だけで、**生 enum 漏れが実際に起きているターミナル面(cli.ts / mission_controller / dashboard / run_pipeline)には一切かかっていない**。
- 実際の違反: `printOperatorPacket` が `packet.readiness` を生表示(`cli.ts:807-809`)し、`question-resolver.ts:234` は生 enum `needs_clarification` / `fully_automatable` を発行。語彙カタログの `readiness_*`(`user-facing-vocabulary.json:386-397`)は**一度も読まれない死にエントリ**。
- 明確化質問が `maxQuestions` で黙って切り捨てられ(`question-resolver.ts:323`)、`missing_inputs` は packet に載るのに CLI は表示しない(`cli.ts:816-824`)— 「残りのブロッカーがある」ことをユーザーが知れない。
- ステータス語彙が面ごとに私製: 接続状態(`sovereign_dashboard.ts:170-176` vs `:100`)、プロバイダ状態(`mission_controller.ts:1071` vs `sovereign_dashboard.ts:251-265`)、ミッション状態(`mission_controller.ts:557-567`)。

## ゴール(受入条件)

1. readiness・接続状態・プロバイダ状態・ミッション状態の表示語彙が語彙カタログの 1 マッピングに集約され、全ターミナル面がそれを使う(生 enum の直接出力ゼロ)。
2. `validateSurfaceUxContract` が (a) 会話面では違反時に**配信前に修正**(語彙置換)を試み、置換不能時のみ warn 付き配信、(b) CI では主要面の出力スナップショットに対して**テストとして**強制される。
3. 質問切り捨て時に「他に N 件の確認事項があります」が表示され、`missing_inputs` が packet レンダラに出る。

## 実装タスク

### Task 1: 表示語彙マッピングの一元化 — `claude-sonnet-4`

1. `libs/core/ux-vocabulary.ts`(または既存の適所)に `renderStatus(domain: 'readiness'|'connection'|'provider'|'mission', value: string, locale): string` を実装し、語彙カタログの `readiness_*` 等を読む。未知値は「そのまま出す + logger.warn」でフェイルソフト。
2. `question-resolver.ts:234` の発行値と `readiness_*` キーの対応表を作り、`cli.ts:807-809`・`sovereign_dashboard.ts:170-176,251-265`・`mission_controller.ts:557-567,1071` を `renderStatus` 経由に置換する。
3. カタログに不足している状態語(provider/mission 系)を en/ja で追加し、`check:catalogs` を通す。

### Task 2: バリデータの実効化 — `claude-sonnet-4`

1. `surface-runtime-orchestrator.ts:1834` の呼び出しを「違反検出 → 語彙置換による自動修正 → 再検証 → 依然違反なら warn 付き配信」に強化する(配信ブロックはしない。無応答の方が害が大きい)。
2. 検出・修正の発生を trace に記録し、`logger.warn` に違反種別を含める(観測してから将来ブロック化を判断するため)。
3. `surface-ux-contract.test.ts` に自動修正のテストを追加。

### Task 3: 契約スナップショットテスト — `claude-sonnet-4`

1. `tests/ux-contract-surfaces.test.ts` を新設: `printOperatorPacket` / `printApprovalRequests` / dashboard の主要セクションを fixture 入力でレンダリングし、(a) 生 enum(`needs_clarification` 等の禁止リスト)が含まれない、(b) `validateSurfaceUxContract` が pass する、をアサートする。
2. 禁止リストは `surface-ux-contract.ts` の既存定義から import し、二重管理しない。
3. IP-03 の CI 拡張に載せて PR ゲート化する。

### Task 4: 質問切り捨ての可視化 — `claude-sonnet-4`

1. `question-resolver.ts:323` の切り捨て時に packet へ `omitted_question_count` を追加し、`printOperatorPacket`(`cli.ts:816-824`)で「他に N 件の確認事項があります(`missing_inputs` 参照)」と `missing_inputs` の一覧を表示する。
2. 会話面(surface-interaction-model)でも同カウントを一文で添える。
3. question-resolver の既存テストにケース追加。

## リスクと注意

- 語彙置換の自動修正は過剰置換(本文中の偶然の一致)に注意。**構造化フィールド(readiness 等)のみ置換対象**とし、自由文はバリデーション警告のみに留める。
- ステータス語の表示変更は運用者の目視習慣を変える。変更一覧(旧語 → 新語)を PR/パッチ説明に表で添付する。

## 実装メモ

- `libs/core/ux-vocabulary.ts` を追加し、`renderStatus()` で readiness / mission などの表示語彙を `user-facing-vocabulary.json` から引くようにした。
- `scripts/cli.ts` の operator packet と `scripts/mission_controller.ts` の mission status 表示を共有レンダラ経由に寄せた。
- `repairSurfaceUxContractText()` を追加し、`runSurfaceMessageConversation` は違反時に配信前修復を試みるようにした。
