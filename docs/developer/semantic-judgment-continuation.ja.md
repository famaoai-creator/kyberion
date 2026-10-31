---
title: 意味判断の継続実装と接続境界
tags: [dot, semantic-judgment, offline, governance]
last_updated: 2026-10-31
---

# 意味判断の継続実装と接続境界

T01〜T06 の検収後に進める合成検証の記録です。最初の契約・保存・経路の説明は [最初の検収スライス](./semantic-judgment-offline-slice.ja.md) を参照してください。

## 現在の検証済み範囲

| 段階   | 実装と検証                                                                                                                      | 残る境界                                                                              |
| ------ | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| T07a   | 明示した offline fixture port を使う観測 facade。親 accounting/scope/day を維持し、全提案共通の期限と予算予約・精算の契約を検査 | 実運用の全 consumer を覆う原子的な予約 API と provider の取消・usage adapter は未接続 |
| T07b1  | charter の optional `runtime.semantic_judgment.mode` は `off` または `shadow`。未指定は off。既存設定ファイルの変更なし         | shadow の指定自体は provider や予算の接続を成立させない                               |
| T07b2a | token 推定と既存の usage/egress context を専用 helper に抽出。claim 後の event attempt を呼出し時に渡す                         | 観測 hook はこの段階には含めない                                                      |
| T07b2b | tool/fence の両経路で、明示した fixture DI に限り baseline 完了後に観測。元の accounting・scope・期限と receipt を維持          | 本番の予約・provider adapter の factory はない。既存 charter 設定は変更しない         |
| T09    | 固定 seed の100 samplesによる合成 p95、既知の設定・操作、既存 continuous-operations engine を通る episode 回帰                  | 実サービスの測定でも、実 WorkItem/claim/executor の縦断検証でもない                   |

T07a の期限切れで provider の停止を確認できない場合は `pending_stop` とし、予約を未確定のまま保持します。遅延応答に実際の usage があれば精算できますが、その応答を保存・採用しません。呼出しがまだ始まっていない場合だけ、開始を禁止して既知のゼロ使用量として精算できます。

fixture の予約 port と通常 consumer が同じ残高を共有する試験は、本番の複数 process・通常 wake・executor 全体の予算保証ではありません。現在の使用量記録だけでは、その保証を導けません。本番 shadow は引き続き No-Go です。

## 合成の測定

同じ profile/model で、baseline は65 usersで p95 1,800 ms、100 usersで2,500 ms、修正 variant は100 usersで500 msになります。これは固定計算であり、性能 benchmark ではありません。自由文 report から測定値を取り出しません。

`configuration_hash` は既知 variant の識別子です。後続の独立 verifier は実際の設定 artifact の bytes も別途結び付ける必要があります。worker の自己申告を改善確認に使用しません。

## Binding 検証の共通部分

`judgmentEvidenceParent` は full binding と scope の strict・非破壊な検証、`scope_hash` の一致確認を行い、評価と効果の identity を単一の計算にまとめます。`parseJudgmentReceiptAddress` は path や権限を持たない厳密な selector を扱います。

`resolveLatestJudgmentEvidence` は同一 full binding・effect の現在有効な最新版を取得します。receipt の割当・上書き・延命は行いませんが、既存の必須 trace を作成・修復する場合があります。明示的な旧参照を再利用する API の拒否は維持します。古い origin の参照と bytes は固定したままです。最新版が取得できても、その verdict は実行許可ではありません。

T08c の前提として追加した `readHistoricalJudgmentEvidence` は、古い origin を明示 ordinal と content hash で読み、保存された scoped payload・binding の整合性だけを検査します。最小の `historical_verified` DTO を detach・deep freeze して返し、trace・index・receipt の作成や修復は行いません。期限切れ origin を現在の判断として採用せず、trace や最終検査に失敗した payload を過去の採用成功とも扱いません。形式が正しい binding や caller の保存済みラベルを、元 receipt の実在証明に使用しません。

