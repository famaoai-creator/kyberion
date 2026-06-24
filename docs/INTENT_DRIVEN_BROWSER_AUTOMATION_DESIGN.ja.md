---
title: 意図駆動ブラウザ自動化（学習→再生）要件・実装設計
kind: design-specification
scope: libs/core, knowledge/product/orchestration, pipelines, tools/adf-replay-extension
authority: approved
status: ready-for-p0
owner: ecosystem_architect
reviewed_at: 2026-06-23
review_record:
  - reviewer: Antigravity (Ecosystem Architect)
    date: 2026-06-23
    verdict: APPROVED with Recommendations
    folded_in: [§4 基盤決定, §6.2 しきい値, §7-Layer③ SPA/iframe, §7-Layer⑤ MFA猶予Lease, §12 決定確定]
depends_on:
  - tools/adf-replay-extension/IMPLEMENTATION_SPECIFICATION.ja.md
tags: [browser-bridge, intent-loop, capability, pipeline, approval, multi-agent]
---

# 意図駆動ブラウザ自動化 要件・実装設計

> このドキュメントは複数エージェント（Sonnet 含む）で並行実装することを前提に書く。
> §6 の共有契約を**最初に凍結**し、その後 §8 のエージェント別範囲で並行着手する。
> 既存のブラウザブリッジ実装（録画→承認→lease→実行→receipt）は完成しているので**作り直さない**。本設計はその上に「意図→自動実行」を載せる差分である。

---

## 1. 背景と現状（既に在るもの／無いもの）

ユーザ発話「ブラウザで勤怠管理サービスの承認をしておいて」に対し、
- **パターンB（既学習）**: 登録済み手順を解決し自動実行
- **パターンA（未学習）**: その場で実演させて学習・コード化

を滑らかに繋ぐのが目的。`feature/cowork-integration-phase0` 時点での充足状況：

| 能力 | 状態 | 主な実体 |
|---|---|---|
| DOM意味込みの実演レコーダー | ✅ 完成 | `tools/adf-replay-extension/content.js`, `background.js`, `sidepanel.js` |
| 録画→draft pipeline コンパイル | 🟡 半分 | `compileBrowserRecordingToPipeline()` @ `libs/core/browser-extension-bridge.ts:490` |
| 承認 / lease / receipt / トラスト境界 | ✅ 完成 | `scripts/browser_bridge_host.ts`, `libs/core/risky-op-registry.ts`, `knowledge/product/governance/approval-policy.json` |
| 秘密入力の非記録（redaction） | ✅ 完成 | `content.js`（password/OTP/token/WebAuthn を記録しない） |
| **① 手順レジストリ＆意図解決** | ❌ 欠落 | — |
| **③' ref→堅牢セレクタ自動解決 / Golden Scenario / dry-run** | ❌ 欠落 | — |
| **④ 自己修復・差分学習** | ❌ 欠落（停止はするが直さない） | — |
| **⑤ MFA中継ゲート** | ❌ 欠落（秘密の非記録のみ） | — |

**重要な事実（設計判断の前提）**
- `libs/core/capability-broker.ts` の Capability Broker は **LLMプロバイダ選択専用**。照合は完全一致キーのみで**曖昧/意味マッチは持たない**。→ 手順の意図解決をここに同居させてはいけない。**同じ知識駆動パターンを踏襲した別レジストリ**を作り、曖昧マッチは reasoning backend に委譲する。
- `knowledge/product/governance/actuator-op-registry.json` の `browser` ドメインに既に2つの実行基盤がある：`extension_session`（ライブタブ実行）と Playwright 系 `click/fill/...`。→ パターンBの実行基盤はこの**両者を用途で振り分ける**。
- pipeline は draft（`_draft:true`, `_review_required`, `version:"0.1.0-draft"`）と promoted（`pipelines/*.json`）で区別される。

---

## 2. 目標・非目標

### 目標
1. 自然言語の業務意図から、登録済みブラウザ手順を**解決**し、パターンA/Bを**自動分岐**する。
2. 未学習時は実演を**1回の録画**から再利用可能 pipeline へ昇格できる（人間レビュー後）。
3. 自動実行が成功したことを **Golden Scenario** で検証し、証跡付きで報告する。
4. つまずいた時は人へ**ハンドオフ**し、その**差分だけ**を既存手順へ学習させる。
5. MFA を**中継**して安全に通過する。

