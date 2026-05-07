---
title: Kyberion OSS Hardening & FDE-Readiness Roadmap
category: Planning
tags: [roadmap, oss, fde, adoption, hardening]
importance: 10
author: famao
last_updated: 2026-05-07
---

# Kyberion OSS Hardening & FDE-Readiness Roadmap

「研究プロトタイプ」から「**OSS として頑健に使われる、その上で導入支援 / FDE が成立する**」までの距離を、実装可能な単位に分解した計画。

## 0. 戦略前提

意図的に **やらないこと** から書く。これを書かないと優先度がブレる。

### やらないこと（少なくとも当面）

- **SaaS 化** — マネージド配布、テナント自動受け入れ、課金、利用計測。
  *理由*: 今 SaaS 化しても土台のユースケースが固まる前に陳腐化する。SaaS は利用者数の関数として後で立てる。
- **マルチテナント GUI** — テナント切替 UI、組織管理、ロールベース ACL。
  *理由*: OSS の主戦場はシングルユーザ／シングル組織で動くこと。
- **公開 REST API / SDK** — 外部開発者が "Kyberion を組み込む" ためのもの。
  *理由*: そもそも内部のユーザー層がまだ薄い段階で、外向きの安定 API を背負うと内部進化が止まる。
- **OAuth / SSO 連携 / Stripe 連携** — 上記の派生。

### やること

1. **OSS として導入の摩擦をゼロに近づける** — clone から first win までのコストを最小化。
2. **手元で 30 日壊れず動く** — 使い捨てではないツールである、という信頼を作る。
3. **READ できるリポジトリにする** — コード／ドキュメント／例が、外部の開発者の頭に 1 時間で入る。
4. **差別化が伝わる** — 似た領域（Computer Use 系、AI 業務自動化、エージェント OS）と混同されない説明と例。
5. **FDE / 導入支援が成立する土台** — カスタム導入の 80% を「設定とテンプレート」で吸収できる構造。fork なしで 1 案件回せる。

### "成功" の暫定指標

商業 KPI ではなく **OSS 健全性 KPI** で測る。

| # | 指標 | 12 ヶ月後の目標値 |
|---|---|---|
| K1 | GitHub Star | 1,000 以上 |
| K2 | 月次 active contributor（コア外） | 5 名以上 |
| K3 | 月次 issue クローズ率 | 70% 以上 |
| K4 | "30 日連続で稼働" を達成した既知ユーザー数 | 10 名以上 |
| K5 | FDE / 導入支援案件 | 1 件以上 着手 |
| K6 | 第三者ブログ／登壇言及 | 5 件以上 |

K1〜K3 は OSS の健康度、K4 は本当に使われているか、K5〜K6 は FDE/支援が実需に届いているか。

---

## 1. プロダクトレベルの再定義

旧版の D1〜D5 を OSS / FDE 文脈に再定義する。

| # | 条件 | 観測指標 |
|---|---|---|
| D1 | clone から first win まで 5 分（Mac/Linux/Docker のいずれか） | 初回成功率 ≥ 80% / 所要時間 p50 ≤ 5 min |
| D2 | 30 日連続で同じユーザの手元で動き続ける | 主要シナリオ 30 日成功率 ≥ 95% |
| D3 | 失敗が読める（原因クラス + 推奨対処が出る） | unknown error 率 ≤ 10% |
| D4 | 公開的な接面（CLI / ADF / Plugin / Skill 仕様）が semver で安定 | breaking change 0 件 / minor |
| D5 | 外部の開発者が 1 週間で contribute できる | "good first issue" merge 率 ≥ 50% |
| D6 | "見て試してみたい" を引き起こす | README CTR / リポジトリの cold star 比率（外部流入由来） |

現状充足度（2026-05-07 時点、主観評価）:

| 条件 | 評価 | 主因 |
|---|---|---|
| D1 | 🔴 30% | 4 段階起動・依存物が暗黙・README が技術詳細寄り |
| D2 | 🟡 50% | 単発は動くが、長時間運用の検証がない |
| D3 | 🔴 25% | 統一 Trace 未稼働（Engine Phase 5 大半 TODO） |
| D4 | 🟡 40% | スキーマ検証あり、semver 化されていない |
| D5 | 🔴 20% | コードベースが大きすぎ（92 アーキ doc・908 knowledge）、CONTRIBUTING.md は陳腐化 |
| D6 | 🔴 10% | README が "なに" 中心で "なぜ／だれに／どう違う" が薄い |

