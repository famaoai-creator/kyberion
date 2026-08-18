---
title: 意図駆動サービスAPI自動化（学習→再生） service アダプタ実装設計
kind: design-specification
scope: libs/core, libs/actuators/service-actuator, knowledge/product/orchestration/service-presets, pipelines
authority: proposed
status: partially_implemented
owner: ecosystem_architect
reviewed_at: 2026-06-23
last_updated: 2026-08-17
depends_on:
  - docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md # マスター設計（substrate 中立な §6 契約・Layer①/④・昇格機構）
tags: [service-preset, intent-loop, capability, pipeline, approval, multi-agent, adapter]
---

# 意図駆動サービスAPI自動化 — `substrate: "service"` アダプタ設計

> **本書はマスター設計（`INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md`）の adapter 仕様**である。
> マスターで substrate 中立に凍結した **§6 共有契約・Layer①（意図解決）・Layer④（自己修復）・昇格機構（`distill-candidate-registry`）は再利用**し、本書は **service 固有のアダプタ（録画・コンパイル・実行・認証ゲート）だけ**を規定する。
> 「勤怠承認」がブラウザ手順だったのに対し、本書が扱うのは例えば「**起票してSlack通知してBoxに格納しておいて**」のような**複数SaaSにまたがるAPI操作列**。

> **実装状況（2026-08-17）**: service recording、secret redaction、ADFコンパイル、レビュー必須のpromotion、service actuator連携、ADF直接実行時の `core:await_decision` gate、service recordingからの候補評価・レビュー用distill candidate生成は実装済み。audit/traceからの自動取り込み、service専用の差分修復、認証grantの承認中継は未実装であり、下記では「残課題」として明示する。

---

## 1. 位置づけ（再利用するもの／新規に作るもの）

| 要素                                                                  | 出所                                                  | 本書での扱い                                                   |
| --------------------------------------------------------------------- | ----------------------------------------------------- | -------------------------------------------------------------- |
| §6 手順エントリ／`ProcedureResolution`／`ProcedureDelta`／Golden 契約 | マスター §6（substrate 中立）                         | **そのまま再利用**。`substrate:"service"` で埋める             |
| Layer① 意図解決 `resolveProcedure()`                                  | マスター §7 Layer①                                    | **そのまま再利用**（service エントリも同じ resolver で引ける） |
| Layer④ 自己修復・差分学習 / 昇格                                      | マスター §7 Layer④ ＋ `distill-candidate-registry.ts` | service recordingから候補生成・評価まで実装。delta学習は残課題 |
| パターンA/B 分岐・しきい値                                            | マスター §6.2                                         | **そのまま再利用**                                             |
| **録画アダプタ（service-call 列の記録）**                             | `ServiceRecordingSession` / `service_recording` CLI   | **実装済み**。audit/trace自動取り込みは残課題                  |
| **コンパイラ（param一般化・secret束縛）**                             | `service-recording-compiler.ts`                       | **実装済み**。ref→selector 解決は不要                          |
| **実行アダプタ**                                                      | 既存 `service:preset` op / `service-engine.ts`        | **再利用**（本書 §7-C）                                        |
| **認証ゲート（MFA相当＝OAuth/token grant）**                          | 既存 `secret-guard.ts`                                | **再利用**（本書 §7-⑤）                                        |

**結論**：録画・コンパイル・候補評価・レビュー用candidate生成・レビュー済み録画の昇格までの最小経路は実装済み。実行時のservice approvalとsecret-guardは既存境界を再利用し、ADF直接実行には明示的な承認gateを追加した。audit/traceからのライブ録画、候補の差分修復、grant承認中継は次段階で追加する。

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

