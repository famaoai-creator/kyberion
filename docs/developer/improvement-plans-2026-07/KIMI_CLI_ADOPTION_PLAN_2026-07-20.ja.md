---
title: Kimi CLI 概念取り込み計画(KC-01〜10)
kind: improvement-plan
scope: core / agent-dispatch / approval / hooks / testing / pipelines
authority: planning
status: proposed
---

# Kimi CLI 概念取り込み計画(KC-01〜10): 実行時セルフガバナンス・観測契約・委譲ハードニング

> **作成日**: 2026-07-20
> **起点**: [MoonshotAI/kimi-cli](https://github.com/MoonshotAI/kimi-cli)(Python 3.12 製ターミナルエージェント、Apache-2.0、kimi-code へ移行中)の実コード分析(2026-07-20、shallow clone にて実施)。
> **位置づけ**: [OPENHARNESS_ADOPTION_PLAN](./OPENHARNESS_ADOPTION_PLAN_2026-07-18.ja.md)・[HERMES_AGENT_ADOPTION_PLAN](./HERMES_AGENT_ADOPTION_PLAN_2026-07-18.ja.md) と同じ「コードは取り込まず概念だけ既存契約へ昇華する」方式。OH-01(実装済)の追補、SA 系(実行時ガバナンス)、QA 系(エージェント挙動テスト)に具体的な実装参照を与える。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 1. 診断

### 1.1 Kimi CLI とは

Moonshot AI 製の Claude Code 型ターミナルエージェント。設計思想が明確で読み取りやすい:

- **機構と方針の分離** — LLM 抽象 + `step()` プリミティブだけを提供するカーネル `packages/kosong`(「空」)の上に、エージェントループ本体 `KimiSoul`(`src/kimi_cli/soul/kimisoul.py`)が載る。ループはチェックポイント → 自動圧縮判定 → step → ツール実行 → 文脈成長、を明文化された段階として持つ。
- **UI 非依存の観測契約** — `Wire`(`src/kimi_cli/wire/`)という型付きイベントストリーム(SPMC broadcast + jsonl 記録)に soul の全挙動を投影し、TUI / `--print` / Web UI / ACP(Zed・JetBrains)が同一ストリームを購読する。承認要求もこのストリーム上のイベント。e2e テストは Wire を JSON-RPC で駆動してイベント列を assert する。
- **KLIP プロセス** — 設計提案(`klips/`)は「データ構造・プロトコル・モジュール境界への本質的修正」だけを疑似コードで記述し、プロトタイプと提案を同時に育てる(KLIP-0)。

Kyberion は「外部エージェント CLI 群を reasoning backend として束ねるガバナンス層」であり、単一 REPL 製品である kimi-cli とは層が違う。よって TUI・認証・SDK は対象外とし、**ワーカーループの実行時セルフガバナンス**と**観測・テスト契約**に絞って概念を昇華する。

### 1.2 対応表(kimi-cli 実装 → Kyberion 現状 → 判定)

| 機構 | kimi-cli 実装 | Kyberion 現状 | 判定 |
| ---- | ------------- | ------------- | ---- |
| Agent loop / LLM 抽象 | `kosong.step()` + `KimiSoul` | `reasoning-backend.ts` + FailoverReasoningBackend | 既に成熟(方式差のみ) |
| ツール呼び出し反復検知・強制停止 | `soul/toolset.py`: 正規化引数の連続一致 streak を 3/5/8/12 段階でエスカレーション、12 で force-stop | `reasoning-drift-watchdog.ts` は mission-item 粒度(prompt/response 署名)のみ。tool-call 粒度の検知・文脈内エスカレーション無し | **部分 → KC-01** |
| 型付きイベントストリーム + 記録/再生 | `wire/types.py` の Pydantic envelope、SPMC、`wire.jsonl` recorder、Wire 駆動 e2e | `TraceContext`/`persistTrace` + `mission-orchestration-events.ts` は個別存在。統一 envelope・再生・イベント列 assert の e2e 無し | **部分 → KC-02** |
| 承認 facade / runtime 分離 | `soul/approval.py` + `approval_runtime/`: セッション action キャッシュ、source(turn/agent)単位キャンセル、wire 投影 | `approval-gate.ts`/`approval-store.ts` は hash-bound・human-only で堅牢だが、セッション内同種行為キャッシュとソース単位キャンセル無し | **部分 → KC-03** |
| ライフサイクルフック | `hooks/`: 13 イベント × server/client 2 系統、並列 regex マッチ、fail-open + telemetry は fail-open 外 | `claude-code-hook.ts` は Claude Code 依存の 5 イベントのみ。内製ループ(worker/pipeline)のフック語彙無し | **部分 → KC-04** |
| AI 監査テスト | `tests_ai/`: markdown 自然言語不変条件 → subagent fan-out 監査 → `report.json` | boundary/contract テスト + eval スクリプトはあるが、lint で書けない意味的不変条件の監査層無し | **欠落 → KC-05** |
| Subagent registry / 再開可能 store | `LaborMarket`(型別 ToolPolicy)+ `SubagentStore`(agent_id 単位永続・resume 可)+ 要約最短長 retry | `agent-dispatch.ts` + `delegation-preflight.ts`(深度・予算)。subagent 単位の永続 store と要約品質 retry 無し | **部分 → KC-06** |
| Background 完了通知の文脈注入 | claim-based `NotificationManager` → 次 step で LLM 文脈へ配達、圧縮後は active-task snapshot 再注入 | `mission-task-events.ts` はあるが、実行中ワーカーの LLM 文脈への claim-based 配達契約無し | **部分 → KC-06** |
| Checkpoint + 文脈巻き戻し(D-Mail) | `Context.checkpoint()`/`revert_to` + `SendDMail` → `BackToTheFuture` 例外で失敗探索を折り畳み教訓のみ持ち帰る | mission checkpoint は再開用のみ。ワーカー文脈の巻き戻しによる自己修正無し | **欠落 → KC-07** |
| コンテキスト自動圧縮 | `soul/compaction.py`(85% 閾値、preserve-last-N、reactive 圧縮) | **OH-01 実装済**(`worker-context-compaction.ts`: 2 段階 + carryover + reactive + 3 連続失敗停止) | 既に同等 |
| 動的注入 provider | `dynamic_injection.py`: throttle 付き provider + `on_context_compacted` リセット | `working-principles.ts` 注入はあるが provider 契約(throttle・圧縮後リセット)無し | **部分 → KC-08** |
| completion token 動的予算 | `_compute_completion_overrides`: `max_completion = window − 入力見積 − margin` | 無し(固定 max_tokens) | **欠落 → KC-09** |
| Flow スキル(図式ワークフロー) | Mermaid/D2 フローチャートを SKILL.md に埋め、decision ノードは `<choice>` で分岐、Ralph loop 合成 | `pipelines/` + `core:if`/`core:while` + `semantic-decide.ts`(selection mode)で機能同等。著述 UX(図 → 実行)のみ差 | 既に同等 → **KC-10(条件付き)** |
| Skills 階層探索(brand 互換 `.kimi|.claude|.codex|.agents`) | klip-8: project > user > extra > builtin、scope 標示 | `skill_installer.ts` + plugins(Beta) | 既に同等 |
| MCP(background 読込・OAuth) | fastmcp、起動非ブロック読込 | `scripts/mcp_server.ts`(Phase 0) | OH-05 の管轄 |
| ACP | `acp/server.py` + **ACPKaos**(exec/fs だけ OS 抽象層で IDE へリダイレクト) | `acp-mediator.ts`(client 側、Copilot 用) | 不採用表参照(seam 原則のみ学ぶ) |
| KLIP プロセス | 「本質的修正」限定の設計提案 + プロトタイプ同時育成 | improvement-plans + STATUS 運用で同等 | §4 にプロセス上の学びのみ記載 |

### 1.3 最大のギャップ: 実行時セルフガバナンスと観測契約

Kyberion のガバナンスは**実行前**(approval gate・preflight・guardrails・kill-switch)と**実行後**(Trace・review)が厚い一方、**実行中**のワーカーループ自身を守る機構が薄い。kimi-cli はここに安価で実証済みの答えを持つ:

1. **反復検知の段階的エスカレーション**(`toolset.py`)— 同一(ツール, 正規化引数)の連続呼び出しを streak として数え、3 回で穏やかな system-reminder、5 回で詳細警告、8 回で「行き止まり」宣言、12 回で turn 強制停止 + telemetry。LLM 不要・O(1)・誤検知時も文言注入だけで無害。暴走 token 消費の最安の保険。
2. **観測の単一契約**(`wire/`)— 全挙動(step 開始・圧縮・承認要求・subagent イベント・token 使用)を 1 つの型付き envelope に投影すると、(a) UI が差し替え可能になり、(b) jsonl 記録で再生・デバッグでき、(c) **e2e テストが「イベント列の assert」という決定的形式で書ける**。非決定的なエージェントを決定的にテストする最短経路。
3. **文脈巻き戻しによる自己修正**(D-Mail)— 失敗した探索の全 tool 往復を checkpoint まで折り畳み、蒸留した教訓 1 通だけを持ち帰る。圧縮(要約)より強い文脈衛生で、OH-01 と直交する。

## 2. 採用方針

**コードは取り込まない**(Python/asyncio/ContextVar 前提でアーキテクチャ非互換)。概念のみ既存の typed ops / core 契約へ昇華する。

### 不採用(理由付き)

| 機構 | 不採用理由 |
| ---- | ---------- |
| Kosong / kimi-sdk(LLM 抽象カーネル) | `reasoning-backend.ts` + failover が同役割で成熟済み。二重化になる |
| shell TUI(Ctrl-X shell mode)・zsh 統合・Web UI | オペレータ接点は SU-0x / E2E-04 の管轄。Kyberion は REPL 製品ではない |
| OAuth ログイン(klip-14)・auth 層 | CLI ブリッジ(claude/codex CLI)で認証を外部化済み |
| KAOS 全面移植(Local/SSH/ACP の OS 抽象) | FS は `secure-io`、exec は `shell-command-policy` が既存 seam。リモート実行は HA-05(EnvironmentBackend、需要トリガー)の管轄。「ツール層でなく OS 抽象層でリダイレクトする」原則だけ HA-05 設計時に参照 |
| ACP サーバ化(IDE から Kyberion を駆動) | 需要未確定。KC-02 の envelope が出来れば薄い adapter で後付け可能 |
| plan ファイルのヒーロー名 slug 等の演出 | 装飾。価値中立 |
| Lazy subcommand 読込(CLI 起動最適化) | 有効だが微小。CLI 起動が問題化した時に IP 系で扱う |
| `/btw`(deny-all toolset での脇道質問) | surface 側の会話 UX。既存 Direct reply 層で同目的達成 |

## 3. 実装計画

実装割当の既定: パターン確立(初回)= sonnet、機械的展開(2 回目以降)= haiku、設計判断を含む item(KC-02/04/07)の設計レビュー = opus。

### KC-01: ツール呼び出し反復ガバナー(P0 / S)

**内容**: 同一(op/tool 名, 正規化引数)連続呼び出しの streak 検知と段階的エスカレーションを、Kyberion が自前でツールループを持つ経路 — `generateWithTools` 経路(`claude-agent-query.ts` / InSessionDispatcher)と `adf-engine.ts` の step 再試行 — に導入する。引数はキー再帰ソートの canonical JSON で比較(kimi-cli `toolset.py` 方式)。閾値 3/5/8 で system-reminder を注入、12 で強制停止し `needs_attention` + Trace event(`tool_call_repeat`)。既存 `reasoning-drift-watchdog.ts`(mission-item 粒度)の下位粒度として state を統合し、二重管理しない。同一 step 内の完全重複呼び出しは初回結果を共有(dedup)。

**受入条件**:
1. stub backend で同一呼び出しを 12 回発生させる hermetic テストで、3/5/8 の注入文言と 12 での強制停止・Trace 記録を検証。
2. 引数のキー順・空白差だけの呼び出しが同一 streak として数えられる。
3. 強制停止が kill-switch/`recordGovernanceAction` に記録され、mission 側で `needs_attention` として観測できる。

### KC-02: ワーカーイベントストリーム契約(P1 / M)

**内容**: `TraceContext`・`mission-orchestration-events.ts`・operator notification に分散している観測を、単一の型付き envelope(`{type, payload}`、zod 契約)へ投影する `WorkerEventStream` を定義する。kimi-cli `wire/types.py` の語彙(TurnBegin/End, StepBegin, CompactionBegin/End, StatusUpdate(token/context %), SubagentEvent, ApprovalRequest/Response, Notification)を出発点に Kyberion 語彙(mission/phase/gate)を足す。SPMC 購読 + jsonl recorder(mission-local storage へ)。既存 Trace は envelope の 1 購読者として維持(破壊的変更なし)。**e2e テストがイベント列を assert できる**ことを第一の消費者として設計する(kimi-cli `tests_e2e/wire_helpers.py` 方式)。

**受入条件**:
1. 代表 pipeline 実行 1 本と mission dispatch 1 本の全挙動が envelope 列として記録され、jsonl から再生表示できる。
2. e2e テスト 1 本が「prompt 投入 → 期待イベント列」を stub backend で決定的に assert する。
3. 既存 Trace/notification 出力が回帰しない(golden 比較)。

### KC-03: 承認ランタイム強化(P1 / S)

**内容**: `approval-store.ts` に (a) **セッション action キャッシュ** — 承認時に「このセッションでは同種 action を自動承認」を選べる。action は payload hash でなく行為記述子(op + 対象クラス)単位。tier/kill-switch/human-only 契約は不変で、キャッシュは `require_approval` → `approved` の短絡のみ、`deny` は短絡不可 — と (b) **source 単位キャンセル** — 承認要求に `source`(mission/task/agent id)を持たせ、turn/task 終了時に pending をまとめて cancel(kimi-cli `cancel_by_source`)— を追加する。承認要求/決定は KC-02 の envelope へ投影する。

**受入条件**:
1. 同種 action の 2 回目以降が pending を作らず auto-approve され、その事実が audit(`session_cache_written` 相当)に残る。
2. deny 判定・tier 違反はキャッシュを素通りしない。
3. task 中断時に当該 source の pending 承認が全て cancelled になり、放置 pending が残らない。

### KC-04: ライフサイクルフックエンジン一般化(P1 / M)

**内容**: `claude-code-hook.ts`(Claude Code 依存 5 イベント)を、内製ワーカーループ・pipeline 実行にも適用できるフックエンジンへ一般化する。イベント語彙は kimi-cli 13 種(PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, Stop, StopFailure, SessionStart/End, SubagentStart/Stop, PreCompact, PostCompact, Notification)を Kyberion 名へ写像。マッチは regex、複数フックは並列実行し 1 つでも block なら block。**fail-open**(エンジン障害でワーカーを止めない)としつつ、**security block の telemetry 発行だけは fail-open の外**に置く(kimi-cli の carve-out)。server 側 = 設定ファイルのコマンドフック、client 側 = KC-02 envelope 購読者としてのフック。

**受入条件**:
1. PreToolUse フックが特定 op を block でき、block が Trace/telemetry に必ず残る(フックエンジン自体を故障させたテストでも telemetry は残る)。
2. フック実行失敗がワーカーを停止させない。
3. PreCompact/PostCompact が OH-01 圧縮の前後で発火する。

### KC-05: AI 監査テスト層(P1 / S)

**内容**: lint/型では書けない意味的不変条件(例: 「エラーメッセージは復旧手順を含む」「UTF-8 前提の decode をしない」)を markdown 1 ファイル = 1 不変条件(Scope + Requirements + 例)として `tests_ai/` に置き、pipeline(`core:parallel_foreach` + `delegateStructured`)で subagent へ fan-out 監査させ、`report.json`(`{file, cases:[{name, pass}]}`)へ集約・pass/fail 表示する。**dog-food ルール準拠**: 監査自体を mission/pipeline として実装する。stub backend では skip(非 stub backend 必須)とし、CI 常時実行ではなく `pnpm ai-test` 相当の明示実行 + 定期 schedule から始める。

**受入条件**:
1. 不変条件 md 3 本(うち 1 本はわざと違反を仕込んだ fixture 対象)で、違反が fail として報告される。
2. report が Trace 付きで mission-local storage に成果物として残る。
3. 監査 pipeline が `pipelines/` に登録され、schedule 定義を持つ。

### KC-06: 委譲ハードニング(P1 / S)

**内容**: `delegateTask`/agent-dispatch 経路へ kimi-cli subagent 運用の小物 4 点を導入する。
1. **要約最短長 retry** — 委譲結果の最終報告が閾値(200 字相当)未満なら continuation prompt で 1 回だけ追記させる(`SUMMARY_CONTINUATION_PROMPT` 方式)。`delegateStructured` の schema 検証と併用。
2. **subagent 単位の永続 store** — 委譲 1 件ごとに mission-local `subagents/<id>/`(指示・結果・trace 参照)を残し、id 指定で resume/再照会できるようにする(既存 `delegated-task-observability.ts` の trace を保存先として拡張)。
3. **background 完了通知の claim-based 注入** — background task 完了を通知 store に積み、実行中ワーカーの次 step 冒頭で上限付き(4 件)配達して文脈に載せる。
4. **圧縮後 active-task snapshot** — OH-01 圧縮直後に実行中 background task の一覧を再注入する(kimi-cli `build_active_task_snapshot`)。

**受入条件**:
1. 短すぎる委譲報告が 1 回の continuation で補完され、2 回目はそのまま返る(無限 retry しない)。
2. resume が委譲 id から文脈を復元して追加指示を実行できる。
3. 圧縮を挟んでも実行中 task をワーカーが言及できることを hermetic テストで検証。

### KC-07: チェックポイント付き文脈巻き戻し(D-Mail)(P2 / M・実験)

**内容**: 長時間ワーカー(`generateWithTools` 経路)の文脈 JSONL に step 前 checkpoint 記録を入れ、ワーカー自身が呼べる `context:rewind` ツール(引数: checkpoint id + 教訓メッセージ ≤ 上限字数)を提供する。発火時は checkpoint 以降を破棄し、教訓を system メッセージとして 1 通だけ注入して再開(kimi-cli `BackToTheFuture`)。ガード: 1 turn あたり発火 1 回まで、巻き戻しで承認済み効果(実世界への書込み)は取り消せないため **rewind 前に外部効果があった場合は発火拒否**(Trace の効果記録で判定)。発火は KC-02 envelope + Trace(`context.rewind`)へ記録。OH-01 圧縮とは独立に動き、圧縮 carryover は巻き戻しでも保持する。

**受入条件**:
1. 行き止まり探索(fixture)で rewind 後の文脈に失敗 tool 往復が含まれず、教訓メッセージだけが残る。
2. 外部効果(write 系 op 実行済み)がある場合に rewind が拒否される。
3. 発火が Trace に残り、mission 側から巻き戻し回数を観測できる。

### KC-08: 動的注入 provider 契約(P2 / S)

**内容**: `working-principles.ts` 等の prompt 注入を `DynamicInjectionProvider` 契約(`collect(state) → injection | null`、throttle 間隔、`onContextCompacted()` リセット)へ一般化する。KC-01 の反復警告・KC-06 の通知配達も同契約の provider として実装し、注入は独立メッセージとして持ち隣接 user メッセージと正規化統合する(kimi-cli `normalize_history`)。圧縮後に one-shot 注入(原則 brief 等)が再発火する。

**受入条件**:
1. 同一 provider の注入が throttle 間隔内で重複しない。
2. 圧縮後に working-principles 注入が 1 回だけ再発火する。

### KC-09: completion token 動的予算(P3 / S)

**内容**: OH-01 追補。API 直叩き backend(anthropic / openai-compatible)で `max_completion_tokens = context_window − 入力トークン見積 − safety margin` を要求ごとに計算し、固定値で window を踏み越えて即エラーになる事象を予防する(kimi-cli `_compute_completion_overrides`)。CLI ブリッジ backend は対象外(CLI 側が管理)。

**受入条件**: 入力が window 近くまで膨らんだ fixture で、要求 max_tokens が残余に収まり "prompt too long" 前に自然に縮むことを検証。

### KC-10: Mermaid フロー → pipeline compiler(P3 / S・需要トリガー)

**内容**: 機能は既存(`core:if` + `semantic-decide` selection mode + `core:while`)で充足しているため新規ランタイムは作らない。需要が確認できた場合のみ、Mermaid フローチャート(task/decision ノード)を pipeline ADF へ変換する governed compiler(`draft → preflight → commit` 経由)を追加し、「図で書けるワークフロー」の著述 UX だけを取り込む。decision ノードは `semantic-decide` の候補制約付き呼び出しへ落とす。

**受入条件**: サンプル図 1 本が valid な pipeline ADF に変換され、guardrails/preflight を通過して実行できる。

## 4. プロセス上の学び(KLIP)

KLIP-0 の規律「提案はデータ構造・プロトコル・モジュール境界への**本質的修正**だけを疑似コードで書き、行レベル詳細は書かない。プロトタイプと提案を同時に育て、accept 時にはコードがほぼ出来ている」は、本リポジトリの improvement-plans 運用と同型だが、**「本質的修正(変わるデータ構造・契約)」を独立セクションとして必須化**する点は取り込む価値がある。次回の plan テンプレート改訂時に「変わる契約」欄(変更されるスキーマ/インターフェース/イベント語彙の列挙)を追加することを推奨する(独立 item とせず、README.ja.md のテンプレート節へ 1 行追記で足りる)。

## 5. 優先順位まとめ

| ID    | タイトル                                       | 優先度 | 規模 | 依存           |
| ----- | ---------------------------------------------- | ------ | ---- | -------------- |
| KC-01 | ツール呼び出し反復ガバナー                     | **P0** | S    | なし           |
| KC-02 | ワーカーイベントストリーム契約(記録/再生/e2e)  | P1     | M    | なし           |
| KC-03 | 承認ランタイム強化(action キャッシュ・cancel)  | P1     | S    | KC-02 推奨     |
| KC-04 | ライフサイクルフックエンジン一般化             | P1     | M    | KC-02 推奨     |
| KC-05 | AI 監査テスト層(markdown 不変条件 fan-out)     | P1     | S    | なし           |
| KC-06 | 委譲ハードニング(要約 retry・store・通知注入)  | P1     | S    | OH-01 連携     |
| KC-07 | 文脈巻き戻し D-Mail(実験)                      | P2     | M    | KC-02, OH-01   |
| KC-08 | 動的注入 provider 契約                         | P2     | S    | KC-01/06 連携  |
| KC-09 | completion token 動的予算                      | P3     | S    | OH-01 追補     |
| KC-10 | Mermaid フロー compiler(需要トリガー)          | P3     | S    | 需要確定       |
