---
title: '来歴・実行認可・記憶・回復性の実装と検証'
tags: [security, provenance, authorization, memory, verification]
last_updated: 2026-10-25
---

# 来歴・実行認可・記憶・回復性の実装と検証

対象は合意した6件。来歴、機密性、根拠としての有効性、実行権限を別々に扱い、
履歴・モデルの自信・タスク成功だけでは操作を許可しない。

## 実装と観測する効果

| 項目                      | 実装                                                                               | 検証する振る舞い                                                                                                  |
| ------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| 1. 承認と操作・仕様の拘束 | external-operation / operation-protection / external-operation-proof               | 引数・schema・候補集合・承認・charterの変更をcommitで拒否。未変更の正規操作は成功                                 |
| 2. 同一出典の重複抑止     | memory-provenance / knowledge-index / distill-knowledge-injector / promoted-memory | 1出典の派生が検索枠を占有せず、独立した裏付けを残す。URL・traceも出典単位で扱う                                   |
| 3. 派生先までの失効       | 保護されたtenant/owner別の来歴状態、世代と内容hash                                 | 古いdescriptor・キャッシュ・変更したmission/task/projectでも失効を回避できない。過去の広いscopeは再認可にならない |
| 4. 引数単位の出所         | hostのみが設定できる引数証拠、重要引数の対応表                                     | 外部由来・不明な重要引数はexact consentが必要。失効した出典では実行しない                                         |
| 5. 完了と委任遵守の別評価 | scenario authorization contract / report / trajectory / CLI gate                   | 完了・越権の4通りを区別。不完全な観測はindeterminate。宣言した契約の未完了や越権をCLI成功にしない                 |
| 6. 校正と回復可能性       | repair-assurance / advisory-only ADF repair / host commit                          | 定数判定器や誤承認を拒否。失敗した自分の変更は保存バイトへ復元。他者の新しい編集は上書きしない                    |

実行時の契約と制限は
[provenance-authorization-controls](../../knowledge/product/governance/provenance-authorization-controls.md)
に記載した。

## 検証方法

- 実ファイル、secure-io、実際の権限チェックと来歴ストアを使う。
- 外部transportはfake SDK／spyを使い、拒否時に実行関数が呼ばれないことを確認する。
- MCPは実adapterの接続・tools/list・schema照合・認可・callTool・closeの順序を検証する。
- 修復は実pipeline schemaとguardrailsの制御例でも校正し、読み取り専用候補生成とhost確定を通す。
- 正常系、攻撃相当の改変、失効、並行更新、旧形式との互換性をまとめて検証する。
- `KYBERION_TEST_LEAK_STRICT=1`で実データ領域へのテスト書き込みを失敗として扱う。

代表的な統合ケースは`tests/provenance-authorization.integration.test.ts`。
同一出典の原本＋20派生と独立出典1件の22候補から、2出典を選択する。
その後、元出典を失効すると、再indexせず同じキャッシュから独立出典1件だけを返す。

一括回帰の再現コマンド:

```sh
CI=true KYBERION_TEST_LEAK_STRICT=1 pnpm exec vitest run \
  libs/core/governance libs/core/knowledge libs/core/pipeline \
  libs/core/scenario libs/core/service \
  libs/core/lifecycle-hook-engine.test.ts \
  libs/core/plugin/plugin-managed-install.test.ts \
  libs/core/integrations/email-external-governance.test.ts \
  libs/core/promoted-memory.test.ts libs/core/promoted-memory-scope.test.ts \
  libs/core/autonomous-repair.test.ts \
  libs/core/organization/tenant-knowledge-retrieval.test.ts \
  libs/actuators/service-actuator/src \
  scripts/pipeline-execution-approval.test.ts scripts/scenario_runner.test.ts \
  tests/provenance-authorization.integration.test.ts --maxWorkers 2
```

## 検証履歴

初回の一括回帰は201スイート・2,315件中2,303件成功、12件失敗。
旧fixtureの不完全な承認証拠、tenant未指定の旧形式知識、長いロック名が原因だった。
失敗した知識公開テストが残した4件の合成成果物も確認し、個別に削除した。
保護を緩めずfixture・旧形式の明示的扱い・後片付け・長いファイル名の処理を修正した。
構造整理前の一括回帰は201ファイル・2,316件が全て成功。
ビルドと並行した最初の再実行ではcompiler lockの生成を検出したため、
ビルド完了後に単独で再実行し、書き込み監視の警告が出ないことも確認した。
構造整理後はlifecycle／pluginの関連テストも加え、最終203ファイル・2,367件が全て成功（失敗0）。
最終実行でも書き込み監視の警告はなかった。

追加の焦点検証として、lock／secure-ioの5スイート・149件と、
権限・scopeの12スイート・200件が成功した。重複するテストを合算した数字ではない。
`CI=true pnpm build`はpackages・scripts・両UI・source shadow検査まで成功。
変更したTypeScript全件のESLintと`git diff --check`も成功した。
構造整理後の`CI=true pnpm typecheck`も成功した。
ビルド中の一時的なdist削除と並行した型検査は失敗したため、ビルド完了後に順序を分けて再検査した。
最後の共通JSON保存APIへの統一後はpackagesを再ビルドし、関連63件と203ファイル・2,367件の回帰を再実行して成功した。

