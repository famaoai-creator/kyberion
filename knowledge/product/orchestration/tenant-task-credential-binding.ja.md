---
title: テナント資格情報のタスク束縛
tags: [security, credentials, tenant, workitem, providers]
last_updated: 2026-11-16
runtime_stages: [execution]
---

# テナント資格情報のタスク束縛

概念の正準定義は[資格情報のライフサイクル・割り当て・実行境界](../architecture/api-credential-proof-boundary.md)。
この文書は実装済みのタスク束縛プロトコルを定義する。
「割り当て」は利用者への継続的な利用許可、「束縛」はその許可を現在の実行へ適用すること。
外部binderを設定した場合は下記のsecret serviceが割り当てを判定する。未設定の場合は
人が承認した `credential.use` standing Grantをローカルbrokerが解決する。
登録キーの割り当て・確認・取り消し・実タスク経路の実証は
[tenant資格情報の手順](../../../docs/developer/TENANT_CREDENTIALS.ja.md)を参照する。

## ローカル割り当て

`reasoning credentials assign` はtenant・canonical provider・secret参照名・理由・期限を
既存の承認へ束縛し、承認後に既存のGrant storeへ保存する。別のキー保管庫は作らない。
dispatchは現在のclaimを検証してから、許可された参照先のconnection documentだけを
短命のread-only capabilityで読む。通常のtenantコードがpersonal documentを読めるようにはしない。
Grant/承認の取り消し・期限切れ・claim変更・キー更新は次の管理されたAPI利用時にも検査する。
送信済みリクエストや起動済みCLIセッションを取り消す機構ではない。

外部binderが存在するときはローカルへfallbackしない。外部binderの資格情報はその外部管理境界で失効させる。

`ShellSecretResolver.bindTask` は、既存の `KYBERION_SECRET_RESOLVER_COMMAND`
で設定された信頼済みsecret serviceから、現在のタスク専用の資格情報を受け取る。
新しい資格情報ストアは作らず、operatorの環境変数・personal connectionsへの
フォールバックもしない。接続先ごとの利用権限や外部送信承認は別途必要となる。

## 設定済みコマンドのプロトコル

通常のsecret解決は従来どおり `{{key}}` / `{{scope}}` を使う。
タスク束縛時は `{{key}}` が固定の `__KYBERION_TASK_BINDING__`、
`{{scope}}` が検証済みの現在のtenant slugになる。コマンドは次のJSONをstdinで受け取る。
資格情報の値は引数に渡さない。

```json
{
  "version": 1,
  "scope": {
    "tier": "confidential",
    "tenant_slug": "example-org",
    "mission_id": "MSN-EXAMPLE",
    "task_id": "task-a"
  },
  "workItemId": "WI-example"
}
```

secret serviceは、このtenantへの明示的な割り当てを確認したうえで、次の形式をstdoutに返す。
ログや説明はstdoutに混ぜない。設定値は例示用のプレースホルダーである。

```json
{
  "version": 1,
  "secrets": {
    "ANTHROPIC_API_KEY": "<tenant-owned-value>"
  },
  "providerEnvironments": {
    "codex": {
      "HOME": "/absolute/checkout/active/shared/cache/confidential/example-org/provider-auth/codex/home"
    }
  }
}
```

`providerEnvironments` はCLIを使わなければ省略できる。
`HOME` は既存のprivate tenantの一時領域またはキャッシュ領域内に事前に作成し、当該tenantの
認証を設定する。operator HOMEのコピー、別tenantのHOME、リンク、特殊ファイル、
HOME外を指す認証設定パスは拒否される。CLIの子プロセス環境はこの設定から構築される。
レスポンスは128 KiBまで、secret/envの各mapは64項目まで、各値は16,384文字まで。
未知のトップレベルフィールドや不正なキー・型・プロトコルversionは拒否する。

## 実行境界と失敗時の扱い

coordinated dispatchはWorkItemをclaimし、mint済みのscope envelopeとcanonicalな
claim holderのactor contextに入ってからbinderを呼ぶ。
adapterはtenant/mission/task、WorkItemのtyped context、実行中attempt、active lease、
holderを照合し、secret service応答後にも同じclaimが継続していることを確認する。
応答にはidentityを含めず、bindingのidentityは現在のclaimから付与する。
organization/projectを持つ実行では、WorkItemのtyped contextとdispatchの
`security_scope`にも同じchainを渡す。scopeから省略したprojectを、WorkItem側の
既定値で権限として補完することはしない。

