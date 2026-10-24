---
title: '顧客との調整事項ヒアリングと決定の計画 (CD-01〜13)'
tags: [customer, hearing, decision, ai-dlc, agile, deal, invitation, plan]
last_updated: 2026-10-24
status: active
---

# 顧客との調整事項ヒアリングと決定の計画 (CD-01〜13)

- 前提: [stance-tenant-customer-model](../../../knowledge/product/architecture/stance-tenant-customer-model.md)、E2E-06 の顧客モード（`libs/core/customer-conversation.ts`、`customer-conversation-modes.ts`、`customer-channel-binding.ts`）、presence-studio の hearing（`hearing-scenario-catalog.ts`、`hearing-*.ts`）、MO-11 の alignment gate（PR #1223）、公開 ingress（PR #923）、決定台帳 SSOD（[SSOD_HEARING_INTEGRATION_PLAN](../improvement-plans-2026-09/SSOD_HEARING_INTEGRATION_PLAN_2026-09-14.ja.md)、`libs/core/decision-ledger/`、`pnpm decisions`）
- 関連: [AIDLC Integration Process](../../../knowledge/product/orchestration/aidlc-integration-process.md)、`mission-workflow-catalog.json` の `code-change-aidlc`、[Front desk 依頼キュー計画](./FRONT_DESK_INTAKE_QUEUE_PLAN_2026-10-05.ja.md)

## 背景

社内の作業はナレッジに沿って処理できるようになってきた。一方、顧客との調整は担当者が手で行っている。必要な部品はほぼ揃っている。

- 顧客向けの対話は社内の対話処理と別系統になっている。回答の根拠はカタログと商談の記録に限られ、こちらから送るときは必ず承認ゲートを通る。
- `requirements_hearing` モードが既にあり、hearing sheet と決定の受領記録もある。
- AI-DLC 形式のミッション工程（alignment → planning → contract_authoring → execution → test → self_review …）も既にある。

足りないのは次の 3 つである。

1. **「顧客に決めてもらうこと」を表すデータ**。今の hearing は要件を埋めるためのもので、選択肢・決定者・決定の優先順位を持たない。
2. **社外の人が入れる入口**。hearing は社内の閲覧者が使う前提になっている。
3. **AI-DLC の工程との接続**。顧客の判断が必要な箇所（要件の承認、範囲の確定、各 bolt のレビュー、実装中に出る判断）を、ミッションから顧客に回して結果を戻す経路がない。

本計画では、アジャイルな AI-DLC 形式でソフトウェアを受託開発する場合を最初の対象にする。この場合に、**顧客と調整したいことを定義し、Web 上でヒアリングし、決めてもらい、その結果がミッションに戻る**までをつなぐ。

## 方針（判断済み）

- **最初の対象は AI-DLC 形式の受託開発**。他の業務は、同じ仕組みに hearing sheet を追加して対応する。
- **決定は多段にする**。顧客の決定を最優先とし、顧客が決めていない間はこちらの決定で進める。顧客の返事を待って作業を止めない。詳細は「決定の層」の節。
- **本人確認は当面、招待リンクだけ**。機能を確認した後に強化する（CD-13）。ただし、招待リンクで記録した決定には本人確認の強さ（`identity_assurance: invite_link`）を必ず付けておく。後から「強い本人確認が必要な決定」を判別できるようにするためである。
- **選択肢はこちらの約束として扱う**。顧客に見せる選択肢・こちらの決定・影響の説明は、送る前に社内で承認する。顧客は承認済みの選択肢から選ぶか、コメントで「どれも違う」と返す。選択肢の外の回答は担当者へ回す。
- **AI が提案し、人が決める**。AI-DLC の原則と同じく、たたき台（ユーザーストーリー、受け入れ条件、分割案、選択肢、こちらの決定の案）は AI が作る。顧客はそれを承認・修正・選択する。顧客に白紙から書かせない。
- **顧客向けの画面は独立したプロセスにする**。社内向けの presence-studio は公開しない。調整セット 1 件分の画面と API だけを持つ専用の display を別プロセスで動かし、公開 ingress 経由で出す。E2E-06 の「顧客を社内の状態に近づけない」方針と同じ考え方である。
- **非同期を基本にする**。顧客はチャットに長く付き合わない。選んでコメントするだけのフォームを基本にし、曖昧な点だけ対話でヒアリングする（既存の `requirements_hearing` モードを使う）。
- **AI-DLC の単位の対応**: 受託案件 = project、AI-DLC Unit = WorkItem、bolt = ミッション。

## 用語

| 用語                             | 意味                                                                                                                                                                                         |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 調整事項（decision request）     | 顧客に決めてもらう 1 件。問い、背景、選択肢と影響、決定の層、回答の目安日、顧客側の決定者、決定後に動くものを持つ。                                                                          |
| 調整セット（decision agenda）    | 1 回の依頼でまとめて送る調整事項の束。例: 「Inception の確認事項 5 件」「bolt 3 のレビュー」。招待リンクは調整セットに対して発行する。                                                       |
| 決定の層（decision layer）       | 1 件の調整事項に対する決定の出どころ。優先順位つきで、既定は「顧客の決定 > こちらの決定 > 組織の既定値」。                                                                                   |
| 有効な決定（effective decision） | その時点で作業が従う決定。値を持つ層のうち、最も優先順位の高いものの値。                                                                                                                     |
| 決定記録（decision receipt）     | 層ごとの決定を記録したもの。誰が、いつ、どの版の選択肢に対して、何を選んだか。顧客の決定には本人確認の強さも付ける。                                                                         |
| AI-DLC Unit / Bolt               | AI-DLC の作業の切り方（Unit = 独立して作れる機能のまとまり、Bolt = 数時間〜数日の短い反復）。Kyberion の「Units of work」（GLOSSARY）と混同しないよう、本計画では必ず「AI-DLC Unit」と書く。 |

