---
title: 外部操作の接続と権限委任オンボーディング
tags: [onboarding, approval, delegation, github, browser]
last_updated: 2026-10-21
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
pnpm onboarding authority preview --file <repository-local-input.json> --json
# preview の input / digest / base_hash をそのまま reviewed ファイルへ保存する
pnpm onboarding authority request --file <reviewed-preview.json> --json
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

期限切れ・廃止済み Charter がある場合は、`renew_existing: true` を明示し、表示された全ての既存権限・金額・データ・リスク制限を確認して更新する。ブラウザでは更新確認欄を選ぶ。通常の変更申請では復活させず、過去の利用額や停止条件もリセットしない。承認後に Charter の有効状態が変わった場合は再確認が必要になる。

## 実行と制限

委任は承認された対象・操作・期限と現在の Charter、停止状態、実行用 ID を毎回確認する。現在の対象は PR 作成と限定したブラウザ移動であり、任意の GitHub 更新やクリック・送信・evaluate の包括委任ではない。元からある金額・データ・リスク制限を引き上げない。取消しは実行中の外部要求を巻き戻さず、次の admission から効く。

PR 本文をファイルから渡す場合、public と明示された知識または runtime partition に置いたものだけが自律委任の対象となる。例: `active/shared/tmp/public/shared/<job>/pr-body.md`。個人・機密データや、分類不明の scratch ファイルは個別承認を必要とする。本文ファイルを移動するだけで公開可と判断せず、内容の公開可否を確認する。

ブラウザの origin 制限は遷移先だけでなく redirect とネットワーク要求にも適用する。既存の CDP 接続や制約のない再利用セッションを、この限定委任で自律操作してはならない。接続設定と実行準備状態は画面で別々に確認する。

委任対象の公開ページは `browser:goto` の params に `onboarding_isolated_navigation: true` を指定して隔離環境で読む。public scope、承認済み origin、登録・有効化済み実行用 ID が必要になる。JavaScript を必要とするログイン後の画面や任意の操作まで許可するものではない。契約例は [browser-actuator README](../../../libs/actuators/browser-actuator/README.md) を参照する。
