---
title: 継続委任された開発工程を既存ownerへ接続する実装計画
tags: [delegation, development, dots, scheduler, governance]
last_updated: 2026-11-02
status: implemented
---

# 目的と基準

各tierの実行権限と外部操作の承認・委任を維持したまま、実装、検証、PR、独立レビュー、修復、merge、merge後確認を継続する。単に次の作業を文字列で返す処理から、既存executorを実際に呼び出す経路へ進める。

作業rootは `/Volumes/data/forcheck/kyberion-delegation-current`、branchは `feat/continuous-delegation-current-20261102`。開始HEADは `b5d970e2c`。remoteをfetchし、Windows hardeningの2コミットを取り込んだ `origin/main=f0bd6955e4ff5841419a0f1166672cbdfe41284d` へ既存成果をrebaseした。旧checkoutは変更しない。missionは `MSN-DEVELOPMENT-CYCLE-20261102`。

# 既存機構と配置

| 責務                         | 正本・拡張先                                                      | 方針                                                   |
| ---------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------ |
| 継続進行とeffect前checkpoint | `organization/continuous-work-owner.ts`                           | 既存ownerを維持する                                    |
| controller実行とprocess監督  | `scripts/continuous_work_owner.ts`、`continuous_owner_process.ts` | mission identityと子孫processの境界を維持する          |
| 個別実装・修復               | `mission/mission-workitem-dispatch*`                              | 同一scopeの既存WorkItemを選択してdispatchする          |
| 独立レビュー                 | `mission-orchestration-artifact-review`、artifact review receipt  | 対象revisionとCI policyをmanifestに束縛する            |
| 開発工程の接続               | `mission/mission-development-*`                                   | ownerから呼ぶboundedなtyped処理。並列ownerを作らない   |
| 公開・merge                  | `vcs-actuator`、publication host、external-operation              | 新しいGitHub transportや権限storeを作らない            |
| 再起動・定期化               | 既存continuous cadence／supervisor、必要時Chronos                 | 同一loopを二重登録せず、既存lock・予算・停止機構を使う |
| dots                         | 既存のproposal、allowed_pipelines、承認済みmanaged work           | dot workerのmission直接起動禁止を解除しない            |

# アクション別の承認・委任契約

| 操作                           | 必要な境界                                                           | 今回の確認・変更                                                             |
| ------------------------------ | -------------------------------------------------------------------- | ---------------------------------------------------------------------------- |
| 読取・編集・test               | runtime scope、tier、sandbox、WorkItem claim                         | caller入力からtier・roleを昇格させない                                       |
| AI実装・修復                   | 既存dispatcher、provider egress、TaskCredentialBinding               | 独自model runnerを作らず、対象WorkItemだけをdispatch                         |
| レビュー                       | implementerと異なるreviewer、artifact hash、revision、CI policy      | artifactの存在や自己申告でapprovedにしない                                   |
| PR作成                         | exact repo、本文provenance、tier、private確認、charterまたは単発承認 | 既存VCS境界を利用                                                            |
| push                           | exact remote/ref/SHA、source history、tier、private確認              | 非公開pushの実visibility facts欠落を修正し、履歴内の非公開pathを見落とさない |
| merge                          | exact repo/base/head、現行権限、現行CI・独立review                   | 直前の再確認と実merge後のproofを維持                                         |
| secret利用                     | 現行credential grant、主体・task・tenant binding                     | secretをplan、checkpoint、prompt、公開logへ入れない                          |
| secret登録・rotation／権限拡大 | 専用の現行承認経路                                                   | 開発委任を根拠に自動承認しない                                               |

publicだけを特別な実行対象にしない。confidentialは同一tenantの実行・データ許可とverified private destination、personalは本人のscopeとverified private destinationを要求する。承認はcross-tenant、データ流出禁止、provider制限を解除する手段にしない。分類不明・権限失効・曖昧な外部効果は停止する。

新規managed work planとmission alignmentは既存の本人承認を維持する。その承認後の工程を継続委任する。将来の任意mission作成までオンボーディングのVCS grantだけで許可する変更はしない。

