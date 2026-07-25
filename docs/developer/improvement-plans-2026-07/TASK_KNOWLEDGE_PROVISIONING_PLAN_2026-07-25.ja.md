# タスク知識配給計画 — 担当エージェントへ「必要十分」なナレッジを渡す(KP-01〜07)

> **作成日**: 2026-07-25
> **優先度**: P1(KP-01/02/03/05)/ P2(KP-04/06/07)
> **位置づけ**: MO-04(context pack 配布)・KM-01〜04(揮発メモリ活性化・検索品質・昇格ガバナンス・ストア衛生)の**後続ループ**。前提はすべて DONE([STATUS](./STATUS.ja.md))。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 0. 要旨

MO-04 / KM 系の完了で「ナレッジを検索して context pack として配る」土台はできた。しかし現状は **(a) 配給経路によって装備水準がバラバラ**、**(b) 選定が一律 top-3 でタスクの規模・役割に較正されない**、**(c) 配ったナレッジが役立ったかの帰還信号がゼロ** の3点で、「タスクを実行するのに必要十分で生産性が高い」状態には達していない。本計画は、**配給(delivery)を単一のサービス面に統一し、配置(placement)をタスクプロファイル宣言で駆動し、メンテナンス(curation)を利用実績で駆動する** 閉ループを作る。

```
配置(KP-03,07)          配給(KP-01,02,04)             帰還(KP-05)
knowledge/ + taxonomy ──▶ provisionTaskKnowledge() ──▶ worker 実行
  ▲   slices 宣言           全経路が同一入口             task_result.knowledge_feedback
  │                                                       trace.knowledgeRefs
  └────────── キュレーション(KP-06) ◀── delivered/used 集計・鮮度 SLO ──┘
```

## 1. 診断(2026-07-25、origin/main `00485737` で実コード突合)

### 1.1 配給経路が3つあり、装備水準が不均一

| 経路                                   | 実装                                                                                                        | ナレッジ装備                                                                                                                                                                                                                |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 単発 dispatch(既定)                    | `dispatchPlannedMissionTask` → `buildTaskExecutionPrompt`(`libs/core/mission-orchestration-worker.ts:1242`) | **最厚**。mission goal 行 + working principles 注入(KC-08)+ context pack(knowledge_hints top-3・220字抜粋・6,000字予算)                                                                                                     |
| Goal-driven(KD-01, opt-in)             | `dispatchGoalDrivenMissionTask` → `runGoalDrivenWorkItem`(同 `:2081-2086`)                                  | **最薄**。`systemPrompt`/`turnPrompt` 引数は存在する(同 `:1929-1932`)のに**渡していない**ため context pack 非添付。objective は `task.description` のみ(KD-04 枠付けは有り)。多ターン自律実行で最も知識を要する経路が最も裸 |
| `delegateTask`(review/repair/voice 等) | `anthropic-reasoning-backend.ts:814`                                                                        | `Context: {ctx}\n\nTask: {instr}` の素文字列連結。構造化ナレッジ添付なし。呼び出し側(`background-review-runner.ts` / `adf-repair-agent.ts` / `autonomous-repair.ts` 等)が各自恣意的に context を組む                        |

### 1.2 選定が「必要十分」に較正されない

- `loadKnowledgeHintsIfPossible`(`libs/core/mission-context-pack.ts:948-1004`)は mission_type + team_role + 各種テキストから topic を合成し `findRelevantDistilledKnowledge({limit:3, minScore:0.08})` を呼ぶだけ。**タスク規模(`estimated_scope` S/M/L)・役割の知識要求・タスク種別に依らず一律 top-3**。
- frontmatter には `role_affinity` / `phase` / `applies_to` が存在する(762 md 中 555 が frontmatter 保有)が、KM-02 が選定信号に昇格させたのは `last_updated`/`doc_authority`/`scope` まで。**「この役割のこの phase のタスクには必ずこの文書」というピン留め宣言の置き場がない**。
- `task_guidance`(受入条件・出力契約・検証手順の fast-lane 圧縮)は fast-tier model hint のときだけ生成(`mission-context-pack.ts:401`)。

### 1.3 帰還信号がゼロ → メンテナンスが「量の管理」しかできない

