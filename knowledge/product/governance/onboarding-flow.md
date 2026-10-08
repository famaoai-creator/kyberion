---
title: オンボーディング標準フロー — 環境 / Identity / Tenant / Activation / First Work
tags: [governance, onboarding, identity, tenant, organization, activation, first-work]
last_updated: 2026-10-08
kind: governance
scope: repository
authority: standard
phase: [onboarding, alignment, execution]
---

# オンボーディング標準フロー

この文書は、Kyberion を初期化してから最初の仕事を安全に開始するまでの**手順の順序**の正本である。
各コマンドの詳しい説明や環境ごとの注意は [`docs/INITIALIZATION.md`](../../../docs/INITIALIZATION.md)、
最短の first-win は [`docs/QUICKSTART.md`](../../../docs/QUICKSTART.md)、lifecycle phase から参照する
短い runbook は [`phases/onboarding.md`](./phases/onboarding.md) にある。

## 1. 全体像とルート

オンボーディングは 4 つのブロックでできている。A と B は全員が通る。C は用途によって分岐する。

```text
A. 共通土台         前提 → 導入とビルド → first-win → readiness
B. 主体と identity  stance を決める → identity を保存 → baseline を all_clear へ
C. テナント運用     tenant registry → context binding → activation → first-work
D. 完了確認         vital-check → baseline-check
E. 組織の運営       purpose → service / operation → cadence / decision → 定常実行と状態確認
                    → 目標と KR → project → mission / work item → 進捗の計測
```

| ルート                  | 使い方                                      | 通るブロック                                        |
| ----------------------- | ------------------------------------------- | --------------------------------------------------- |
| **1. 個人のみ**         | 自分の作業を自分の identity で任せる        | A → B → D                                           |
| **2. AI 会社**          | AI workforce を主な労働力として会社を始める | A → B → C（`onboard company` で登録と結合） → D → E |
| **3. 既存テナント追加** | 機密境界を持つ顧客・組織の仕事を扱う        | A → B → C（個別コマンドで登録と結合） → D → E       |

ルート 1 は tenant を作らない。tenant に紐づく mission や first-work の apply が必要になった
時点で、ルート 3 の C に進む。ルート 2 と 3 では、activation receipt が `active` になるまで
最初の仕事を実行しない。

### ルート 2（AI 会社）の実行順

ルート 2 の stance（`customer/<company-slug>/`）は Step 5 の `onboard company` が作る。そのため
Step 3 の identity は **2 回**保存する: まず個人 profile に（Step 3）、次に company stance に切り替えて
もう一度（Step 5 の直後）。stance を有効にすると profile root が `customer/<company-slug>/` に
切り替わり、mission start はそこにある `my-identity.json` / `my-vision.md` / `agent-identity.json`
を要求するためである（無いと `Sovereign profile incomplete` で停止する）。

```text
Step 1〜2 → Step 3（個人 identity） → Step 4 → Step 5（onboard company）
  → stance:switch → onboarding apply（company stance の identity） → Step 7 → Step 8 → Step 9 → Step 10
```

### 操作シェルの前提（全ルート共通）

オンボーディングの governed facade（`stance:create`、`onboarding company`、`onboarding:context`、
`tenant:activation`）は、それぞれ必要な権限（tenant registry を扱う onboarding 権限など）を
自分で持つので、操作者 persona を設定しなくても動く。mission の作成も同様である。
`tenant:activation` は `--tenant-slug` / `--organization-id` の tenant と組織に自分で束縛するので、
`KYBERION_TENANT_SCOPE_REQUIRED=true` のシェルでも `KYBERION_TENANT` を設定せずに `plan` と `probe` が
同じ環境で動く。

persona が要るのは Step 10 の `pnpm organization` の書き込み系だけである。これは組織の運営状態を
変える操作なので、操作者を明示する。`pnpm onboarding apply` は `KYBERION_PERSONA` を `.env.local` に
記録するが、**pnpm script は `.env.local` を読み込まない**ため、組織を運営するシェルでは次を実行する
（tenant を限定したい場合は `MISSION_ROLE=organization_operator` と `KYBERION_TENANT=<tenant>`）。

```bash
export KYBERION_PERSONA=sovereign
```

## 2. 3 つの名前を混同しない

