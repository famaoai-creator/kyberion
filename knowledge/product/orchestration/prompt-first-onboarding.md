---
title: LLM CLI から始めるプロンプト経由オンボーディング
tags: [onboarding, cli, identity, tenant, organization, services, first-work]
last_updated: 2026-10-18
kind: playbook
scope: repository
authority: recipe
phase: [onboarding, alignment]
role_affinity: [sovereign_concierge, ecosystem_architect]
---

# LLM CLI から始めるオンボーディング

Git clone したディレクトリで LLM CLI を起動し「初期設定して」と依頼されたときの、
エージェント向け実行手順。インストール前でもこの文書は読める。
利用者にコマンド表を選ばせず、目的を聞き、既存の governed facade を実行して結果を伝える。
実行順と承認条件の正本は [オンボーディング標準フロー](../governance/onboarding-flow.md)。
この手順はその CLI 会話経路であり、新しい状態ストアや承認経路を作らない。

## 入口のプロンプト

利用者は clone 後、リポジトリを作業ディレクトリとして LLM CLI を起動し、次のように依頼する。
CLI のインストールとログインは、その CLI の手順で済ませておく。

> この端末で Kyberion を使い始めたい。環境を確認して、必要なことを質問しながら初期設定を進めて。
> 最初に任せたい仕事は週次レポートの下書き。まずは個人で使いたい。

会社の場合も専門用語を要求しない。

> AI と会社を運営したい。会社名は Acme。最初は問い合わせ対応の下書きを任せたい。
> テナント、組織、必要なサービスも一緒に準備して。

## 1. 会話の前に端末を確認する

1. リポジトリと既存の変更を確認する。既存 identity、stance、scope を上書きしない。
2. Node / pnpm / git、依存、ビルド成果物を確認する。未導入の新規 clone では、
   baseline の実行失敗を繰り返さず [QUICKSTART](../../../docs/QUICKSTART.md) の
   install → build → env:bootstrap → doctor → verify-session の順に準備する。
   OS のツール導入や外部認証が必要なら、その操作だけ利用者へ渡す。
3. baseline が実行可能なら実行し、status と失敗層に従う。circuit_broken のときは
   [復旧規則](../governance/phases/recovery.md)に従い自動修復を止める。
   fatal_error は新規 clone の前提不足と混同せず、pipeline の修復まで先へ進まない。
4. setup report で不足を確認する。任意のサービスが未接続なら、必要になるまで保留する。
   failed layer と、利用者の仕事を妨げるかは分けて説明する。all_clear を偽って報告しない。

LLM CLI で会話できることと、Kyberion の reasoning backend が使えることは別々に検証する。
親 CLI のログインを引き継げると推測せず、reasoning:setup と onboarding llm show で確認する。
同じ CLI を backend に選ぶ場合も、子プロセスの認証・実行可否を確認する。

## 2. 最小限の質問をまとめる

プロンプトや保存済み情報で分かる項目は再質問しない。最初の質問は次の三つまでにまとめる。

- **用途と最初の成果物**: 個人の仕事 / AI と会社を運営 / 既存の会社・顧客の仕事、何を任せたいか。
- **本人と責任者**: 呼び名と言語。会社・顧客業務なら組織名と責任を持つ人。
- **使う道具**: 最初の仕事で読む・書くサービスやアカウント。後から追加でもよい。

確認例: 「個人用で、週次レポートの下書きまでを準備します。外部送信は実行前に確認します。
呼び名と、元データをローカル資料・GitHub などのどこから読むかを教えてください。」
技術識別子（tenant slug、organization ID、agent ID）は既存値を優先し、必要なら安全な候補を
提示する。目的・責任者・会社の事実をサンプルから補完しない。
identity の interaction_style などの設定値は推奨値を添えて計画に含め、専門用語の質問を増やさない。

## 3. 目的からルートを選び、計画を見せる

| 用途           | 準備する範囲                                            | 完了前の確認                                |
| -------------- | ------------------------------------------------------- | ------------------------------------------- |
| 個人           | 環境、identity、必要な接続                              | vital-check / baseline、最初の仕事の計画    |
| AI 会社        | 上記 + tenant、organization、責任者、AI worker          | binding、activation、最小の組織運営設定     |
| 既存会社・顧客 | 既存 tenant / organization を照合し、必要なものだけ追加 | 認可、binding、activation、既存状態との整合 |

