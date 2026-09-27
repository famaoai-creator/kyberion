# Authority, Role & Persona Model (v3.0)

## 1. 概要

Kyberion の権限モデルは **ExecutionMode** を中心に再設計されました。プロセスがどの領域で動いているかを `system / mission / sovereign` の 3 モードで明文化し、モードごとに書き込み可能なパスを厳格に分離します。

この `ExecutionMode` は書き込み権限の境界を定義し、作業を mission 化するかどうかは定義しません。実行形状の選択は [`work-scope-policy.json`](./work-scope-policy.json) のミッションゲートに従い、`system` / `sovereign` の権限を持つ作業でも、作業自体が mission-shaped ならそのゲートを通過します。両者に個人タスクという新しい概念は導入しません。

### 命名の注意

| 用語             | 定義                   | 値の数 | 場所                                        |
| ---------------- | ---------------------- | ------ | ------------------------------------------- |
| **Persona**      | 実行コンテキスト ID    | 6 種   | `libs/core/types.ts`                        |
| **Perspective**  | AI 思考スタイル        | 27 種  | `knowledge/product/personalities/matrix.md` |
| **Authority**    | 物理操作の特権         | 6 種   | `libs/core/types.ts`                        |
| **docAuthority** | ドキュメント信頼レベル | 5 段階 | knowledge frontmatter                       |

以前は "Persona" が実行 ID と思考スタイルの両方に使われていました。v3.0 からは思考スタイルを **Perspective** と呼びます。

---

## 2. ExecutionMode (実行モード)

プロセスの動作領域を 3 つに分類します。Persona から自動導出されます。

```
persona === 'sovereign'           → executionMode = 'sovereign'
persona === 'ecosystem_architect' → executionMode = 'system'
それ以外                           → executionMode = 'mission'
```

### SYSTEM モード (`ecosystem_architect`)

Kyberion 自体のメンテナンス。

|              | 対象パス                                                                                                                                                                 |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 書き込み可   | `knowledge/product/`, `libs/`, `scripts/`, `pipelines/`, `schemas/`, `presence/`, `satellites/`, `plugins/`, root ドキュメント群, `active/audit/`, `active/shared/logs/` |
| 書き込み不可 | `knowledge/personal/`, `knowledge/confidential/`, `active/missions/`, `active/projects/`, `customer/`                                                                    |

### MISSION モード (`worker`, `analyst`, `mission_owner`)

ミッション・タスクの実行。

|              | 対象パス                                                                                                                                              |
| ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| 書き込み可   | `active/missions/${MISSION_ID}/`, `active/projects/`, `customer/`, `knowledge/product/evolution/`（蒸留のみ）, `active/audit/`, `active/shared/logs/` |
| 書き込み不可 | `knowledge/product/`（evolution 以外）, `libs/`, `scripts/`, `knowledge/personal/`, `knowledge/confidential/`                                         |

### SOVEREIGN モード (`sovereign`)

緊急・全権。すべての操作が audit に記録されます。

---

## 3. 構成要素

### A. Persona (実行 ID)

`KYBERION_PERSONA` 環境変数または `resolveIdentityContext()` で解決されます。

- **sovereign**: 全境界を超越。すべてが audit 記録対象。
- **ecosystem_architect**: SYSTEM モード。Kyberion コアの維持管理専用。
- **mission_owner**: MISSION モード上位。ミッション全体を統制。
- **worker**: MISSION モード。プロジェクト・ミッションのサンドボックス内に制限。
- **analyst**: MISSION モード。ナレッジ読み取りと蒸留書き込みに特化。
- **unknown**: 未解決。ほとんどの書き込みが拒否される。

### B. Authority Role (機能ロール)

`MISSION_ROLE` として注入され、`security-policy.json` の `authority_role_permissions` と対応します。

28 の知識ロールと Authority Role の対応は `knowledge/product/governance/role-authority-map.json` を参照してください。