# 実装順

1. 現行moduleと起動経路を調査し、この計画と受入条件をmissionに記録する。
2. pushのprivate visibilityと履歴provenanceを実処理から正規の委任判定へ渡す。public既存操作の互換を保つ。
3. reviewedなcontinuous work planへoptionalなdevelopment descriptorを追加する。repository URL、専用owner checkoutの `cwd: "."`、task/review、本文artifact、修復上限と `source_edit_paths` を束縛する。編集範囲は既存tool grantと同じ1〜64件の正確なpublic code fileとし、directory prefixやwildcardで広げない。変更時は既存admission hashとcheckpoint identityが変わる。
4. ownerの完了判定前に開発工程を接続する。実装・修復・レビューは既存WorkItem dispatcher、PR・push・mergeは既存VCS hostを呼ぶ。
5. 一回のwakeでboundedに進める。CI待機・queue待機・承認待機は修復回数を消費せず、次回のowner wakeから同じ工程を再確認する。
6. review/CI失敗時は対象taskを正規の方法で再実行する。revision変更後は古いreviewを無効とし、失敗上限・予算・lease・haltを守る。
7. 実merge commitと、その親・CI policy・必須checkの確認が揃うまでownerのdevelopment完了を認めない。
8. 非公開境界、取消し、再起動、重複wake、修復、完了条件を回帰試験し、独立レビューと修正を行う。

調査で既存dispatcherはruntime rootで動き、候補branchの自動作成・commitは行わないと判明した。このため、既存owner roleのstageで専用のclean main checkoutから独立したsource cloneを作成し、taskの正確な編集先を写像する。公開tierもclone内で編集し、提案中のsecurity-policy等が稼働中のgovernance rootへ即時適用されないようにする。承認された正確な編集範囲だけをownerがcommitする。既存の無関係なdirty/index、他missionの候補、実行root不一致は停止する。個々のworkerへrepositoryのowner権限を渡さない。

非公開taskには、public source rootへ直接書けない既存のsource-edit境界がある。この境界は維持し、既存task workspace rootにtier別partitionを追加して、同一mission・task・tenant・organization・projectが所有する登録済みgit workspace内へ編集先を写像する。private生成物をpublic rootへコピーしない。physical tierの保護とtyped VCSのcwd読取制約を追加し、public readerから隔離する。private側はGit objects・refsも共有しない独立cloneとし、公開側からprivate commitを参照できないことを試験する。VCSの公開先は同じ承認済みprivate repositoryに固定する。

初版は一つのwork planにつき開発missionは一件とし、別runには別の専用checkoutを使う。未対応の連続branch再利用を暗黙に行わず、複数開発missionのplanはparserで拒否する。既存の非開発mission群は維持する。

新規cloneの開始点は、runtime checkoutのローカルmainではなく、承認された正確なHTTPS repositoryから正規VCS fetchで取得した現在のmain SHAへ固定する。既存workspaceはresetしない。fetchは既存hostのGit認証設定を使い、秘密情報を新しい設定へ複製しない。hook・fsmonitor・自動maintenanceを無効化し、HTTPSに限定する。認証・取得に失敗した登録済みworkspaceは自動転用せず、ownerによる復旧対象とする。

ownerはcanonical missionからScopeEnvelopeをmintし、既存envelopeがあれば拡大せずにnarrowする。supervisorのprocess-global envは変更せず、監督付きcontrollerの子processへ明示tierを渡す。personalに架空のtenantを要求しない。

標準processのraw reviewer/human checkを機械が代行しない。承認済みdevelopment descriptorに限り、canonical facadeでTESTS・CODE_REVIEW・DELIVERYのdefinitionをtypedな実CI／review／publication proofへ結び付ける。一般missionのgateは維持する。標準のtest taskは実際の必須CIからowner serviceが証跡を作成し、local testを実行したとは主張しない。phase表示はCI待機・修復・merge後確認を妨げない順序とし、実際のreview receipt・CIはmerge前にも必須とする。