## 決定の層（多段の決定）

調整事項ごとに、優先順位つきの層を持つ。作業は常に「有効な決定」に従う。

| 優先 | 層           | 決める人                        | 有効な決定になったときの扱い                                               |
| ---- | ------------ | ------------------------------- | -------------------------------------------------------------------------- |
| 1    | 顧客の決定   | 顧客側の決定者                  | 確定。ただし金額・契約に関わるものは、CD-13 までは担当者の確認で確定にする |
| 2    | こちらの決定 | 担当者（AI の案を承認したもの） | 暫定                                                                       |
| 3    | 組織の既定値 | hearing sheet や選択肢のひな形  | 暫定                                                                       |

規則:

- **待たずに進める**。顧客が決めていなくても、こちらの決定（なければ組織の既定値）で作業を進める。顧客の決定なしでは進めてはいけないもの（契約・金額など）は `requires_customer: true` にし、下位の層を持たせない。そうした事項のある作業だけが判断待ちになる。
- **顧客には今の状態を見せる**。顧客の画面には「現在はこちらの決定 X で進めています」と、別の選択肢に変えた場合の影響（費用・期日・範囲、既に作ったものへの手戻り）を出す。顧客は「このままでよい」を選べ、それは顧客の決定として確定する。
- **上の層の決定が後から来たら切り替える**。顧客の決定がこちらの決定と違う場合、有効な決定が切り替わる。その決定を使っていた先（alignment brief、計画、ミッションのタスク、WorkItem）に変更を知らせ、既に作ったものへの手戻りは変更の WorkItem として起票する。費用や期日が変わる場合は、変更要求の調整事項として顧客に確認を返す。
- **上書きできる期間を決めておく**。調整事項ごとに上書きの締め切り（`override_until`、例: その bolt の着手、リリース）を持てる。締め切り後の顧客の変更は直接上書きせず、変更要求として扱う。
- **顧客側も多段にできる**。意見を言う人の回答は、決定者が承認するまで層に入らない参考情報として扱う。層の並びは調整事項ごとに変えられ、既定は上の 3 層とする。
- **履歴は追記だけ**。層ごとの値は上書きせず追記する。有効な決定は常に「どの層の、誰の、いつの、どの版に対する決定か」を返せる。
- **こちらの決定を変えるのも承認つき**。こちらの決定は調整セットの承認済みの版に含まれる。変えるときは新しい版として再承認する（`decision-rights` に従う）。

## AI-DLC で顧客に決めてもらう箇所

| 工程                        | 顧客が決めること                                           | 調整事項の形                               | 戻り先                                       |
| --------------------------- | ---------------------------------------------------------- | ------------------------------------------ | -------------------------------------------- |
| Inception: 意図             | 目的、成功条件、利用者                                     | ヒアリング（対話）                         | 商談の `requirements_ref`                    |
| Inception: 要件の具体化     | AI が作ったユーザーストーリーと受け入れ条件の承認・修正    | 成果物の承認（承認 / 修正依頼）            | alignment の brief                           |
| Inception: 非機能要件       | 性能、セキュリティ、可用性、対応環境                       | 選択（選択肢ごとに費用と期日の影響を示す） | alignment の brief                           |
| Inception: 分割と優先順位   | AI-DLC Unit の分け方、最初の bolt に入れる範囲（MVP）      | 並べ替えと範囲の選択                       | planning、商談の `agreed.scope`              |
| Construction: 実装中の判断  | 実装中に出る仕様上の分岐（例: 認証方式、データの保持期間） | 選択（こちらの決定つき）                   | 該当ミッションのタスク                       |
| Construction: bolt レビュー | デモを見て、受け入れ / 修正依頼 / 却下                     | 成果物の承認と、修正依頼の自由記述         | 次の bolt の計画、修正はバックログへ         |
| 変更要求                    | 途中で出た追加・変更を、今回入れるか後回しにするか         | 選択（範囲・費用・期日の影響つき）         | `agreed` の更新（`requires_customer: true`） |
| リリース                    | 本番に出すかどうか、運用への引き継ぎ条件                   | 承認（`requires_customer: true`）          | delivery、商談 stage を `delivered` へ       |

## 全体の流れ

