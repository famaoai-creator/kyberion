---
title: 外部入出力 actuator の統合と自律運用
tags:
  [
    governance,
    autonomy,
    accountability,
    approvals,
    actuator,
    meeting,
    service,
    browser,
    vcs,
    voice,
    media,
  ]
last_updated: 2026-10-21
---

# 外部入出力 actuator の統合と自律運用

責任者が定めた charter の範囲内で収集・下書き・実行・結果確認を継続し、範囲外の判断だけを approvals に渡す。認証の存在、capture/apply 分類、モデルの提案は実行許可の代わりにならない。

## 洗い出し

以下はリポジトリルート相対の実装パス。manifest と op-catalog の宣言だけでは直接呼出しの認可を保証しない。

| 対象・実装パス                                                                                                                   | 入力・出力・副作用                                                                          | 既存の境界と統合上の注意                                                                                                                                                                    |
| -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 会議: libs/actuators/meeting-actuator/src/{meeting-actuator-helpers.ts,meeting-session.ts,meeting-intelligence-ops.ts}           | URL・音声・字幕から transcript、議事録、action items。参加・発話・chat・reminder は外部作用 | 直接入口の runOpPreflight、participation consent、mission 単位の voice consent、監査、restricted action 判定。議事録作成と配布を別操作とし、発話同意を charter で代用しない                 |
| 外部サービス: libs/actuators/service-actuator/src/{service-actuator-helpers.ts,service-actuator-tenant-binding.ts,op-catalog.ts} | PRESET/API/CLI/MCP/OAuth、接続調整。読取・送信・更新・削除が同居                            | admitServiceAction の tenant binding と runOpPreflight、trusted approval resolver、CLI 制約。preset/harness の capture 分類だけで無害と判断せず、実 service/action と解決済み引数で判定する |
| メール: libs/actuators/email-actuator/src/{index.ts,op-catalog.ts}                                                               | 宛先・本文から下書き/送信。Mail.app/SMTP                                                    | email bridge の実送信境界と登録 backend を共通認可へ接続。宛先・CC・本文・送信元・SMTP account をhashに結び付け、部分拒否は不明。送信の自動retryなし                                        |
| カレンダー: libs/actuators/calendar-actuator/src/{index.ts,calendar-backend.ts,op-catalog.ts}                                    | 予定取得、作成・変更、会議 URL、招待通知                                                    | mutation helper・GWS/JXA・core workflowを共通認可へ接続。参照を維持し、出席者・通知設定・calendar_idを対象に含める。削除は包括委任不可                                                      |
| HTTP/A2A: libs/actuators/network-actuator/{manifest.json,src/op-catalog.ts}                                                      | fetch、shell、a2a_send/poll、artifact                                                       | fetch更新・shell・実A2A送信を共通認可へ接続。GET/HEADの既存SSRF/egress検証を維持。更新retryなし。旧A2A mailboxのtenant分離は別課題                                                          |
| ブラウザ・端末・OS: libs/actuators/{browser,terminal,system,android,ios}-actuator/manifest.json                                  | ページ・端末・画面の観測、クリック、コマンド、外部更新                                      | 共通 SDK と固有制約。service 認可を UI/CLI 経由で回避しない。自由入力の効果を確定できるまで個別制約を保持する                                                                               |
| 取込・検索・音声・画像・生成: libs/actuators/{ingest,search,voice,vision,media,media-generation}-actuator/manifest.json          | 外部取得、認識、provider への送信、音声出力                                                 | provider、perception、consent 境界。read 系でも外部モデルへのデータ移転と課金を別評価する                                                                                                   |
| 公開・配備・金融: libs/actuators/{vcs,deployment,blockchain}-actuator/manifest.json                                              | push/公開、環境変更、取引                                                                   | 個別ポリシーを保持し、不可逆性・費用・公開先が確定しない操作を包括許可に含めない                                                                                                            |
| 秘密・保存・制御: libs/actuators/{secret,file,data,artifact,scheduler,process,agent,orchestrator}-actuator/manifest.json         | 資格情報、保存、予約、子実行                                                                | secure-io、scope、制御面。直接 I/O がなくても資格情報・予約実行を介して外部作用を生むため、子操作にも認可を伝播する                                                                         |

