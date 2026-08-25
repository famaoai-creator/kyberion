---
title: CLAUDE NATIVE SUBAGENT PLAN 2026 08 12
tags: [improvement-plan, 2026-08]
last_updated: 2026-08-25
status: active
---

# Claude ネイティブ・サブエージェント委譲(CN-01〜06)

> **作成日**: 2026-08-12
> **優先度**: P1(CN-01/02/03/04)/ P2(CN-05/06)
> **位置づけ**: [CLI_SUBAGENT_TEAM_PLAN_2026-07-25](../improvement-plans-2026-07/CLI_SUBAGENT_TEAM_PLAN_2026-07-25.ja.md) CT-05 の Claude 側続き。Codex(app-server 共有)・AGY(公式 SDK bridge)・Grok(ACP 共有)で確立した `NativeSubagentAdopter` 契約を、Claude の2つの実行面へ適用する。
> **実装状況の索引**: [2026-08 README](./README.ja.md)

## 0. 要旨

「委譲ごとに provider CLI を spawn せず、provider ネイティブのサブエージェント機構を使う」という CT-05 の要求に対し、Claude 側だけ2つの穴が残っていた。

1. **`claude-cli`(`ShellClaudeCliBackend`)に adopter が無い** — AGENTS.md が推奨する既定 backend でありながら `getNativeSubagentAdopter` を実装しておらず、`KYBERION_HARNESS_SUBAGENT=1` でも `delegateTask` に降格し、委譲ごとに `claude -p` を新規 spawn していた。
2. **`claude-agent`(Agent SDK)の adopter が名ばかり** — `runClaudeAgentTask` は SDK の `agents` を渡さず委譲ツールも許可していないため provider 側サブエージェントは一度も起動せず、それでいて metadata は `mode: 'agent-sdk'` と自己申告していた。CT-05 が明示的に禁じた「native を騙る表示」に該当する。

本計画は両方を、他 provider と同じ **観測ゲート付き fail-closed** の形で埋める。

## 1. provider 能力の実測(2026-08-12、Claude Code CLI 2.1.x)

`--input-format stream-json` の長寿命セッションに対する実測で確認した protocol 事実:

- `--output-format stream-json` は `--verbose` を要求する。
- 最初の user message を送るまで **一切出力が無い**。以後 `system/init` が `session_id` / 登録済み `agents[]` / 親 `tools[]` を報告する。
- 委譲ツールは `--tools` 語彙では `Task`、stream 上の `tool_use` では **`Agent`** として現れる(両方を観測対象にする必要がある)。
- サブエージェント出力は `parent_tool_use_id` = 当該 `tool_use.id` を持つメッセージとして流れる。ただし**これは完了の証拠にはならない**(background 実行でも同じメッセージが流れる)。
- **既定でサブエージェントは background 実行**される。このとき `tool_result` は即時の受領応答(`Async agent launched successfully. … The agent is working in the background.`)で、最初の `result` は親の「起動しました」文。**続く自動継続ターンの `result` も報告の言い換え**(実測: `The background agent completed and replied with PONG.`)であり verbatim ではない。したがって background 委譲からは忠実な報告を取り出せない。
- `run_in_background: false` を指示すると同期実行になり、`tool_result` の第1 text block にサブエージェントの報告本文が入る(第2 block は `agentId` と `<usage>` の内部メタデータで、CLI 自身が「ユーザー向けに引用するな」と明記している)。
- 親セッションには `--agents` で注入した定義に加えて CLI 組み込み(`general-purpose` / `Explore` / `Plan` …)も見えるため、**`subagent_type` の検証は呼び出し側の責務**。
- `--setting-sources ''` で user/project の設定由来 agent 定義が読み込まれなくなり、`--agents` で注入した定義と CLI 組み込みだけが可視になる(決定性 + 未承認 agent 到達不能というガバナンス上の利点)。

SDK 側は `Options.agents?: Record<string, AgentDefinition>` を持ち、メッセージに `parent_tool_use_id` が付く。

## 2. 実装

### CN-01: `ClaudeCliSessionAdapter`(共有 stream-json セッション)