### 非目標
- 既存の承認ゲート／レビュー必須の原則は緩めない（draft は自動昇格しない）。
- 秘密値・PII の記録方針は変えない（`extension_session` の redaction を踏襲）。
- 任意 ADF の即時実行や、ページ文言を命令として扱うことは依然禁止（prompt injection 不変条件）。

---

## 3. 全体アーキテクチャ（意図ループへの接続）

```text
ユーザ意図（NL）
   │
   ▼
[Layer① 意図解決ディスパッチャ]  resolveBrowserProcedure(intent, {origin?})
   │                                       │
   │ confident match (pattern B)           │ no/low match (pattern A)
   ▼                                       ▼
[Layer C 実行ディスパッチャ]          [既存レコーダー + Layer②' 意図抽出]
   │ 基盤を用途で振り分け                  │ 実演を録画
   │  - 対話/MFA要 → extension_session     ▼
   │  - 無人バッチ → browser:pipeline    [Layer③ コンパイラ拡張]
   ▼                                       ref→selector / Golden Scenario / dry-run
[Layer⑤ MFA中継] ──(必要時)──┐            │
   │                          │            ▼
   ▼                          │      draft pipeline（人間レビュー）
 実行 → receipt → Golden検証   │            │
   │                          │            ▼
   │ 失敗/ambiguity            │      promoted pipeline + 手順レジストリ登録
   ▼                          │            （= 次回からパターンB）
[Layer④ 自己修復]─────────────┘
   人の手動解決の差分を該当stepへ差し込み、versionを上げる
```

意図ループ上の対応：受信・明確化（Layer①）→ 実行（Layer C/⑤）→ 検証（Golden）→ 学習（Layer④ / 昇格）。

---

## 4. 実行基盤の分岐決定（設計の分かれ目を確定する）

パターンBの自動実行を **extension（ライブタブ）** と **Playwright（ヘッドレス）** のどちらで行うかは曖昧にしない。**用途で振り分ける**：

| 条件 | 実行基盤 | op |
|---|---|---|
| ユーザのログイン済みセッション必須 / MFA を伴う / 対話確認が要る | Chrome 拡張 | `browser.apply: extension_session` |
| 認証済みでセッションを別途確立できる無人バッチ | Playwright | 既存 `browser:pipeline` |

手順レジストリのエントリに `execution_substrate: "extension" | "playwright"` を持たせ、Layer C が読んで分岐する。**【決定】初期実装は `extension` 固定**（勤怠/承認系はログイン＋MFA前提で、ライブセッション再利用がヘッドレス自動ログインより圧倒的に安定するため）。Playwright 経路は後続フェーズ。

---

## 5. 不変条件の遵守（全エージェント必読）

- **File I/O は `@agent/core/secure-io` のみ**。`node:fs` 直呼び禁止。
- レジストリ／pipeline／receipt の保存 tier は呼び出し側が必ず指定：個人ブラウズ=`personal`、組織業務=`confidential/{project}`。
- 高リスク操作（submit/delete/purchase/credential/settings_change）は既存 approval-gate を必ず通す。新規 op を足す場合も `risky-op-registry.ts` と `approval-policy.json` に登録。
- ページ DOM・本文・ARIA・URL は untrusted。policy/lease/許可操作をページから変更不可（既存方針を継承）。
- **ミッション化必須**：本作業は CLAUDE.md §2 の mission-gating 条件（5+成果物 / 再実行前提 / 同パターン反復）を満たす。`scripts/mission_controller.ts` でミッションを開始し、`pipelines/` パイプラインとして昇格物を管理する。

---

## 6. 共有契約（★ここを最初に凍結する★）

並行実装の衝突を防ぐため、以下の型・スキーマを**先に1つのコミットで確定**してから各エージェントが着手する。型は `libs/core/procedure-types.ts`（新規）に集約する。