| 観点              | browser アダプタ                              | **service アダプタ**                                                                                                 |
| ----------------- | --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| 操作の単位        | DOM の click/fill（ref）                      | preset の **action 呼び出し**（`service_id` + `action` + `params`）                                                  |
| セレクタ/ref 解決 | 必要（壊れやすい・dry-run要）                 | **不要**。action は構造化済み・安定 → コンパイラが大幅に簡素                                                         |
| 記録の素性        | DOM スナップショット＋ref列                   | **(service_id, action, params) の列**。redaction が容易（param 単位で分類）                                          |
| 実行系            | `extension_session`（ライブタブ）/ Playwright | **`service:preset` op**（`service-engine.ts:executeServicePreset`）                                                  |
| セッション保持    | lease + ログイン済み Chrome                   | **時限 grant**（`active/shared/auth-grants.json`、MISSION_ID 束縛）                                                  |
| 「MFA」相当       | スマホOTP中継                                 | **OAuth/token grant の承認中継**（`grantAccessGuarded`）                                                             |
| Golden 検証       | 終端DOM（トースト）                           | **レスポンス/`output_mapping`** の表明（例: issue key が返る）                                                       |
| 既存の録画機構    | あり（extension）                             | `ServiceRecordingSession` と明示的な `service_recording capture` を提供。audit-chain/traceからの自動取り込みは未実装 |

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
   │                                  権限不足 → §7-⑤ grant 承認中継（残課題）
   │                                            ▼
   │                                  Golden 検証（レスポンス表明）→ receipt
   └─ unmatched (A) ──┐
                      ▼
        [§6 録画アダプタ] 操作列を redaction 付きで記録
                      ▼
        [§7-③ コンパイラ] param 一般化 + secret 束縛 → draft pipeline
                      ▼
        人間レビュー → distill candidate保存 → service procedure/catalog 昇格
                      （= 次回からパターンB）
```

実装済みの操作入口は次のとおりである。

```text
pnpm service:recording -- capture --target-name <name> --calls <json|@path>
pnpm service:recording -- compile --recording <path> --procedure-id <id> --intent-phrases '[...]'
pnpm service:recording -- candidate --recording <path> --procedure-id <id> --intent-phrases '[...]' [--mission-id <id>] [--tenant-slug <slug>] [--tier <personal|confidential>]
pnpm service:recording -- review --recording <path> --approve|--reject
pnpm service:recording -- promote --recording <path> --procedure-id <id> --intent-phrases '[...]'
```

`compile` は `_draft: true` のADFを生成する。`candidate` は同じADFとGolden情報を `active/shared/runtime/distill-candidates/` にレビュー用として保存するが、catalogや実行pipelineは書き換えない。confidential candidateには `--tenant-slug` が必要で、public candidateはbrokered publication未実装のため拒否する。`promote` は承認済み録画だけを受け付ける。high-risk stepのADFには `core:await_decision` が前置されるため、ADFを直接実行する経路でも承認前に `service:preset` は実行されない。

---

## 5. 不変条件（マスター §5 を継承）

- File I/O は `@agent/core/secure-io` のみ。
- 保存先：現在の録画・draftは `active/shared/runtime/recordings/` と `active/shared/tmp/`、candidateは `active/shared/runtime/distill-candidates/`、promotion先は `knowledge/personal/procedures.json` と `pipelines/service/`。candidateのconfidential scope表現は実装済みだが、組織業務のtenant catalogへの実昇格は残課題であり、現状のpromotion CLIは個人/fixture用途に限定する。
- external-effect の service action は approval-gate を必ず通す（§8）。
- 秘密は `secret-guard` 経由でのみ解決し、値は手順/録画/trace に出さない。
- 本番のライブ録画・昇格はミッションとtenant scopeに束縛する。fixture capture/compileは外部副作用を持たないため、ローカル改善ループとして実行できる。

---

## 6. service 録画アダプタ（新規・本書の中核）

ブラウザの content.js に相当する「実演記録」を、service 呼び出し列として実装する。

- **記録単位（`service-recording.v1`）**：
  ```jsonc
  {
    "schema_version": "service-recording.v1",
    "recording_id": "svc-rec-example",
    "created_at": "2026-08-17T00:00:00.000Z",
    "source": "service-capture",
    "target": { "name": "Deal Intake", "services": ["jira", "slack"] },
    "steps": [
      {
        "step_id": "step-001",
        "service_id": "jira",
        "action": "create_issue",
        "summary": "Create an issue",
        "risk_class": "high",
        "params": {
          "project": "SBISEC",
          "summary": "{{input.summary}}",
          "authorization": "{{secret.authorization}}",
        },
        "param_bindings": {
          "project": "fixed",
          "summary": "input",
          "authorization": "secret",
        },
        "secret_refs": ["authorization"],
        "produces": "issue_key",
      },
      {
        "step_id": "step-002",
        "service_id": "slack",
        "action": "post_message",
        "summary": "Notify Slack",
        "risk_class": "high",
        "params": { "channel": "#deals", "text": "{{channel.issue_key}}" },
        "consumes": ["issue_key"],
      },
    ],
    "risk_summary": { "requires_manual_review": true, "approval_required_count": 2 },
    "review": {
      "status": "pending",
      "decisions": [
        { "step_id": "step-001", "status": "pending" },
        { "step_id": "step-002", "status": "pending" },
      ],
    },
  }
  ```
- **取得方法**：現在は `ServiceRecordingSession` に明示的な `service_recording_session_id` を渡した `service:preset` 呼び出しと、fixtureを受け取る `service_recording capture` CLIを実装済み。audit-chain/traceからの自動正規化は残課題。
- **redaction**：`params` は固定値・`{{input.*}}`・`{{channel.*}}`・`{{secret.*}}` のいずれかとして保存する。raw secretは保存せず、結果もshape（kind/keys/array_length）のみ保存する。
- **対象ファイル**：`libs/core/service-recording.ts`, `libs/core/service-recording-session.ts`, `libs/core/service-recording-compiler.ts`, `libs/core/service-distill-candidate.ts`, `scripts/service_recording.ts`, `knowledge/product/schemas/service-recording.schema.json`
- **受入条件**：未定義 actionは記録できず、secret binding・入力不足・channel順序不整合はwarning/validationで昇格を止める。token/clientSecret等がrecording/traceに残らず、produces/consumesがADFへ連結される。

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
  "required_inputs": [{ "name": "summary", "label": "件名", "type": "string" }],
  "required_secrets": [
    { "name": "jira", "scope": "confidential/{project}" },
    { "name": "slack", "scope": "confidential/{project}" },
    { "name": "box", "scope": "confidential/{project}" },
  ],
  "risk_class": "high",
  "golden_scenario_ref": "knowledge/.../golden/deal-intake.v1.json",
  "version": "1.0.0",
  "status": "active",
}
```

