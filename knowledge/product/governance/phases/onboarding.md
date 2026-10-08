---
title: 'Phase Protocol: Onboarding'
tags: [governance, lifecycle, onboarding]
last_updated: 2026-10-08
runtime_stages: [intake, classification]
---

# Phase Protocol: ① Onboarding (Ecosystem Initialization)

## 目的

環境、identity、（必要なら）tenant と organization、実行権限を順に準備し、最初の仕事を安全に
開始できる状態へ進める。

手順の順序の正本は [オンボーディング標準フロー](../onboarding-flow.md) である。この文書は
lifecycle phase から参照する短い runbook で、各項目の番号は標準フローの Step に対応する。

## ルートを決める

| ルート              | 通る Step                                                         |
| ------------------- | ----------------------------------------------------------------- |
| 1. 個人のみ         | 0 → 1 → 2 → 3 → 4 → 9                                             |
| 2. AI 会社          | 0〜4 → 5〜8（`onboard company` で 5・6 をまとめる） → 9 → 10 → 11 |
| 3. 既存テナント追加 | 0〜11 すべて                                                      |

ルート 2 は `onboard company` の直後に company stance へ切り替え、その stance でも identity を
保存する（mission start が `customer/<slug>/my-identity.json` などを要求するため）。順序の詳細は
標準フローの「ルート 2（AI 会社）の実行順」を参照する。

## 実行順

### Step 0〜2: baseline・導入・readiness

```bash
pnpm pipeline --input pipelines/baseline-check.json
pnpm install
pnpm build
pnpm env:bootstrap --manifest kyberion-toolchain   # dist/ を使うので build の後
pnpm kyberion doctor
pnpm kyberion setup report --persona first-time-user
pnpm kyberion secret introduce <service-id> <secret-key>   # 必要な secret だけ。値は argv に載せない
pnpm surfaces reconcile
```

baseline が `needs_recovery` または `fatal_error` の場合は、通常の onboarding を始めず、
それぞれ recovery または障害修復へ分岐する。

### Step 3: stance を決めてから identity を保存する

顧客・会社として使う場合は、先に `pnpm stance:switch <customer-slug>` を実行する。
baseline の L3 はアクティブな profile の identity を見るため、順序を逆にしない。

```bash
pnpm onboarding
# または（非対話）
pnpm onboarding apply --identity <reviewed-identity-json> --dry-run
pnpm onboarding apply --identity <reviewed-identity-json>
```

オンボーディングのコマンドは persona なしで動く。`pnpm organization` の書き込み（Step 10）だけは
`export KYBERION_PERSONA=sovereign` が要る（`.env.local` は自動では読み込まれない）。

GUI では concierge（`http://127.0.0.1:3050`）の `/settings` から保存できる。メンバーと承認者も
ここで登録する。この段階では外部効果や mission を開始しない。

### Step 4: baseline を all_clear にする

baseline を再実行し、`needs_attention` が残れば失敗層を確認する。初回は L8（storage janitor）、
L10（chronos scheduler）、L11（監査台帳）が落ちやすい。対処は標準フロー Step 4 を参照する。

ルート 1 はここで Step 9 へ進む。

### Step 5〜8: tenant・binding・activation・first-work

```bash
pnpm tenant create <tenant-slug> --display-name "<Tenant name>" --assigned-role owner --apply
pnpm check -- --only tenant-registry
pnpm onboarding:context bind --customer-slug <customer-slug> --tenant-slug <tenant-slug> \
  --organization-id <organization-id> --dry-run --json
pnpm onboarding:context bind ... --apply --json
pnpm tenant:activation plan --customer-slug <customer-slug> --tenant-slug <tenant-slug> \
  --organization-id <organization-id>
pnpm tenant:activation probe --customer-slug <customer-slug> --tenant-slug <tenant-slug> \
  --organization-id <organization-id> --nhi-id kyberion://agent/<organization-id>/<agent-slug>
# 全 probe が通ると、証跡を参照する activate コマンドが表示される。<human:owner> を置き換えて実行する
pnpm tenant:activation activate ... --owner-id human:<owner> --apply --accept
pnpm onboarding:context first-work --customer-slug <customer-slug> \
  --intent "<最初の依頼>" --dry-run --json
```

tenant を登録したら、使うモデルと provider への送信許可を決める（標準フロー Step 5.1）。
どちらも dry-run が既定で、attestation は `--apply --accept` で人間が明示したときだけ記録される。

```bash
pnpm onboarding llm show --tenant <tenant-slug>   # tier ごとに使える provider を表示する
pnpm onboarding llm select --backend <mode> [--model <model-id>] --apply
pnpm onboarding llm attest --tenant <tenant-slug> --provider <id> --training-use none \
  --plan "<plan>" --basis <url|ref> --attested-by human:<owner> --apply --accept
```

attest しない限り、confidential・personal の material は local-only 以外の provider に送られない。
`tenant:activation plan` の `llm_availability` で結果を確認する。

未登録、`suspended`、`archived`、または reserved scope 名の tenant は先へ進めない。
activation receipt が `active` になるまで、first-work の apply と tenant に紐づく mission は
fail-closed で停止する。オプションの詳細は標準フロー Step 5〜8 を参照する。

### Step 10: 組織の運営（ルート 2・3）

`pnpm organization status` で現状と次の行動を確認し、purpose → domain / service →
cadence / decision → operation の順に governed facade で登録する。定常業務は
`pnpm scope use` で scope を選んでから `operation run execute` / `operation tick` で回す。
コマンド例は標準フロー Step 10 を参照する。

### Step 11: 目標から作業へ（ルート 2・3）

目標に計測できる KR を付け（`organization objective kr add`）、`organization objective kr measure`
で計測して（外で測った値は `organization objective kr record`）`organization status` で進捗を見る。
目標のための project を `--objective-ids` 付きで作り（`project create` → `scaffold` →
`update-status --status active`）、その下で `mission kickoff --project-id`（業務は
`--mission-type` を明示）、backlog は `work create-item` → `work project-next-tasks --apply` で
mission の task に取り込む。コマンド例は標準フロー Step 11 を参照する。

### Step 9: 完了確認

```bash
pnpm pipeline vital-check
pnpm pipeline --input pipelines/baseline-check.json
```

## 再開と失敗時の扱い

```bash
pnpm onboarding:context show --customer-slug <customer-slug> --json
pnpm tenant:activation reconcile --customer-slug <customer-slug> \
  --tenant-slug <tenant-slug> --organization-id <organization-id>
pnpm tenant:activation resume ... --apply --accept
```

probe をやり直さずに activation を再開しない。停止・ロールバック・offboarding は
`tenant:activation suspend|rollback` の governed command を使い、state を直接編集しない。
identity のやり直しは `pnpm onboarding reset` を使う。

## 成功条件

1. identity と onboarding summary がアクティブな profile に保存されている。
2. `pnpm pipeline vital-check` が成功し、baseline-check が `all_clear` である。
3. （ルート 2・3）tenant registry と consistency check が成功している。
4. （ルート 2・3）customer、tenant、organization の binding が一致している。
5. （ルート 2・3）activation receipt が `active` で、必須 probe と責任を持つ人間が記録されている。
6. （ルート 2・3）first-work がレビュー済みで、typed context と approval boundary が定まっている。

## 関連文書

- [オンボーディング標準フロー](../onboarding-flow.md)
- [docs/INITIALIZATION.md](../../../../docs/INITIALIZATION.md)
- [テナント追加手順](../tenant-onboarding-procedure.md)
