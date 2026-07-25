# CLI サブエージェント・チームモード — 単一 LLM プロバイダ CLI 内で完結するチーム構成と連携(CT-01〜04)

> **作成日**: 2026-07-25
> **優先度**: P1(CT-01/02)/ P2(CT-03/04)
> **位置づけ**: agent-runtime(A2A ブリッジ)によるマルチエージェント基盤の**代替実行面**。KD-05(サブエージェント能力ティア)・MO-04(context pack)・KD-03(イベントソーシング journal)・HN-02(schema 強制委譲)の成果を、CLI ハーネスのサブエージェント機構へ射影する。[TASK_KNOWLEDGE_PROVISIONING_PLAN](./TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md)(KP-01)と配給入口を共有する。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 0. 要旨

Kyberion の「チーム」は、実体としてはランタイムの数ではなく**契約の束**である — 役割定義(team-roles)、能力プロファイル(KD-05)、タスク契約(`PlannedNextTask` + `task_result` 出力契約)、context pack(MO-04)、共有ミッション作業域(per-mission git + `coordination/`)。これらはすべて **CLI 非依存の形で実装済み**。したがって、同一 LLM プロバイダの CLI(Claude Code / Agent SDK)内で完結するチームモードは、新しい連携機構の発明ではなく、**既存契約を CLI ハーネスのサブエージェント機構へ射影する薄いアダプタ**として構築する。

新規に必要なのは2つだけ:

1. **役割 → サブエージェント定義の生成儀式**(SSoT から `.claude/agents/<role>.md` を生成、手書き禁止)
2. **`HarnessSubagentDispatcher`**(既存の `AgentDispatcher` seam に1クラス追加)

```
                 既存契約(CLI 非依存)                        実行面(選択制)
  team-roles/*.json ─┐                                  ┌─ agent-runtime(A2A ブリッジ)
  roles/<r>/PROCEDURE.md ─┤→ タスク契約 + context pack ─┤   … 長時間・書込多・障害分離
  KD-05 capability profile ─┘        │                  └─ CLI サブエージェント(本計画)
                                     │                      … 短命チーム・読取中心・対話内完結
                          共有ミッション作業域(ファイル契約)
                          coordination/ + task_result + claim + journal
```

## 1. 診断(2026-07-25、実コード突合)

### 1.1 切替 seam は既にあるが、CLI ハーネス委譲の実装がない

- `libs/core/agent-dispatch.ts` — `AgentDispatcher` interface。既定 `ProcessSpawnDispatcher`(`:50`、`claude` CLI を都度プロセス spawn)、`KYBERION_IN_SESSION_SUBAGENT=1` で `InSessionDispatcher`(`:72`、A2A ブリッジ在中ルート)。`maybeWrapWithDispatcher`(`:286`)が env 分岐の単一点。**CLI ハーネス自身のサブエージェント機構(Claude Code の Agent tool / Agent SDK の `agents`)へ委譲する dispatcher が存在しない**。
- `claude-agent-reasoning-backend.ts:581-593` — `KYBERION_CLAUDE_AGENT_TOOLS=1` の governed agentic path(Agent SDK + Kyberion MCP + `GOVERNED_AGENT_ALLOWED_TOOLS` + `createKyberionCanUseTool` の tier/approval gate)が実装済み。ただし**単発の delegateTask 用**で、役割別のチーム構成には未接続。

### 1.2 チーム構成の SSoT はあるが、CLI サブエージェント定義に射影されていない

- 役割レジストリ: `knowledge/product/orchestration/team-roles/*.json`(implementer / facilitator / attacker / defender / devils_advocate 等)+ `knowledge/product/roles/<role>/PROCEDURE.md`。
- 能力ティア: `libs/core/subagent-capability-profiles.ts`(KD-05: implementer / explorer / planner の型付き allowlist + system prompt 枠)。
- リポジトリに `.claude/agents/` は存在せず、CLI 側でチームを組む場合は**その場の手書きプロンプトになる** — SSoT からのドリフトを検知する仕組みもない。

### 1.3 連携プリミティブは CLI 非依存で揃っている(未接続なだけ)