- **system_roles** (6): `ecosystem_architect`, `knowledge_steward`, `solution_architect`, `integration_steward`, `reliability_engineer`, `infrastructure_sentinel`
- **mission_roles** (5): `mission_controller`, `software_developer`, `sovereign_concierge`, `incident_commander`, `performance_engineer`
- **context_roles** (16): `ceo`, `business_owner`, `product_manager` など。Authority Role はなく、ナレッジ上の責務定義のみ。

Authority role definitions: `knowledge/product/governance/authority-roles/*.json`

### B2. ロールの解決順序とロール引き受けポリシー (RA-01 / RA-02)

`resolveRole()`（`libs/core/authority.ts`）は次の順で現在の Authority Role を決めます。secure-io / tier-guard の認可判定は `resolveIdentityContext()` 経由でこの結果を使います。

1. **プロセス内で引き受けたロール** — `withExecutionContext` / `withExecutionContextAsync` が `AsyncLocalStorage`（`libs/core/foundation/execution-scope.ts`）に載せたロール。非同期コンテキストごとに独立し、`await` をまたいでも入れ子でも正しく戻ります。**プロセス内でしか設定できず、親プロセスから継承した環境変数からは決して来ません。**
2. **委譲されたロール（DR-01）** — 親が `buildExecutionEnv(env, role)` で起動した子プロセスのロール（`KYBERION_DELEGATED_ROLE`、下の「子プロセスへのロール委譲」）。1 のどの引き受けよりも下、`SYSTEM_ROLE` より上です。
3. `SYSTEM_ROLE` — `scripts/surface_runtime.ts` が各サーフェスを `SYSTEM_ROLE=<surface id の - を _ にしたもの>`（例: Chronos → `chronos_mirror_v2`）で起動し、`pnpm surfaces` / `pnpm config-mission` も自身に設定します。
4. `MISSION_ROLE`
5. `process.argv[1]` のファイル名からの推定

Persona も同じスコープに従います（`resolveExecutionPersona()`）。引き受け（委譲を含む）で決まった Persona が `KYBERION_PERSONA` より優先されます。

環境変数への反映（ミラー）は同期版の `withExecutionContext` だけが行います。同期の `fn` の実行中は他のコンテキストが割り込めないため、書き込みと復元が交差しません。また `fn` 自身が書き換えた値は上書きして戻しません。非同期版の `withExecutionContextAsync` は `process.env` に一切触れません。同期版に Promise を返す `fn` を渡した場合、スコープのロールはその Promise の継続（`await` の後）にも引き継がれますが、環境変数のミラーは `fn` が返った時点で元に戻ります。非同期の処理には `withExecutionContextAsync` を使ってください。環境変数はプロセス全体で 1 つなので、並行する非同期コンテキストが書き込みと復元を交互に行うと、値が壊れたまま残るためです。子プロセス用の env（`buildExecutionEnv` / `buildSafeExecEnv`）は現在のスコープの引き受けを反映します。**正しさは環境変数に依存しません**。認可判定では環境変数を直接読まず、`resolveRole()` / `resolveIdentityContext()` / `resolveExecutionPersona()` を使ってください。

認可の入力になる Persona は実行スコープから解決します: secure-io の policy-engine 判定（`file_write` / `execute_command` の `agentId`）、`operation-policy-gate`、`organization-digest` の sovereign 判定は `executionPersonaText()` / `resolveExecutionPersona()` を使います。`MISSION_ROLE` / `KYBERION_PERSONA` を今も直接読む既知の箇所は、監査・トレースの帰属ラベル、または CLI の操作者 ID 照合だけです（非同期の引き受けの中では外側の値になります）:

- 帰属ラベル: `network.ts`、`secret-guard.ts`、`secret-introduction.ts`、`delegated-task-observability.ts`、`provider-pins-store.ts`、`seam-provider-selection.ts`、`seam-selection-rules.ts`、`mission-lifecycle-service.ts`、`reasoning-bootstrap.ts`、`work-coordination.ts`、`project-management.ts`、`organization-operating-model*.ts`、`organization-operation-run-recording.ts`、`tenant-governance.ts`、`cloudflare-os-control-plane.ts`、`acp-mediator.ts`、`claude-agent-governance.ts`
- CLI の操作者 ID 照合: `mission-maintenance.ts`（承認者）、`mission-work-reconciliation.ts`（採用者）
- 明示的に渡された env を読むもの: `mcp-request-context.ts`、`authn-providers.ts`（`deps.env` があるときのみ。ないときはスコープを使う）