| 名前              | 意味                                                | 正本・用途                                                                                       |
| ----------------- | --------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `customer_slug`   | いまどの主体として振る舞うかという stance           | `customer/{slug}/` と `KYBERION_CUSTOMER`。認可境界ではない                                      |
| `tenant_slug`     | 機密性、認可、監査の境界                            | `knowledge/personal/tenants/{slug}.json` の registry profile と `knowledge/confidential/{slug}/` |
| `organization_id` | tenant をどう運営するかという目的・責任・運用モデル | governed organization facade が管理する状態                                                      |

包含順は常に次の一つである。

```text
tenant_slug → organization_id → project_id → mission_id → task_id → session
```

`customer/{slug}` はこの chain の一階層ではなく stance overlay である。customer 側にある
tenant JSON は表示・契約上の facet になり得るが、tenant registry の代替にはならない。

## 3. 標準手順

### Step 0: baseline を確認する

セッション開始時は次を実行し、結果の `status` に従う。

```bash
pnpm pipeline --input pipelines/baseline-check.json
# 出力の `[BASELINE] status=<status> failed_layer=<layer>` 行で分岐する。
# 層ごとの詳細 JSON が必要なら: node dist/scripts/run_baseline_check.js
```

| status             | 意味                                                   | 次の行動                                         |
| ------------------ | ------------------------------------------------------ | ------------------------------------------------ |
| `needs_recovery`   | L0〜L2（CLI、依存、ディレクトリとビルド）が欠けている  | suspension point を復元するか、Step 1 をやり直す |
| `needs_onboarding` | L3（アクティブな profile の `my-identity.json`）がない | Step 1 から進める                                |
| `needs_attention`  | L4 以降のどれかが落ちている                            | 失敗層を操作者に示す。初回は Step 4 で解消する   |
| `all_clear`        | すべて通過                                             | alignment で今回の目的を確認する                 |
| `fatal_error`      | pipeline 自体が失敗                                    | pipeline を修復するまで実行しない                |

baseline の判定層は次のとおり。`needs_attention` のときは、どの層が落ちたかで対処が決まる。

| 層  | 見ているもの                                                  |
| --- | ------------------------------------------------------------- |
| L0  | 必須 CLI                                                      |
| L1  | SDK とコア依存                                                |
| L2  | ディレクトリとビルド成果物                                    |
| L3  | アクティブな profile の identity                              |
| L4  | surface 定義と `active-surfaces.json`                         |
| L5  | サービス接続の準備状況                                        |
| L6  | cowork 連携                                                   |
| L7  | 必須の `KYBERION_*` 環境変数                                  |
| L8  | storage janitor の最終実行（48 時間以内）                     |
| L9  | 所属先がなくなった NHI がないこと                             |
| L10 | 有効なスケジュールがあるとき、chronos daemon が動いていること |
| L11 | 監査台帳に最近の記録があること                                |

### Step 1: 導入とビルド（A）

前提は Node.js `24+`、`pnpm`、`git` である。`env:bootstrap` はビルド済みの `dist/` を実行する
ため、必ず `pnpm build` の後に実行する。

```bash
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain
pnpm exec playwright install chromium   # 任意。ブラウザ系 first-win を使う場合
pnpm kyberion doctor
pnpm pipeline --input pipelines/verify-session.json
```

`pnpm kyberion doctor` と verify-session の first-win は [QUICKSTART](../../../docs/QUICKSTART.md) が正本である。

### Step 2: readiness を確認する（A）

surface、service、reasoning、doctor の準備状況をまとめて確認する。

```bash
pnpm kyberion setup report --persona first-time-user
```

報告に出た不足を、使う機能の分だけ埋める。

- **reasoning backend**: `pnpm reasoning:setup` で使える backend を確認して選ぶ。選んだ値は
  `.env.local` の `KYBERION_REASONING_BACKEND` に保存される。
- **外部サービス**: `pnpm service:setup` で必要な secret と接続の置き場を確認する。実行直前の
  可否は `pnpm service:preflight -- --service <service-id>` で確かめる。