1. 担当者（または AI-DLC ミッション）が調整事項を作る。AI がたたき台・選択肢・こちらの決定の案を作り、担当者が直す。
2. 調整セットを社内承認にかける。承認されたら、選択肢とこちらの決定の版を固定する（内容のハッシュで固定し、MO-11 の hash-bound brief と同じ扱いにする）。この時点から、こちらの決定が有効な決定になり、作業が進められる。
3. 招待リンクを発行し、紐付け済みのチャネル（メール / Slack 等）から `sendToCustomer()` で送る。この送信も承認ゲートを通る。
4. 顧客がリンクを開くと、調整セットの画面が出る。各事項で、今の決定と影響を見ながら、選ぶ・承認する・「このままでよい」を選ぶ・コメントする。曖昧な点は画面内の対話（`requirements_hearing` モード）で聞かれる。
5. 顧客が確定すると顧客の層に決定が記録され、顧客と担当者の両方に控えを返す。
6. 有効な決定が変わった場合は、戻り先（商談、alignment の brief、ミッションのタスク、WorkItem）に反映し、手戻りを起票する。
7. 選択肢の外の回答、範囲外の質問、`requires_customer` の事項で返事がない場合は、担当者へ回す。

## 項目

### 段階 1: Inception の縦切り（招待リンクで決めてもらえるところまで）

| ID    | 内容                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CD-01 | **調整事項のデータ型とスキーマ**: 調整事項・調整セット・決定記録を定義する（`knowledge/product/schemas/customer-decision-*.schema.json`）。調整事項の種類は `choice`（選択肢から選ぶ）、`approval`（成果物を承認 / 修正依頼）、`ranking`（並べ替えと範囲の選択）、`hearing`（対話で聞き取る）の 4 つ。調整事項の状態は `draft → pending_approval → open → customer_decided`（ほかに `closed`（上書きの締め切り後）/ `escalated` / `withdrawn`）。決定の値は SSOD の決定台帳に置き、調整セット・決定記録・切り替わりは同じ case の配下に置く（「段階 1 の実装設計」の節）。`system/` には何も置かない。 |
| CD-02 | **決定の層と有効な決定の解決**: 層の並び、`requires_customer`、`override_until` をスキーマに持たせる。`resolveEffectiveDecision()`（`libs/core`、副作用のない関数）が、層ごとの追記履歴から有効な決定と、その出どころ（層・決めた人・日時・版）と、暫定か確定かを返す。有効な決定が切り替わったときに、切り替わりのイベント（前の値、新しい値、出どころ）を出す。網羅的な単体テストを付ける（層の欠け、同じ値での確定、締め切り後の変更、`requires_customer`、版の不一致）。                                                                                                                           |
| CD-03 | **AI-DLC Inception の hearing sheet**: `hearing-scenarios.json` に `aidlc_inception` を追加する。段階は「意図」「要件の具体化」「非機能要件」「分割と優先順位」の 4 つ。各項目に組織の既定値を持たせられるようにする。語彙は `user-facing-vocabulary.json` に en / ja の両方で追加する。                                                                                                                                                                                                                                                                                                               |
| CD-04 | **たたき台の生成**: 意図のヒアリング結果から、ユーザーストーリー・受け入れ条件・非機能要件の選択肢・AI-DLC Unit の分割案と、それぞれのこちらの決定の案を AI が生成し、調整事項の下書きにする。選択肢には「費用」「期日」「範囲」の影響を必ず付ける。根拠はカタログ・価格表・テナントのナレッジに限る（顧客向け対話と同じ制約）。生成は typed op として実装し、pipeline の文字列 JS にしない。                                                                                                                                                                                                          |
| CD-05 | **社内承認と版の固定**: 調整セットを approval-actuator 経由で承認にかける。承認時に内容のハッシュを記録し、以後の変更（こちらの決定の変更を含む）は新しい版として再承認する。顧客の回答は必ず特定の版に結び付ける。操作は facade（`pnpm kyberion customer-decision draft / submit / send / status`）から行う。                                                                                                                                                                                                                                                                                         |
| CD-06 | **招待リンク**: 調整セット 1 件に対して招待トークンを発行する。トークンはランダム値で、保存するのはハッシュだけにする。有効期限、取り消し、利用回数の記録を持つ。リンクで入れるのは、その調整セットの閲覧と回答だけ。トークンからはテナントと調整セットを解決するだけで、他の調整セット・商談・ミッションには届かない。招待時に顧客側の参加者名と役割（決定者 / 意見を言う人）を指定する。                                                                                                                                                                                                             |
| CD-07 | **顧客向けの画面**: 新しい display（仮称 `customer-room`）を独立したプロセスとして作り、loopback で待ち受けて公開 ingress（Tailscale Funnel）から出す。画面は A2UI の kyberion-base kit で作り、i18n は en / ja を必須にする。調整事項ごとに、問い・背景・今の有効な決定とその出どころ・選択肢と変えた場合の影響・「このままでよい」・コメント欄を出す。`hearing` 種別の事項は、`runCustomerConversation` の `requirements_hearing` モードで対話する。`active-surfaces.json` への登録と、境界テスト（他の調整セットや社内 API に届かないこと）を同時に入れる。                                         |
| CD-08 | **決定記録と反映**: 決定者が確定したら顧客の層に記録する。内容は、回答、参加者、版のハッシュ、日時、`identity_assurance: invite_link`、監査チェーンへの記録。控えを顧客（画面と紐付け済みのチャネル）と担当者に返す。CD-02 の切り替わりイベントを受けて、商談の `requirements_ref` と `agreed.scope`、MO-11 の alignment brief の入力を更新する。金額・契約に関わる決定は、担当者が確認するまで暫定とする。                                                                                                                                                                                            |

### 段階 2: Construction への接続