空stdout・コマンド失敗は未束縛のまま扱い、後続のproviderアクセスがfail closedする。
`{"version":1,"secrets":{}}` は意図的な空bindingであり、operatorへのfallbackを許可しない。
不正応答やscope/claim変更はsecretの内容を含まないエラーになる。
資格情報やコマンド出力をmission evidenceへ保存しない。

これはclaim後のタスク実行向けのadapterであり、WorkItem claimを持たない
`mission kickoff` にoperator資格情報を貸す仕組みではない。
設定されていないtenantへの実service接続、OAuthログイン、課金provider呼び出しの
動作確認を、adapterの回帰テスト成功と同一視しない。

検証: `shell-task-credential-binding.test.ts` / `task-credential-dispatch.test.ts` /
`shell-task-credential-dispatch.integration.test.ts` / `provider-auth-home.test.ts` /
`credential-binding.test.ts`。実portとの統合テストでは、Work Coordinationが
`current_attempt_id`に保持する`run_id`と、別の`attempt_id`を区別して照合する。

## tenantless 個人 dispatch の段階的導入

tenantless の claimed dispatch は、インストール済みの個人所有者・active な canonical
NHI、runtime が mint した mission/task envelope、同じ WorkItem の現在の run と生存 lease
を照合して、資格情報が空の binding 内で実行する。owner と NHI は入力値から選ばず、
既存の read-only identity resolver で毎回確認する。別 owner、actor、task、run、lease の
キャッシュ済み client を流用できない。

この段階では tenant 用の configured broker を呼ばず、token、provider HOME、GWS session、
PRESET 操作を許可しない。operator の account 登録・provisioning・鍵アクセス・接続設定読取も
拒否する。直接 operator として行うセットアップは claimed dispatch の外で扱う。