- **secret の登録**: API key などの値は `pnpm kyberion secret introduce <service-id> <secret-key>` で
  入れる。値は argv では受け付けず、TTY の非表示プロンプトか `active/shared/tmp/` 配下の
  `--from-file` から読む。ローカルで自動承認されない場合は、表示された
  `pnpm kyberion approve <approval-id>` の後に `pnpm kyberion secret apply <approval-id> --from-file <path>`
  で適用する。登録状況は `pnpm kyberion secret status <service-id>` で確認する。GUI では
  concierge の `/settings` →「サービス連携」から同じ二段階の流れで登録できる。接続 JSON や
  `.env` に値を直接書かない。
- **機能ごとの依存**: `pnpm deps:check --actuator <browser|voice|media-generation>`。
  lightpanda などの system tool は `pnpm tool:setup -- --list` で確認し、`--apply` で導入する。

最後に background surface を起動する。

```bash
pnpm surfaces reconcile
```

これで concierge（秘書室、`http://127.0.0.1:3050`）なども起動し、Step 3 の GUI 経路が使えるようになる。

### Step 3: stance を決め、identity を保存する（B）

identity の保存先は stance で決まる。baseline の L3 も同じ場所を見るため、**identity を保存する前に**
stance を決める。

- 自分として使う（ルート 1）: `KYBERION_CUSTOMER` を設定しない。保存先は `knowledge/personal/`。
- 顧客・会社として使う: 先に `pnpm stance:switch <customer-slug>` で stance を切り替える。保存先は
  `customer/{customer-slug}/`。ルート 2 の `pnpm onboarding company` はこの overlay を作るので、
  ルート 2 では上の「ルート 2 の実行順」に従い、company stance でもう一度 identity を保存する。

identity は次のどれかで保存する。

```bash
# 対話（TTY あり）
pnpm onboarding

# 非対話。テンプレートを active/shared/tmp/ に複製して編集し、dry-run で検証してから適用する
pnpm onboarding apply --identity knowledge/public/templates/onboarding/identity.example.json --dry-run
pnpm onboarding apply --identity <reviewed-identity-json>

```

TTY の無い環境（エージェント、CI）で `pnpm onboarding` を実行すると exit 2 で停止する。
その場合は上の `onboarding apply` を使う。

GUI では concierge の `/settings` を開く（旧 `/setup` と `/onboarding` はここへリダイレクトされる）。

| セクション     | ここで決めること                                    |
| -------------- | --------------------------------------------------- |
| あなたのこと   | 名前、言語、対話スタイル、vision（identity の保存） |
| 組織とメンバー | メンバーと承認者、責任を持つ agent                  |
| サービス連携   | 外部サービスの接続と secret の登録                  |
| 声と話し方     | 音声と話し方                                        |
| 通知           | 通知の受け取り方                                    |
| 拡張機能       | プラグインの承認                                    |
| 詳細設定       | 管理用の設定                                        |

この段階で作られるのは identity、vision、agent identity、onboarding state と summary、
connection 候補、tenant 候補、tutorial plan である。外部サービスへの書き込みや、最初の mission の
実行はまだ行わない。

### Step 4: baseline を all_clear にする（B）

Step 0 の baseline をもう一度実行する。初回は次の層が `needs_attention` になりやすい。

- **L8（janitor）**: baseline-check が storage janitor を自動で投入する。完了後に baseline を
  再実行すれば通る。手動で走らせる場合は次を使う。

  ```bash
  pnpm pipeline --input pipelines/storage-janitor.json --context '{"dry_run":false}'
  ```

- **L10（scheduler）**: 有効なスケジュールが一つもなければ通る。スケジュールを登録したら chronos
  daemon を常駐させる。macOS では `pnpm kyberion scheduler install` で内容を確認し、`--apply` で
  LaunchAgent に登録する。その場で動かすだけなら `pnpm scheduler`。
- **L11（監査台帳）**: 監査記録が一つもないか古いと落ちる。Step 3 の identity 保存などの
  governed 操作を行えば記録される。

**ルート 1（個人のみ）はここで Step 9 の完了確認へ進む。**

### Step 5: tenant registry を登録・検証する（C）

オンボーディング入力に含まれる tenant は候補、または stance 側の facet として扱う。
機密境界の正本登録は governed facade で行う。

