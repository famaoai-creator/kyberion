# 登録したAPIキーをtenantのタスクで使う

この手順では、キーを登録し、特定tenantへの利用を人が承認し、そのtenantのタスクで接続を実証します。
キー本体は非表示の入力画面だけに入力します。引数・チャット・手順書・承認理由に貼り付けません。

## 1. 対象と作業スコープを確認する

```bash
cd /Volumes/data/forcheck/kyberion
pnpm kyberion tenant list
pnpm scope show

# 現在のscopeを退避し、キー登録を行うoperator scopeに移る
pnpm scope push
pnpm scope operator
```

`scope operator` は保存済みのtenant・organization・project・mission・taskの選択を外し、personalを選びます。
シェルで設定したscope環境変数は優先されるため、`pnpm scope show` でtenantが `(shared)` になっていることを確認してください。
退避したscopeは最後に `pnpm scope pop` で復元します。`scope clear` は退避履歴も消すため、この手順では使いません。
この選択変更はtenantへの利用許可ではありません。実行中タスクの束縛も書き換えません。

以下の値は、実在するactiveなtenantと、そのtenantのorganization/projectに置き換えてください。
新しいtenantやprojectの作成は、それぞれ既存のtenant・organization・project管理コマンドで行います。

```bash
TENANT='your-tenant'
ORG='your-organization-id'
PROJECT='your-project-id'
MODEL='your-api-model-id'
MISSION='MSN-CREDENTIAL-PROBE-20261102'
```

## 2. 個人のキーを登録・確認する

```bash
# 登録済みなら再登録は不要
pnpm kyberion reasoning credentials register --provider anthropic
pnpm kyberion reasoning credentials status --provider anthropic

# operatorとしてAPI接続も確認する場合。料金が発生する可能性がある
pnpm kyberion reasoning credentials verify --provider anthropic --model "$MODEL" --allow-paid
```

`configured=true` はキーを解決できたこと、`verified=true` は現在のキー・モデル・endpoint・実行スコープと一致する
15分以内の実証があることを示します。モデル選択が実証と異なる場合や鍵の更新後は `verified=false` になります。
登録は現在の通常backendを自動で変更しません。`--model` と `--activate` はキー登録とは別の選択です。

## 3. tenantへの利用許可を申請する

```bash
pnpm kyberion reasoning credentials assign --provider anthropic --tenant "$TENANT" \
  --purpose 'Tenant reasoning' --days 7
```

この時点ではキーの共有は有効になりません。出力の `approval_id` を控えます。
承認画面にはtenant・provider・資格情報の参照名・理由・期限が表示され、キー本体は含まれません。
割り当ては既存のstanding Grantとしてtenantのconfidential partitionに保存されます。
`--days` は1〜30日で、未指定なら30日です。現行の制限単位はtenant・provider・参照先・期限です。
モデル単位の許可リストや個別金額上限をこのコマンドで設定する機能はありません。

## 4. 人が承認し、割り当てを適用する

```bash
pnpm scope use --tier confidential --tenant "$TENANT" --organization "$ORG" --project "$PROJECT"
pnpm kyberion approvals --approve <approval_id>

# provider・tenant・purpose・daysは申請時と同じ値を使う
pnpm kyberion reasoning credentials assign --provider anthropic --tenant "$TENANT" \
  --purpose 'Tenant reasoning' --days 7 --approval <approval_id>

pnpm kyberion reasoning credentials allocations --tenant "$TENANT"
pnpm kyberion reasoning credentials check --provider anthropic --tenant "$TENANT"
```

認証済みの人による承認を既存の承認機構で確認します。エージェントによる自己承認や、別tenant・provider・参照先・期限への
承認の使い回しは認めません。適用結果の `grant_id` は取り消しに使います。
`check` はローカル割り当ての有効性を調べるだけで、キーを取得せず、APIにも接続しません。
`allocated=true` でも、サービス権限・データ送信許可・予算・モデルへのアクセスは別途必要です。

## 5. 実際のタスク経路でAPI接続を確認する

activeで、上記organization/projectに関連付けられた既存missionを使えます。
検証用missionを新規作成する場合は、既存のmission controllerを使います。

