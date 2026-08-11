# CLI サブエージェント・チームモード — 単一 LLM プロバイダ CLI 内で完結するチーム構成と連携(CT-01〜06)

> **作成日**: 2026-07-25
> **優先度**: P1(CT-01/02/05)/ P2(CT-03/04)
> **位置づけ**: agent-runtime(A2A ブリッジ)によるマルチエージェント基盤の**代替実行面**。KD-05(サブエージェント能力ティア)・MO-04(context pack)・KD-03(イベントソーシング journal)・HN-02(schema 強制委譲)の成果を、CLI ハーネス(Claude Code / Codex app-server 等)のサブエージェント機構へ射影する。[TASK_KNOWLEDGE_PROVISIONING_PLAN](./TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md)(KP-01)と配給入口を共有する。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 0. 要旨

Kyberion の「チーム」は、実体としてはランタイムの数ではなく**契約の束**である — 役割定義(team-roles)、能力プロファイル(KD-05)、タスク契約(`PlannedNextTask` + `task_result` 出力契約)、context pack(MO-04)、共有ミッション作業域(per-mission git + `coordination/`)。これらはすべて **CLI 非依存の形で実装済み**。したがって、同一 LLM プロバイダの CLI(Claude Code / Agent SDK / Codex app-server)内で完結するチームモードは、新しい連携機構の発明ではなく、**既存契約を CLI ハーネスのサブエージェント機構へ射影する薄いアダプタ**として構築する。

Claude 向け初版の最小追加は2つであり、Codex 対応は CT-05 で同じ境界へ接続する:

1. **役割 → サブエージェント定義の生成儀式**(SSoT から `.claude/agents/<role>.md` を生成、手書き禁止)
2. **`HarnessSubagentDispatcher`**(既存の `AgentDispatcher` seam に1クラス追加)

```
                 既存契約(CLI 非依存)                        実行面(選択制)
  team-roles/*.json ─┐                                  ┌─ agent-runtime(A2A ブリッジ)
  roles/<r>/PROCEDURE.md ─┤→ タスク契約 + context pack ─┤   … 長時間・書込多・障害分離
  KD-05 capability profile ─┘        │                  └─ CLI サブエージェント(Claude / Codex)
                                     │                      … 短命チーム・読取中心・対話内完結
                          共有ミッション作業域(ファイル契約)
                          coordination/ + task_result + claim + journal
```

## 1. 診断(2026-07-25、実コード突合)

### 1.1 切替 seam は既にあり、Claude の governed harness 委譲まで実装済み

- `libs/core/agent-dispatch.ts` — `AgentDispatcher` interface。既定 `ProcessSpawnDispatcher` は backend の `delegateTask` に処理を渡すため、provider によっては委譲ごとに CLI/SDK プロセスを増やす。`KYBERION_IN_SESSION_SUBAGENT=1` の `InSessionDispatcher` は A2A ブリッジ経由、`KYBERION_HARNESS_SUBAGENT=1` の `HarnessSubagentDispatcher` は Claude Agent SDK の governed path 経由である。`maybeWrapWithDispatcher` が実行面切替の単一点。
- `claude-agent-reasoning-backend.ts` — `KYBERION_CLAUDE_AGENT_TOOLS=1` の governed agentic path(Agent SDK + Kyberion MCP + `GOVERNED_AGENT_ALLOWED_TOOLS` + `createKyberionCanUseTool` の tier/approval gate)が実装済み。ただし現状の harness 実装は Claude に限定され、Codex の既存 app-server session/thread へは接続されていない。

### 1.2 チーム構成の SSoT はあるが、CLI サブエージェント定義に射影されていない

- 役割レジストリ: `knowledge/product/orchestration/team-roles/*.json`(implementer / facilitator / attacker / defender / devils_advocate 等)+ `knowledge/product/roles/<role>/PROCEDURE.md`。
- 能力ティア: `libs/core/subagent-capability-profiles.ts`(KD-05: implementer / explorer / planner の型付き allowlist + system prompt 枠)。
- リポジトリに `.claude/agents/` は存在せず、CLI 側でチームを組む場合は**その場の手書きプロンプトになる** — SSoT からのドリフトを検知する仕組みもない。

### 1.3 連携プリミティブは CLI 非依存で揃っている(未接続なだけ)

- 発注書: `PlannedNextTask`(受入条件・deliverable・依存・scope)。納品書: `task_result` ブロック 1 個の出力契約(`parseTaskResultResponse`)。
- 共有状態: `<mission>/coordination/`(context-packs、KD-03 goal-journal)、work-item claim(排他)、per-mission git(rollback)。
- 相互参照: `buildUpstreamResultLines` — 前タスク結果を次タスクの prompt に載せる hub-and-spoke の流儀が単発 dispatch に実装済み。