- 発注書: `PlannedNextTask`(受入条件・deliverable・依存・scope)。納品書: `task_result` ブロック 1 個の出力契約(`parseTaskResultResponse`)。
- 共有状態: `<mission>/coordination/`(context-packs、KD-03 goal-journal)、work-item claim(排他)、per-mission git(rollback)。
- 相互参照: `buildUpstreamResultLines` — 前タスク結果を次タスクの prompt に載せる hub-and-spoke の流儀が単発 dispatch に実装済み。

## 2. 目標アーキテクチャ

1. **hub-and-spoke 固定**: メイン CLI セッション = mission owner = オーケストレータ(「One owner per mission」不変条件を維持)。サブエージェント同士は直接会話しない。相互参照は upstream results として次タスクの context pack 経由。
2. **契約はランタイム非依存のまま**: 入力 = context pack、出力 = `task_result`、排他 = work-item claim、進行 = KD-03 journal。A2A メッセージをファイル契約に置き換えるのではなく、**もともとファイル契約だったものをそのまま使う**。
3. **ガバナンスは二重化**: (a) サブエージェント定義の tools 許可(KD-05 allowlist の射影)と (b) governed path(MCP + `canUseTool` + tier/approval gate)。secure-io 不変条件(直接 fs 禁止、`pnpm pipeline` / typed CLI 経由)は system prompt と tool 許可の両方で強制。
4. **モデル多様性の代替**: 同一プロバイダゆえ MO-07 の best-of-N は「モデル分散」でなく**視点(lens)分散**の同型サブエージェント並列で構成する。
5. **使い分け基準を文書化**: 短命・読取中心・対話内完結 → CLI チーム / 長時間・書込多・再起動復元・障害分離 → agent-runtime。

## 3. 実装タスク

### CT-01: 役割 → サブエージェント定義の生成儀式

> 優先度 P1 / 規模 M / 依存: KD-05(実装済み)

`scripts/generate_subagent_definitions.ts` を新設し、team-roles JSON + `roles/<role>/PROCEDURE.md` + KD-05 プロファイル + working principles(`buildWorkingPrinciplesLines`)から `.claude/agents/<role>.md`(frontmatter: `name` / `description` / `tools`)を生成する。tools 許可は KD-05 allowlist → CLI ツール名のマッピング表を単一箇所に持つ(explorer=読取専用ツールのみ、planner=ツールなし、implementer=Edit/Write/Bash を割当範囲で)。生成物は手書き編集禁止(ヘッダに生成元と再生成コマンドを明記)。

**受入条件**

1. 代表 3 役割(implementer / explorer 系 / devils_advocate)の定義が SSoT から決定論的に生成される hermetic テスト。
2. `--check` モードが CI に載り、SSoT と生成物のドリフトが検知される(`check:op-registry` と同型の登録儀式)。
3. 生成された system prompt に KD-05 の能力枠文と secure-io 制約(直接 fs 禁止、pipeline/typed CLI 経由)が含まれる。

— claude-sonnet-4

### CT-02: `HarnessSubagentDispatcher` の追加と配線

> 優先度 P1 / 規模 M / 依存: CT-01

`libs/core/agent-dispatch.ts` に `HarnessSubagentDispatcher implements AgentDispatcher` を追加する。実装は governed path(`runClaudeAgentTask` + Kyberion MCP + `canUseTool`)を基盤に、CT-01 の役割定義を `agents` オプション(Agent SDK)として渡す。`maybeWrapWithDispatcher` に `KYBERION_HARNESS_SUBAGENT=1`(仮)の分岐を1本追加 — **呼び出し側(mission-orchestration-worker / background-review 等)は無変更**であること。SDK 不在・ハーネス外実行時は `ProcessSpawnDispatcher` へ fail-open フォールバック(`InSessionDispatcher` と同型)。

**受入条件**

1. dispatcher 差し替えだけで `delegateTask` 呼び出し元が変更されないことを型とテストで固定。
2. 役割指定付き委譲で、CT-01 生成定義の system prompt / tools 許可が実際に適用される hermetic テスト(SDK は fake)。
3. フォールバック経路(SDK 不在)の回帰テスト。
4. 委譲の試行/成功/失敗が KC-02 worker event stream に載る。

— claude-sonnet-4

### CT-03: ファイル契約によるチーム連携の実証(E2E)

