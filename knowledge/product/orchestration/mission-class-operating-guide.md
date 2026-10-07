---
title: Mission Class Operating Guide — クラス別の AI の進め方
category: Orchestration
tags: [mission, classification, playbook, organization, evaluation]
importance: 9
author: Ecosystem Architect
last_updated: 2026-10-07
runtime_stages: [alignment, planning, execution, verification, delivery]
---

# Mission Class Operating Guide

classify が決める「ミッションクラス」ごとに、**AI がどう進めるのが良いか**(任せる範囲・段階ごとの実践・ノウハウ・落とし穴・エスカレーション)を定義したもの。
機械可読な定義は [`mission-class-playbooks.json`](../governance/mission-class-playbooks.json)(スキーマ検証・全クラス網羅を契約テストで保証)。ミッション作成時に `mission-workflow.json` の `class_playbook` と `TASK_BOARD.md` の `> Playbook:` 行へ自動で付与され、チーム編成 brief にも載る。

## 1. クラス一覧(14)

| 区分               | クラス                                                                                                                               | 主な業務                                                       | 姿勢(posture)                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- | ---------------------------------------------------------------- |
| 組織機能(新規)     | `finance_and_accounting`                                                                                                             | 決算・請求/支払・経費・売掛・給与・予算・資金調達              | `prepare_for_approval` — AI は準備・照合、確定と実行は人間       |
|                    | `people_and_talent`                                                                                                                  | 採用・人事評価・入退社                                         | `advise_and_prepare` — 判断材料の用意まで。人に関する判断は人間  |
|                    | `legal_and_compliance`                                                                                                               | 契約レビュー・内部監査・規制対応・リスク・BCP                  | `analyze_for_review` — 分析は有資格者のレビューを経て使う        |
|                    | `strategy_and_governance`                                                                                                            | 事業計画・OKR・取締役会・M&A・提携・ゲートレビュー             | `advise_with_dissent` — 選択肢と反対論を示し、決定は決定者       |
|                    | `procurement_and_supply`                                                                                                             | ベンダー選定・仕入先登録・需給計画・受注/出荷                  | `prepare_for_approval`                                           |
| 既存(進め方を拡充) | `code_change` `product_delivery` `research_and_absorption` `content_and_media` `operations_and_release` `environment_and_recovery` … | コード変更・提供・調査・制作・運用・復旧・意思決定・顧客・導入 | 多くは `execute_within_guardrails`(承認範囲の内側で実行まで担う) |

組織機能クラスを分けた理由: これらは従来 `operations_and_release` / `decision_support` に混在し、**給与計算が `code_change` 扱いでソフトウェア開発ワークフローに流れる**、契約レビューに交渉リハーサル用ゲートが付く、といった誤りが起きていた。統制の型(お金・人・法・方向・供給)が違えば、必要なチーム・レビューゲート・AI の任せ方が違う。

## 2. 共通原則

1. AI は「準備・分析・照合・草案・記録」を担い、「承認・確定・約束・支払・採否」は人間が行う(posture が既定値)。
2. 根拠のない断定をしない。事実・推測・意見を区別し、確度と未確認事項を明記する。
3. 先に基準を決めてから対象を見る(評価基準・承認閾値・統制は成果物より先)。
4. 計算・引用・突合は暗算や記憶でなくツールと原文で行い、再現できる証跡を残す。
5. 反対意見・例外・未解決事項は隠さず、見直しトリガーか次アクションに紐づける。
6. 小さく可逆に進める(1変更1検証)。失敗を新しい仮説なしに繰り返さない。
7. 機密・個人・顧客情報は定められた階層とテナント境界の中だけで扱う。

## 3. 各クラスの要点(組織機能)

詳細(段階別の実践・ノウハウ・証跡)は JSON が正本。ここでは判断の勘所だけを示す。

- **経理・財務** — 数字を作る前に統制(職務分掌・承認閾値・照合元)を決める。明細単位で照合し、差異は「金額・原因・担当・次アクション」。**合計は暗算せずツールで再計算**。支払・転記は人間。ゲート `FINANCIAL_CONTROLS`。
- **人事・人材** — 評価基準は対象者を見る前に文書化(後付け禁止)。事実と解釈を分け、点数でなく根拠付き所見を渡す。属性の推定・自動足切りはしない。ゲート `PEOPLE_DATA_PROTECTION`。
- **法務・コンプライアンス** — 原文を全体で読み、所見は「条項番号・原文引用・リスク格付・修正案」。引用は原文と文字列照合。助言ではなく有資格者向けの分析として渡す。ゲート `LEGAL_REVIEW`。
- **経営企画・ガバナンス** — まず「何を決めるか」を1文に。前提に根拠と見直しトリガーを付け、最強の反対論を別視点で書き、不採用案を dissent-log に残す。ゲート `STAKEHOLDER_ALIGNMENT` `DISSENT_RESOLUTION` `ASSUMPTIONS_EXPLICIT`。
- **調達・サプライ** — 評価基準と重みを候補を見る前に確定し、TCO で同条件比較。利益相反と取引先リスクを独立に確認。発注・契約は承認権限者。ゲート `VENDOR_INTEGRITY`。