- trace の `knowledgeRefs` はスキーマ上存在するが実運用でほぼ空(`active/shared/logs/traces/*.jsonl` 全件 `"knowledgeRefs":[]`)。
- `task_result` スキーマに「どのヒントを使った/足りなかった」を返す欄がない。
- 結果、メンテナンスは rotate max 100(`feedback-loop.ts`)・`HINTS_MAX_SECTIONS = 50`(`promoted-memory.ts:90`)という**件数上限のみ**。どのナレッジが実際に生産性へ寄与したかを知る手段がなく、「効くナレッジを残し、効かないものを退役させる」判断ができない。

### 1.4 corpus 純度の残穴(KM-04 のガード外)

- auto-distilled 文書にプレースホルダが混入: `knowledge/product/evolution/distill_msn-media-review-fix-20260720_2026_07_20.md:18-25` は「None extracted automatically (policy fallback)」のまま検索 corpus に載りランキングを汚す。
- persistent tier へのテスト書き込みが実在: `knowledge/personal/my-identity.json` が 73 byte の `{"sovereign":"test"}`(2026-07-24 生成)。KM-04 の CI ガードは `MSN-TEST-*` 系ミッション汚染が対象で、`knowledge/personal/` と `HINTS.md`(重複 test fixture 残存)は守られていない。

## 2. 目標アーキテクチャ

1. **配給の単一入口**: `provisionTaskKnowledge(contract, recipient)` を `@agent/core` に新設し、単発 dispatch・goal-driven・`delegateTask` の3経路すべてが同じ選定・予算・記録ロジックを通る。経路ごとの差は「レンダリング形態」(pack 全文 / systemPrompt / context 文字列)だけに縮退させる。
2. **配置はタスクプロファイル宣言で駆動**: `knowledge-slices.json`(taxonomy 拡張)に `team_role × phase × mission_type → {pinned 文書, 検索対象サブツリー, 除外}` を宣言。frontmatter `role_affinity`/`phase`/`applies_to` を選定信号に昇格。
3. **必要十分の較正**: `estimated_scope` 連動のヒント数/文字予算、worker の `needs[]`/`gaps` を起点とした**追加配給(2巡目 retrieval)**。
4. **帰還ループ**: 配給内容を trace `knowledgeRefs` に記録し、`task_result` に `knowledge_feedback` を追加。delivered/used 集計を KM-03 の occurrence 基盤に接続。
5. **メンテナンスは有効性主導**: 週次キュレーション pipeline(低効率ヒントの降格候補化・knowledge_steward 承認)+ kind 別鮮度 SLO + corpus 純度ガード拡張。

## 3. 実装タスク

### KP-01: 配給 API の単一化と goal-driven 経路への接続

> 優先度 P1 / 規模 M / 依存: MO-04・KD-01(実装済み)

`resolveMissionContextPack` + `renderMissionContextPack` の呼び出し部(`mission-orchestration-worker.ts:1605-1642`)を `provisionTaskKnowledge(contract, recipient, {form: 'pack'|'system_prompt'|'context_string', budgetChars})` として抽出し、`dispatchGoalDrivenMissionTask` から `runGoalDrivenWorkItem` へ `systemPrompt`(= role-scoped 圧縮レンダリング)を渡す。goal loop は毎ターン再送しない(KD-08 プロンプトキャッシュ規律に従い stable prefix に置く)。

**受入条件**

1. goal-driven タスクの初回ターン prompt に context pack 由来の knowledge hints / mission summary が含まれることを hermetic テストで固定。
2. 単発 dispatch の既存出力(golden)が不変であること(リファクタのみ)。
3. pack は従来どおり `<mission>/coordination/context-packs/` に保存され、goal 経路でも `saveMissionContextPack` が呼ばれる。

— claude-sonnet-4

### KP-02: `delegateTask` の構造化ナレッジ装備

> 優先度 P1 / 規模 S / 依存: KP-01

`ReasoningBackend.delegateTask(instruction, context?, options?)` の呼び出し側標準を「素文字列 context」から「`provisionTaskKnowledge(…, {form:'context_string'})` で組んだ context」へ移行する。第一弾は `background-review-runner.ts` と `adf-repair-agent.ts`(repair 時に該当 op の contract 文書・過去の同型 incident ヒントを添付)。backend インターフェースは変更しない(呼び出し規約の統一のみ)。

**受入条件**

1. 上記2呼び出し元の context に knowledge 由来セクションが含まれるテスト。
2. ナレッジ取得失敗時は従来の素 context に fail-open(委譲自体を止めない)。

— claude-sonnet-4

### KP-03: タスクプロファイル駆動の知識スライス(データ配置戦略)

