# surface 会話オーケストレータ — surface が CLI と同格の対話オーケストレータになる(SO-01〜04)

> **作成日**: 2026-07-25
> **優先度**: P1(SO-01〜03)/ P2(SO-04・SO-05)
> **位置づけ**: [SN-01(surface 中立オーケストレーション)](./SURFACE_NEUTRAL_ORCHESTRATION.ja.md)の後続。SN-01 が中立化したのは**ミッション発行まで**であり、本計画は**発行後の所有・操縦**を surface へ開放する。[INTENT_LOOP_CONCEPT](../../INTENT_LOOP_CONCEPT.md) §7「CLI ホストは可換、ループ閉鎖のみ不変」の実装。CT/XP(worker 実行面)とは直交し、「誰がユーザと会話し、ミッションを所有・操縦するか」を扱う。
> **実装状況の正本**: [STATUS.ja.md](./STATUS.ja.md)

## 0. 要旨

LLM プロバイダ CLI(Claude Code 等)で Kyberion を使うとき、CLI セッションが「ユーザと会話し、ミッションを所有・操縦するオーケストレータ」を担う。surface(Slack / Telegram / Discord / iMessage / terminal / web)経由では、**会話の前面は既に surface 中立の共通ループが担っており**(`runSurfaceConversation`: 意図コンパイル→clarification→ルーティング→委譲→要約、UX 契約の単一チョークポイント)、**ミッション発行も SN-01 で中立化済み**。欠けているのは発行後 — surface の会話スレッドがミッションを**所有**し、checkpoint・gate 承認・完了判定まで**操縦**する「オーナー昇格」の経路である。

本計画は新しい会話機構の発明ではない。(a) 既にプログラマティックに存在する lifecycle 動詞(`missionSystem`)を governed facade として libs へ昇格し、(b) 会話スレッド↔ミッション所有の永続バインディング(`OrchestratorSession`)を新設し、(c) surface プロセスへ mission-owner 権限を governed に付与し、(d) 会話ターンからの操縦意図ルートを共通ループへ追加する — の4増分で、surface を CLI と同格のオーケストレータにする。加えて (e) 責務ごとのモデル階梯(会話の前面 = fast/standard、オーケストレータ判断 = deep)を既存の `model_tier` 語彙で宣言し、対称化がコスト増にならないようにする(SO-05)。

```
        会話の前面(実装済み・surface 中立)                ミッション操縦(本計画)
  Slack/TG/Discord/iMessage/terminal/web ──→ runSurfaceConversation
    意図コンパイル → clarification → routing → 委譲 → 要約
                      │
                      ├─ ミッション発行(SN-01 実装済み)      SO-02 OrchestratorSession
                      │                                     会話スレッド ↔ mission 所有
                      └─ 操縦意図(SO-04)──→ SO-01 lifecycle facade ──→ missionSystem(SSoT)
                                               ↑ SO-03 owner 権限(execution context + claim)
                      CLI オーケストレータも同じ facade を使う(対称形)
```

## 1. 診断(2026-07-25、実コード突合)

### 1.1 会話の前面は既に surface 中立(未解決なのは操縦ではなく所有)

- `libs/core/surface-runtime-orchestrator.ts` — `runSurfaceConversation`(`:2140`)/ `runSurfaceMessageConversation`(`:2365`)。全メッセージングブリッジ(satellites/{slack,telegram,discord,imessage}-bridge)・voice-hub・terminal(`kyberion ask`)・concierge・chronos が同一入口を通る。曖昧な意図は `savePendingIntent`(correlationId キー)で永続化して clarification packet を返し、surface agent(`ensureSurfaceAgent` `:1769` → agent-runtime handle の `ask`)が応答を生成、UX 契約は `validateSurfaceUxContract` の単一チョークポイントで強制。
- つまり「surface でユーザと会話する」は解決済み。**未解決なのは、その会話がミッションの所有者として振る舞えないこと。**

### 1.2 推論はホスト CLI 非依存(窓口と推論は分離済み)

- `libs/core/reasoning-bootstrap.ts` — `installReasoningBackends`(`:705`)は `claude-agent` / `claude-cli` / `codex-cli` / `anthropic` / `openrouter` / ローカルランナー等から failover chain を構成する。「誰が推論するか」と「誰がユーザとの窓口か」は既に分離されており、surface オーケストレータのために推論層の新設は不要。

### 1.3 lifecycle 動詞はプログラマティック API が既に在るが、scripts 層に閉じている

