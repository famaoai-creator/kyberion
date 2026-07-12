# HN-01: モデル階層の実効化と軽量モデル活用の規律

> 優先度: P1 / 規模: M / 依存: MO-05(タスク単位ルーティング)、IP-13(モデルID一元化) / 関連: [ORCHESTRATION_HARNESS_MODEL](../ORCHESTRATION_HARNESS_MODEL.ja.md) §7/§8
>
> **参考にしたハーネス原則(Fable 5)**: モデルとエフォートはタスクごとに選ぶ — 機械的横展開=軽量・低エフォート、標準実装=中位、設計判断/審判/敵対検証=上位・高エフォート。**強いモデルは雑な依頼を補完するが軽量モデルは補完しない**ので、軽量モデルほどブリフ自己完結度・スコープの狭さ・検証の厳格さを上げる。
>
> **⚠ 重複解消(2026-07-03 レビュー): ルーティング機構(`resolveTaskModelHint` の新設・`thinking:'adaptive'` ハードコード解消・shadow→enforce)は MO-05 が単独オーナー**。HN-01 はそれを**前提**に、軽量モデル特有の規律のみを担う: (a) model-registry への tier 定義追加、(b) `fast` tier タスクへの自動強化(schema 必須化・検証厳格化)、(c) パターン確立→横展開の seed 添付。**Task 1/2 の routing/effort 実装は MO-05 に委譲**し、本計画からは重複を削除する。

## 背景と課題

- **モデル階層が定性バンドのみ**: `model-registry.json` は `cost_band`(high/medium)・`latency_band`・role_fit を持つが、**small/standard/large の tier も $/token も無い**(HN 確認 §1)。「機械的=安価、判断=強力」は `REACTION_FAST→gpt-5.4-mini` の shadow マッピングに sketch されるだけで dispatch では効かない。
- **effort が固定**: `anthropic-reasoning-backend.ts` で `thinking:{type:'adaptive'}` が 10 箇所ハードコード。per-task の effort/budget パラメータが無い(HN 確認 §4)。
- **軽量モデル活用の設計規律が無い**: 軽量モデルにタスクを渡す時に「スコープを狭める・良質例で seed する・出力を構造で縛る・検証を厳格化する」という規律が仕組みとして無い。現状 worker には薄い自由文字列が渡り(MO-04)、出力は自由テキストで受理される(HN-02)。

## ゴール(受入条件)

1. モデルレジストリに**明示的な tier**(例: `fast`/`standard`/`deep`)と、可能なら $/token(OP-01 のコスト計算と共有)が付く。
2. `risk × estimated_scope × phase_kind` から **tier + effort ヒント**が決定論的に導出され(MO-05 の resolveTaskModelHint を拡張)、`KYBERION_TASK_MODEL_ROUTING=enforce` で実 dispatch に効く。effort が backend に伝搬する(adaptive ハードコード解消)。
3. **軽量モデル向けタスクの自動強化**: tier が `fast` のタスクは、(a) context pack の受入条件をより具体化、(b) 出力を schema-forced(HN-02)必須、(c) 検証を一段厳格化(敵対レビュー/動かす検証)する、という規律がパイプラインに組み込まれる。
4. 「パターン確立=上位、横展開=軽量」を支援する仕組み: 1 件目の成果物/diff を後続の軽量タスクの seed として自動添付できる。

## 実装タスク

### Task 1: tier と effort のレジストリ整備 — `claude-sonnet-4`

1. `model-registry.json` に `tier`(fast/standard/deep)を追加し、既存 cost_band と対応付け。可能なら per-1k コスト(OP-01 の model-cost-registry と統合、二重管理を避ける)。
2. `reasoning-model-routing.ts` の `resolveTaskModelHint`(MO-05 Task 1 で新設)に tier 解決を追加。tier→モデルは registry の tier + role_fit + 可用性で解決。
3. テスト: tier 解決、可用性フォールバック(不在なら 1 段上へ、下げない)。

### Task 2: effort のタスク単位制御 — `claude-sonnet-4`

1. `delegateTask`/`prompt` の入力(または dispatch のオプション)に `effort` を追加し、anthropic backend の `thinking` ハードコード(10 箇所)を effort 連動に置換。他 backend は対応可能なら伝搬、不可なら無視(既定動作)。
2. tier ヒントから effort を導出(fast=low、deep=high)。既定はセッション/backend 既定を継承。
3. テスト: effort 指定が backend に伝わること、未指定の後方互換。

### Task 3: 軽量モデルタスクの自動強化 — `claude-sonnet-4`

1. dispatch(MO-03/MO-04 経路)で、tier が `fast` のタスクに対し: context pack の受入条件セクションを必須化・具体化、出力 schema(HN-02)を必須指定、検証段階(MO-02 受入ゲート)を一段厳格(動かす検証 or 敵対レビュー)にする規律を適用する。
2. この強化は「軽量モデルの成果ほど疑う」原則の実装。tier=standard/deep では既定の検証強度。
3. テスト: fast タスクで schema 必須 + 厳格検証が適用されること。

### Task 4: パターン→横展開の seed 添付 — `claude-sonnet-4`

1. 同一パターンの連続タスク(例: 同型ファイルの一括変換)で、先行タスク(上位モデル)の成果物/diff を後続タスク(軽量モデル)の context pack に「手本」として自動添付する仕組み。MO-07 Task 5 の品質ランク再利用と統合。
2. planner が「これは横展開バッチ」と判定した場合に発動(MO-01 のプロセステンプレートにバッチ相を定義)。
3. テスト: 横展開バッチで先行 diff が後続に添付されること。

## リスクと注意

- tier の誤割当(判断タスクを fast に)は品質を落とす。enforce は MO-05 と同様に shadow 観測(precision 確認)後に段階導入。まず `fast` の機械的タスクのみ enforce。
- effort を上げるとコストが増える。OP-01 の予算上限と連動し、deep+high は高リスク/strict のみ。
- 「軽量モデルタスクの自動強化」は検証コストを足す。fast タスクは本来安価なので、強化(schema + 検証)を足しても全体では上位モデル単発より安い、というバランスをコスト集計(OP-01)で確認する。

## 実装メモ

### Task 1 slice — 2026-07-04

- `knowledge/product/governance/model-registry.json` に `execution_tier` (`fast` / `standard` / `deep`) を追加し、`reasoning-model-routing.ts` の `resolveTaskModelHint` が `execution_tier` を返すようにした。
- `libs/core/reasoning-model-routing.test.ts` で `execution_tier` の決定論性を固定した。

### Task 3 slice — 2026-07-04

- `scripts/refactor/mission-workitem-dispatch.ts` で fast-tier タスクを自動強化し、work item prompt に fast-tier 指示を追加した。
- fast-tier の完了扱いは `verification_done` と `artifacts` / `needs` を組み合わせて厳格化し、完了報告が薄い場合は review に落ちるようにした。
- `scripts/refactor/mission-workitem-dispatch.test.ts` で fast-tier の prompt 追加と検証不足時の review 化を固定した。

### Task 4 slice — 2026-07-04

- `libs/core/mission-context-pack.ts` で fast-tier context pack に、同一 mission の過去 work item dispatch の response / reflection を seed として自動添付するようにした。
- `libs/core/mission-context-pack.test.ts` で prior work item 出力が `task_guidance.seed` に入ることを固定した。
