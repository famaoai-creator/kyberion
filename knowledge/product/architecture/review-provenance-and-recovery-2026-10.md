---
title: レビュー証跡・抽出方法の明示とプロセス復旧検証
tags: [mission, review, provenance, recovery, distillation, ux]
last_updated: 2026-10-28
status: implemented
runtime_stages: [execution, review]
---

# レビュー証跡・抽出方法の明示とプロセス復旧検証

[Hermes追加採用](hermes-additional-adoption-implementation-2026-10.md)の運用上の制約から、次の3点を改善する。

## レビュー対象の作成者

`record-evidence` は対象タスクの作成者を既存のexecution ledgerに記録する。
実行中の有効なclaimに束縛された `taskBinding` があれば、そのactorを使用できる。
明示したactorとの矛盾や期限切れ・他scopeのclaimは既存fenceで拒否する。

ファイルが存在するだけでは、別タスクの作成者は分からない。
レビュー対象タスクをcascadeで完了するには、そのタスク自身のactor付き証跡が必要になる。
作成者が不明な過去の成果物には、実際の作成者で対象タスクの `record-evidence` を実行し、別agentの `review-task` を再実行するよう案内する。
dispatcher・observer・reviewerのイベントから作成者を推測しない。
既に実施したレビューを登録する `review-task` は推論backendの起動・認証probeを必要としない。モデルによるレビュー実行とは区別する。

これは既存のdirect-workによる作成者申告であり、外部の人の身元を新たに認証する仕組みではない。
同じactorによる自己レビューの拒否と、現在の成果物hashへのレビュー束縛は維持する。

## 学習抽出とレビューを分けて表示する

既存のmission distillation receiptに、`mode`、`llm_used`、構造抽出時の `structural_reason` を保持する。
理由は `stub_requested` または `llm_unavailable` の分類だけを保存し、providerの生エラーや認証情報を表示しない。
stateのschemaは矛盾した組み合わせを拒否する。

CLIの完了・再実行表示、抽出Markdown、history、ledger、TUIのmission詳細、Chronosのmission履歴で抽出方法を確認できる。
構造抽出はLLM抽出と表示せず、LLM抽出であっても独立レビューや承認を済ませたことにはならない。
古いreceiptで抽出方法が不明な場合は「未確認」、receipt自体がなければ「記録なし」とする。
表示は既存のviewer/scope経路を使用し、権限を追加しない。

## 別プロセスによる復旧replay

`libs/core/harnessing/runtime-recovery-replay.test.ts` は、永続境界を保存した子プロセスをSIGKILLで終了し、新しいNodeプロセスで実storeを読む。
既存の `eval/runtime-replay/probe.json` から、このbatteryも実行する。

- OAuth: callback claimを取得した直後と完了receipt保存後。再起動で二度目のclaimを許さず、処理中状態の失効と他principalからの不可視性を確認する。
- Plugin: prepared journalと旧tree移動済みの境界を合成し、実際のlock/recoveryを2回実行して旧bytesを保持する。
- Compaction: 実artifactとworker journalのcommit後。別プロセスで2回復元し、同じ履歴・世代、期限切れ拒否、journalへの追記がないことを確認する。

pluginの中断位置は合成fixtureであり、全実行命令位置でのfault injectionではない。
OAuthのclaim seam検証は、外部token endpointに対する一般的なexactly-once保証ではない。
履歴の復元検証はstoreの境界であり、全daemonの再起動や外部サービスとの通信断を網羅しない。
実OAuth、実provider、画面の目視確認は別途の検証になる。

## 承認保存APIのrole型

Chronos単独の型検査で見つかった `chronos_localadmin` の不整合は、承認保存API専用の `ApprovalStoreRole` で扱う。
このidentityには既存policyがchannelの読み書きを許可している。別のidentityへの置き換えや型castで隠さず、承認保存とそのhelperだけに正しい型を渡す。
汎用artifact writerのrole一覧やsurfaceのrole設定schemaは拡張せず、認証・人による決定・channel・tenantの既存チェックも維持する。