観測した効果は次のとおり。

- 22候補を独立した2出典にまとめ、失効後は同じキャッシュから1出典だけを返した。
- 正規の未変更操作は実行し、引数・interface・出典失効の改変時は実行関数を呼ばなかった。
- 完了と越権を別に記録し、未完了・越権・観測不足を契約成功として扱わなかった。
- 定数検証器を拒否し、失敗した自分の変更のみ元バイトへ復元した。他者の新しい編集は保持した。

標準gateで検出したテストの内部参照登録漏れと、利用開始後の不要なorphan登録を修正した。
認可・MCP連携に伴う依存拡大は、承認要求の作成と決定・実行の依存を分離して解消した。
公開API・保存内容・監査イベントを維持し、最大runtime SCCは32（既存上限33）に収まる。
検査の閾値やbaselineは緩和していない。
来歴ストアのJSON保存は既存の共通`writeJson`に統一し、権限・lock・原子的な保存を維持した。

最終の`CI=true pnpm check -- --changed --base 508096860 --jobs 2`は74 gate全件成功（失敗0）。
PR標準gate一式と、変更パスに対応するfull-scopeの24 gateを含む。
生成物は`CI=true pnpm kyberion resolve generated --no-stage`の12工程が成功し、driftは残っていない。
これはローカル検証結果であり、リモートCI・実サービスへの本番反映は行っていない。

## origin/main取り込み後の確認

`origin/main`の`6a353bc8a`を専用ブランチへ競合なくマージした。
重複した承認ストア・実行認可・pipeline制御の3ファイルは独立した静的レビューでもmust_fixなし。
承認要求の`source.actionId`、private repositoryの委任、reminder dispatchと既存の実行直前の保護を維持した。

- 固定lockfileでworkspaceの公開APIを同期した。
- 全体ビルドと型検査が成功した。
- 上流のNHI admission・charter・action supersessionも含む207ファイル・2,391テストが成功した。
- `CI=true pnpm check -- --changed --base origin/main --jobs 2`は79 gate全件成功（失敗0）。
- canonical generatorの12工程が成功し、生成物のdriftと未解決競合はない。

## PRで検出した一時名の指摘

PR #1253のCodeQL集約チェックは、長い一時ファイル名を短縮するための
`SHA-256(basename)`をパスワード用hashとして検出した。
一時名は対象パスからの導出が不要なので、暗号学的なUUIDへ置き換えた。
既存のlock identity、検査済みディレクトリ、排他的open、原子的な置換と後片付けは維持する。

clockと弱いrandom suffixを固定しても一時名を再利用しない実ファイル回帰を追加し、
secure-io／lockの5ファイル・137テスト、変更TSのESLintが成功した。
独立レビューのmust_fixはない。ローカルCodeQL CLIは未導入のため、
新しいコミットのGitHub CodeQL結果で指摘の解消を確認する。

## 全体CIで見つけた回帰への対応

対象を広げた初回CIでは、上記のHigh指摘に加え、ローカルの最初の対象外だった
直接API・fixture・層の検査で失敗した。保護を解除せず、以下を修正した。

- network／deployment／voice／mediaの直接APIも、実際のmanifestとschemaから現行fingerprintを得る。calendarはcanonicalなcalendar-actuatorを参照する。
- 承認モックは実payloadからexact proofを生成する。最小installation fixtureにも実際のVCS manifestを配置する。
- 未出所のtargetを広いcharterだけで承認しない負例と、host由来の引数証拠を備えた正例を分ける。
- tenantの実行主体を認証文脈へ結び付け、query scopeだけで権限を与えない。別rootのscanner fixtureは来歴判定を分離し、実publication e2eでは来歴まで確認する。
- capabilityの保存先解決はdomain層へ移し、foundationからdomainへの不正な依存を取り除く。権限検査と保存先は変えない。
- 修復・transport単体試験と、移動済みの承認creator／readerのmockを実際の呼び出し境界へ合わせる。

失敗した21ファイルと関連境界をまとめた再実行は28ファイル・344テスト全件成功。
strict leak警告はなく、変更TSのESLintも成功した。直接APIの対応表とcapability移動は
独立レビューでmust_fixなし。以降のGitHub CI結果はPR #1253の最新headで確認する。

## 解釈上の制限

- 論文の攻撃成功率や回答精度を再現した実験ではない。Kyberionの実行境界の決定的な契約検証である。
- 校正はschema／guardrailの識別力を測る。任意の業務上の意味やLLMの判断全体を保証しない。
- 旧形式の未登録知識、tenant未指定のconfidential記録、owner不明のpersonal記録は保護済み来歴を持たない。
- リモート側の最後のtools/list観測後の意味変更を原子的に防ぐには、相手側の協力が必要。
- stdio承認継続は明示的なhost callbackが必要。statelessな再実行で消費済み起動を自動再生しない。
- 保存版の自動復元は同一process内でhostが書いた内容に限る。外部副作用・process再起動・他者の新しい編集を巻き戻す保証はない。