- `scripts/refactor/mission-system.ts` — `buildMissionSystem`(`:49`)が start / createCheckpoint / verifyMission / finishMission / staffMissionTeam / prewarmMissionTeam / distillMission / dispatchMissionWorkItems / pauseMission / resumeMission / cancelMission / recordEvidence 等を**既にプログラマティックに公開**している。`scripts/mission_controller.ts` はその CLI router に過ぎない。
- しかし build 依存方向(libs → scripts は不可)により、surface 側(libs/core)から import できない。`issueMissionFromProposal`(`libs/core/surface-mission-proposals.ts:398`)は `dist/scripts/mission_controller.js start` への **shell out** + `withExecutionContext('mission_controller')` の enqueue で「発行」のみを実現しており、**操縦動詞(checkpoint / gate / finish …)への in-process 経路が無い**。

### 1.4 会話 ↔ ミッション所有の永続バインディングが無い

- 発行後のミッションは `startMissionOrchestrationWorker` の async 実行へ渡り、以降のチャット発話がそのミッションを操縦する構造が無い。`pendingIntent` は clarification 専用、mission proposal の確認 stash(`stashMissionProposalForConfirmation`)は発行**前**専用。「この会話スレッドがこのミッションのオーナーである」ことを表す永続オブジェクトが存在しない。

### 1.5 surface はオーナー権限を持てない

- [共同実行契約](../../../knowledge/product/governance/multi-provider-coexecution-contract.md)は「`.git`/repo 設定 = mission owner のみ、worker CLI は不可」。`surface-roles.json` の write scope は scoped / none であり、mission-owner authority + work-item claim を surface プロセスへ governed に付与する経路が未定義。オーナー昇格は**権限モデルの拡張**であり、単なる API 公開では済まない。

### 1.6 モデル階梯の語彙は在るが、surface 会話ループは無宣言(常に既定モデル)

- `ReasoningCallOptions.model_tier`(fast | standard | deep)と `resolveClaudeModelForTier`(fast→haiku / standard→sonnet / deep→opus)は SR-01 / MO-05 で実装済みで、**ミッションの workitem dispatch は `task_model_hint` を委譲へ伝搬している**。しかし `surface-runtime-orchestrator.ts` には `model_tier` の参照が 1 箇所も無く、意図コンパイル・clarification・要約・surface agent の応答はすべて無宣言(= 既定モデル)で走る。
- 会話の前面(定型度が高く、UX 契約で出力形式が拘束される)とオーケストレータ判断(計画確定・gate 承認・完了判定)は要求知能が非対称なのに、現状はどちらも同じモデルを使う。surface をオーケストレータへ昇格させる本計画では、この非対称を**宣言**しないと deep 級モデルが全会話ターンに使われるコスト構造になり得る。

## 2. 目標アーキテクチャ

1. **対称形**: 「オーケストレータ」とはプロセスの種類(CLI / surface)ではなく、**intent loop を閉じる責務 + mission-owner 権限の束**。CLI も surface も同じ lifecycle facade・同じ契約・同じ監査形式で操縦する。
2. **発行者→所有者の昇格は明示的 ceremony**: `OrchestratorSession` の作成 = 所有権バインディング。「One owner per mission」不変条件の写像として、1 mission につき active session は高々1つ。
3. **lifecycle SSoT は一本**: `missionSystem` を核とし、CLI router と surface facade の両方が同一実装を呼ぶ。動詞の意味・状態遷移・監査が呼び出し面で分岐しない。
4. **権限は execution context + claim で強制**(fail-closed)。プロバイダ sandbox は defense-in-depth に留める(共同実行契約と同じ整理)。
5. **完了は検証を通る**: finish は IL-04(completion↔intent 突合)を通過しない限り会話から発火できない。INTENT_LOOP_CONCEPT が「薄い」と自認する⑤検証を、オーナーの義務として構造化する。
6. **知能は責務に階梯づける**: オーケストレータ責務(ミッション計画の確定・gate 承認の判断材料・IL-04 突合・finish 判定)は deep、会話の前面(意図コンパイル・clarification・ルーティング・要約)は fast/standard を既定とし、既存の `model_tier` 語彙で**呼び出し点ごとに宣言**する。tier はモデル選択の意図表明であり、バックエンド系統の選択(env)とは独立(SR-01 の整理を踏襲)。

## 3. 実装タスク

### SO-01: lifecycle 動詞の in-process governed facade

> 優先度 P1 / 規模 M〜L / 依存: なし