T08a の `bindSyntheticDotJudgmentProposal` は server-authored な合成参照を作ります。full proposal と charter の hash、scope、full judgment binding、元の receipt selector、効果 policy の版を固定し、detach・deep freeze します。shadow・既存参照の差替え・managed/handoff・未許可 pipeline には付与しません。モデル parser は内部 `semantic_judgment` field を tool/fence の両方で拒否します。これは pure authoring であり、元 receipt の真正性や実行許可を保証する API ではありません。

T08b1 の server proposal validator は binding を再作成せず、元の canonical proposal とその hash を照合します。action ledger は private 本文と admission proposal の binding・scope・全 proposal hash、および pipeline・objective・shape など実行に使う row の各 field を照合します。metadata だけの private index を実行用 record として扱いません。index に private binding や admission が混入した場合も拒否します。binding がない従来の16文字 hash は維持し、有効な binding がある場合だけ hash にその識別子を追加します。この段階では WorkItem 伝播や承認の binding は未変更です。

T08b2 は元の binding を action から WorkItem の初回作成・復旧・capacity 再開へ渡します。元の admission がない judged work を legacy として再構築しません。現在の charter が active・off・非 diagnostic・許可済み pipeline/shape で、完全な scope と hash が一致することを独立に検査します。同一 operation で binding が変わった場合は別 WorkItem を作りません。既存 item に不足する binding を補完することもありません。

実ストアでは元の作成履歴による identity 検証を維持します。履歴を持たない注入 port の既存 snapshot には、厳密な作成属性・context・metadata の一致を要求します。status/version など lifecycle 更新は許容しますが、注入 snapshot の作成属性が後から編集されている場合は保留します。この段階の合格は伝播・復旧の範囲であり、承認 payload の真正性や origin の現在性の証明ではありません。

T08b3 は元の `admission.semantic_hash` と `dot-judgment:${action_ref}` を既存 approval の payload/effect に結び付けます。current charter、request ID、requester/source、完全 scope、accountability を terminal feedback・admission 記録前に照合し、肯定的な承認には既存の期限・利用可否・SoD も要求します。WorkItem 作成直前と既存 item の復旧時にも再読します。新しい承認 policy や認証ラベルは設けません。

judged の肯定的 feedback は dispatch 成功後の再照合まで遅らせます。記録前に証跡が変われば parked を維持し、作成直前に変われば WorkItem を作りません。作成後に変わった場合は feedback を抑止できますが、既存の内部 WorkItem を取り消せるわけではありません。実効果直前の evidence/claim 検査と、実行との競合は T08c 以降の検証対象です。

T08c の `validateDotJudgmentPreEffect` は実 claim の item/lease/run、origin と最新の apply、server の既知 candidate と固定目標、現在の charter・bounds・role・policy・承認を照合します。最後の観測時刻で receipt・承認・lease の期限も再検査します。`current_attempt_id` は `run_id` と一致させ、claim 前の lease version を現在の item version と混同しません。

返す `eligible_observed` は **DOT admission の観測適格性**です。既存の intake mapping は WorkItem 作成の gate であり、具体的な pipeline effect の実行権限ではありません。正規 mapping、`admission_only`、`gate_action_id`、execution policy の descriptor/version を照合します。現 gate の有限 score と known-action/current-policy による分類は、将来新しい拒否形式が増えたら回帰試験とともに更新が必要です。実 ADF/default adapter の preflight・個別 actuator 権限・競合のない effect 実行・全 production 入口の非迂回は未証明です。

T08c の actual-claim fixture は隔離した policy と NHI warn staging を使います。実 store の状態検証であり、本番の認証・権限設定の合格判定ではありません。latest/reuse が必要 trace を作成・修復する可能性も維持しています。

## 修正と独立検証の準備

T10a の pure verifier は、既知の設定を canonical bytes にし、controller が独立に保持する期待 file SHA/configuration hash と実 bytes を照合します。固定 T09 spec/model/profile/seed から100 users の p95 と0 JPY条件を再計算します。現在の既知 canonical JSON では2つの hash 値が一致する場合がありますが、実 bytes の同一性と設定の意味的同一性という役割は区別します。