以前は `SYSTEM_ROLE` が `MISSION_ROLE` より優先されていたため、surface_runtime から起動されたサーフェスでは `withExecutionContext` によるロール引き受けがすべて黙って無視されていました（例: Chronos の `chronos_localadmin` によるテナントレジストリ読み取りやプラグイン承認）。

**ロール引き受けポリシー（多層防御）**: `SYSTEM_ROLE` が設定されたプロセスが引き受けられるのは、次のいずれかのロールだけです。それ以外を引き受けようとすると、`fn` を実行する前に `[ROLE_ASSUMPTION_DENIED]` で失敗します。

- `SYSTEM_ROLE` 自身（常に許可）
- [`role-assumption-policy.json`](./role-assumption-policy.json) の `shared_core_roles`（`libs/core` が自分のストアへ書くために呼び出し元の代わりに内部で引き受ける、範囲の狭いロール: `chronos_gateway`、`infrastructure_sentinel`、`knowledge_steward`、`slack_bridge`、`surface_runtime`）。広い権限を持つ `ecosystem_architect` / `mission_controller` / `sovereign_concierge` は共有せず、到達可能性で裏付けられたサーフェスごとに `may_assume` に理由付きで載せます。stimuli journal（`presence/bridge/runtime/stimuli.jsonl`）の追記とローテーションは、呼び出し元の引き受けに依存しないよう `infrastructure_sentinel` で書き込みます（SB-01）
- 同ファイルの `system_roles.<system role>.may_assume`

**読み取り専用の狭いロール（TR-01）**: 個人 tier を読めないサーフェスのロールが特定の 1 ファイルだけを読む必要がある場合は、広いロールを引き受けず、そのファイルだけを許可する専用ロールを作ります。`chronos_token_registry_reader` は viewer token registry（`knowledge/personal/connections/chronos-access.json`、SHA-256 ハッシュのみ）の読み取りだけを許可し（`security-policy.json` の `allow_read` はこのファイルそのもの、`allow_write` は空。ロールとしての書き込み権限はなく、Persona `worker` と `default_allow` の書き込み先だけが残ります）、Chronos / Concierge の viewer 解決と `authn-providers` の `registry-token` プロバイダーが `withExecutionContext(CHRONOS_TOKEN_REGISTRY_READER_ROLE, …)` で使います。registry を実際に読む `chronos_mirror_v2` / `concierge` の `may_assume` にだけ載っています（`computer_surface` / `presence_studio` は `registrations: null` を渡すため registry を読みません）。

スコープのストアは `globalThis` から到達できるため、スコープを読む側（`resolveRole()`、Persona 解決、子プロセス env）は引き受けられたロールを読み出すたびにこのポリシーで再検査します。拒否されるロールを載せたスコープは警告（`[ROLE_ASSUMPTION_IGNORED]`）を出して無視されます。スコープのオブジェクトは凍結されており、書き込み口は `authority.ts` が使う `runInExecutionScope` だけです。`system_roles` に載っていない `SYSTEM_ROLE` は自分自身しか引き受けられません。ポリシーファイルがない、または壊れている場合も同じです（fail closed）。この場合は警告を出し、60 秒ごとに読み直します。`SYSTEM_ROLE` のないプロセスの挙動は変わりません。一覧の根拠は、呼び出し単位の到達可能性レポートと実行時トレースです（下の「ポリシーの絞り込み手順」）。到達できるのに許可されていないロールを引き受けると本番で例外になるため、新しいサーフェスを追加したり、サーフェスから到達するコードで新しいロールを引き受けたりする場合は、レポートを再生成してこのポリシーを更新してください。`knowledge/product/governance/surfaces/` の外にある独自のサーフェス manifest や customer overlay から起動するサーフェスにも、`SYSTEM_ROLE`（surface id の `-` を `_` にしたもの）のエントリが必要です。エントリがなければ、そのサーフェスは自分自身のロールしか引き受けられません（`libs/core/organization/authority-role-assumption.test.ts` が、起動対象の全サーフェスにエントリがあることを検査します）。

