# HO-01: 自己完結ハンドオフパケット — 引き継ぎで文脈・意図・根拠を落とさない

> 優先度: P1 / 規模: M / 依存: MO-04(コンテキスト)、IL-01(goal 貫通)/ 関連: AA-04(会話)、UX-04(承認)
>
> **なぜ重要か**: 作業が別の holder(次フェーズ・別エージェント・人間)に渡る瞬間に文脈が落ちると、受け手は再導出するか聞き返すしかなく、品質と速度が両方落ちる。Cowork 連携が持つ**自己完結パケット**の質を、内部のハンドオフにも広げる。

## 背景と課題

ハンドオフの完全性が経路ごとにバラバラで、内部ほど lossy。

- **`mission:handoff` はペルソナ文字列の交換のみ**: `handoffMission`(`scripts/mission_controller.ts:1318-1339`)は `assigned_persona` を変えて `HANDOFF` 履歴イベントを 1 行追記するだけ。state も成果物も根拠も受入条件も渡さない。受け手は名前だけ継いで全部再読。
- **`handoffWorkItem` は purpose のみ、作業サマリを落とす**: `work-coordination.ts:1097-1131` は release→claim で、イベントは `{from_lease_id, to_lease_id, purpose}`(`:1124-1128`)。`WorkItemAttempt.summary` は**終端完了時のみ**捕捉(`:757-762`)され、実行中ハンドオフでは「何をした/どこで止めた/何を決めた」が消える。
- **タスク契約の忠実度ギャップ**: Mission Task Contract(`task-contract.schema.json`)は `objective`/`acceptance_criteria`/`correlation_id` を持つが、**実際に A2A 配送で使う wire 契約(`a2a-task-contract.schema.json`)は acceptance_criteria も expected_outputs も objective も落とす**(intent + text + context のみ)。**どちらの契約にも `rationale`/`why`/`prior_decisions` フィールドが無い** — 受け手は「なぜこのタスクか」を決して受け取らない。
- **人間への承認ハンドオフが素っ気ない**: `enforceApprovalGate` は `title = "Approval required: ${operationId}"`、`summary = "Agent ... requests approval for ..."`(`approval-gate.ts:148-149`)の**汎用テンプレ**。diff も成果物も「承認/拒否したらどうなるか」も無い。**リッチな `summarizeApprovalGate`(`approval-gate-summary.ts:44-63`)が存在するのに `enforceApprovalGate` に配線されていない**。
- 良い実例(再利用元): `question-resolver` の OIP(`:187-236`、理由/既定/影響つき — 人間への最良ハンドオフ)、`cowork-surface` の delivery packet(`:82-104`、mission_id/trace_id/next_action/artifacts の自己完結パケット — repo 最良の構造化ハンドオフ)。

## ゴール(受入条件)

1. **自己完結ハンドオフパケット**スキーマが定義され、`handoffWorkItem` と `mission:handoff` に添付される: 退出側サマリ(何をしたか)・未決事項・部分成果物 refs・残り受入条件・**rationale**。`WorkItemAttempt.summary` を**ハンドオフ時にも**捕捉(終端限定を解除)。
2. タスク契約に `rationale`/`prior_decisions` を追加し、**A2A wire 契約が acceptance_criteria/expected_outputs/objective を運ぶ**(Mission Task Contract と同等の忠実度)。source は `GuidedCoordinationBrief`(`objective`/`assumptions`/`approval_boundary` を持つ)。
3. **承認ハンドオフのリッチ化**: `summarizeApprovalGate`(成果物 + 帰結)を `enforceApprovalGate` に配線し、人間/Cowork の承認者が「何が変わる・承認/拒否の結果・リスク・成果物リンク」を受け取る(OIP 品質を承認にも)。
4. 受け手が「聞き返さず継続できる」ことをテストで確認(自己完結性)。

## 実装タスク

### Task 1: ハンドオフパケットスキーマと work-coordination 配線 — `claude-sonnet-4`

1. `schemas/handoff-packet.schema.json` を定義: `{ outgoing_summary, open_decisions[], partial_artifacts[], remaining_acceptance_criteria[], rationale, correlation_id }`。
2. `handoffWorkItem`(`work-coordination.ts:1097`)にパケットを添付。`WorkItemAttempt.summary` の捕捉を終端限定(`:757-762`)からハンドオフ時にも拡張(退出側が「どこまでやったか」を必ず残す)。
3. `mission:handoff`(`mission_controller.ts:1318`)もペルソナ交換に加えてパケットを記録。
4. テスト: ハンドオフ後、受け手がパケットだけで作業継続に必要な情報を持つこと。

### Task 2: タスク契約の忠実度統一 — `claude-sonnet-4`

1. `task-contract.schema.json` と `a2a-task-contract.schema.json` に `rationale`/`prior_decisions` を追加。
2. **A2A wire 契約に `objective`/`acceptance_criteria`/`expected_outputs` を追加**し、Mission Task Contract と同等にする(MO-03 のタスク契約拡張と統合 — 重複させず、MO-03 のスキーマに rationale/wire 忠実度を足す形)。
3. dispatch(MO-04 の context pack 配線)がこれらを埋める。source は `GuidedCoordinationBrief`(`guided-coordination-brief.ts:9-45`)。
4. テスト: A2A 経由の worker が acceptance_criteria と rationale を受け取ること。

### Task 3: 承認ハンドオフのリッチ化 — `claude-sonnet-4`

1. `summarizeApprovalGate`(`approval-gate-summary.ts:44`)を `enforceApprovalGate`(`approval-gate.ts:148-149`)に配線し、保存される承認リクエストが汎用テンプレでなく「変更内容・承認/拒否の帰結・リスク・成果物 refs」を持つようにする(UX-04 の帰結表示・SU-04 の承認キューと同じデータ)。
2. Cowork 承認(`approval-cowork-adapter.ts`)にも同じリッチ framing が流れることを確認(現状は bare summary を継承)。
3. テスト: 承認リクエストがリッチ framing を持つこと、Cowork 側にも伝わること。

## リスクと注意

- パケット・契約の拡張は多くの読み手に触れる。**フィールド追加のみ**で既存を壊さない。wire 契約の拡張は A2A のペイロードを増やすので、MO-04 のコンテキスト予算と整合(パケットは要約 refs 中心、全文は貼らない)。
- rationale/prior_decisions に confidential が入り得る。ハンドオフパケットの tier を継承し、tier をまたぐハンドオフでは機密根拠を要約/参照に留める。
- 承認 framing のリッチ化で機密(diff 内容等)が承認者に出る。承認者の権限・tier を確認し、必要なら参照リンクに留める。

## 実装結果

- `libs/core/handoff-packet.ts` / `dist/libs/core/handoff-packet.js` に自己完結パケット生成を追加した。
- `handoffWorkItem` は release/claim の両方に `handoff_packet` を添付し、release 側の summary に退出サマリを残すようにした。
- `mission:handoff` は persona 交換に加えて `handoff_packet` を history に記録するようにした。
- `enforceApprovalGate` は `summarizeApprovalGate` ベースの rich draft を使い、Cowork 承認一覧にも `details` を流すようにした。
- `pnpm pipeline --input pipelines/baseline-check.json` は healthy で完走した。
