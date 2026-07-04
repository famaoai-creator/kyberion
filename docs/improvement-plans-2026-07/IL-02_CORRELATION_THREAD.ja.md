# IL-02: intent→goal→result を貫く相関スレッド

> 優先度: P1 / 規模: M / 依存: IL-01(goal 貫通)/ 関連: AA-05(A2A の correlation_id)、SA-01(監査)、統一 Trace(D3)
>
> **なぜ重要か**: 「ユーザーは X を頼み → ゴールは Y → 成果物は Z」を機械的に再構成できることは、監査・説明可能性・学習・FDE 説明責任のすべての土台。現状これが不可能。

## 背景と課題

発話・契約・ミッションが**3つの無関係な名前空間**に住んでおり、繋がらない。

- サーフェスは `correlationId` を持つ(`surface-interaction-model.ts:74,428,512`)が、昇格したミッションは無関係な新 `MSN-${Date.now()}` を得る(`surface-runtime-orchestrator.ts:1052,1120`)。
- intent-contract-memory のキーは `intent_id::contract_ref.kind::contract_ref.ref`(`scripts/sync_intent_contract_memory.ts:44`)で、mission id も correlation id も持たない。
- スナップショットは `mission_id` と**任意の `trace_ref`**(`intent-snapshot-store.ts:88`)を持つが、サーフェス→ミッション経路では trace_ref はほぼ populate されない。
- 結果、「発話 → 契約 → ミッション → 成果」を機械的に辿れない。

## ゴール(受入条件)

1. 受信時に発行される単一の相関 ID(`correlationId` または IntentContract id)が、intent contract・mission id/state・snapshot の `trace_ref`・intent-contract-memory・TraceContext・監査エントリすべてに貫通する。
2. `pnpm intent trace <correlation_id>`(または既存 CLI 配下)で「発話 → 解釈された goal → ミッション/タスク → 成果物 → 検証結果」の時系列が 1 コマンドで出る。
3. 既存データ(相関 ID なし)との後方互換(欠落時は従来表示)。
4. AA-05 の `mission flow` と統合(メッセージフローと intent フローが同じ相関キーで結合)。

## 実装タスク

### Task 1: 相関 ID の発行と貫通 — `claude-sonnet-4`

1. 受信時(`runSurfaceConversation`、`surface-runtime-orchestrator.ts:1647`)に相関 ID を確定し(既存 `correlationId` を正とする)、IntentContract に格納する。
2. ミッション昇格時(`:1052`)、相関 ID をミッション作成に渡す(IL-01 の handoff に相乗り)。ミッション id 自体は `MSN-timestamp` のままでよいが、`state.json` に `correlation_id`/`origin_intent_id`/`origin_utterance_ref` を保持する。
3. snapshot 生成箇所すべてで `trace_ref` に相関 ID を入れる(`intent-snapshot-store.ts:88` の任意フィールドを必須化しないが、mission 経路では常に埋める)。
4. `sync_intent_contract_memory.ts:44` のキー/レコードに相関 ID(と mission id)を追加(キーは互換のため据え置き、フィールド追加)。
5. テスト: 受信 → 昇格 → memory/snapshot/state に同一相関 ID が伝播することを確認。

### Task 2: TraceContext・監査への相関 ID — `claude-sonnet-4`

1. TraceContext(`libs/core/src/trace.ts`)のスパン/イベントに相関 ID 属性を付与し、intent 経路の各段(compile・clarify・execute・verify)が同一 ID を持つようにする。
2. 監査チェーン(SA-01)のエントリにも相関 ID を含める(intent 起点の操作の追跡)。
3. フィールド追加のみで既存読み手を壊さない。

### Task 3: intent trace 閲覧コマンド — `claude-sonnet-4`

1. `pnpm intent trace <correlation_id>` を追加: intent-contract-memory・snapshot store・mission state・trace JSONL・監査を相関 ID で突合し、時系列(発話 → goal → shape 決定 → 実行イベント → 成果物 → 検証)を表で出す。
2. 出力語彙は UX-05 の `renderStatus` を使い生 enum を出さない。confidential 発話は本文でなく参照のみ表示(tier 隔離)。
3. AA-05 の `mission flow` と共通の相関キーで結合できるよう出力形式を揃える(将来 1 コマンドに統合可能に)。
4. fixture での unit test + 実データ 1 件の手動確認。

## リスクと注意

- 相関 ID の貫通は多数のモジュールを横断する薄い変更の集合で、AA-05・SA-01・統一 Trace と接触する。**フィールド追加のみ**を厳守し、これらの計画と相関キー名を統一(`correlation_id`)しておく(各計画の該当箇所に相互参照を明記)。
- 既存ミッション・memory には相関 ID が無い。trace コマンドは「相関 ID あり=フル結合、なし=部分表示」で degrade する。
- confidential 発話が trace 出力・memory に生で残らないよう、格納は参照(snapshot ref)ベースにし、本文は tier 保護領域に留める。
