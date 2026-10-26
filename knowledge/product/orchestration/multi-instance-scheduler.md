---
title: 複数checkoutのscheduler運用
tags: [scheduler, chronos, instances, deployment, operations]
last_updated: 2026-10-26
runtime_stages: [preflight, execution, review]
---

# 複数checkoutのschedulerを同居させる

各checkoutで正規のscheduler管理コマンドを実行する。サービスIDとログ名は
canonicalな物理rootのhashで分離される。同じrootへのsymlink別名は同じinstanceになる。
起動unitの `KYBERION_ROOT` もそのrootに固定するため、サービスマネージャから
継承した環境変数によって別checkoutへ状態を書き込まない。

2つ目を適用する前に、後述の外部ジョブの所有者・schedule allowlistを決める。
分担が未設定の間はpreviewに留め、同じ外部更新を複数instanceから開始しない。

```bash
# 各checkoutで、対象instance/rootと生成unitを確認
pnpm kyberion scheduler install
# そのinstanceのみを登録（OS設定を変更し、設定済みジョブの実行を開始する）
pnpm kyberion scheduler install --apply
pnpm kyberion scheduler status
# 対象instanceだけを操作。--applyがなければpreview
pnpm kyberion scheduler restart --apply
pnpm kyberion scheduler stop --apply
pnpm kyberion scheduler start --apply
pnpm kyberion scheduler uninstall --apply
```

launchdのlabel/plist、systemd userのservice/timer、Windows Task Schedulerのtaskを
instance単位にする。heartbeat、schedule registry、leader lease、実行claim、配送queueは
既存のcheckout配下の保存先を使い、別のinstance storeは追加しない。

## 既存のglobal登録

旧 `com.kyberion.chronos` などの登録は、自動移行・削除・上書きをしない。
旧登録を操作するときだけ `--legacy-global` を明示する。

```bash
pnpm kyberion scheduler status --legacy-global
pnpm kyberion scheduler uninstall --legacy-global
```

移行時は、旧serviceがどのcheckoutを動かしているかを確認する。
新instanceのpreviewとジョブ分担を確認してから登録し、対象rootのheartbeatと
実行記録を検証する。旧global登録の停止・削除は、その所有者を確認して別途行う。
同一rootでの並行tickは既存leader leaseと実行claimで保護するが、不要な二重登録を
恒常運用には使わない。

## 外部ジョブの分担

別rootのschedulerは独立している。同じ通知や外部更新ジョブを両方で有効にすると、
両方から実行され得る。同居対応は、rootをまたいだ外部効果の一回性を意味しない。

`KYBERION_CHRONOS_SCHEDULES` にplainなschedule IDをカンマ区切りで設定し、
`--forward-env KYBERION_CHRONOS_SCHEDULES` でそのinstanceへ渡す。
plain IDは実行対象を限定する。`+ID` は追加opt-inなので、ジョブ分担には使わない。
通知・外部更新は原則1instanceに割り当て、もう一方は内部検証用などに限定する。
rootの移動・renameは別instance IDになるため、旧登録を確認して移行する。