→ ボトルネック: **D1 / D3 / D5 / D6**。D6（見せ方）を最初の Phase で D1 と並走させる。

---

## 2. ギャップ全体像（再分類）

旧版で挙げたうち、SaaS 文脈のギャップを除き、OSS / FDE 文脈で残るものを再構成。

### 2.1 導入摩擦 (D1, D6)

| ID | ギャップ | 現状 | 目指す姿 |
|---|---|---|---|
| G-IN-1 | 起動の重さ | `pnpm install + build + reconcile + onboard` の 4 段。10〜20 分。 | 1 コマンドで first win |
| G-IN-2 | 環境前提が暗黙 | Playwright・python・voice 周辺の前提が実行時にしか露出 | preflight `doctor` が must/should/nice を 3 行で出す |
| G-IN-3 | 配布チャネル不在 | GitHub clone のみ | macOS/Linux 向け Docker image + `npx kyberion init` |
| G-IN-4 | 何ができるか伝わらない | README は機能列挙寄り | "5 分で見える 1 つの結果" を README に動画/GIF で |
| G-IN-5 | デモ素材不在 | スクリーンショット少、動画なし | 主要シナリオ 3 本の terminal cast / GIF |

### 2.2 信頼性 (D2, D3)

| ID | ギャップ | 現状 | 目指す姿 |
|---|---|---|---|
| G-RL-1 | 統一 Trace 未稼働 | Phase 5 の 5.3〜5.8 が未完 | 全 actuator が OTel 互換 Trace を吐く |
| G-RL-2 | 失敗の説明可能性 | エラー文面はあるが分類無し | 失敗 → 分類 → 推奨対処の自動表示 |
| G-RL-3 | 長寿命ミッション | 単発前提、復帰検証無し | 24h 以上のミッションが checkpoint→resume で冪等 |
| G-RL-4 | 回帰検出 | tests + lint。意味的回帰は無し | 代表 ADF の golden output 比較 |
| G-RL-5 | 失敗からの学習 | distill フェーズはあるが運用は手動 | 失敗が `knowledge/public/incidents/` に自動蓄積 |
| G-RL-6 | クロス OS 検証 | macOS 主、Linux/Docker 検証は CI 限定 | macOS / Ubuntu / Docker の 3 本立てを定常テスト |

### 2.3 拡張 / コントリビュート (D4, D5)

| ID | ギャップ | 現状 | 目指す姿 |
|---|---|---|---|
| G-EX-1 | コードベース理解コスト | 442 ファイル/core, 92 アーキ doc | "1 時間で読める" 入口 doc + 階層化 |
| G-EX-2 | CONTRIBUTING の陳腐化 | `npm run create-skill` 等、現在動かない記述あり | 動く CONTRIBUTING + good-first-issue 体系 |
| G-EX-3 | 拡張点の不安定性 | actuator / pipeline / plugin の API が semver 化されていない | semver 化 + 互換性検査 CI |
| G-EX-4 | プラグイン authoring 体験 | `plugins/` 構造はあるが authoring guide 無し | テンプレート + チュートリアル |
| G-EX-5 | ローカル開発の遅さ | フルビルド前提の workflow | watch モード + 局所テスト戦略 |

### 2.4 ナレッジ運用 (D5, D6)

| ID | ギャップ | 現状 | 目指す姿 |
|---|---|---|---|
| G-DC-1 | ドキュメント膨張 | docs 29 + knowledge 908 ファイル | "User / Operator / Developer" 3 階層に正規化、それ以外 archive |
| G-DC-2 | 言語混在 | 規約 = 英、概念 = 日本語、内部混在 | README / Quickstart / Contributing は英語、設計は日英並行 |
| G-DC-3 | 例の腐食検査なし | サンプル ADF は手動更新 | docs 内コードブロックを CI で実行 |
| G-DC-4 | "なぜ" を語る doc 不在 | 機能 doc は多いが思想・差別化を語る短い doc 無し | `docs/WHY.md` (or VISION.md) 1 本 |

### 2.5 FDE / 導入支援 readiness (D4)

| ID | ギャップ | 現状 | 目指す姿 |
|---|---|---|---|
| G-FD-1 | 設定の集約点が散在 | env / `knowledge/personal/*` / policy.json に分散 | "1 つの場所" に customer-specific 設定を集約できる構造 |
| G-FD-2 | バーティカル・テンプレ無し | 個別 `projects/` のみ | 業種ごとの mission seed テンプレ集 |
| G-FD-3 | デプロイ runbook 無し | runbook テンプレは knowledge にあるが Kyberion 自体のデプロイ runbook 無し | "顧客環境への導入手順" doc |
| G-FD-4 | アップグレードパス無し | release 概念が無い | semver + migration スクリプト + CHANGELOG |
| G-FD-5 | カスタマイズ vs fork の境界曖昧 | どこまで設定で済み、どこから fork が要るかの線が無い | 拡張点リスト + "ここまでは設定" 宣言 |

