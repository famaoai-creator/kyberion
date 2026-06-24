---
title: 意図駆動デスクトップGUI自動化（学習→再生） desktop アダプタ実装設計
kind: design-specification
scope: libs/core, libs/actuators/system-actuator, pipelines
authority: proposed
status: draft
owner: ecosystem_architect
reviewed_at: 2026-06-23
depends_on:
  - docs/INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md    # マスター設計（substrate 中立な §6 契約・Layer①/④・昇格機構）
  - docs/INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md    # 兄弟アダプタ（同構造）
tags: [desktop, os-automation, accessibility, intent-loop, approval, multi-agent, adapter]
---

# 意図駆動デスクトップGUI自動化 — `substrate: "desktop"` アダプタ設計

> **本書はマスター設計の adapter 仕様**。substrate 中立に凍結した **§6 契約・Layer①（意図解決）・Layer④（自己修復）・昇格機構（`distill-candidate-registry`）は再利用**し、本書は **desktop 固有のアダプタ（録画・コンパイル・実行・安全ゲート）だけ**を規定する。
> 扱うのは「**この社内アプリで承認処理しておいて**」のような、ブラウザ外のネイティブGUIアプリ操作。
> ⚠️ **desktop は browser に最も近いが、最も壊れやすく・最もリスクが高い**（座標依存＋承認ゲート未整備）。本書は安全側に強く倒す。

---

## 1. 位置づけ（再利用するもの／新規に作るもの）

| 要素 | 出所 | 扱い |
|---|---|---|
| §6 契約・Layer①・Layer④・昇格機構 | マスター（substrate 中立） | **再利用** |
| 実行プリミティブ（click/keystroke/screenshot/window/focus） | 既存 `osAutomationBridge`（`libs/core/os-automation-bridge.ts:38-70`） | **再利用** |
| セマンティック focus 検出（AX role/description/editable） | 既存 `apple-event-bridge.ts:detectFocusedInput` | **再利用（後述の脱・座標化の要）** |
| 実行 op | 既存 `system:*`（`libs/actuators/system-actuator`） | **再利用** |
| ライブ状態の可視化 | 既存 `computer-surface.ts:emitComputerSurfacePatch`（`runtime/computer/sessions/`） | **再利用（ただし action trail ではない）** |
| **録画アダプタ（OSイベント列の記録）** | — | **新規（本書 §6、最難関）** |
| **コンパイラ（座標→セマンティック・ターゲット解決）** | — | **新規（本書 §7-③、browser の ref 解決に相当）** |
| **desktop 安全ゲート（破壊的操作の承認）** | 現状ほぼ無い | **新規・必須（本書 §8）** |

**結論**：desktop の新規実装は「録画層」「座標→セマンティック解決コンパイラ」「破壊的操作の承認ゲート」。実行プリミティブと AX 土台は既存。

---

## 2. 目標・非目標

### 目標
1. ネイティブGUIアプリの操作列を NL意図から解決し再生する（パターンB）。
2. 未学習時はユーザの実演（クリック/入力/ウィンドウ操作）を**セマンティック・ターゲット込みで録画**し、再利用 pipeline へ昇格（人間レビュー後、パターンA）。
3. 破壊的・外部影響のある操作（送信/削除/アプリ終了/プロセス kill/任意 keystroke）は**必ず承認**を取る。
4. 座標ドリフトで壊れた手順を、AX/ウィンドウ・セマンティックで再ターゲットし、人の修正差分を学習する。

### 非目標
- 任意座標の盲目クリックを「手順」として無検証で昇格しない（壊れやすく危険）。座標のみのステップは録画時に「要セマンティック化／要人手」と分類。
- macOS 以外は V1 対象外（`osAutomationBridge` は AppleScript/cliclick 前提）。理由を UI に明示。
- アクセシビリティ権限・cliclick 未導入の環境では実行不可とし、案内する。

---

## 3. desktop が browser と違う点（アダプタ差分の要点）