```bash
pnpm tenant create <tenant-slug> \
  --display-name "<Tenant name>" \
  --assigned-role owner \
  --apply
pnpm tenant show <tenant-slug> --json
pnpm check -- --only tenant-registry
```

新しい tenant は `isolation_policy`（`strict_isolation: true`、`allow_cross_distillation: false`）付きで
登録される。Step 7 の `memory_policy` チェックはこの値を要求する。

registry が `active` でない tenant、未登録の tenant、tier 名と衝突する tenant は、後続の
binding と activation に進めない。customer stance を切り替えても registry の正本は変わらない。

ルート 2 では、Step 5 と Step 6 を次の governed facade でまとめて行える。dry-run で書き込み範囲を
確認してから、`--dry-run` を外して適用する。

```bash
pnpm onboarding company --help   # 使える --vertical の一覧を表示する
pnpm onboarding company --vertical saas-product-company --slug <company-slug> \
  --name "<会社名>" --owner-id human:<owner> \
  --goal "<最初に達成する顧客成果>" \
  --tenant-slug <tenant-slug> --dry-run
```

適用すると customer overlay、tenant registry、organization state、context binding（Step 6）が
作られる。続けて company stance に切り替え、その stance の identity を保存する。

```bash
pnpm stance:switch <company-slug> && source active/shared/runtime/customer.env
pnpm onboarding apply --identity <reviewed-identity-json>
```

`customer/<company-slug>/onboarding/ai-company-readiness.json` と `first-work-plan.md` を
確認する。consistency check と Step 7 の activation は省略しない。

### Step 6: customer stance と organization を結合する（C）

tenant と organization の結合を dry-run で確認してから適用する。

```bash
pnpm onboarding:context bind \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --dry-run --json
pnpm onboarding:context bind \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --apply --json
```

この apply は `customer/{customer-slug}/onboarding/organization-context.json` と、
tenant に紐づく organization state を作成または再利用する。これは activation ではない。

### Step 7: tenant activation を検証し、人間が受け入れる（C）

activation は context binding があるだけでは完了しない。registry、organization state、
責任を持つ人間、memory policy に加えて、viewer scope、NHI、service readiness、isolation の
各 probe を明示的に確認する。`--owner-id` には Step 3 の「組織とメンバー」で登録した
承認者を指定する。

```bash
pnpm tenant:activation plan \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id>

pnpm tenant:activation activate \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --owner-id human:<owner> \
  --nhi-id <nhi-id> \
  --check-viewer-scope \
  --check-nhi \
  --check-services \
  --check-isolation \
  --probe-ref viewer_scope=<audit-ref> \
  --probe-ref nhi_provisioned=<audit-ref> \
  --probe-ref service_readiness=<audit-ref> \
  --probe-ref isolation_probe=<audit-ref> \
  --apply --accept
```

`--accept` は人間の受け入れを表す。成功すると
`customer/<customer-slug>/onboarding/tenant-activation/<tenant>/<organization>/<tier>/activation.json`
に activation receipt が保存され、status が `active` になる。receipt には stance、tenant、
organization、tier、owner、NHI、次の行動、operation contract（task lease、heartbeat watchdog、
quota と budget、approval gate、pause と escalation、drift watcher）、各 probe の監査証跡 ref が記録される。

#### probe を実行して証跡を作る

4 つの probe は `probe` サブコマンドがまとめて実行し、activation receipt の隣
（`.../tenant-activation/<tenant>/<organization>/<tier>/probes/`）に証跡 JSON を書き出す。
全項目が通ると、その証跡を参照する `activate` コマンドがそのまま表示される（`<human:owner>` を
承認者に置き換えて実行する）。probe は観測するだけで、activation も NHI の発行も行わない。

```bash
pnpm tenant:activation probe --customer-slug <customer-slug> --tenant-slug <tenant-slug> \
  --organization-id <organization-id> --nhi-id kyberion://agent/<organization-id>/<agent-slug> \
  [--service <service-id>]...
```

| probe               | probe が確かめること                                                                                                              |
| ------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| `isolation_probe`   | tenant が strict isolation を宣言し、`check:tenant-registry` が通る                                                               |
| `viewer_scope`      | tenant が登録済み・active で viewer の絞り込みが解決でき、`KYBERION_VIEWER_SCOPE` が `off` でない（`enforce` で拒否まで行う）     |
| `service_readiness` | binding の `default_service_ids` と `--service` の各サービスが `service:preflight` で ready（無ければ「外部サービスなし」で通る） |
| `nhi_provisioned`   | 各 `--nhi-id` が NHI ledger にあり、retired / suspended でない                                                                    |