**ポリシーの絞り込み手順（RN-01〜03: トレース → 解析 → 絞り込み）**:

1. **トレース（RN-01）**: `KYBERION_ROLE_ASSUMPTION_TRACE=<パス>` を設定すると、`withExecutionContext*` の判定ごとに `{system_role, assumed_role, allowed, caller, stack, ts}` を 1 行の JSONL として secure-io 経由で追記します（`libs/core/organization/role-assumption-trace.ts`）。トレース先は専用ディレクトリ `active/shared/tmp/role-assumption-trace/` か `active/shared/runtime/role-assumption-trace/` の下の `.jsonl` ファイルに限られ、パスのどこにもシンボリックリンクを含められません（それ以外は警告して無視）。パスは KYBERION_ROOT からの相対で解決され、ファイルは排他的に作成してから追記します。未設定なら環境変数を 1 回読むだけです。パスの解決も含めてトレースの処理はすべて例外を外に出さず、失敗してもロール引き受けの判定は変わりません（失敗後はそのプロセスのトレースを止めます）。サーフェスの vitest を `SYSTEM_ROLE=<surface>` 付きで実行する、plugin-views E2E を `--keep-root` で実行する（トレースの設定を Chronos に転送します）、ビルド済みのサーフェスを hermetic root（`active/shared/tmp/` の下に `knowledge/product` をコピーした root）で `SYSTEM_ROLE` 付きで起動する、といった方法で、実際に引き受けられたロールを集めます。
2. **解析（RN-02）**: `node --import ./scripts/ts-loader.mjs scripts/analyze_role_assumptions.ts` が TypeScript コンパイラ API で `withExecutionContext*` の呼び出しとロール引数（リテラル、型チェッカーで解決したリテラルの union、ラッパーの引数を経由して各呼び出し元で解決したロール）を集め、トップレベル宣言の参照グラフを surface manifest・`surface_runtime`・`config_mission` / `run_pipeline` の各エントリポイントからたどります。SYSTEM_ROLE を引き継ぐ子プロセス（`process.env` を渡す spawn や PTY）の起動先スクリプトもエントリポイントとして追います。結果は [`docs/developer/role-assumption-reachability.json`](../../../docs/developer/role-assumption-reachability.json) に書き出され、CI ゲート `role-assumption-reachability`（`--check`）がレポートの古さを検出します。
3. **絞り込み（RN-03）**: `may_assume` から外してよいのは、レポートが到達不能と示し（`policy_roles_not_reachable`）、かつどのトレースでも観測されていないロールだけです。rationale には根拠を書きます。`scripts/analyze_role_assumptions.contract.test.ts` は、レポートで到達可能なロールがポリシーにないと失敗します。

解析は「到達可能」とみなす側に倒しています。参照された宣言は呼ばれるか渡されるかを問わず到達可能とし、参照されたクラスはすべてのメンバーを、入れ子の関数は外側の宣言を到達可能とみなします。import されたモジュールの初期化コードは常に実行されるとみなし（`isDirectEntry` で守られた CLI 本体だけは、そのファイルがエントリポイントのときに限ります）、エントリポイント・動的 import されたモジュール・名前空間として値で使われたモジュールの export はすべて到達可能とします。解決できないロール引数、計算された動的 import、起動先を解決できないのに SYSTEM_ROLE を引き継ぐ子プロセスは「任意のロール」とみなし、そのサーフェスでは何も外せません。データに依存する分岐は、`scripts/lib/role-assumption-reviews.ts` のレビュー表（`REVIEWED_DYNAMIC_IMPORTS`、`REVIEWED_CHILD_PROCESSES`、`REVIEWED_INFEASIBLE_ASSUMPTIONS`）に理由と到達不能を固定するテストを添えて載せます。レビュー表にない新しいサイトは任意のロールとして扱われます。共有コアロールをシステムロールごとに外すにはポリシーの形を変える必要があるため、レポートが到達不能と示していても現在は外していません。