---

## 3. 4 段ホライズン（再構成）

旧版から **Phase C (マルチテナント／billing) を削除**、**Phase D を OSS distribution + FDE-ready に置換**。

優先順位: **見える形にする (Phase A) → 30 日壊れない (Phase B) → コミットされる土壌 (Phase C') → 実装支援が成立する (Phase D')**。

### Phase A — 見える形にする（〜 4 週）

> ゴール: **clone から first win まで 5 分 / README で "なぜ" が伝わる**。

| ID | タスク | 完了条件 | 主要成果物 | 該当 D |
|---|---|---|---|---|
| A-1 | ポジショニング / WHY 文書 | "誰の何の問題を、なぜ Kyberion でなければ解けないか" を 1 ページに | `docs/WHY.md` (en/ja) | D6 |
| A-2 | README 全面書き直し | 1 段目: WHY と GIF。2 段目: 5 分 quickstart。3 段目: 比較・拡張への入口 | `README.md` (英語ベース) | D6, D1 |
| A-3 | ワンライナー起動 + **on-demand pull** | `npx kyberion init` または `docker run kyberion/playground` で `first win` まで。コア image は最小、重い依存（Playwright / Style-Bert-VITS2 / Whisper / OCR）は actuator 起動時に必要分だけ pull。詳細は §10 付録 B 参照 | `scripts/dependency_resolver.ts` + slim Docker image + README | D1 |
| A-4 | preflight doctor 強化 | `pnpm doctor` が must/should/nice の 3 列で不足を出す + 自動修復案。voice first win の依存（mic 権限、API key、ネットワーク）も含む | `pipelines/vital-check.json` 拡張 + `scripts/doctor_*` | D1 |
| A-5 | **Voice first win 実装** | "Hello Kyberion" = 声で話しかけ → ミッション解決 → 声で返ってくる、を 60 秒以内に体験。詳細は §10 付録 A 参照 | onboarding フロー + voice e2e ADF | D1, D6 |
| A-6 | デモ素材 3 本 | terminal cast (asciinema) / GIF / 短編動画 を README から見える場所に | `docs/demos/` + README 埋め込み | D6 |
| A-7 | エラー分類器 | `unknown` エラーを原因タイプ × 推奨対処に分類 | `libs/core/error-classifier.ts` + 共通ハンドラ | D3 |
| A-8 | Privacy / Telemetry スタンス明示 | telemetry は **デフォルト off**、何を送るかを 1 ページで宣言 | `docs/PRIVACY.md` | D6 |
| A-9 | LICENSE / 第三者依存棚卸し | LICENSE 既存 + 第三者ライセンスの棚卸しを月次自動化 | `scripts/license_audit.ts` | D4 |

**受入条件**: 社外の開発者 1 名（Kyberion を知らない人）が、ヘルプ無しで `init → first win` を完走でき所要時間 p50 ≤ 5 分。README を見て「使ってみたい」と言える。

---

### Phase B — 30 日壊れない（〜 8 週）

> ゴール: **手元で連続して使い続けられる / 失敗時に「次に何をすればいいか」が出る**。

| ID | タスク | 完了条件 | 主要成果物 | 該当 D |
|---|---|---|---|---|
| B-1 | 統一 Trace 完全展開 | Engine Phase 5.3〜5.6 を完了。全 actuator が Trace span を吐く | Engine 5.3〜5.6 | D3 |
| B-2 | クロス OS CI | Ubuntu / macOS / Docker の 3 マトリクスで主要シナリオを CI 実行 | `.github/workflows/cross-os.yml` | D2 |
| B-3 | Mission 長寿命化 | 24h 以上のミッションが checkpoint→suspend→resume で冪等。プロセス再起動を跨ぐ e2e | mission_controller v2.1 + e2e test | D2 |
| B-4 | Golden output 回帰検出 | 代表 ADF 10 本の出力を golden 化、PR 時に意味差分検出 | `tests/golden/` + CI job | D2, D4 |
| B-5 | Chaos drill 常設 | "actuator down" "network partition" "secret missing" を weekly | `pipelines/chaos-*.json` + scheduled job | D2 |
| B-6 | 失敗ヒント自動蓄積 | A-7 のエラー分類を distill に連結 → `knowledge/public/incidents/` に記録 → 次回参照 | `libs/core/incident-distiller.ts` | D3 |
| B-7 | テレメトリ任意 opt-in | 匿名クラッシュ・所要時間を opt-in 送信（送信先は当初 localhost 蓄積、後段で OSS dashboard） | `libs/core/telemetry.ts` | D2, D3 |
| B-8 | trace viewer 同梱 | Chronos に Trace ビューアを追加（OTel 形式 dump も） | Chronos 拡張 | D3 |

