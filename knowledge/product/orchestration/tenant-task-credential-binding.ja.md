---
title: テナント資格情報のタスク束縛
tags: [security, credentials, tenant, workitem, providers]
last_updated: 2026-11-01
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
