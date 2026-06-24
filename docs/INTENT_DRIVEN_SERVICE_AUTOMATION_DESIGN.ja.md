---
title: 意図駆動サービスAPI自動化（学習→再生） service アダプタ実装設計
kind: design-specification
scope: libs/core, libs/actuators/service-actuator, knowledge/product/orchestration/service-presets, pipelines
authority: proposed
status: draft
owner: ecosystem_architect
reviewed_at: 2026-06-23
depends_on:
  - docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md   # マスター設計（substrate 中立な §6 契約・Layer①/④・昇格機構）
tags: [service-preset, intent-loop, capability, pipeline, approval, multi-agent, adapter]
---

# 意図駆動サービスAPI自動化 — `substrate: "service"` アダプタ設計

> **本書はマスター設計（`INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md`）の adapter 仕様**である。
> マスターで substrate 中立に凍結した **§6 共有契約・Layer①（意図解決）・Layer④（自己修復）・昇格機構（`distill-candidate-registry`）は再利用**し、本書は **service 固有のアダプタ（録画・コンパイル・実行・認証ゲート）だけ**を規定する。
> 「勤怠承認」がブラウザ手順だったのに対し、本書が扱うのは例えば「**起票してSlack通知してBoxに格納しておいて**」のような**複数SaaSにまたがるAPI操作列**。

---

## 1. 位置づけ（再利用するもの／新規に作るもの）

| 要素 | 出所 | 本書での扱い |
|---|---|---|
| §6 手順エントリ／`ProcedureResolution`／`ProcedureDelta`／Golden 契約 | マスター §6（substrate 中立） | **そのまま再利用**。`substrate:"service"` で埋める |
| Layer① 意図解決 `resolveProcedure()` | マスター §7 Layer① | **そのまま再利用**（service エントリも同じ resolver で引ける） |
| Layer④ 自己修復・差分学習 / 昇格 | マスター §7 Layer④ ＋ `distill-candidate-registry.ts` | **そのまま再利用**。service 用評価器だけ追加 |
| パターンA/B 分岐・しきい値 | マスター §6.2 | **そのまま再利用** |
| **録画アダプタ（service-call 列の記録）** | — | **新規**（本書 §6） |
| **コンパイラ（param一般化・secret束縛）** | — | **新規・ただし簡素**（ref→selector が不要、本書 §7-③） |
| **実行アダプタ** | 既存 `service:preset` op / `service-engine.ts` | **再利用**（本書 §7-C） |
| **認証ゲート（MFA相当＝OAuth/token grant）** | 既存 `secret-guard.ts` | **再利用**（本書 §7-⑤） |

**結論**：service アダプタの新規実装は実質「録画層」と「簡素なコンパイラ」「service 用 distill 評価器」だけ。実行・認証・監査は既存資産に乗る。

---

## 2. 目標・非目標

### 目標
1. 「起票→通知→格納」のような**複数サービスをまたぐ操作列**を、NL意図から解決し自動実行する（パターンB）。
2. 未学習時は、その意図を**1回実行してみせる過程を録画**し、再利用可能 pipeline へ昇格（人間レビュー後、パターンA）。
3. 外部副作用（送信・作成・削除・購入）は既存 approval-gate で**必ず承認**を取る。
4. 認証は `secret-guard` の時限 grant で解決し、権限不足時はユーザへ grant 承認を中継する（ブラウザの MFA 中継に相当）。

### 非目標
- service preset そのもの（`operations` 定義）を本書では新設しない。既存 `service-presets/*.json` を利用・拡張する。
- 任意の生 HTTP 呼び出しを学習しない。**必ず preset の `operations` に定義済みの action だけ**を手順化する（未定義 action は録画時に「要 preset 追加」として人へ戻す）。
- 秘密値（token/clientSecret 等）を録画・手順・trace に残さない。

---

## 3. service が browser と違う点（アダプタ差分の要点）