## 4. 評価と改善のサイクル

分類品質は感覚でなく数値で比較する。`mission-class-eval-corpus.json`(発話→期待クラス/意図/ワークフロー/チーム/ゲート)を `libs/core/mission/mission-class-eval.ts` が実チェーン(意図解決→分類→ワークフロー→レビュー設計)に通して 5 次元で採点する。コーパスは `dev`(チューニングに使う)と `holdout`(汎化の測定用、追加のみ)に分かれ、`neg-*` は他ドメインが組織クラスに誤って吸われないことの偽陽性ガード。

```bash
pnpm exec vitest run libs/core/mission/mission-class-eval.test.ts   # 床値(floor)を下回ると失敗し、差分を表示
```

### 4.1 改善の記録(2026-10-07)

| 反復                        | 変更                                                                                                                                                 | overall | dev   | holdout | class | intent | workflow | team  | gates |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- | ------- | ----- | ------- | ----- | ------ | -------- | ----- | ----- |
| 0 ベースライン(9クラス)     | —                                                                                                                                                    | 10.3%   | 12.8% | 0%      | 10.3% | 49.1%  | 4.5%     | 0%    | 2.2%  |
| 1 組織5クラス追加           | クラス/チーム/ゲート/ワークフロー/方針ルール/ontology フォールバック                                                                                 | 74.1%   | 76.6% | 63.6%   | 94.8% | 72.7%  | 75.0%    | 97.7% | 97.8% |
| 2 意図キーワード補強        | 欠落していた同義語(決算・督促・退職者…)を追加                                                                                                        | 94.8%   | 95.7% | 90.9%   | 98.3% | 94.4%  | 97.7%    | 100%  | 100%  |
| 3 新規 holdout 追加で再測定 | 未チューニングの発話16件を追加 → 一時的に低下                                                                                                        | 89.2%   | 100%  | 70.4%   | 90.5% | 98.2%  | 97.8%    | 88.3% | 90.2% |
| 4 汎化可能な同義語を補強    | 発話パターンの拡充(ただし偽陽性が出やすい語は除外)                                                                                                   | 98.6%   | 100%  | 96.3%   | 100%  | 98.2%  | 97.8%    | 100%  | 100%  |
| 5 偽陽性ガード追加と是正    | `nda`⊂`agenda`、`reconcil`、`inventory`、`見積`、`acquire`、`採用` など吸い込み語を除去/限定                                                         | 98.8%   | 100%  | 96.3%   | 100%  | 98.3%  | 97.8%    | 100%  | 100%  |
| 6 独立レビュー指摘の是正    | 汎用語(`acquisition` `lead time` `倉庫` `compliance` `オンボーディングを進め` 等)の吸い込みを除去し、負例4件を追加。リスクルールを高リスク語の後ろへ | 98.8%   | 100%  | 96.3%   | 100%  | 98.3%  | 97.8%    | 100%  | 100%  |

読み取り方:

- 反復 3 が示すとおり、**チューニング済みデータのスコアは汎化の証拠にならない**。新しい holdout を足すと一度下がる。これが測定の効いている証拠であり、足したあとに汎化可能な範囲だけ補強した(反復 4)。ただし反復 4 以降の holdout は部分的に見たものなので、次に測るときは**さらに新しい発話を追加**すること。
- 反復 4 では偽陽性を生みやすい語(`nda`、`reconcil`、`inventory`、`見積`、`acquire`、`strategic`、`採用` 単独)を入れかけて、`agenda`・`reconcile-knowledge-index`・業務棚卸し・工数見積り・「方式を採用」を組織クラスに吸ってしまう実害を偽陽性ガードで検出し、語を限定した(反復 5)。発話パターンは**部分一致**なので、短い英単語や一般語は入れない。
- 独立レビュー(別エージェント)が、実測に現れなかった吸い込み(`データ倉庫`→調達、`data acquisition`→経営企画、`顧客オンボーディング`→人事)を静的読解で指摘した。コーパスの偽陽性ガードは**実害を見つけた後に足す**のではなく、レビューで出た入力を負例として先に固定すること。
- 試して撤回した変更: 意図解決の同点を「一致キーワードの長さ」で破る案は意図の選択精度を上げた(overall 96.6%)が、`research reportを作って` が `bootstrap-project` から `generate-report` に変わり golden シナリオ(`golden-alignment-gated-high-stakes`)を壊したため撤回し、キーワード補強で対処した。グローバルな解決ロジックの変更は golden を壊しうるので、データ(キーワード・ルール)側で直せるならデータで直す。
- 解消した取りこぼし(反復 6): 「予実管理の会議の前に数字の乖離を確認しておいて」は、カレンダー意図スコアラーが「会議」を時間の目印として使われただけでも拾っていたため `schedule-read-agenda` に流れていた。語彙 `schedule.agenda_temporal_anchor`(「会議の前」「before the meeting」等)を判定前に取り除くようにし、budget-review に到達する。スコアラー全体は変えず、語彙データ+1語彙の除去だけで直した。
- 汎用推論意図の救済(反復 6): 9 意図のうち 7 つ(`diverge-hypotheses`・`multi-agent-consensus`・`counterfactual-simulation`・`adaptive-reasoning`・`chain-of-thought-planning`・`recall-prior-knowledge`・`active-learning-escalate`)は、**意図 かつ 特徴語句**の両方に当たるときだけ ontology 宣言のクラスにする(「反事実」「賛否」「立場から」「タスク分解」等)。意図の信頼度は本物の推論依頼と通常のコード依頼を区別できない(`shebang を追加して設計をテストして` も 0.79)ため、信頼度ではなく語句で絞った。`plan-and-execute` と `tool-use-expert` は任意のタスクの実行を指すので対象外のまま `code_change` に残る。コーパスに該当 7 件と、コード依頼が引きずられない負例 3 件を追加した。
- 未解決(意図解決そのものの精度): 「テスト失敗を分解して原因を探して」が `lifestyle-booking` に解決される。クラス規則では救えないため、意図キーワードの見直しが別途必要。

### 4.2 構造的な発見(分類そのものの欠陥)

- 改善前は ontology 上 `operations_and_release` 等の 143/168 件の意図が分類ポリシーのルールに当たらず既定値 `code_change` に落ちていた。mission 形の意図については **ontology の宣言クラスを参照**するようにした(`matched_rules.mission_class_rule_id = ontology-intent:<id>`)。task 形の汎用推論意図(`chain-of-thought-planning` 等)は誤解決されうるため対象外にし、通常のコード依頼が意思決定クラスへ引きずられる回帰を避けた。
- 組織系ワークフローは `delivery_shapes: [multi_artifact_pipeline]` を要求するが、配送形ルールが無く専用テンプレートに到達していなかった。組織意図の配送形・リスクを明示ルール化し、`mission-class-ontology-parity.test.ts` で「mission 形の全意図が ontology 宣言どおりのクラス・専用ワークフロー・リスクに到達する」ことを保証する。
- task 形・direct_reply 形の意図も、汎用推論パターン9件(`chain-of-thought-planning` 等、広いキーワードで誤解決されうる)を除き、ontology と同じクラスに分類される(ポリシーに `*-intent-ontology-parity` ルール追加、`mission-class-ontology-parity.test.ts` が全意図で保証)。除外した9件は既定値 `code_change` のまま。
- 発話パターンのうち `.*` や `(a|b)` を含むものは正規表現として評価する(従来は部分一致のため一度も一致しなかった)。

### 4.3 意図キーワードの見直し(2026-10-08, MSN-INTENT-KEYWORD-REVIEW-20261008)

クラス規則では救えない「意図そのものの誤選択」を、意図解決コーパス(`intent-resolution-eval-corpus.json`、`libs/core/intent/intent-resolution-eval.ts`)で測りながら直した。クラス評価コーパスとは別に、**utterance → 選ばれた意図**だけを測る。通常のコード依頼が意図に吸われないことを負例(`expect_no_intent`)で固定している。

| 測定                                      | 変更前 | 変更後 |
| ----------------------------------------- | ------ | ------ |
| dev(65, チューニング対象)                 | 63.1%  | 100%   |
| 最初の holdout(46, 一度直したので dev 化) | 43.5%  | 89%    |
| 未見の holdout3(34, 直す前に測定)         | 44.1%  | 70.6%  |

