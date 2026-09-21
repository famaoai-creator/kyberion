---
title: オンボーディング標準フロー — 環境 / Identity / Tenant / Activation / First Work
tags: [governance, onboarding, identity, tenant, organization, activation, first-work]
last_updated: 2026-09-22
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
```

| ルート                  | 使い方                                      | 通るブロック                                    |
| ----------------------- | ------------------------------------------- | ----------------------------------------------- |
| **1. 個人のみ**         | 自分の作業を自分の identity で任せる        | A → B → D                                       |
| **2. AI 会社**          | AI workforce を主な労働力として会社を始める | A → B → C（`onboard company` で登録と結合） → D |
| **3. 既存テナント追加** | 機密境界を持つ顧客・組織の仕事を扱う        | A → B → C（個別コマンドで登録と結合） → D       |

ルート 1 は tenant を作らない。tenant に紐づく mission や first-work の apply が必要になった
時点で、ルート 3 の C に進む。ルート 2 と 3 では、activation receipt が `active` になるまで
最初の仕事を実行しない。

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
pnpm doctor
pnpm pipeline --input pipelines/verify-session.json
```

`pnpm doctor` と verify-session の first-win は [QUICKSTART](../../../docs/QUICKSTART.md) が正本である。

### Step 2: readiness を確認する（A）

surface、service、reasoning、doctor の準備状況をまとめて確認する。

```bash
pnpm kyberion setup report --persona first-time-user
```

報告に出た不足を、使う機能の分だけ埋める。

- **reasoning backend**: `pnpm reasoning:setup` で使える backend を確認して選ぶ。選んだ値は
  `.env.local` の `KYBERION_REASONING_BACKEND` に保存される。
- **外部サービス**: `pnpm services:setup` で必要な secret と接続の置き場を確認する。実行直前の
  可否は `pnpm service:preflight -- --service <service-id>` で確かめる。
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
- 顧客・会社として使う: 先に `pnpm customer:switch <customer-slug>` で stance を切り替える。保存先は
  `customer/{customer-slug}/`。ルート 2 の `pnpm onboard company` はこの overlay を作る。

identity は次のどれかで保存する。

```bash
# 対話（TTY あり）
pnpm onboard

# 非対話。まず dry-run で検証してから適用する
pnpm onboard apply --identity knowledge/public/templates/onboarding/identity.example.json --dry-run
pnpm onboard apply --identity <reviewed-identity-json>
```

GUI では concierge の `/settings` を開く（旧 `/setup` と `/onboarding` はここへリダイレクトされる）。

| セクション     | ここで決めること                                    |
| -------------- | --------------------------------------------------- |
| あなたのこと   | 名前、言語、対話スタイル、vision（identity の保存） |
| 組織とメンバー | メンバーと承認者、責任を持つ agent                  |
| サービス連携   | 外部サービスの接続                                  |
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
  daemon を常駐させる。macOS では `pnpm kyberion chronos install` で内容を確認し、`--apply` で
  LaunchAgent に登録する。その場で動かすだけなら `pnpm chronos`。
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

registry が `active` でない tenant、未登録の tenant、tier 名と衝突する tenant は、後続の
binding と activation に進めない。customer stance を切り替えても registry の正本は変わらない。

ルート 2 では、Step 5 と Step 6 を次の governed facade でまとめて行える。dry-run で書き込み範囲を
確認してから、`--dry-run` を外して適用する。

```bash
pnpm onboard company --vertical saas-product-company --slug <company-slug> \
  --name "<会社名>" --owner-id human:<owner> \
  --goal "<最初に達成する顧客成果>" \
  --tenant-slug <tenant-slug> --dry-run
```

適用後は `customer/<company-slug>/onboarding/ai-company-readiness.json` と `first-work-plan.md` を
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
  --project-id <project-id> \
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

## 4. オンボーディング後の調整（任意）

次のものはオンボーディングの必須手順ではない。必要になったときに使う。

| 目的                                              | コマンド                                                                 |
| ------------------------------------------------- | ------------------------------------------------------------------------ |
| provider 選択（browser、OCR、STT など）の調整     | `pnpm kyberion seam select list` / `explain` / `calibrate` / `rules set` |
| 外部送信の状況を見る                              | `pnpm egress:report`                                                     |
| サブエージェント定義の生成                        | `pnpm agents:generate`                                                   |
| AGY SDK の導入                                    | `pnpm agy:sdk:setup --apply`                                             |
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

identity をやり直す場合は `pnpm onboard reset` を使い、生成物を手で消さない。

## 6. 完了条件

全ルート共通:

- `pnpm env:bootstrap` と `pnpm doctor` が成功している
- アクティブな profile に identity と onboarding summary が保存されている
- `pnpm pipeline vital-check` が成功し、baseline-check が `all_clear` である

ルート 2・3 ではさらに:

- tenant registry の正本が一意で `active`、`check:tenant-registry` が成功している
- customer stance、tenant、organization の binding が一致している
- activation receipt が `active` で、必須の probe すべてと人間の受け入れが記録されている
- scope chain が `tenant_slug → organization_id → project_id → mission_id → task_id` の typed context で保持されている
- first-work が dry-run でレビュー済みで、実行形と approval boundary が確定している
- 最初の外部効果が人間の承認の内側にある

## 関連文書

- [Phase Protocol: Onboarding](./phases/onboarding.md)
- [docs/QUICKSTART.md](../../../docs/QUICKSTART.md)
- [docs/INITIALIZATION.md](../../../docs/INITIALIZATION.md)
- [テナント追加手順](./tenant-onboarding-procedure.md)
- [entity-scope-hierarchy](../architecture/entity-scope-hierarchy.md)
- [stance-tenant-customer-model](../architecture/stance-tenant-customer-model.md)
- [docs/SURFACES.md](../../../docs/SURFACES.md)
- [Tenant / Organization / Onboarding / Autonomous Operations 統合計画](../../../docs/developer/improvement-plans-archive/2026-08/TENANT_ORGANIZATION_ONBOARDING_AUTONOMY_PLAN_2026-08-15.ja.md)
