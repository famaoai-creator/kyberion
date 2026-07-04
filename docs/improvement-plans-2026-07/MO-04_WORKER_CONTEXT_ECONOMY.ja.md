# MO-04: ワーカーへのコンテキスト供給 — context pack を実際に配る

> 優先度: P1 / 規模: S〜M / 依存: なし(MO-03 と併走可)
>
> **参考にしたハーネス原則(Fable 5)**: サブエージェントへの依頼は**自己完結**でなければならない(会話履歴を知らない前提で、目的・制約・返答形式まで 1 つのプロンプトに入れる)。渡すのは「必要十分な要約された事実」であり、生ダンプではない。返させるのは「結論と根拠」であり、ファイルの中身ではない。予算(文字数)を切り、超過分はロールアップに逃がす。

## 背景と課題

**設計として優れた `MissionContextPack` が存在するのに、実際の分配では使われていない。**

- worker が A2A で送るのは手組み文字列: task id / ロール / description / deliverable / target_path + `JSON.stringify({mission_id, team: role→agent_id マップ})` だけ(`mission-orchestration-worker.ts:458-478`)。ミッションの outcome contract、既存 evidence、project/track 状態、ナレッジヒントは**一切含まれない**。
- 一方 `mission-context-pack.ts` は: ロール別スコープ、mission/project/track サマリ、知識ヒント上位3、再利用アーティファクトヒント上位3、**明示的 redactions**(「全ナレッジコーパスは見えない」等、`:546-553`)、**6,000 字予算の剪定**(`pruneMissionContextPack` `:395-486`)+ ロールアップ退避、そして「このパックの事実のみを使い、足りなければ**推測せずギャップを報告せよ**」で終わるレンダリング(`renderMissionContextPack` `:1099-1178`)を持つ。**Fable 5 の原則をほぼ正しく実装した部品**が、dispatch 経路に配線されていない。
- 返答側も規律が無い: `a2aBridge.route` は生テキストを返し(`a2a-bridge.ts:168-170`)、構造化された結果契約(何を作った・何を検証した・残ギャップ)が無い。

## ゴール(受入条件)

1. タスク分配プロンプトが `renderMissionContextPack`(ロール別・予算付き)+ タスク契約(MO-03)で構成され、手組み文字列が廃止される。
2. ワーカーの返答が構造化される: `{ summary, artifacts: [{path, kind}], verification_done: [], gaps: [], needs: [] }` 相当のブロックを必須とし、受入ゲート(MO-02)がこれを入力にする。
3. `needs`(情報不足の申告)が返った場合、worker が追加コンテキスト(パックの補強 or owner への質問)を 1 往復だけ供給する経路がある。
4. コンテキストサイズが trace に記録され、予算超過時のロールアップ発動が観測できる。

## 実装タスク

### Task 1: dispatch への context pack 配線 — `claude-sonnet-4`

1. `dispatchMissionNextTasks` のプロンプト構築(`:458-478`)を置換: `resolveMissionContextPack(missionId, role)` → `renderMissionContextPack(pack)` + タスク契約セクション(description / deliverable / acceptance_criteria / expected_output_format)+ 返答形式の指定(Task 2 のブロック仕様)。
2. パック構築失敗時は現行の thin 文字列にフォールバックし、`context_pack: degraded` を trace に記録(分配を止めない)。
3. パック生成のレイテンシを計測し、タスクごとに重い場合はミッション単位で生成してロール差分のみ適用するキャッシュを入れる。

### Task 2: 結果契約(構造化返答)— `claude-sonnet-4`

1. 返答ブロック仕様を定義し(`extractSurfaceBlocks` の既存ブロック機構に `task_result` ブロックを追加)、スキーマを `schemas/` に置く。必須: summary(3 文以内)/ artifacts / verification_done / gaps / needs。
2. dispatch プロンプトの末尾に「返答は task_result ブロックで。**作業ログや ファイル全文を貼らない**。結論・成果物パス・検証内容・残ギャップのみ」と明記する。
3. ブロック欠落/スキーマ不合格の応答は 1 回だけ「task_result 形式で再送せよ」と再要求し、それでも欠落なら受入ゲートで fail 扱い。
4. unit test: 正常ブロック/欠落→再要求/不正スキーマ。

### Task 3: needs の 1 往復解決 — `claude-sonnet-4`

1. `task_result.needs` が非空の場合: (a) 要求がパック内で解決可能(存在するがロール外だった情報)なら redaction を一時緩和した補強パックを添えて 1 回だけ再依頼、(b) 解決不能なら `blocked(needs_input)` + owner へ質問を転送(question-resolver の既存質問経路に乗せる)。
2. 往復は 1 回上限(無限の聞き返しループを作らない)。上限到達は blocked。
3. テスト: (a)(b) 両経路。

### Task 4: 観測 — `claude-haiku`

- 分配ごとに `context_chars / pruned / rollup_used / result_schema_ok` を trace に記録し、reconciliation サマリに「平均コンテキストサイズ・needs 発生率」を 1 行追加する。

## 実装メモ

### Task 4 slice — 2026-07-04

- `dispatchMissionNextTasks` の各 task result から context サイズと needs 件数を集計し、`MISSION_FOLLOWUP_DISPATCHED` に平均値と rate を記録するようにした。
- `mission_controller record-task` 経路で `LATEST_TASK.json` に owner 向けの一行サマリが残るようにした。

## リスクと注意

- パックの 6,000 字予算はタスクによっては不足する。予算は process template(MO-01)側でクラス別に上書き可能にする(research 系は広め等)。ただし上限撤廃はしない — 足りない分は `needs` 経路で取りに来させるのが原則。
- redaction の一時緩和(Task 3a)は tier 境界を越えてはならない。緩和対象は同 tier 内のロールスコープのみで、tier-guard の検査は通常どおり適用されることをテストで固定する。
