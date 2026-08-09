# cloudflare-os 分析・採択計画(OS-01〜15)

> **作成日**: 2026-08-09
> **分析対象**: [cloudflare/cloudflare-os](https://github.com/cloudflare/cloudflare-os) @ `1cb5e3d9`(2026-08-07、v2 "August 2026 early access"。clone は `active/shared/tmp/cloudflare-os` — 分析済みにつき削除可)
> **実行者**: **codex CLI(GPT 5.6 Luna)** を想定。着手前に §6 実行者ノートを必ず読むこと。
> **位置づけ**: QM / claw-empire 採択計画と同型の「外部システム分析 → kyberion への選択的取り込み」計画。主対象は**ガバナンス制御プレーン**(承認・capability・監査・情報フロー)— SO-04 / KD-05 / KC-03 の後続。
> **前提**: 情報共有・将来的な SaaS 化は**妨げない**(2026-08-09 オペレータ確認 — 機能として有用なら段階採用する。旧「非目標につき非採用」の判断はこの方針で更新済み)。移植しないのは Cloudflare Workers ランタイム基盤(Durable Objects / Facets / Dynamic Workers / Cap'n Web)のみで、非採用の判断基準は**ランタイム置換の費用対効果**に限る。採るのはランタイムに依存しない**制御プレーンの設計文法**と、共有・マルチユーザーへ将来拡張できる **capability グラフの骨格**である。

## 1. cloudflare-os とは何か(要約)

Cloudflare 社内で全職種が使う「会社のための AI 生産性 OS」の v2 完全書き直し。カーネル(`packages/workshop-backend`)がワークスペース DO 上で agent ループとサンドボックスを管理し、**Gadgets**(ユーザーごとのプライベートなミニアプリ。Dynamic Worker facet + `globalOutbound: null` で外部到達ゼロ)、**Gatekeepers**(外部サービスごとの capability ブローカー Worker、16 種同梱)、**Blueprints**(アプリのコードごと共有するテンプレート)、**Code Mode**(ツール群でなく `executeCode` で型付き binding に対して JS を書いて実行する agent)から成る。LLM は pi-agent-core 経由でマルチプロバイダ(SUGGESTED_MODELS に Claude Opus/Sonnet 5、GPT 5.6 Sol/**Luna**/Terra 等)。

最大の発明は **Gatekeeper の非同期 human-in-the-loop**: 副作用アクションを `submitAction()` でキューに積み、ブローカーが**結果を局所シミュレート**(GitHub は provisional ID `~1,~2…` + 読み取り時オーバーレイ、Google Docs はキャッシュ変異方式)して agent を止めずに先へ進ませ、人間は**後でまとめて**承認/却下する。適用は単一チョークポイント `applyPendingAction()`(overseer.ts:2490)のみ、全 read も observation として監査され、共有時は **observer 検証**(閲覧者が元データを直接読めるか毎回再検証)と **lockdown**(`prohibitAllSharing` → 以後の共有・アクション・webFetch を遮断)で情報フローを守る。

### kyberion との構造対比

| 軸               | cloudflare-os                                                                                                                                                    | kyberion                                                                                                                                                                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 副作用の承認     | **submit → シミュレート続行 → 後刻 bulk 承認 → apply/reject/revert**。auto-approve は「作者の autoApprovable × ユーザーのタグ許可」二重ゲート + 順序保証 drainer | `enforceApprovalGate` は `pending` を返し**呼び出し側は中断・放棄**(`procedure-dispatcher.ts:486`)。承認時自動実行は SO-04 steering 動詞のみ。シミュレーションなし(`dryRun` は外部効果ステップを `blocked` にするだけ)               |
| 既定アクセス     | **導入(introduction)ベース**: agent/Gadget は既定ゼロ、ユーザーがリソース単位で紹介。`requestConnection` で agent 側から要求も可                                 | サブエージェントは KD-05 tier で減衰するが、**mission owner / pipeline runner は登録済み全 op へ ambient アクセス**(guardrail + 承認 + egress 政策のみ)。リソース単位 lease は browser-extension のみ(`browser-extension-bridge.ts`) |
| 読み取り監査     | **全 observation を記録**(`authorizeObservation` 必須、内容記述付き、Activity タブで閲覧)                                                                        | アクションは audit-chain + actuator-trace で記録。**外部リソースの read は系統的に監査されない**                                                                                                                                     |
| 共有・情報フロー | observer 再検証(戦略 A〜D)+ `excludeObservers` + lockdown                                                                                                        | tier 不可逆(personal→confidential→public)+ `evaluateAudienceEgress` floor。**成果物単位の出所 taint はない**                                                                                                                         |
| 実行様式         | Code Mode(型付き binding への JS を隔離 isolate で実行、env 遮断)                                                                                                | 宣言的 pipeline + 型付き TS op(LE-04 で JS-in-string を抑制)。既存 `run_js` は `node:vm` + **env 丸渡し**で正反対(`assertUnsafeJsAllowed` ゲート付き)                                                                                |
| テンプレート     | Blueprint = コード + **binding 要求形状**(資格情報なし)+ `.gadget` 交換コンテナ                                                                                  | `automation-blueprint.ts` + `knowledge/product/pipeline-templates/`(instantiate-before-run)。**必要サービスの形状宣言と交換コンテナがない**                                                                                          |
| 知識提供         | Context Library gatekeeper: **有界カタログ {id,title,description} を prompt に inline + agent 主導 read/search**、SKILL.md → slash command、git 同期             | mission dispatch が role-scoped context pack へ**全文取得**(`context-security-scope.ts`)。カタログ + 遅延 read の形はない                                                                                                            |
| 統合テスト       | workerd 上で実プロトコルを喋る harness + **「外部へ何も漏れなかった」afterAll 断言**(network-interceptor)                                                        | hermetic テスト文化はあるが、ネットワーク逸脱ゼロの自動断言はない                                                                                                                                                                    |

**採択の基本判断**: cloudflare-os の資産は (a) **「止めない承認」= submit/simulate/apply の held-action ライフサイクル**、(b) **導入ベースの capability 付与**、(c) **read まで含む全行動監査と出所 taint**、の 3 点で、いずれも Workers 基盤と独立に kyberion の approval-store / actuator / audit-chain 系へ移植できる。加えて 2026-08-09 の方針更新(情報共有・将来 SaaS 化は妨げない)を受け、**共有 capability グラフ(OS-13)→ 生成ミニ surface = Gadget 型(OS-14)** の段階採用経路を引く — 一括移植はしないが、袋小路にならない骨格を先に置く。

## 2. 改善項目一覧

| ID    | タイトル                                                              | 優先度 | 規模 | 対応する既存計画                       |
| ----- | --------------------------------------------------------------------- | ------ | ---- | -------------------------------------- |
| OS-01 | held-action キュー(submit → 後刻承認 → 自動 apply)の一般化            | **P0** | M    | SO-04 / KC-03 後続                     |
| OS-02 | アクション・シミュレーション層(provisional ID + 読み取りオーバーレイ) | **P0** | L    | OS-01 依存                             |
| OS-03 | リソース導入(introduction)モデル — タスク単位 capability 付与         | **P1** | M    | KD-05 / XP-02 後続                     |
| OS-04 | observation 監査 — 外部 read の記録と帰属                             | **P1** | S    | 監査チェーン拡張                       |
| OS-05 | 出所 taint → 共有・egress 検証(observer 検証の kyberion 射影)         | **P1** | M    | OS-04 依存、audience floor 後続        |
| OS-06 | 永続 auto-approve ルール(二重ゲート + 順序保証 drain)                 | **P1** | S    | KC-03 後続、OS-01 依存                 |
| OS-07 | 適用済みアクションの revert(前状態キャプチャ)                         | P2     | M    | OS-01/02 後続                          |
| OS-08 | governed Code Mode op(env 遮断 isolate + 型付き brokered binding)     | P2     | M    | LE-04 / AR-07 後続                     |
| OS-09 | agent catalog 型 knowledge 提供 + 非信頼テキスト有界化                | P2     | S    | TASK_KNOWLEDGE_PROVISIONING 後続       |
| OS-10 | チャネル毎 per-thread capability 分離(satellites)                     | P2     | S    | HA 系後続                              |
| OS-11 | blueprint の binding 要求宣言 + 交換コンテナ                          | P3     | S    | plugin/KD-06 後続                      |
| OS-12 | 統合テストの「ネットワーク逸脱ゼロ」断言                              | P2     | S    | kyberion-development-practices 後続    |
| OS-13 | 共有 capability グラフ(可逆 revocation + default-deny ラッパ)         | P2     | M    | OS-05 依存(ラッパ先行適用は独立着手可) |
| OS-14 | 生成ミニ surface(Gadget 型の段階採用)                                 | P3     | L    | OS-03/08/11/13 依存                    |
| OS-15 | 認証設定の不変面 + OAuth callback 堅牢化                              | P2     | S    | 独立                                   |

---

### OS-01: held-action キューの一般化(P0 / M)

**cloudflare-os の設計**: 全副作用は `ApprovalQueue.submitAction()` で `ActionRecord {state: "pending", caller, description}` として Overseer DO に積まれ、承認は `approveAction → applyPendingAction()`(唯一のチョークポイント)が gatekeeper の `applyAction(n)` を呼ぶ。`resolvedBy` / `autoApproved` / `appliedAt` は**必須引数**で、監査帰属を飛ばせる経路が構造的に存在しない。却下は `rejectAction(n)` でブローカー側状態を掃除。シミュレート不能なアクションは `awaitDecision` を立て、その場合のみ turn を停止し、全承認後に「承認・適用済み。read は反映済み」という合成メッセージで再開する。

**kyberion の現状**: `enforceApprovalGate`(`libs/core/approval-gate.ts`)は `pending` を返すだけで、**通常 op の呼び出し側は run を放棄する**(`procedure-dispatcher.ts:486-517` — `approval_required` で終了し、承認後の再 dispatch が `correlationId` で承認済みレコードを拾う)。承認時に自動実行される held action は SO-04 steering 専用(`ApprovalSteeringAction` → `scheduleSteeringApprovalExecution` → `executeApprovedMissionSteeringApproval`、`drainPendingSteeringApprovalExecutions`)。つまり**器はある**(approval-store のライフサイクル、`payloadHash`+`effectBinding` によるハッシュ束縛、event 投影 `approval_request/response`)が、steering 以外に一般化されていない。

**実装**:

1. `libs/core/approval-store.ts` の `ApprovalSteeringAction` パターンを一般化した `ApprovalHeldAction`(`{op, params, effectBinding, missionId, taskId, submittedBy}`)を導入。`decideApprovalRequest(approved)` 時に held action を実行する generic executor を追加し、steering は最初の移行例としてこの経路に載せ替える。
2. 実行は単一チョークポイント(`applyHeldAction`)経由のみとし、`resolvedBy` / `autoApproved` / `appliedAt` を cloudflare-os 同様**必須引数**にする(省略可能にしない)。適用結果は `ApprovalApplyResult` として record に残し、失敗は `failed` + 再試行可否を記録。
3. 却下時は held action を `cancelled` にし、投入元(mission/task)へ `approval_response` イベントで通知。有効期限切れ(`expired`)も同様。
4. 投入側 API: `submitHeldAction()` を `enforceApprovalGate` の隣に追加し、procedure-dispatcher の `approval_required` 中断経路から「中断せず held に積んで続行」を選べるようにする(選択は op ごとの宣言 — OS-02 のシミュレーション可否と連動)。

**受入条件**: steering が新経路へ退行なく移行する回帰 / held action が承認で一度だけ実行される冪等テスト / 却下・期限切れで実行されないテスト / `resolvedBy` なしの適用がコンパイル・実行時とも不可能なこと / audit-chain に submit→decide→apply の 3 記録が残ること。

### OS-02: アクション・シミュレーション層(P0 / L)

**cloudflare-os の設計**: 承認待ちの間、ブローカーが結果を偽装して agent を先へ進ませる。GitHub gatekeeper(参照実装、`storage-schema.md`)は (a) pending アクション自体を真実の源とし、read 時にリモート状態へ**オーバーレイ**、(b) 未承認 create には **provisional ID `~1,~2…`** を発行し、それを対象とする後続アクション(コメント追記等)も pending のまま連鎖、apply 時に実 ID へ解決、(c) 却下時は依存アクションへ**カスケード却下** + `{restart: true}`(シミュレート済み世界を巻き戻せないため Gadget を再起動)。Google Docs はキャッシュ変異方式(`GoogleDocSimulationCacheHolder`)。シミュレート不能なら `awaitDecision` で同期承認へフォールバック。

**kyberion の現状**: シミュレーションは皆無。`service-procedure-executor.ts` の `dryRun` は read だけ実行し外部効果ステップを `blocked` にする(結果を作らないので後続が進めない)。`pipeline-dry-run.ts` は静的 feasibility 検査。

**実装**:

1. actuator op 契約に任意実装の `simulate(params, ctx): SimulatedResult` を追加(`libs/core/actuator-op-registry.ts` にメタデータ `simulatable: boolean` を登録。boundary-test 登録セレモニー対象)。`SimulatedResult` は provisional ID 台帳(`~N` 形式を踏襲)と「この結果はシミュレーションである」フラグを持ち、actuator-trace に `simulated: true` で記録。
2. 参照実装は 2 つに絞る: **slack 投稿**(`satellites/slack-bridge` 経由の外部投稿。post → provisional ts、thread 返信の連鎖)と **email 送信**(`libs/core/email-bridge.ts`。送信 → provisional message-id)。GitHub 級のオーバーレイ read は初期スコープ外(効果対効き目が薄い)。
3. pipeline / procedure 実行系: 外部効果ステップが `simulatable` なら OS-01 の held に積んで simulated 結果で続行、そうでなければ従来どおり `approval_required` 中断(= `awaitDecision` 相当)。後続ステップの成果物には provisional 参照が残り得るため、**mission finish は未解決 provisional がゼロであることを検査**する(未承認のまま完了させない)。
4. 却下時: provisional に依存する後続 held アクションをカスケード `cancelled` にし、投入元 task を `blocked` に落として通知(Gadget 再起動に相当する安全側の運転)。

**受入条件**: simulate → 承認 → apply で provisional が実 ID に解決されるテスト / 却下カスケードのテスト / 未解決 provisional が残る mission finish が拒否されるテスト / simulated trace が実 trace と区別されて監査に残るテスト / stub backend だけで回る hermetic テスト(実 Slack/SMTP 不要)。

### OS-03: リソース導入(introduction)モデル(P1 / M)

**cloudflare-os の設計**: agent/Gadget は既定でゼロアクセス。ユーザーが URL 貼り付け/ピッカーで**特定リソースを紹介**すると、資格情報とリソース同一性(`{resourceKind, owner, repo, issueNumber}` 等)を props に焼き込んだセッションオブジェクトが渡される。API はリソース単位の object-capability(`GitHubIssue` vs `GitHubRepo`)で、**オブジェクトを持っていないことが権限制限**。agent は `requestConnection` ツールで紹介を要求でき、ユーザーが非同期に許可/拒否。OAuth スコープ自体もユーザーが有効化したリソース種別に絞る。

**kyberion の現状**: 減衰は**委譲チェーン基準**(KD-05: `subagent-capability-profiles.ts`、`delegation-chain.ts` の単調減衰)で、リソース単位ではない。mission owner は登録済み全 op に ambient アクセス。リソース単位の時限 lease は browser-extension だけ(`issueBrowserExtensionLease` — 承認済み録画のアクションハッシュへスコープ)。knowledge 側は `context-security-scope.ts` が purpose/tier 単位の導入に近い形を既に持つ。

**実装**:

1. `libs/core/resource-introduction.ts` を新設: `ResourceIntroduction {id, missionId/taskId, service, resourceRef(正規化 URL/識別子), scope(read|write), grantedBy, expiresAt}`。browser-extension lease の一般化として位置づけ、保存は approval-store と同じ台帳規律(audit-chain 記録付き)。revoke は OS-13 の可逆 revocation 規律に従う(レコードを破壊せず論理切断エッジで表現し、再付与で復元可能にする)。
2. `service-actuator` の `api|preset|mcp` 実行前に「当該 mission/task に対象リソースの introduction が存在するか」を検査する enforcement を追加。**段階導入**: まず warn モード(監査記録のみ)で全 mission を観測し、次に新規 mission から enforce(`egress-policy.ts` の warn/enforce 二段運用と同型)。
3. worker 側 API: `requestResourceIntroduction()`(cloudflare-os の `requestConnection` 相当)を追加し、`notifyOperator('approval_required')` → 承認で introduction が発行される非同期フロー。OS-01 の held と同じ「止めない」動線に載せる。
4. mission dispatch(`agent-dispatch.ts`)で task contract に introduction 一覧を同梱し、KD-05 tier との積集合を実効権限とする。

**受入条件**: introduction なしの service-actuator 呼び出しが warn→enforce の各段で期待どおり扱われる境界テスト / 期限切れ introduction が拒否されるテスト / 委譲時に introduction が親の範囲を超えて増えない(単調減衰)テスト / requestResourceIntroduction → 承認 → 実行の統合テスト。

### OS-04: observation 監査(P1 / S)

**cloudflare-os の設計**: 契約レベルで「全 read は返す前に `authorizeObservation()`」を強制。observation は `state:"approved"`, `type:"observation"` の ActionRecord として、**実際に取得したデータを説明する記述**付きで残り、Activity タブの History で All/Actions/Observations をフィルタ閲覧できる。組み込みツール(webFetch)も sentinel gatekeeper ID `-1` で記録。

**kyberion の現状**: audit-chain と actuator-trace は**アクション**中心。外部サービスからの read(service preset の gmail 取得、network-actuator の fetch 等)は trace には出るが、「誰が・どのリソースを・何の目的で読んだか」を一覧できる observation 台帳がない。OS-05 の taint 判定にはこの帰属が必要。

**実装**: `libs/core/observation-log.ts` を新設し、service-actuator / network-actuator / email-bridge の read 系 op 完了時に `ObservationRecord {service, resourceRef, tier推定, missionId/taskId, purpose(ContextSecurityScope 由来), summary}` を audit-chain 配下に記録。chronos の Activity 相当(既存 deliverable-inbox / approvals UI の隣)に Observations フィルタを追加。webFetch 相当(network-actuator の汎用 fetch)は sentinel サービス ID で記録。

**受入条件**: read 系 op 実行で observation が 1 件記録される単体テスト / mission 単位で observation を列挙できる投影テスト / 記録漏れ検出(read 系 op 一覧と観測実装の突合)を boundary-test 化。

### OS-05: 出所 taint → 共有・egress 検証(P1 / M)

**cloudflare-os の設計**: 共有は「Gadget が過去に読んだ全データを、新しい閲覧者が**自分の権限で直接読めるか**」を gatekeeper ごとの `addObserver(id, verifier)` で検証(open のたびに再検証)。検証戦略は A: private 専用 / B: リソース全体 ACL / C: データセット追跡 / D: 低リスク no-op の 4 型。検証できない observation は `excludeObservers` で前方遮断(保守側 = 遮断に倒す)。最終手段は `prohibitAllSharing` lockdown — 以後の共有・全 `submitAction`・webFetch まで遮断して exfiltration 経路を閉じる。

**kyberion の現状**: tier 不可逆と `evaluateAudienceEgress` floor はあるが、**成果物・work コンテキスト単位の出所 taint がない**。personal tier の知識を読んだ mission の成果物が外部 audience へ出る経路は、人間レビュー(MO-08 / SU-03)頼み。

**実装**:

1. OS-04 の observation 台帳から mission/work-item ごとの **taint 集合**(読んだ最高 tier + テナント集合 + `prohibit_external` フラグ)を投影する `libs/core/provenance-taint.ts` を新設し、control-plane の `projectTaint` も同じ投影器を利用する。
2. `ShareGrantGraph` の resource に provenance mission を束縛し、mutation ごとに observation taint を再解決する。taint 未満の audience floor、対象 tenant 外への共有、non-public provenance の share link は default-deny にする。
3. `evaluateAudienceEgress` / `secureFetch` に observation provenance を渡せる payload context を追加し、`prohibitExternal`・tenant scope・tier floor を既存 egress allowlist と合成する。personal tier を読んだコンテキストは cloudflare-os の lockdown 同様、**外部 egress を既定遮断**にする。
4. Chronos の `/api/os/share-grants` は public 以外の resource に provenance mission を必須化し、server-side control-plane observation 台帳を resolver として利用する。
5. ViewerContext(chronos)にも同じ判定を適用し、閲覧者の tier 許可集合が taint を包含しない成果物は覆い隠す(deny-unless-brokered の成果物版)。Chronos token の `tier_access` は role の canonical 許可集合を超えられず、他の OS surface も未指定時は public/confidential の safe default を使う。

**受入条件**: personal 読取後の外部送信が遮断される統合テスト / taint が観測から決定的に再計算できる(スナップショットでなく再導出)テスト / floor 判定と taint 判定の合成が既存 egress テストを退行させない回帰。

### OS-06: 永続 auto-approve ルール(P1 / S)

**cloudflare-os の設計**: 二重ゲート — gatekeeper 作者がアクション単位で `autoApprovable: true` と判断し、**かつ**ユーザーが `${gatekeeperId}:${tag}` 単位でルールを有効化(`enabledBy` 記録、その人の権限で適用)した場合のみ。`AutoApprovalDrainer` は pending を **id 順に厳密適用し、最初の手動ゲートで停止**(人間ゲートを飛び越えない)、gatekeeper 単位 single-flight で二重適用を防ぐ。

**kyberion の現状**: KC-03 セッション承認キャッシュ(同一アクションクラスをそのプロセスセッション中だけ auto-approve。dual-key / injection 疑いは対象外)止まりで、セッションを跨ぐ永続ルールと順序規律がない。

**実装**: `approval-policy.json` に per-tenant の `auto_approve_rules`(`{op, action_tag, enabled_by, enabled_at}`)を追加し、`resolveApprovalPolicy` で「op 宣言側の `autoApprovable` × ルール有効」の二重ゲートを実装。OS-01 の held キューに drainer を付け、**mission 内 submit 順で適用・最初の手動ゲートで停止・single-flight** を cloudflare-os 仕様のまま踏襲。dual-key / `validateHumanFinalDecision` 対象 op は宣言側で恒久的に `autoApprovable: false`。

**受入条件**: 二重ゲートの真理値表テスト / 手動ゲートを飛び越えないことの順序テスト / 並行 drain で二重適用が起きないテスト / dual-key op がルールでも自動化できない境界テスト。

### OS-07: 適用済みアクションの revert(P2 / M)

**cloudflare-os の設計**: `revertAction()`(任意実装だが推奨)。GitHub は各アクションに `previousTitle` / `previousBodyMarkdown` / `previousLabels` / 作成コメント ID(`GitHubRevertInfo`)を保存し、削除・復元で undo。不可逆なら `{message, canRetry}` の手動ガイダンス Markdown を返す。

**kyberion の現状**: 外部効果の undo 機構なし(mission の atomic rollback は repo 内のみ)。

**実装**: OS-01 の held-action 契約に任意の `revert(applied, ctx)` を追加し、apply 時に前状態スナップショットを record へ保存。参照実装は slack(メッセージ削除)と config/vault 系(前値復元 — `risky-op-registry.ts` の `config:update` / `vault:write` は前値が取りやすく価値が高い)。email 送信のような不可逆 op は `irreversible: true` を宣言し、承認 UI に「取り消し不能」を明示(cloudflare-os の `ActionDescription` の可逆性ヒントに相当)。

**受入条件**: apply → revert で前状態へ戻る往復テスト / 不可逆 op の revert 要求が手動ガイダンスを返すテスト / revert も監査記録されること。

### OS-08: governed Code Mode op(P2 / M)

**cloudflare-os の設計**: agent の主actuator は `executeCode` — 生成 JS モジュールを使い捨て isolate(`globalOutbound: null`、`disallow_importable_env`)で実行し、`env` には**明示的に束縛された型付きセッション stub だけ**が入る。「多数のツール呼び出し」より「型付き API へのコード」の方がトークン効率も精度も高い、という思想。

**kyberion の現状**: 逆方向の穴がある — `run_js`(`libs/actuators/code-actuator/src/code-pipeline-helpers.ts:404` / `system-pipeline-helpers.ts:1460`)は `node:vm` + **`process.env` コピー丸渡し**で、`node:vm` はセキュリティ境界ですらない(`assertUnsafeJsAllowed` ゲートのみ)。一方で LAYERED_EXECUTION / LE-04 の「JS-in-string を典型 op へ」方針は正しく、Code Mode を全面採用する理由はない。

**実装**(全面採用ではなく **`run_js` の後継 + 判断駆動の複合 API 操作専用**):

1. `code:execute_governed` op を新設: 子プロセス isolate(env 空、ネットワーク遮断)で実行し、ホストとは RPC チャネルのみで通信。チャネル越しに渡すのは OS-03 の introduction 済みリソースに対応する**型付き brokered セッション**(呼び出しは全て approval-gate / observation 監査 / held キューを通過)のみ。
2. 既存 `run_js` は deprecation: 新規 pipeline での使用を adf-guardrails で警告し、既存利用箇所を棚卸して `core:transform` 典型 op か `code:execute_governed` へ移行。
3. `wisdom:*` / reasoning backend が生成するコードの実行先をこの op に一本化(「生成コードが素の env を見る」経路を根絶)。

**受入条件**: isolate 内から `process.env` / 生ネットワークに到達できない escape テスト / brokered 呼び出しが監査・承認を通ることの統合テスト / `run_js` 新規使用が lint で警告される回帰。

### OS-09: agent catalog 型 knowledge 提供 + 非信頼テキスト有界化(P2 / S)

**cloudflare-os の設計**: Context Library は埋め込み RAG でなく、**有界カタログ**(`{id,title,description}` の JSON を system prompt に inline。gatekeeper 出力は非信頼として `AGENT_CATALOG_MAX_*` でサイズ上限 + 制御文字サニタイズ)+ agent 主導の `read(id)` / `search(query)`(線形走査、fanout 8 上限)。`SKILL.md` frontmatter 文書は slash command 化。外部由来テキストは常にフェンス(webFetch は「injection の可能性あり」と明示、compaction 要約は `<prior_conversation>` で区切り剥がし)。

**kyberion の現状**: mission dispatch は role-scoped context pack へ**全文**を取り込む(`context-security-scope.ts`)。knowledge が育つほど pack が肥大する構造。外部由来テキストのプロンプト混入に対する共通の有界化・サニタイズユーティリティがない。

**実装**: (1) `CompiledContextPack` に「カタログ + 遅延 read」モード追加 — 大きい fragment は `{id,title,description}` で載せ、worker は `knowledge:read` op で必要時に取得(observation 監査対象)。役割ごとの inline/カタログ閾値は語彙カタログで管理。(2) `libs/core/untrusted-text.ts` を新設(サイズ上限 + 制御文字除去 + フェンス付与)し、外部由来テキストをプロンプトへ載せる全経路(network fetch 結果、satellites 受信文、MCP 応答)をこれに通す。

**受入条件**: カタログモードで pack サイズが縮む計測テスト / 遅延 read が観測記録されるテスト / 有界化ユーティリティの property テスト(上限・制御文字・フェンス)と主要経路の適用確認 boundary-test。

### OS-10: チャネル毎 per-thread capability 分離(P2 / S)

**cloudflare-os の設計**: AgentSpawnerConfig の指針 — 受信メール 1 通ごとに agent を 1 つ spawn し、**その 1 通にだけ返信できる reply-stub** をスコープする。「メールスレッド間の prompt injection・情報漏洩を防ぐ」ための per-thread capability 分離。

**kyberion の現状**: satellites(slack / telegram / discord / imessage)は bridge プロセスが会話を捌く。受信文は非信頼だが、enqueue された仕事が持つ返信能力のスレッド単位スコープは明示されていない。

**実装**: satellites の enqueue 時に **reply capability をスレッド/メッセージ ID に束縛**した introduction(OS-03)として発行し、worker はその introduction 経由でのみ返信可能にする(別スレッド・別チャネルへの送信は held + 承認)。受信本文は OS-09 の有界化を通す。

**受入条件**: スレッド A 起点の仕事がスレッド B へ返信できない境界テスト / 束縛外送信が承認要求に落ちるテスト。

### OS-11: blueprint の binding 要求宣言 + 交換コンテナ(P3 / S)

**cloudflare-os の設計**: Blueprint はコードに加え **binding 要求の形状**(どの gatekeeper vendor / URL パターン / AI モデルが必要か。資格情報は含まない)を宣言し、インスタンス化時にユーザーが wiring する。`.gadget` バイナリコンテナ(magic + JSON メタ + 内容、サイズ上限)で instance 間を移動できる。

**kyberion の現状**: `automation-blueprint.ts` + `pipeline-templates/`(instantiate-before-run)は既に近い。欠けているのは (a) テンプレートが**必要とするサービス/資格情報の形状宣言**(現状は実行時に落ちて分かる)と (b) テナント間・instance 間の交換フォーマット。

**実装**: (1) pipeline-template frontmatter に `required_bindings`(service / preset / secret 名の形状。値は含まない)を追加し、instantiate 時に検証 + 不足分を OS-03 の introduction 要求へ変換。交換は既存 plugin 管理コピー機構(KD-06 `installPluginManaged`)にテンプレート同梱を許す拡張で足りる(独自バイナリ形式は作らない)。(2) **fingerprint 付き seed 更新**(フォーマット blueprint からの回収断片): 出荷テンプレは fingerprint 管理で lazy install し、更新時は再インストールするが **operator/テナントが後から行った削除・上書きは決して巻き戻さない**。(3) **語彙マッピング**: カタログの prompt 投影に「ユーザーはテンプレート名でなく成果物名(『提案書』『週報』)で頼む」前提の対応表を同梱し、要求語彙 → blueprint 解決を安定させる(cloudflare-os `describeStandardFormats()` 相当)。

**受入条件**: required_bindings 不足時に instantiate が実行前に失敗し不足一覧を出すテスト / 形状宣言に秘密値が書けない schema テスト / seed 更新が operator カスタム(削除・上書き)を保存する更新往復テスト。

### OS-12: 統合テストの「ネットワーク逸脱ゼロ」断言(P2 / S)

**cloudflare-os の設計**: 統合テストは実 Worker 群を workerd で起動し実プロトコルで喋るが、outbound HTTP だけ `network-interceptor.ts` で横取りし、**afterAll で「インターネットへ何も逃げなかった」を断言**する。

**kyberion の現状**: hermetic テストは実践(kyberion-development-practices)だが、逸脱の自動検出はない — mock を忘れた 1 本が CI から実サービスを叩いても気づけない。

**実装**: vitest セットアップに outbound 監視(`globalThis.fetch` と `node:http` / `node:https` を許可リスト外で fail させる)を追加し、Axios を含む integration 系スイートの共通 harness に組み込む。許可リストは localhost の全ポート + `KYBERION_VITEST_NETWORK_ALLOWLIST` による host:port の明示 opt-in のみ。外部 URL は接続前に fail し、`Request` の HTTP メソッドも記録し、afterAll で未処理の逸脱記録を断言する。

**受入条件**: mock 漏れの fetch / Axios / `node:http` が接続前にテストを fail させる自己テスト / 既存スイートが green のまま通る回帰。

**レビュー修正後の補足**: 共通 guard は `globalThis.fetch` に加えて `node:http` / `node:https` を接続前に監視するため、Axios などの HTTP クライアントも対象とする。localhost は全ポートを許可し、外部の `KYBERION_VITEST_NETWORK_ALLOWLIST` は host:port の明示指定だけを受け付ける。`Request` 入力のメソッド記録と guard 自身の Axios / `node:http` / allowlist 回帰テストも追加した。

### OS-13: 共有 capability グラフ — 可逆 revocation + default-deny ラッパ(P2 / M)

**cloudflare-os の設計**(`docs/sharing.md`): 権限は所有者を根とする**有向グラフ**(ユーザーエッジ + share link エッジ)で、実効ロール(`build` > `use`)は open のたびに到達可能性の不動点として再計算される。取り消しは**エッジ切断のみ**で cascade-delete しない — 仲介者を再追加すると配下の権限がまるごと復元される(lazy で可逆)。削除前に影響プレビュー + `keepUsers` による再ルート。share key は 128-bit 乱数で **HMAC-SHA-256 ハッシュのみ保存**、revocation 時は storage 同期後にライブセッションを退去させる。制限ロールには `UseOverseerInterface implements Overseer` の **default-deny ラッパ** — 正 API にメソッドを追加すると、制限ロール側の扱いを意識的に決めるまで**コンパイルが通らない**。

**kyberion の現状**: 閲覧は ViewerContext + tenant registry(単一 operator 前提)で、principal 間で成果物・ビューを共有する骨格がない。tier ゲート付き API は手動規律で、エンドポイント追加時のゲート付け忘れを型で検出する仕組みもない。情報共有を妨げない方針(§前提)に対する唯一の構造的欠落。

**実装**:

1. `libs/core/share-grant-graph.ts` を新設: `ShareEdge {resourceRef(成果物 / mission ビュー / surface), grantee(principal または share-link), role(view|operate), grantedBy, revokedAt?}`。実効権限は owner からの到達可能性で毎回導出(スナップショット保存しない)。取り消しはエッジの論理切断のみとし、再付与で配下が復元される可逆性を保証。mutation は authenticated actor と trusted authorizer の検証を必須化し、resource に `tenantSlug` を束縛する。台帳は HMAC hash-chain + secure-io 永続化 + audit-chain 記録で保護する。
2. `libs/core/share-grant-authorizer.ts` に server-side viewer context adapter と tenant registry authorizer を追加する。principal が明示された token/loopback viewer だけを actor に変換し、viewer の tenant scope と registry の `active` 状態を全 mutation で検証する。`all` scope も未登録・suspended・archived tenant の bypass には使えない。principal grant は対象 tenant を明示し、cross-tenant は明示的な broker authorizer がない限り拒否する。
3. share link は 128-bit key を発行し、保存は HMAC ハッシュのみ(vault / secure-io 規律)。TTL 付き。平文 token は応答時だけ返し、台帳には保存しない。
4. Chronos の `/api/os/share-grants` POST route で localadmin + server-resolved ViewerContext を graph mutation に接続する。client が送る tenant は narrowing input に限定し、registry authorizer が再検証する。
5. **default-deny ラッパの先行適用**(OS-13 の即効部分、独立着手可): chronos の役割別 API 投影を「フル API interface を implements する制限クラス」へ書き換え、新エンドポイント追加時に制限ロールの扱いをコンパイル時に強制する。マルチユーザー化を待たず、現行 tier ゲートの付け忘れ事故を型で塞ぐ。
6. OS-05 との合成: grant は taint / audience floor を**広げられない**(共有は許可集合の交差のみ)。taint を超える grant は発行時に拒否。
7. `ShareGrantLiveSessionRegistry` を共有グラフの退去契約へ接続する。`openShareLinkSession` が token を現時点で検証してから登録し、`link_revoked` の ledger append + fsync 完了後に、同一 `linkId` と `resourceRef` の active session だけを退去させる。registry は失効 scope の再登録を拒否し、ledger replay 時にも eviction を再実行する。退去 backend 障害時もリンク失効は維持し、失効済みリンクへの再 revoke で退去を再試行する。

**受入条件**: 仲介者エッジ切断で配下が権限を失い、再追加で復元される到達可能性テスト / share key の平文が一切保存されない検査 / viewer の tenant scope と active tenant registry を外れた mutation の拒否テスト / cross-tenant broker 不在の grant 拒否テスト / revoke 済み edge の再操作にも認証が必要なテスト / 不正 ledger event の fail-closed replay テスト / Chronos mutation route の ViewerContext 接続テスト / 制限ラッパの網羅性を検査する型テスト(interface へのメソッド追加でコンパイルエラーになること)/ taint を超える grant の発行拒否テスト / revoke の永続化先行と対象リンク限定の live-session 退去テスト。

### OS-14: 生成ミニ surface — Gadget 型の段階採用(P3 / L)

**cloudflare-os の設計**: Gadget = AI が書くユーザーごとのミニアプリ。server は internet 遮断 isolate(`globalOutbound: null`)で実行され、client/server の通信を単一 RPC 契約(Cap'n Web)に**強制**することで、**全アプリが自動的に agent から操作可能な API を持つ**(MCP サーバも独自 agent ループも不要)。blueprint から scaffold し、共有は observer 検証付き。

**kyberion の現状**: surface は手書き Next.js(`presence/displays/`)のみ。A2UI(`libs/core/a2ui.ts`)が agent 主導の動的 surface 組成を持つが、(a) 生成コードの実行基盤、(b) 「アプリ側 API の自動公開」規約がない。従来の見送り理由は非目標ではなく**基盤不足**(isolate なしでは安全に成立しない)であり、OS-08 の基盤が育てば成立する。

**実装**(前提: OS-03 / OS-08 / OS-11 / OS-13 完了後):

1. A2UI に「surface server は typed op contract(zod schema 付き)を必ず公開する」規約を追加 — agent が追加のツール定義なしで生成アプリを discovery → 操作できる(cloudflare-os の Cap'n Web 強制に相当する kyberion 語彙での規約)。
2. `code:execute_governed`(OS-08)を常駐セッション化した gadget runtime を新設: 生成コードは brokered binding(OS-03 の introduction 済みリソース)以外に到達できず、全副作用は held キュー(OS-01)を通る。
3. scaffold は automation-blueprint(OS-11 の binding 要求宣言付き)から。生成コードの履歴は mission 管理下の git に置く(Yjs は採らない)。
4. 共有は OS-13 グラフ + OS-05 taint 検査経由のみ。
5. 初期スコープは **operator 自身の内部ツール**(ダッシュボード断片・かんばん亜種・集計ビュー)に限定。テナント向け公開・マルチユーザー提供は SaaS 運用判断とあわせて §3 の再評価項目(課金・サインイン)と同時に設計する。

**受入条件**: isolate escape テスト(生成コードから env・生ネットワークに不達)/ 生成アプリの op contract を agent が discovery → 呼び出しできる統合テスト / blueprint scaffold → 実行 → 共有の e2e / 共有時に taint 検査が働くテスト。

**今回の実装**: `CloudflareOsControlPlane.generateGadget()` は zod の input/output schema と governed code、introduction、observation metadata、tenant binding を持つ operation contract を必須化する。`discoverGadgetOperations()` は実行関数や code を公開せず descriptor だけを返し、実行は `runGovernedCode()` の child-process isolation 経由に限定する。read operation は introduction・capability・tenant を検証して observation 台帳へ記録し、held operation は `submitHeldAction()` に積み、承認適用時にも capability を再検証する。contract と schema は secure-io 管理の control-plane state に保存し、再起動後に復元する。

### OS-15: 認証設定の不変面 + OAuth callback 堅牢化(P2 / S)

**cloudflare-os の設計**: 認証設定は意図的に **env 変数のみ**で AdminConfig に置かない — 「**侵害された admin セッションから認証設定を変更できないように**」(`admin-config.ts` の明示コメント)。OAuth flow は initiation nonce の constant-time 比較、段階 TTL(initiation → oauth)、放棄フローの self-destruct alarm、サインイン用途は最小スコープ + 2 分で自壊する一時グラント(github.ts:1131)。

**kyberion の現状**: `KYBERION_VIEWER_SCOPE` の env 段階制御は同型で整合。ただし (a) 認証・承認の**ルート設定**のうち実行時可変面(HTTP API / 表面 / 設定ファイル書込 op)から変更できてしまうものの棚卸しがなく、(b) `scripts/oauth_callback_surface.ts` の nonce 衛生(constant-time 比較・TTL・放棄時クリーンアップ)が体系的に検証されていない。

**実装**: (1) 「認証・承認のルート設定は env / 人間承認ゲート付きファイルのみから変更可能」という不変条件を boundary-test 化(可変面から到達できる設定パスの静的棚卸し + 回帰)。(2) OAuth callback に constant-time nonce 比較・段階 TTL・放棄フロー self-destruct を実装/検証。(3) 将来 OS-13/14 で principal が増える際のサインイン(OAuth ベース)は本項の衛生を前提に別途設計する(本計画では骨格のみ)。

**受入条件**: 可変面から認証設定を変更する経路が存在しないことの boundary-test / nonce のタイミング安全・TTL・自壊のテスト / 既存 OAuth preset 連携の回帰。

**今回の実装**: OAuth state は Kyberion が生成し、呼び出し側の state override は拒否する。preset の scope allowlist を超える要求、通常 actuator からの redirect URI override、state なしの直接 code exchange を拒否し、interactive setup の redirect は human gate + loopback HTTP に限定する。pending session の initiation TTL を 10 分、callback 開始後の TTL を 2 分に分離し、期限切れ state は読み出し時に消去する。state ごとの lock で callback の二重 exchange を防ぎ、code 不在・service 不一致・token exchange 失敗を含む callback 試行では pending session を self-destruct する。callback surface の runtime summary は token を保存せず、state の照合は候補長を揃えた `timingSafeEqual` を使う。OAuth preset の既存連携と回帰テストで検証する。

---

## 3. 非採用(明示)

2026-08-09 方針更新(情報共有・将来 SaaS 化は妨げない)に伴い、旧「非目標につき非採用」だった **共有グラフ → OS-13**、**Gadget プラットフォーム → OS-14** は採択へ移動した。残る非採用は**ランタイム置換の費用対効果**と**時期尚早(運用実体待ち)**の 2 種に限る。

| cloudflare-os の要素                                                                              | 非採用の理由                                                                                                    | 回収済みの断片                                                                                                        |
| ------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Workers ランタイム基盤(Durable Objects / Facets / Dynamic Workers / Worker Loader / tail workers) | kyberion はファイルベース + プロセスモデルが正本。移植コストが価値を大きく上回る                                | 「既定遮断」思想(`globalOutbound: null`)は OS-08/14 の isolate 仕様に採用                                             |
| Cap'n Web RPC への置き換え                                                                        | 表面 API は Next.js route + ViewerContext で確立済み。プロトコル置換は価値に対し破壊が大きい                    | object-capability 文法は OS-03、「全アプリが agent API を自動公開」の強制は OS-14 の typed op contract 規約として採用 |
| typed-storage(DO SQLite 層)                                                                       | ストレージ正本はファイル + 監査チェーン(QM 計画 §4 と同判断)                                                    | —                                                                                                                     |
| Yjs 同期・リアルタイム共同編集                                                                    | OS-14 は mission 管理下の git 履歴で代替。リアルタイム共同編集は必要が生じた時点で再評価                        | —                                                                                                                     |
| BYOK 課金 / AI Gateway 無料枠                                                                     | **時期尚早**: 対応する運用実体(課金主体)がまだない。SaaS 運用開始の判断時に OS-14 §5 と同時に再評価             | per-turn コスト帰属メタデータ + 実ログ非同期照合の形式は OP-01 コスト会計の参考                                       |
| gatekeeper による OAuth サインイン                                                                | **時期尚早**: サインイン表面は principal が operator 1 名の現在は不要。OS-13 でマルチユーザー化する時点で再評価 | env-only 原則・nonce/TTL/self-destruct 衛生は OS-15 で回収                                                            |
| pi-agent-core への LLM 層移行                                                                     | reasoning backend failover chain(claude-cli → grok-cli → …)が確立済み。置換理由なし                             | 二スロット system prompt(cache prefix 安定化)は backend 側で制御可能なら参考                                          |
| フォーマット blueprint(docs/sheets/slides のオフィススイート)                                     | 成果物生成は creative design cascade + 既存 engine(PPTX 等)が担う                                               | fingerprint 付き seed 更新規律と語彙マッピングは OS-11 で回収                                                         |
| 「eval なし・手動スモーク」の検証方針                                                             | pi-impl.md が自認する早期アルファの割り切り。kyberion の hermetic テスト規律を緩める理由にしない(反面教師)      | 決定的リプレイ重視の姿勢は既存方針と一致                                                                              |

## 4. 実装順序と依存

```
OS-01(held キュー)─→ OS-02(シミュレーション)─→ OS-07(revert)
        └─→ OS-06(auto-approve drain)
OS-04(observation)─→ OS-05(taint → egress)─→ OS-13(共有グラフ)──┐
OS-03(introduction)─→ OS-08(Code Mode op)──────────────────────┼─→ OS-14(生成ミニ surface)
        └─→ OS-10(per-thread 分離)・OS-11(binding 宣言)────────┘
OS-09 / OS-12 / OS-15 は独立(OS-12 は OS-02 のテスト基盤として先行が得。
OS-13 実装 3(default-deny ラッパの ViewerContext 先行適用)は依存なしで即着手可)
```

P0 の 2 件(OS-01/02)が本計画の背骨 — 「止めない承認」は operator 不在時間帯の autonomous 運転(AO 系)の詰まりを直接解消する。OS-03〜05 は「ambient アクセス + 行動監査の read 盲点」という現行の構造的弱点への対処で、順序は 04→05、03 は並行可。OS-13/14 は共有・SaaS 方向への布石で、OS-14 は本計画の合流点(OS-03/08/11/13 が揃ってから)— 先行着手しない。

## 5. 実装状況

| ID        | 状態                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 備考                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| OS-01〜15 | 共通 control-plane 契約・reference と各 surface 接続済み。OS-11 は automation blueprint の credential-free required binding 宣言・不足時拒否・語彙/fingerprint 形状を実装。OS-12 は Vitest 共通 outbound guard（localhost + 明示 allowlist、外部 fetch の接続前 fail、afterAll 断言）を実装。OS-13 は default-deny wrapper、tenant-scoped viewer authorizer、Chronos mutation route、共有グラフ基礎、token 検証付き live-session 登録、失効 scope barrier、ledger replay eviction を実装、OS-05 は provenance/egress core と Chronos ViewerContext の tier masking を実装済み | `libs/core/cloudflare-os-control-plane.ts` と hermetic acceptance (`libs/core/cloudflare-os-control-plane.test.ts`, `pipelines/cloudflare-os-validation.json`) を実装。レビューで検出した VM escape、未認証 approval、競合 apply、揮発 state、OAuth service/state 不一致、tenant 欠落 egress、親 capability revoke、実 fetch 未監視を修正し、回帰テストを追加。さらに service-actuator の明示 `context.introduction_mode: "enforce"` を OS-03 enforcement へ接続し、`context.observation` を OS-04 observation 台帳へ接続。OS-15 は OAuth session TTL / constant-time state 比較 / 放棄時 self-destruct まで実装。`CloudflareOsSurface` と Presence Studio の `/api/os/control-plane`、human decision/apply route、OS observation panel で最初の本番 surface 接続を完了。追加レビューで server-side viewer/tenant scope、human actor binding、apply failure status、summary redaction、UI mutation error/confirmation、route contract test を追加。さらに Chronos の `/api/os/control-plane` に `ViewerContext` の tenant scope を接続し、read-only OS panel と route/UI contract test を追加。Chronos では server-side `tierAccess` を `CloudflareOsSurface` に伝播し、同一 tenant でも許可 tier を超える observation を masking する integration と回帰テストを追加。Operator Surface には browser input を受けない server-side tenant scope、明示 principal、OS read audit、read-only restore、guarded surface next-action、観測時刻を備えた projection panel と回帰テストを追加。Computer Surface には既存の localadmin/token 境界の内側へ `/api/os/control-plane` を追加し、server-side tenant scope、human principal、private no-store、held action / observation の表示用パネル、guarded surface への next-action 導線、URL 検証、読み取り専用回帰テストを追加。さらに OS-13 の default-deny read-only wrapper (`CloudflareOsReadOnlySurface`) を追加し、Chronos / Operator Surface / Computer Surface の projection consumer が decision/apply API を型上公開しない構成へ移行した。`libs/core/share-grant-graph.ts` には owner-root の到達可能性、論理的な可逆 edge revoke/re-grant、128-bit token の HMAC ハッシュ保存、TTL、taint を広げない audience floor gate、resource の tenant binding、認証済み revoke、fail-closed replay、provenance mission の再解決、失効 ledger 同期後の対象 live-session 退去、token 検証付き session opening、replay 時の eviction 再実行を追加し、`libs/core/share-grant-live-sessions.ts` の registry に失効 scope barrier を追加して Chronos mutation graph へ接続した。`libs/core/share-grant-authorizer.ts` で trusted viewer context、active tenant registry、cross-tenant broker gate を mutation 認可へ接続した。`libs/core/provenance-taint.ts` を共有 projection と egress contract の単一実装として追加し、Chronos の `/api/os/share-grants` では public 以外の resource に provenance mission を必須化した。 |

## 6. 実行者ノート(codex / GPT 5.6 Luna 向け)

本節は本計画を実行する codex CLI エージェントへの拘束事項。**着手前に必ず repo ルートの `AGENTS.md`(= `CLAUDE.md`)と `knowledge/product/governance/kyberion-development-practices.md` を読むこと。**

1. **セッション開始**: `pnpm pipeline --input pipelines/baseline-check.json` を実行し、report の `status` に従って分岐(`AGENTS.md` §3)。
2. **mission ゲート**: 必須トリガーが1つ以上、または蓄積トリガーが2つ以上なら**必ず mission 化**する。`work-scope-policy.json` を正本とし、`scripts/mission_controller.ts` で start(命名例: `MSN-OS-ADOPTION-<YYYYMMDD>`)し、OS-XX 単位を work item として claim。mission 全体状態を worker から直接変更しない。
3. **不変条件**: ファイル I/O は `@agent/core/secure-io` のみ(`node:fs` 直接呼び出し禁止 — cloudflare-os から移植するコード断片にも適用)。一時ファイルは `active/shared/tmp/`。plugin 設定 `.kyberion-plugins.json` の直接編集禁止。tier 逆流禁止。
4. **1 変更 1 検証**: 変更のたびに対象テストを個別実行。仮説を変えずに同一リトライをしない。「done」は証跡(テスト出力・trace)必須。
5. **検証コマンドの罠**: ルート tsc は `libs/actuators` を型検査しない — actuator を触ったら **`pnpm build:actuators` を必ず実行**。`surface-coordination-store` の replay テストは並列 full-suite で flake することがある(単独再実行で確認してから判断)。
6. **登録セレモニー**: 新規 op(OS-02 `simulate`、OS-08 `code:execute_governed`、OS-09 `knowledge:read`)や新規 export は boundary-test allowlist の登録セレモニー対象(kyberion-development-practices 参照)。黙って追加しない。
7. **政策ファイル**: 承認まわりの変更は `knowledge/product/governance/approval-policy.json` を単一ソースとし、コード側にルールを埋め込まない。
8. **完了の取り込み**: 各 work item の完了は `mission_controller reconcile-work <ID> --generate` → 証跡記入 → `--dry-run` → apply。`NEXT_TASKS.json` の手書き完了マークは禁止。レビュー task は structured receipt(code-reviewer 役割 + implementer id)が必要。
9. **文書規約**: 実装状況は本文書 §5 の表を更新(行を OS-XX ごとに分けてよい)。開発者向け文書は日本語(`.ja.md`)、コード・コミット・ルールは英語。
10. **モデル指定**: ローカル codex CLI の既定は `gpt-5.6-sol` と表示されることがある。Luna で実行する場合は `codex -m gpt-5.6-luna`(モデル差は本計画の内容・受入条件に影響しない)。
11. **クローン後始末**: `active/shared/tmp/cloudflare-os` は分析済み。参照が不要になった時点で削除してよい(license は cloudflare-os 側 LICENSE に従い、コードの逐語コピーは行わず設計の再実装とする)。