返却する `artifact_content_verified` は内容と合成測定の検証です。Proof DTO の distinct actor/item/effect/action/operation/lease/run は構造検査にすぎず、出自・独立性・仕事の完了・実行許可を保証しません。実ストアからの証跡再構成と controller による親完了判定は、T10b で分けて検証しています。worker の自己申告メトリクスは入力にしません。

## 承認済みの結果保存境界

T10b の実 executor で confidential 結果保存が拒否されたため、[専用 facade の設計](./semantic-judgment-result-writer-proposal.ja.md)を追加承認のうえ実装しています。P1 は append-only 操作を secure I/O まで伝播し、P2 は実行 charter から指定できない専用 role と exact resource/operation capability を組み合わせます。既存 worker の grant は広げません。

P3a の immutable result/report marker と one-shot origin permit、P3b の実 action/WorkItem/claim/lease を照合する保存 facade は focused strict tests と独立レビューを通過しています。結果ファイルは同 scope 内の複数 DOT で共有されるため、返す最小状態は DOT ごとに絞り、本文・参照先の保護 evidence を返しません。privileged helper は公開 package export に追加せず、pure records のみを公開します。

P3c の executor・consumer 接続は全体 build と focused strict 検査を通過しました。producer 5 files / 90 tests、consumer 5 files / 86 tests、境界 gate 4 tests が成功し、leak は空です。T12-pre では実 expired lease の negative recovery だけを追加検証しました。pipeline continuation、由来を証明できない lease_lost などは拒否を維持します。

T10b は保留を解除し、実 admission・claim・executor・独立 verifier・controller による親完了を strict 21 tests、skip なしで確認しました。実 creation history・run/lease/event・効果 settlement・durable result を照合し、verifier 完了後も実 bytes と固定100 users / p95 500 ms / 追加0 JPYを再検証します。worker 単独成功、偽 proof、stale 判断、履歴欠損、actor/scope/parent 不一致、最終ファイル改変、親の版・context 変更では完了しません。隔離 policy と合成 port の検証であり、実 ADF/default adapter や本番認証・効果権限の資格確認ではありません。

## 模擬 human handoff

T11 は private な opaque fixture context を使い、モデル JSON・複製 token・viewer・別 scope・古い質問では判断を変更しません。実 ledger の lock と既存 promotion/append を使って費用判断の新しい版を保存し、実 record の canonical hash に結合した goal を再読します。同じ `work_ref` の新 revision・receipt として再評価し、100 users / p95 500 ms の目標、旧 receipt の address/bytes、実 pending effect approval の payload/status/ID 集合を維持します。無回答は保留、質問の再生成は同じ採用参照へ収束し、外部送信しません。

durable な検証対象は ledger・receipt・approval です。human 認証・質問 queue・revision はテスト内の仕組みで、実ユーザー認証・永続質問 queue・実 WorkItem revision 更新は接続していません。新しい価値判断を effect approval に変換しません。

## 期限切れ後の未知結果

T12-pre は、実 claim→coordination reaper の lease expiry と `lease_expired` attempt、元 action/WorkItem identity、同 run の held ownership、4種類の実 event を照合して `blocked` / `escalated` の最小結果だけを追記します。lock 後にも再検査し、保存後にのみ既存の archive/report へ進みます。新 claim、operator release、完了済み settlement、scope/履歴不一致は拒否し、追記失敗時は UNKNOWN を保持します。grant・policy は増やしていません。実 reaper 接続と保存・archive 失敗時の冪等性を含む strict 120 tests を通過しました。

## 5停止点と並行 wake

T12 本体では snapshot・model 応答・receipt 保存・admission 保存・効果後の結果保存前に fault を置き、現在版の再読、同 immutable receipt の修復、同 WorkItem への収束、未知 claim の expiry/archive と再実行抑止を確認しました。model 再呼出しは fixture の2 calls / 140 tokens の上限内だけで、無料 retry や exactly-once を仮定しません。並行 wake は同 root/namespace/key の実2 managed child と READY barrier を使い、実 file lock を通して1 action/WorkItem へ収束します。READY 前の正常／異常終了も待機・rejection を処理し、finally で managed owner を片付けます。

