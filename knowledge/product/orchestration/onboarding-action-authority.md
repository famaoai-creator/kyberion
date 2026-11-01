---
title: 外部操作の接続と権限委任オンボーディング
tags: [onboarding, approval, delegation, github, browser]
last_updated: 2026-11-02
kind: runbook
scope: repository
authority: reference
phase: [onboarding, execution]
---

# 外部操作の接続と権限委任

接続資格情報と操作権限は別に確認する。GitHub のログインや OAuth、ブラウザへの接続はサービスの利用準備であり、外部書き込みを一括承認するものではない。

## ブラウザから設定する

1. Concierge に本人としてログインし、設定のサービス接続で必要な認証を行う。
2. 設定の操作権限で個人、または自分が owner の登録済み組織を選ぶ。
3. 操作、GitHub repository / browser origin、有効期限を指定し、受領側の実行用 ID に権限申請を依頼する。本人が開始したことと、その ID が受領を申請したことを別々に記録する。独立した内容審査を行ったという意味ではない。
4. 表示された同じ内容を本人が passkey 等の必要な強度で承認する。CLI から作った申請もこの画面で確認できる。
5. 承認済み申請を適用する。初期状態の実行用 ID を有効化する場合、その ID も事前の説明に含まれる。停止・廃止済み ID は復活させない。
6. 取消しも対象を明示して申請・本人承認・適用する。停止操作は別の既存手続きを使う。

## CLI から申請する

```bash
pnpm onboarding authority show --scope person --json
pnpm onboarding authority preview --file <repository-local-input.json> \
  --out knowledge/personal/onboarding/reviewed-preview.json --json
# 保存された input / digest / base_hash と statement を確認する
pnpm onboarding authority request --file knowledge/personal/onboarding/reviewed-preview.json --json
pnpm onboarding authority status --scope person --request-id <id> --json
# 本人がブラウザで内容を確認して承認した後
pnpm onboarding authority apply --scope person --request-id <id> --json
```

入力例（期限は実際に希望する未来の日時へ変更する）:

```json
{
  "scope_kind": "person",
  "mode": "grant",
  "expires_at": "2026-11-01T00:00:00.000Z",
  "grants": [
    { "operation_id": "vcs:pr_create", "repository": "https://github.com/owner/repository" }
  ]
}
```

組織の場合は `scope_kind=organization` と実在する `tenant_slug` を指定し、show/status/apply にも `--scope organization --tenant <slug>` を渡す。個人利用のために架空の tenant を作らない。接続済みであっても本人の承認をエージェントが代行してはならない。

### 最初は identity の有効化だけを承認する

新規の個人設定で外部操作を常設委任しない場合は、`onboarding apply` が作る
`onboarding/activation-input.json` を使う。同じ preview → request → 人間承認 → apply の手順で進める。
再実行でも既存の入力と確認済みファイルは上書きしない。`show` で依頼を探し、pending / approved の
依頼があれば同じ ID を再開する。有効化済みの identity には新しい有効化依頼を作らない。
入力は次の形で、外部操作の grant を一つでも含めた場合は拒否する。

```json
{
  "scope_kind": "person",
  "mode": "activate",
  "expires_at": "2026-11-01T00:00:00.000Z",
  "grants": []
}
```

有効化対象は登録済みの provisioned identity に固定する。既存 charter の置き換えや更新、
suspended / retired identity の復活には使えない。個別の外部送信は依然として人間の承認が必要である。
期限が過ぎた入力を再利用せず、希望する未来の日時へ更新してから preview を取り直す。

期限切れ・廃止済み Charter がある場合は、`renew_existing: true` を明示し、表示された全ての既存権限・金額・データ・リスク制限を確認して更新する。ブラウザでは更新確認欄を選ぶ。通常の変更申請では復活させず、過去の利用額や停止条件もリセットしない。承認後に Charter の有効状態が変わった場合は再確認が必要になる。

旧履歴に複数の独立した Charter があり、会計の継承先を一意に検証できない場合は、承認申請の前に停止する。自動リセットや推測による結合は行わない。この状態を修復する専用の履歴移行 UI は本変更の対象外であり、監査可能な継続性移行を別途用意する必要がある。