### 1.4 Codex 側の未接続境界

- `CodexAppServerAdapter` は現在 `codex app-server --listen stdio://` を起動し、`thread/start` / `turn/start` を単一の app-server session に送る実装である。これは**app-server 自体を1つ起動すること**と、委譲タスクごとに `codex` CLI を新たに spawn することを区別するための基盤になる。
- 一方、`delegateTask` の実行面選択はまだ Codex の logical thread / native subagent capability を照会せず、既定の `ProcessSpawnDispatcher` に降りうる。Codex が提供する subagent/thread、sandbox、approval、resume の能力を KD-05 / task contract / context pack / KC-02 event stream に結びつける計画がない。
- CT-05 はこの境界を埋める。**Codex の能力が確認できた場合は既存 app-server 内の論理 subagent/thread を使い、委譲ごとの新規 `codex` process spawn を行わない。能力がない場合は自動的に spawn へ降格せず、`unavailable` と理由を trace/operator surface に表面化する。** これにより「サブエージェントを使っている」という虚偽の成功表示を防ぐ。

## 2. 目標アーキテクチャ

1. **hub-and-spoke 固定**: メイン CLI セッション = mission owner = オーケストレータ(「One owner per mission」不変条件を維持)。サブエージェント同士は直接会話しない。相互参照は upstream results として次タスクの context pack 経由。
2. **契約はランタイム非依存のまま**: 入力 = context pack、出力 = `task_result`、排他 = work-item claim、進行 = KD-03 journal。A2A メッセージをファイル契約に置き換えるのではなく、**もともとファイル契約だったものをそのまま使う**。
3. **ガバナンスは二重化**: (a) サブエージェント定義の tools 許可(KD-05 allowlist の射影)と (b) governed path(MCP + `canUseTool` + tier/approval gate)。secure-io 不変条件(直接 fs 禁止、`pnpm pipeline` / typed CLI 経由)は system prompt と tool 許可の両方で強制。
4. **モデル多様性の代替**: 同一プロバイダゆえ MO-07 の best-of-N は「モデル分散」でなく**視点(lens)分散**の同型サブエージェント並列で構成する。
5. **使い分け基準を文書化**: 短命・読取中心・対話内完結 → CLI チーム / 長時間・書込多・再起動復元・障害分離 → agent-runtime。

## 3. 実装タスク

### CT-01: 役割 → サブエージェント定義の生成儀式

> 優先度 P1 / 規模 M / 依存: KD-05(実装済み)

`scripts/generate_subagent_definitions.ts` を新設し、team-roles JSON + `roles/<role>/PROCEDURE.md` + KD-05 プロファイル + working principles(`buildWorkingPrinciplesLines`)から Claude 用 `.claude/agents/<role>.md` と Codex adapter 用の role / sandbox / approval mapping artifact を生成する。tools 許可は KD-05 allowlist → provider ツール名のマッピング表を単一箇所に持つ(explorer=読取専用ツールのみ、planner=ツールなし、implementer=Edit/Write/Bash を割当範囲で)。生成物は手書き編集禁止(ヘッダに生成元と再生成コマンドを明記)。provider 固有の配置や protocol option は生成物の射影先に閉じ込める。

**受入条件**

1. 代表 3 役割(implementer / explorer 系 / devils_advocate)の定義が SSoT から決定論的に生成される hermetic テスト。
2. `--check` モードが CI に載り、SSoT と生成物のドリフトが検知される(`check:op-registry` と同型の登録儀式)。
3. 生成された system prompt に KD-05 の能力枠文と secure-io 制約(直接 fs 禁止、pipeline/typed CLI 経由)が含まれる。

— claude-sonnet-4

### CT-02: provider-neutral `HarnessSubagentDispatcher` の追加と配線

> 優先度 P1 / 規模 M / 依存: CT-01

`libs/core/agent-dispatch.ts` に `HarnessSubagentDispatcher implements AgentDispatcher` を追加する。Claude の governed path(`runClaudeAgentTask` + Kyberion MCP + `canUseTool`)を第一 adapter とし、CT-01 の役割定義を provider-specific な subagent/agent/thread オプションへ射影する。`maybeWrapWithDispatcher` に `KYBERION_HARNESS_SUBAGENT=1`(仮)の分岐を1本追加 — **呼び出し側(mission-orchestration-worker / background-review 等)は無変更**であること。provider adapter が capability を持たない場合の降格・未対応表面化は CT-05 の契約に従う。

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