- **受入条件**：service 意図が browser 意図と同じ resolver で解決され、`target.services`/`origin` 不一致を誤選択しない。

### Layer③ コンパイラ（録画→draft pipeline、**簡素版**）

- **要件**：`service-recording.v1` を `service:preset` ステップ列の draft pipeline へ変換。**ref→selector 解決は不要**（service の最大の利点）。
- **実装**：`libs/core/service-recording-compiler.ts`。`scripts/service_recording.ts compile` がADF/guardrail preflightを実行する。
  - `kind:input` → `{{input.*}}`、`kind:template` → 既存出力チャネル参照（`consumes`）、`kind:secret` → `auth:"secret-guard"` ＋ `required_secrets`。
  - `produces`/`consumes` を pipeline の channel に落とす（既存 pipeline の `produces.channel`/`consumes` 規約に準拠）。
  - **dry-run**：副作用なしで確認するため、各 action の `parameters.required` を service harnessのoperation契約と突合する。external-effectは試走せず、ADFには `core:await_decision` を前置する。
  - `extractGoldenScenario`：各 step の `output_mapping`（例 jira `create_issue` → `issue_key`）を成功表明として §6.4 形式で同梱。
- **対象ファイル**：`libs/core/service-recording-compiler.ts`, `scripts/service_recording.ts`, `pipelines/service/*.json`（promotion時に生成）。専用templateは未作成。
- **受入条件**：全stepのactionがpresetに存在し、required param不足はwarningになる。external-effectをdry-runで発火させず、draftは `_draft:true` のままレビューまで昇格しない。promotion後は `_draft` を除去し、実行ADFには承認gateを残す。

### Layer C 実行アダプタ — **既存 `service:preset` を再利用**

- **要件**：`ProcedureResolution(matched)` を受け、step 列を `service:preset` で順に実行。
- **実装**：`libs/core/procedure-dispatcher.ts` は録画のschema/semantic validation、review、service allowlist、approval gateを実行する。ADF直接実行側には `core:await_decision` を追加し、`service:preset` へ到達する前に停止する。
- **対象ファイル**：`libs/core/procedure-dispatcher.ts`, `libs/actuators/service-actuator/src/service-actuator-helpers.ts`, `libs/core/service-procedure-executor.ts`
- **受入済み**：未承認のexternal-effectはprocedure/ADFの両経路でブロック。produces/consumesとsecret placeholderを検証する。3サービス実サービスE2Eとgrant失効からの再開は未検証。

### Layer⑤ 認証ゲート（ブラウザ MFA 中継に相当）— **既存 `secret-guard` を再利用**

- **要件**：実行に必要な service 認証が未 grant の場合、自動失敗せずユーザへ **grant 承認を中継**し、付与後に再開。
- **現状**：`secret-guard` とsecret placeholder拒否は再利用するが、grant不足をユーザ承認へ中継して再開するservice専用フローは未実装。録画からのraw secret除去と、未束縛secretの実行拒否は実装済み。
- **残課題**：`getSecret(key, scope)` → `grantAccessGuarded` → approval-store → 再開の一連のservice adapter接続。