| 観点 | browser | **desktop** |
|---|---|---|
| ターゲット | DOM ref（role/name、安定） | **多くが画面座標（cliclick）で壊れやすい**。focus だけ AX セマンティック |
| 録画機構 | あり（extension） | **無い（本書で新規）**。`computer-surface` は最新状態のみ persist、action trail 無し |
| 再生の安定性 | re-snapshot + ambiguity 停止 | **座標ドリフトに極端に弱い** → 脱・座標化が品質の生命線 |
| 実行系 | `extension_session` | **`system:*` op**（mouse_click/keyboard/paste_text/press_key/activate_application/get_focused_input/screenshot…） |
| 承認ゲート | 高リスク op は approval 済み | **desktop 破壊操作は現状ほぼ無防備**（§8 で必須整備） |
| 「ログイン/MFA」 | 中核課題 | 多くはアプリが既に起動済みで回避。ただし要すれば §7-⑤ で承認中継 |
| Golden 検証 | 終端DOM | **終端スクリーンショット＋AX状態**（focus/ウィンドウタイトル/通知） |

---

## 4. パターンA/B（desktop 版の流れ）

```text
ユーザ意図「社内アプリで承認しておいて」
   │ Layer①（共有） resolveProcedure(intent)
   ├─ matched (B) ──────────────────────────┐
   │                                          ▼
   │                            [§7-C 実行アダプタ]
   │                            activate_application → (window 特定) →
   │                            get_focused_input(AX) → paste_text/press_key →
   │                            破壊操作は §8 approval → 再生
   │                            座標ステップは実行前に再ターゲット試行
   │                                          ▼
   │                            Golden 検証（screenshot+AX）→ receipt
   └─ unmatched (A) ─┐
                     ▼
       [§6 録画アダプタ] OSイベント列を**セマンティック・ターゲット込み**で記録
                     ▼
       [§7-③ コンパイラ] 座標→AX/ウィンドウ・ターゲットへ昇格、要人手を分類
                     ▼
       人間レビュー → 昇格（distill-candidate-registry）→ procedures.json 登録
                     （= 次回からパターンB）
```

---

## 5. 不変条件（マスター §5 を継承）

- File I/O は `@agent/core/secure-io` のみ。tier 指定必須（個人=`personal/`、組織=`confidential/{project}`）。
- **破壊的 desktop 操作は approval-gate を必ず通す（§8）**。これは desktop アダプタの最重要不変条件。
- `shell`/`run_js` は既存どおり `ALLOW_UNSAFE_SHELL`/`ALLOW_UNSAFE_JS` ゲートを尊重。
- スクリーンショットに写り込む PII/秘密の取り扱いに注意（trace/receipt 保存時に redaction 方針を適用）。
- ミッション化必須（`scripts/mission_controller.ts`）。

---

## 6. desktop 録画アダプタ（新規・最難関）

ブラウザ content.js に相当。**座標の生記録ではなく、可能な限りセマンティック・ターゲットを captures する**のが品質の鍵。

- **記録単位（`desktop-recording.v1`、新規スキーマ）**：
  ```jsonc
  {
    "recording_id": "...", "created_at": "...", "source": "desktop-capture",
    "substrate": "desktop", "platform": "darwin",
    "steps": [
      { "op": "activate_application", "target": { "app": "ApprovalApp" } },
      { "op": "focus_input",                        // get_focused_input(AX) の結果
        "target": { "app": "ApprovalApp", "window_title": "承認待ち",
                    "ax_role": "AXTextField", "ax_description": "コメント", "editable": true } },
      { "op": "fill", "value_classified": { "kind": "input", "name": "comment" } }, // 値は分類のみ
      { "op": "press_key", "key": "enter", "risk_class": "high" }, // 承認確定＝破壊操作
      { "op": "click", "target_fallback": { "x": 980, "y": 640 },  // 座標は fallback 扱い
        "semantic_hint": { "window_title": "承認待ち", "label_near": "承認" },
        "needs_semantic_resolution": true }
    ],
    "recording_hash": "...", "policy_version": "..."
  }
  ```