読み取り方: **dev と、直した後の holdout は汎化の証拠にならない**。直す前に測った未見セット(holdout3)の 44.1% → 70.6% が実際の改善幅である。

直した構造的な原因:

- 同点の決め方: 一致キーワード 1 個ずつで 0.67 の同点になり、**カタログ順**で意図が決まっていた(「天気」と「教えて」が同格)。同点時は、キーワードの希少度(そのキーワードがキーワード・例文に現れる意図の数の逆数)で決める。パケットの形は変えない。
- 英字キーワードの部分一致: `search` が `research` に当たっていた。英字キーワードは単語境界で照合する(複数形 `s`/`es` は許容)。
- 汎用語の過剰登録: `実行`・`追加して`・`テスト`・`バグ`・`更新`・`探して`・`調べて` などの汎用語が、推論パターン意図・リマインダー・生活予約・横断是正・知識検索の「単独で当たる」キーワードになっており、通常のコード依頼を吸っていた。削って、専用語(「再発防止」「ミッションの担当」「健康状態」等)を足した。同じ話題を持つ意図(天気・ニュース)は一方に寄せた。
- カレンダー読み取りスコアラー: 会議の議事録・録音・資料作成のように、会議が出どころにすぎない依頼も `schedule-read-agenda` になっていた。語彙 `schedule.agenda_non_calendar_object` で除外する。`カレンダー` を話題語に追加し、`動かし`・`延期` を変更の合図に追加した。
- golden の更新(理由つき): `golden-alignment-gated-high-stakes` の発話 `research reportを作って` は、`search` の誤一致のおかげで `bootstrap-project` に解決されていた。正しくは `generate-report` なので、高リスク工程の検証には `bootstrap-project` の例文 `新規事業の管理基盤を作って` を使う。`chain-of-thought-planning-ja` は `テスト` という汎用語に依存していたので、計画の依頼を明示する発話に差し替えた。

独立レビュー(別エージェント)の指摘で直したもの: 短い部分一致キーワード(`ヘルス`・`整合`・`中止`・`取り消`・`チケット`・`状況`・`毎日`・`中国語`・`類似`・`プレゼン` 等)が通常依頼を吸うので複合語に置き換えた。カレンダー除外語から `minutes`・`要約`・`資料`・`作って` を外した(「30 minutes 後の予定」を落とすため)。頻度表と英字キーワードの正規表現はカタログ単位でキャッシュする。golden は発話を差し替えただけでは挙動の変化が隠れるので、元の発話を **意図なし → `code_change`** として明示するシナリオ(`shebang-fix-no-intent-ja`)と、`research reportを作って` が `generate-report` に届くことを固定する golden(`golden-report-request-single-track`)を追加した。レビューが挙げた吸い込み例は意図解決コーパスの負例にした。

残る既知の取りこぼし(コーパスの床で許容): 「…と通知して」が会議語でカレンダー読み取りに流れる、「ログ出力を追加して」が `inspect-service` に流れる、「健康状態」が `inspect-service` と競合する、「ミッションを終了して締めて」等の言い換え。キーワードは**例文を増やすより汎用語を減らす**方が効く。新しい意図を足すときは、単独で当たる汎用語を `trigger_keywords` に入れず、複数語の専用語にする。

## 5. 新しいクラスを足すとき(チェックリスト)

足す前に ADR(`knowledge/product/architecture/decisions/`)で、既存クラスと**統制・チーム・ゲート・AI の任せ方が実質的に違う**ことを示す(ラベルの違いだけなら足さない)。足す場合の登録先:

1. スキーマ enum(`mission-classification*.schema.json`、`standard-intents.schema.json`、`intent-domain-ontology.schema.json`、`mission-task-classification-scenarios.schema.json`、`mission-class-eval-corpus.schema.json`、`mission-class-playbooks.schema.json`)と `MISSION_CLASS_VALUES` / `mapMissionClassToMissionTypeTemplate`
2. 分類ポリシー(`class-*` ルール、配送形/リスクルール)、ontology と standard-intents の `mission_class`、`pnpm exec tsx scripts/generate_artifact_kinds.ts`
3. チームテンプレート、ワークフロー(専用+クラス単位のフォールバック)、レビューゲート(`mode_rules` 含む)
4. `mission-class-playbooks.json` に全段階の進め方(契約テストが全クラス・全段階を要求)
5. 評価コーパスに dev と holdout と `neg-*` を追加し、床値を満たすこと
6. `process-definition-registry.json` の件数、`kyberion-intent-catalog.md` のクラス一覧