| ID    | 内容                                                                                                                                                                                                                                                                                                                                                                                                   |
| ----- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| CD-09 | **実装中の判断を顧客に回す**: AI-DLC ミッションの実行中に出た問いのうち、顧客の判断が必要なものを分類する（`question-resolution-playbook` の分類に「顧客判断」を追加する）。該当するものは、こちらの決定つきの調整事項にし、ミッションはこちらの決定で先に進める。`requires_customer` の事項だけはタスクを判断待ちにする。顧客の決定で有効な決定が変わったら、手戻りを変更の WorkItem として起票する。 |
| CD-10 | **bolt レビュー**: bolt の完了時に、デモ（プレビュー URL、スクリーンショット、変更点の要約）を `approval` 種別の調整事項として送る。上書きの締め切りは次の bolt の着手にする。受け入れなら次の bolt へ進み、修正依頼はバックログ（WorkItem）に、却下は担当者に回す。プレビューは調整セットの画面内に置き、社内の環境は公開しない。                                                                     |
| CD-11 | **リマインドと担当者への引き継ぎ**: 回答の目安日の前のリマインド（Chronos のトリガ、紐付け済みチャネル経由）、上書きの締め切りが近い事項の知らせ、選択肢の外の回答と範囲外の質問の担当者への引き継ぎを入れる。リマインドの送信も承認ゲートを通す（定型文はあらかじめ承認しておける）。                                                                                                                 |

### 段階 3: 運用と強化

| ID    | 内容                                                                                                                                                                                                                                                                                                                                     |
| ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CD-12 | **可視化と学習**: Chronos の組織ビューに、暫定のまま進んでいる決定、顧客の判断待ち（`requires_customer`）、締め切り間近、担当者行きを出す。テナントは `ViewerContext` で絞る。こちらの決定が顧客に覆された率、繰り返し出る問い、修正依頼の多い選択肢を distill の対象にし、hearing sheet・組織の既定値・選択肢のひな形の改善につなげる。 |
| CD-13 | **本人確認の強化**（機能確認の後）: 招待リンクに加えて、メールでのワンタイム確認やパスキーを選べるようにする。調整事項ごとに必要な本人確認の強さ（例: 金額・契約に関わる決定はメール確認以上）を指定し、強さが足りない顧客の決定は暫定のままにする。段階 1〜2 では強さを記録するだけで、強制はしない。                                   |

## テナント境界と権限

- 調整セット・決定記録・招待トークンは、すべてテナント配下に置く。トークンからはそのテナントの、その調整セットしか解決できない。
- 顧客向けの画面は、社内の viewer スコープの仕組みを使わない。招待トークンだけで解決する別の principal（`customer_invitee`）として扱う。社内 API とは別のプロセス・別の HTTP サーバで動かす。
- 顧客に送るものと見せるものは、社内承認済みの版だけにする。AI が対話中に作った文章も、顧客向け対話と同じ制約（根拠はカタログ等に限る、範囲外は保留して担当者へ）に従う。
- 決定記録の作成・招待の発行と取り消し・送信・有効な決定の切り替わりは、すべて監査チェーンに記録する。

## 検証

- 段階 1 の受け入れ: 架空の顧客テナントで、意図のヒアリング → たたき台の生成 → 社内承認（こちらの決定で作業が進められる状態）→ 招待リンク送付 → 顧客がスマートフォンで開いて回答 → 有効な決定の切り替わり → alignment brief に反映、までを結合テストと実機の両方で確認する。
- 決定の層: 顧客が未回答の間はこちらの決定が有効、顧客の決定で切り替わる、「このままでよい」で暫定から確定になる、締め切り後の変更は変更要求になる、`requires_customer` の事項は下位の層で進まない。
- 境界: 招待トークンで別の調整セット、別テナント、社内 API に届かない。取り消し済み・期限切れのトークンは拒否する。トークンの平文は保存されていない。
- 版の固定: 承認後に内容を変えると再承認が必要になる。古い版への回答は新しい版に流用されない。
- 退行: 既存の `requirements_hearing` モードと presence-studio の hearing（`web_app_build` / `work_inventory` / `process_improvement`）の挙動が変わらない。

## 判断済みの事項（2026-10-24 追記）

- `requires_customer: true` の既定: 金額・契約・リリース・変更要求。
- **決定の切り替わりの伝え方: タスクの境界で照合し、実行中のタスクには割り込まない**。
  - ミッション（bolt）は、タスクの開始時に有効な決定を読み、使った決定の id と値を固定する（SSOD の `DecisionLock` と同じ形）。
  - タスクの完了時（evidence を記録する前）に、固定した値と今の有効な決定を照合する。違っていれば、そのタスクの成果を「古い決定に基づく」とし、手戻りを変更の WorkItem として起票する。
  - 実行中のタスクには割り込まない。途中で止めると成果が中途半端に残り、どこまでが古い決定に基づくかが分からなくなるためである。bolt は数時間〜数日と短く、境界での照合で十分に早い。
  - 段階 1 では、照合の純関数と切り替わりの記録（`switches.jsonl`）までを作る。ミッションの実行器への組み込みは CD-09 で行う。