`activate` / `plan` は ref を次の規則で検証する。

- `<scheme>://...`（`audit://`、`probe://` など）は外部の証跡として、受け入れる人間の責任で扱う。
- それ以外はリポジトリ内の実在ファイルでなければならない。probe の証跡 JSON の場合は、同じ scope で
  記録され、その probe が `passed: true` でなければならない。
- `--nhi-id` は `kyberion://agent/<organization-id>/<agent-slug>` の形式で、この組織のものでなければならない。

**NHI について**: `onboard company` は、宣言した AI worker（`ceo-operator`）の NHI
`kyberion://agent/<organization-id>/ceo-operator` を責任者付きで ledger に発行する（結果の
`workerNhiId`）。そのため新しい組織でもそのまま `--nhi-id` に指定すれば `nhi_provisioned` が通る。
個別コマンドで登録したルート 3 では、同じ組織で mission が staffing した NHI を指定するか、外部の
証跡（`--probe-ref nhi_provisioned=audit://...`）を人間が確認して受け入れる。

`plan` の `blockers` が空になるまで `activate` しない。

### Step 7.1: 設定変更と外部入口の追加

オンボーディング後の service binding、surface、channel、MCP grant、quota、egress の変更も、
JSON を直接編集せず `config-mission` の scoped change として扱う。

```bash
pnpm config-mission create --preset <preset> --tenant <tenant> \
  --probe-ref viewer_scope=<audit-ref> \
  --probe-ref service_readiness=<audit-ref>
pnpm config-mission request-approval --tenant <tenant> --id <cfg-id>
pnpm config-mission apply --tenant <tenant> --id <cfg-id>
```

`brief.json` の `change` は target scope、risk、desired fingerprint、probe refs、approval ref を
保持する。system scope の surface 公開、外部 egress、credential、cross-tenant binding は、
人間の承認と payload hash の一致がなければ apply できない。apply 後は reconcile と receipt を
確認する。失敗したら同じ change を無変更で再実行せず、recovery や rollback point を確認してから再開する。

### Step 8: first-work を洗い出し、レビュー後に実行する（C）

```bash
pnpm onboarding:context first-work \
  --customer-slug <customer-slug> \
  --intent "<最初の依頼>" \
  --dry-run --json
```

分類結果を確認する。

- `solution_project`: Project bootstrap を提案する
- `service_operation` / `routine_operation` / `incident_response` /
  `governance_cadence` / `improvement_experiment`: organization operating model の対応する
  管理単位へ接続する
- 未確定、低 confidence、approval が必要: 実行せず、人間の判断を求める

分類を上書きするフラグは無い。`next_action` が `request_human_confirmation` のままなら、成果物と
管理単位が分かる言い回しに `--intent` を直して dry-run をやり直す（例: 「手順書を整備する」は
`routine_operation` と推定されるが、「新しい顧客オンボーディングポータルを作る」は
`solution_project` / `bootstrap_project` になる）。

activation が `active` でない場合、first-work の apply は fail-closed で拒否される。
レビューして受け入れた後にだけ apply する。

```bash
pnpm onboarding:context first-work \
  --customer-slug <customer-slug> \
  --intent "<最初の依頼>" \
  --apply --accept
```

`solution_project` の場合は Project bootstrap の情報も明示する。

```bash
pnpm onboarding:context first-work \
  --customer-slug <customer-slug> \
  --intent "<最初の依頼>" \
  --apply --accept \
  --bootstrap-project \
  --project-id PRJ-<UPPER_SNAKE_OR_DASH_ID> \
  --project-name "<project-name>" \
  --project-summary "<project-summary>"
```

mission に昇格する仕事は、作成と開始を分けて governed mission controller を使う。
開始前に scope、budget、success condition、外部副作用の approval boundary を再確認する。

```bash
pnpm mission create <mission-id> \
  --tier confidential \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id> \
  --goal "<最初の依頼>" \
  --success-condition "<受け入れ条件>"
pnpm mission start <mission-id>
```