- **取得**：`osAutomationBridge` のイベントをフックして記録。各操作で **直前に `detectFocusedInput()`／`getWindowList()` を呼び、AX role/description・ウィンドウタイトルを必ず同梱**。座標は `target_fallback` として保持し `needs_semantic_resolution:true` を立てる。
- **redaction**：入力値は `kind: fixed|input|secret`（マスター Layer② 同思想）。スクリーンショットは既定で手順に同梱しない（検証用に限定し redaction）。
- **対象ファイル**：新規 `libs/core/desktop-recording.ts`, 新規 `knowledge/product/schemas/desktop-recording.schema.json`, フック点として `os-automation-bridge.ts`（観測のみ、破壊操作は足さない）
- **受入条件**：全 step に app/window もしくは AX ターゲットが付く。座標のみの step は `needs_semantic_resolution` が立つ。入力値・スクショ内秘密が手順/trace に残らない。

---

## 7. レイヤー別 設計（desktop 固有部分のみ）

### Layer① 意図解決 — **再利用（追加なし）**
`procedures.json` に `substrate:"desktop"` エントリを足すだけ。例：
```jsonc
{
  "procedure_id": "approval.${APPROVAL_INTERNAL_HOST}-app",
  "substrate": "desktop",
  "adapter": { "recorder": "desktop-capture", "executor": "system" },
  "target": { "name": "ApprovalApp", "platform": "darwin" },
  "intent_phrases": ["社内アプリで承認", "承認処理して", "approve in the app"],
  "pipeline_ref": "pipelines/desktop/approval-internal-app.json",
  "required_inputs": [ { "name": "comment", "label": "コメント", "type": "string", "optional": true } ],
  "risk_class": "high",
  "golden_scenario_ref": "knowledge/.../golden/approval-internal-app.v1.json",
  "version": "1.0.0", "status": "active"
}
```

### Layer③ コンパイラ（録画→draft pipeline、**脱・座標化が中核**）
- **要件**：`desktop-recording.v1` を `system:*` ステップ列へ変換。**座標を可能な限りセマンティック手順へ置換**（browser の ref→selector に相当）。
- **設計**：新規 `libs/core/desktop-recording-compiler.ts`
  - 入力ステップ：`focus_input` + `fill` → `system:activate_application` → `system:get_focused_input`（AX で対象確認、role/editable が一致しなければ停止）→ `system:clipboard_write`＋`system:paste_text`（既存 `focused-form-fill.json` の安全パターンを踏襲）。
  - クリック：`semantic_hint`（window_title + label_near）から `activate_window_by_title`（match policy）＋ focus 確認で代替できれば座標を捨てる。代替不能な座標のみ step は **`_review_required` に「座標依存・要人手確認」**として残す。
  - **dry-run / rehearsal**：副作用を起こさず確認するため、**read-only（screenshot / get_focused_input / window_list）だけを試走**。破壊操作（press_key 確定/click 送信/app_quit）は dry-run で発火させない。
  - `extractGoldenScenario`：終端 `screenshot` ＋ `get_focused_input`/ウィンドウタイトル/`system_notify` を成功表明として §6.4 形式で同梱。
- **対象ファイル**：`libs/core/desktop-recording-compiler.ts`(新), `knowledge/product/pipeline-templates/automate-desktop-workflow.json`(新)
- **受入条件**：座標 step が AX/ウィンドウ・ターゲットに昇格 or 「要人手」分類。破壊操作を dry-run 非発火。draft は `_draft:true` で人間レビューまで昇格しない。

### Layer C 実行アダプタ — **既存 `system:*` を再利用**
- **設計**：`procedure-dispatcher.ts`（マスター §7-C と同一ファイル）の desktop 分岐：`adapter.executor==='system'` → 各 step を `system-actuator` の対応 op で実行。実行前に AX/ウィンドウで対象を再確認し、**不一致なら停止して再ターゲット要求**（browser の ambiguity 停止に相当）。破壊操作は §8 approval。
- **対象ファイル**：`libs/core/procedure-dispatcher.ts`（desktop 分岐追加）, 既存 system-actuator（変更なし）
- **受入条件**：対象アプリ/ウィンドウ不在・AX 不一致で暴走せず停止。破壊操作は承認なしに実行されない。

