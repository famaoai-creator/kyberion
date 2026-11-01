# API キーの登録・実証と provider の拡張

キーはアカウントの権限・請求先、モデル ID は呼び出すモデルを指定します。1つのキーをモデルと1対1で保存する仕組みではありません。

## 登録から利用までの概念

正準定義は[資格情報のライフサイクル・割り当て・実行境界](../../knowledge/product/architecture/api-credential-proof-boundary.md)です。
登録・割り当て・束縛・モデル選択・実証を別々に管理します。

| 操作・状態 | 意味                                                      | 現状                                                             |
| ---------- | --------------------------------------------------------- | ---------------------------------------------------------------- |
| 登録       | 承認のうえ、キーを既存の保管先へ保存する                  | operator向けの `register` が実装済み                             |
| 割り当て   | キーの参照先を特定tenantが利用できると承認する            | `assign` と人による承認。既存のstanding Grantを利用              |
| 束縛       | 検証済みtenant・mission・taskの実行に必要なキーだけを渡す | claim後のtrusted dispatchと `SecretResolver.bindTask` が実装済み |
| 選択       | 使用するbackend・モデル・経路を決める                     | provider定義と既存の選択・routing設定で管理                      |
| 実証       | その実行経路で、対象API・モデルを実際に呼べたか確認する   | `verify` が実装済み。利用許可を付与する操作ではない              |

personalは保管・データの区分、tenantは実行時の分離境界です。scopeを切り替えても
利用許可は増えません。今回登録した個人キーはoperator利用の対象であり、登録だけで
全tenantから使えるようにはなりません。同じキーを複数tenantで利用する設計でも、
明示的な割り当てを個別に行い、外部アカウントの請求・上限・鍵の更新影響は共有されます。

登録キーが存在しても、tenant側の割り当てや束縛がなく利用できない状態は正常です。
tenant実行でキーが欠けた場合にpersonalキーへ戻る動作はありません。
tenant側はローカル割り当てまたは[タスク束縛プロトコル](../../knowledge/product/orchestration/tenant-task-credential-binding.ja.md)の
外部secret serviceを使います。[登録から割り当て・タスク実証・取り消しまでの手順](./TENANT_CREDENTIALS.ja.md)を参照してください。
外部task binderが設定されている場合、その空結果からローカル割り当てへはfallbackしません。

## 現在の登録・確認コマンド

```bash
# キーだけ登録。既存の承認付き secret introduction と非表示入力を使う
pnpm kyberion reasoning credentials register --provider openai

# モデルも選び、通常利用する API backend へ切り替える
pnpm kyberion reasoning credentials register --provider openai --model MODEL_ID --activate

# 存在確認は有効性の証明ではない
pnpm kyberion reasoning credentials status --provider openai

# 課金の可能性を明示的に許可し、短い公開テスト文を1回だけ送る
pnpm kyberion reasoning credentials verify --provider openai --model MODEL_ID --allow-paid
```

`MODEL_ID` はその API アカウントで利用可能なモデル ID に置き換えます。キーを argv・チャット・`.env` へ貼り付けないでください。`register` は既存の `kyberion secret introduce` を呼び、Secret Guard と OS secret store の導入・承認・監査を再利用します。承認待ちの場合はモデルや backend を有効化しません。表示された secret introduction の手順を完了してください。

登録時の `--model` は任意です。`--activate` では明示指定 → 環境変数 → 保存済み設定 → provider 定義の既定値で解決し、不足している場合だけ要求します。キーとモデルは別設定です。実証の `--model` は毎回明示します。

OpenAI API の canonical mode は `openai-api`、CLI の mode は `codex-cli` です。以前からの runtime alias `openai` は Codex CLI のまま保持します。**このキー登録コマンド**の `--provider openai` は API descriptor の `provider` 名で解決し、有効化時には `openai-api` を保存します。CLI の OAuth 認証は API キーの代わりに使いません。Responses adapter はテキスト・構造化推論に対応し、画像・ツール・ネイティブストリーミングは宣言しません。Tenant 実行では既存の task credential binding を必須とし、operator の ambient key へフォールバックしません。