| 観点 | browser アダプタ | **service アダプタ** |
|---|---|---|
| 操作の単位 | DOM の click/fill（ref） | preset の **action 呼び出し**（`service_id` + `action` + `params`） |
| セレクタ/ref 解決 | 必要（壊れやすい・dry-run要） | **不要**。action は構造化済み・安定 → コンパイラが大幅に簡素 |
| 記録の素性 | DOM スナップショット＋ref列 | **(service_id, action, params) の列**。redaction が容易（param 単位で分類） |
| 実行系 | `extension_session`（ライブタブ）/ Playwright | **`service:preset` op**（`service-engine.ts:executeServicePreset`） |
| セッション保持 | lease + ログイン済み Chrome | **時限 grant**（`active/shared/auth-grants.json`、MISSION_ID 束縛） |
| 「MFA」相当 | スマホOTP中継 | **OAuth/token grant の承認中継**（`grantAccessGuarded`） |
| Golden 検証 | 終端DOM（トースト） | **レスポンス/`output_mapping`** の表明（例: issue key が返る） |
| 既存の録画機構 | あり（extension） | **無い（本書で新規）**。ただし `audit-chain`/trace に呼び出し痕跡はある |

---

## 4. パターンA/B（service 版の流れ）

```text
ユーザ意図「起票してSlack通知してBoxに格納して」
   │ Layer①（共有） resolveProcedure(intent)
   ├─ matched (B) ─────────────────────────────┐
   │                                            ▼
   │                                  [§7-C 実行アダプタ]
   │                                  service:preset を順に実行
   │                                  (jira.create_issue → slack.post → box.upload)
   │                                  各 external-effect step は approval-gate
   │                                  権限不足 → §7-⑤ grant 承認中継
   │                                            ▼
   │                                  Golden 検証（レスポンス表明）→ receipt
   └─ unmatched (A) ──┐
                      ▼
        [§6 録画アダプタ] 操作列を redaction 付きで記録
                      ▼
        [§7-③ コンパイラ] param 一般化 + secret 束縛 → draft pipeline
                      ▼
        人間レビュー → 昇格（distill-candidate-registry）→ procedures.json 登録
                      （= 次回からパターンB）
```

---

## 5. 不変条件（マスター §5 を継承）

- File I/O は `@agent/core/secure-io` のみ。
- 保存 tier：個人用途=`personal/`、組織業務=`confidential/{project}/`（procedures/recording/receipt すべて）。
- external-effect の service action は approval-gate を必ず通す（§8）。
- 秘密は `secret-guard` 経由でのみ解決し、値は手順/録画/trace に出さない。
- ミッション化必須（`scripts/mission_controller.ts`）。

---

## 6. service 録画アダプタ（新規・本書の中核）

ブラウザの content.js に相当する「実演記録」を、service 呼び出し列として実装する。

- **記録単位（`service-recording.v1`、新規スキーマ）**：
  ```jsonc
  {
    "recording_id": "...", "created_at": "...", "source": "service-capture",
    "substrate": "service",
    "steps": [
      {
        "service_id": "jira",
        "action": "create_issue",                 // 必ず preset.operations に定義済み
        "params_classified": {                     // 値は分類のみ。生値は保存しない
          "project": { "kind": "fixed", "value": "SBISEC" },
          "summary": { "kind": "input", "name": "summary" },     // {{input.summary}}
          "assignee": { "kind": "input", "name": "assignee", "optional": true }
        },
        "auth": "secret-guard",
        "risk_class": "high",                      // external-effect（作成）
        "produces": "issue_key"                    // 後続 step が consume する出力
      },
      { "service_id": "slack", "action": "post_message",
        "params_classified": { "channel": {"kind":"fixed","value":"#deals"},
                               "text": {"kind":"template","value":"起票: {{issue_key}}"} },
        "consumes": ["issue_key"], "risk_class": "high" }
    ],
    "recording_hash": "...", "policy_version": "..."
  }
  ```
- **取得方法（2方式、どちらでも可）**：
  1. **ライブ・キャプチャ**：本物のミッション中に走った `service:preset` 呼び出しを `audit-chain`/trace から拾い、recording に正規化（`audit-chain.ts` のエントリ＋trace を素材にする）。最小実装。
  2. **対話デモ**：ユーザが「こうやって」と各 action を順に指定 → その場で記録。
- **redaction**：`params` は値を保存せず `kind: fixed|input|template|secret` に分類（マスター Layer② の「固定/可変/秘密」と同思想）。`secret` は `secret-guard` の key 参照のみ。
- **対象ファイル**：新規 `libs/core/service-recording.ts`, 新規 `knowledge/product/schemas/service-recording.schema.json`
- **受入条件**：未定義 action は記録できず「要 preset 追加」として戻る。token/clientSecret 等が recording/trace に残らない。step の入出力（produces/consumes）が連結できる。