`libs/core/claude-cli-session-adapter.ts`。1本の `claude -p --input-format stream-json --output-format stream-json` プロセスを保持し、NDJSON でターンを往復する。`boot / ask / askNativeSubagent / getRuntimeInfo / shutdown` は `CodexHarnessSession` / `AgyHarnessSession` と同型。

- **観測ゲート(4条件すべて)**: ① `Agent`/`Task` の `tool_use` である、② その `subagent_type` が当該 tier の `kyberion-<tier>` と**完全一致**する、③ 同じ `tool_use.id` を閉じる `tool_result` が来る、④ その `tool_result` が error でも background の launch ack でもない。1つでも欠ければ `nativeSubagent` metadata を出さず `[SUBAGENT_UNAVAILABLE]`。`parent_tool_use_id` 付きメッセージは「活動の痕跡」であって完了の証拠ではないため、単独では採用しない。
- **非統制サブエージェントの遮断**: `subagent_type` が組み込み(`general-purpose` 等)だった場合は fail-closed に加えて `interrupt` + セッション破棄を行う。既に親の permission mode で動き始めているため、ターンを失敗させるだけでは統制外の作業が走り続ける。
- **background は成功にしない**: `run_in_background` が明示的に `false` でない、または launch ack を観測した委譲は、報告を忠実に取り出せないため `[SUBAGENT_UNAVAILABLE]`(次ターンの言い換えを結果として返さない)。
- **返す本文**: 親の最終 `result` ではなくサブエージェント自身の `tool_result` 第1 text block を採用し、CLI 内部の `agentId` / `<usage>` トレーラを落とす。
- **定義未登録の検知**: `system/init` の `agents[]` に `kyberion-<tier>` が居なければ fail-closed。`agents` 欠落・空配列も「登録確認不能」として同様に扱う(fail-open しない)。
- 子プロセス env は `buildProviderChildEnv({provider:'claude'}) + childDelegationEnv()`(XP-02 の allowlist と SA-05 の depth 加算を維持)。
- timeout / abort は `[SUBAGENT_UNAVAILABLE]` で分類し、abort 時は `control_request: interrupt` を送る。

### CN-02: KD-05 → Claude ネイティブ射影と backend 配線

`libs/core/claude-native-subagent.ts` が唯一の射影点:

- `--agents` JSON を **実行時に** KD-05 レジストリから生成(コミット済み生成物ではないのでドリフト不能)。prompt は `systemPromptPrefix` + working principles + secure-io 制約 + 共有ディレクトリ規約。
- 後者2つは `libs/core/subagent-prompt-framing.ts` に SSoT 化し、`scripts/generate_subagent_definitions.ts`(`.claude/agents/*.md` 生成儀式)も同じ定数を参照するよう変更した。`pnpm check:subagent-definitions` はドリフト0のまま。
- 権限は XP-02 の `PROVIDER_PERMISSION_MATRIX` を解析して射影する(独自マトリクスを作らない)。親セッションは `--tools Task` のみ = 自分で作業できない。tier の実ツールはサブエージェント定義側が持ち、**KD-05 ∩ 権限マトリクス allowlist**(least agency)に絞る。planner は `--permission-mode plan` + tools 無し。未知フラグは fail-closed。
- `ShellClaudeCliBackend` に `getNativeSubagentAdopter()`(id `claude-cli`)/ `requiresNativeSubagent()` / `dispatchNativeSubagent()` を追加。委譲は `harnessQueue` で直列化。metadata が無ければ `[SUBAGENT_UNAVAILABLE]`。

### CN-03: 観測結果の表面化

adopter が返す metadata は `provider` / `mode: 'cli-stream-json'` / `threadId`(session_id)/ `turnId`(tool_use id)/ `subagentType` / `effort`。既存の `nativeHarnessEventFields` がそのまま `subagent_end` イベントへ射影するため、Chronos operator surface の native/thread/effort 表示は変更不要で有効になる。

### CN-04: セッション寿命(QM-06 / GE-06)

`resetSession()` で failover 時にセッションを破棄。注入セッションは呼び出し側の所有物なので shutdown しない(Codex review C2 と同じ規約)。`(tier, model, effort)` はセッション構築フラグなので、signature が変わったら旧セッションを落として再起動する — 前の tier の権限で走り続けることを構造的に防ぐ。

### CN-05: `claude-agent`(SDK)を本物のネイティブ委譲に