契約、支払い、外部公開、credential や権限の変更は、first-work review の後も人間の承認なしに確定しない。

### Step 9: 完了を確認する（D）

```bash
pnpm pipeline vital-check
pnpm pipeline --input pipelines/baseline-check.json
```

baseline が `all_clear` になれば完了である。`needs_attention` が残る場合は Step 0 の表で
失敗層を確認し、Step 4 の対処を行う。

### Step 10: 組織の運営を始める（E）

activation 後の組織は、目的・サービス・定常業務・定例・意思決定を `pnpm organization` の
governed facade で登録して回す。状態ファイル（`active/organizations/`）は直接編集しない。
書き込み系は `--dry-run` か `--apply` のどちらかが必須で、confidential tier では
`--tenant-slug` を明示する。全サブコマンドは `pnpm organization help` で確認できる
（引数なしの `pnpm organization` は運営モデルのカタログ JSON を出す）。

```bash
export KYBERION_PERSONA=sovereign   # organization の書き込みに必要（操作シェルの前提を参照）
O="--organization-id <organization-id> --tier confidential --tenant-slug <tenant-slug>"

# 1. 現状を見る（未登録の項目と次の行動が出る）
pnpm organization status $O

# 2. 目的と目標
pnpm organization purpose set $O --name "<組織名>" --purpose "<存在目的>" --owner-role ceo --apply
pnpm organization objective add $O --objective-id <obj-id> --title "<目標>" --horizon 2026Q4 --owner-role ceo --apply

# 3. 提供するサービス（domain → service の順。`onboard company` は org-chart の domain を登録済み）
pnpm organization domain add $O --domain-id <domain-id> --name "<領域名>" --owner-role <role> --apply
pnpm organization service add $O --service-id <svc-id> --domain-id <domain-id> --name "<サービス名>" \
  --outcome "<顧客成果>" --owner-role <role> --consumer <consumer> --apply

# 4. 定例と意思決定（decision は既存の cadence に属し、proposed から始まる）
pnpm organization cadence add $O --cadence-id weekly-review --name "週次レビュー" --cadence-type weekly \
  --schedule "Mon 09:00 JST" --owner-role ceo --apply
pnpm organization decision add $O --decision-id <dec-id> --cadence-id weekly-review --title "<論点>" \
  --decision-owner ceo --due-at <ISO8601> --option "<案A>" --option "<案B>" --apply

# 5. 定常業務（自動実行できるのは pipelines/ の governed pipeline だけ。
#    runbook 型は --execution-ref に operation scope 内の実在パスが必要）
pnpm organization operation add $O --operation-id <op-id> --name "<業務名>" --operation-type scheduled \
  --owner-role <role> --trigger-kind schedule --trigger-expression "0 8 * * *" --timezone Asia/Tokyo \
  --execution-kind pipeline --execution-ref pipelines/vital-check.json --record-status active --apply
```

定常業務の実行は、scope を選んでから行う（tick / execute は dry-run でも scope 選択を要求する）。

```bash
pnpm scope use --tier confidential --tenant <tenant-slug> --organization <organization-id>
pnpm organization operation run execute $O --operation-id <op-id> --run-id <op-id>-<YYYYMMDD> --apply
pnpm organization operation tick $O --apply   # 期限の来た業務を 1 回ずつ実行し、中断した run を blocked に回収する
pnpm organization operation run list $O --operation-id <op-id>
```

意思決定は `decision transition` で `proposed → pending_approval → approved → implemented` と進める。
承認には `--rationale` と `--approval-ref <channel:id>` が要る。サービスの稼働状態は
`organization service state set` で観測値として記録し、`status` が「Unobserved services」を
出さなくなるまで埋める。運営の定期確認は `pnpm organization status $O` と
`pnpm organization reconcile $O --dry-run` で行う。

### Step 11: 目標から作業へ（E）

組織の目標（objective）を測れる形にし、その目標のための仕事を project → mission → task / work item
の順に流す。各要素がどこにぶら下がるかは次のとおりである。