**受入条件**: 1 ユーザ環境で 30 日無人運用、人間介入 ≤ 1 件 / 週、unknown error 率 ≤ 10%。

---

### Phase C' — コミットされる土壌（〜 12 週）

> ゴール: **外部の開発者が "1 週間で何かしら merge される" 状態 / 拡張点が安定する**。

旧版 Phase C（マルチテナント／billing）を全面置換。

| ID | タスク | 完了条件 | 主要成果物 | 該当 D |
|---|---|---|---|---|
| C-1 | ドキュメント 3 階層統合 | docs 29 + knowledge 908 を user/operator/developer の 3 階層に正規化、archive 分離 | `docs/{user,operator,developer}/` | D5 |
| C-2 | 1 時間で読める入口 doc | "Kyberion を 1 時間で理解する" guided tour | `docs/developer/TOUR.md` | D5 |
| C-3 | CONTRIBUTING 全面更新 | 動く手順、good first issue ラベル運用、PR テンプレ、レビュー方針 | `CONTRIBUTING.md` 更新 + `.github/` 整備 | D5 |
| C-4 | 拡張点 semver 化 | actuator / pipeline / plugin / skill 仕様を v1 として宣言、semver 違反を CI で検出 | `scripts/check_contract_semver.ts` | D4, D5 |
| C-5 | プラグイン authoring guide | "新しい actuator を 30 分で書く" チュートリアル + テンプレ | `docs/developer/plugin-authoring/` | D4, D5 |
| C-6 | doctest 相当 | docs 内の code block を CI で実行検証 | `scripts/check_doc_examples.ts` | D5 |
| C-7 | ローカル開発体験 | watch モード、局所テスト、`pnpm dev` の改善 | tooling | D5 |
| C-8 | issue triage rotation | weekly triage / monthly contributor sync の運用ルール | `docs/MAINTAINERSHIP.md` | D5 |
| C-9 | コードベース縮小 | 死んだコード／重複 actuator／使われていない pipeline を archive | inventory + cleanup PR | D5 |

**受入条件**: 外部の開発者 1 名が、初回 contribution（good first issue）を 1 週間以内に merge できる。actuator/pipeline/plugin の semver 違反が 0 件 / リリース。

---

### Phase D' — FDE / 導入支援が成立する（〜 24 週）

> ゴール: **fork なしで 1 件の顧客導入が回せる / リリース運用が回る**。

旧版 Phase D を OSS adoption + FDE-ready に再焦点化。

| ID | タスク | 完了条件 | 主要成果物 | 該当 D |
|---|---|---|---|---|
| D-1 | カスタマイズ集約点 | customer-specific 設定（identity / connections / policy / mission seed）を 1 ディレクトリに集約 | `customer/` 仕様 + マイグレーションガイド | G-FD-1 |
| D-2 | バーティカル mission seed | "金融の稟議自動化" "個人の予約代行" "社内 SaaS 棚卸し" 等 3〜5 業種で seed テンプレ | `templates/verticals/` | G-FD-2 |
| D-3 | デプロイ runbook | "顧客の Macbook / Linux サーバ / 内製 VM への導入" 3 パターンの正規 runbook | `docs/operator/deploy/` | G-FD-3 |
| D-4 | semver リリース運用 | `v0.x.y` 採用、Conventional Commits ベース CHANGELOG 自動生成、`migration/` ディレクトリ | release pipeline | G-FD-4 |
| D-5 | 拡張点公式リスト | "ここは設定で済む / ここから fork が要る" を明示した拡張点マップ | `docs/developer/EXTENSION_POINTS.md` | G-FD-5 |
| D-6 | リファレンス事例 | 公開許諾を取った実装事例 ≥ 2 件（KPI 改善値を含む） | `docs/case-studies/` | K6 |
| D-7 | **OSS ガバナンス文書一式** | OSS ベストプラクティスに従い `MAINTAINERS.md` / `CODEOWNERS` / `CODE_OF_CONDUCT.md` / `SECURITY.md` / `GOVERNANCE.md` を整備。コミッター / メンテナの 2-tier 体制、月次 contributor sync、半年ごとのメンテナ昇格レビュー。最初の外部メンテナ 1 名 | `.github/` + ガバナンス文書一式 | K2, D5 |
| D-8 | 月次リリース | 月次の安定 release を 3 回以上連続 | release tag + GitHub release notes | D4 |

