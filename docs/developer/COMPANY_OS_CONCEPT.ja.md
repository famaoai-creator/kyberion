# Kyberion で AIスタートアップを回す — 組織構成と業務の進め方のコンセプト

> **作成日**: 2026-07-03
> **問い**: 「私 + Kyberion」で AIスタートアップ企業を回せるか。組織構成の作り方・業務の進め方のコンセプトをどう表現するか。
> **位置づけ**: コンセプトの参照文書 + 表現方法の見本。思想の土台は [FABLE5_AGENT_MODEL](./FABLE5_AGENT_MODEL.ja.md) / [ORCHESTRATION_HARNESS_MODEL](./ORCHESTRATION_HARNESS_MODEL.ja.md) / [AUTONOMOUS_MAINTENANCE_JUDGMENT](./AUTONOMOUS_MAINTENANCE_JUDGMENT.ja.md)。既存の概念スパインは `knowledge/product/architecture/enterprise-operating-kernel.md` と `organization-work-loop.md`。Company OS 完成のための実装は [improvement-plans-2026-07](./improvement-plans-2026-07/README.ja.md) の CO 系。

---

## 0. 結論(可能か)

**構想としては、Kyberion は「1人 + AI で会社を回す」ためにほぼ設計されている。** 「sovereign(1人の主権者)が intent を与え、mission がエージェント群を統べ、証跡と記憶を残す」という中核モデルそのものが、少人数 AI 企業の経営構造である。既存の `enterprise-operating-kernel.md`(重要度10)は明言する — 「Leadership が intent と承認を与え、Kyberion が解決・実行・会計・学習する」。`organization-work-loop.md` は同じループが「会社設立・製品開発・コンプライアンス・財務運用・顧客報告・サービス運用」を統べると宣言する。

**ただし実装成熟度は「概念スパイン + 個別部品は本番、company-level の統合は未完」。** 部品(vision・role・authority・agent・tenant・mission class・99 pipeline template・organization-profile・capability broker)はいずれも実在し、多くは production。しかし「会社を1つのエンティティとして束ねる層」「財務/KPI/OKR のモデル」「組織図のデータ化」「意思決定権限のデータ化」は概念文書止まり(§4)。

したがって率直な評価は — **今日でも「業務の遂行」は既存プリミティブで表現・実行できる。だが「会社そのものの経営(組織・財務・意思決定を束ねた company OS)」を完全に回すには、統合層の実装が要る**(それが CO 系計画)。まず今できることを最大限使い、足りない層を段階的に足す、が現実的な道。

---

## 1. マッピング — AIスタートアップの構成要素 → Kyberion プリミティブ

「会社とは何でできているか」を Kyberion の表現手段に対応させる。**これがコンセプトを表現する土台**。

| 会社の要素                   | Kyberion での表現                                                                                                                                                               | 実装状態                                                                                            |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| **会社そのもの(法人格)**     | `customer/{slug}/customer.json`(社名・事業形態・子会社・前期財務)+ `organization-profile.json`(経営既定)+ `knowledge/confidential/{slug}/`(機密データ)                          | 部品は本番。会社を束ねる集約オブジェクトは未実装(§4-1)                                              |
| **創業者(あなた)**           | sovereign persona + `customer/{slug}/identity.json`(主権者・言語・対話スタイル・専門)                                                                                           | 本番。sbiss で famao=取締役社長として既に設定済み                                                   |
| **理念・意思決定の規範**     | `vision/_default.md`(全社憲章: 存在意義・意思決定の黄金律・優先順位)+ `customer/{slug}/vision.md`(`_template.md` の Soul/Steering/Destination 形式)                             | 全社版は runtime で読まれる(`core.ts:398`)。**テナント別 vision は authoring 止まりで未配線**(§4-3) |
| **部門・機能**               | 28 の knowledge role を 5 ドメインに整理(`personalities/roles.json`: Leadership/Engineering/Business&Growth/Governance&Quality ほか)。各 role に `PROCEDURE.md`(職務規程)       | 本番(知識・責務として)。ただし CEO/finance/sales 等は**権限を持たない advisory role**(§4-2)         |
| **従業員(AIスタッフ)**       | 13 の agent manifest(`*.agent.md`: capability・trust・persona・model)+ `agent-profile-index.json`(role/team-role 紐付け)                                                        | 本番。sovereign-brain=戦略、planner=企画/PM、surface 群=フロント、meeting-proxy=秘書                |
| **外部専門家(契約要員)**     | `specialist-catalog.json`(document-specialist・browser-operator・project-lead 等)+ capability broker が mission ごとに召集                                                      | 本番                                                                                                |
| **役割の人格・専門性**       | 27 perspectives(思考様式: Ruthless Auditor・Pragmatic CTO 等)+ capabilities                                                                                                     | 本番                                                                                                |
| **業務プロセス**             | 5 mission class + 99 pipeline template(sales-inbound-lead・contract-review・weekly-executive-digest・ceo-strategic-report 等)+ mission-workflow-catalog(intake→…→delivery の相) | 本番(engineering/ops/media 寄り。hiring/payroll/財務決算等は不足、§4-6)                             |
| **経営の回し方**             | Enterprise Operating Kernel の Intent→Resolve→Approve→Execute→Account→Learn。創業者は intent + 承認 + 成果評価だけを担う                                                        | 概念は完成、実装は mission 層まで(org-level 集約は未完、§4-7)                                       |
| **権限・決裁**               | mission スコープの time-boxed Authority(SUDO/GIT_WRITE/SECRET_READ 等)+ persona の tier アクセス。創業者は sovereign SUDO                                                       | 本番。ただし「どの役割が何を決裁できるか」の決定権限マトリクスは未データ化(§4-5)                    |
| **観測(経営ダッシュボード)** | `sovereign_dashboard`(CEO DASHBOARD)+ management-control-plane views + ceo-strategic-report                                                                                     | 部分実装(UX-06/SU 系で強化予定)                                                                     |
| **財務・KPI・OKR**           | `customer.json` の財務文字列 + finance_controller の cost-report。KPI/OKR は CEO_SCENARIO のレポート生成パターンのみ                                                            | **モデル化されていない**(§4-4)                                                                      |