```text
organization ─ purpose ─ objective ─ key result（計測できる指標）
     │
     ├─ project（organization_id で組織に属し、objective_ids で目標を指す）
     │     ├─ mission（--project-id でプロジェクトに属する）── task（NEXT_TASKS.json）
     │     └─ work item（project の backlog。project-next-tasks で mission の task に取り込む）
     └─ dot（常駐エージェント。goal_ref で objective を指し、KR を自動で計測・改善提案する）
```

目標と作業をつなぐのは project の `objective_ids`（`--objective-ids`）である。mission と work item は
project を通して目標にたどれる。指定した objective はその組織の purpose に存在するかが検証され、
`organization status` は目標の行の下に、その目標を指す project を並べる。

```bash
export KYBERION_PERSONA=sovereign
O="--organization-id <organization-id> --tier confidential --tenant-slug <tenant-slug>"

# 1. 目標に key result（KR）を付ける。自動で計測する指標
#    （org_metric: open_incidents / overdue_operations / pending_decisions / unhealthy_services、
#     file: リポジトリ内 JSON の値、probe、signal_ratio）か、人が値を記録する manual を選ぶ。
#    形式は pnpm organization help を参照
pnpm organization objective kr add $O --objective-id <obj-id> --kr-id <kr-id> --title "<指標>" \
  --metric-json '{"source":"org_metric","metric":"open_incidents"}' --target 0 --direction decrease --apply
pnpm organization objective kr add $O --objective-id <obj-id> --kr-id <kr-id> --title "<アンケートなど>" \
  --metric-json '{"source":"manual"}' --target 40 --direction increase --apply

# 2. KR を計測し、status で目標ごとの進捗を見る（dot が無い組織でもこれで進捗が動く）。
#    Kyberion の外で測った値（manual の KR、ファイルの無い file の KR など）は record で記録する
pnpm organization objective kr measure $O --apply
pnpm organization objective kr record $O --objective-id <obj-id> --kr-id <kr-id> --value 30 --apply
pnpm organization status $O        # Objective: <目標> — 50% (kr-a 100%, kr-b 0%)

# 3. 目標のための project を作り、作業場所（project-os）を用意して active にする。
#    --objective-ids で目標を指す（後から pnpm project update PRJ-<ID> --objective-ids でも付けられる）
pnpm project create --project-id PRJ-<ID> --name "<名前>" --summary "<何をするか>" \
  --tier confidential --organization-id <organization-id> --tenant-slug <tenant-slug> \
  --objective-ids <obj-id>
pnpm project scaffold PRJ-<ID>
pnpm project update-status PRJ-<ID> --status active

# 4. project の下で mission を始める（--project-path は project から自動で決まる）。
#    業務の仕事は --mission-type を明示する（development / operations /
#    operations_report / meeting_facilitation / document_production /
#    presentation_production / video_production。省略すると開発用の 8 段階タスク
#    (code-change-aidlc) になり、文書仕事でも build・PR 前提の受入条件が付く。
#    文書・マニュアル類は document_production、スライドは presentation_production、
#    動画は video_production を選ぶ）
pnpm mission kickoff MSN-<TOPIC>-<YYYYMMDD> --tier confidential --tenant-slug <tenant-slug> \
  --organization-id <organization-id> --project-id PRJ-<ID> --mission-type operations \
  --goal "<この mission で達成すること>" --success-condition "<受け入れ条件>"

# 5. project の backlog に work item を積み、mission の task に取り込む
pnpm work create-item --item-id WI-<ID> --title "<作業>" --description "<目的と完了条件>" \
  --project-id PRJ-<ID> --organization-id <organization-id> --tenant-slug <tenant-slug> \
  --mission-id MSN-<...> --work-shape solution_project
pnpm work list-items --project-id PRJ-<ID>
pnpm work project-next-tasks --mission-id MSN-<...> --project-id PRJ-<ID> --tenant-slug <tenant-slug>          # 差分を確認
pnpm work project-next-tasks --mission-id MSN-<...> --project-id PRJ-<ID> --tenant-slug <tenant-slug> --apply  # 取り込む
```

注意点:

- `file` 型の KR は、参照する JSON ファイルが存在しないと計測できない（`measure` が警告を出し、
  その目標は「unmeasured」のままになる。KR が 1 つでも未計測なら目標全体の進捗も出ない）。
  ファイルを用意できないうちは `objective kr record` で値を記録すれば進捗が出る。