```bash
pnpm mission kickoff "$MISSION" --tier confidential --tenant-slug "$TENANT" \
  --organization-id "$ORG" --project-id "$PROJECT" \
  --goal 'Check the allocated API credential' --success-condition 'A tenant task returns verified'

pnpm kyberion reasoning credentials probe --provider anthropic --tenant "$TENANT" \
  --mission "$MISSION" --model "$MODEL" --allow-paid
```

`probe` は診断用WorkItemを作成し、通常のcoordinated dispatchでclaim・lease・scope envelopeを取得してから
割り当てを解決します。実証は公開の固定文1回・最大128出力トークンで、再試行・fallbackを行いません。
実行中の別task envelope内からの起動は拒否します。任意のtenantフラグだけで束縛を作るコマンドではありません。

成功時は `work_item_id`、`task_id` と `proof.status=success` / `proof.code=verified` を返します。
proofにはキーのバージョンを表すハッシュ・endpoint・モデル・日時・tenant/mission/task・通信経路を記録し、キー本体を保存しません。
失敗時もWorkItemのattemptと状態に結果を残します。通常タスクも同じdispatch経路に入れば割り当てを利用できます。
WorkItem claimを持たないmission kickoffや単独CLIへ、tenantの資格情報を自動貸与する機能ではありません。

タスクの `allowed_reasoning_backends` が指定されている場合、そのproviderだけの割り当てを解決します。
外部の `KYBERION_SECRET_RESOLVER_COMMAND` や明示的なtrusted resolverを設定している場合は、そのresolverが優先されます。
`bindTask` のない外部resolverから、ローカルのタスク束縛を自動補完することもありません。
外部resolverの空結果・失敗から、ローカル割り当てや個人キーへfallbackしません。

## 6. 取り消しと終了

```bash
pnpm kyberion reasoning credentials revoke --tenant "$TENANT" --grant <grant_id> --reason 'Finished testing'
pnpm kyberion reasoning credentials check --provider anthropic --tenant "$TENANT"

# 元の選択へ戻す
pnpm scope pop
```

同じtenant/providerに他の有効なGrantが残っていなければ、取り消し後の `check` は `allocated=false` と終了コード1を返します。
providerの利用を完全に止める場合は、`allocations` で対象を列挙し、有効なGrantをすべて取り消してください。
取り消したGrantを使う新しいローカル束縛は拒否され、既存のローカル束縛も
次の管理されたAPI利用時にGrant・承認・期限・claim・キーのバージョンを再検証して拒否します。
送信済みのAPIリクエストは取り消しません。外部resolverや起動済みCLI子プロセスの失効は、その別の管理境界に従います。
検証用missionの終了は既存の `mission verify` / `mission finish` の手順で行ってください。

## エラーとKeychainのダイアログ

| 表示                                             | 確認すること                                      |
| ------------------------------------------------ | ------------------------------------------------- |
| `credential_unavailable`                         | キー登録、operator/tenantの区別、実行時の束縛     |
| `CREDENTIAL_ALLOCATION_DENIED` / 割り当てなし    | 承認・適用・期限・取り消し・現在の参照先          |
| `dns_failed`                                     | そのCLIプロセスからのホスト名解決。キー不正とは別 |
| `authentication_failed` / `authorization_failed` | API側の401 / 403。アカウントと利用権限            |
| `model_or_endpoint_unavailable` / `rate_limited` | API側の404 / 429。モデル・URL・割り当て上限       |
| `network_timeout`                                | 通信のタイムアウト。自動再試行はしない            |

起動時の暗号化設定の一括復号、同じキーの二重照会、保存前の不要な削除を避けます。
明示的な1操作では拒否・timeoutも一時記憶し、同じ照会を繰り返しません。復号時に暗号鍵を新規作成したり、
読み取り拒否を「キーがない」と判断して暗号鍵を書き換えたりしません。
OSが必要なアクセス許可を初回に求めること自体はあります。身に覚えのない要求は拒否してください。
別のKyberionプロセスや未更新のプロセスの要求まで、この操作の一時記憶で抑止することはできません。

概念: [資格情報のライフサイクル](../../knowledge/product/architecture/api-credential-proof-boundary.md)。
実行契約: [tenantのタスク束縛](../../knowledge/product/orchestration/tenant-task-credential-binding.ja.md)。