**子プロセスへのロール委譲（DR-01）**: 子プロセスの env は、明示ロールつきの `buildExecutionEnv(process.env, role)` で作ります（`{ ...process.env, MISSION_ROLE: '<role>' }` は使いません）。親から `SYSTEM_ROLE` を引き継ぐ場合、`MISSION_ROLE` だけでは `SYSTEM_ROLE` に負けて子は親サーフェスのロールで動いてしまうため、`buildExecutionEnv` は結果の env に `SYSTEM_ROLE` があるとき `KYBERION_DELEGATED_ROLE=<role>@<SYSTEM_ROLE>` も設定します（互換のため `MISSION_ROLE` も残します。`SYSTEM_ROLE` がなければ委譲は設定せず、継承した値も消します）。ロールを渡さない `buildExecutionEnv()` も、現在のスコープのロール（プロセス内の引き受け、またはそのプロセス自身の委譲）を同じように委譲します。子は、最初に実行スコープを読んだ時点（import 順に依存せず遅延・決定的）で env を読み取り（スナップショット。その後に `process.env` を書き換えても委譲は変わりません）、これをそのロールのプロセス内の引き受けと同じ扱いのプロセス全体のルートスコープにします。`KYBERION_DELEGATED_ROLE` を書き込めるのは `libs/core/authority.ts` だけです（`libs/core/organization/authority-delegated-role.boundary.test.ts` が検査し、解析もそれ以外の書き込みを任意のロールとして扱います）。

- **優先順位**: プロセス内の引き受けより下、`SYSTEM_ROLE` より上です。`resolveRole()` / `resolveAssumedRole()` / `resolveIdentityContext()`、Persona（`resolveExecutionPersona()`。ロールの既定 Persona）、子プロセス env（`buildExecutionEnv()` / `buildSafeExecEnv()`）が同じように従います。
- **上限**: 引き受けと同じ `isRoleAssumptionAllowed(SYSTEM_ROLE, role)` で検査します。許可されない委譲は `[ROLE_DELEGATION_DENIED]` の警告を出して無視され、子は `SYSTEM_ROLE` として、固定の低い Persona `worker` で動きます（fail closed。`nexus_daemon` のように `SYSTEM_ROLE` の既定 Persona が `sovereign` でも、それにはなりません）。子の中の引き受けの上限は、委譲されたロールではなく元の `SYSTEM_ROLE` の `may_assume` のままです。
- **新しい `SYSTEM_ROLE` での起動**: `SYSTEM_ROLE` を設定してプロセスを起動するもの（`surface_runtime` のサーフェス起動、`pnpm config-mission` のパイプライン、terminal HUD のサーフェス操作）は、必ず `buildSystemRoleLaunchEnv(env, systemRole, { persona, missionRole })` で env を作ります。これは `SYSTEM_ROLE` を設定し、起動元の委譲を必ず消し、`MISSION_ROLE` / `KYBERION_PERSONA` も起動の契約が明示した値（サーフェス manifest の `env` など）以外は消します。サーフェスの Persona は manifest の明示値、なければ `pnpm surfaces` の契約どおり `worker` です（起動元から継承した Persona は使いません）。manifest の `env` で `SYSTEM_ROLE` や委譲は設定できません。これがないと、`buildExecutionEnv(process.env, 'surface_runtime')` で起動された surface_runtime（`surface_runtime@X`）がサーフェス X を起動し直したとき、束縛が一致してサーフェス全体が surface_runtime として動いてしまいます。
- **空の値は未設定**: `buildSystemRoleLaunchEnv` は消すキーを削除せず空文字列（`MISSION_ROLE=` など）にします。Kyberion は空の値を未設定として扱うため、Node 以外の子プロセスや env を読む外部ツールも、空の値を「未設定」と解釈してください。
- **束縛**: 値は発行したときの `SYSTEM_ROLE` に束縛され、別の `SYSTEM_ROLE` のプロセスでは無視されます（上の起動規則に対する二重の防御）。`SYSTEM_ROLE` のないプロセスでは何もせず、従来どおり `MISSION_ROLE` が使われます。
- **孫プロセス**: 子が自分の `buildExecutionEnv(env, role)` を呼ぶと委譲は置き換わり、ロールを渡さなければ現在のスコープのロール（引き受けの中ならその引き受け、なければ自分の委譲）が委譲されます。上限はどちらでも元の `SYSTEM_ROLE` のものです。
- **伝播しない先**: プロバイダー / エージェント CLI の子（`buildProviderChildEnv`、SO-03）には `SYSTEM_ROLE` と同じく渡しません。`buildSafeExecEnv` も `SYSTEM_ROLE` と同じく既定では引き継がず、呼び出し側が明示的に渡した env（`buildExecutionEnv` の結果）でだけ届きます。呼び出し側やデータが渡す env（terminal / process アクチュエーターの `params.env`、system アクチュエーターの `exec` / シェル実行の `params.env`、ミッションゲート `command_succeeds` の `params.env`、service アクチュエーターの manifest の `env`、サービスプリセットの `alt.env`）からは `stripAuthorityEnvOverrides` が `SYSTEM_ROLE`・`MISSION_ROLE`・`KYBERION_PERSONA`・`KYBERION_DELEGATED_ROLE`・`KYBERION_SUDO` を取り除くため、クライアントや ADF の入力から設定する経路はありません。
- **トレース**: 委譲の判定は `KYBERION_ROLE_ASSUMPTION_TRACE` にプロセスごとに 1 回、`source: "delegation"` つきで記録されます。
- **到達可能性**: 解析は、`SYSTEM_ROLE` を運びうる env（`undefined` や省略は `process.env` の意味）に対する `buildExecutionEnv(env, role)` の呼び出しを `role` の引き受け箇所（`… [delegated child role]`）として数えます。env リテラルが `SYSTEM_ROLE` を設定している場合は、その `SYSTEM_ROLE` の到達可能ロールとして数えます。`buildSystemRoleLaunchEnv` で作った env は親の `SYSTEM_ROLE` を運ばないとみなします。子のエントリポイントは従来どおり子プロセスとしてたどり、子の中の引き受けは親の `SYSTEM_ROLE` の上限で数えます。