- `manual` 型の KR は `measure` では計測されない。`record` で記録した値が最新の計測値になる。
- mission は company stance の identity を要求する（`--organization-id` が `customer/<org>/` の
  stance を選ぶため）。Step 5 の後に stance で `onboarding apply` を済ませておく。
- 朝会（`pipelines/organization-standup.json`）と振り返り（`organization-retro.json`）は、
  運用・決定・目標の変化を組織ごとにまとめて `active/organizations/.../artifacts/report/` に保存する。
  動きの無い組織は出力されない。
- 目標を自動で追いかけさせたい場合は dot charter（`dots/README.md`、
  `knowledge/product/architecture/resident-dot-model.md`）で `goal.goal_ref` に objective を指定する。
  稼働中の dot は KR を定期的に計測し、改善の work item を提案する。

## 4. オンボーディング後の調整（任意）

次のものはオンボーディングの必須手順ではない。必要になったときに使う。

| 目的                                              | コマンド                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| provider 選択（browser、OCR、STT など）の調整     | `pnpm kyberion seam select list` / `explain` / `calibrate` / `rules set` |
| 外部送信の状況を見る                              | `pnpm egress:report`                                                     |
| サブエージェント定義の生成                        | `pnpm agents:generate`                                                   |
| AGY SDK の導入                                    | `pnpm agy:sdk-setup --apply`                                             |
| surface、channel、MCP grant、quota、egress の変更 | `pnpm config-mission ...`（Step 7.1）                                    |

## 5. 再開・停止・ロールバック

途中の状態は削除してやり直さず、状態を確認してから再開する。

```bash
pnpm onboarding:context show --customer-slug <customer-slug> --json
pnpm tenant:activation reconcile \
  --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> \
  --organization-id <organization-id>
pnpm tenant:activation resume ... --apply --accept
pnpm tenant:activation suspend ... --reason "<reason>" --apply --accept
pnpm tenant:activation rollback ... --reason "<reason>" --apply --accept
```

activation を suspend すると、tenant の task-scoped grant は取り消される。再開するときは
probe をやり直し、同じ activation receipt を更新する。offboarding 済みや archived の tenant では、
tenant に紐づく読み書き、memory retrieval、NHI、grant、projection が fail-closed になる。

identity をやり直す場合は `pnpm onboarding reset` を使い、生成物を手で消さない。

## 6. 完了条件

全ルート共通:

- `pnpm env:bootstrap` と `pnpm kyberion doctor` が成功している
- アクティブな profile に identity と onboarding summary が保存されている
- `pnpm pipeline vital-check` が成功し、baseline-check が `all_clear` である

ルート 2・3 ではさらに:

- tenant registry の正本が一意で `active`、`check:tenant-registry` が成功している
- customer stance、tenant、organization の binding が一致している
- activation receipt が `active` で、必須の probe すべてと人間の受け入れが記録されている
- scope chain が `tenant_slug → organization_id → project_id → mission_id → task_id` の typed context で保持されている
- first-work が dry-run でレビュー済みで、実行形と approval boundary が確定している
- 最初の外部効果が人間の承認の内側にある
- （Step 10）purpose と少なくとも一つの service / operation / cadence が登録され、
  `pnpm organization status` に次の行動が明示されている
- （Step 11）目標に計測できる KR があり、`organization status` に進捗が出ていて、
  目標を `objective_ids` で指す project が active で mission が紐付いている

## 関連文書

- [Phase Protocol: Onboarding](./phases/onboarding.md)
- [docs/QUICKSTART.md](../../../docs/QUICKSTART.md)
- [docs/INITIALIZATION.md](../../../docs/INITIALIZATION.md)
- [テナント追加手順](./tenant-onboarding-procedure.md)
- [entity-scope-hierarchy](../architecture/entity-scope-hierarchy.md)
- [stance-tenant-customer-model](../architecture/stance-tenant-customer-model.md)
- [docs/SURFACES.md](../../../docs/SURFACES.md)
- [Tenant / Organization / Onboarding / Autonomous Operations 統合計画](../../../docs/developer/improvement-plans-archive/2026-08/TENANT_ORGANIZATION_ONBOARDING_AUTONOMY_PLAN_2026-08-15.ja.md)