---

## 7. レイヤー別 設計（service 固有部分のみ）

### Layer① 意図解決 — **再利用（追加実装なし）**
マスター §7 Layer① の `resolveProcedure()` をそのまま使う。`procedures.json` に `substrate:"service"` エントリを足すだけ。エントリ例：
```jsonc
{
  "procedure_id": "deal.intake.jira-slack-box",
  "substrate": "service",
  "adapter": { "recorder": "service-capture", "executor": "service:preset" },
  "target": { "name": "Deal Intake", "services": ["jira", "slack", "box"] },
  "intent_phrases": ["起票してSlack通知してBoxに格納", "案件を起票して共有", "intake a deal"],
  "pipeline_ref": "pipelines/service/deal-intake.json",
  "required_inputs": [ { "name": "summary", "label": "件名", "type": "string" } ],
  "required_secrets": [
    { "name": "jira", "scope": "confidential/{project}" },
    { "name": "slack", "scope": "confidential/{project}" },
    { "name": "box", "scope": "confidential/{project}" }
  ],
  "risk_class": "high",
  "golden_scenario_ref": "knowledge/.../golden/deal-intake.v1.json",
  "version": "1.0.0", "status": "active"
}
```
- **受入条件**：service 意図が browser 意図と同じ resolver で解決され、`target.services`/`origin` 不一致を誤選択しない。

### Layer③ コンパイラ（録画→draft pipeline、**簡素版**）
- **要件**：`service-recording.v1` を `service:preset` ステップ列の draft pipeline へ変換。**ref→selector 解決は不要**（service の最大の利点）。
- **設計**：新規 `libs/core/service-recording-compiler.ts`
  - `kind:input` → `{{input.*}}`、`kind:template` → 既存出力チャネル参照（`consumes`）、`kind:secret` → `auth:"secret-guard"` ＋ `required_secrets`。
  - `produces`/`consumes` を pipeline の channel に落とす（既存 pipeline の `produces.channel`/`consumes` 規約に準拠）。
  - **dry-run**：副作用なしで確認するため、(a) 各 action の `parameters.required` 充足チェック（`service-preset-registry.ts` の `operations` 定義と突合）、(b) **read 系 action のみ実際に試走**、external-effect は**承認前提のため dry-run では発火させない**（ここが browser と違う安全配慮）。
  - `extractGoldenScenario`：各 step の `output_mapping`（例 jira `create_issue` → `issue_key`）を成功表明として §6.4 形式で同梱。
- **対象ファイル**：`libs/core/service-recording-compiler.ts`(新), `knowledge/product/pipeline-templates/automate-service-workflow.json`(新、`automate-browser-workflow.json` と対構造)
- **受入条件**：全 step の action が preset に存在し required param が揃う／揃わない step は「要人手」に分類。external-effect を dry-run で発火させない。draft は `_draft:true` で人間レビューまで `pipelines/` へ昇格しない。

### Layer C 実行アダプタ — **既存 `service:preset` を再利用**
- **要件**：`ProcedureResolution(matched)` を受け、step 列を `service:preset` で順に実行。
- **設計**：新規 `libs/core/procedure-dispatcher.ts`（マスター §7-C と同一ファイル）の service 分岐：`adapter.executor==='service:preset'` → 各 step を `executeServicePreset(service_id, action, params, 'secret-guard')`（`libs/core/service-engine.ts`）へ。`produces`→`consumes` のチャネル受け渡しは既存 `handleAction(action:'pipeline')`（`service-actuator-helpers.ts`）の合成規約に合わせる。
- external-effect step は実行前に approval-gate（§8）。失敗時は §7-④ 自己修復へ。
- **対象ファイル**：`libs/core/procedure-dispatcher.ts`（service 分岐追加）, 既存 `service-engine.ts`/`service-actuator-helpers.ts`（変更なし or 最小）
- **受入条件**：3サービス連鎖が channel 受け渡しで通る。未承認の external-effect はブロック。grant 失効は拒否。