> **【決定: substrate 中立で凍結】** 意図解決レジストリ／結晶化→昇格／自己修復は本質的にブラウザ固有ではない（actuator は11ドメインあり、サービスAPI合成・デスクトップGUI・メール triage 等が同じ形を持つ。§13参照）。よって契約は最初から substrate 中立とし、ブラウザは**最初のアダプタ**として実装する。実装が動くのはブラウザのみだが、後からサービス/デスクトップ アダプタを**凍結済み契約を壊さずに**追加できる。昇格機構は新規実装せず**既存 `libs/core/distill-candidate-registry.ts`（`DistillCandidateRecord`, status: proposed|promoted|archived）を再利用**する。

### 6.1 手順レジストリ・エントリ（substrate 中立な知識駆動カタログ）
新規カタログ: `knowledge/product/orchestration/procedures.json`
（`provider-capabilities.json` と同じ「知識JSON＋コード側フォールバック」パターンを踏襲。**ブラウザ専用ではない**）

```jsonc
// 1エントリの形（substrate 中立）
{
  "procedure_id": "attendance.approve.kingoftime",   // 安定キー
  "substrate": "browser",                            // browser | desktop | service | media | ...（discriminator）
  "adapter": { "recorder": "chrome-extension", "executor": "extension_session" }, // substrate 別の録画/実行アダプタ
  "target": { "name": "King of Time", "origins": ["https://s2.kingtime.jp"] }, // service名/origin/アプリ名など substrate 依存の同定子
  "intent_phrases": ["勤怠の承認", "勤怠承認", "approve attendance"], // 意図解決の素性
  "execution_substrate": "extension",                // §4（browser の場合の実行系。substrate=browser 固有）
  "pipeline_ref": "pipelines/browser/attendance-approve-kingoftime.json",
  "required_inputs": [                               // {{input.*}} 候補
    { "name": "target_period", "label": "対象期間", "type": "string", "optional": true }
  ],
  "required_secrets": [                              // Vault/service preset から解決
    { "name": "kingoftime_login", "scope": "confidential/{project}" }
  ],
  "risk_class": "high",                              // 承認要否の素性
  "golden_scenario_ref": "knowledge/.../golden/attendance-approve-kingoftime.v1.json",
  "version": "1.0.0",
  "status": "active"                                // active | deprecated
}
```

`substrate`/`adapter`/`target` 以外（intent_phrases, required_inputs/secrets, risk_class, golden_scenario_ref, version, status）は全 substrate 共通。`resolveProcedure` はこの共通部だけで意図解決し、`adapter` を見て実行系へ橋渡しする。

### 6.2 意図解決の結果型
```ts
// libs/core/procedure-types.ts
export interface ProcedureResolution {
  outcome: 'matched' | 'ambiguous' | 'unmatched';
  best?: { procedure_id: string; confidence: number /*0..1*/ };
  candidates: Array<{ procedure_id: string; confidence: number; reason: string }>;
  recommendedPattern: 'B' /*execute*/ | 'A' /*learn*/;
}
```
分岐規則【決定: 初期値 0.75 / 0.4、設定でオーバーライド可】：`best.confidence >= 0.75` → パターンB。`0.4..0.75` → ユーザに候補提示して確認。`< 0.4` → パターンA。

### 6.3 差分学習レコーディング（Layer④）
```ts
export interface ProcedureDelta {
  procedure_id: string;
  anchor: { step_index: number; ref_snapshot_hash: string }; // どのstepの後に差すか
  delta_recording_ref: string;   // 既存 browser-recording.v1 を再利用
  reason: 'ambiguity' | 'handoff' | 'new_popup' | 'mfa';
}
```

### 6.4 Golden Scenario（検証成果物）
```jsonc
{
  "scenario_id": "...", "procedure_id": "...",
  "success_conditions": [
    { "kind": "ref_visible", "role": "alert", "name_contains": "承認が完了しました" }
  ],
  "captured_from": "receipt_id", "version": "1.0.0"
}
```

> 凍結とは：6.1〜6.4 のスキーマJSON（`knowledge/product/schemas/` に追加）と `browser-procedure-types.ts` の型シグネチャを、**中身の実装が空でも先に**マージすること。以後この署名は §9 の手続きでしか変えられない。