---

## 2. 組織構成の作り方(今日できる手順)

既存プリミティブで「AIスタートアップの組織」を立てる具体手順:

1. **会社を興す** — `customer/{slug}/` を作り(`_template` を複製)、`customer.json`(社名・事業形態・財務)と `identity.json`(あなた=創業者 sovereign・言語・対話スタイル・専門領域)を書く。`organization-profile.json` で経営既定(既定 mission class・チームテンプレート・並列 mission 上限・LLM 方針)を定める。
2. **理念と意思決定規範を書く** — `customer/{slug}/vision.md` を `_template.md` の形式(Core Emotion=魂 / Decision Principles=舵 / Victory Conditions=目的地)で書く。これが全エージェントの判断の拠り所になる(※現状は authoring 止まりなので CO-01 で runtime 配線)。
3. **部門を選ぶ** — 5 ドメイン(Leadership/Engineering/Business&Growth/Governance&Quality)から必要な role を有効化。1人スタートアップなら最小構成: CEO(あなた)+ product_manager + strategic_sales + finance_controller + software_developer + cyber_security。各 role の `PROCEDURE.md` が職務を定義する。
4. **スタッフを配属する** — 必要な agent を有効化し、`agent-profile-index.json` で authority_role / team_role に紐付ける。1人+AI の最小編成: sovereign-brain(戦略・調整)+ planner-agent(企画・分解)+ surface agent 1つ(あなたとの窓口、Slack 等)+ 必要に応じ specialist を mission ごとに召集。
5. **権限を設計する** — 危険な操作(コード変更・送信・課金・鍵)は Authority grant + 承認ゲート(SA-05)の下に置く。創業者は sovereign SUDO を持つが、日常はエージェントが mission/worker persona の限定権限で動く(判断基準 AUTONOMOUS_MAINTENANCE_JUDGMENT §1-2)。

**ポイント**: Kyberion は「組織図を先に固めない」思想(`organization-profile-model.md`: 「full org chart ではない、mission ごとにチームを derive する」)。つまり**固定的な組織図でなく、mission ごとに必要な役割を動的に編成する**のが Kyberion 流。これは少人数 AI 企業の実態(固定部署でなくプロジェクトごとに人を集める)に合致する。

---

## 3. 業務の進め方(今日できる手順)

「どう仕事を回すか」は Enterprise Operating Kernel のループ + pipeline template で表現する:

1. **繰り返す業務は pipeline template にする** — 月次経営レポート=`ceo-strategic-report`、週次ダイジェスト=`weekly-executive-digest`、営業=`sales-inbound-lead-workflow`+`sales-outbound-initial-contact`+`account-expansion-workflow`、契約=`contract-review`、日次運用=`daily-routine`。既存 99 テンプレートを起点に、自社の業務を template 化(CLAUDE.md の「繰り返す決定論作業は pipeline に昇格」原則)。
2. **一回性の仕事は intent として投げる** — 「来週の取締役会資料を作って」→ intent loop が解釈 → goal 合意(IL-04)→ mission 化 → チーム編成 → 実行 → 検証 → あなたに成果提示。創業者は**intent と承認と評価だけ**を担う。
3. **業務を型で回す** — mission class(research/content/operations/decision-support 等)が実行プロセス(相・ゲート・編成)を決める(MO-01)。SDLC 的な開発業務は AI-DLC テンプレート(MO-01/HO-02)。
4. **成果を評価して学ぶ** — 完了は「動かして・元の依頼に突き合わせて」確認(MO-07/IL-04)。学びは knowledge に昇格(KM-03)。これが「会社が経験を蓄積する」corporate-memory-loop。
5. **無人で回す部分を増やす** — 定常業務(日次サマリ・健全性・請求処理等)は自律保守ループ(AO-01)で無人化し、判断が要る所だけあなたに上げる(AUTONOMOUS_MAINTENANCE_JUDGMENT のエスカレーション基準)。

**CEO の1日のイメージ**(`CEO_SCENARIOS.md` の10シナリオが実証): 朝に週次ダイジェストが自動生成され、Slack で承認待ちの決裁を捌き、「A社との提案を進めて」と intent を投げると営業 mission が走り、夕方に成果物(提案書 PPTX)がインボックスに届きレビューする。これが「1人+AI で会社を回す」日常。

---

## 4. コンセプトを表現する方法(まとめ)と、足りないもの

### 表現の要諦

「AIスタートアップのコンセプト」を Kyberion で表現するとは、**次の5つを書くこと**である:

1. **理念** → vision(魂・舵・目的地)。会社が何のために存在し、どう判断するか。
2. **組織** → role(部門・職務)+ agent(スタッフ)+ organization-profile(経営既定)。誰が何を担うか。
3. **業務** → pipeline template(繰り返す仕事)+ mission class(仕事の型)。どう仕事を回すか。
4. **権限** → authority + 承認ゲート + 判断基準ルーブリック。誰が何を決裁できるか。
5. **記憶** → knowledge tier + corporate-memory-loop。経験をどう蓄積するか。

この5つが揃えば、Kyberion 上で「会社」が表現される。既存プリミティブでその大半が書ける。

### 足りないもの(Company OS の完成に向けて)

現状は「業務の遂行」は表現・実行できるが、「会社そのものの経営」を束ねる層が未完。gap を改善計画にした:

| gap                                                   | 内容                                                                                                           | 計画                                                                      |
| ----------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| 会社の集約エンティティが無い                          | vision+org+role+KPI+process が5ファイルに散在、束ねる `company` オブジェクトが無い。per-tenant vision も未配線 | [CO-01](./improvement-plans-2026-07/CO-01_COMPANY_ENTITY.ja.md)           |
| 組織図がデータでない + カスタムロール作成フローが無い | 組織図は非構造化 tenant 知識のみ、"CFO agent" を作るには SYSTEM tier の config 手編集                          | [CO-02](./improvement-plans-2026-07/CO-02_ORG_CHART_ROLES.ja.md)          |
| 財務/KPI/OKR がモデル化されていない                   | 財務は文字列、KPI/OKR はレポート生成パターンのみ、P&L/予算/予測の primitive が無い                             | [CO-03](./improvement-plans-2026-07/CO-03_FINANCIAL_KPI_MODEL.ja.md)      |
| 意思決定権限がデータでない                            | 決裁権限は散文(vision/PROCEDURE)、閾値ベースの decision-rights マトリクスが無い                                | [CO-04](./improvement-plans-2026-07/CO-04_DECISION_RIGHTS.ja.md)          |
| 事業プロセスライブラリが機能不完全                    | 99 テンプレは eng/ops 寄り、hiring/payroll/procurement/fundraising/board/財務決算が無い                        | [CO-05](./improvement-plans-2026-07/CO-05_BUSINESS_PROCESS_LIBRARY.ja.md) |

これらを足すと、Kyberion は「業務を回すツール」から「会社を経営する OS」になる。

---

## 5. 一文で

**「私 + Kyberion で AIスタートアップを回す」は、Kyberion の設計思想そのもの — sovereign が intent を与え mission がエージェント群を統べる。今日でも組織(vision/role/agent/tenant)と業務(mission/pipeline)は表現・実行でき、CEO の日常業務は実証済み。残るのは「会社を1つのエンティティとして束ね、財務・KPI・意思決定権限をデータ化する Company OS 層」の実装(CO 系)であり、それが完成すれば1人+AI での本格的な会社経営が Kyberion 上で完結する。**

→ Company OS 完成の実装計画: [CO-01〜05](./improvement-plans-2026-07/README.ja.md#company-os会社を経営するos層)。既存の概念スパイン: `knowledge/product/architecture/enterprise-operating-kernel.md`。