### Layer⑤ 認証ゲート（ブラウザ MFA 中継に相当）— **既存 `secret-guard` を再利用**
- **要件**：実行に必要な service 認証が未 grant の場合、自動失敗せずユーザへ **grant 承認を中継**し、付与後に再開。
- **設計**：`getSecret(key, scope)` が `AUTHORIZED_SCOPE`＋`MISSION_ID` grant を要求し、未充足なら TIBA_VIOLATION。dispatcher はこれを捕捉して `grantAccessGuarded(missionId, serviceId, ttl)`（approval-gate 経由、高権限は dual_key_confirmation）をユーザへ中継 → 付与後リトライ。grant は `active/shared/auth-grants.json` に期限付きで入る。OAuth トークンが切れている場合の再認可フローも同経路。
- **対象ファイル**：`libs/core/procedure-dispatcher.ts`（grant 不足の中継）, 既存 `secret-guard.ts`/`service-binding.ts`（変更なし）
- **受入条件**：未 grant で自動失敗せず承認要求に落ちる。付与後に再開。token/secret が録画/trace/receipt に残らない。grant 期限切れは明示 `aborted`。

### Layer④ 自己修復・差分学習 — **再利用＋ service 評価器のみ追加**
- マスター §7 Layer④ をそのまま使う。service 固有なのは「失敗 step の差分（例：preset に新 action 追加、param 追加）を `ProcedureDelta` 化し該当 step に差し込む」点と、昇格候補の評価器。
- **設計**：`assessServiceDistillCandidate`（`browser-distill-candidate.ts` の汎用 interface 兄弟）を追加。`distill-candidate-registry.ts`（proposed→promoted）は共有。
- **対象ファイル**：新規 `libs/core/service-distill-candidate.ts`, 既存 `distill-candidate-registry.ts`（再利用）
- **受入条件**：「呼び出し列が壊れた→人が直した→次回は直った版で通る」を回帰再現。delta は人間レビュー無しに promoted を上書きしない。

---

## 8. リスク・承認の拡張（service external-effect の分類）

現状 `risky-op-registry.ts`/`approval-policy.json` は service の **read を非ゲート**、`secret:grant_access`/`auth:grant_authority` を high-risk としている。本アダプタでは**外部副作用を起こす service action を high-risk として明示分類**する必要がある。

- **追加分類**：`service:external_effect`（送信/作成/更新/削除/購入/権限変更系 action）を `approval-policy.json` に追加し、`risky-op-registry.ts` に op ID を登録。判定は preset 側の action にメタ（`effect: "read" | "write" | "external"`）を持たせ、`write|external` を承認対象とする。
- read-only の合成（情報収集パイプライン）は従来どおり非ゲートで高速に。
- **受入条件**：external-effect step が承認なしに実行されない。read-only 合成は承認不要のまま。preset に effect 分類が無い action は安全側（承認要）に倒す。

---

## 9. エージェント別 実装範囲（マスター §8 と整合）

service アダプタは browser とファイルが分離されるので、**browser チームと並行可**。共有契約（§6）の owner は同一。

| Agent | 担当 | owns（書き換え可） | 依存（読むだけ） | 成果物 |
|---|---|---|---|---|
| **Agent-S1（Recorder）** | §6 録画 | `service-recording.ts`, `service-recording.schema.json` | §6 契約, `audit-chain.ts`, preset registry | service-call 列の記録＋redaction |
| **Agent-S2（Compiler）** | §7-③ | `service-recording-compiler.ts`, `automate-service-workflow.json` | §6 契約, `service-preset-registry.ts` の operations | param一般化/secret束縛/Golden |
| **Agent-S3（Dispatcher/Auth）** | §7-C, ⑤ | `procedure-dispatcher.ts` の service 分岐 | A の `ProcedureResolution`, `service-engine.ts`, `secret-guard.ts` | 実行＋grant 中継 |
| **Agent-S4（Risk/Distill）** | §8, §7-④ | `service-distill-candidate.ts`, `approval-policy.json`/`risky-op-registry.ts` の service 追加 | `distill-candidate-registry.ts` | external-effect 分類＋差分学習 |
| **Agent-R（Reviewers）** | 横断 | （指摘のみ） | 全PR | §10 レビュー |