---

## 7. レイヤー別 要件・実装設計

各レイヤーは「要件 / 設計 / 対象ファイル / 受入条件」を持つ。

### Layer① 手順レジストリ＆意図解決（substrate 中立）
- **要件**: NL意図から `ProcedureResolution` を返す。2回目以降の発話で確実にパターンBへ入る。**全 substrate 共通の解決層**（ブラウザ手順もサービス手順も同じ resolver で引ける）。
- **設計**:
  - 新規 `libs/core/procedure-registry.ts`
    - `loadProcedures(tier): ProcedureEntry[]` — secure-io 経由で `procedures.json` を読む（無ければ空＋コードフォールバック）。
    - `resolveProcedure(intent: string, opts?: {origin?: string; substrate?: string}): Promise<ProcedureResolution>`
      - **2段構え**：(1) 安価な前処理＝`intent_phrases`/`target.name`/`origin` に対する正規化キーワード・identifier 一致でプレフィルタ（Capability Broker と同じ完全一致思想）。(2) 候補が1件に絞れない時のみ `getReasoningBackend().delegateTask(prompt, context)` に意味ランキングを委譲（曖昧マッチはここだけ）。stub backend 時は前処理結果のみで決定（オフライン決定性を維持）。
      - `substrate`/`adapter`/`target` 以外の共通フィールドだけで解決する。substrate 固有の同定（origin一致など）は `target` の解釈に閉じ込める。
  - Capability Broker（プロバイダ解決）とは**別物**。混ぜない。解決の語彙（sole/preferred/best-match）を参考にしてよいが流用ではない。
- **対象ファイル**: `libs/core/procedure-registry.ts`(新), `procedure-types.ts`(新), `knowledge/product/orchestration/procedures.json`(新)
- **受入条件**: 登録済み意図はbackend無し(stub)でも `matched` を返す。未登録は `unmatched`＋`recommendedPattern:'A'`。曖昧時は複数 `candidates` を信頼度付きで返す。origin/identifier が一致するエントリを優先する。substrate を跨いでも resolver が破綻しない（browser 以外のエントリ型を受理できる）。

### Layer② 実演レコーダーのインタラクティブ意図抽出（既存への追加）
- **要件**: 録画中／レビュー時に「この値は毎回変わるか」「承認対象の条件」を問い、`required_inputs` を確定。
- **設計**: 既存 `sidepanel.js` の Review タブに変数化UIがあるので、(a) 各 `fill_ref` に「固定値 / 毎回入力({{input.name}}) / 秘密(Vault)」の三択を出す、(b) 確定結果を recording の `locator candidates`/変数メタに反映。座標やセレクタは前面に出さない（目的中心の日本語ラベル）。
- **対象ファイル**: `tools/adf-replay-extension/sidepanel.js`, `content.js`（変数候補メタの付与）, 既存 `browser-recording.schema.json`（必要なら変数メタ拡張）
- **受入条件**: 録画後、各入力が固定/可変/秘密に分類され、可変は `{{input.*}}` 名が付く。秘密は値が draft/storage/trace に残らない（既存方針の回帰）。

### Layer③ コンパイラ拡張（draft を実行可能品質へ）
- **要件**: 現状 `_review_required` に列挙される穴（ref→selector 等）を**自動で埋め**、dry-run で再現確認し、Golden Scenario を自動抽出する。
- **設計**: 既存 `compileBrowserRecordingToPipeline()` を拡張または後段関数を追加。
  - `resolveRefsToSelectors(draft): {resolved, unresolved[]}` — role/name/snapshot文脈から堅牢な locator を決定。解決不能は人へ戻す（自動昇格しない原則は維持）。
  - `rehearseDraft(draft): RehearsalResult` — `execution_substrate` に応じた dry-run（extension は dry実行 or Playwright headless で再現）。`Math.random()/Date.now()` は使わない（決定性）。
  - `extractGoldenScenario(rehearsalResult): GoldenScenario` — 終端の成功 DOM（トースト等）を §6.4 形式で同梱。
  - 秘密参照は `{{secrets.*}}` へ。Service preset 認証（`auth:secret-guard` + `AUTHORIZED_SCOPE` + `KYBERION_PERSONA`）の3点に接続。
  - **【追加要件 / agyレビュー A】SPA・iframe 動的ロード対応**: 勤怠/社内系は SPA（同一URLでDOM書き換え）と iframe を多用するため、(a) 各 step の ref に「対象がDOMに出現しかつ操作可能(interactable)になるまでの自動待機（タイムアウト付き）」を必須化、(b) ref メタに iframe コンテキスト（frame chain / origin）を保持し、再生時に自動でフレーム切替する。固定 `wait` 秒（既存プロトタイプの1秒）は使わず条件待機にする。