**受入条件**: 外部の SI / FDE が、Kyberion を **fork せずに** 1 件の顧客導入を完了できる。月次リリースが回る。リファレンス事例 ≥ 2 件。

---

## 4. 旧版からの主な変更

| 項目 | 旧版 (v1) | 新版 (v2) |
|---|---|---|
| 北極星 | プロダクト品質の 5 条件 (D1〜D5) | OSS 健康度 KPI (K1〜K6) + 接面 6 条件 (D1〜D6) |
| Phase A | "Beta 公開可能化" | "見える形にする" — WHY/README/デモ重視 |
| Phase B | "信頼性で立つ" | 同方向。ただし **クロス OS** が追加 |
| Phase C | "マルチテナント／billing" | **削除**、"コミットされる土壌" に置換 |
| Phase D | "スケールと差別化（mobile, marketplace, i18n, SOC2 等）" | "FDE / 導入支援が成立する" に置換 |
| 削除した検討事項 | OAuth/SSO, Stripe, REST API, mobile companion, marketplace v2, SOC2/ISO27001 | — 利用者数が増えた時点で再検討 |
| 追加した検討事項 | OSS 配布, クロス OS, バーティカル seed, 拡張点 semver, FDE runbook | — |

---

## 5. 横断テーマ

### 5.1 ドキュメント "Single Source"

```
docs/
  WHY.md / VISION.md           — 思想・差別化（A-1）
  user/                        — エンドユーザ向け（Quickstart, How-to, Troubleshooting）
  operator/                    — 運用者向け（Installation, Daily ops, SRE runbook, Deploy）
  developer/                   — 拡張開発者向け（Tour, Architecture, ADF, Plugin authoring, Extension points）
  case-studies/                — 公開事例
knowledge/
  public/                      — システムが参照する正規ナレッジ
  procedures/hints/            — 失敗 distill 由来のヒント（高頻度・追記型）
```

`docs/developer/architecture/` 92 ファイルは `docs/developer/architecture/` に正規化＋重複統合。redundant な knowledge は `archive/` に分離。

### 5.2 言語ポリシー

**英語と日本語を等しく一級市民として扱う**（ターゲットは OSS 国際流入 + 日本市場）。

| 文書種別 | 英語 | 日本語 |
|---|---|---|
| `README.md` / `README.ja.md` | **必須** | **必須**（並行ファイル） |
| `docs/user/` （Quickstart, How-to, Troubleshooting） | **必須** | **必須** |
| `docs/operator/` （Install, Deploy, Runbook） | **必須** | **必須** |
| `docs/developer/` （Architecture, ADF, Plugin authoring） | **必須** | 推奨（順次補完） |
| `WHY.md` / `VISION.md` / `CONTRIBUTING.md` | **必須** | **必須** |
| `knowledge/public/architecture/` （概念設計） | 推奨 | **必須**（既存資産・思考言語） |
| `knowledge/public/governance/phases/` | 推奨 | **必須** |
| コミットメッセージ / PR / Issue | **必須**（外部 contributor のため） | 任意（補足として） |
| エラーメッセージ / CLI 出力 | **必須** | locale 切替で表示（D-5 i18n と連動） |

実務ルール:
- README / Quickstart / Troubleshooting は **同時に** 両言語を更新。片方だけの PR は CI で reject。
- `docs/developer/` の英語版は順次補完で OK だが、日本語版が無い新規 doc は merge しない。
- 翻訳は機械翻訳（DeepL / Claude）+ 人手レビュー前提。両者の差分が大きい場合は人手版を正とする。
- `docs/DOCUMENTATION_LOCALIZATION_POLICY.md` を本ポリシーで全面改訂（Phase A-2 と並行）。

### 5.3 リリース運用

- semver 採用、`v0.x.y` 系のうち `0.x` を Phase 単位で繰り上げ。
- `CHANGELOG.md` を Conventional Commits から自動生成。
- `migration/` に「上げる前に流すスクリプト」を集約。
- PR ラベルで `breaking` / `feature` / `fix` / `chore` を強制し、`breaking` 含む場合は minor 跨ぎ必須。
- リリース pipeline は Phase D-4 で確立。

