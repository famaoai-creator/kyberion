---
title: 組織の自律実行・拡張境界の改善
tags: [architecture, autonomy, dot, runtime, scope, extensibility]
last_updated: 2026-10-26
status: active
---

# 組織の自律実行・拡張境界の改善

## 対象と判定

組織の親子 WorkItem、mission の学習回収、Dot、dispatch、常駐 runtime、API 型モデルを対象とした。
自律実行は、仕事の委譲だけでなく、成果物確認・独立レビュー・承認待ち・再開・学習回収まで同じ scope と証跡を保つ必要がある。
今回の修正はこの経路を接続する。認証のない provider や所属の不明な旧データを、権限緩和で実行可能にするものではない。

## 指摘と実装

| 指摘                                               | 改善                                                                                        |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| 親子の再作業回数を使い切ると進行不能になる         | exhausted rework を明示的な blocked とし、親子双方の復旧案内を保持                          |
| distill の後段失敗で学習を回収できない             | durable outbox と replay を導入し、archive 後も回収                                         |
| process ID の追加に既存分岐の編集が必要            | registry に schema を宣言し、契約に基づいて検証                                             |
| Dot 拡張の登録が分散・部分反映する                 | 型付きの原子的登録境界へ集約                                                                |
| Dot 通知・handoff・状態が tier を保持しない        | tier・tenant・組織・project・personal owner を照合し、private 本文と全体制御 index を分離   |
| 個人 Dot の再読込・KR 更新で owner が欠落          | owner の検証と scoped な状態保存を統一                                                      |
| dispatch が profile・task・lease を失う            | A2A と supervisor に契約を伝搬し、現在の claim holder と各ツール実行時に照合                |
| API delegate が text のみで作業できない            | 共通の型付き task tool loop と function calling adapter を提供                              |
| CLI の native 機能や既存 MCP が scope を迂回し得る | host の制約機能を確認し、継承した MCP・hooks を封じた構成を検証。未対応 host は開始前に拒否 |
| モデルの完了宣言が成果物の完成と一致しない         | 宣言された成果物の read-back・hash・現在 lease の evidence を完了条件にする                 |
| 承認待ちを失敗として再試行・能力昇格する           | pending を独立状態として保存し、元の承認・仕事契約から再開                                  |
| MCP から lifecycle を完結できない                  | owner に限定した evidence／review／verify／distill／finish facade と状態固定の承認を追加    |
| Dot が呼出元 mission/task を誤継承する             | 非同期 execution scope で identity を明示的にマスク                                         |
| ビルド中に daemon が更新途中の module を読む       | compiler lock 下で sweep し、更新中は trigger を消費せず defer                              |
| distill の nullable optional 出力で失敗を繰り返す  | null を未指定として受理し、不完全な lesson 自体は拒否                                       |

## 拡張性

ログから判明した ops-alert 保存と学習登録の権限エラーも修正した。
固定された保存先だけを扱う alert store と、boolean のみ返す tenant registry 読取口を使い、呼出元全体の権限を広げない。

process は registry/schema、Dot は typed extension registration、モデルは adapter bridge、作業能力は task tool runtime、pipeline は登録した typed executor を拡張点とする。
新規機能を追加する際、既存の dispatch 分岐に provider ごとの例外を増やさない。
ただし、権限を持つ新規 tool・新規 provider protocol・保存領域の追加には、その境界実装と登録・検証が必要である。
「全機能が設定だけで追加可能」という意味での無制限な拡張性は採用しない。

## 運用上の境界

過去ログから provider の未認証、workspace trust 不足、別 provider 用 model ID の混入、compiler 更新との競合、distill の出力形式不一致を確認した。
秘密や private 本文は本レポートへ転記していない。
認証・trust は正規手順で operator が設定する。履歴 scope が不明な旧状態は、確認付き migration を使用する。
常駐 process はビルド成果物を自動的に読み直さないため、稼働中の仕事を確認したうえで管理された再起動が必要となる。

手順と回帰条件は [scoped-runtime-task-tools](../../../knowledge/product/orchestration/scoped-runtime-task-tools.md) と
[operations-hygiene-runbook](../../../knowledge/product/governance/operations-hygiene-runbook.md) に記録する。

## 初期改修時の検証

- package / repository の build と typecheck が成功。
- 変更対象48ファイル・870テストが `KYBERION_TEST_LEAK_STRICT=1` で成功。ライブ状態への書込みなし。
- 最終UXレビューで長いscopeの省略を修正し、追加の回帰1件を含むCLI全12テストが成功（検証対象計871件）。
- `check -- --changed` の76ゲートが成功。規約のbaselineは緩和していない。
- 実際のWorkItem、NEXT_TASKS、mission用Git、controllerを通し、ファイル読取から成果物作成・ソース編集・実pipeline実行・証跡登録までを検証。モデル応答にはテストbackendを使用。
- 独立レビューの最終差分に追加の必須指摘なし。
- supervisorを更新すると、旧processが30秒ごとに記録していたtenant境界違反が停止。検証後に最新版を復帰し、agent数0・busy数0を確認。