## 共通接続点

既存入口は libs/core/pipeline/op-preflight.ts と op-preflight-defaults.ts、SDK は libs/core/actuator/actuator-sdk.ts。外部作用の共通 facade は libs/core/governance/external-operation.ts、責任・委任・例外は autonomous-ops-gate.ts、approval-gate-charter.ts、charter-service.ts に寄せる。consent、tenant binding、secret/egress policy は追加の必要条件として残す。

認可には解決済み payload、tenant/organization/project/mission/work item、責任者、宛先・対象、費用・不可逆性を結び付ける。利用者入力の approval_granted 等を根拠にせず、信頼された resolver が承認対象との一致を確認する。charter 範囲外の操作は副作用前に止める。

### 実装された owner 接続

`withExternalOperationAuthority(resolver, body)` を信頼済みの owner が実行境界に設置する。resolver は解決済みの `operationId` / `effect` を検査し、その操作に限定した `agentId`、`tenantSlug`、`invocationId`、`hasHuman`、`charter` とレビュー概要・成果物参照を返す。既存 SDK / ADF 内の service / meeting 呼出しにも非同期コンテキストで伝わる。呼出しごとの `externalAuthority` オプションも利用できる。操作 JSON や pipeline context に同名フィールドを書いても resolver は設置できない。

`charter` は既存の `charterInputForDecision` などで、確定した宛先・情報分類・添付・費用に基づき組み立てる。モデルが生成した「安全」「承認済み」は事実として採用しない。`invocationId` は新しい操作ごとに発行し、同じ操作の承認待ちから再開するときだけ保持する。再開時の payload 変更は effect hash で拒否する。責任範囲内なら人間を待たずに進み、範囲外かつ `hasHuman: false` なら外部作用前に停止する。

通常の pipeline dispatch は `external-operation-runtime.ts` で resolver を設置する。run・step・外部操作・宛先に加え、実行エンジンが管理する foreach/parallel_foreach の反復番号と service substep の番号を実行IDに含める。同じ宛先へ送る別項目と、同じ項目の再試行を区別する。JSON から反復コンテキストを設定することはできない。

承認再開のチェックポイントはトップレベルの pipeline step 単位である。内側の service/meeting envelope に複数の承認対象をまとめると途中再開できないため、その形は最初の外部作用より前に拒否する。複数 service 呼出しや join/chat 等はそれぞれ独立したトップレベル step に分ける。service の読取にも tenant binding の承認があり得るため、再開可能な run では複数 service 呼出しをまとめない。run に結び付かない直接呼出しの複数step envelopeには、自動再開の保証を与えない。

汎用 runtime が charter へ対応付けるのは明示された Slack `post_message` と会議の speak/chat のみで、受信者数・情報分類を推測しない。宛先や分類が不明な既定値は通常の charter では停止する。自律実行には、信頼済み owner が正確な宛先数・情報フローを与える resolver を設置する。未対応の操作名を既知の返信へ自動分類しない。

対話実行で例外承認が必要な場合は、秘密情報を除いた内容と元の effect hash を `writeScopedArtifact` で tenant の confidential/personal evidence に保存し、その参照を承認要求へ渡す。tenant 未設定の対話実行はレビュー資料の保存前に停止する。pipeline は実際の request ID で suspend し、保存済みの run・step・mission・channel・request・correlation と一致する承認だけで再開する。SDK が例外を失敗結果へ変換しても suspend は失われない。拒否・失効・内容不一致・非対話実行を自動修復や再申請で迂回しない。

