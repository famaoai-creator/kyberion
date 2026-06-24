---
title: 意図駆動 文書/メディア生成自動化（学習→再生） media アダプタ実装設計
kind: design-specification
scope: libs/core, libs/actuators/media-actuator, knowledge/product/pipeline-templates, pipelines
authority: proposed
status: draft
owner: ecosystem_architect
reviewed_at: 2026-06-23
depends_on:
  - docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md   # マスター設計（substrate 中立な §6 契約・Layer①/④・昇格機構）
  - docs/INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md   # 兄弟アダプタ
tags: [media, pptx, document-generation, theme, preference-profile, intent-loop, approval, adapter]
---

# 意図駆動 文書/メディア生成自動化 — `substrate: "media"` アダプタ設計

> **本書はマスター設計の adapter 仕様**。substrate 中立に凍結した **§6 契約・Layer①（意図解決）・Layer④（自己修復）・昇格機構（`distill-candidate-registry`）は再利用**し、本書は **media 固有のアダプタだけ**を規定する。
> 扱うのは「**この体裁で月次レポートを作っておいて**」のような文書/スライド生成。
> ⚠️ media は他アダプタと性質が違う：**「UI操作の再生」ではなく「お手本（例文書＋ブリーフ）から生成レシピを学習して次回適用」**。抽出・嗜好登録・承認ゲートは既存。**欠けているのは結晶化ループだけ**。

---

## 1. 位置づけ（再利用するもの／新規に作るもの）

| 要素 | 出所 | 扱い |
|---|---|---|
| §6 契約・Layer①・Layer④・昇格機構 | マスター（substrate 中立） | **再利用** |
| 抽出（例文書→design protocol/theme） | 既存 `media:pptx_extract`(`distillPptxDesign`), `media:theme_from_pptx_design`(`deriveThemeFromPptxDesign`) | **再利用** |
| レンダリング（生成） | 既存 `media:pptx_render`/`xlsx_render`/`docx_render`/`pdf_render`/`mermaid_render`/`d2_render`/`drawio_write`（`media-actuator`） | **再利用** |
| ブリーフ→設計の決定論コンパイル | 既存 `media:brief_to_design_protocol` 等 | **再利用** |
| 嗜好プロファイル登録 | 既存 `registerPresentationPreferenceProfile`（`presentation-preference-registry.ts`、`knowledge/personal/orchestration/...`） | **再利用** |
| ブランド/テーマ保存 | 既存 `media:save_brand_to_confidential`（`knowledge/confidential/{tenant}/design/`） | **再利用** |
| 文書生成の承認ゲート | 既存 `claude:document_generation`（approval-policy 済み） | **再利用** |
| **結晶化ループ（「この体裁で」を再利用 pipeline へ蒸留）** | — | **新規（本書 §6・§7-③、media の唯一の本質的欠落）** |

**結論**：media は部品が最も揃っている。新規は「**お手本→再利用生成 pipeline の蒸留**」と「media 用 distill 評価器」だけ。実行・抽出・嗜好登録・承認は既存。

---

## 2. 目標・非目標

### 目標
1. 「この体裁/この前回資料のように作って」という意図から、登録済みの**生成レシピ（テンプレ＋テーマ＋ブリーフ構造）**を解決し、入力差分だけで再生成する（パターンB）。
2. 未学習時は、お手本文書とブリーフ回答から**再利用可能な生成 pipeline ＋嗜好プロファイル**を蒸留し登録（人間レビュー後、パターンA）。
3. 生成物の体裁が意図どおりかを **Golden（テーマ適用・構造）** で検証。
4. フィードバック（「色が違う」「章立て変えて」）を差分として嗜好プロファイル/レシピへ学習。

### 非目標
- 新しいレンダリング op（pptx/xlsx 等）は作らない。既存 `media:*` を組み合わせる。
- 外部配布物の生成は必ず `claude:document_generation` 承認を通す（既存）。勝手に外部送付しない。
- お手本に含まれる機密データ本文は学習対象にしない（学習するのは**体裁・構造・テーマ**であって中身ではない）。

---

## 3. media が他アダプタと違う点

| 観点 | browser/desktop/service | **media** |
|---|---|---|
| 「実演」の正体 | UI操作 or API呼び出しの**列** | **お手本文書＋ブリーフ回答**（成果物そのものが教師） |
| 学習対象 | 操作手順 | **体裁・構造・テーマ・ブリーフ質問セット**（中身ではない） |
| 録画機構 | UIイベント/API列の記録が必要 | 既存 `pptx_extract`/`theme_from_pptx_design` が**事実上の抽出器**。新規は「蒸留して再利用 pipeline にする」部分 |
| 再生 | UI/API を再実行 | **テーマ＋ブリーフを差し替えて再レンダリング**（`brief_to_design_protocol`→`*_render`） |
| 既存の到達点 | 録画は browser のみ | 抽出・嗜好登録・承認は**すべて既存**。欠落は結晶化ループのみ |
| Golden 検証 | DOM/レスポンス/スクショ | **テーマ適用の一致・章立て構造・ファイル生成** |
| リスク | アダプタごとに整備 | **`document_generation` が既に承認ゲート済み** |