### 5.4 セキュリティの最低限

- secret-actuator 経由でない秘密利用を CI で禁止する lint 追加。
- 外部送信前段で secrets / PII を検出する egress redaction を **既定 on**（FDE 案件で必須）。
- 依存ライセンス棚卸しを月次自動化（A-9）。
- 監査チェーン（audit-chain.ts）はそのまま維持、blockchain anchor は opt-in。

### 5.5 観測の貯め方／見せ方

- 短期: trace を JSONL で `active/shared/logs/traces/` に蓄積、Chronos に viewer (B-8)。
- 中期: OTel exporter を出し、ユーザが自前の Grafana / Honeycomb / Datadog に接続できる（OSS friendly）。
- 長期: trace を distillation の入力として、自動的に hint / runbook を生成（B-6）。

---

## 6. 既存ロードマップとの結線

| 既存ドキュメント | 本ロードマップでの位置付け |
|---|---|
| `docs/ROADMAP_ENGINE_REFINEMENT.md` Phase 1〜4 | 前提。Phase B-1 / B-3 / C'-4 の足場。 |
| `docs/ROADMAP_ENGINE_REFINEMENT.md` Phase 5 | Phase B-1 と一体化（ここで終わらせる）。 |
| `docs/ROADMAP_ENGINE_REFINEMENT.md` Phase 6 | **本計画では遅らせる**。tier の multi-tenant 拡張は K1〜K4 が立った後に再検討。 |
| `docs/developer/architecture/POST_ONBOARDING_UX_ROADMAP.md` | Phase A-4 / A-5 の具体実装ガイド。 |
| `docs/archive/CONCEPT_INTEGRATION_BACKLOG.md` | アーカイブ済。主要項目は完了、残りは本ロードマップで追跡。 |
| `docs/developer/architecture/AUTONOMY_SYSTEM_GUIDE.md` / `NERVE_SYSTEM_GUIDE.md` | Phase B-3（24h ミッション）の参照元。 |

---

## 7. 進捗トラッキング

- 状態管理: 各タスク ID（A-1 等）を本ファイルのチェックボックスで更新。
- レビュー周期: Phase 単位で `mission` を切り、distill 結果を本ファイルに反映。
- Gate: Phase A → B 進入で D1 / D6 達成、B → C' 進入で D2 / D3 達成、C' → D' 進入で D4 / D5 達成。未達なら次 Phase に入らない。
- KPI の観測: K1〜K6 は **月次** で測定する別ドキュメント（`docs/KPI_TRACKING.md`、後段で作成）に蓄積。

### Phase 状態（更新する）

- [ ] Phase A — 見える形にする
- [ ] Phase B — 30 日壊れない
- [ ] Phase C' — コミットされる土壌
- [ ] Phase D' — FDE / 導入支援が成立する

---

## 8. 戦略決定事項（2026-05-07 確定）

旧版で残していた判断ポイントは以下のとおり確定。

| # | 論点 | 決定 | 理由 / 補足 |
|---|---|---|---|
| 1 | **first win** | **Voice**（声で話しかけ → ミッション → 声で返ってくる）。**初期段は API key も install も不要**: presence surface（ブラウザ）の Web Speech API で入力、OS 標準 TTS（macOS `say` / Linux `espeak` / Windows SAPI）で応答 | マーケ訴求力が最も高い。GIF/動画が映える。Kyberion の固有性（mission + actuator + voice）が一発で伝わる。クラウド voice / ローカル Style-Bert-VITS2 への upgrade パスを用意。詳細は §10 付録 A。 |
| 2 | **配布 image** | **Slim core + on-demand pull** | Docker image はコア最小、重い依存（Playwright / Style-Bert-VITS2 / Whisper / OCR）は actuator 起動時に必要分だけ pull。詳細は §10 付録 B。 |
| 3 | **英語化** | **英語と日本語を等しく一級市民として扱う**（README/Quickstart/User/Operator 系は両言語必須） | OSS 国際流入 + 日本市場の両立。実務ルールは §5.2 参照。 |
| 4 | **メンテナ招聘** | **OSS ベストプラクティスに従う**（CODEOWNERS / MAINTAINERS / GOVERNANCE / 月次 sync / 昇格レビュー） | 自然発生を待ちつつ、ガバナンス文書を先に整える。詳細は Phase D'-7。 |

進行中に新たな論点が出た場合は本セクションに追記する。

---

## 9. 進め方の原則

