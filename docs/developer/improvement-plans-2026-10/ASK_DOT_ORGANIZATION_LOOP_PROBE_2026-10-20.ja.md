---
title: ask から dots と組織ミッションへの実行経路検証
tags: [autonomy, governance, dots, ask, organization, runtime-probe]
last_updated: 2026-10-20
status: partial
---

# ask から dots と組織ミッションへの実行経路検証

## 結論と確認範囲

実 Claude を使った ask、合成の組織コンテキスト、dots の起動経路を確認した。現時点では ask → dots intake → WorkItem → 組織ミッションという全区間の自律実行は確認できていない。個別の会話応答、public の planned mission 作成、手動 wake の成功に加え、通常 supervisor の関数を使った有界 tick で dots intake から組織 mission 開始まで成功した。ask の接続と既定 shadow の承認後再開は未接続であり、全区間の成功と区別する。

検証 checkout は専用 worktree、起点は main の b938 系。検証用 identity、tenant、organization、Dot は正規 onboarding／organization facade で準備済み。project は作成していない。リポジトリと runtime は専用 worktree に分離したが、native CLI の認証とグローバルコンテキストは host の既存設定を使用したため、コンテキスト全体の隔離を証明するものではない。ユーザーの既存組織や個人情報を検証本文に流用しない。外部送信、支払い、削除を依頼しない。応答本文、認証情報、所有者の個人情報は本報告へ転載しない。

## 実 ask の証跡

次の ID と結果は検証担当が保存した実行ログのメタデータによる。ログ本体はローカル一時証跡であり、この文書には含めない。

| 試行                                          | intent request ID | 実際の到達点                                                                                                    |
| --------------------------------------------- | ----------------- | --------------------------------------------------------------------------------------------------------------- |
| unscoped ask                                  | ir_28ce0e8c4309   | A2A task contract の context 欠落で委任失敗。新規 WorkItem／mission なし                                        |
| tenant／organization の環境変数を指定した ask | ir_31e46c767bbb   | 同じ A2A 契約エラー。環境変数だけでは scoped ingress にならない                                                 |
| 基本文言の ask                                | ir_f3a86a632e97   | service_scope など計3項目の clarification。委任なし、mission／approval 作成なし。authority は approval_required |
| ドキュメント系 ask                            | ir_0638b08a9b33   | MSN-MVFYES9T を作成。保存先 public、状態 planned。組織 scope 付き dots 経由の作成ではない                       |

最初の二試行では approval_required の表示があっても approvalRequests と missionProposals は空だった。承認ラベルだけでは、操作可能な承認要求や承認後の再開経路の存在を証明しない。

## コード上の阻害要因

### P1: ask は dots intake を経由しない

scripts/kyberion_home.ts:312 の handleAskSubcommand は :323 で runSurfaceMessageConversation を直接呼ぶ。tenant／organization を持つ scope や dots の intake receipt は渡さない。libs/core/surface/surface-runtime-orchestrator.ts:136 と :322 の mission 作成分岐も public mission を直接 create する。作成済み planned mission は、dots の分類・WorkItem 所有・mandate の検証を通った証拠にならない。

### P1: surface handoff と mission task の契約不一致

libs/core/surface/surface-runtime-orchestrator.ts:800 の forced delegation は context を指定しない。libs/core/surface/surface-runtime-conversation-data.ts:1368 の builder は、呼出側が context を渡した場合だけ payload に入れる。一方 libs/core/structured-output-contracts.ts:103、:104、:140 は mission_id、team_role と context を必須とする。libs/core/mesh/a2a-bridge.ts:382、:393 で実行前に拒否される。

モデルが A2A を出す別経路でも、surface-runtime-orchestrator.ts:747 の processDelegations は text の補正だけを行う。欠落した trusted runtime context を解決しない。偽の mission_id を補って通す修正は採らない。bridge は mission_id の有無を runtime の所有区分にも使うため、監査上の誤帰属になる。

### P2: 単語の receiver rule が governed routing を先取りする

knowledge/product/governance/surface-provider-manifests.json:1229 の「計画」は CLI を nerve-agent に振り分ける。surface-runtime-orchestrator.ts:1227 は receiver が決まった場合 compiler を実行しない。「改善計画」を含む mission 作成依頼もこの条件に入る。自然な文言の差で mission admission と一般委任の経路が変わる。

### P2: 承認表示と durable request の不一致

surface-runtime-orchestrator.ts:578 は intentResolution.authority_level だけでも承認表示を選ぶ。承認 ID のない表示を「承認待ちとして処理可能」と扱わず、実際の request 保存、通知、承認後再開の証跡を別々に確認する。

## 既存 ingress の再利用境界

libs/core/dot/dot-event-intake.ts:535 の ingestLocalEvent は、宣言済み source、source 側で固定された tenant、イベント台帳、delivery の重複防止を再利用できる。ask と接続する場合は、trusted CLI scope と organization の tenant 所属を検証し、対応する active DotCharter と source に解決してから受け渡す。ユーザー本文から tenant や実行権限を導かない。