委譲の導入で外せるようになった許可はありません。Concierge の `/api/ingest` の子（`scripts/ingest.ts`）は `sovereign_concierge` として動くようになりましたが、`SYSTEM_ROLE=concierge` は引き継ぐため、子の中の `ingest_commit` の引き受けには引き続き `concierge` の `may_assume` が必要です。nexus-daemon が起動するアクチュエーターは明示ロールなしの `process.env` で起動されるため、従来どおり `nexus_daemon` として動き、`ingest_commit` / `reconcile_config_fallbacks` も残ります。明示的に委譲されるロール（`sovereign_concierge`、`mission_controller`、`surface_runtime`）はいずれも、起動元のサーフェスの `may_assume` か共有コアロールにすでに含まれています。ロールなしの `buildExecutionEnv()` が委譲するのは、親がすでに引き受けを許可されたロールだけです。既存の委譲箇所（Chronos の intelligence、surface-mission-proposals、ミッション編成のハンドラー、Concierge の avatar / config-missions）の子は、以前は親サーフェスのロール（例: `chronos_mirror_v2` は `active/shared/coordination/chronos/` などにしか書けません）で動いていましたが、今は委譲されたロール（`mission_controller` は `active/shared/` と `active/missions/` に書けます）で動くため、書き込みの範囲は狭まっていません。

### C. Authority (特権)

特定の物理操作に対して与えられる、時間制限付きの「鍵」です。

- **SUDO**: セキュリティガードを完全にバイパスする全能特権。
- **GIT_WRITE**: リポジトリの変更・ブランチ操作。
- **SECRET_READ**: 秘匿情報の取得（スコープ制限あり）。
- **SYSTEM_EXEC**: 任意のシェルコマンド実行。
- **NETWORK_FETCH**: 外部 API との通信。
- **KNOWLEDGE_WRITE**: ナレッジ層の直接変更。