scope envelope のない claimed dispatch、自由形式の peer label、未登録・停止済み NHI は拒否する。
既存呼出元は canonical NHI と一致する typed mission/task/project context に移行する必要がある。
現行の WorkItem project モデルに合わせた public standalone project の credential-free 実行までが
対象であり、personal tier の project、missionless 実行、個人 account の利用許可は後続段階である。
詳細は [依存関係と未実装範囲](../architecture/api-credential-proof-boundary.md#tenantless-personal-execution-dependency-roadmap) を参照。

## 常駐 Dot の binding（standing lineage）

tenant の常駐 Dot は agent-runtime supervisor（複数 tenant を扱う 1 プロセス）が起こす。
起動時の実行文脈は role と tenant だけで、mission/task の系譜も WorkItem の claim もない。
そのため推論が `[CREDENTIAL_BINDING_REQUIRED]` で止まる。これは claim なしに資格情報を貸さないための正しい拒否であり、
回避ではなく、Dot の実行を他の WorkItem と同じ claimed dispatch に乗せて解決する
（実装: `libs/core/dot/dot-standing-binding.ts`）。

- **standing Issue**: Dot ごとに 1 件。系譜 ID は Dot の mission admission の規則
  (`dotAdmissionMissionId` / `dotAdmissionItemId`) を `dot-standing:<tenant>:<dot_id>` に適用した
  `MSN-DOT-*` / `WITEM-DOT-*` で、決定的に同じ値になる。この mission ID は系譜 ID であり、
  mission_controller の mission 記録ではない。Issue は backlog で作られ、executor は `ready` しか取らないので拾われない。
- **charter の出所**: tenant の資格情報を束縛するのは `knowledge/confidential/<tenant>/dots/` から読み込まれ、
  同じ tenant を宣言する confidential charter だけ。repo 直下の `dots/` charter が tenant を宣言しても束縛しない
  （`[DOT_STANDING_CHARTER_UNBOUND]` で失敗する）。git 管理の charter を書けるだけで tenant の資格情報を使えないようにするため。
- **step = 種類ごとに 1 件を再利用**: Issue の下に wake 用と executor 用の step が 1 件ずつあり、1 回の実行ごとに
  Dot の canonical NHI (`kyberion://agent/<tenant>/<org|_>/dot-<dot_id>`) が claim する（1 回の claim が 1 attempt）。
  step の task ID が binding の task になる。lease (15 分) は実行中の supervisor が 5 分ごとに更新し、実行後は
  step を backlog に戻して lease を解放する（`ready` にはしないので dispatcher は拾わない）。結果は attempt と
  `metadata.execution_status` に残る。attempt 履歴は store が上限で切るので、Dot 1 体あたりの WorkItem は
  Issue と step 2 件の計 3 件で増えない（保持・削除の仕組みは不要）。
- **異常終了した step**: lease が切れたまま in_progress に残った step は、その Dot の次の実行が claim の前に
  回収する（attempt を `lease_expired` にして同じ step を使う）。standing の Issue と step は dot の作業ではないため、
  dot executor の reaper と実行候補から除外され、「結果不明」として隔離・エスカレーションされることはない。
  別の実行が lease を持っている間は `[DOT_STANDING_CLAIM_BUSY]` で見送り、次の sweep で再試行する。
- **binding**: step の claim を持ったまま、系譜から mint した scope envelope・Dot の role と系譜を持つ実行文脈・
  claim holder の actor context に入り、`withConfiguredTaskCredentials` を通す。binding は AsyncLocalStorage 内にしか存在せず、
  同じプロセスで交互に起きる 2 つの tenant が binding を共有することはない。推論 backend はその中で
  `buildTaskReasoningBackend` が作る task 専用 chain を使い、operator 用のプロセス全体の chain は借りない。
- **事前検査**: claim の前に、bind 時と同じ判定（`allocationGrantInScope` / `reasoningAllocationProviderAdmitted`）で
  使える Grant があるかを確かめる。charter が `runtime.reasoning_backend` を指定していれば、その provider の Grant に限る。
  API provider ではない backend（例: `claude-cli`）は built-in の割り当てでは束縛できないので、claim せずに
  `[DOT_CREDENTIAL_GRANT_MISSING]` で失敗する。モデル呼び出しで束縛済みの資格情報が使えなかった場合
  （`CREDENTIAL_KEY_UNAVAILABLE` / `CREDENTIAL_PROVIDER_DENIED` / `CREDENTIAL_ALLOCATION_DENIED`）も
  `credential_grant` に分類し、wake circuit が数える（backend の再選択はしない）。
- **資格情報の出所**: ローカル broker の場合、tenant の owner が承認した `credential.use` standing Grant だけ。
  利用のたびに Grant・承認・claim・キーを再検査する（取り消し後の次の利用は fail closed）。外部 binder を設定している場合は
  その binder が判定し、事前の Grant 検査は行わない。
- **失敗の扱い**: Grant が無い → `[DOT_CREDENTIAL_GRANT_MISSING]`、期限切れ（猶予内）→ `[DOT_CREDENTIAL_GRANT_EXPIRED]`、
  charter の出所が違う → `[DOT_STANDING_CHARTER_UNBOUND]`、claim を作れない → `[DOT_STANDING_BINDING_UNAVAILABLE]`。どれも次に打つコマンドを含み、モデルを呼ばずに
  失敗した wake として記録される（ledger の `reason_code` は `credential_grant` / `standing_binding`）。
  wake circuit が数えるので、同じ失敗を毎回繰り返さない。executor は WorkItem を claim せず、Dot ごとに sweep 1 回につき
  skipped を 1 行だけ記録する。lease を失った場合は、その実行の資格情報利用が fail closed し、次の実行が step を回収する。
- **actor の NHI**: Dot は NHI として登録されていないため、名前を NHI registry では照合しない。
  資格情報の判定は名前ではなく現在の claim で行い、名前の正しさは charter の出所の規則で担保する。
- tenantless（public）の Dot は従来どおりで、step も binding も作らない。

### credential.use Grant の延長

Grant は最長 30 日。期限が来る前に、同じ Grant の `expires_at` だけを延ばす。ID・principal・scope・目的は変わらない。

```bash
pnpm kyberion reasoning credentials allocations --tenant <tenant>          # 期限と days_left
pnpm kyberion reasoning credentials extend --tenant <tenant> --grant <grant_id> [--days 30]
pnpm kyberion approvals --approve <approval_id>                            # owner が承認
pnpm kyberion reasoning credentials extend --tenant <tenant> --grant <grant_id> [--days 30] --approval <approval_id>
```

- 延長 1 回の承認は、grant ID・直前の期限・延長日数に payloadHash で結び付き、1 回だけ消費される（consumer `grant_extension`）。
  新しい期限は「承認を消費した時刻 + 延長日数」で、1 回あたり capability の上限（30 日）を超えない。
- 取り消し済みの Grant は延長できない。期限切れから 7 日（`GRANT_EXTENSION_GRACE_DAYS`）以内なら延長でき、
  その間 Grant は何も許可しない。7 日を過ぎたら `assign` で新しい Grant を依頼する。
- 延長は監査（`grant.extended`）に記録され、利用のたびに延長の連鎖ごと再検証される。手で `expires_at` を書き換えた記録は何も許可しない。
- 期限の 7 日前から、supervisor の Dot sweep が ops_alert（Chronos に表示）で 1 日 1 回知らせる。

### claude CLI（サブスクリプション）で常駐 Dot を動かす場合

built-in の割り当ては API キーの provider だけを束縛する。claude CLI は束縛中、`providerEnvironments.claude`
（tenant 専用の HOME）が無いと `CREDENTIAL_PROVIDER_DENIED` で止まる。これを満たすのは現状、外部 binder
（`KYBERION_SECRET_RESOLVER_COMMAND`）が tenant 専用 HOME を返す経路だけである。
built-in で「tenant 専用 HOME に `claude login`」を束縛する方式は採用していない。macOS の claude CLI は
ログイン情報を HOME ではなく利用者の Keychain に保存するため、HOME を分けても operator 本人のログインを
共有・上書きするおそれがあり、「operator の CLI ログインへ fallback しない」境界を保証できない。
サブスクリプションで動かす場合は、tenant 専用の長期 token（`claude setup-token`）を秘密として登録し、
`credential.use` で割り当て、束縛時に tenant 専用 HOME と `CLAUDE_CODE_OAUTH_TOKEN` を claude の子プロセスへ渡す。
子プロセス側（起動引数・環境・作業ディレクトリ）は次節のとおり実装済み。資格情報の種類・貸し出しの判定は
[設計](../../../docs/developer/improvement-plans-2026-11/CLAUDE_CLI_TENANT_CREDENTIAL_DESIGN_2026-11-16.ja.md) §2・§3 に従う。

### claude CLI の隔離起動（束縛下）

束縛下の claude CLI は、operator の設定・hooks・MCP・ログインを読まない。delegate・stream・prompted-tools の
全経路（`libs/core/shell/shell-claude-cli-backend.ts`）に同じ規則を当てる。実装は
`libs/core/provider/claude-cli-tenant-isolation.ts`、環境の組み立ては `buildProviderChildEnv`（provider `claude`）。

binding は `secrets`・`providerEnvironments.claude`（`HOME`、`CLAUDE_CONFIG_DIR=$HOME/.claude`、秘密の値は入れない）・
`credentialKind`（`api_key` | `subscription_token`）を持つ。

| 項目           | api_key                                                                                                           | subscription_token                                              |
| -------------- | ----------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| 共通の引数     | `--strict-mcp-config --mcp-config '{"mcpServers":{}}' --setting-sources '' --settings '{"disableAllHooks":true}'` | 同左                                                            |
| 追加の引数     | `--bare`（Keychain と OAuth を読まない）                                                                          | なし（`--bare` は token を無視する）                            |
| 環境に通すもの | `HOME`、`CLAUDE_CONFIG_DIR`、`ANTHROPIC_API_KEY`                                                                  | `HOME`、`CLAUDE_CONFIG_DIR`、`CLAUDE_CODE_OAUTH_TOKEN`          |
| 落とすもの     | `CLAUDE_CODE_OAUTH_TOKEN`、`ANTHROPIC_AUTH_TOKEN`、他 provider のキー                                             | `ANTHROPIC_API_KEY`、`ANTHROPIC_AUTH_TOKEN`、他 provider のキー |
| 共通の環境     | `DISABLE_AUTOUPDATER=1`、`CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`                                             | 同左                                                            |
| cwd            | tenant の scratch floor（`active/shared/tmp/<tier>/<tenant>/claude-cli/<id>`、終了時に削除）                      | 同左                                                            |

- 資格情報は binding の `secrets` からだけ取る。`providerEnvironments.claude` に入っていた鍵は使わない。
- `credentialKind` が無い、または種類に対応する秘密が無い場合は、子プロセスを起動せず `[CREDENTIAL_PROVIDER_DENIED]` で止まる。
  未知の種類は束縛時に `[CREDENTIAL_BINDING_INVALID]`。`CLAUDE_CONFIG_DIR` が HOME の外なら `[CREDENTIAL_HOME_REQUIRED]`。
- operator の `KYBERION_CLAUDE_CLI_EXTRA_ARGS` は束縛下の起動には付けない。
- 束縛の無い実行（operator 自身の作業）は従来どおり（引数・環境・cwd を変えない）。
- 確認: 単体テスト `libs/core/shell/shell-claude-cli-tenant-isolation.test.ts`（種類ごとの引数・環境、秘密が無い場合の拒否、未束縛の不変）と、
  doctor の canary `claude-tenant-isolation`（`pnpm kyberion doctor --manifest reasoning-backend`）。canary は隔離した HOME で資格情報なしに
  `claude [--bare] auth status --json` を実行し、両方の種類で未ログインであることを確かめる。ログイン済みと出たら FAIL（隔離が壊れている）。
  モデルへの要求は出さない。claude が無ければ skip する。

## 運用手順

資格情報の登録・貸し出し・承認・延長から Dot を動かすまでの流れは [reasoning-credential-lending-playbook](./reasoning-credential-lending-playbook.ja.md) を参照。