UX reviewなど追加の品質taskも、boardとcanonical WorkItemの両方を照合してmerge前に完了を要求する。未完了なら既存executorで進め、承認待ち・実行中は待機する。承認済み設計を対象とする追加reviewの否認は、単純なcode repairとみなさず明示的に停止する。主要code review／CIの失敗は承認範囲内で有限回修復する。

personalの承認本文は、system treeに新規保存せず、既存approval domainのpersonal/shared/owners/<NHI hash> partitionへ分離する。初回dot scopeと認証済み人間のConcierge scopeを正本のNHIへ束縛し、公開・別NHIからのraw/facade読取とcache再利用を拒否する。組織承認のtenant分離は維持する。過去にsystem領域へ置かれたpersonal記録はfacadeで遮断するが、本変更で既存実データを物理移行・削除しない。

承認cardには自動化される操作と対象を表示し、全fileと完全なdescriptorは同じadmission hashの既存scoped ledgerに保存する。Conciergeの既存承認queueで全範囲を展開できるようにし、hashだけが同じ古い非表示の同意は再利用しない。

pushの分類対象は、実destinationからread-onlyに確認したdefault HEADへ未到達の履歴とする。remote-tracking refは正本にしない。既に同じdestinationへ公開済みの古いpathだけを理由にpublic開発を永久停止させず、新規に送る履歴内では削除された非公開pathも確認する。

merge queueとの互換のため、prepared promotionはbranch削除を同時要求しない。remote branchのretirementはrepositoryの自動削除設定、または完了後の正規owner操作で行う。固定候補branchが前runからremoteに残る場合、次runの開始前に所有者が照合・後処理する。既存branchをforce pushで転用しない。

# 受入条件

- default runtime adapterが既存executorとVCS境界を呼ぶ。テスト用callbackだけで完了を主張しない。
- 実装から修復・独立レビュー・PR・merge後確認へ到達する接続を、実WorkItem／mission fixtureを用いた試験で確認する。
- public／confidential／personalの許可と拒否、別tenant、権限不足、unknown provenanceを検証する。
- scope、lease、停止状態、revocationをeffect前に再確認する。古いactorや承認済みhashの変更は拒否する。
- 待機と修復を区別し、無限修復・同時実行・二重PR／二重mergeを防ぐ。
- artifactやtask statusだけを根拠に開発完了を返さない。
- 既存scheduler／dotsの実起動経路と設定手順を示す。新しいdaemonを追加しない。
- 実GitHub canary・稼働中grant変更・secret rotation・実scheduler有効化は、ローカル検証と区別して報告する。

# 検証

編集対象の型検証・ESLint、authority／VCS／owner／dispatch／cadenceのfocused回帰を先に行う。sourceが固定してからbuildとPR向けcheckを実行し、testsはlive-stateを書き込むmission／baseline／checkと並行実行しない。全体レビューではscope、UI/UX、復旧、拡張性と既存機構への重複を確認する。

進捗・実行した検証・残る制約は本書へ追記し、未実行の外部操作を成功として記録しない。

# 実装・検証結果

既存continuous owner／resident dots／supervisor cadenceから、登録済みの各tierの独立clone、限定WorkItem dispatch、実必須CIのQA証跡、実diffの独立review、有限回の修復、正規VCS公開、merge後のimmutable proofへ接続した。新しいscheduler、権限store、GitHub REST transportは追加していない。初回のwork planとalignment承認は維持する。