- 各 Phase は **3〜4 週で 1 回は外向きアウトプット**（README 改訂、デモ公開、ブログ、リリースノート）。
- 大規模リファクタは Phase B-1 の Trace 統一以外は避ける。
- 既存 actuator / pipeline は **延命優先**。再設計は Phase D' 以降。
- 「あったら良い」を入れない。各タスクが D1〜D6 のどれを進めるかを必ず明示する。
- **OSS 視点で恥ずかしくないこと** を最低ライン（コミットメッセージ、PR、ドキュメント、example の鮮度）。

---

## 10. 付録

### 付録 A: Voice First Win 仕様（Phase A-5）

#### A.1 ゴール

clone から 5 分以内に、ユーザが **声で話しかけ → Kyberion が声で返す** 体験を 1 往復成立させる。
**初期段は外部 API key 不要・追加 install 不要**で動く。GIF / 動画で映える短い demo が同時に作れる構成にする。

#### A.2 体験フロー（60 秒）

```
[起動 0s]    > npx kyberion init --voice
[セットアップ 0–20s] preflight が「マイク権限・ブラウザ・ネットワーク（任意）」を 3 行で確認
                     presence surface (http://127.0.0.1:3031 等) を自動で開く
[挨拶 20–25s]  ブラウザに大きなマイクボタン。OS 標準 TTS が「こんにちは。マイクボタンを押して話してください」
[ユーザ発話 25–40s] ボタンを押して "今日の天気を教えて"（ブラウザ内 Web Speech API で文字起こし）
[応答 40–60s]  Kyberion が天気を取得（既存 service-actuator）→ OS 標準 TTS で「東京は晴れ、最高 23 度です」
```

実装上の既存資産:
- `presence/displays/presence-studio/`（ブラウザ surface、Web Speech API を呼ぶ frontend）
- `satellites/voice-hub/`（音声入出力ハブ）
- `libs/actuators/voice-actuator/`（Style-Bert-VITS2、ローカル TTS）— upgrade 用
- `libs/core/anthropic-voice-bridge.ts`（Anthropic Voice 経由）— upgrade 用
- `scripts/run_realtime_voice_conversation.ts`

#### A.3 三段構成（依存重量と OSS-friendly の両立）

| 段 | 名前 | STT | TTS | 起動時間 | 外部依存 | 推奨用途 |
|---|---|---|---|---|---|---|
| **0** | **Browser + Native (first win default)** | ブラウザ内 Web Speech API | OS 標準 (`say` / `espeak` / `powershell SAPI`) | 数秒 | **無し**（ブラウザと OS だけ） | 初回 first win。"5 分で動く・課金なし・install なし" を成立させる |
| 1 | **Cloud voice (opt-in upgrade)** | Anthropic Voice / OpenAI Realtime | 同上 | 数秒 | API key | 自然な対話、リアルタイム多言語、業務利用 |
| 2 | **Local voice (further opt-in)** | Whisper (local) | Style-Bert-VITS2 (local) | 数十分（モデル DL） | python + GPU 推奨 | 完全オフライン、声カスタマイズ、長期常用 |

→ 初回は段 0 で確実に動かし、`pnpm voice:upgrade-cloud` / `pnpm voice:upgrade-local` でいつでも段 1 / 2 に切り替え。
→ いずれの段でも mission/actuator/Trace の本体は共通。voice の入出力経路だけが差し替わる。

**段 0 の選定理由**:
- API key 不要 = OSS の "見て触る" 障壁が最も低い
- macOS / Linux / Windows いずれも OS 標準 TTS あり、追加 install ゼロ
- ブラウザの Web Speech API は Chrome/Edge/Safari で広くサポート（モバイルブラウザでも動く）
- 後段の cloud / local upgrade と完全に互換（mission 側のコードは変えない）

**注意点**:
- Web Speech API は一部ブラウザ（Firefox 等）でサポート限定 → preflight で検出して案内
- OS 標準 TTS の声はやや機械的 → README には "より自然な声がほしい場合は段 1 / 2 へ" と明示

#### A.4 失敗時のフォールバック

- **マイク権限なし** → テキスト入力モードに自動降格（presence surface 内のテキスト入力）。応答は OS TTS で継続
- **ブラウザが Web Speech API 非対応** → "Chrome / Edge / Safari を使うか、テキスト入力に切り替えてください" + テキスト入力 UI
- **OS 標準 TTS が動かない**（Linux で `espeak` 未 install など）→ テキスト出力のみに降格、`espeak` install コマンドを案内
- **ネットワーク無し** → 段 0 はローカル完結なので **そのまま動く**（mission 内容次第で外部 API 呼び出しは失敗）。"今日の天気を教えて" の代わりに "システムの状態を教えて" 等の **オフラインで完結する first win 質問** を案内する