Nemotron は `--provider nemotron-api` と `KYBERION_NEMOTRON_MODEL` を使います。初回有効化時に URL が未設定なら NVIDIA の公式 URL を保存します。明示済みの自前ホスト URL は保持します。API 実証は descriptor に定義された公式 URL を検証し、runtime の URL override には従いません。

実証は `Reply with exactly OK.` の公開テスト文だけを、最大128出力トークン・20秒・1回で送ります。再試行・リダイレクト・CLI/backend fallback はしません。OpenRouter の配下 provider fallback も無効です。小さい実証でも料金が発生する可能性があり、金額上限は保証しません。結果は physical scope を使った `active/shared/runtime/health/api-verification/` 配下へ provider・モデル・日時・成否・固定結果コード・出力上限だけを保存します。キー・応答本文・provider の生エラーは保存しません。

`status` の `configured` は現在のスコープでキーを解決できたかを示します。`verified` は
現在のキーのバージョン・選択モデル・endpoint・実行identity・通信経路と一致する15分以内の実証があるかを示します。
operatorでの成功はtenantでの成功や、別のCLI・プロセス経路での成功を保証しません。
`ENOTFOUND` は接続先ホストの名前解決の失敗で、認証拒否やtenant権限不足とは別です。
DNSは `dns_failed`、401/403/404/429やtimeoutも固定コードで区別します。その他の `request_failed` をDNSと断定しません。

鍵のローテーションと利用許可の取り消しは別操作です。ローカル束縛は次の管理されたAPI利用時にも
Grant・承認・期限・claim・キーのバージョンを再検証します。送信済みのAPIリクエストは取り消しません。
外部resolverと起動済みCLIプロセスの失効は、それぞれの管理境界に従います。

## 既存 API 形式の provider を追加する

別のレジストリは作りません。正準定義は既存の `knowledge/product/governance/reasoning-providers/*.json` です。`secret_refs` の先頭が登録・実証するキーの identity、`model_env_keys` がモデル設定、追加の `api_proof` が実証 protocol と固定 URL です。

```json
{
  "secret_refs": [
    { "service_id": "example", "secret_key": "API_KEY", "env_keys": ["EXAMPLE_API_KEY"] }
  ],
  "model_env_keys": ["EXAMPLE_API_MODEL"],
  "api_proof": {
    "protocol": "chat-completions",
    "base_url": "https://api.example.com/v1"
  }
}
```

これは既存 descriptor に追加するフィールドの例です。通常の provider descriptor・directory index・backend policy・route/model 設定は既存の登録手順に従います。既存 protocol の場合、キー登録・モデル解決・実証の呼び出し側に分岐を足す必要はありません。必要な egress 許可は別の policy で設定し、descriptor の追加で tenant の送信許可を広げません。

組み込み proof protocol は `messages`、`generate-content`、`responses`、`chat-completions`、`openrouter-chat` です。`default_model`、`default_model_role`、`runtime_url_env` は必要に応じて指定できます。スキーマは `reasoning-provider-registry.schema.json`。秘密付き・private/local・HTTP・query 付き URL と未登録 protocol は送信前に拒否します。

## 新しい API 形式

独立した trusted module から `registerReasoningApiProofAdapter` を呼び、request renderer と text extractor を登録します。descriptor の `api_proof.protocol` にその ID を指定すれば、登録・実証 CLI の編集は不要です。通常実行の新しい protocol は既存の provider-module registration / conformance gate に従って実装・登録してください。JSON から任意のコードをロードしたり、既存 adapter を上書きしたりはしません。

実証は adapter 登録の前後で同じ共通ループを通ります。新 adapter でも固定の公開文・渡された出力上限・秘密情報の非出力を守り、tenant credential binding と egress gate を迂回しないでください。