---

## 4. パターンA/B（media 版の流れ）

```text
ユーザ意図「前回の体裁で月次レポート作っておいて」
   │ Layer①（共有） resolveProcedure(intent)
   ├─ matched (B) ─────────────────────────────┐
   │                                            ▼
   │                          [§7-C 実行アダプタ]
   │                          登録レシピを解決 → 嗜好プロファイル/テーマ適用 →
   │                          今回入力でブリーフ充填 → brief_to_design_protocol →
   │                          media:*_render（document_generation 承認）
   │                                            ▼
   │                          Golden 検証（テーマ/構造/生成）→ receipt
   └─ unmatched (A) ─┐
                     ▼
       [§6 抽出+蒸留] お手本 pptx を pptx_extract → theme_from_pptx_design、
                      ブリーフ質問セットを抽出（中身ではなく体裁・構造）
                     ▼
       [§7-③ コンパイラ] 再利用生成 pipeline へ蒸留（入力を {{input.*}} 一般化）
                      ＋ register_presentation_preference_profile
                     ▼
       人間レビュー → 昇格（distill-candidate-registry）→ procedures.json 登録
                     （= 次回からパターンB）
```

---

## 5. 不変条件（マスター §5 を継承）

- File I/O は `@agent/core/secure-io` のみ。tier 指定必須（テーマ/ブランドは原則 `confidential/{tenant}`、個人嗜好は `personal/`）。
- 外部配布物生成は `claude:document_generation` 承認を必ず通す（既存）。
- **学習対象は体裁・構造・テーマに限定**。お手本の機密本文を学習・転記しない。
- ミッション化必須（`scripts/mission_controller.ts`）。customer-facing なガバナンス証跡は dog-food 規則によりミッション/pipeline 必須。

---

## 6. media 抽出＋蒸留アダプタ（新規は「蒸留」のみ）

ブラウザの「録画」に相当する工程は、media では **(a) 既存抽出器 ＋ (b) 新規の蒸留** に分かれる。

- **(a) 抽出（既存再利用）**：お手本 pptx → `media:pptx_extract`（`distillPptxDesign`）→ `media:theme_from_pptx_design`（`deriveThemeFromPptxDesign` → `active_theme`）。Web お手本は `browser:snapshot`→`reasoning:synthesize`（既存 `extract-brand-theme.json` 経路）。
- **(b) 蒸留（新規・本書の中核）**：抽出結果＋ブリーフ回答を **`media-recipe.v1`** に正規化する。
  ```jsonc
  {
    "recipe_id": "report.monthly.sbisec",
    "substrate": "media", "kind": "media-recipe.v1",
    "render": { "format": "pptx", "render_op": "media:pptx_render" },
    "theme_ref": "knowledge/confidential/sbisec/design/theme.json", // save_brand_to_confidential 産
    "preference_profile_ref": "knowledge/personal/orchestration/presentation-preference-registry.json#report.monthly",
    "brief_schema": {                          // ブリーフの「質問セット」= 体裁の骨格
      "sections": ["サマリ", "実績", "課題", "次月計画"],   // 構造（中身ではない）
      "inputs": [
        { "name": "period", "label": "対象月", "type": "string" },
        { "name": "kpi_table", "label": "KPI", "type": "table" }
      ]
    },
    "golden_scenario_ref": "knowledge/.../golden/report-monthly.v1.json",
    "version": "1.0.0", "status": "active"
  }
  ```
- **redaction/方針**：`brief_schema` は構造と入力名のみ。お手本の実データ値は保存しない。テーマは既存 `save_brand_to_confidential` の保存方針に従う。
- **対象ファイル**：新規 `libs/core/media-recipe.ts`, 新規 `knowledge/product/schemas/media-recipe.schema.json`, 既存 `media-actuator`/`presentation-preference-registry.ts`（再利用）
- **受入条件**：お手本から theme＋brief_schema が抽出され recipe 化。実データ本文が recipe に残らない。嗜好プロファイルが `presentation-preference-registry` に登録される。

---

## 7. レイヤー別 設計（media 固有部分のみ）