> Layer①/④ 本体は browser チーム（Agent-A/D）が実装する共有層。service チームは**その上に乗るアダプタだけ**を作る。`procedure-dispatcher.ts` は browser(Agent-C) と service(Agent-S3) が触るため、**substrate 分岐で関数を分け、同一ブロックを編集しない**こと（衝突回避はマスター §9 に従う）。

起動プロンプト雛形（owner が配布）：
> 「`docs/INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md` の §1 再利用方針と、あなたの担当 **Agent-SX** の §6〜§8 該当節・§9 owns 範囲だけを実装せよ。マスターの §6 凍結契約と不変条件（§5）を厳守。external-effect は必ず approval-gate を通す。read-only 以外は dry-run で発火させない。完了時は §受入条件のテストを追加し `pnpm build`＋該当テスト green を確認して報告。」

---

## 10. レビュー観点（Agent-R）

| 観点 | 確認 |
|---|---|
| セキュリティ | token/clientSecret/PII が recording・trace・receipt・ログに残らない。preset 未定義の生 HTTP を学習・実行していない。 |
| ガバナンス | external-effect が approval-gate を通る。read-only 合成は非ゲートのまま。grant が `secret-guard`＋MISSION_ID 束縛で解決。draft が人手レビュー無しに昇格しない。 |
| 契約整合 | マスター §6 の凍結型に準拠。`substrate:"service"` エントリが共有 resolver で解決。owns 外（特に Layer①/④ 本体）を変更していない。 |
| 不変条件 | secure-io 経由のみ。`Date.now()/Math.random()` 非依存。tier 指定必須。 |
| 連鎖の健全性 | produces/consumes のチャネル受け渡しが既存 pipeline 規約に一致。1サービス失敗時に後続が暴走しない。 |
| dry-run 安全性 | external-effect が dry-run で発火しない。Golden は read 確認 or 実行後表明のみから生成。 |

---

## 11. フェーズ計画

| フェーズ | 内容 | 受入条件 |
|---|---|---|
| **S0** | `service-recording.schema.json` ＋ service エントリ例を §6 契約に追加（マスター P0 に相乗り可） | スキーマ invalid が弾かれる |
| **S1 録画** | Agent-S1 | audit/trace or 対話デモから service-call 列を redaction 付きで記録。未定義 action は戻る。 |
| **S2 コンパイラ** | Agent-S2 | draft pipeline 生成、required param 突合、external-effect を dry-run 非発火、Golden 付与。 |
| **S3 実行＋認証** | Agent-S3 | 3サービス連鎖が channel 受け渡しで実行。未 grant で承認中継→再開。external-effect 承認必須。 |
| **S4 リスク＋自己修復** | Agent-S4 | external-effect 分類が効く。差分学習で「壊れた→直した→通る」を回帰。 |
| **S5 昇格** | owner | 1意図で複数SaaS自動実行・検証・報告。ミッション/pipeline 証跡化。 |

---

## 12. 着手前に owner が確定すべき事項

- 録画方式：まず **audit/trace からのライブ・キャプチャ**（最小実装）で始めるか、対話デモも同時に作るか。
- `effect: read|write|external` メタを **preset 側に持たせる**か、別ファイルで分類するか（推奨：preset 内メタ）。
- service 手順の保存 tier 既定（組織業務が大半なら `confidential/{project}` 既定）。
- 初手の対象サービス（推奨：社内で頻出の Jira＋Slack＋Box か、Gmail triage）。

---

## 13. 他アダプタへの展開（同テンプレートで書ける）

本書は browser に続く2本目のアダプタ仕様。同じ構造（§1 再利用方針→§6 録画→§7 コンパイル/実行/認証→§8 リスク→§9 エージェント協調）で、以下も同テンプレートで起こせる：

- **desktop**（GUIアプリ）：実行は `os-automation-bridge.ts`（再利用）、録画＝OSイベント列、コンパイラは ref 解決が要る（browser に近い）。
- **media**（PPTX/レポート生成）：実行は `media:*` op（再利用）、録画＝抽出/変換手順の例示。

> いずれもマスター §6 契約・Layer①/④・`distill-candidate-registry` を共有し、本書同様「録画＋コンパイラ＋（必要なら）実行アダプタ」だけを足す。要望に応じて desktop / media の指示書も同形式で作成する。