#### A.5 マーケ素材の同時産出

A-5 のタスク完了条件に「30 秒以内の terminal cast + ブラウザ画面録画 GIF + 短編動画（60 秒、声入り）」を含める。
最初の README ヒーロー画像 / OG 画像はこの動画から切り出す（A-2, A-6 の素材）。
動画は **段 0 で撮る**（"API key なしでこれだけ動く" を訴求するため）。

#### A.6 Phase A-5 詳細タスク

- A-5.1: `npx kyberion init --voice` で段 0 経路（presence surface 起動 → ブラウザ自動 open → first win 質問提示）を 1 コマンドにまとめる
- A-5.2: presence surface に Web Speech API 入力 UI を追加（既存ならば動作確認）
- A-5.3: OS 標準 TTS の薄いラッパ `libs/core/native-tts.ts`（`say` / `espeak` / `SAPI` の差異を吸収）
- A-5.4: 段 0 用 e2e ADF `pipelines/voice-hello.json`（greeting → mission → reply、外部依存ゼロを宣言）
- A-5.5: voice preflight（マイク権限、ブラウザ、TTS 経路）を `pipelines/vital-check.json` に統合
- A-5.6: 失敗フォールバック（A.4）の実装
- A-5.7: terminal cast / GIF / 動画の収録 + README 埋め込み
- A-5.8: `pnpm voice:upgrade-cloud`（段 1）/ `pnpm voice:upgrade-local`（段 2）で切り替えるスクリプトと doc

#### A.7 段 1（クラウド voice）採用時の選択

段 0 を default としたため、段 1 の provider 選択は **first win 後の話** になり、急がない。
ただし実装順としては既存資産（`anthropic-voice-bridge.ts`）がある **Anthropic Voice** が早いと推測される。
段 1 の正式採用は Phase B / C' に入ったタイミングで K1〜K4 の状況を見て確定。

---

### 付録 B: On-Demand Pull 戦略（Phase A-3）

#### B.1 image 構成

| Image | サイズ目安 | 同梱 | 用途 |
|---|---|---|---|
| `kyberion/playground:slim` | < 500 MB | Node + コア actuator (file/network/system/secret/wisdom/orchestrator/agent) + cloud voice 経路 | 初回 first win、軽量試用 |
| `kyberion/playground:full` | ~3 GB | 上記 + Playwright + python + Whisper tiny + 主要フォント | 業務シナリオ、demo |
| `kyberion/playground:devel` | ~5 GB | 上記 + Style-Bert-VITS2 + 全 actuator + 開発ツール | コントリビュート、FDE 案件 |

→ README で勧めるのは `slim`。`full` / `devel` は必要に応じて pull。

#### B.2 on-demand 解決メカニズム

`scripts/dependency_resolver.ts`（新規）を導入。actuator 起動前に依存を確認し、不足時に：

1. **must**（無いと動かない）: ユーザに確認の上、自動 install を試行
2. **should**（推奨）: 警告と install コマンドを提示、未充足のまま降格モードで継続
3. **nice**（あると便利）: 案内のみ

例:
- browser-actuator 起動 → Playwright ブラウザ未 install → "ブラウザを install します（200MB、約 30 秒）" + 進捗表示
- voice-actuator local モード起動 → Style-Bert-VITS2 サーバ未稼働 → "Local voice モデル（1.2GB）を pull、または cloud voice にフォールバックしますか？"
- media-generation-actuator → ComfyUI 未稼働 → "ローカル ComfyUI を起動 / Replicate API を使う / スキップ" の 3 択

#### B.3 keying と再現性

- 各依存の version pin と sha256 を `dependencies/manifest.json` に記録
- `pnpm doctor --strict` で manifest と実環境の乖離を検出
- FDE 案件用の "frozen" モード: manifest 通りの依存以外の install を拒否

---

### 付録 C: KPI トラッキング雛形（Phase A 期間中に立ち上げ）

| 月 | K1 Star | K2 Contributor | K3 Issue close | K4 30d 連続稼働 | K5 FDE | K6 言及 |
|---|---|---|---|---|---|---|
| 2026-05 | TBD | 0 | TBD | 0 | 0 | 0 |
| 2026-06 |  |  |  |  |  |  |
| ... |  |  |  |  |  |  |

詳細トラッキングは別途 `docs/KPI_TRACKING.md`（Phase A 期間中に新設）に移行。