同 policy は tenant 単位であり、organization の宛先は別途検証が必要。同一 tenant の別組織へ配信しない条件を設ける。内部 API ingestInboundEvent に未検証の tenant を埋めた event を直接渡さない。

共有 dot inbox をそのまま接続先にしない。libs/core/dot/dot-inbox.ts:108 の入力には tenant／organization がなく、共有 system 台帳に書く。:266 の判定は dot_id／channel によるもので、無宛先は同じ channel の dots へ broadcast する。libs/core/surface/channel-adapter.ts:179 の既存 bridge も input.scope を inbox に保持しない。機密本文をこの共有経路へ追加する変更は避ける。

## dots の実行確認と限界

検証担当は host I/O の起動阻害を修正し、実バックエンドの手動 wake 成功を確認した。ただし、この手動 wake は ask や inbox receipt を起点にしていない。モデル応答が得られたことだけでは、入力量の分類、WorkItem 作成、組織ミッションへの自律昇格の成功を主張しない。

## 通常 trigger と組織ミッションの追跡

通常 trigger の実行結果と具体的 ID は後続の「実イベントの経過」「組織 mission 開始の実成功」に記載する。専用環境の有界 tick と shadow 解除を明示し、常駐無介入試験や既定設定の成功とは区別する。

初期 shadow の mission-start を人為的な学習履歴で auto に昇格させない。正規の人間承認で bootstrap した場合も、承認前後の evidence と適用境界を記録する。委任範囲内の次回実行と、初回に人間が開始した実行は区別する。

## 最小の改善方向

ask の trusted scope から既存の tenant 隔離済み intake へ渡す入口を設け、入力量と実操作の承認を分ける。generic surface handoff と実 mission task を契約上区別し、mission task 側の必須条件は維持する。承認が必要なら durable request ID を返し、承認が不要な intake を会話上の承認ラベルで止めない。修正後、同じ自然文を実バックエンドと通常 supervisor に通し、上記 ID の連鎖で再確認する。

## 実イベントの経過（追記）

- 最初の inbox は実モデルが提案したが、依頼した実対象パス docs/** が glob のため拒否。委任範囲の glob と実対象の具体的パスは区別する。この拒否は正しい。
- 対象を docs/loop-verification-plan.md に直した新しい依頼02は、実 trigger wake:ca9b4411124a3d29 から提案を生成し、action dact-6ebb0f1178f4734d9682ab078c11015bcc21cd7e1c1e4f1a2fd748462fdc5381、WorkItem WITEM-DOT-2c015fd9effd292c01f3874eb1def8b653251eb7 を作成した。intake に承認要求は不要で、tenant/organization は保持された。
- project 未指定の Dot と WorkItem の正規化済み default bucket が不一致になり、mission 受入が停止した。元の Dot の宣言 scope を検証後に利用する修正を適用。具体 project の不一致は引き続き拒否する。
- 同じ WorkItem を通常 watchdog で再評価すると、既定の mission_start_mandate は decision:auto / allowed:false / shadow:true。mission 未作成のまま保持される。この分岐は承認要求を作成しない。
- 専用環境の第二シナリオのみ、同 action の shadow を false に設定した。費用ゼロ・外部作用なし・具体的文書パスの委任は維持。学習実績や承認は投入しない。この設定は製品差分に含めない。
- controller 呼出しまで進んだが、呼出し元の organization_operator を引き継ぎ mission_controller の必須 context を満たさず停止。WorkItem は blocked、失敗 receipt は ok:false で記録された。失敗は削除しない。

## 組織 mission 開始の実成功

2026-10-20 00:50:32 UTC、同じ WorkItem を通常 watchdog から再評価し、MSN-DOT-2C015FD9EFFD292C01F3874E が active になった。tenant=loop-verification-20261020、organization=loop-verification-ops、project は未所属。元 WorkItem は done。controller は8タスクを展開し、mission 用 Git を初期化した。

mission brief は元 WorkItem と ask-dot-loop-docs を保持し、SHA256 は 89edca87ccd874ef4d104ce4759c8c9c4e3bf9e06fc4e24e40b4e42bd9bcbf45。成功 receipt は mission-start:loop-verification-20261020:MSN-DOT-2C015FD9EFFD292C01F3874E、ok:true、00:50:32.074Z。00:49:02.832Z の controller context 失敗 receipt は ok:false のまま保持した。

これは「実イベント → 実モデル → 型付き提案 → WorkItem → 包括委任判定 → controller → 組織 mission 開始」の確認である。通常 supervisor が使う評価・実行関数を専用環境の有界 tick で順番に呼び出した。常駐デーモンを長時間放置した無介入試験ではない。成果物作成・mission 完了までは回していない。承認偽造、学習実績の投入、WorkItem や mission の手動作成で経路を補っていない。委任の shadow 解除は明示した専用設定であり、既定状態の成功とは主張しない。

ask→intake の接続不足、および shadow 保留→実承認要求→承認後再開の未接続は残課題。後者はカードを足すだけでは不十分で、brief/WorkItem/mandate/scope の hash を束縛し、承認後に現在の委任を再検証する durable continuation が必要。今回の修正は host I/O、project scope、controller context の実行阻害を対象とする。