- **対象ファイル**: `libs/core/browser-extension-bridge.ts`, 新規 `libs/core/browser-recording-compiler.ts`（肥大化する場合は分離）, `knowledge/product/pipeline-templates/automate-browser-workflow.json`, `tools/adf-replay-extension/content.js`（再生時の interactable 待機・iframe 切替）
- **受入条件**: 全 step の ref が selector 解決 or 明示的に「要人手」に分類される。dry-run 成功時のみ Golden が付く。draft は依然 `_draft:true` で、人間レビュー通過まで `pipelines/` へ昇格しない。**SPA再描画・iframe内要素・遅延出現要素を含む手順が、固定待機なしで安定再生される（回帰テストあり）。**

### Layer C 実行ディスパッチャ＆基盤振り分け
- **要件**: `ProcedureResolution(matched)` を受け、§4 の基盤へ振り分けて実行し、receipt と Golden 検証結果を返す。パターンA時はレコーダー起動を促す。
- **設計**: 新規 `libs/core/procedure-dispatcher.ts`
  - `dispatch(resolution, inputs, ctx)`：`adapter.executor` で実行系を選ぶ。substrate=browser かつ `execution_substrate==='extension'` → 既存 `extension_session` 経路（lease発行→拡張実行）。`'playwright'` → `browser:pipeline`。他 substrate のアダプタは後続フェーズ（§13）で追加。
  - 高リスク step は既存 approval-gate を必ず通す（`risky-op-registry.ts`）。
  - 実行後 Golden Scenario と receipt を突合し、成功/失敗を判定。
- **対象ファイル**: `libs/core/procedure-dispatcher.ts`(新), `scripts/browser_bridge_host.ts`（lease に procedure_id/mission を載せる, 仕様§4.2 未配線分）
- **受入条件**: extension 経路で承認→lease→実行→receipt→Golden検証が一気通貫。未承認の高リスクはブロック。lease 失効・origin不一致は拒否（既存回帰）。

### Layer④ 自己修復・差分学習
- **要件**: ambiguity停止やハンドオフ時、人の手動解決を `ProcedureDelta` として捕捉し、該当 step へ差し込んで version を上げる。
- **設計**:
  - 停止/ハンドオフ時に「ここから手動で」をUI提示（既存 pause/resume を活用）。手動操作を delta として録画（既存レコーダー再利用、anchor=失敗step）。
  - `accrueProcedureDelta(delta): {updated_pipeline_ref, new_version}` — 既存 promoted pipeline の該当 step 後に挿入。**昇格は人間レビュー必須**（自動上書き禁止）。昇格候補は新規実装せず**既存 `libs/core/distill-candidate-registry.ts` の `DistillCandidateRecord`（status: proposed→promoted）を再利用**。`browser-distill-candidate.ts` の評価器は汎用 interface のブラウザ実装と位置づけ直す。
- **対象ファイル**: `libs/core/procedure-registry.ts`（version管理）, `libs/core/distill-candidate-registry.ts`（再利用）, `tools/adf-replay-extension/background.js`（ハンドオフ→delta録画）, 新規 delta スキーマ
- **受入条件**: 同じ手順が「壊れた→人が直した→次回は直った版で通る」を回帰で再現。delta は人間レビュー無しに promoted を書き換えない。