- **運用者の確認は customer-decision の層の概念とする**（2026-10-24 第 2 回レビュー）。`requires_customer` の項目で顧客が決めた値は、台帳では `state: decided` の記録のまま変えない。確認は承認ゲート（`customer_decision:operator_confirm`、相関 id `<agenda>:<entry>:<decision_id>`）を通り、調整セットの `operator_confirmations` に記録する。`--by` は依頼者で、権限そのものではない。確認済みかどうかを知る読み手は、台帳の `state` ではなく有効な決定の解決（`resolveAgendaEffective`）を使う。
- **台帳への書き込みはすべて台帳ごとのロックで直列化する**。ロックは `appendDecisions` / `applyPromotions` の中で取り（書き手が取り忘れない）、同じプロセス内では入れ子にできる。customer-decision は案件ロック → 台帳ロックの順で取り、respond の id の事前割り当てから台帳への追記までを包む。`pnpm decisions` は台帳ロックだけを取るので、順序が逆になることはない。
- **respond の先行記録（`respond-journal/`）は台帳の隣に置く**。先行記録は台帳に書く決定の id を前もって割り当てて守るものなので、その決定と同じ `decision_ledger` 権限・同じテナント範囲・同じロックの下で読み書きする。中身（決定記録）も同じ confidential のデータである。完了すると消し、残っているものは reconcile が完了させる途中の実行であって、作り直せるキャッシュではない。
- **顧客が答えられない項目は送らない**。`submit` は、案（`our_decision.value`）のない `approval` の項目と、選択肢のない `ranking` の項目があれば、項目を列挙して拒否する。`requires_customer` の `approval` は schema でこちらの決定を持てないため対象外で、問いそのものを承認してもらう。

## 段階 1 の実装設計

**決定の正本は SSOD の決定台帳に置く**。新しい決定の保存先は作らない。本計画で足すのは、決定台帳の上に載る「依頼と表示の層」（調整セット、招待、決定記録、切り替わり）である。

| 本計画の概念 | 決定台帳での表現                                                                                                                                                                      |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 案件         | 決定台帳の case（`knowledge/confidential/<tenant>/decisions/<case>/`）。case id は project id または deal id                                                                          |
| 調整事項     | 台帳の 1 つの item × key と、調整セットの 1 項目（問い・背景・選択肢と影響・層・`requires_customer`・`override_until`）                                                               |
| 顧客の決定   | `level: customer-value`、`state: decided` の記録。`decided_by.on_behalf_of` が顧客 actor（`customers/<customer>/actors.json`）、`evidence` が決定記録の id                            |
| こちらの決定 | `level: customer-value`、`state: proposed` の記録で、id が承認済みの調整セットの版に固定されているもの。版に固定されていない proposed（会話中の答えなど）はこちらの決定として扱わない |
| 組織の既定値 | 調整セットの項目が持つ値（hearing sheet のひな形から来る）。台帳には書かない                                                                                                          |
| 上書き       | 台帳の `supersedes`（追記のみ）。顧客の決定はこちらの決定を supersede できるが、逆はできない（facade が拒否する）                                                                     |

置き場:

- 調整セット: `knowledge/confidential/<tenant>/decisions/<case>/agendas/<agenda_id>.json`
- 決定記録: `knowledge/confidential/<tenant>/decisions/<case>/receipts/<receipt_id>.json`
- 切り替わりの記録: `knowledge/confidential/<tenant>/decisions/<case>/switches.jsonl`
- 招待（秘密値のハッシュのみ）: `active/shared/runtime/customer-decision-invites/confidential/<tenant>/<invite_id>.json`（tier-guard と tenant scope の保護対象になる `<root>/<tier>/<tenant>` の並び）

モジュール:

- `libs/core/customer-decision/`: 型、内容ハッシュ、有効な決定の解決（純関数）、切り替わりの検出、照合、招待トークン、保存。
- `scripts/customer_decision.ts`（`pnpm kyberion customer-decision`）: 書き込みの唯一の窓口。`draft` / `generate` / `submit` / `send` / `status` / `revoke`、および顧客向け画面が子プロセスとして呼ぶ `view` / `respond`。台帳への書き込みは `libs/core/decision-ledger` の関数を使う。
- `presence/displays/customer-room/`: 独立したプロセス。1 プロセスは 1 テナントだけを扱う（`KYBERION_CUSTOMER_ROOM_TENANT`）。招待トークンは URL のフラグメントで渡し、画面からはヘッダで送る（サーバのアクセスログに残さない）。読み書きとも facade の子プロセスを通し、ライブラリから台帳を直接触らない。
- 段階 1 では、`hearing` 種別の事項は自由記述で受ける。画面内の対話（`requirements_hearing` モード）は段階 1 の後の改善で入れる。

## CD-09 の実装設計（2026-10-24）

**何を固定するか**: タスクの開始時に、そのミッションの案件で効いているすべての決定（閉じていない調整セットの全項目の有効な決定）を固定する。タスクがどの決定を使ったかは分からないため、案件の全体を保守的に固定する。手戻りの WorkItem には変わった項目だけを並べ、要否は担当者が判断する。

**案件の見つけ方**: ミッションの `tenant_slug` と `relationships.project.project_id` を使う。無ければ `mission_ids` にそのミッションを含む商談の deal id を使う。どちらにも決定台帳の案件ディレクトリが無ければ、何もしない（顧客の決定と無関係なミッションの動作は変えない）。