新9ケースと境界 gate の strict 15 tests、既存 admission recovery/ownership の strict 46 tests が成功しました。5停止点は fault/resume 相当の fixture であり、全点 OS kill/restart ではありません。budget と質問 dedupe は local fixture、OS 全体の process 残存は未確認です。

## 学習回帰の停止と別修正（T13 Step A）

partial publication の回帰で、実 publication 後・承認消費前に実 candidate queue を `rejected` にすると、古い approved snapshot で承認が消費され、後段の公開だけが拒否される不具合を再現しました。承認レコードや消費結果を偽造せず、実 facade の境界で状態を変えた検証です。初回の残る2失敗は tenant 承認の保存先を誤った fixture であり、保存先修正後に partial publication の復旧／却下4ケースが成功し、実競合1件だけを分離できました。

停止証拠を残して別 ticket へ分け、現在の canonical queue と消費を既存 publication→queue lock 内で結合しました。current id/scope/payload/status/approval ref/files を検証し、rejected 等は消費前に拒否します。promoted は既存の完全一致 consumption の確認だけで、新たに消費しません。grant・store・schema は増やしていません。

元の未変更5ケースが strict 5 PASS、既存 publication/workflow が strict 22 PASS、skip/leak なし、core build・lint・core typecheck・独立レビューを通過しました。fixture の保存先誤りも governed tenant resolver に直し、location ambiguity を意図した拒否の証拠と誤認しないようにしています。GitHub issue の現在状態や既知回帰全体の解消は確認していません。

## 公開 lesson の実配送と再検証（T13 Step B）

新しい隔離 fixture の実 worker/verifier・claim/result と独立 controller の before/after bytes 測定から、scoped artifact と SHA を作ります。実 feedback queue と fixture human の review/publication を通し、canonical publication を同一 bytes で検証した pin から実 delivery snapshot を保存します。次の実 work の worker report だけでは verified は0で、別の実 verifier と controller 再測定の合格後だけ1になることを確認しました。別 tenant/project、公開 bytes 改変、未改善、配送のみ・自己申告のみでは成功にしません。

途中で pin loader の祖先 metadata 検査が `knowledge/confidential` の tenant 未指定拒否を踏む不具合を再現し、別 ticket で中央 path validator へ置き換えました。containment・祖先/leaf の symlink/ENOTDIR・leaf 本文権限・サイズ・同一 bytes の hash を保持し、grant は追加していません。structural prefix の metadata 拒否を維持したまま正当な pin が通ります。path unit 8 tests と reuse integration 5 tests が strict・0 skip で成功し、core build・lint・core typecheck・独立レビュー、leak 空を確認しました。

job は generic synthetic port で semantic binding はなく、MissionState は fixture selector です。test 環境で省略される audit は初回 enqueue に実 tenant audit ID を補う計装を使い、本番の自動監査保証とは区別します。`golden` は controller が実 proof と再測定を検査して記録する telemetry で、API 自体の proof 認証ではありません。固定操作の再利用回路の検証であり、モデル学習による因果改善・実性能・本番認証／ADF/provider 権限の証明ではありません。

## 評価 dataset と品質 gate（T14）

[評価の記録](./semantic-judgment-evaluation.ja.md)と80件の合成 draft dataset を追加しました。apply/reframe/escalate 各20件、negative 20件、JA60件・EN20件です。35組の group inventory・draft branch/scenario/language の整合性・正規化した自由文80件の一意性と、既存 assessor による scripted fail-closed 条件を strict 81 tests で確認しました。dataset・prompt・rubric の SHA を固定し、自由文を trusted facts に昇格させません。

検収は決定論的な契約試験だけです。label は独立 human review 待ちの `synthetic_draft` / `regression_draft` で、gold・holdout・80の独立 business 問題とは呼びません。実 provider、意味品質、precision/recall、latency/tokens は未測定の null、閾値は提案値です。実 shadow/enforce は No-Go を維持します。T15 の confidential 互換修正と集約検証は未完了です。

## 実行済み検査の記録