> 優先度 P1 / 規模 M / 依存: KM-02(実装済み)。スキーマ設計は opus、実装は sonnet

`knowledge/product/governance/knowledge-slices.json`(+ `product/schemas/knowledge-slices.schema.json`)を新設し、`team_role × phase × mission_type`(ワイルドカード可)ごとに:

- `pinned`: 常に配給する文書(例: implementer × execution → 該当 actuator の contract 文書、reviewer × review → artifact_review_profile 対応チェックリスト)
- `search_roots`: 検索を優先するサブツリー(taxonomy `retrieval_priority` の上書き)
- `exclude`: 配給対象外(例: `product/evolution/` の未レビュー auto-distilled)

を宣言する。`loadKnowledgeHintsIfPossible` は slice 解決 → pinned を先頭固定 → 残予算で検索、の順に変更。あわせて frontmatter `role_affinity`/`phase`/`applies_to` を `knowledgeMetadataScore()`(KM-02)の信号に追加する。**配置ルールの正**: 役割が実行時に必要とする文書は `knowledge/product/roles/<role>/` 配下または slice の `pinned` に登録し、それ以外は検索に委ねる — 「どこに置けば届くか」を書き手が推測しなくてよい状態にする。

**受入条件**

1. slice 宣言の schema validate が CI(`governance` チェック)に載る。
2. implementer/execution の代表タスクで pinned 文書が hints 先頭に来る hermetic テスト。
3. slice 未定義の組には従来動作(後方互換)。
4. `docs/GLOSSARY.md` に「knowledge slice」を追記。

— 設計 claude-opus / 実装 claude-sonnet-4

### KP-04: 必要十分の較正(規模連動予算と2巡目配給)

> 優先度 P2 / 規模 S / 依存: KP-01

- `estimated_scope` S/M/L に応じてヒント件数(例 2/3/5)と pack 文字予算を変える(現行は一律 top-3・6,000字)。
- `task_guidance` 生成を fast-tier 限定から全 tier に拡張(内容は tier で圧縮率を変える)。
- worker が `needs[]` / `gaps` を返したとき、MO-04 の「1回の補強」を **needs 文字列を query にした targeted `queryKnowledge` 再検索 + 差分配給**に拡張する(現在は手持ち情報の再送のみ)。

**受入条件**

1. scope 別の件数/予算がテストで固定される。
2. `needs` に「◯◯の手順が不明」を返す fake worker に対し、2巡目 prompt へ該当文書の抜粋が追加されることを hermetic テストで確認。
3. 予算超過時の roll-up(`pruneMissionContextPack`)経路が回帰しない。

— claude-sonnet-4

### KP-05: 配給テレメトリと knowledge_feedback(帰還ループの起点)

> 優先度 P1 / 規模 M / 依存: KP-01

- `provisionTaskKnowledge` が配給した文書 path + score を trace span の `knowledgeRefs` に記録する(現状ほぼ空の欄を実データで埋める)。
- `task_result` スキーマ(`renderStructuredOutputSchemaPrompt('task_result')` の対応 schema)に任意フィールド `knowledge_feedback: {used: string[], not_used: string[], missing_topics: string[]}` を追加し、worker prompt の出力契約に1行で明記。
- 受信した feedback を `active/shared/runtime/feedback-loop/` 配下に `delivered/used/missing` の集計レコードとして永続化し、KM-03 の `occurrences`/`last_seen` 基盤に接続する。`missing_topics` は既存の memory-promotion-queue へ「知識ギャップ候補」として enqueue する(蒸留対象の指名)。

**受入条件**

1. 配給ありのタスク trace に `knowledgeRefs` が非空で記録される統合テスト。
2. feedback 無し(旧形式 task_result)でも parse が壊れない後方互換テスト。
3. `missing_topics` が promotion queue に candidate として現れる hermetic テスト。

— claude-sonnet-4

### KP-06: 有効性主導キュレーションと鮮度 SLO(メンテナンス計画)

> 優先度 P2 / 規模 M / 依存: KP-05

