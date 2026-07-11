# AR-02: op レジストリの単一真実源化 — 4系統ドリフトと silent no-op の解消

> 優先度: **P0** / 規模: M / 依存: なし / 関連: AC-01(能力プローブ)、AR-06(no-op 修正)、AR-03(per-op スキーマ)
> **検証(2026-07-03, Fable)**: op-registry は `domains` + `shared_{capture,transform,apply}_ops` 構造。`global_actuator_index.json` は compact 形式で **op を列挙しない**(counts のみ)。file-pipeline-helpers に `default: return ctx;`(:178/:237/:249)= **未知 op が silent no-op**、を確認。

## 背景と課題

「どの op が存在するか」の真実源が**4つあり、どれも一致しない**。

1. `knowledge/product/governance/actuator-op-registry.json` — 唯一の消費者は `actuator-op-registry.ts:35`(step の type を capture/transform/apply に決める)。**13ドメインのみ**で17アクチュエータは domain 未登録。
2. 各 `manifest.json` の `capabilities[]`。
3. `schemas/*-pipeline.schema.json` / `*-action.schema.json`(op enum のことも自由形式のことも)。
4. dispatch の `switch`(実挙動)。

### 実害: silent no-op(検証済み)

op-registry ↔ code のドリフトで、`determineActuatorStepType('file','stat')` が file domain にも shared pool にも `stat` を見つけられず既定 `'apply'` に落とす → file エンジンが `opApply` に回すが switch に `stat` case が無く **`default: return ctx;`(:237/:249)で status=success のまま何もしない**。`exists`/`tail` も同様。**「成功したのに無反応」**が最悪の体験。

### 発見可能性が全 hop で壊れる

`global_actuator_index.json` は op を列挙せず(compact/counts のみ、検証済み)→ 各 manifest を開く → 大半の op は `schema_ref: None` → actuator の `contract_schema` は陳腐化(wisdom)or 自由形式 → 実挙動は switch のみ。`CAPABILITIES_GUIDE.md` は system-actuator の op しか表にしない(AC-01 と連結)。

## ゴール(受入条件)

1. **dispatch の switch を単一真実源**とし、そこから op-registry / manifest capabilities / CAPABILITIES op 表を**生成**する(手書きドリフトの排除)。
2. `determineActuatorStepType` の分類が生成 registry に基づき、**未知 op の誤分類→silent no-op が起きない**(AR-06 と連携: 未知 op は error)。
3. `global_actuator_index.json` が**op を列挙**する(発見可能性の回復)。
4. 生成物とコミット済みの一致を CI(`check:catalogs` 系)で検証。

## 実装タスク

### Task 1: dispatch からの op 抽出 — `claude-sonnet-4`

1. 各アクチュエータの dispatch switch(envelope 型は sub-op、verb 型は action)を機械抽出する仕組みを作る。手法: (a) 各アクチュエータに `describeOps(): OpSpec[]` を実装させ registry を自己申告させる(推奨、堅牢)、or (b) AST で switch の case を抽出(脆い)。(a) を採る。
2. `OpSpec = { op, kind: capture|transform|apply|control, summary, schema_ref? }`。

### Task 2: 生成スクリプトと CI ゲート — `claude-sonnet-4`

1. `scripts/generate_op_registry.ts`: 全アクチュエータの `describeOps()` を集約し `actuator-op-registry.json`・`global_actuator_index.json`(op 列挙付き)・CAPABILITIES op 表を生成。
2. `check:catalogs` に「生成結果 == コミット済み」検査を追加(ドリフトで fail)。AC-01 の manifest 生成と統合。

### Task 3: 分類の修正 — `claude-sonnet-4`

1. `determineActuatorStepType`(`actuator-op-registry.ts:35`)を生成 registry ベースにし、**未知 op は既定 apply に落とさず「未知」を返す**。呼び出し元(engine)は未知を AR-06 の error 経路へ。
2. file の `stat`/`exists`/`tail`/`write_artifact` 等、registry と code の既知ドリフトが解消することをテストで固定。

**進捗メモ(2026-07-06)**: 既定 `apply` フォールバックは除去済み。未知 op は `actuator-op-registry.ts` で `[UNKNOWN_OP]` として失敗し、`super-nerve` からもそのまま failed に伝播する。

**進捗メモ(2026-07-06 追記)**: `system-actuator` で `describeOps()` を切り出し、`scripts/generate_op_registry.ts` で `actuator-op-registry.json` と `actuator-op-discovery.json` を再生成できるようにした。まだ全アクチュエータ self-describe 化は未完了だが、生成パイプラインの実行路は確立した。

### Task 4: 発見可能性ドキュメント — `claude-haiku`

- `global_actuator_index` と CAPABILITIES を生成物に切替。`docs/GLOSSARY`/`CAPABILITIES_GUIDE` から「op の探し方(生成 index → per-op schema)」を1段落で案内。

## リスクと注意

- `describeOps()` を全アクチュエータに実装するのは横展開作業(AR-01 のアダプタ化と同時が効率的)。1件でパターン確立 → haiku 横展開。
- 生成に切り替えると手書きの有用な注記が失われ得る。生成前後の diff を確認。
- AC-01(能力プローブ)と生成基盤を共有する(manifest + prerequisites + op を同じ生成器で)。

**進捗メモ(2026-07-12)**: `describeOps()` の横展開を完了 — file / network / code / modeling / wisdom / browser に `op-catalog.ts` を新設(dispatch switch の case と1:1、wisdom は decision-ops の48 op も apply として申告、browser の `extension_session` は index レベル特例 op として収載)。`generate_op_registry.ts` は self-describe テーブル(7アクチュエータ + media は manifest)から registry / discovery を生成し、**手書きだった registry の虚偽エントリを一掃**(例: file の `symlink` は case が存在せず UNKNOWN_OP になる宣言だった、code の `apply_pattern`/`merge_content` 等も同様)。`goto` の capture/apply 二重掲載は分類が apply に反転するため catalog 側で capture に正準化。discovery は +591 行(全 op 列挙 + input_schema)。残: 未 self-describe のロングテール アクチュエータ(agent/artifact 等、pipeline エンジン非搭載系)と CAPABILITIES op 表の生成切替。