### Layer⑤ MFA中継ゲート＆Vault
- **要件**: ログイン/承認時の MFA を検知→実行を一時停止→ユーザにOTP/承認を中継→再開。OTP値は記録しない。
- **設計**:
  - MFA画面の検出（既知パターン or step メタの `mfa: true`）で `pause` し、UI/チャットへ「認証コードを入力」要求を中継。入力はエフェメラル（lease スコープ内のみ、storage/trace 非保存）。
  - Vault/Service preset から認証情報を解決（§Layer③ と同じ3点）。
  - **【追加要件 / agyレビュー B】MFA猶予 Lease 延長**: MFA中継でユーザ入力を待つ間に lease 失効タイマーが切れて自動失敗するのを防ぐ。`browser_bridge_host.ts` に `MFA_WAIT` 状態を設け、その間に限り失効タイマーを一時停止、または**最大3分の猶予 lease 延長**を自動発行する。延長は MFA_WAIT 中のみ・1回限り・origin/step 束縛を変えない（権限拡大に使わせない）。タイムアウト時は明示的 `aborted` で終了。
- **対象ファイル**: `tools/adf-replay-extension/background.js`/`sidepanel.js`（pause/中継UI）, `scripts/browser_bridge_host.ts`（`MFA_WAIT` 状態＋猶予 lease 延長）, secret 境界
- **受入条件**: MFA要求で自動失敗せず一時停止し、ユーザ入力後に再開。**MFA待機が既定 lease TTL を超えても、猶予延長（最大3分）内なら失効せず再開できる。猶予超過時は `aborted` になる。** OTP/秘密が draft/storage/trace/receipt に残らない。

---

## 8. エージェント別 実装範囲（協調指示書）

ワーカーは下記の単位で割り当てる。各エージェントは**自分が owns するファイルのみ書き換える**。他者の owns へ触れる必要が出たら §9 の手順で調整する。

| Agent | 担当レイヤー | owns（書き換え可） | 依存（読むだけ） | 主要成果物 |
|---|---|---|---|---|
| **Agent-A（Registry）** | ① | `procedure-registry.ts`, `procedures.json`, 関連スキーマ | §6 契約 | substrate中立な意図解決＋手順台帳 |
| **Agent-B（Compiler）** | ③ | `browser-recording-compiler.ts`, `browser-extension-bridge.ts` のコンパイル部, `automate-browser-workflow.json` | §6 契約, recording schema | ref解決/dry-run/Golden（browserアダプタ） |
| **Agent-C（Dispatcher）** | C, ⑤ | `procedure-dispatcher.ts`, `browser_bridge_host.ts`, 拡張の pause/中継 | A の `ProcedureResolution`, 既存 lease/approval | 実行振り分け＋MFA中継 |
| **Agent-D（Self-repair）** | ④, ② | `background.js`/`sidepanel.js` の録画・差分・意図抽出 UI | A の version API, B の pipeline形 | 差分学習＋対話的意図抽出 |
| **Agent-R（Reviewers）** | 横断 | （書き換えない／指摘のみ） | 全PR | §10 のレビュー |

> Layer② はUI密着のため Agent-D（拡張担当）に同梱。owner（あなた＝ミッション所有者）は §6 契約の凍結と統合を担う。Agent-A〜D は1ワーカー=1ブランチ/worktree で並行可（ファイル所有を分けてあるので衝突しにくい）。

各エージェントへの**起動プロンプト雛形**（owner が `delegateTask` 等で配る）：
> 「Kyberion の `docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md` の §6 共有契約と、あなたの担当である **Agent-X / Layer N** の §7 該当節・§8 の owns 範囲だけを実装せよ。owns 外のファイルは読むだけ。不変条件 §5 を厳守（secure-io / 承認ゲート / tier 指定 / ページ untrusted）。完了時は §7 の受入条件を満たすテストを `tests/` または `libs/core/*.test.ts` に追加し、`pnpm build` と該当テストの green を確認して差分を報告せよ。」

---

## 9. エージェント間 協調プロトコル