### Layer① 意図解決 — **再利用（追加なし）**
`procedures.json` に `substrate:"media"` エントリ。`pipeline_ref` は蒸留で生成した生成 pipeline、`adapter` は recipe を指す。例：
```jsonc
{
  "procedure_id": "report.monthly.sbisec",
  "substrate": "media",
  "adapter": { "recorder": "media-distill", "executor": "media:pipeline", "recipe_ref": "report.monthly.sbisec" },
  "target": { "name": "Monthly Report (SBISEC)" },
  "intent_phrases": ["前回の体裁で月次レポート", "月次レポート作って", "monthly report like last time"],
  "pipeline_ref": "pipelines/media/report-monthly-sbisec.json",
  "required_inputs": [ { "name": "period", "label": "対象月", "type": "string" } ],
  "risk_class": "high",            // 外部配布物 → document_generation 承認
  "golden_scenario_ref": "knowledge/.../golden/report-monthly.v1.json",
  "version": "1.0.0", "status": "active"
}
```

### Layer③ コンパイラ（recipe→再利用生成 pipeline）
- **要件**：`media-recipe.v1` を、既存 media テンプレート（`meeting-to-pptx-workflow.json` の `brief→design→render` 構造）に倣った**再利用生成 pipeline** へ変換。
- **設計**：新規 `libs/core/media-recipe-compiler.ts`
  - 生成 pipeline の骨格：`(input 充填)` → `media:brief_to_design_protocol`（recipe の brief_schema＋theme を適用）→ `media:{format}_render` → 検証。
  - ブリーフの可変項目を `{{input.*}}` に一般化、固定の体裁（章立て・テーマ）は recipe から固定注入。
  - **dry-run / rehearsal**：レンダリングは副作用が小さい（ファイル生成）ので**実レンダリングを mission_evidence の一時領域に対して試走**し、(a) ファイル生成成功、(b) テーマ適用、(c) 章立て構造一致を確認。外部配布はしない。
  - `extractGoldenScenario`：テーマ色/フォント一致・章立て・生成ファイル存在を §6.4 形式で同梱。
- **対象ファイル**：`libs/core/media-recipe-compiler.ts`(新), `knowledge/product/pipeline-templates/automate-media-workflow.json`(新、既存 `meeting-to-pptx-workflow.json` を参考)
- **受入条件**：recipe から生成 pipeline が作られ、入力差分のみで再生成可能。dry-run で体裁一致を検証。draft は `_draft:true` で人手レビューまで昇格しない。

### Layer C 実行アダプタ — **既存 media op を再利用**
- **設計**：`procedure-dispatcher.ts`（共有）の media 分岐：`adapter.executor==='media:pipeline'` → 生成 pipeline を実行（`executeMediaPipeline`/`media-pipeline-helpers.ts` 経由）。レンダリング step は `claude:document_generation` 承認を通す。
- **対象ファイル**：`libs/core/procedure-dispatcher.ts`（media 分岐追加）, 既存 media-actuator（変更なし）
- **受入条件**：登録レシピが入力充填→設計→レンダリングまで通る。外部配布物生成は承認必須。

### Layer⑤ 承認ゲート — **既存 `document_generation` を再利用**
- media は MFA/lease 不要。代わりに **生成＝外部配布の可能性があるため `claude:document_generation` 承認（既存）を必ず通す**。社外提出物は特に dog-food 規則でミッション/pipeline 証跡を残す。
- **受入条件**：配布物生成が承認なしに完了しない。社内ドラフト（非配布）は設定で軽量化可。

### Layer④ 自己修復・差分学習 — **再利用＋嗜好プロファイル更新**
- フィードバック（「色」「章立て」「トーン」）を `ProcedureDelta` 化し、(a) recipe の `brief_schema`/`theme_ref` 更新、(b) `registerPresentationPreferenceProfile` で嗜好プロファイル更新（既存 API）。これが「使うほど自分の体裁に寄る」を実現。
- **設計**：`assessMediaDistillCandidate`（汎用 interface の media 実装）追加。`distill-candidate-registry.ts`＋`presentation-preference-registry.ts` を共有。
- **対象ファイル**：新規 `libs/core/media-distill-candidate.ts`, 既存 `distill-candidate-registry.ts`/`presentation-preference-registry.ts`（再利用）
- **受入条件**：「体裁を直した→次回から反映」を回帰再現。delta は人手レビュー無しに promoted/嗜好プロファイルを破壊的上書きしない。

---

## 8. リスク・承認

- **既存で充足**：`claude:document_generation` が `risky-op-registry.ts`／`approval-policy.json` で承認必須に分類済み。media アダプタはこれを踏襲するだけ（新規分類は原則不要）。
- 追加で配慮：テーマ/ブランドを `confidential/{tenant}` に保存する際の tier 越境防止（他テナントの design に書かない）。`save_brand_to_confidential` の tenant_slug を必ず明示。
- **受入条件**：配布物生成が承認を通る。テーマ保存が正しい tenant tier に限定される。

---

## 9. エージェント別 実装範囲（マスター §8 と整合）

