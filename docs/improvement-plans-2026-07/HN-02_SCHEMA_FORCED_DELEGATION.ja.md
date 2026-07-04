# HN-02: schema-forced 委譲 — 構造化出力を返させ、検証してから受理する

> 優先度: P1 / 規模: M / 依存: なし / 関連: MO-04(結果契約)、MO-07(品質)、HN-01(軽量モデル規律)
>
> **参考にしたハーネス原則(Fable 5)**: サブエージェントに返させるのは結論と根拠であって自由テキストや作業ログではない。**スキーマで縛り、検証してから受理する**(不一致は再プロンプト)。私のワークフローでは schema オプションで検証済みオブジェクトを返させ、パース不要にしている。軽量モデルほど、この構造化強制が品質と信頼性を担保する。

## 背景と課題

- **`delegateTask` は文字列しか返さない**: `reasoning-backend.ts:344` は `delegateTask(instruction, context?): Promise<string>`。schema パラメータもオブジェクト返却も無い(HN 確認 §2)。呼び出し元は文字列を自前でパースする。
- **schema-forced は decision 領域 9 op に限定**: `structured-reasoning.ts` の 9 op は Zod schema + `safeParse`(不一致で throw)で検証済みオブジェクトを返し、anthropic backend は `output_config: { format: zodOutputFormat(...) }` でプロバイダネイティブに強制する。**しかし汎用の「任意タスクを schema-validated object で返させる」機構が無い**。
- **不一致で再プロンプトしない**: schema 失敗は即 throw(`structured-reasoning.ts:405-407`)。retry-on-mismatch が無い。
- **サブエージェント出力が無検証で受理される**: mission worker は返答を自由テキストとして受け、best-effort な JSON ブロック抽出(空 catch で失敗を握りつぶす)+ 手組み構造アサートのみ。`a2a-task-contract.schema.json` はあるが return-path で使われない(HN 確認 §5)。

## ゴール(受入条件)

1. **汎用の schema-forced 委譲**: `delegateTask`/dispatch に `outputSchema` を渡すと、検証済みオブジェクトが返る(プロバイダがネイティブ schema forcing 対応なら利用、非対応なら prompt に schema を埋め + パース + 検証)。
2. **retry-on-mismatch**: schema 不一致時に「この形式で返せ」と再プロンプト(上限付き)。上限超過で構造化エラー。
3. **サブエージェント出力の契約検証**: mission worker が受ける planner/worker 応答が、受理前に schema(planning_packet / task_result 等、MO-04 の結果契約)で検証される。空 catch での握りつぶしを廃止。
4. 既存の自由テキスト経路は後方互換(schema 未指定なら現状動作)。

## 実装タスク

### Task 1: 汎用 schema-forced 委譲 API — `claude-sonnet-4`

1. `reasoning-backend` に `delegateStructured<T>(instruction, outputSchema, opts): Promise<T>`(または `delegateTask` に `outputSchema` オプション)を追加。実装は既存の 2 経路を一般化: (a) プロバイダネイティブ(anthropic の `zodOutputFormat`)、(b) 非対応 backend は prompt に schema 記述を埋め、`parseStructuredJson`(`structured-reasoning.ts:371` の寛容パーサ)+ `safeParse`。
2. Zod schema をレジストリ化し、呼び出し元がスキーマ名で指定できるようにする(a2a-task-contract 等の既存 JSON schema を Zod に対応付け)。
3. テスト: ネイティブ/非ネイティブ双方で検証済みオブジェクト取得、不正 JSON の寛容パース。

### Task 2: retry-on-mismatch — `claude-sonnet-4`

1. `safeParse` 失敗時(`structured-reasoning.ts:405-407` の即 throw を置換)、不一致内容を添えて「この形式で返せ」と再プロンプト(既定上限 2 回)。上限超過で構造化エラー(HN-01 の軽量モデルタスクでは特に重要)。
2. 再プロンプトのコストを OP-01 の集計に含める。
3. テスト: 1 回目不一致 → 再プロンプトで成功、上限超過でエラー。

### Task 3: サブエージェント出力の契約検証 — `claude-sonnet-4`

1. `surface-response-blocks.ts` のブロック抽出(`:131-193`、空 catch で JSON.parse 失敗を握りつぶす)を、抽出後に対応スキーマで検証する形に変更。`validatePlanningPacket`(`mission-orchestration-worker.ts:231`)の手組みアサートを Zod schema 検証に置換。
2. 検証失敗時は「task_result/planning_packet 形式で再送せよ」と 1 回再要求(MO-04 Task 2 の再要求と統合)。それでも失敗なら受入ゲート(MO-02)で fail 扱い。空 catch の握りつぶしを廃止(IP-08 の規律)。
3. `a2a-task-contract.schema.json` を return-path 検証に接続。
4. テスト: 不正応答の再要求、正応答の受理、握りつぶし解消。

## リスクと注意

- プロバイダネイティブ schema forcing の対応状況は backend で異なる(anthropic は対応、CLI 系は不確実)。非対応は prompt 埋め + パース + retry でフォールバックし、機能差を吸収する。
- retry-on-mismatch は無限ループとコスト増のリスク。上限を必ず設け、超過はエラーで返す(黙って続けない)。
- 既存の自由テキスト依存の呼び出し元を壊さないため、schema 指定はオプトインで導入し、MO-04/MO-01 の新経路と HN-01 の軽量タスクから順に必須化する。