1. **契約凍結が最初のバリア**。owner が §6 の型・スキーマを1コミットでマージ。これ以前に Agent-A〜D は実装着手しない。
2. **着手順（依存グラフ）**:
   - 並行可: Agent-A, Agent-B, Agent-D の Layer②部分。
   - Agent-C は Agent-A の `resolveBrowserProcedure` シグネチャ確定後に着手（型は §6 で凍結済みなのでモック実装で先行可）。
   - Agent-D の Layer④（差分学習）は Agent-B の pipeline 形と Agent-C の停止シグナルが要るので最後。
3. **契約変更が必要になったら**：勝手に直さず owner へ要求 → owner が §6 を更新し全エージェントへ通知 → 影響エージェントが追従。型シグネチャの一方的変更は禁止。
4. **結合点はモックで疎結合に**：A→C は `ProcedureResolution`、B→D は draft pipeline JSON、C→D は `ProcedureDelta`。各々相手が未完成でも §6 の型に対するスタブで進める。
5. **統合は owner**。各ブランチを取り込み、`pnpm pipeline --input pipelines/baseline-check.json` が `all_clear`、`pnpm build`＋全関連テスト green を確認。

---

## 10. レビュー観点（Agent-R／横断）

| 観点 | 確認すること |
|---|---|
| セキュリティ | OTP/password/token/PII が draft・`chrome.storage`・trace・receipt・ログに残らない。ページ文言で policy/lease/許可操作が変わらない。`<all_urls>` 等の権限拡大が無い。 |
| ガバナンス整合 | 高リスク op が approval-gate を通る。draft が人間レビュー無しに `pipelines/` へ昇格しない。delta が promoted を自動上書きしない。tier 指定が必須化されている。 |
| 契約整合 | §6 の型/スキーマに準拠。owns 外のファイルを変更していない。結合点の型が一致。 |
| 不変条件 | File I/O が secure-io 経由のみ（`node:fs` 直呼び無し）。`Date.now()/Math.random()` 非依存（決定性）。 |
| 意図解決の健全性 | stub backend でも登録済み意図は解決。曖昧時に勝手にパターンBへ突入せず確認に落ちる。origin 不一致の手順を誤選択しない。 |
| 信頼性 | dry-run 成功時のみ Golden 付与。ambiguity/navigation/SPA再描画/MFA/service worker 再起動/lease失効の回帰がある。 |
| UX | 操作ラベルが目的中心の日本語（`click_ref`/selector を前面に出さない）。停止・ハンドオフ・中継が明示的。 |

---

## 11. フェーズ計画と受入条件

| フェーズ | 内容 | 受入条件 |
|---|---|---|
| **P0 契約凍結** | §6 の型・スキーマをマージ | スキーマ invalid ケースが弾かれる。型が全エージェントから import 可能。 |
| **P1 意図解決（①）** | Agent-A | 登録済み意図→`matched`（stub可）、未登録→`A`、曖昧→候補列挙。origin優先。 |
| **P2 コンパイラ（③）** | Agent-B | ref解決 or 要人手分類、dry-run成功時のみGolden、draftは非昇格。 |
| **P3 実行＋MFA（C/⑤）** | Agent-C | extension経路で承認→lease→実行→receipt→Golden検証が一気通貫。MFAで停止→再開。秘密非残留。 |
| **P4 自己修復＋意図抽出（④/②）** | Agent-D | 「壊れた→人が直した→次回通る」を回帰。録画後に入力が固定/可変/秘密へ分類。 |
| **P5 統合・昇格** | owner | 1意図発話でパターンA/B分岐し、Bが自動実行・検証・報告まで到達。ミッション/pipeline として証跡化。 |

各フェーズは「1つ変えたら即テスト」（CLAUDE.md §3 Execution）。重い解析・一括実装は `delegateTask()` でサブエージェントへ委譲し本ループの文脈を小さく保つ。

---

## 12. 確定事項（agyレビューで凍結 / 2026-06-23）

着手前の検討事項は以下の通り確定。P0 の共有契約に直接組み込む。