| Agent | 担当 | owns | 依存（読むだけ） | 成果物 |
|---|---|---|---|---|
| **Agent-M1（Distill）** | §6 | `media-recipe.ts`, `media-recipe.schema.json` | §6 契約, media-actuator 抽出関数, preference-registry | お手本→recipe 蒸留＋嗜好登録 |
| **Agent-M2（Compiler）** | §7-③ | `media-recipe-compiler.ts`, `automate-media-workflow.json` | §6 契約, `meeting-to-pptx-workflow.json` 構造 | recipe→再利用生成 pipeline/dry-run/Golden |
| **Agent-M3（Dispatcher）** | §7-C, ⑤ | `procedure-dispatcher.ts` の media 分岐 | A の `ProcedureResolution`, `media-pipeline-helpers.ts` | 実行＋document_generation 承認 |
| **Agent-M4（Distill assessor）** | §7-④ | `media-distill-candidate.ts` | `distill-candidate-registry.ts`, `presentation-preference-registry.ts` | フィードバック差分学習 |
| **Agent-R（Reviewers）** | 横断 | （指摘のみ） | 全PR | §10 レビュー |

> `procedure-dispatcher.ts` は共有ファイル。**substrate 分岐で関数を分け、同一ブロックを編集しない**（マスター §9 準拠）。Layer①/④ 本体は browser チームの共有層。

起動プロンプト雛形：
> 「`docs/INTENT_DRIVEN_MEDIA_AUTOMATION_DESIGN.ja.md` の §1 再利用方針と担当 **Agent-MX** の §6〜§8 該当節・§9 owns 範囲だけを実装。マスター §6 凍結契約と不変条件（§5）厳守。**学習対象は体裁・構造・テーマに限定し、お手本の機密本文を転記しない**。配布物生成は `document_generation` 承認を通す。受入条件のテストを追加し `pnpm build`＋該当テスト green を確認して報告。」

---

## 10. レビュー観点（Agent-R）

| 観点 | 確認 |
|---|---|
| セキュリティ/機密 | recipe・嗜好プロファイルにお手本の機密本文が残らない（体裁・構造のみ）。テーマ保存が正しい tenant tier に限定。 |
| ガバナンス | 配布物生成が `document_generation` 承認を通る。social/外部提出は mission/pipeline 証跡。 |
| 契約整合 | マスター §6 凍結型に準拠。`substrate:"media"` が共有 resolver で解決。owns 外（Layer①/④ 本体）不変更。 |
| 不変条件 | secure-io 経由のみ。tier 指定必須。`Date.now()/Math.random()` 非依存。 |
| 再利用 | 既存 `media:*`/`brief_to_design_protocol`/`presentation-preference-registry` を再利用し、レンダリング op を新設していない。 |
| Golden 健全性 | テーマ適用・章立て・ファイル生成を検証。dry-run が外部配布を伴わない。 |

---

## 11. フェーズ計画

| フェーズ | 内容 | 受入条件 |
|---|---|---|
| **M0** | `media-recipe.schema.json` ＋ media エントリ例を §6 契約に追加 | スキーマ invalid が弾かれる |
| **M1 蒸留** | Agent-M1 | お手本→theme+brief_schema 抽出→recipe 化、機密本文非残留、嗜好登録。 |
| **M2 コンパイラ** | Agent-M2 | recipe→生成 pipeline、入力差分で再生成、dry-run で体裁検証、Golden 付与。 |
| **M3 実行＋承認** | Agent-M3 | レシピ実行が充填→設計→レンダリングまで通り、配布物は承認必須。 |
| **M4 自己修復** | Agent-M4 | 体裁フィードバック→次回反映を回帰。嗜好プロファイル非破壊更新。 |
| **M5 昇格** | owner | 1意図で前回体裁を再現生成・検証・報告。ミッション/pipeline 証跡化。 |

---

## 12. 着手前に owner が確定すべき事項

- 初手の対象成果物（推奨：頻出の月次/週次レポート pptx か、提案書）。
- recipe の保存 tier 既定（テーマ=`confidential/{tenant}`、嗜好=`personal/` が既定で良いか）。
- 蒸留の起点をお手本ファイル指定とするか、過去ミッションの生成証跡からの逆蒸留も許すか。
- 「体裁学習」と「本文生成」の境界線の運用ルール（本文は都度入力、体裁のみ学習）。

---

## 13. クロスリファレンス

- マスター（substrate 中立契約・Layer①/④）: `INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md`
- 兄弟アダプタ（API合成）: `INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md`
- 兄弟アダプタ（GUI操作）: `INTENT_DRIVEN_DESKTOP_AUTOMATION_DESIGN.ja.md`

> media は4アダプタ中**最も既存資産が揃っている**（抽出・レンダリング・嗜好登録・承認すべて在り）。本質的な新規は「お手本→再利用生成 pipeline の蒸留ループ」だけで、最短で価値を出せる候補。