**固定の置き場**: `knowledge/confidential/<tenant>/decisions/<case>/consumers/<consumer>.json`（`ConsumedDecisionLock`、schema つき）。値は顧客のデータなので案件と同じ tier・テナントに置き、`decision_ledger` 権限で読み書きする。ミッションの evidence（public）には固定の件数と照合の結果（古いかどうか、起票した WorkItem の id）だけを書き、項目名や値は書かない。

**照合する場所**（実行中のタスクには割り込まない）:

| 時点         | 場所                                                                                                       |
| ------------ | ---------------------------------------------------------------------------------------------------------- |
| タスクの開始 | worker: `dispatchPlannedMissionTaskCore` の WorkItem 取り込みの直後。CLI: `recordTask`                     |
| タスクの完了 | worker: 成功の確定（WorkItem を `done` にする）の直前。CLI: `recordEvidence` が台帳に記録する直前          |
| 顧客の回答   | `customer-decision respond` が切り替わりを記録した後。切り替わった項目を固定している完了済みのタスクを探す |

古い決定に基づく成果は、タスクを止めずに完了させ、手戻りの WorkItem を起票する（`createWorkItemIfAbsent`、id はミッション・タスク・切り替わった決定から決めるので、完了時と回答時の両方で見つけても 1 件になる）。

**実装中の判断を顧客に回す**: worker の結果に、文字列の `needs` とは別の構造化した `customer_decisions`（問い・item・key・こちらの案・選択肢・`requires_customer`・理由・話題）を足す（`TaskResultBlock`、`TaskCustomerDecisionRequest`）。形の崩れた項目は警告を出して捨て、結果全体は失敗にしない。question-resolution に「顧客判断」（`customer_judgment`）の分類を足す。技術の選択はこちらで決め、顧客に見える製品の選択は顧客判断としてこちらの案で進め、金額・契約・リリース・変更要求は `requires_customer` にする（policy の `customer_judgment.requires_customer_topics` に当たる話題は、worker が何と言っても `requires_customer` になる）。

- **worker に調整セットを書く権限を与えない**。worker は結果を記録する前に `customer_decisions` を取り除き、そのタスク自身の固定（`consumers/<consumer>.json`）に `task_proposal` の層の項目として記録する（狭い `customer_decision_consumer_store` 権限のまま）。ミッションの evidence・タスクのイベント・`NEXT_TASKS.json`・WorkItem には、問いや値を書かず、提案の id（`tp-<hash>`）と件数だけを書く。
- **調整セットへの取り込みは運用者が行う**。`pnpm kyberion customer-decision draft --tenant <t> --case <c> --from-tasks --customer <slug>`（既存の下書きに足すときは `--agenda <id>`）が、まだ調整セットに載っていない提案を下書きの項目にする。選択肢があれば `choice`、なければ `approval` で、こちらの決定はタスクの案にする。`requires_customer` の問いは schema の規則どおりこちらの決定を持たない。同じ item × key を別の開いている調整セットが聞いていれば、項目を足さずにその項目に結び付ける。ただし `requires_customer` の問いは、`requires_customer` でない項目には結び付けない。その項目が下書きなら `requires_customer` に上げ（こちらの決定と組織の既定値を外す）、承認済み・送付済みなら取り込まずに衝突として出す。取り込んだ提案には固定の側に調整セットと項目の id を書き戻すので、2 回目の取り込みでは何も足さない。承認と送付は既存の `submit` / `send` で行う。`status`（`--agenda` は省略できる）は、取り込み待ちの提案と、顧客の判断を待っているタスクを id と件数で出す。
- **タスクはこちらの案で完了する**。固定に提案の値が残るので、顧客が後から違う値に決めると、回答時の照合が手戻りの WorkItem を 1 件起票する。取り込む前の提案と、誰もまだ決めていない提案は照合しない。
- **`requires_customer` の問いだけはタスクを判断待ちにする**。WorkItem は `blocked`（`blocked_reason: awaiting_customer_decision`）、タスクは `blocked` で、`evidence/task-clarification-<task>.json` には id と件数だけを書く。顧客の決定を運用者が確認すると（`confirm` の後の照合）、固定に解決を記録し、WorkItem の `metadata.customer_decision_hold` に解決した決定の id を書く。タスクの再実行は既存の再開（`pnpm mission resume <MISSION_ID>`、blocked のタスクを planned に戻す）で行う。worker はタスクを渡すたびに固定を作り直すが、タスク自身の提案（取り込み済み・解決済みを含む）は引き継ぐので、調整セットが閉じられた後でも同じ問いを聞き直さない。
- **決定の案件がないミッション**では台帳に何も書かず、診断の警告を出す。`requires_customer` の問いは通常の `needs` として扱い（`needs_input` で止まる）、それ以外はこちらの案で進める。

## CD-10 の実装設計（2026-10-24）

**始め方**: bolt（ミッション）の完了で自動では送らない。顧客に見せる画面と要約は担当者が選ぶ（ミッションの evidence には社内の情報が混じるため）。`finish` は、ミッションに決定台帳の案件があれば、bolt レビューの下書きを作るコマンドを次の一手として示す。担当者は `customer-decision bolt-review --tenant <t> --case <case> --mission <MSN> --summary-file <path> [--attach <png|jpeg|webp>]... [--preview-url <https URL>] --customer <c>` で下書きを作り、既存の `submit`（承認ゲート）と `send` で送る。