## 実行と制限

委任は承認された対象・操作・期限と現在の Charter、停止状態、実行用 ID を毎回確認する。対象は repository に限定した PR 作成、branch に限定した push / merge、および限定したブラウザ移動。クリック・送信・evaluate の包括委任にはしない。元からある金額・データ・リスク制限を暗黙に引き上げない。取消しは実行中の外部要求を巻き戻さず、次の admission から効く。

PR 本文をファイルから渡す場合、実ファイルの知識/runtime partition と実行scopeの両方を照合する。公開本文の例は `active/shared/tmp/public/shared/<job>/pr-body.md`。personal は本人のperson scope、confidential は実tenantのorganization scopeとし、いずれも明示したcharterのread token、実行時のread ceiling、完全一致の `visibility: "private"` grant、実際に非公開と確認したrepositoryが必要。shared/group/system領域と分類不明のscratchは自律委任の対象にしない。本文ファイルの移動やpublicラベルで実行scopeを格下げできない。

### 開発を初回同意で委任する

VCS grantはPR作成・push・mergeの操作範囲を定める。継続した実装・修復・レビューの起動は、別途承認されたmanaged work planを既存continuous ownerへ渡す。[継続運営の設定手順](continuous-operations-playbook.md)と[実装計画](../../../docs/developer/CONTINUOUS_DEVELOPMENT_IMPLEMENTATION_PLAN_2026-11-02.ja.md)を参照する。新規plan/alignmentの本人承認、providerへの情報送信制約、secret登録・rotationの専用承認は維持する。

reasoning providerのtask credential allocationと、VCSの既存`gh`認証／登録済みtokenは別の接続である。VCSの操作委任だけで、すべてのtokenが新たにTaskCredentialBindingへ移行したとは解釈しない。tokenをplan・PR本文・checkpointへ保存しない。

設定画面の「リポジトリ開発を委任」は、PR作成・専用候補branchへのpush・統合先branchへのmergeを一つのplanにする。準備済み開発ループが対応する候補 `agent/kyberion-development` と統合先 `main` に固定し、統合先への直接pushは含まない。他のbranchを委任する場合は個別のpush / merge設定を使うが、この開発ループの対象にはならない。同意済み範囲内では操作ごとの承認を繰り返さない。

`onboarding apply` とwizardは既存の `onboarding/delegation-input.json` を案内する。grant-modeの同意は、provisioned NHIの有効化も同時に行う。外部権限を付けず有効化だけ行う場合は従来のactivation planを選べる。private repository向けのCLIテンプレートを実際のvisibility照会で生成する場合は `onboarding apply --verify-repository-visibility` を明示する。既に確認用ファイルがある場合は上書きせず、所有者が変更を確認する。

`data_tier` は省略時に既存の設定を維持する。明示する場合は `{"read":["public","personal"],"write":[]}`（person）または `confidential:<tenant_slug>`（organization）のように対象を指定する。取消しで権限を拡大できず、未知token・他tenant・個人と組織の取り違えは拒否する。readは情報を使う権限、writeは知識への書込み権限であり、VCSのpush/merge権限は別のgrantで確認する。

準備済みWorkItemの公開確認は `vcs:development_loop` が担当する。独立review receiptのmanifestにはrepository・head/base・branch・WorkItem・CI policy digestを固定する。既定はdry-run。CI待機、修復要求、review不足、merge queue、merge後CIを別の結果として返し、実装と修復は既存のmission executorへ戻す。実行用モデルや別の承認storeを新設する入口ではない。

ブラウザの origin 制限は遷移先だけでなく redirect とネットワーク要求にも適用する。既存の CDP 接続や制約のない再利用セッションを、この限定委任で自律操作してはならない。接続設定と実行準備状態は画面で別々に確認する。

委任対象の公開ページは `browser:goto` の params に `onboarding_isolated_navigation: true` を指定して隔離環境で読む。public scope、承認済み origin、登録・有効化済み実行用 ID が必要になる。JavaScript を必要とするログイン後の画面や任意の操作まで許可するものではない。契約例は [browser-actuator README](../../../libs/actuators/browser-actuator/README.md) を参照する。