### Layer④ 自己修復・差分学習 — **候補生成は実装済み、評価器・修復は残課題**

- `assessServiceDistillCandidate` が、preset operation・intent phrase・観測時validation errorを確認する。通過した recordingだけを `service-distill-candidate.ts` がADF/Golden/preflight付きの procedure candidateへ変換し、`distill-candidate-registry.ts` に保存する。candidateは常に `status:"proposed"`、`metadata.executable:false` である。
- **残課題**：実行trace/auditからの自動候補化、`ProcedureDelta`への変換、人間レビュー後の再コンパイル回帰。

---

## 8. リスク・承認の拡張（service external-effect の分類）

service harnessのoperation契約は `read` / `write` / `destructive` を持ち、録画時はread以外をhigh-riskとして扱う。procedure dispatcherは `service:external_effect` をapproval-gateへ渡し、ADF compilerは同じ境界を `core:await_decision` として埋め込む。global `risky-op-registry.ts` への個別service action追加は行っていない。

- **実装済み分類**：`service:external_effect`（送信/作成/更新/削除/購入/権限変更系 action）をservice dispatcherのapproval operationとして使用する。未知またはread以外のoperationは安全側に倒して承認対象とする。
- read-only の合成（情報収集パイプライン）は従来どおり非ゲートで高速に。
- **受入条件**：external-effect stepがprocedure/ADFの両経路で承認なしに実行されない。read-only合成はprocedure経路では承認不要のまま。presetにeffect分類がないactionはservice harnessのrisk分類に従い安全側に倒す。

---

## 9. エージェント別 実装範囲（マスター §8 と整合）

service アダプタは browser とファイルが分離されるので、**browser チームと並行可**。共有契約（§6）の owner は同一。

| Agent                           | 担当     | owns（書き換え可）                                                                            | 依存（読むだけ）                                                   | 成果物                                   |
| ------------------------------- | -------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------ | ---------------------------------------- |
| **Agent-S1（Recorder）**        | §6 録画  | `service-recording.ts`, `service-recording.schema.json`                                       | §6 契約, `audit-chain.ts`, preset registry                         | service-call 列の記録＋redaction         |
| **Agent-S2（Compiler）**        | §7-③     | `service-recording-compiler.ts`, `scripts/service_recording.ts`                               | §6 契約, service harness の operations                             | param一般化/secret束縛/Golden/ADF gate   |
| **Agent-S3（Dispatcher/Auth）** | §7-C, ⑤  | `procedure-dispatcher.ts` の service 分岐                                                     | A の `ProcedureResolution`, `service-engine.ts`, `secret-guard.ts` | 実行＋grant 中継                         |
| **Agent-S4（Risk/Distill）**    | §8, §7-④ | `service-distill-candidate.ts`, `approval-policy.json`/`risky-op-registry.ts` の service 追加 | `distill-candidate-registry.ts`                                    | external-effect 分類＋候補評価・差分学習 |
| **Agent-R（Reviewers）**        | 横断     | （指摘のみ）                                                                                  | 全PR                                                               | §10 レビュー                             |

現在の実装ファイルと残課題の対応は次のとおり。

| 領域               | 現在の実装                                                                                                   | 状態                                        |
| ------------------ | ------------------------------------------------------------------------------------------------------------ | ------------------------------------------- |
| Recorder           | `libs/core/service-recording-session.ts`, `scripts/service_recording.ts`, service actuatorの明示session hook | 実装済み。audit/trace自動取り込みは未実装   |
| Compiler/Promotion | `libs/core/service-recording-compiler.ts`, `libs/core/service-procedure-promotion.ts`                        | 実装済み。承認gate付きADFを生成             |
| Dispatcher/Risk    | `libs/core/procedure-dispatcher.ts`, `service:external_effect`, `core:await_decision`                        | 実装済み                                    |
| Distill/Repair     | `libs/core/service-distill-candidate.ts`, `libs/core/distill-candidate-registry.ts`                          | 候補評価・生成は実装済み。delta修復は未実装 |
| Auth relay         | `secret-guard` placeholder拒否                                                                               | grant承認中継・再開は未実装                 |