| 検討事項 | 確定 | 根拠 |
|---|---|---|
| パターンBの初期実行基盤（§4） | **`extension` 固定で開始** | SaaS は SSO/MFA 必須。ライブセッション再利用が headless 自動ログインより安定。Playwright は後続フェーズ。 |
| `browser-procedures.json` 保存 tier | **個人=`personal/` / 組織=`confidential/{project}/`** | 個人勤怠・ID が共有領域へ漏れるのを Tier 隔離で防ぐ。 |
| 意図解決しきい値（§6.2） | **0.75 / 0.4 で開始（設定でオーバーライド可）** | 適合率/再現率バランスの妥当な初期値。 |
| 新規 op | **既存 `extension_session` 再利用、新規追加は最小限** | risky-op を増やさずポリシー複雑化を回避。増やす場合のみ `approval-policy.json`/`risky-op-registry.ts` 登録。 |

加えて agy レビューにより、**Layer③ に SPA/iframe 自動待機・コンテキスト切替**（§7 Layer③ 追加要件A）、**Layer⑤ に MFA猶予 Lease 延長**（§7 Layer⑤ 追加要件B）を実装要件として組み込み済み。

---

## 13. 他 substrate への展開（汎用化方針とロードマップ）

本設計の中核（① 意図解決レジストリ／結晶化→人間レビュー→昇格→登録／④ 自己修復・差分学習）は substrate 非依存。**ブラウザ固有なのは「レコーダー」と「コンパイラの ref→selector 解決」だけ**。よって新 substrate の追加は「録画アダプタ＋実行アダプタ＋（必要なら）コンパイラ」を足すだけで、§6 の凍結契約・Layer①/④・昇格機構（`distill-candidate-registry`）はそのまま再利用する。

このリポジトリに既に土台があり、同じ形を持つインテント類型（着手しやすい順）：

| substrate | 既存土台 | 追加が要るアダプタ | アダプタ指示書 | 備考 |
|---|---|---|---|---|
| **service**（Jira/Slack/Box/Gmail 多段API合成） | `service-presets/`, `service:preset` op | サービス呼び出し列の**記録**アダプタ＋実行アダプタ | [INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md](./INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md) | DOM不要・構造化済みで**ブラウザより安全に学習可能**。最有力の次手。 |
| **desktop**（GUIアプリ自動化） | `os-automation-bridge.ts`, `computer-surface.ts` | OSイベント録画アダプタ＋実行アダプタ＋ref解決 | [INTENT_DRIVEN_DESKTOP_AUTOMATION_DESIGN.ja.md](./INTENT_DRIVEN_DESKTOP_AUTOMATION_DESIGN.ja.md) | ブラウザと最も近い「実演→再生」形。**座標依存と承認ゲート未整備が二大リスク**。 |
| **media**（PPTX抽出・レポート生成） | `media:*` op, `extract-brand-theme.json` | 例示→生成レシピの**蒸留ループ**（抽出・嗜好登録・承認は既存） | [INTENT_DRIVEN_MEDIA_AUTOMATION_DESIGN.ja.md](./INTENT_DRIVEN_MEDIA_AUTOMATION_DESIGN.ja.md) | 部品が最も揃い、欠落は結晶化ループのみ。**最短で価値**。 |
| **mail/messaging triage** | `email-triage-workflow.json`, Gmail preset | triade 実演の記録 | （service アダプタの一種として後続） | 日次反復。小さく始められる。 |

各アダプタ指示書は本書と同一の骨格（§1 再利用方針 → §6 録画/抽出 → §7 Layer①(共有)/③/C/⑤/④ → §8 リスク → §9 エージェント編成 → §10 レビュー → §11 フェーズ）で記述され、本書 §6 凍結契約・Layer①/④・`distill-candidate-registry`・`procedure-dispatcher.ts` を共有再利用する。`procedure-dispatcher.ts` は全 substrate が触るため **substrate 分岐で関数を分け同一ブロックを編集しない**（§9 準拠）。

**ロードマップ上の位置づけ**：本ドキュメントの P0〜P5 は **browser アダプタの完成**まで。browser が一巡したら、上記アダプタを同じ契約・同じ Layer①/④ の上に追加する。**今やるのは契約の一般化だけで、他アダプタの実装は P5 後**。実装難度・リスク・既存資産からの推奨着手順は **media（最短・低リスク）→ service（安全・高頻度）→ desktop（最難・要安全設計）**。