service の PRESET は宣言された risk と実際の route を確認する。read が未宣言の CLI/MCP を GET 相当と推測しない。破壊操作、OAuth、自由形式 API/CLI/MCP は charter 委任対象にせず、個別承認と既存の制約を保持する。tenant binding の対象・操作許可は先に検証し、共通認可の成立だけが engine の binding 承認を満たす。明示的な `_approval_required` は追加の事前承認条件として残る。会議の join/listen/speak/chat は共通認可を通るが、参加・音声同意は引き続き別に検証される。

### 既存の実行証明との接続

service PRESET がすでに main の delegated permit または human apply claim の内側で動作している場合、実際の service・action・request・auth が完全一致する private runtime context を再検証する。その証明で共通境界の認可条件を満たし、二つ目の承認要求や charter 消費を作らない。tenant の一致と独立した永続予約・監査は維持し、transport 直前にも証明を検証する。既存 claim の内側で別 payload へ変えたり、失効した証明を新しい承認要求で迂回したりしない。直接の mapped service 呼出しも既存の実行 wrapper 内に共通境界を置く。CLI の PR publisher は汎用 `ghMust` mutation ではなく、snapshot を固定する `ghPrCreate` を使う。

### 結果からのフィードバック

browser の canonical handler map・直接 op・assist は、実セッションの所有者・tab・現在URL・ref対象・scriptソース・入力と解決済み値を認可へ結び付ける。navigation のorigin制限は先に確認し、secret/ref/passkeyの固有制約は認可後も有効。click、fill等の試行後retry/fallbackを止める。任意UI操作は効果を確定できないため包括委任しない。read、wait、ローカル変換は通常どおり自動で進む。

VCS は canonical `gitPush` / `ghPrCreate` / `ghPrMerge` を同期の共通認可へ接続する。pushはpush URL・source SHA・destinationを固定してSHA refspecで送り、PRは実repository・head・base・本文を確認する。mergeはhead snapshotを再確認し `--match-head-commit` を指定する。generic `gitRun` は既知のローカルverbだけを受け付け、global optionやaliasで外部操作へ逃がさない。generic `ghRun` のmutationもtyped verbに限定する。既存のPR publisher/readinessは別に維持する。

voice は実OS TTS、物理出力bridge、登録済みplatformの再生、未知/外部のrenderとSTTに認可を置く。音声同意とprovider制約を代用しない。source音声・script・reference音声の内容hashを結び付け、待機中の差替えを確認する。既知のlocal renderは自動のまま、外部renderと再生の複合操作は独立stepに分ける。生成した音声artifactと実再生は別の作用である。

通常のpipelineでは trusted run・step・tenant・反復番号から安定した音声job IDを作り、承認再開時にランダムな別jobを作らない。独自の再開runtimeは明示的で安定した request_id を与える。再生対象は一時ファイル名ではなく内容hash・音声format・実出力先に結び付ける。確率的な音声再生成でbytesが変わる場合は旧承認を流用せず、artifact生成と既存artifactの再生を別stepにする。primaryだけでなくfallback候補も外部renderを含むか事前判定する。

マイク録音のnative/shell境界と仮想カメラのstart/stopも共通認可を通る。OS許可・probe・source形式の固有検証を残し、無効な録音やカメラ未起動を成功にしない。カメラ登録は同じ設定を再利用し、start→stopで二重登録しない。設定変更は既存出力のownerが停止・再設定してから行う。低水準streaming/audio-busや任意provider実装をsandbox化するものではない。

image/video/workflow は登録providerの送信境界と直接公開facadeを保護する。画像のreferenceは内容hashに加え、native Gemini inline uploadへ渡すbytesをメモリ内で固定する。user-photo egress consentは引き続き必要。外部画像providerへの試行後はquota/timeoutでも別providerへ切り替えない。動画の `submitted` は受付であり完成ではない。jobのpoll/download不良から生成要求を再送せず、legacy `retrying` jobも対象provider jobを確認するまで止める。

