---
title: 情報資産カタログ・収集・dots intake 統合実装計画
kind: implementation_plan
status: active
last_updated: 2026-11-02
tags: [information-assets, organization, collectors, dots, intake, governance]
importance: 8
---

# 情報資産カタログ・収集・dots intake 統合実装計画

## 目的と完了条件

「未対応の顧客依頼」「未処理のレビュー依頼」「承認待ち申請」という業務上の情報を要求すると、その組織・プロジェクトの取得先を解決し、サービス経由で収集し、既存 intake と WorkItem に接続できるようにする。結果の確認、承認・相手待ち、再確認までを追跡する。実アカウントでの成功は fixture による契約試験と区別する。

## 構成と正本

1. product の情報種別定義・業務レシピは parameterized catalog とする。
2. 組織別の所在定義は既存 organizationStateDir 配下の information-assets.json とし、既存 organization facade から登録・更新する。秘密・承認状態・WorkItem 状態は複製しない。
3. 接続は既存 ServiceBindingRecord の binding_id を参照する。owner_kind=organization の owner_ref は tenant slug であり organization_id ではない。組織との関連は認可済み所在登録で明示する。
4. コレクターは typed registry の capture-only adapter とし、service actuator の既存 preset transport を再利用する。CLI risk の推測に頼らず明示 capture/read 宣言を確認する。
5. イベントは既存 ingestLocalEvent、仕事は既存 WorkItem・dot dispatch・承認・pipeline runner を正本とする。新しい汎用仕事状態ストアを作らない。
6. 既存 ingest asset ledger は取り込み済みカードの来歴を維持する。取得可能な所在定義と取得済み成果を分離し、source/version/asset provenance ref で結ぶ。

## 実装フェーズと受入項目

| ID    | 対象                    | 受入条件                                                                                                 | 状態        |
| ----- | ----------------------- | -------------------------------------------------------------------------------------------------------- | ----------- |
| IA-01 | 型・schema・3種情報定義 | 顧客依頼、レビュー依頼、承認待ち申請を定義し不正入力を拒否する                                           | implemented |
| IA-02 | 組織カタログ facade     | owner認可、tenant/org/project親子関係、CAS、lock、監査、symlink拒否を満たす                              | implemented |
| IA-03 | 取得先 resolver         | 意味/別名から検索し、scopeで先に絞り、正本/鮮度/接続状態/未観測を説明する                                | implemented |
| IA-04 | 収集契約と永続継続      | object IDとchange ID分離、全page受理後checkpoint、部分失敗/再開/競合/破損を試験する                      | implemented |
| IA-05 | Gmail adapter           | list/get/history、変更token、pagination、期限切れ明示保留に対応する                                      | implemented |
| IA-06 | GitHub adapter          | PR/review request収集、pagination、head/version差分を取り込む                                            | implemented |
| IA-07 | Jira adapter            | enhanced searchとJSM approval読取を分け、paginationに対応する                                            | implemented |
| IA-08 | intake接続              | catalogからcollectorを選び既存feed/event経路へ渡す。tenant/source/binding不一致時は通信しない            | pending     |
| IA-09 | 12業務レシピ            | メール4、GitHub4、Jira4を宣言し、同一業務の再取得で重複仕事を作らない                                    | implemented |
| IA-10 | 業務化・完了追跡        | typed contextで既存WorkItemへ渡し、外部read-back/成果物検証により完了を確認する。承認/相手待ちは保留する | pending     |
| IA-11 | 操作・参照面            | organization CLIから登録/一覧/解決/収集/仕事確認を実行でき、ViewerContext経由で見える範囲だけ参照する    | implemented |
| IA-12 | 来歴・運用可視性        | 取得元/版/hash/取得時刻/coverageと既存資産来歴を関連付け、未取得や不完全取得を成功表示しない             | pending     |
| IA-13 | fixture統合試験         | 3サービスを通じた取得→イベント→仕事→確認を、拒否/重複/再開/変更/不明結果込みで検証する                   | pending     |
| IA-14 | 文書・登録・検証        | runbook、schema/role/storage/op登録、生成物、関連testとbuildを整合させる                                 | pending     |

## 最初に用意する業務レシピ

- メール: 朝の仕分け、返信準備、依頼からのアクション抽出、対応・返信期限超過。
- GitHub: レビュー依頼、レビュー後の追加コミット、未解決レビュー指摘、担当PRのCI失敗。
- Jira: 担当割当、承認待ち、期限超過、情報待ちで止まったチケット。

## 信頼境界

- catalogのメタデータ自体をscopeで絞ってから検索・件数集計する。
- catalog登録は実行権限を付与しない。接続owner、許可action、現在のactor/scope/ポリシーを送信ごとに検証する。
- 外部payloadは非信頼データ。任意のop、URL、pipeline、宛先、tenantを選ばせない。
- provider変更・selector変更・scope変更時は既存checkpointを暗黙再利用しない。
- 受理結果不明・外部副作用不明は元attemptを照合し、自動で再送しない。
- 朝の処理はcutoffのあるbatchにし、その後の新着は次batch/streamに分ける。
- sourceの全件性、収集完了、イベント受理、業務完了は別々の証拠として表示する。
- live接続や定期実行は登録者が既存の承認・信頼設定を通して有効化する。実装作業では実メール送信や承認を実行しない。

## 検証と提出物

tenant/org/project混在、同名asset、接続取消、権限取消、CAS競合、同時収集、複数page、受理直後クラッシュ、部分失敗、同一objectの版違い、重複delivery、Gmail token期限切れ、承認待ち/取消/不明結果、外部state変更、出力lineageをfixtureで検証する。core build、actuator境界、Chronos typecheck/build、governance/catalog/op/input-contract/gate検査と独立レビューを実施する。各項目の完了状態と証拠をこの表と mission evidence に記録する。

## 検証記録（PR提出前）

- core TypeScript と full TypeScript を実行し成功。Chronos / concierge を含むビルドが成功。並行編集後は最終世代を再ビルドする。
- カタログの実 I/O・認可・CAS・coverage・scope拒否を fixture で検証。
- 3 provider の実 dots admission → WorkItem → claim → 成果物照合と、新版のみの再仕事化を検証。
- 統一認可のdeclared subject、authority強化時の拒否、承認domainとCedar出力を検証した。PR readiness gateの最終結果はPR本文に記録する。
- 実アカウントへの収集・更新は未実施。