`mission-system` の中核を libs 側(`@agent/core` から import 可能な位置)へ移設し、`libs/core/mission-lifecycle-service.ts`(仮)が execution-context 検証付きの動詞サブセット(start / checkpoint / verify / finish / staff / prewarm / dispatch / gate / pause / resume / status)を公開する。`scripts/refactor/mission-system.ts` と `scripts/mission_controller.ts` は同一実装への thin router として**挙動不変**を保つ(移設 + re-export。CLI の argv 契約・出力・状態遷移に変更なし)。

**受入条件**

1. 既存 mission_controller CLI の全テスト緑・出力/遷移不変(挙動不変リファクタであることをテストで固定)。
2. facade 経由の動詞呼び出しは `mission_controller` execution context 外では fail-closed(境界テスト。registration ceremony 準拠)。
3. 動詞ごとの監査記録(actor / surface / verb / mission)が CLI 経由・facade 経由で同一形式。

— claude-sonnet-4

### SO-02: OrchestratorSession(会話スレッド ↔ ミッション所有の永続バインディング)

> 優先度 P1 / 規模 M / 依存: SO-01

`libs/core/orchestrator-session.ts` を新設する: surface / channel / thread(correlationId 系譜 = IL-02)↔ mission_id ↔ owner authority の永続レコード。governed storage(surface-coordination-store 系)に保存し、プロセス再起動後もスレッド発話からセッションを復元する(KD-03 / MO-06 と同型の journal 記録)。1 mission = 高々 1 active session(二重オーナーの構造的防止)。解放は handoff / finish / 明示 release のいずれかで行い、解放後の操縦は拒否される。

**受入条件**

1. 作成 / 復元 / 解放 / 二重オーナー拒否の hermetic テスト。
2. 再起動後の journal replay による復元テスト。
3. `handoffMission` との整合(CLI オーケストレータへ引き継いだら session は released になる回帰テスト)。

— claude-sonnet-4

### SO-03: surface のオーナー権限配線

> 優先度 P1 / 規模 S〜M / 依存: SO-02

surface identity → mission-owner execution context への昇格 ceremony を実装する(`OrchestratorSession` 作成時に work-item claim を取得し、操縦動詞の実行を session 保有 + claim 保有の二重条件にする)。`surface-roles.json` に orchestrator write-scope 語彙を追加し、[共同実行契約](../../../knowledge/product/governance/multi-provider-coexecution-contract.md)へ「surface オーケストレータ」節(cwd = repo root / worktree root、`.git` は owner のみ、worker 委譲へは不付与)を追記する。

**受入条件**

1. session を持たない surface からの操縦動詞が fail-closed(拒否理由が UX 契約形式でユーザへ表面化)。
2. 契約文書・`surface-roles.json`・GLOSSARY の整合(断リンクなし)。
3. worker 委譲経路(KD-05 / XP-02 の権限射影)に owner 権限が漏れない境界テスト。

— claude-sonnet-4

### SO-04: 会話からのミッション操縦 + 完了検証

> 優先度 P2 / 規模 M / 依存: SO-02・SO-03

`runSurfaceConversation` のルーティングに mission-steering 意図(status / checkpoint / gate 承認 / pause / resume / finish)を追加し、`OrchestratorSession` 経由で SO-01 facade を呼ぶ。応答は既存 UX 契約の会話シェイプ(Status / Execution Preview / Delivery)を流用する。finish は IL-04(completion↔intent reconciliation)を通し、未突合なら理由付きで拒否する。gate 承認・finish 等の不可逆操作は既存の human 承認契約(UX-04 / HA-06 の共通 decision API)を必ず経由する。

**受入条件**

1. stub backend での hermetic E2E: 発行 → 操縦(status / checkpoint / gate)→ finish の全会話フローが完走する。
2. IL-04 未突合の finish が理由付きで拒否される回帰テスト。
3. 全操縦応答が `validateSurfaceUxContract` を通過。
4. 不可逆動詞(gate 承認 / finish)が human 承認契約を経由しない経路を持たないことの境界テスト。

— claude-sonnet-4

### SO-05: 責務別モデル階梯の宣言(会話の前面 = fast/standard、オーケストレータ判断 = deep)

> 優先度 P2 / 規模 S〜M / 依存: なし(前半)・SO-04(操縦・検証面)

新機構は作らない。既存の `ReasoningCallOptions.model_tier` + `resolveClaudeModelForTier`(SR-01 / MO-05 実装済み)を、surface 会話ループとオーケストレータ責務の呼び出し点へ宣言として配線する。