**調整セット**: ひな形 `bolt-review` の `approval` 項目 1 つ。問いは「この bolt の成果を受け入れますか」、背景が変更点の要約、こちらの決定は「受け入れ」。上書きの締め切りは `{kind: milestone, milestone: "bolt-after:<MSN>"}`。

**次の bolt の着手**: `startMission` は、そのミッションの案件にある未完了の bolt レビューのうち、別の完了済みミッションの分について `bolt-after:<MSN>` を `milestones_passed` に足す（案件ロックの下）。着手は顧客の回答を待たない（こちらの決定で先に進む）。締め切りの後の顧客の回答は、既存の変更要求として扱う。

**添付**: 項目の `attachments`（`{id: sha256, name, media_type, bytes}`）と `links`（`{label, url}`）。どちらも内容ハッシュに入る（顧客は見た物そのものを承認する）。画像は `decisions/<case>/attachments/<sha256>.<ext>` に置き、png・jpeg・webp だけ、1 枚 512 KB まで、1 項目 6 枚まで。リンクは https だけで、localhost・プライベート IP・`.local`・`.internal` は拒否する（社内の環境を公開しない）。

**顧客向け画面**: 画像は facade の新しい動詞 `attachment`（招待トークンを stdin で受け、送付済みの調整セットの項目に載っている id だけを返す）を通して配る。画面は Bearer ヘッダつきで取得して `blob:` URL で表示する（`img-src` に `blob:` を足す、`nosniff`）。リンクは外部リンクとして `rel="noopener noreferrer"` で開く。

**回答の行き先**: `approval` 項目に「却下」（`reject`、コメント必須）を足す。

| 回答                          | 行き先                                                                                                                                                   |
| ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 受け入れ（`approve`）         | 有効な決定になる。次の bolt はそのまま進む                                                                                                               |
| 修正依頼（`request_changes`） | バックログの WorkItem を起票する（id は調整セット・項目・決定の id から決め、1 件にする）。WorkItem には id と件数だけを書き、顧客の文面は案件の側に残す |
| 却下（`reject`）              | 担当者に知らせる（`notifyOperator` と受信箱）。WorkItem は作らない                                                                                       |

行き先への反映は respond の後に行い、失敗しても顧客の回答は失敗させない（次の respond・`status` で再試行する）。

## 未決事項

- 顧客向け画面内の対話ヒアリング（`requirements_hearing` モード）の入れ方（段階 1 の後）。

## 実装状況（2026-10-24）

段階 1（CD-01〜08）を実装した（ブランチ `feat/customer-decision-20261024`、ミッション `MSN-CUSTOMER-DECISION-20261024`）。

| ID    | 状況                                 | 実装の位置                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ----- | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| CD-01 | 完了                                 | `libs/core/customer-decision/{model,store,hash}.ts`、`customer-decision-{agenda,receipt,switch}.schema.json`                                                                                                                                                                                                                                                                                                                                                         |
| CD-02 | 完了                                 | `libs/core/customer-decision/effective.ts`（有効な決定・切り替わり・照合・上書きの可否）。承認済みの決定は編集中も `in_force` で効力を保つ                                                                                                                                                                                                                                                                                                                           |
| CD-03 | 完了                                 | `hearing-scenarios.json` の `aidlc_inception`、`customer-decision-templates/aidlc-inception.json`、語彙 `customer_decision:*`                                                                                                                                                                                                                                                                                                                                        |
| CD-04 | 完了                                 | `libs/core/customer-decision/{template,draft}.ts`、`customer-decision generate`。推論が使えないときは組織の既定値を案にする                                                                                                                                                                                                                                                                                                                                          |
| CD-05 | 完了                                 | `customer-decision submit`（承認ゲート、内容ハッシュ、こちらの決定を台帳の proposed として固定）                                                                                                                                                                                                                                                                                                                                                                     |
| CD-06 | 完了                                 | `libs/core/customer-decision/invite.ts`、権限 `customer_decision_invite_store`（招待の置き場だけに絞った capability）                                                                                                                                                                                                                                                                                                                                                |
| CD-07 | 完了（対話ヒアリングは未）           | `presence/displays/customer-room/`。`hearing` 種別は自由記述で受ける                                                                                                                                                                                                                                                                                                                                                                                                 |
| CD-08 | 完了                                 | `libs/core/customer-decision/{respond,reflect}.ts`、`customer-decision respond`（台帳 → 決定記録 → 切り替わり → brief 入力・商談メモ）                                                                                                                                                                                                                                                                                                                               |
| CD-09 | 完了                                 | `libs/core/customer-decision/consumption.ts`、`libs/core/mission/mission-decision-lock.ts`、`customer-decision draft --from-tasks`（ブランチ `feat/customer-decision-cd09-20261024`、ミッション `MSN-CUSTOMER-DECISION-CD09-20261024`）                                                                                                                                                                                                                              |
| CD-10 | 第 1 波完了（顧客向け画面は第 2 波） | `libs/core/customer-decision/bolt-review.ts`（添付の検査・リンクの検査・回答の行き先）、`libs/core/mission/mission-bolt-review.ts`（次の bolt の着手で `bolt-after:<MSN>`、`finish` の次の一手、WorkItem・担当者への通知）、権限 `customer_decision_milestone_store`（調整セットのファイルだけに絞った capability）、`customer-decision bolt-review` / `attachment`、ひな形 `bolt-review`、`approval` の `reject`（ブランチ `feat/customer-decision-cd10-20261024`） |

