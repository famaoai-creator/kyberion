---
title: Skill Recorder 概念取り込み計画(DR-01〜09)
kind: improvement-plan
scope: libs/core / procedure-* / os-automation / pii-scrubber / ocr-bridge / evals
authority: planning
status: implemented
---

# Skill Recorder 概念取り込み計画(DR-01〜09): 実演観測 → 意図再構成 → ネイティブ op 優先の蒸留

> **作成日**: 2026-08-09
> **起点**: [microsoft/skill-recorder](https://github.com/microsoft/skill-recorder) v0.4.2(Electron + TypeScript、~25k LOC、MIT)の全サブシステム実コード分析(2026-08-09、shallow clone にて実施)。
> **位置づけ**: [OPENHARNESS_ADOPTION_PLAN](./OPENHARNESS_ADOPTION_PLAN_2026-07-18.ja.md) と同じ「コードは取り込まず概念だけ既存契約へ昇華する」方式。
> 本計画は**新パラダイムの提案ではない**。Kyberion は既に [INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN](../../INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md)(学習→再生、パターン A/B)を**凍結契約**として保有しており(`libs/core/procedure-types.ts`)、skill-recorder はその **desktop サブストレート**と**蒸留品質**に対する実装参照である。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 0. 実装状況（2026-08-09）

DR-01〜DR-09 は実装済み。フェーズごとの独立レビュー結果と制約は
[REVIEW_DR_2026-08-09.ja.md](./REVIEW_DR_2026-08-09.ja.md) を正本とする。

| フェーズ | 対象          | 判定 | 主な証拠                                                                                          |
| -------- | ------------- | ---- | ------------------------------------------------------------------------------------------------- |
| Phase 1  | DR-01 / DR-02 | DONE | `risky-op-registry` / `procedure-dispatcher` テスト、desktop schema、browser pipeline 参照検査    |
| Phase 2  | DR-04 / DR-03 | DONE | `desktop-recording` テスト、静止フレーム差分・heartbeat、baseline/doctor の readiness 表示        |
| Phase 3  | DR-05 / DR-06 | DONE | intent schema/review、観測→native op map 検証、GUI fallback 回帰                                  |
| Phase 4  | DR-07         | DONE | frame redaction/egress テスト、browser extension の共有 PII rule                                  |
| Phase 5  | DR-08 / DR-09 | DONE | `pnpm eval:distill` score 1.0、production import、trace→draft ADF preflight、human promotion gate |

実装の共通境界は `@agent/core` に置き、入力値・clipboard 本文・OCR 読み取り文字列は録画/trace/egress の成果物へ保存しない。trace→ADF は `_draft: true` かつ人手レビュー前は実行系へ登録しない。

## 1. 診断

### 1.1 skill-recorder とは

「人間が一度やった作業を画面ごと記録し、GitHub Copilot CLI に **intent + 順序付き steps** として再構成させ、そこから再利用可能な `SKILL.md`(スキル)またはスケジュール実行される Automation を生成する」ツール。macOS 主対象、Windows 対応。

Kyberion にとっての価値は製品としてではなく、**「観測 → 蒸留 → 再利用可能成果物」を実運用品質で通した実装のカタログ**である。とりわけ次の3点は Kyberion の既存設計に欠けている:

1. **人間の実演を、専用フックなしに OS レベルの安価な信号だけで観測する**方式。
2. 録画とコンパイルの間に **「意図 + 手順」という人間レビュー可能な意味層**を挟む設計。
3. 記録された GUI 操作を **再生せず、ターゲットのネイティブ機能に置換する**方針と、それを守らせる決定論的 eval。

### 1.2 対応表(skill-recorder 実装 → Kyberion 現状 → 判定)

| 機構                   | skill-recorder 実装                                                                                            | Kyberion 現状                                                                                                        | 判定                 |
| ---------------------- | -------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------- |
| 学習→再生の契約        | `common/analysis.ts` + `common/skill.ts`(アプリ固有)                                                           | `libs/core/procedure-types.ts`(substrate 中立・凍結済み、A/B パターン、しきい値定数まで規定)                         | **Kyberion が上位**  |
| browser 録画           | 無し(画面録画で代替)                                                                                           | `tools/adf-replay-extension/`(MV3、DOM セマンティクス付き、per-action 承認 UI)+ `browser-recording-compiler.ts`      | **Kyberion が上位**  |
| desktop 実演録画       | `electron/collectors/*`(ポーリング型。app 切替 1000ms / clipboard 700ms / URL 1500ms)                          | **無し**。`desktop-recording.schema.json` は存在するが**生成元がゼロ**                                               | **欠落 → DR-03**     |
| desktop 実行系         | 該当なし(生成物は他エージェントが実行)                                                                         | `os-automation.ts` に `clickAt`/`keystrokeText`/`getWindowList`/`takeScreenshot` 等が**既に揃っている**              | **結線漏れ → DR-02** |
| desktop 破壊操作の承認 | 該当なし                                                                                                       | `RISKY_OPS`(`risky-op-registry.ts:19-28`)は7件、desktop 系は**1件も無い**                                            | **欠落 → DR-01**     |
| 観測ソースの費用宣言   | `CAPTURE_SOURCES`(`common/config.ts:45-51`)が source ごとに `tier` と `cost` を宣言                            | tier は data tier(personal/confidential/public)のみ。観測ソース単位の取得コスト宣言は無し                            | **欠落 → DR-04**     |
| 意図再構成(describer)  | Copilot CLI エージェント + 6 サンドボックス tool → `submit_analysis` で intent + steps を強制構造化出力        | 録画 → コンパイラの直結。**意味層が無い**(`browser-recording-compiler.ts` は 1:1 転写)                               | **欠落 → DR-05**     |
| 1例からの汎化          | `skillbuilder/instructions.ts:33-41`「録画は1例。N 件を扱う手順に汎化せよ」                                    | `{{input.*}}` プレースホルダはあるが、**コレクション反復への汎化は無い**                                             | **欠落 → DR-05**     |
| ネイティブ機能への置換 | catalogue 内の「記録された操作 → 優先すべき機能」対応表(`scout-catalogue.ts:75-88`)+ 優先順位ラダー            | `CAPABILITIES_GUIDE.md`(32 actuator、manifest から**自動生成**)はあるが、**観測 → op の対応表が無い**                | **部分 → DR-06**     |
| 秘密の混入防止         | `@secretlint/*` + `tesseract.js` による**フレーム OCR redaction**、fail-closed(スキャン失敗→フレーム withhold) | `pii-scrubber.ts`(rule 駆動、Luhn/マイナンバー検証)と `ocr-bridge.ts`(Tesseract/AppleVision)は個別に成熟。**未結合** | **部分 → DR-07**     |
| 蒸留器の eval          | `evals/`(合成 fixture、決定論スコアリング、`PASS_THRESHOLD=0.8`、LLM judge は既定 off)                         | コンパイラ/昇格器に対する eval は**無い**                                                                            | **欠落 → DR-08**     |
| 実行成功→再利用昇格    | 該当なし                                                                                                       | `pipeline_promote.ts`(LC-02)+ `promotion-candidates.ts`(3回で候補提示)                                               | **Kyberion が上位**  |
| 意図解決(NL → 手順)    | 該当なし(スキル名/description で他エージェントが解決)                                                          | `procedure-registry.ts`(決定論スコアリング → 曖昧時のみ意味ランキング、stub でも動く)                                | **Kyberion が上位**  |
| 自己修復・差分学習     | 無し                                                                                                           | `procedure-self-repair.ts` + `ProcedureDelta`(人手レビュー gate 付き)                                                | **Kyberion が上位**  |

### 1.3 最大の発見 — 契約は凍結済みで、欠けているのは「観測層」と「意味層」

`libs/core/procedure-types.ts:18` は `ProcedureSubstrate = 'browser' | 'desktop' | 'service' | 'media'` を凍結しており、[INTENT_DRIVEN_DESKTOP_AUTOMATION_DESIGN](../../INTENT_DRIVEN_DESKTOP_AUTOMATION_DESIGN.ja.md) は desktop アダプタを詳細設計済みである。しかし実装は止まっている:

1. `procedure-dispatcher.ts:141-149` は `executor: 'system'` に対し `not_implemented` を返す。そのコメントは **「desktop has no OS automation backend」と書かれているが、これは事実に反する** — `libs/core/os-automation.ts` は `clickAt` / `rightClickAt` / `keystrokeText` / `pasteText` / `pressKey` / `getWindowList` / `activateWindowByTitle` / `takeScreenshot` / `clipboardRead` を macOS・Windows 両対応でエクスポート済みである。同じ陳腐化した注記が `desktop-recording.schema.json:5` にもある。**再生側はほぼ揃っており、止まっているのは観測側**。
2. `knowledge/product/orchestration/procedures.json` は空(`"procedures": []`)。実データは `knowledge/personal/browser-procedures.json` の 5 件のみ。
3. その 5 件はすべて `pipelines/browser/{id}.json` を参照するが、**`pipelines/browser/` ディレクトリが存在しない**。録画→カタログ登録は動いているが、コンパイル済み成果物が永続化されていない。

さらに、Kyberion の蒸留は**散文しか生まない**。`extractHintsFromTrace`(`libs/core/src/feedback-loop.ts`)は `HINTS.md` へのテキストヒントを、`DistillCandidateRecord.target_kind` は `pattern | sop_candidate | knowledge_hint | report_template` を生成する — **実行可能成果物の選択肢が無い**。成功したミッションはヒントを残すが pipeline を残さない。

### 1.4 desktop 設計 §6 の想定を補正する必要がある

既存設計 §6 は録画層を「`osAutomationBridge` のイベントをフックして記録」と規定している。これは **エージェントが操作している場合にしか発火しない**。パターン A の前提は「未学習だから人間が実演する」であり、その瞬間 `osAutomationBridge` は呼ばれていない。**人間の実演を観測するには、介入(hook/intercept)ではなく独立した観測が要る。**

skill-recorder はここを、特権的なイベントタップを使わず **安価な高信号ソースのポーリング**で解いている(`electron/collectors/`):

- アクティブウィンドウ/タイトル: 1000ms(ただし**ブラウザが前面のときは 1600ms** — `get-windows` の Apple Events 往復がブラウザを詰まらせるため)
- クリップボード: 700ms(内容ではなく **sha1[:16] + 120字プレビュー**のみ保持)
- ブラウザ URL: 要求時のみ、最小間隔 1500ms、fire-and-forget
- 画面映像: **二次的**。1fps・720p・VP8 で、かつ dHash 差分ゲート(ハミング距離 ≤8 は破棄)+ 5 秒ハートビートで JPEG を間引く

そして describer への指示が設計思想を明言している(`electron/describer/instructions.ts:20-30`):

> 「recorder は安価で高信号な OS イベントを **PRIMARY** ソースとして収穫した。低フレームレートの画面映像も存在しうるが、それは **OPPORTUNISTIC な補強**であり、イベントが曖昧な箇所でのみフレームを引く。**映像を見なければならないと仮定するな**。大半のステップはイベントだけで完全に説明できる。」

Kyberion にとっての含意は大きい: `os-automation.ts` は既に `getWindowList` / `activateWindowByTitle` / `clipboardRead` / `listChromeTabs` を持つ。**skill-recorder の collector 群に相当する原材料は、新規ネイティブ実装なしで既に手元にある。**

## 2. 採用方針

**コードは取り込まない**(Electron/Copilot CLI 前提、かつ Kyberion 側の契約のほうが上位)。概念のみ既存の凍結契約・typed ops へ昇華する。

### 不採用(理由付き)

| 機構                                       | 不採用理由                                                                                                                                 |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Electron アプリ / 録画 HUD                 | オペレータ接点は SU-0x / E2E-04 の管轄。録画制御は既存 surface(Chronos / CLI)に載せる                                                      |
| catalogue のハンドオーサリング散文         | Kyberion は `CAPABILITIES_GUIDE.md` を manifest から**自動生成**済み。手書き散文を固定する skill-recorder 方式は退化。DR-06 で生成側に倒す |
| `SKILL.md` を第一級の成果物とする方針      | Kyberion の再利用成果物は `pipelines/*.json` + `ProcedureEntry`(実行可能・検証可能)。SKILL.md は外部ハーネス向けエクスポートに留める       |
| Automation(スケジュール実行)の独自スキーマ | `mission_controller` + scheduler が上位互換。二重化しない                                                                                  |
| commit ピン止めソースリリース + install.sh | OP-03(INSTALL_DISTRIBUTION)の管轄。別軸で扱う                                                                                              |
| Whisper 常時ナレーション                   | 音声基盤(`mic-capture.ts` / `speech-to-text-bridge.ts` / mlx-whisper)は既に保有。録画への統合は DR-03 の後続で判断(本計画では非対象)       |

### 採用の順序原則

**承認ゲート(DR-01)を先に置く。** desktop 実行系は座標依存かつ破壊的で、`RISKY_OPS` に1件も分類が無い。実行を結線してから承認を足すのは順序として誤りである。

## 3. 実装計画

### DR-01: desktop 破壊操作の承認分類(P0 / S)— **他のすべての前提**

**内容**: `desktop:destructive_action` を `knowledge/product/governance/approval-policy.json` に追加し、`RISKY_OPS`(`libs/core/risky-op-registry.ts:19-28`)に op ID を登録する。対象は送信確定・削除・`app_quit`・`process_kill`・任意アプリへの `paste_text`+`press_key` 確定系。read-only(`takeScreenshot` / `detectFocusedInput` / `getWindowList` / `clipboardRead`)は非ゲートで高速のまま維持する。リスク分類の無い未知 desktop op は**安全側(承認要)に倒す**。

**受入条件**:

1. 破壊操作が承認なしに実行されない boundary test。
2. read-only op が承認を要求しない(性能退化しない)テスト。
3. 未分類 desktop op が deny ではなく「承認要」に落ちる(AR-06 に従い silent no-op にしない)。

**担当モデル**: sonnet

### DR-02: desktop executor の結線 + 陳腐化した契約注記の是正(P0 / M)

**内容**: `procedure-dispatcher.ts:141-149` の `case 'system'` を `system-actuator` 経由で実装する。実行前に AX/ウィンドウで対象を再確認し、**不一致なら停止して再ターゲットを要求**(browser の ambiguity 停止と同型)。併せて事実に反する注記を修正する:

- `procedure-dispatcher.ts:143-144` の「desktop has no OS automation backend」
- `desktop-recording.schema.json:5` の「NO executor exists yet (no OS-automation backend)」

**副次**: `pipelines/browser/` 欠落の是正。`knowledge/personal/browser-procedures.json` の 5 エントリが参照するコンパイル済み pipeline が永続化されていない。`compileBrowserRecordingToPipeline()` の出力を実際に書き出すか、参照側を録画直接replayに正すか、どちらが正かを判定して片付ける。

**受入条件**:

1. `substrate: 'desktop'` の procedure が dispatch され、対象アプリ/ウィンドウ不在・AX 不一致で暴走せず停止する。
2. 破壊操作が DR-01 の承認を必ず通る。
3. `pipelines/browser/` の参照断裂が解消され、`procedures.json` / `browser-procedures.json` の `pipeline_ref` がすべて解決する回帰テスト。

**担当モデル**: opus(結線設計)→ sonnet(実装)

### DR-03: 人間実演レコーダ(ポーリング観測)(P0 / L)— **本計画の中核**

**内容**: `desktop-recording.v1` を実際に生成する観測層を新設する(`libs/core/desktop-recording.ts`)。既存設計 §6 の「`osAutomationBridge` をフックする」方式は**人間の実演では発火しない**(§1.4)ため、**独立ポーリング観測**に改める。

- **観測ソース**: `getWindowList` / `activateWindowByTitle`(アクティブアプリ・ウィンドウタイトル)、`clipboardRead`(sha1 + 短いプレビューのみ。**内容は保持しない**)、`listChromeTabs`(ブラウザ URL)、`detectFocusedInput`(AX role/description/editable)。すべて `os-automation.ts` の既存エクスポート。
- **映像は二次**: `screen-capture-bridge.ts` / `screen-recording-bridge.ts` を低レートで使い、**dHash 差分ゲート + ハートビート**で間引く(skill-recorder は 64bit dHash・ハミング距離 8・5 秒ハートビート・1fps/720p)。ハートビートは「静止画面でも任意の窓に必ずキーフレームが1枚存在する」ことを保証するための下限であり、省略してはならない。
- **ステップ分割**: 全イベントではなく **アプリ変更・URL の *ホスト* 変更・コマンド実行**の3つだけを境界とする(`common/bundle.ts:166-172`)。ホスト単位で切ることが SPA 内 40 遷移を 1 ステップに畳む最大の削減レバー。どの規則で境界が開いたかを step に記録し、分割器に自己説明させる。
- **座標の扱い**: 既存設計どおり、座標は `target_fallback` に落とし `needs_semantic_resolution: true` を立てる。

**受入条件**:

1. 人間の実演(Kyberion 側の自動化を一切経由しない操作)から `desktop-recording.schema.json` 準拠の記録が生成される。
2. 全 step に app/window もしくは AX ターゲットが付く。座標のみの step は `needs_semantic_resolution` が立つ。
3. 静止画面で1分放置してもフレームが線形に増えない(差分ゲートが効いている)ことの計測テスト。
4. クリップボード本文・入力値が記録にも trace にも残らない。
5. ブラウザ前面時のポーリング減速により、実演中の体感遅延が発生しない。

**担当モデル**: opus(観測設計)→ sonnet(実装)

### DR-04: 観測ソースの tier / cost 宣言(P1 / S)

**内容**: skill-recorder の `CAPTURE_SOURCES`(`common/config.ts:45-51`)に倣い、観測ソースごとに **必要権限段階と取得コストを宣言**する registry を設ける。skill-recorder の宣言は tier 0(権限不要: アプリ切替・クリップボード)/ tier 1(一度きりの OS 権限: ウィンドウタイトル・ブラウザ URL)/ tier 3(画面収録権限: 映像)である。

Kyberion では既存の data tier(personal/confidential/public)と**別軸**であることを明示し、`runDoctor()` 相当の可用性チェック(どのソースが本当に使えるか、権限が足りているか)を baseline-check に接続する。オペレータには「何が記録されるか」を録画開始前に必ず提示する。

**受入条件**:

1. 観測ソース registry が単一の正本として存在し、録画設定・可用性チェック・ユーザ提示の3者がそこだけを読む。
2. 権限が無いソースが silent に欠落せず、理由付きで「使えない」と表示される。
3. data tier と観測 tier が混同されないことをドキュメントとテストで固定。

**担当モデル**: sonnet

### DR-05: 意図再構成ステージ + 人間レビュー(P0 / M)

**内容**: 録画とコンパイラの間に、**「1つの意図 + 順序付き steps」を再構成する意味層**を挿入する。現状の `browser-recording-compiler.ts` は 1:1 転写であり、これが「録画を再生するだけで汎化しない」根本原因である。

- **構造化出力の強制**: `delegateStructured<T>`(HN-02 完了済み)で intent / steps を強制。各 step は `id`(安定・フィードバック対象)、`title`、`detail`、`evidence[]`(根拠として使った信号の明示)、`confidence` を持つ。skill-recorder の `AnalysisSubmission` / `Analysis` の分離(モデルが書ける範囲とエンジンが所有するメタデータを型で分ける)をそのまま採る。
- **修復ラダー**: schema 不一致は throw せず、**違反箇所を列挙してモデルに差し戻す**(`electron/describer/tools.ts:404-417`)。加えて「散文だけ返して submit しなかった」場合の nudge ターンを1回だけ入れる。LC-01 の「決定論修復 → LLM 修復」順序原則と接続する。
- **汎化の指示**: 「録画は1例である。特定の3件に対して行われた操作は、**その種別の全件を反復する手順**に汎化せよ。本質(1件ごとにフォームを出す)を残し、偶発(その3件・ウィンドウ位置・タイミング)を捨てよ」(`skillbuilder/instructions.ts:33-41`)。
- **自己ノイズ除去**: 録画開始/停止のための Kyberion 自身への操作、URL のトラッキングパラメータ(`utm_*` 等)差分のみの遷移、サブ秒のフォーカス揺れをステップにしない。
- **過剰剪定の防止**: 意図を根拠にステップを落とすのは、意図が本当にそれを無関係にする場合だけ。**「後続に効くステップ(コピー、参照、ログイン、ツールを開く)は、単体では脇道に見えても on-task」— 脇道を刈れ、前提を刈るな。**
- **人間レビュー**: 再構成結果は**必ず人間が承認**してからコンパイラに渡る。編集結果はモデルに再解釈させず、そのまま下流の正本とする。

**受入条件**:

1. 録画1件から intent + steps が構造化出力として得られ、schema 不一致がモデルへの差し戻しで自己修復される。
2. 「3件に対する操作」の録画から、全件反復を含む手順が生成される回帰シナリオ。
3. 録画開始/停止の自己操作がステップに現れない。
4. 人間が編集した steps が、LLM を再度通さずにコンパイラへ渡る。
5. stub バックエンドでも決定論的なベースライン記述が必ず得られる(skill-recorder の `common/describe.ts` に相当。LC-07〜09 の縮退防止と接続)。

**担当モデル**: opus(プロンプト契約・schema 設計)→ sonnet(実装)

### DR-06: ネイティブ op 優先の置換(P1 / M)— **最大のレバレッジ**

**内容**: 記録された GUI 操作を**再生せず、Kyberion のネイティブ actuator op に置換する**方針を正本化し、蒸留器に強制する。skill-recorder の該当箇所(`scout-catalogue.ts:20-88`)は、優先順位ラダーと「記録された操作 → 優先すべき機能」の対応表という2部構成で、GUI 再生は**最下位の fallback** に置かれている。

Kyberion での実装は skill-recorder より**強くできる**: 向こうは capability カタログを手書き散文で凍結し、SHA-256 でピン止めして drift を防いでいる。Kyberion は `CAPABILITIES_GUIDE.md` を `libs/actuators/*/manifest.json` + `actuator-op-discovery.json` から**既に自動生成**しているため、カタログ自体は生成物として常に正しい。

- **新規に要るのは対応表の層**: 「ブラウザで GitHub の issue を操作している」→ `github` 系 op、「ターミナルで `az` を叩いている」→ 対応 actuator op、「ローカルファイルを開いて読んだ」→ file 系 op、「API も CLI も無い web アプリのフォーム入力」→ **そこで初めて** browser/desktop 再生。この観測 → op のマッピングを `knowledge/product/orchestration/` に置き、op registry(AR-02)に対して検証する。
- **ラダーの正本化**: LC-05 の `llm-invocation-rubric.md` と同じ位置づけで、「決定論 op → 既存 actuator op → CLI → GUI 再生」の降順ラダーを1枚に固定し、working-principles 経由でワーカーに注入する。

**受入条件**:

1. 「ブラウザで GitHub を操作した録画」から、browser 再生ではなく `gh`/github actuator 相当の手順が生成される回帰シナリオ(DR-08 の eval として固定)。
2. 対応表のすべての右辺が `actuator-op-registry.json` に実在する op であることを検証する lint(存在しない op を提案したら CI で落ちる)。
3. **GUI 再生が正解であるケースを誤って禁止しない** — API も CLI も無い対象では browser/desktop 手順が出ることを別シナリオで固定する。

**担当モデル**: opus(ラダー・対応表)→ sonnet(lint・実装)

### DR-07: フレーム redaction と egress ゲート(P0 / M)

**内容**: 画面フレームに写り込んだ秘密が外部へ出るのを防ぐ層を新設する。既存設計 §5 はこれを「注意」としか書いておらず実装が無い。Kyberion は部品を両方とも既に持っているため、**結合が仕事の中身**である:

- `ocr-bridge.ts` の `TesseractOcrProvider` / `AppleVisionOcrProvider` でフレームから**単語と矩形**を抽出(`eng.traineddata` / `jpn.traineddata` はリポジトリ直下に配備済み)。**OCR の役割は「読む」ことではなく「位置を特定する」ことに限定し、OCR テキスト自体は絶対に外へ出さない。**
- 抽出テキストを `pii-scrubber.ts` の rule 群(`PiiSeverity: 'secret' | 'pii'`、`PiiAction: 'block' | 'mask'`、Luhn・マイナンバー検証付き)に通す。
- 検出領域を**不透明な矩形で塗り潰す**。可逆なぼかしにしない。
- 検出は**全て決定論**とし、ML 分類器を検出経路に置かない。

**フレーム専用の構造ヒューリスティック(最も移植価値が高い)**: OCR は高エントロピー文字列(API キー・トークン・JWT)の**文字を正しく読めない**(`0/O`、`1/l/I`、`5/S` を取り違える。skill-recorder は Tesseract の各種前処理と局所 VLM の双方で計測して確認している)。したがって**読んで判定するのではなく、形状で判定する**: 20 文字以上・Shannon エントロピー 3.2 bits/char 以上・英数字比 0.75 以上・数字と英字の両方を含む、を秘密の「形」とみなす。加えて `token=` / `secret:` / `password=` 等の**代入形**を検出する。

この層は**ベンダ接頭辞のブロックリスト(`ghp_`、`AKIA`、`sk_live_` …)を意図的に作らない** — 際限なく増え続け、必ず追随に失敗するため。またこの層は**フレーム経路にのみ適用し、テキスト経路には絶対に適用しない**(テキスト側で過剰マスクすると、モデルが正当に必要とする情報まで壊れる)。

**テキスト→フレームのクロスフィード**: テキスト側で検出済みの値を OCR 結果に対して最優先で literal 検索する。ターミナルやクリップボードで捕まえた値は、OCR が画面上でその文字列を読み損ねていても塗り潰される。

**egress とフェイルセーフ**:

- **egress の一点集約**: 録画中は一切外に出ない。外部推論バックエンドへ渡る瞬間だけを唯一の境界とし、`withReasoningPayloadScope` / `ingest-tier-gate.ts` に接続する。
- **fail-closed**: スキャンが失敗したら**フレームは withhold する**(テキストだけで蒸留を続行させ、その旨をモデルに伝える)。skill-recorder は3状態(保護 off = 生フレーム / 保護 on だが準備未完 = 全 withhold / 準備完 = 塗り潰し)を凍結シングルトンとして表現しており、この形をそのまま採る。
- **本家との相違点(意図的)**: skill-recorder はスキャン例外時に**テキストだけは無防備に送る**(Analyze を止めないため)。**Kyberion はこれを採らない。** tier 越境の禁止は Kyberion の第一不変条件であり、テキストも fail-closed とする。処理継続よりも境界保持を優先する。
- **allow-list を作らない**: 走査対象は「外に出るペイロード全体」とする。出力対象と検出対象を別々に列挙すると、必ず drift して静かに漏れる。
- **生の値をプロセス境界から出さない**: 検出結果のレポートには**マスク済みの値と件数だけ**を載せる。フレーム内テキストは件数のみで、内容は保持しない。マスクは長さを漏らさない形式にする。

**受入条件**:

1. 秘密を含む合成フレームが、外部バックエンドへ渡る前に必ず塗り潰される boundary test。
2. スキャン失敗時にフレーム・テキストの**双方**が withhold され、蒸留が停止するか明示的に縮退することのテスト(silent 継続は不可)。
3. 録画中(蒸留開始前)に外部通信が一切発生しないことのテスト。
4. 構造ヒューリスティックがテキスト経路に適用されていないことのテスト(過剰マスク回帰の防止)。
5. テキストで検出した値が、OCR が読み損ねたフレーム上でも塗り潰される(クロスフィード)ことのテスト。
6. ブラウザ拡張側の手書き redaction(`tools/adf-replay-extension/content.js`)が `pii-scrubber` の rule を共有し、二重実装が解消される。

**担当モデル**: opus(境界設計・ヒューリスティック閾値)→ sonnet(実装)

### DR-08: 蒸留器の eval ハーネス(P1 / M)

**内容**: 蒸留(録画 → 意図再構成 → コンパイル)は確率的な工程であり、現状これを測る仕組みが無い。skill-recorder の eval 設計を採る。要点は**「乱数シードで揺れを均す」のではなく「揺れる層を構造的に取り除く」**ことにある。

- **fixture はデータファイルではなくコード**: シナリオは「タイムスタンプ付きイベント列を返す `build()` + ルーブリック」であり、それを実際の記録ファイルとして materialize してから**本番のパイプラインと本番のエージェントに通す**。
- **合成・映像なし**: 実キャプチャはフレーキーで遅く、かつ測りたい対象ではない。映像を fixture から外し、**分散があるのはモデル工程だけ**という状態を作る。
- **1ハーネス1ステージ**: 意図再構成の eval は入力(イベント列)を凍結し、コンパイラの eval は**上流の出力(承認済みの意図+steps)を凍結**する。こうすると失敗がどちらの責任か一意に決まる。
- **決定論スコアリングを唯一のゲートにする**: LLM judge は opt-in で、**終了コードに影響させない**。順序は同義語グループの部分列一致で見る。ステップ数は範囲(min/max)で見て言い換えの揺れを吸収する。
- **非対称なしきい値**: 意図再構成は総合点(skill-recorder は 0.8)+ **禁止トークン1件で即 fail**。コンパイラ側は全チェック通過を要求(より厳しい)。redaction は recall を hard gate、過剰マスクは soft warning — 「漏れるほうが、塗りすぎより悪い」を閾値の非対称性として表現する。
- **採点範囲を手順部分に限定**: 「なぜ GUI 再生を避けたか」を説明した散文が禁止語に引っかかって減点される事故を防ぐ。禁止語は**実際に手順となる部分(step の見出しと本体)だけ**を見る。
- **既知の限界は `xfail` として登録**: モデル側の既知ギャップを恒久的な赤 CI にせず、かつ暗黙に消さない。想定外に通ったら XPASS として検出する。
- **本番との構造的結合**: eval は本番のプロンプト定義・tool 定義・schema・検出器を**コピーせず import する**。型チェックも本番ソースに対して行う。加えて「eval が本番モジュールを import できること自体」を通常のテストスイートで守る。

**本家の弱点は踏襲しない**: skill-recorder の describer/builder eval は **CI に接続されていない**(対話ログイン済み CLI を要求するため)。Kyberion では IP-03(CI test gates)に接続し、少なくとも**バックエンド非依存で走る決定論部分(redaction・構造検証)は CI 必須**とする。

**受入条件**:

1. `pnpm eval:distill` 相当が合成 fixture 群を採点し、閾値割れで非ゼロ終了する。
2. DR-06 の「GitHub → ネイティブ op」および「API/CLI 無し → GUI 再生が正解」の両シナリオが登録され、両方向の回帰を検出する。
3. eval が本番プロンプト・schema・検出器を import しており、本番側の変更が eval に自動反映される(コピーが存在しない)ことのレビュー確認 + 型チェック。
4. redaction eval の recall gate が hard、過剰マスクが soft として実装され、CI で走る。
5. `xfail` 登録された既知ギャップが XPASS したときに検出される。

**担当モデル**: opus(ルーブリック設計)→ sonnet(実装)

### DR-09: 蒸留成果物に実行可能な選択肢を与える(P2 / M)

**内容**: `DistillCandidateRecord.target_kind` は現在 `pattern | sop_candidate | knowledge_hint | report_template` で、**すべて散文**である。成功したミッションが pipeline を残せない構造的原因がここにある。`procedure`(= `ProcedureEntry` + コンパイル済み pipeline)を `target_kind` に追加し、review フェーズの蒸留レーンから昇格できるようにする。

併せて、`pipeline_promote --trace` が trace id を**provenance として刻むだけで中身を読んでいない**ギャップ(LC-02 の残件)を埋める。`TraceSpan` は `op` と attributes を持っており、これは pipeline step が必要とする情報のほぼすべてである。**trace → 候補 ADF の合成**は、既存資産のうち最も未活用のレバレッジである。

**受入条件**:

1. `target_kind: 'procedure'` の候補が review フェーズで生成され、既存の人手レビュー gate(KM-03)を経て昇格する。
2. 成功 trace 1件から候補 ADF が合成され、preflight 緑で再実行可能。
3. 昇格されない限り実行系に載らない(draft のまま)ことのテスト。

**担当モデル**: opus(trace → step 写像設計)→ sonnet(実装)

## 4. 依存関係と推奨順序

```
DR-01(承認分類)────┬──→ DR-02(executor 結線・注記是正)
                     │
DR-04(観測 tier)────┼──→ DR-03(実演レコーダ)──→ DR-05(意図再構成)──→ DR-06(ネイティブ op 置換)
                     │                                    │                      │
DR-07(redaction)────┘                                    └──────────┬───────────┘
                                                                      ▼
                                                              DR-08(eval ハーネス)
                                                                      │
                                                                      ▼
                                                              DR-09(実行可能な蒸留成果物)
```

- **DR-01 と DR-07 は他のどれよりも先に着手してよい**(単独で価値があり、他をブロックしない)。
- **DR-02 は DR-01 なしに着手してはならない**(承認の無い desktop 実行系の結線は退行)。
- **DR-06 は DR-08 とセットで初めて意味を持つ**。方針をプロンプトに書くだけでは守られない — skill-recorder のシナリオ群は「ビルダーが GitHub 作業にブラウザを選んでしまうバグ」の再発防止として作られたものであり、eval がその方針の唯一の執行機構である。

## 5. 参照

| 文書                                                                                                      | 関係                                                     |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------- |
| [INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN](../../INTENT_DRIVEN_BROWSER_AUTOMATION_DESIGN.ja.md)            | マスター設計(substrate 中立契約・Layer①/④・昇格機構)     |
| [INTENT_DRIVEN_DESKTOP_AUTOMATION_DESIGN](../../INTENT_DRIVEN_DESKTOP_AUTOMATION_DESIGN.ja.md)            | desktop アダプタ設計。DR-02/03 は本書 §6/§7/§8 の実装    |
| [LOOP_CLOSURE_PLAN](./LOOP_CLOSURE_PLAN_2026-07-13.ja.md)                                                 | LC-02(昇格ツール)・LC-05(判断配置)・LC-07〜09(縮退)      |
| [LAYERED_EXECUTION_PLAN](./LAYERED_EXECUTION_PLAN_2026-07-15.ja.md)                                       | 蒸留結果を pipeline=配線 / typed op=ロジックに落とす原則 |
| [OPENHARNESS_ADOPTION_PLAN](./OPENHARNESS_ADOPTION_PLAN_2026-07-18.ja.md)                                 | 同方式の先行事例(概念のみ昇華)                           |
| [kyberion-development-practices](../../../knowledge/product/governance/kyberion-development-practices.md) | 登録儀式・境界テスト allowlist・hermetic テスト          |