> 優先度 P2 / 規模 M / 依存: CT-02

CLI チームモードで「計画 → 並列実装 + レビュー → 統合」の最小チームフローを回す hermetic E2E を作る: メインが `PlannedNextTask` 2件を発注し、implementer 系サブエージェント(fake)が `task_result` を返し、work-item claim で排他が守られ、upstream results が後続タスクの context pack に載り、devils_advocate 系レビューが lens 分散 best-of-N(同型 3 並列・視点別プロンプト)で判定する — までをファイル契約のみで完走させる。A2A ブリッジは起動しない。

**受入条件**

1. E2E が stub/fake バックエンドで決定論的に緑。A2A ブリッジ・外部プロセス依存ゼロ。
2. claim 競合(同一 work-item への二重着手)が構造的に防がれる回帰テスト。
3. lens 分散レビューの多数決集約が MO-07 の判定契約と互換の形式で記録される。

— claude-sonnet-4

### CT-04: 実行面の使い分け基準と文書化

> 優先度 P2 / 規模 S / 依存: CT-02

`docs/GLOSSARY.md` に「CLI サブエージェント・チームモード」を追記し、[agent-mission-control-model](../../knowledge/product/architecture/agent-mission-control-model.md) に実行面の選択基準を追加する: **CLI チーム** = 短命チーム(レビュー班・調査班・judge panel)・読取中心・対話セッション内完結 / **agent-runtime** = 長時間・書込多数・KD-03 復元要件・障害分離(単一プロセスの巻き添えクラッシュ・kill-switch とハーネス permission への依存を明記)。AGENTS.md への追記は**実装が安定してから**(CT-02/03 完了後)行う。

**受入条件**

1. 選択基準が opus/sonnet/haiku で同じ判断に至る決定論ルーブリック形式([AUTONOMOUS_MAINTENANCE_JUDGMENT](../AUTONOMOUS_MAINTENANCE_JUDGMENT.ja.md) と同型)。
2. GLOSSARY のリンク整合(断リンクなし)。

— claude-haiku(文書)/ ルーブリック設計 claude-sonnet-4

## 4. 実施順序

```
CT-01(定義生成儀式)→ CT-02(dispatcher)→ CT-03(E2E 実証)
                                          └→ CT-04(使い分け文書化)
```

KP-01(配給 API 単一化)が先に入る場合、CT-02 は `provisionTaskKnowledge` を配給入口として利用する(役割別 pinned 知識が CLI サブエージェントにも自動で届く)。

## 5. 非目標

- サブエージェント間の直接メッセージング(hub-and-spoke を崩さない。必要になったら A2A ランタイムを使うべき兆候と扱う)。
- 他プロバイダ CLI(codex 等)への同時対応 — dispatcher とマッピング表は分離して設計するが、初版は claude ハーネスのみ。README.ja.md §2.1 のモデル読み替え方針に従い、概念は移植可能に保つ。
- agent-runtime の置き換え。本計画は**代替実行面の追加**であり、長時間ミッションの正本は引き続き A2A ランタイム。
- ハーネス側 permission 機構の再実装(承認・kill-switch はハーネスの機構に委ね、Kyberion 側は governed path の tier/approval gate を重ねるのみ)。

## 6. 関連計画

- [KD-05(サブエージェント能力ティア)](./KIMI_CODE_ADOPTION_PLAN_2026-07-20.ja.md) — 能力宣言の語彙(DONE)。CT-01 はその射影。
- [MO-04](./MO-04_WORKER_CONTEXT_ECONOMY.ja.md) / [KP-01](./TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md) — context pack 配給。CT-02 の入力面。
- [MO-07_QUALITY_MAXIMIZING_DELEGATION](./MO-07_QUALITY_MAXIMIZING_DELEGATION.ja.md) — best-of-N/judge。CT-03 の lens 分散はその単一プロバイダ版。
- [HN-02](./HN-02_SCHEMA_FORCED_DELEGATION.ja.md) — schema 強制委譲。`task_result` 契約の基盤。
- [KD-03(イベントソーシング復元)](./KIMI_CODE_ADOPTION_PLAN_2026-07-20.ja.md) — journal。CLI チームでは参照のみ(復元要件が出たら agent-runtime へ)。