### D. Tier (知識階層)

| Tier             | パス                      | 書き込み可能な Persona                  |
| ---------------- | ------------------------- | --------------------------------------- |
| **product**      | `knowledge/product/`      | `sovereign`, `ecosystem_architect`      |
| **confidential** | `knowledge/confidential/` | `sovereign`（ecosystem_architect 不可） |
| **personal**     | `knowledge/personal/`     | `sovereign` のみ                        |
| **public**       | `knowledge/public/`       | `sovereign`, `ecosystem_architect`      |

> v3.0 変更点: `confidential` から `ecosystem_architect` の write を削除（SYSTEM モードは confidential に書かない）。

---

## 4. 評価順序

権限判定は次の順で行われます。

1. `default_allow`（`active/audit/`, `active/shared/logs/` を含む）
2. `Authority` による明示的な許可
3. `Authority Role` による実行スコープ許可
4. `Persona` による恒常的な許可
5. `Tier` 制約による deny
6. 明示的に許可されなかった経路の deny

---

## 5. ガバナンス・プロトコル

### Temporal Grant (時間制限付き付与)

Authority は原則としてミッションに紐づけて発行されます。Authority Role は長寿命の責務、Authority は短寿命の鍵です。

- `mission_controller grant <MISSION_ID> <SERVICE_ID>` により、必要なときだけ権限を委譲します。
- 付与された権限は `active/shared/auth-grants.json` に記録され、期限が切れると自動的に無効化されます。

### Sovereign Sudo (主権者による委譲)

緊急時や初期設定時、主権者は明示的に `SUDO` モードを起動できます。

- `mission_controller sudo <MISSION_ID> ON`
- この操作は system-ledger に永久に記録され、監査の対象となります。

SUDO が必要な操作のうち `scope-approve` (origin intent のリベースライン) は、
**approval-mediated 経路**を持ちます: worker が `scope-approve --request-approval`
で hash-bound の `mission_gate` 承認リクエストを `mission-scope` チャネルに起票し、
人間が `pnpm kyberion approvals --approve <id>` で承認すると、worker は
`--approval-request-id` による適用で SUDO なしに完了できます
(`libs/core/mission/mission-scope-approval.ts` — `reconcile-work` と同じ PI-05 型)。
承認は goal/reason/success-condition の payloadHash に束縛され、`approved_by` には
承認した人間 decider が記録されます。これにより「権限を持たない worker が詰まる」
状態を解消しつつ、分掌 (drift した worker が自ら rebaseline しない) を維持します。
手順の詳細は [mission-triage-playbook](../orchestration/mission-triage-playbook.md) を参照。

なお `pnpm kyberion approvals --approve` の human 認証は surface が申告する形
(`decidedByType: 'human'`, `authMethod: 'manual'`) であり、人間が操作するターミナル
であることが信頼境界です — PI-05 系 (reconcile-work, plugin install) と同一の前提です。
より強い認証 (passkey/TOTP) の証跡化は将来の改善余地です。

---

## 6. 起動時の環境変数

サーフェスやバックグラウンドサービスを起動する際、`KYBERION_PERSONA` と `MISSION_ROLE` を正しく渡す必要があります。設定は `knowledge/product/governance/surfaces/<surface-id>.json` の `"env"` プロパティに定義します。

```json
"env": {
  "KYBERION_PERSONA": "worker",
  "MISSION_ROLE": "surface_runtime"
}
```

Persona が `unknown` のままだとほとんどの書き込みが拒否されます。`resolveIdentityContext()` の返す `executionMode` で現在のモードを確認できます。

テナントに束縛された実行（`KYBERION_TENANT`、chronos のテナントパイプライン）の env 構成、違反を起こす組み合わせ、安全なプローブ手順、キルスイッチの確認方法は [tenant-bound-runtime-probing](./tenant-bound-runtime-probing.md) を参照してください。

---

_Status: v3.0 — ExecutionMode / 4-tier / 28-role mapping (2026-06-02)_