- `runClaudeAgentTask` に `agents` を渡せるようにし、stream から `Agent`/`Task` の起動・完了・background・error を観測して `nativeSubagent` を返す。完了判定は CLI 側と同じ規則(非 error かつ非 ack の `tool_result` のみ)。
- backend はネイティブモード時のみ `agents` + `Task` 許可 + 委譲プロンプトを使い、**非統制 `subagent_type` / background / tool error / 未完了のいずれでも fail-closed**(理由別メッセージ)。
- `createKyberionCanUseTool({ allowNativeSubagentTools })` を追加。既定では委譲ツールを拒否し、ネイティブモードでも `kyberion-*` 定義以外の `subagent_type`(`general-purpose` 等)は拒否する。KD-05 の外側にあるサブエージェントが起動する穴を塞ぐ。
- metadata の自己申告を廃止: ネイティブ実行は `agent-sdk-subagent`、従来の単発 governed ターンは `agent-sdk-single-turn` と正直に名乗る。

### CN-06: 登録儀式と文書

`KYBERION_CLAUDE_NATIVE_SUBAGENT` を env registry に登録(`pnpm generate:env-registry` 経由、`CONFIGURATION.md` / `env.example` 再生成)。本計画文書と STATUS 追記。

## 3. ロールアウト(既定 OFF)

`ReasoningBackendExecutionAdapter`(work graph 実行面)は env フラグに関係なく adopter があれば無条件に使う。したがって adopter を常時公開すると、既定の work-item 委譲がその場で新経路へ切り替わる。実 provider での連続運用実績が無い段階でそれを行うと、fail-closed 契約がそのまま「今まで通っていた委譲が落ちる」に化けるため、**`KYBERION_CLAUDE_NATIVE_SUBAGENT=1`(または `nativeSubagent: true` オプション、テスト用の harness 注入)でのみ adopter を公開する**。

- OFF(既定): 既存の `claude -p` per-task spawn。挙動は従来と1バイトも変わらない。
- ON: 共有セッション + native サブエージェント。観測できなければ `subagent_unavailable`。

既定 ON への切り替えは、実 provider での連続委譲(2ターン以上・プロセス数不増・thread/turn ID 記録)を確認してからの単独コミットとする。

## 4. 検証

- hermetic: `claude-native-subagent.test.ts`(射影)/ `claude-cli-session-adapter.test.ts`(protocol・観測ゲート4条件・非統制サブエージェント遮断・background fail-closed・error tool_result・未登録/`agents` 欠落・timeout・abort)/ `shell-claude-cli-backend.test.ts`(adopter gating・fail-closed・QM-06・signature 再起動)/ `claude-agent-query.test.ts`(SDK 観測)/ `claude-agent-reasoning-backend.test.ts`(ネイティブ/非ネイティブの正直な metadata)/ `claude-agent-governance.test.ts`(委譲ツール gate)。
- 実 provider(2026-08-12、`model: haiku`、`profile: explorer`、観測ゲート強化後に再実行): 同一 backend から2回委譲し、
  - 双方が `kyberion-explorer` サブエージェントで実行され、報告本文がそのまま返る(`PONG-ONE` / `PONG-TWO`)、
  - `threadId` は2回とも同一(`29d2084d-…` = セッション再利用)、`turnId` は委譲ごとに別(`toolu_01JJ…` / `toolu_018F…`)、
  - セッションプロセス数は委譲1回目・2回目とも 1(per-task spawn ではない)、`resetSession()` 後は 0、
    を確認した。
- 儀式: `pnpm check:subagent-definitions` / `pnpm check:env-registry` / `tsc --noEmit` / child-process boundary allowlist 登録。

## 5. 残作業

1. 既定 ON への切り替え(単独コミット)。判断材料は §3 のとおり work graph 実行面への影響。加えて、モデルが `run_in_background: false` を無視した場合はそのターンが `subagent_unavailable` になる(実測では毎回 foreground を選択)。頻度の運用観測が必要。
2. tier ごとの並列委譲(現状は1セッション1委譲の直列。必要なら tier 別セッションへ拡張)。
3. mission journal への native metadata 記録の運用確認(イベント射影は実装済み、実ミッションでの表示確認は未実施)。