### Layer⑤ 認証・権限ゲート（browser MFA 中継に相当）
- desktop の多くは「対象アプリが既にログイン済み」で回避。ただし (a) アプリ内ログイン要求の検出時は `pause` してユーザへ中継、(b) **アクセシビリティ権限 / cliclick 未導入**は実行不可として明示案内（V1 非対象理由を返す）。
- **対象ファイル**：`procedure-dispatcher.ts`（権限・ログイン待ち state）, `os-automation-bridge.ts`（権限プローブ）
- **受入条件**：権限欠如・ログイン要求で自動失敗せず案内/中継に落ちる。

### Layer④ 自己修復・差分学習 — **再利用＋ desktop 評価器のみ追加**
- 座標ドリフト・UI変更で停止 → 人が手動で正しい要素を再指定 → その**差分（新しい AX ターゲット/手順）を `ProcedureDelta`** 化し該当 step に差し込む。**座標 fallback よりセマンティック・ターゲットを優先採用**する学習方針。
- **設計**：`assessDesktopDistillCandidate`（汎用 interface の desktop 実装）追加。`distill-candidate-registry.ts` は共有。
- **対象ファイル**：新規 `libs/core/desktop-distill-candidate.ts`, 既存 `distill-candidate-registry.ts`（再利用）
- **受入条件**：「座標ずれで壊れた→人が再指定→次回はセマンティックで通る」を回帰再現。delta は人手レビュー無しに promoted を上書きしない。

---

## 8. リスク・承認の拡張（desktop の最重要整備）

現状 `risky-op-registry.ts`/`approval-policy.json` は **desktop 操作（mouse_click/keyboard/paste_text/press_key/app_quit/process_kill）を高リスク分類していない**（shell/JS のみ env ゲート）。**本アダプタは破壊的 desktop 操作を approval 対象に追加することを必須要件とする。**

- **追加分類**：`desktop:destructive_action`（送信確定/削除/`app_quit`/`process_kill`/任意アプリへの `paste_text`+`press_key` 確定系）を `approval-policy.json` に追加し、`risky-op-registry.ts` に op ID 登録。手順上 `risk_class:"high"` の step は実行直前に承認＋再確認。
- read-only（screenshot/get_focused_input/window_list/clipboard_read）は非ゲートで高速のまま。
- 任意 `keystrokeText`/`paste_text` は対象アプリ・対象 AX フィールドが手順で固定されている場合のみ許可。盲目入力は不可。
- **受入条件**：破壊操作が承認なしに実行されない。read-only は承認不要。リスク分類の無い未知 op は安全側（承認要）に倒す。

---

## 9. エージェント別 実装範囲（マスター §8 と整合）

| Agent | 担当 | owns | 依存（読むだけ） | 成果物 |
|---|---|---|---|---|
| **Agent-D1（Recorder）** | §6 | `desktop-recording.ts`, `desktop-recording.schema.json`, `os-automation-bridge.ts` の観測フック | §6 契約, `apple-event-bridge.ts` | AX込み OSイベント録画＋redaction |
| **Agent-D2（Compiler）** | §7-③ | `desktop-recording-compiler.ts`, `automate-desktop-workflow.json` | §6 契約, system-actuator op 一覧 | 脱・座標化/dry-run(read-only)/Golden |
| **Agent-D3（Dispatcher/Gate）** | §7-C, ⑤ | `procedure-dispatcher.ts` の desktop 分岐 | A の `ProcedureResolution`, system-actuator, AX | 実行＋再ターゲット停止＋権限案内 |
| **Agent-D4（Risk/Distill）** | §8, §7-④ | `desktop-distill-candidate.ts`, `approval-policy.json`/`risky-op-registry.ts` の desktop 追加 | `distill-candidate-registry.ts` | 破壊操作分類＋差分学習 |
| **Agent-R（Reviewers）** | 横断 | （指摘のみ） | 全PR | §10 レビュー |