第 2 回レビューの対応（2026-10-24）:

- 台帳ロック: `libs/core/decision-ledger/ledger.ts` の `withDecisionLedgerLock`。`pnpm decisions` と customer respond を別プロセスで同時に走らせても、どちらの記録も失われない（`scripts/customer_decision.test.ts`）。
- reconcile は先行記録ごとに失敗を受け止め、`status` の `reconciled.stuck` に診断コードつきで出し、`respond_reconcile` の失敗として監査に残す。1 件の壊れた記録が案件や `status` を止めない。
- 監査の冪等性: 先行記録に `auditing` の段を足した。監査の追記の前後で止まった実行は、監査チェーンにその決定記録の `respond completed` があれば書き足さない。
- `confirm` は承認ゲートを通る。`close` / `withdraw`（`--agenda <id> --by user:<member> [--reason]`）を足した。`withdraw` は未失効の招待をすべて失効させる。どちらも同じ item × key を別の調整セットで聞けるようにする。
- 顧客向け `view` の追加: 項目ごとの `current.status` / `current.awaiting_operator_confirmation`、`agenda.from`（設定時のみ）、`approval` の項目の `draft`。`from` は `draft --from` / `draft --file` で設定し、内容ハッシュに含める（未設定の調整セットのハッシュは変わらない）。
- `scripts/customer_decision.ts` は入口だけにし、本体を `scripts/customer-decision/`（`common` / `operator` / `operator-lifecycle` / `reconcile` / `customer-facing`）に分けた。

使い方（運用者）:

```bash
pnpm kyberion customer-decision draft --tenant <t> --case <case> --customer <c> --template aidlc-inception --locale ja
pnpm kyberion customer-decision generate --tenant <t> --case <case> --agenda <id> --intent-file <path>
pnpm kyberion customer-decision submit --tenant <t> --case <case> --agenda <id> --by user:<member>
pnpm kyberion customer-decision actor-add --tenant <t> --case <case> --customer <c> --actor customer:<id> --name <name>
pnpm kyberion customer-decision send --tenant <t> --case <case> --agenda <id> --name <name> --role decider --actor customer:<id>
pnpm kyberion customer-decision status --tenant <t> --case <case> --agenda <id>
pnpm kyberion customer-decision status --tenant <t> --case <case>   # タスクの提案と判断待ちのタスク（CD-09）
pnpm kyberion customer-decision draft --tenant <t> --case <case> --from-tasks --customer <c>
pnpm kyberion customer-decision bolt-review --tenant <t> --case <case> --mission <MSN> --customer <c> --summary-file <path> [--attach <png>]... [--preview-url <https URL>]   # CD-10
pnpm kyberion customer-decision confirm --tenant <t> --case <case> --agenda <id> --entry <entry_id> --by user:<member>
pnpm kyberion customer-decision close --tenant <t> --case <case> --agenda <id> --by user:<member>
pnpm kyberion customer-decision withdraw --tenant <t> --case <case> --agenda <id> --by user:<member> --reason <text>
KYBERION_CUSTOMER_ROOM_TENANT=<t> node dist/presence/displays/customer-room/server.js   # 公開 ingress の背後で動かす
```

後続の改善（段階 1 の後）:

- 顧客向け画面内の対話ヒアリング（`requirements_hearing` モード）。
- 招待リンクを紐付け済みチャネルから送る（`sendToCustomer` の `deliver` を持つブリッジ側で行う。CLI はリンクを運用者に一度だけ表示する）。
- 公開 ingress の背後では接続元がすべて 127.0.0.1 になるため、レート制限は全顧客で共有になる。信頼するプロキシ段数の設定を入れて `X-Forwarded-For` を使う。
- 商談メモの項目名を問いの全文ではなく短いラベルにする（テンプレートに `label_key` を足す）。
- CD-09: ミッションの実行器に、タスク境界での照合（`checkDecisionFreshness`）を組み込む。（実装済み。「CD-09 の実装設計」の節）
- CD-09 の残り: 判断待ちから再開したタスクの指示に、確定した顧客の決定の値を渡していない（値は confidential なので、渡し方を決めてから入れる）。
- CD-09 の残り: 判断待ちの解除（`confirm` の後の照合）を、実際の運用者の identity で動かす結合テストを足す（今のテストは facade の関数を直接呼ぶ）。
- CD-09 の残り: 1 つの固定ファイルだけを対象にする capability は、照合（sweep）とタスクの境界とで同じ形になり、guard では区別できない。タスク境界の呼び出し元が自分の固定ファイルだけに書けることを、capability の中の owner で guard が確かめるようにする。
- 顧客の決定で、商談の `requirements_ref` と `agreed.scope` も更新する（段階 1 では商談メモへの追記と brief 入力への反映まで）。
- 招待リンクの公開 URL をテナントごとに持つ（段階 1 は `KYBERION_CUSTOMER_ROOM_PUBLIC_URL` が 1 つで、顧客向け画面を 1 テナント分だけ公開する前提）。
- 回答の復旧時に監査の重複を確かめる処理が監査チェーン全体を読む。受領 id で引ける索引か冪等キーにする（復旧時だけ通る経路）。
- `generate` で `ranking` 項目の選択肢（AI-DLC Unit の候補）も作る。今は運用者が `draft --file` で入れる必要がある。