- T07a: observer と既存 usage-accounting の strict 39 tests。
- T07b1: 既存 charter の strict 50 tests。
- T07b2a: 既存 runtime と usage-accounting の strict 67 tests。
- T07b2b: 観測 integration・runtime・orchestration・observer の strict 110 tests。実 admission integration は4 tests・16シナリオ。
- T07b2b で発見した保存処理の回帰修正: artifact-store の strict 62 tests。
- T09: latency fixture、continuous-operations policy、continuous-operations の strict 76 tests。
- T08-pre: 共通 identity・selector・最新版 lookup を含む evidence の strict 27 tests。
- T08a: binding・proposal の strict 18 tests。binding がない従来 hash の固定値も維持。
- T08b1: ledger・binding・proposal の strict 35 tests。実行 row と元 proposal の不一致、mixed private index の拒否も含む。
- T08b2: 専用30 cases と dispatch・admission recovery・extensions の strict 111 tests。global な承認 cleanup を持つ既存 integration は実行せず、専用の隔離 fixture で実 gate・route・store を検証。
- T08b3: 承認 unit/integration・b2 integration・dispatch・admission recovery・supersession・approval store・SoD の strict 8 files・185 tests。元参照・scope・payload/effect・revoke・途中変更と legacy 互換を検証。
- T08c 監査前提: historical reader を含む evidence の strict 34 tests。origin と最新採用の分離、全 binding/ref 不一致・破損・欠損・無修復を検証。
- T08c: pre-effect 52 cases・evidence・work coordination core/recovery の strict 4 files・127 tests。最終 TTL、正規 intake mapping、prototype/async port、claim・context・policy の変更を検証。
- T10a: verification・T09 fixture の strict 2 files・28 tests。実 bytes・期待 hash・固定測定・不正 proof／自己検証／未改善を検証。
- T10b: 実 store を通る縦断 integration の strict 21 tests、0 skip。対象 lint/typecheck/core build、独立レビュー、leak 空を確認。
- T11: human handoff integration 6 cases と既存 promotion/ledger の strict 3 files・22 tests、0 skip。対象 lint/typecheck/core build、独立レビュー、leak 空を確認。
- T12-pre: result store・実 reaper integration・origin・records・境界の strict 5 files・120 tests、0 skip。対象 lint/typecheck/core build、独立レビュー、leak 空を確認。
- T12: 停止復旧と境界の strict 3 files・15 tests、既存 admission recovery/ownership の strict 2 files・46 tests、0 skip。対象 lint/core build・独立レビュー・leak 空を確認。core typecheck は test files を含まない。
- T13 Step A / 別修正: 元の未変更回帰 strict 5 tests、既存 publication/workflow strict 22 tests、0 skip。canonical queue fence で stale consumption を拒否。
- T13 Step B / pin 別修正: guarded path unit strict 8 tests、fresh learning reuse integration strict 5 tests、0 skip。core build・lint・core typecheck・独立レビュー・leak 空を確認。
- T14: draft dataset 80件と scripted contract strict 81 tests、0 skip。core build・lint・core typecheck・独立レビュー・leak 空を確認。実モデル評価ではない。

各段階で対象 ESLint、core typecheck/build、独立レビューを実施し、strict test の active leak が空であることを確認しました。集約検査・本番 provider 評価・実環境 shadow・リモート CI の成功を意味しません。

実 admission 比較では、隔離 fixture の policy で `dot_delegate_work` の axis scores を0にし、既存 gate・dispatcher・WorkItem・approval store を通します。これは出荷済み policy の権限を証明する試験ではありません。tool/fence と auto/approve floor それぞれで、off と shadow の正常・保存失敗・timeout を比較しました。auto は action 1件・WorkItem 1件、approve floor は保留 action 1件・pending human-only approval 1件・WorkItem 0件です。観測前後で実レコード・ID・version・承認状態が一致し、通知の増分もありません。executor・外部送信は実行しません。

変更していない security policy を読み込む試験で、先行実装が tenantless な構造ディレクトリの metadata を読む不具合を検出しました。パス境界で全祖先の symlink と file ancestor を拒否し、metadata 検査は所有する directory leaf に限定しました。tenant grant は変更していません。実 policy 下の作成・読取、祖先 symlink、file ancestor、leaf file の拒否を artifact-store の回帰に含めています。