> `procedure-dispatcher.ts` は browser/service/desktop が触る共有ファイル。**substrate 分岐で関数を分け、同一ブロックを編集しない**（マスター §9 準拠）。Layer①/④ 本体は browser チームが実装する共有層。

起動プロンプト雛形：
> 「`docs/INTENT_DRIVEN_DESKTOP_AUTOMATION_DESIGN.ja.md` の §1 再利用方針と担当 **Agent-DX** の §6〜§8 該当節・§9 owns 範囲だけを実装。マスター §6 凍結契約と不変条件（§5）厳守。**破壊操作は必ず approval-gate を通し、座標のみのステップは昇格せず要人手に分類**。dry-run は read-only のみ。受入条件のテストを追加し `pnpm build`＋該当テスト green を確認して報告。」

---

## 10. レビュー観点（Agent-R）

| 観点 | 確認 |
|---|---|
| セキュリティ | 破壊的 desktop 操作が approval-gate を通る。盲目座標クリック/入力を昇格していない。スクショ内 PII/秘密が手順/trace/receipt に残らない。 |
| 信頼性 | 座標 step が AX/ウィンドウ・ターゲットへ昇格 or 要人手。実行前に対象再確認し不一致で停止。 |
| 契約整合 | マスター §6 凍結型に準拠。`substrate:"desktop"` が共有 resolver で解決。owns 外（Layer①/④ 本体）不変更。 |
| 不変条件 | secure-io 経由のみ。`Date.now()/Math.random()` 非依存。tier 指定必須。 |
| dry-run 安全性 | read-only のみ試走、破壊操作を dry-run 非発火。 |
| 環境前提 | macOS 限定・AX 権限・cliclick の有無を検出し、不可時に案内。 |

---

## 11. フェーズ計画

| フェーズ | 内容 | 受入条件 |
|---|---|---|
| **D0** | `desktop-recording.schema.json` ＋ desktop エントリ例を §6 契約に追加 | スキーマ invalid が弾かれる |
| **D1 録画** | Agent-D1 | AX/ウィンドウ込みで OSイベント記録。座標のみは要セマンティック化フラグ。秘密非残留。 |
| **D2 コンパイラ** | Agent-D2 | 脱・座標化、read-only dry-run、Golden 付与、破壊操作非発火。 |
| **D3 実行＋ゲート** | Agent-D3 | 対象再確認で停止、権限案内、破壊操作は承認必須。 |
| **D4 リスク＋自己修復** | Agent-D4 | 破壊操作分類が効く。座標ずれ→再指定→次回通るを回帰。 |
| **D5 昇格** | owner | 1意図で desktop 手順を自動実行・検証・報告。ミッション/pipeline 証跡化。 |

---

## 12. 着手前に owner が確定すべき事項

- V1 対象 OS を macOS 限定で確定するか（推奨：限定）。
- `desktop:destructive_action` に含める op 集合の確定（送信確定/削除/app_quit/process_kill/確定系 keystroke）。
- 録画フックを `os-automation-bridge` に置くか、`system-actuator` の dispatch 層に置くか（推奨：bridge 観測 + dispatch 記録の二重で取りこぼし防止）。
- 座標のみ step を「昇格不可（常に要人手）」とするか「fallback 付きで許可」とするか（推奨：V1 は昇格不可で安全側）。

---

## 13. クロスリファレンス

- マスター（substrate 中立契約・Layer①/④）: `INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md`
- 兄弟アダプタ（API合成）: `INTENT_DRIVEN_SERVICE_AUTOMATION_DESIGN.ja.md`
- 兄弟アダプタ（文書生成）: `INTENT_DRIVEN_MEDIA_AUTOMATION_DESIGN.ja.md`

> desktop は browser に構造が最も近い分、**脱・座標化と破壊操作の承認**という2点に品質と安全が集約される。この2点を受入条件で固めることが本アダプタの成否を決める。
