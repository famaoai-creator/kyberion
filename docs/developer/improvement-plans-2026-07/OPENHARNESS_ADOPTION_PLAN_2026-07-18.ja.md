---
title: OpenHarness 概念取り込み計画(OH-01〜08)
kind: improvement-plan
scope: core / reasoning-backend / secure-io / mcp / channels
authority: planning
status: proposed
---

# OpenHarness 概念取り込み計画(OH-01〜08): コンテキスト経済・ガバナンス硬化・実行前判定

> **作成日**: 2026-07-18
> **起点**: [HKUDS/OpenHarness](https://github.com/HKUDS/OpenHarness)(Python 製エージェントハーネス、src ~46k LOC + ohmo gateway ~4.5k LOC、MIT)の全サブシステム実コード分析(2026-07-18、shallow clone にて実施)。
> **位置づけ**: [BROWSER_ACTUATOR_BROWSER_CLI_CONCEPTS](./BROWSER_ACTUATOR_BROWSER_CLI_CONCEPTS.ja.md) と同じ「コードは取り込まず概念だけ既存契約へ昇華する」方式。MO-04(worker context economy)・SA-03(untrusted input defense)・OP-01(cost accounting)・AC-01(capability truthfulness)の未着手部分に具体的な実装参照を与える。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 1. 診断

### 1.1 OpenHarness とは

Claude Code 型のエージェントハーネスの OSS 再実装(agent loop / 43 tools / skills / plugins / permissions / hooks / MCP / memory / background tasks / swarm / チャット 10 チャネル gateway)。研究向けに小さく検証可能な形で書かれており、**個々の機構の設計判断が読み取りやすい**のが価値。プロダクトとしてではなく「実装パターンのカタログ」として扱う。

### 1.2 対応表(OpenHarness 実装 → Kyberion 現状 → 判定)

| 機構                     | OpenHarness 実装                                                     | Kyberion 現状                                                                                            | 判定                       |
| ------------------------ | -------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | -------------------------- |
| Agent loop / failover    | `engine/query.py`(max_turns、並列 tool 実行)                         | `libs/core/reasoning-backend.ts` FailoverReasoningBackend + `provider-health-registry.ts`                | **既に成熟**               |
| コンテキスト自動圧縮     | `services/compact/`(~1,900 LOC、2 段階圧縮 + carryover attachment)   | `mission-working-memory.ts` はあるが token 窓ベースの auto-compact は無し                                | **欠落 → OH-01**           |
| 機密パス常時 deny        | `permissions/checker.py` `SENSITIVE_PATH_PATTERNS`(上書き不可)       | `tier-guard.ts` / `shell-command-policy.ts` は tier 境界が主で、資格情報パスの無条件 deny 層は無し       | **部分 → OH-02**           |
| API リトライ             | `api/client.py:87-201`(指数 backoff + jitter + Retry-After 尊重)     | failover/demotion で代替(その場リトライ無し)                                                             | **部分 → OH-03**           |
| ツール出力退避           | `engine/query.py:524-553`(上限超過分をファイル退避 + inline preview) | 無し(巨大出力がそのまま文脈に載る)                                                                       | **欠落 → OH-04**           |
| MCP クライアント         | `mcp/client.py`(stdio + streamable HTTP、schema inference、失敗隔離) | `scripts/mcp_server.ts`(Phase 0)+ `claude-agent-query.ts` の passthrough                                 | **部分 → OH-05**           |
| 実行前 dry-run 判定      | `cli.py:333-597`(ready/warning/blocked + next_actions)               | baseline-check(セッション級)と ADF preflight(契約級)はあるが「この実行は通るか」のリクエスト級判定は無し | **部分 → OH-06**           |
| チーム内承認同期         | `swarm/permission_sync.py`(1,168 LOC)                                | `approval-policy.ts` + Slack 承認は単発。委譲先への承認伝播は無し                                        | **部分 → OH-07**           |
| チャネル gateway         | `channels/impl/` 10 種(feishu/dingtalk/matrix/whatsapp 等)           | `satellites/`(slack/telegram/discord/imessage)+ `channel-surface.ts` 抽象                                | **部分 → OH-08(条件付き)** |
| Permission modes / hooks | `permissions/modes.py`、`hooks/`(4 種 × 10 イベント)                 | `policy-engine.ts` + `operation-policy-gate.ts` + `claude-code-hook.ts` + `canUseTool`                   | 既に同等                   |
| Skills / plugins         | `skills/loader.py`(SKILL.md、model 起点の on-demand 読込)            | `plugins/kyberion/SKILL.md` + `skill_installer.ts` + knowledge injection                                 | 既に同等                   |
| Provider profiles        | `config/settings.py` ProviderProfile                                 | `provider-discovery.ts` + capability catalog                                                             | 既に成熟                   |
| Memory                   | `memory/`(frontmatter 付き md + 関連度選択)                          | `promoted-memory.ts` + KM 系(昇格ガバナンス付き)                                                         | 既に成熟                   |
| Mission/task 再開        | session snapshot(`ui/runtime.py`)                                    | `mission_controller.ts` journal replay                                                                   | 既に成熟                   |

### 1.3 最大のギャップ: コンテキスト経済

Kyberion の弱点として MO-04 で計画済みの「worker context economy」に対し、OpenHarness は実装済みの完成形を持つ:

1. **2 段階圧縮** — ① microcompact(LLM 不要: 古い tool_result 本文を直近 5 件だけ残して除去)→ ② LLM 要約(tool_use/result ペアを壊さず分割し、9 セクション構造の `<summary>` を生成)。
2. **carryover attachment** — 全 tool 呼び出し後に `task_focus_state`(goal / active_artifacts / verified_state / next_step)、読了ファイル、起動済み skill、非同期 subagent の状態を上限付きで追跡し、圧縮境界を越えて構造化データとして再注入(`engine/query.py:395-511`)。要約 LLM の品質に依存せず作業状態が生き残る。
3. **反応的圧縮** — provider の "prompt too long" 系エラーを検知して強制圧縮 1 回リトライ(`engine/query.py:66-127`)。
4. **暴走防止** — 圧縮 3 連続失敗で auto-compact 停止。

## 2. 採用方針

**コードは取り込まない**(Python/asyncio 前提でアーキテクチャ非互換)。概念のみ既存の typed ops / core 契約へ昇華する。

### 不採用(理由付き)

| 機構                                                                                                          | 不採用理由                                                                               |
| ------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| Claude Code 資格情報の直接流用(`auth/external.py`: Keychain 読出し + `claude-cli/<ver>` UA 偽装で OAuth 通信) | ToS・偽装リスク。Kyberion は CLI ブリッジ(claude/codex CLI 実行)で同目的を正当に達成済み |
| React/Ink TUI・autopilot web dashboard                                                                        | オペレータ接点は SU-0x / E2E-04 の管轄。別軸で扱う                                       |
| coordinator/(in-memory TeamRegistry)                                                                          | 本家でも swarm/ への後方互換層。mission-team 系で上位互換済み                            |
| cost_tracker(token 集計のみ、金額換算無し)                                                                    | OP-01 の方が要求水準が高い。参照価値無し                                                 |

## 3. 実装計画

### OH-01: ワーカーコンテキスト自動圧縮 + carryover(P0 / M)

**内容**: 長時間ワーカーループ(`claude-agent-query.ts` / `delegateTask()` 経由のサブエージェント、mission orchestration worker)に token 窓ベースの自動圧縮を導入する。OpenHarness `services/compact/` の 2 段階方式(microcompact → LLM 要約)と `tool_metadata` carryover を、`mission-working-memory.ts` を carryover の永続先として実装する。MO-04 の実装参照となる。

- 閾値: `context_window − reserve − buffer`(プロファイル別上書き可)。token 見積りは 4/3 padding の近似で十分(OpenHarness 実証済み)。
- 圧縮前後で Trace event(`compact.before` / `compact.after`)を発行し、要約と carryover を mission-local storage に成果物として残す。
- "prompt too long" 系エラー時の反応的圧縮 1 回リトライ。
- 3 連続失敗で auto-compact を停止し `needs_attention` として surface。

**受入条件**:

1. 閾値超過の長時間ワーカーで自動圧縮が発火し、goal / active_artifacts / verified_state / next_step が圧縮後の文脈に構造化データとして残ることをテストで検証。
2. tool_use/result ペアが圧縮境界で分断されない。
3. 圧縮発生が Trace に記録され、mission checkpoint から要約を参照できる。
4. 3 連続失敗時に停止し運用アラートが出る。

**担当モデル**: opus(設計)+ sonnet(実装)

### OH-02: 資格情報パスの常時 deny 層(P0 / S)

**内容**: `secure-io` / `shell-command-policy.ts` に、tier 判定より前段の**上書き不可**な sensitive-path deny を追加する(`~/.ssh/*`、`~/.aws/credentials`、`~/.kube/config`、`~/.gnupg/*`、`~/.claude/.credentials.json`、`~/.codex/auth.json`、Kyberion 自身の OAuth/token 保存先)。プロンプトインジェクション経由の資格情報持ち出しへの最終防衛線(SA-03 と接続)。読み取り・書き込み・shell 経由(cat 等)の 3 経路すべてに適用。

**受入条件**:

1. 上記パスへの read/write/exec がどの tier・どの承認状態でも拒否される boundary test。
2. 拒否は silent でなく理由付きエラーで返る(AR-06 の原則)。
3. deny パターン一覧が単一定義(registry ceremony 対象)。

**担当モデル**: sonnet

### OH-03: transient エラーの in-place backoff(P1 / S)

**内容**: `reasoning-backend.ts` の failover 前段に、429/5xx/529 系のみ対象の in-place リトライ(最大 3 回、指数 backoff + 25% jitter、`Retry-After` ヘッダ尊重)を追加。auth エラーは現行どおり即 demotion(6h)。現状は transient でも即座に別 provider へ demote するため、一時的な過負荷で failover chain を無駄に消費している。

**受入条件**:

1. 429 応答でリトライ後に成功した場合、provider が demote されないことをテストで検証。
2. auth エラーはリトライせず即 demote(現行動作の非退行)。
3. リトライ発生が usage metering / Trace に記録される。

**担当モデル**: sonnet

### OH-04: ツール出力のアーティファクト退避(P1 / S)

**内容**: サブエージェント実行と ADF step 出力で、inline 上限を超えた tool/step 出力を mission-local storage(mission 外は `active/shared/tmp/`)へ退避し、文脈には truncated preview + artifact パスのみ残す(OpenHarness `engine/query.py:524-553` 方式)。OH-01 と併せてコンテキスト経済の両輪。

**受入条件**:

1. 上限超過出力がファイル退避され、文脈内は preview + パスになるテスト。
2. 退避先が temp 規約(mission-local / `active/shared/tmp/`)に従い、review フェーズの掃除対象になる。
3. 退避ファイルが Trace の artifacts に載る。

**担当モデル**: sonnet

### OH-05: MCP クライアント成熟化(P1 / M)

**内容**: 現在 Phase 0 の MCP 統合を、OpenHarness `mcp/client.py` の設計(streamable HTTP transport、`list_tools()` からの schema inference、server 単位の失敗隔離 = 1 台死んでも起動継続、明示的 reconnect)を参照して成熟させる。外部 MCP server のツールを capability catalog に登録し、AC-01(capability truthfulness)の枠組みで「実際に呼べるもの」だけを公開する。

**受入条件**:

1. stdio に加え streamable HTTP の MCP server に接続できる。
2. 接続失敗した server が他の起動を阻害せず、状態が観測可能。
3. MCP tool が input schema 付きで capability catalog に現れ、governance(`canUseTool`)を通過する。

**担当モデル**: opus(設計)+ sonnet(実装)

### OH-06: リクエスト級 dry-run 判定(P2 / S)

**内容**: baseline-check(セッション級 L0-L5)と ADF preflight(契約級)の間に、「この pipeline / mission 起動は通るか」を実行せず判定する層を追加する。`run_pipeline --dry-run` で contract 解決・provider/auth 可用性・必要 actuator の capability・delegation-preflight を静的に評価し、`ready | warning | blocked` の verdict と重複排除済み `next_actions`(例: 「`setup_oauth.ts` を実行」)を返す(OpenHarness `cli.py:333-597` 方式)。副作用ゼロ(model 呼び出し・tool 実行・MCP 接続をしない)を保証する。

**受入条件**:

1. 既知の pipeline に対し dry-run が副作用なしで verdict + next_actions を返す。
2. auth 欠落・provider demoted・contract invalid の 3 ケースでそれぞれ適切な verdict になるテスト。
3. 出力が JSON でも取得でき、surface(Slack)から提示可能。

**担当モデル**: sonnet

### OH-07: チーム承認伝播(P2 / M)

**内容**: mission 内で operator が一度出した承認(例: 特定ディレクトリへの書込み、特定コマンド)を、同一 mission の委譲先ワーカーへ policy として伝播させる(OpenHarness `swarm/permission_sync.py` の概念)。現状は委譲のたびに独立にゲートされ、承認の再要求が摩擦になる。伝播スコープは mission 境界・TTL 付きとし、`approval-policy.ts` + `claude-agent-governance.ts` の `canUseTool` に mission-scoped grant を追加する。

**受入条件**:

1. mission 内の承認が同 mission の後続ワーカーで再要求されないテスト。
2. 伝播は mission 終了 / TTL で失効し、mission 横断で漏れない(tier 不変条件の非退行)。
3. 伝播された承認の行使が audit chain(SA-01)に記録される。

**担当モデル**: opus(設計)+ sonnet(実装)

### OH-08: チャネル拡張 — Feishu / DingTalk(P2 / L・条件付き)

**内容**: `channel-surface.ts` 抽象の上に satellite を追加するだけで対応可能(OpenHarness `channels/impl/feishu.py` 等が protocol 参照実装)。**中華圏の顧客・利用需要が確認できた時のみ着手**。それまでは backlog に留める。

**受入条件**: 需要確定後に個別計画化(本計画では backlog 登録のみ)。

**担当モデル**: sonnet

## 4. 推奨実施順序

1. **OH-02**(S・防御強化、独立)→ 2. **OH-04**(S・OH-01 の前提整備)→ 3. **OH-01**(P0 本丸)→ 4. **OH-03**(S・独立)→ 5. **OH-05 / OH-06 / OH-07**(需要・摩擦の顕在化順)。

OH-01/OH-04 は MO-04、OH-02 は SA-03、OH-05 は AC-01 の各計画と実装状況を相互参照すること(重複着手禁止)。