- **会話の前面(SO-01〜04 に依存せず先行着手可)**: 意図コンパイル・clarification 質問生成・ルーティング補助・要約(`runSurfaceConversation` 内の推論呼び出しと surface agent の `ask`)へ fast/standard を宣言する。既定は fast とし、曖昧度が高い場合や fast の出力が UX 契約 validation に失敗した場合は standard へ 1 回エスカレーションする(unchanged-retry 禁止の働き方原則に整合: tier 変更が新しい仮説)。
- **オーケストレータ判断(SO-04 完了後)**: ミッション計画の確定・gate 承認の判断材料生成・IL-04 completion↔intent 突合・finish 判定に deep を宣言する。操縦動詞のルーティング自体(意図分類)は前面側の fast/standard のまま。

**受入条件**

1. `runSurfaceConversation` 経路の全推論呼び出しに tier 宣言があることをテストで固定(無宣言の新規呼び出しが検知される registration ceremony 型のガード)。
2. fast → standard エスカレーションの hermetic テスト(1 回限り・UX 契約 validation は最終出力で強制・エスカレーション理由が trace に記録)。
3. オーケストレータ判断(IL-04 突合・finish 判定)が deep 宣言で発行される回帰テスト。
4. tier 宣言が trace / 監査に記録され、OP-01(コスト会計)の集計軸に乗る。

— claude-sonnet-4

## 4. 実施順序

```
SO-01(facade 昇格)→ SO-02(OrchestratorSession)→ SO-03(owner 権限)→ SO-04(会話操縦 + IL-04 検証)
                                                └→ SO-04 の読み取り系(status)は SO-03 と並行着手可
SO-05 前半(会話の前面の tier 宣言)は独立して先行着手可 ── SO-05 後半(操縦・検証面の deep 宣言)は SO-04 の後
```

## 5. 非目標

- **CLI オーケストレータの置き換えではない**(対称化であって移行ではない。CLI 経由の運用・`mission_controller` CLI の契約は不変)。
- 新しい会話チャネル / surface の新設(既存チャネルの共通ループへ操縦ルートを足すだけ)。
- `ReasoningBackend` への multi-turn streaming 会話 API の追加(agent-runtime handle の `ask` + correlationId 系譜で足りる。不足が実証されたら別計画として切る)。
- 「One owner per mission」の緩和(共同所有・多重オーケストレータは扱わない。session の移譲は handoff として明示的に行う)。
- worker 実行面の変更(CT / XP の領分)。

## 6. 関連計画

- [SN-01_SURFACE_NEUTRAL_ORCHESTRATION](./SURFACE_NEUTRAL_ORCHESTRATION.ja.md) — 前段(発行の中立化)。本計画は「発行後の所有・操縦」。
- [IL-01](./IL-01_GOAL_THREADING.ja.md) / [IL-02](./IL-02_CORRELATION_THREAD.ja.md) — session の紐付け基盤。[IL-04](./IL-04_COMPLETION_INTENT_RECONCILIATION.ja.md) — finish 検証の実体。
- [MO-06_DURABLE_RESUME](./MO-06_DURABLE_RESUME.ja.md) / KD-03(イベントソーシング復元) — session 永続化の型。
- [SU-02_LIVE_MISSION_INTERVENTION](./SU-02_LIVE_MISSION_INTERVENTION.ja.md) — UI からの操縦。SO-04(会話からの操縦)と同じ facade を共有する。
- [UX-04](./UX-04_APPROVAL_CONFIRMATION_UNIFICATION.ja.md) / HA-06 — 承認契約。[UX-05](./UX-05_UX_CONTRACT_ENFORCEMENT.ja.md) — UX 契約 enforcement。
- [SR-01](./SR-01_SURFACE_ROLE_REDESIGN.ja.md) / [MO-05](./MO-05_MODEL_EFFORT_ROUTING.ja.md) / [HN-01](./HN-01_MODEL_TIER_LIGHTWEIGHT.ja.md) — `model_tier` 語彙と tier→モデル解決(実装済み)。SO-05 はその宣言配線。[OP-01](./OP-01_COST_ACCOUNTING.ja.md) — tier 宣言の集計先。
- [CT](./CLI_SUBAGENT_TEAM_PLAN_2026-07-25.ja.md) / [XP](./CROSS_PROVIDER_EXECUTION_PLAN_2026-07-25.ja.md) — worker 実行面(直交)。
- [multi-provider-coexecution-contract](../../../knowledge/product/governance/multi-provider-coexecution-contract.md) — 権限整理の根拠文書(SO-03 で追記)。