> Layer①/④ 本体は browser チーム（Agent-A/D）が実装する共有層。service チームは**その上に乗るアダプタだけ**を作る。`procedure-dispatcher.ts` は browser(Agent-C) と service(Agent-S3) が触るため、**substrate 分岐で関数を分け、同一ブロックを編集しない**こと（衝突回避はマスター §9 に従う）。

起動プロンプト雛形（owner が配布）：

> 「`docs/INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md` の §1 再利用方針と、あなたの担当 **Agent-SX** の §6〜§8 該当節・§9 owns 範囲だけを実装せよ。マスターの §6 凍結契約と不変条件（§5）を厳守。external-effect は必ず approval-gate を通す。read-only 以外は dry-run で発火させない。完了時は §受入条件のテストを追加し `pnpm build`＋該当テスト green を確認して報告。」

---

## 10. レビュー観点（Agent-R）

| 観点           | 確認                                                                                                                                                            |
| -------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| セキュリティ   | token/clientSecret/PII が recording・trace・receipt・ログに残らない。preset 未定義の生 HTTP を学習・実行していない。                                            |
| ガバナンス     | external-effect が approval-gate を通る。read-only 合成は非ゲートのまま。grant が `secret-guard`＋MISSION_ID 束縛で解決。draft が人手レビュー無しに昇格しない。 |
| 契約整合       | マスター §6 の凍結型に準拠。`substrate:"service"` エントリが共有 resolver で解決。owns 外（特に Layer①/④ 本体）を変更していない。                               |
| 不変条件       | secure-io 経由のみ。`Date.now()/Math.random()` 非依存。tier 指定必須。                                                                                          |
| 連鎖の健全性   | produces/consumes のチャネル受け渡しが既存 pipeline 規約に一致。1サービス失敗時に後続が暴走しない。                                                             |
| dry-run 安全性 | external-effect が dry-run で発火しない。Golden は read 確認 or 実行後表明のみから生成。                                                                        |

---

## 11. フェーズ計画

| フェーズ                | 内容                                                                                            | 受入条件                                                                                                   |
| ----------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **S0**                  | `service-recording.schema.json` ＋ service エントリ例を §6 契約に追加（マスター P0 に相乗り可） | **完了**：schema/semantic validationが動作                                                                 |
| **S1 録画**             | Agent-S1                                                                                        | **部分完了**：明示session/fixture captureは実装。audit/trace自動取り込みは残課題                           |
| **S2 コンパイラ**       | Agent-S2                                                                                        | **完了**：draft、required param warning、secret binding、Golden、ADF preflight                             |
| **S3 実行＋認証**       | Agent-S3                                                                                        | **部分完了**：procedure/ADFのapproval gateは実装。grant中継・3サービス実E2Eは残課題                        |
| **S4 リスク＋自己修復** | Agent-S4                                                                                        | **部分完了**：risk/approval分類・候補評価・recording→candidate生成は実装。差分学習は残課題                 |
| **S5 昇格**             | owner                                                                                           | **部分完了**：レビュー済み録画からpersonal catalogとpipelineへ昇格。tenant/mission bound promotionは残課題 |

---

## 12. 次段階で owner が確定すべき事項

- 録画方式：**audit/trace からのライブ・キャプチャ**を追加し、明示session captureと同じredaction契約へ正規化する。
- `effect: read|write|external` メタを **preset 側に持たせる**か、別ファイルで分類するか（推奨：preset 内メタ）。
- service 手順の保存 tier 既定（組織業務が大半なら `confidential/{tenant-slug}` へ governed promotion）。
- 初手の対象サービス（推奨：社内で頻出の Jira＋Slack＋Box か、Gmail triage）。
- service専用distill candidate/evaluatorと、secret grant承認後の再開契約。

---

## 13. 他アダプタへの展開（同テンプレートで書ける）

本書は browser に続く2本目のアダプタ仕様。同じ構造（§1 再利用方針→§6 録画→§7 コンパイル/実行/認証→§8 リスク→§9 エージェント協調）で、以下も同テンプレートで起こせる：

- **desktop**（GUIアプリ）：実行は `os-automation-bridge.ts`（再利用）、録画＝OSイベント列、コンパイラは ref 解決が要る（browser に近い）。
- **media**（PPTX/レポート生成）：実行は `media:*` op（再利用）、録画＝抽出/変換手順の例示。

> いずれもマスター §6 契約・Layer①/④・`distill-candidate-registry` を共有し、本書同様「録画＋コンパイラ＋（必要なら）実行アダプタ」だけを足す。要望に応じて desktop / media の指示書も同形式で作成する。