実環境baselineは `needs_attention / L10` が残る。prodのscheduler heartbeatが古く、有効29ジョブのうち20ジョブが過去24時間に実行予定だったが実行記録がない。失敗済みジョブは0件。
一方、グローバルのChronos daemonは別のforcheck checkoutで稼働している。
正規installのpreviewで、同じ `com.kyberion.chronos` LaunchAgentをprodへ向ける変更になることを確認した。
この切替は別checkoutの定期実行を置き換え、設定済みジョブを動かすため、未適用の運用判断として残す。認証・trust・履歴tier不明の旧状態も自動承認していない。

### 追補: scheduler同居対応

後続の `MSN-SCHEDULER-INSTANCES-20261026` で、scheduler管理をcanonical checkout単位の登録へ変更した。
現在のinstall既定動作はinstance別のservice/log/rootを使うため、既存forcheckのglobal登録を残してprodを追加できる。
従来global登録の操作には `--legacy-global` が必要。上記のglobal置換previewは変更前の記録であり、現在のinstall既定動作を表さない。
OS登録はまだ適用していない。適用前のジョブ分担と移行手順は
[複数instanceのscheduler運用](../../../knowledge/product/orchestration/multi-instance-scheduler.md) を参照。

### PR前の実行検証で追加した修正

- 同じ agent ID の起動待ち・停止待ちを世代ごとに管理し、別 task/lease の呼出しが先行 runtime を共有する競合を拒否する。古い handle から新しい runtime を停止できない。
- Codex app-server の stdout callback は起動時の非同期 context を保持するため、ask 開始時の context を保存して native tool 実行時に復元する。完了検証も同じ task context 内で行う。boot と ask の scope が異なる AsyncResource 回帰を含む5ファイル99テストが成功。
- standalone worktree の本人設定確認は、同じ Git common directory にある正本の固定3ファイルの存在だけを照会する。内容のコピーや worker の読取権限追加は行わない。13テストと、worktreeでの実際の公開mission kickoffが成功。
- 独立した2つの実 Chronos processで公開ダミーjobを実行し、一方を停止した後も他方が翌周期に成功した。receipt数は停止側1件・継続側2件で、停止側のlastRunは変化しなかった。OS service登録や外部通知は行っていない。
- prewarm成功後に結果schemaが選択情報を拒否し、親が結果を待ち続ける不具合を修正した。選択schemaを共通化し、子の起動・検証失敗も終端結果として保存する。関連52テストと共有writerの20テストが成功。
- A2Aのstrict型にlease・tool profile・選択情報を追加し、実際のdispatch payloadを正規validatorで検証する。public shared taskへ架空のdefault tenantを付与せず、tenantなしはpublicだけに限定する。関連77テストと実payloadの2ケースが成功。
- facadeと設計文書で許可された親組織なしのpublic projectを、authoritative scopeと委譲先にも保持する。別projectへの置換を拒否し、private/tenant-boundの親要件は維持する。関連63テストと実payload/lineageの2ケースが成功。

全suiteの初回実行では、変更途中のbuildと実daemonが並行したため、その結果を最終成功とは扱わない。
検出した固定store初回作成、mock export不足、新しいscope契約に未対応のfixtureを修正した。
加えてorigin/main由来のAsk入力消失を2行の修正で直し、意図されたhearing直送は維持した（250テスト成功）。
既存の認証済みgovernance-overview endpointの完全一致許可と取得失敗表示も修正した（27テスト成功）。

### 実モデルによるdispatch完了の確認

認証済みCodex CLIを実際に起動し、公開の検証専用missionを既定のdispatchからagent_runtime supervisorへ渡した。
plannerの任意ファイル読取権限は広げず、宣言済み成果物の作成、固定成果物だけの読み戻し、ハッシュ照合、controllerへの証跡登録を実行した。
WorkItemはdone、canonical taskはcompletedとなり、実行ledgerの証跡と成果物の検証markerが一致した。
task・lease・planner profileのbindingも確認し、検証runtimeは停止した。外部通知は0件。

実行中に判明したIPC応答の型不一致と終了待ち、応答受領後の誤ったlocal fallback、native model aliasとtool namespaceを修正した。
通信断で実行有無が不明な場合はclaimを保持して隔離し、人間による承認付き復旧まで再実行しない。
native code hostはI/Oを持たないVMに限定し、実バイナリでファイル・process・networkの直接利用不可と、登録したKyberion toolだけへの到達を確認した。
外部API providerへの課金を伴う実呼出しは行っていない。API側は既定execution portから実task runtimeまでを結合テストし、provider I/Oだけを代替した。

### PR公開前の統合検証

正式な全build（package・repository・両UI）とrepository/bootstrapの型検査が成功した。
固定ソースの全strict suiteは29,105件成功・23件skip・契約チェック4件失敗で、strict leak違反と未処理例外は0件だった。
4件はschema参照登録、明示的なruntime routeの期待値、条件式で選ぶ承認consumerの静的検査に対応し、対象4ファイル64件をstrict条件でまとめて再実行して全件成功した。
全suite後の変更はテストと文書だけで、本番コードは変えていない。修正後の全suite再実行は行っていない。
承認の検査ではdotと一般WorkItemの両consumerを列挙し、動的なconsumerや単なる文字列記載を許可しない回帰も追加した。