### CT-05: Codex app-server 内の spawn-less subagent 委譲

> 優先度 P1 / 規模 M〜L / 依存: CT-01・CT-02・XP-01・XP-02

Codex を `ProcessSpawnDispatcher` のまま委譲ごとに起動する経路から、Codex app-server の既存 session 内で論理 subagent/thread を作る経路へ接続する。provider-neutral な `HarnessSubagentDispatcher` の adapter 境界を保ち、Claude と Codex の呼び出し側を分岐させない。Codex の実際の app-server protocol が提供する能力(専用 subagent、child thread、sandbox/approval、resume)は capability probe で確認し、未提供の機能を推測で実装しない。

実装方針:

1. `KYBERION_HARNESS_SUBAGENT=1` の provider resolver が backend の宣言済み capability を見て Claude harness / Codex app-server harness を選ぶ。Codex 専用の opt-in が必要な場合は `KYBERION_CODEX_HARNESS_SUBAGENT=1` を provider adapter の設定として扱う。
2. Codex adapter は既存の app-server process を再利用し、委譲ごとに `codex` child process を spawn しない。logical thread/subagent の識別、親 mission、`DelegationChain`、work-item claim、context pack、`task_result` を同じ契約へ結びつける。
3. CT-01 の role 定義と KD-05 capability profile を Codex の sandbox / approval / tool permission へ射影し、explorer の write deny、planner の no-tool、implementer の許可範囲を adapter 固有の文字列に複製しない。射影表は XP-02 の単一正本を共有する。
4. provider capability が未検出・未認証・protocol 非対応の場合、既定では ProcessSpawn へ黙って降格しない。`subagent_unavailable` と理由を KC-02 event / trace / operator surface に記録し、必要ならオペレータが明示的に legacy spawn fallback を選ぶ。

実装境界: `HarnessSubagentDispatcher` は provider 名や protocol method を直接参照せず、`NativeSubagentAdopter`(adopter id / dispatch / metadata)だけを消費する。Codex の app-server、`thread/fork`、実行時選択可能な `effort`(既定 `medium`)、thread metadata は Codex 側 adopter に閉じ込め、将来の Claude/Gemini 等は同じ契約へ追加する。

**受入条件**

1. fake Codex app-server で、1つの server process に対して複数 logical subagent/thread を委譲でき、委譲回数に比例した `spawn` が発生しないことを検証する。
2. Claude harness と Codex harness が同じ `AgentDispatcher` 呼び出し・task contract・context pack・`task_result`・KC-02 event shape を共有する契約テスト。
3. KD-05 の explorer / planner / implementer が Codex sandbox・approval・tool allowlist へ正しく射影され、未定義の profile/provider 組合せは fail-closed になること。
4. capability 不在時に成功と誤表示せず、`subagent_unavailable` を理由・provider・model・fallback 可否つきで trace/operator surface に出すこと。
5. logical subagent の終了・cancel・timeout が親 app-server process の再 spawn なしに処理され、GE-06 の delegation handle と整合すること。

— Codex adapter 実装 claude-sonnet-4 相当 / protocol 調査 claude-opus 相当 / 契約テスト claude-haiku 相当

### CT-06: Mission WorkItemごとの実行面選択と独立レビュー配線

> **優先度**: P1 / **規模**: M / **依存**: CT-03・CT-04・CT-05・MO-08

missionを作成した後もターミナルのownerが実装を直接続けると、実装とレビューが同じ認知経路に寄り、別途レビュー依頼をしない限り指摘が弱くなりやすい。CT-06では、missionのWorkItemを実行面の単位として扱い、実装と独立レビューそれぞれに `cli_subagent` / `agent_runtime` / `hybrid` を指定または決定できるようにする。

**契約**

- `execution_surface`: `cli_subagent | agent_runtime | hybrid`
- `review_execution_surface`: 実装とは独立したレビュー面。省略時は既存のレビュー経路を維持する。
- `execution_surface_signals`: `expected_duration`、`write_volume`、`recovery_requirement`、`failure_isolation`、`approval_kill_switch`、`model_diversity` の0〜3スコア。
- 最大スコアが0〜1なら `cli_subagent`、2なら `hybrid`、3なら `agent_runtime`。明示指定はルーブリックより優先する。
- `hybrid` はCLI subagentを初期面とし、WorkItemとattemptに将来のruntime昇格条件を残す。
- WorkItemの明示指定 > WorkItemのルーブリック > dispatch既定面 > 既存 `--dispatch-mode agent` の順で解決し、指定がない `auto` / `subagent` はCLI subagentを初期面とする。
- `mission_controller dispatch-workitems` では `--dispatch-execution-surface` / `--dispatch-review-execution-surface` でmission単位の既定面を指定できる。WorkItem metadataが優先される。
- 不正なsurface値は暗黙fallbackせず `EXECUTION_SURFACE_INVALID` として停止する。