- **週次キュレーション pipeline**(`pipelines/` に新設、`schedule.cron` 付き — KM-01 の chronos 配線を利用): delivered/used 集計から (a) 配給回数≥N で used 0 のヒント、(b) kind 別鮮度 SLO 超過文書(governance: 90日 / playbook: 60日 / hint: 30日、`last_updated` 基準)を抽出し、**降格・再検証候補レポート**を生成して knowledge_steward へ回す。自動削除はしない(KM-03 のガードレール踏襲: 昇格も降格も人間/steward の承認を経る)。
- 承認された降格は KM-03 の supersede 記録で処理し、`product/hints/archive` へ退避。
- レポートは `HINTS.md` と同様に Recovery/Alignment phase から参照可能な固定パスに置く。

**受入条件**

1. 集計→候補抽出→レポート生成が stub backend で決定論的に回る hermetic テスト。
2. SLO 閾値が config(taxonomy 拡張)で宣言され、ハードコードされない。
3. `knowledge/product/roles/knowledge_steward/PROCEDURE.md` に週次運用手順を追記。

— claude-sonnet-4

### KP-07: corpus 純度ガードの拡張(KM-04 の残穴)

> 優先度 P2 / 規模 S / 依存: KM-04(実装済み)

- auto-distilled 文書のうちプレースホルダ(「None extracted automatically」等の fallback 文言)を検知し、検索 corpus から除外(KP-03 の `exclude` 既定値)+ 週次レポート(KP-06)で削除候補化。
- persistent tier(`knowledge/personal/` / `knowledge/confidential/`)と `HINTS.md` へのテストフィクスチャ混入検知を KM-04 の CI ドリフトチェックに追加(検知パターン: test 由来 slug、`"sovereign": "test"` 型のプレースホルダ値、重複セクション)。
- 現存する汚染(`knowledge/personal/my-identity.json` の test fixture、`HINTS.md` の重複 `MSN-TEST-AUTOPROMOTE` エントリ)の棚卸しと修復はこのタスクの受入に含める(ただし identity の再生成はオンボーディング手順に委ね、勝手に上書きしない)。

**受入条件**

1. プレースホルダ distill が hints にランクインしない回帰テスト。
2. CI で fixture 混入がドリフトとして検知される(意図的な fixture を置くテスト)。
3. 棚卸し結果が STATUS 追記に記録される。

— claude-haiku(検知パターン横展開)/ 初回 claude-sonnet-4

## 4. 実施順序

```
KP-01(配給 API 統一 + goal-driven 接続)   ← 最初。以降の全タスクの土台
  ├─ KP-02(delegateTask 装備)
  ├─ KP-04(規模連動予算・2巡目配給)
  └─ KP-05(テレメトリ・feedback)
KP-03(知識スライス宣言)                    ← KP-01 と並行可(選定側の強化)
KP-06(週次キュレーション)                  ← KP-05 のデータが前提
KP-07(純度ガード)                          ← 独立。いつでも先行可
```

## 5. 非目標

- embeddings バックエンドの新規導入・全文 RAG 基盤・外部ベクトル DB(KM-02 の範囲を超える検索基盤刷新はしない)。
- `knowledge/` ディレクトリ構造・tier モデルの再編(taxonomy への**追記**のみ。移動を伴う再配置は KP-06 のレポートを見てから別計画で判断)。
- 昇格/降格の自動実行(KM-03 ガードレール「confidential/public への自動昇格禁止」を降格側にも適用し、steward 承認を必須とする)。
- `ReasoningBackend` インターフェースの変更(KP-02 は呼び出し規約の統一のみ)。

## 6. 関連計画

- [MO-04_WORKER_CONTEXT_ECONOMY](./MO-04_WORKER_CONTEXT_ECONOMY.ja.md) — context pack 配布(DONE)。本計画はその配給先の拡大と帰還ループ化。
- [KM-01](./KM-01_VOLATILE_MEMORY_ACTIVATION.ja.md)〜[KM-04](./KM-04_KNOWLEDGE_STORE_HYGIENE.ja.md) — 揮発メモリ・検索品質・昇格ガバナンス・ストア衛生(すべて DONE)。KP-03/05/06/07 はこれらの基盤に直接積む。
- [KIMI_CODE_ADOPTION_PLAN(KD-01/04/08)](./KIMI_CODE_ADOPTION_PLAN_2026-07-20.ja.md) — goal-driven 実行・untrusted 枠付け・プロンプトキャッシュ規律。KP-01 は KD-01 経路の装備、KD-08 の stable-prefix 規律に従う。
- [HO-01_HANDOFF_PACKETS](./HO-01_HANDOFF_PACKETS.ja.md) — phase 間引き継ぎ。KP は task 単位の配給に閉じ、phase 間は HO の範囲。