tenant は機密境界、organization はその中の運営単位、customer は振る舞う主体の stance。
同じ名前である必要はない。個人利用では tenant を作らない。
既存テナントの名称が分かってもアクセス権があるとはみなさない。

「今回作るもの・再利用するもの・保留するもの・承認が必要な操作」を短く示して、
依頼済みの範囲を進める。不明な業種テンプレートを勝手に選ばず、会社ルートでは
onboarding company の help が返す vertical から用途に合う候補を確認する。
会社ルートは --tenant-slug を明示する（省略すると会社作成だけで binding まで進まない）。
既存組織に対して company を再実行したり --force を使ったりしない。

## 4. 対話の回答を既存 facade へ渡す

エージェントの実行ツール越しに裸の pnpm onboarding を起動しない。readline が人間の端末を
待って停止するため、会話で聞いた値から reviewed JSON を作り onboarding apply を使う。
人間が直接端末を操作する場合のウィザードはそのまま利用できる。

- 入力契約は [identity.example.json](../../public/templates/onboarding/identity.example.json)。
  例の名前や alpha-team を本人の情報とみなさず、個人ルートは tenants: [] にする。
  tutorial は simulate または skipped とし、最初の実務を暗黙に実行しない。
- 入力ファイルは secure-io で storage-layout の scratch に作る。秘密情報を入れず、
  確認済みの identity だけを渡す。pnpm onboarding apply --identity <file> --dry-run で
  検証し、同じ入力を適用する。生成された profile / summary は手で書き換えない。
- AI 会社は標準フローの company dry-run → apply → stance 切替 → その stance の identity →
  activation の順に進める。既存テナントは tenant registry を照合し context bind を使う。
- 設定済みの backend と model は再利用する。変更する場合は onboarding llm select の
  preview を確認して適用する。機密を送る provider の契約根拠が不明なら送信を開かない。
- tenant の plan / probe が通った後、人間が activation を受け入れる。
  --accept や approvals --approve を、未回答の質問への代わりに実行しない。

コマンドの正確な引数は標準フローの該当 Step と各 facade の help で確認する。
利用者の自由文をシェル構文へ直接連結せず、引数または reviewed JSON として渡す。

## 5. 二種類のサービスを準備する

| 種類             | 意味                                     | 入口                                                          |
| ---------------- | ---------------------------------------- | ------------------------------------------------------------- |
| 外部サービス接続 | GitHub / Google Workspace 等の認証と接続 | service:setup → secret introduce → service:preflight          |
| 組織のサービス   | 組織が提供する価値・責任・業務           | organization purpose / domain / service / operation / cadence |

外部接続は最初の仕事で必要なものだけ確認し、既存アカウントを再利用する前に対象を照合する。
secret introduce の非表示 TTY 入力、または既存の承認付き登録画面へ案内し、API key、token、
password を会話・argv・公開証跡・.env に貼らせない。CLI の認証操作は利用者が行い、
接続完了後に同じ scope で service:preflight を実行する。

組織ルートでは、最初の仕事に関係する purpose と service / operation / cadence を標準フロー
Step 10 の governed facade で最小限登録する。単発の下書きを勝手に定期実行へ変えない。
書き込みに必要な persona と選択中 scope を確認する（.env.local の保存だけでシェルへ反映したとみなさない）。
定期実行・外部送信・支払い等を有効にする前に、その内容と人間の承認境界を示す。

## 6. 最初の仕事へ引き渡す

個人ルートは tenant を要求しない。組織ルートは activation receipt が active になった後で
onboarding:context first-work の dry-run を確認する。包含順は常に
tenant_slug → organization_id → project_id → mission_id → task_id。
すべての仕事に project / mission を強制せず、work-scope policy で実行形を決める。

最後に「利用可能・保留・承認待ち・次の一手」を短く返す。
環境が整っただけ、または binding ができただけで「組織の仕事が実行可能」と報告しない。
vital-check と baseline の結果、組織なら activation / organization status、必要な接続の
preflight を根拠にする。first-work の作成と実行は区別する。

## 7. 中断からの再開

「初期設定の続きをして」と言われたら、active profile の onboarding summary / state、
onboarding llm show、setup report を確認する。組織ルートは context show、activation reconcile、
organization status を加える。既存 receipt と照合し、未完了の段階から進める。
会話履歴だけを進捗の正本にせず、reset・--force・state の手編集でやり直さない。
承認待ちなら request ID と人間が行う操作を伝え、承認を推測しない。
秘密を含む会話や identity を product knowledge に保存しない。