| 確認                             | 結果                                                                                                                                                                                                                                                                  |
| -------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile` | 成功                                                                                                                                                                                                                                                                  |
| `pnpm build`                     | packages／repository／bundle／両UI production build／source shadow確認が成功                                                                                                                                                                                          |
| Concierge `tsc --noEmit`         | 成功                                                                                                                                                                                                                                                                  |
| `pnpm check -- --changed`        | PR gateと変更パスで選択されたgate、計82項目が成功                                                                                                                                                                                                                     |
| 変更107 TS／JSファイルのESLint   | warning 0で成功                                                                                                                                                                                                                                                       |
| 関連65テストファイルの一括実行   | 988成功、2skip、失敗0                                                                                                                                                                                                                                                 |
| 実Git fixture                    | staleなruntime mainより新しいremote mainの取得、3tierの独立clone、private objectの公開側からの不可視性を確認。外部HTTPS transportだけをローカルbare repositoryへ置換                                                                                                  |
| 実行環境baseline                 | pipeline自体は成功、意味上はL3 `needs_attention`。scope付きworktreeから本人設定を横断参照しない既存制約による `source: unavailable`。同じ環境のstandalone metadata確認では、正本 `/Volumes/data/forcheck/kyberion` のidentityが `ready: true`、`source: installation` |

独立したreview agentがowner／scope／clone／dispatch／CI proof／review／phase ordering／personal承認経路を読取レビューした。merge queueとbranch削除flagの競合を修正し再レビューを受けた。別途、public dotへのprivate scope継承、全tierのsource隔離、scope判定の低位module循環、未完了の追加品質taskがmergeへ先行できる順序も修正した。CIの基準値やcycle上限は引き上げていない。テストの共有fixture・store role期待値・verifier登録fixtureの不整合も修正し、全65ファイルを再実行した。

実GitHub／実modelによる一連の開発canary、稼働中grantやsecretの変更、schedulerの実有効化は行っていない。既存personal承認データの物理移行も行っていない。実装済みのローカル経路・検証と、本番運転の開始を区別する。

初版の上限は一つのwork planにつき開発mission一件、正確なsource file 1〜64件、review diff 64KiB、code repair最大3回。root package設定変更や任意の将来mission作成まで無制限に委任するものではない。範囲外、追加品質reviewの否認、未知の外部効果、認証・scope不整合は明示的な停止・owner復旧とする。remote候補branchが残るrepositoryでは次run前の正規retirementを要する。

レビュー可能なローカル実装として引き渡す。PR公開・merge、本番の自律実行を完了したという扱いにはしない。

# PR公開準備の追加検証

続くPR依頼に対し、最新の `origin/main=1bc5c0c45d764cf4e8ef75000dd46515824d4423`（#1339を含む）へ4件のfeature commitをrebaseした。機能sourceの競合はなく、`CAPABILITIES_GUIDE.md` の生成物競合は正規generatorで再生成した。main側のvoice／search追加exports、secure-io metadata制約、backup修正を保持している。rebase後の検証記録commitは `d3de996a8`。

このbaseで `pnpm install --frozen-lockfile`、`pnpm build`、変更パスcheck 82 gates、`pnpm check -- --scope full` 90 gatesが成功した。Concierge TypeScript検証もproduction build内で成功した。対象67 test filesの再実行は1,015成功・2skip・失敗0。その後、例外表に従ったC localeの全Vitest実行では3,109 files／32,422 tests成功、21 tests失敗、2 worker errorsとなった。失敗のうち委任scope invariant、PR publication fixture、PR lifecycle fixture、tenant selection fixtureの6 filesを修正し、該当6 filesの95 testsとworker errorのあった `background-review-nudge.test.ts` 4 testsを再実行して全件成功した。修正後の全suite再実行は未実施である。独立review agentは前回baseで権限境界とexportsを確認し阻害なしとしたが、#1339取り込み後の独立reviewは未実施。

手動のIntent smokeも5経路すべて成功した。PR公開前にはこの記録の対象branch/headを一致させ、最新sourceに対するcanonical readinessとKnowledge検査を再実行する。

missionの `verify → distill → memory-approve --knowledge-domain product --approval-channel pr_review → memory-promote` を実行し、検証済みの境界・完了条件の学びをpublicなproduct recordとして同じPRへ同梱する。raw distillationは構造抽出（LLMなし）と明記し、元の実装・検証・レビュー証跡から明示的に選択してcurationした。PR reviewによるratificationはmainへの反映後に確定する。本番canary・scheduler有効化・既存personal記録の物理移行は引き続き未実施。