メールの組込 provider の直接呼出しと registry 経由のカスタム backend、カレンダーの直接 helper・backend・core workflow にも同じ境界を置く。カレンダーの層間引継ぎは入力オブジェクト・hash・操作種別に一致する単回 capability に限定し、二重認可と別操作への転用を防ぐ。下書きは外部アカウントの更新であり、送信許可と共用しない。汎用 runtime は新規メールや予定変更を既知の返信へ自動分類しない。自律実行には owner がその操作に対応する正確な charter facts を供給する。

配備は `deployment:deploy_release` の共通認可へ既存 `config:update` / `scope:governance` の policy floor を同時に渡し、A3等の保証水準を維持する。独立した承認を二度求めない。`triggered` は起動受付の証拠であり本番稼働完了ではない。dry runや失敗は配備成功にしない。

charter による認可が実際に成立した操作だけが、その tenant の ledger へ `execution_outcome` を追記できる。レポートは認可件数と、成功・失敗・要確認の結果件数を分ける。通信切断や部分結果は `unknown` とし、自動再送しない。後から対象サービスを照会して結果を確認した場合は、同じ effect hash の `unknown` を最終結果へ解決できる。確定済みの結果は書き換えない。

認可後は外部作用の前に永続予約を作成し、同じ実行IDをプロセス再起動後も拒否する。予約は自動期限切れにしない。実行開始・結果の記録が欠けた場合も要確認として残す。照会で不明状態を解決しても予約を解放して再送することはない。新しい実行は、既存作用を確認したうえで別の実行IDとして明示する。

試行済みの mutation の例外は修復対象の契約不良と区別する。失敗・部分結果・不明 receipt は、SDKが例外を吸収した場合もtrusted observerから外側のpipelineへ停止を伝える。承認要求を新設したり、操作名・宛先を変更するモデル修復で再送しない。読取失敗に同じmutation停止条件を適用しない。

責任者が `external_operation_failure` tripwire をあらかじめ宣言した場合だけ、確認できた失敗で停止条件を立てる。結果不明は成功率向上の証拠に使わず、要確認として残す。監査・結果記録の障害は、送信済み操作を再実行する理由にしない。tenant の結果を system 共通の autonomy learner へ混ぜず、委任範囲を自動拡張しない。

## 会議から外部連携までの自律ループ

1. 許可された calendar から対象を解決し、参加・録音・発話それぞれの consent と tenant scope を確認する。
2. pipelines/meeting-followup.json で transcript 正規化→議事録下書き→action items→delivery pack を作る。partial transcript を証拠に残し、不明な担当・期限を創作しない。
3. 成果物を同じ scope に保存する。議事録作成成功を、配布や外部登録の成功として扱わない。
4. action item ごとに対象サービスと作用を確定し共通認可へ渡す。charter 内なら進み、例外だけ具体的 payload と承認要求を提示する。
5. 認可された操作を実行し、結果識別子と監査を記録する。外部結果を確認してから action item を完了する。モデルの計画生成だけでは完了にしない。
6. timeout や送信後の観測失敗を「未実行」と区別し、照会・idempotency で結果を確定してから再実行する。失効・拒否を自動再申請ループにしない。

補助 pipeline は meeting-watcher.json、meeting-proxy-workflow.json、meeting-facilitation-workflow.json、service-lifecycle-smoke.json。実サービス実行の証拠とローカルテスト結果は分けて記録する。

## 残る接続と検証範囲

接続済みは service、meeting、email、calendar、network、deployment と、上記 browser/VCS/voice/media-generation 境界。raw Playwright/CDP、ブラウザ内部primitive、pluginが保持したraw実装参照、任意shellやSDKを外部から直接呼ぶコードのsandbox化を意味しない。OS/terminal/mobile、取込・検索・独自providerの残る低水準経路は固有制約に従う。blockchain actuator は現状local mockへの `simulated:true` な記録であり、実チェーンへの送信実装や実取引の成功は存在しない。新しい外部provider/transportはcanonical境界へ登録してから使用する。テストは模擬transportで行い、実公開・実音声再生・実provider生成・本番配備は行っていない。