**実装タスク**

1. `mission-execution-surface` の純粋resolverと契約テストを追加する。
2. `dispatch-workitems` の実装経路へresolverを接続し、選択面と実際に使用した面をmanifest、WorkItem metadata、dispatch eventへ記録する。
3. `agent_runtime` はA2A/runtime peerとrouteが無い場合にsubagentへ黙って降格せず、`EXECUTION_SURFACE_UNAVAILABLE` としてblockedにする。
4. 独立reviewerも同じresolverを使い、レビュー面を実装面と別に選択できるようにする。選択したreviewer identityとcontext packのsecurity scopeを実際の委譲へ渡し、実装者から除外する。

**受入条件**

1. 短命・読み取り中心のWorkItemは `cli_subagent`、hard thresholdを含むWorkItemは `agent_runtime`、score 2のみのWorkItemは `hybrid` と決定される。
2. 実装とレビューに異なる実行面を指定でき、manifestとレビューartifactから両方を確認できる。`execution_surface_used` は実行成功後だけ記録する。
3. `agent_runtime` のroute不在時に成功扱い・暗黙subagent降格をしない。
4. 既存の `--dispatch-mode agent|subagent` と既存レビュー経路の後方互換性を保つ。

— 実装: Codex / 契約レビュー: 独立 reviewer

## 4. 実施順序

```
CT-01(定義生成儀式)→ CT-02(dispatcher)→ CT-03(E2E 実証)
                                          ├→ CT-04(使い分け文書化)
                                          └→ CT-05(Codex app-server adapter)
CT-03・CT-04・CT-05・MO-08 → CT-06(WorkItem実行面選択 + 独立レビュー配線)
```

KP-01(配給 API 単一化)が先に入る場合、CT-02 は `provisionTaskKnowledge` を配給入口として利用する(役割別 pinned 知識が CLI サブエージェントにも自動で届く)。

## 5. 非目標

- サブエージェント間の直接メッセージング(hub-and-spoke を崩さない。必要になったら A2A ランタイムを使うべき兆候と扱う)。
- Claude 以外の全プロバイダ CLI(agy / gemini / copilot 等)の深い harness 対応 — CT-05 は Codex app-server を第二の実装対象とし、その他の provider は capability probe と明示的な未対応表面化までに留める。README.ja.md §2.1 のモデル読み替え方針に従い、概念は移植可能に保つ。
- agent-runtime の置き換え。本計画は**代替実行面の追加**であり、長時間ミッションの正本は引き続き A2A ランタイム。
- ハーネス側 permission 機構の再実装(承認・kill-switch はハーネスの機構に委ね、Kyberion 側は governed path の tier/approval gate を重ねるのみ)。

## 6. 関連計画

- [KD-05(サブエージェント能力ティア)](./KIMI_CODE_ADOPTION_PLAN_2026-07-20.ja.md) — 能力宣言の語彙(DONE)。CT-01 と CT-05 はその射影。
- [MO-08(成果物レビュー閉鎖)](./MO-08_ARTIFACT_REVIEW_CLOSURE.ja.md) — 独立レビューreceiptと実装者除外の正本。CT-06は実行面選択だけを追加する。
- [MO-04](./MO-04_WORKER_CONTEXT_ECONOMY.ja.md) / [KP-01](./TASK_KNOWLEDGE_PROVISIONING_PLAN_2026-07-25.ja.md) — context pack 配給。CT-02 の入力面。
- [MO-07_QUALITY_MAXIMIZING_DELEGATION](./MO-07_QUALITY_MAXIMIZING_DELEGATION.ja.md) — best-of-N/judge。CT-03 の lens 分散はその単一プロバイダ版。
- [HN-02](./HN-02_SCHEMA_FORCED_DELEGATION.ja.md) — schema 強制委譲。`task_result` 契約の基盤。
- [KD-03(イベントソーシング復元)](./KIMI_CODE_ADOPTION_PLAN_2026-07-20.ja.md) — journal。CLI チームでは参照のみ(復元要件が出たら agent-runtime へ)。
