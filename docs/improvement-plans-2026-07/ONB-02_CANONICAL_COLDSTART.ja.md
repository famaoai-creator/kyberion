# ONB-02: コールドスタートの単一正本化と前提条件の一元検出

> 優先度: **P0** / 規模: M / 依存: なし / 関連: OP-03(配布)・OP-05(env)・IP-04(死んだ参照)と接続
>
> **なぜ重要か**: 起動手順が文書間で矛盾し、最初に失敗する前提条件が最後まで検出されない。新規ユーザーは「どれを・どの順で・何が必要か」を知る単一の場所を持たない。評価レポートの D1(first-win)最優先ボトルネックの直接要因。

## 背景と課題

- **5つの矛盾する起動手順**: README(`:56-63`)、QUICKSTART(`:23-31`)、INITIALIZATION(`:19-40`、9 ステップ)、AGENTS.md(`:45`、reconcile→onboard)、ウィザード自身の締め(`onboarding_wizard.ts:554`、reconcile を onboard の**後**に)。`surfaces:reconcile` が onboard の前か後か、`prereq:check` が経路に含まれるか、5 つの `*:setup` が初回に必要か、すべて食い違う。
- **Node バージョンが4ソースで矛盾**: `package.json:8` `>=24.0.0`、README バッジ `>=24`、`.nvmrc` `22`、QUICKSTART/INITIALIZATION/baseline manifest は `22+`。`nvm use`(.nvmrc=22)→ `pnpm install` で engines `>=24` に当たる。しかも doctor/prereq:check は `node --version` を floor 検証せず素通り(pnpm engines だけが実際のゲート、それを preflight が見ていない)。
- **Playwright ブラウザ導入手順がどこにもない**: `playwright`/`puppeteer` は deps(`package.json:257,259`)だが `postinstall` 無し(`prepare: husky` のみ `:198`)、`npx playwright install` の記載がドキュメント全体でゼロ。看板の「5分 first win」は browser スクショ(`check_first_win_smoke.ts:100-127` が `browser:goto`/`browser:screenshot`)なのに、クリーンクローンではブラウザバイナリが無く**無言でテキストフォールバックに落ち**、スクショの first win が起きない。
- **allowBuilds にプレースホルダ残存**: `pnpm-workspace.yaml` の `allowBuilds` に `@anthropic-ai/claude-code` と `onnxruntime-node` がリテラル文字列 `"set this to true or false"` のまま。
- ネイティブビルド(node-pty/sharp/sqlite3/onnxruntime-node/tesseract.js)や Python 音声依存の前提が事前に提示されない。

## ゴール(受入条件)

1. **単一正本の起動手順**が 1 箇所(`docs/INITIALIZATION.md` を正とする)に定まり、README/QUICKSTART/AGENTS.md/ウィザード締めはそれを参照/一致させる(順序の矛盾解消)。
2. **Node バージョンが全ソースで統一**(engines を正とし `.nvmrc`・docs・manifest を合わせる)。preflight が実際の floor(pnpm engines と同じ)を検証し、不足を最初に検出する。
3. **単一の preflight**(`pnpm prereq:check` を正)が、Node・pnpm・reasoning backend(ONB-01)・Playwright ブラウザ・native toolchain・(音声を使うなら)Python 依存を**一括で actionable に**チェックし、first-win の前に不足を示す。
4. Playwright ブラウザ導入が手順 or postinstall に組み込まれ、browser first-win が実際に動く。
5. `allowBuilds` のプレースホルダが解決される。

## 実装タスク

### Task 1: 起動手順の単一正本化 — `claude-sonnet-4`

1. `docs/INITIALIZATION.md` を正本と定め、正しい順序(install → prereq:check → build → reasoning:setup(ONB-01)→ surfaces:reconcile → onboard → doctor → first-win)を確定する。`surfaces:reconcile` の前後問題は実装を確認して1つに決める(ウィザード締めの記述も合わせる)。
2. README/QUICKSTART/AGENTS.md を正本へのリンク + 最小要約に統一(手順の実体を二重管理しない)。ウィザードの締めメッセージ(`onboarding_wizard.ts:554`)も正本と一致させる。
3. 手順どおりでクリーンクローンから first-win まで到達できることを(可能な範囲で)検証。

### Task 2: Node バージョン統一と floor 検証 — `claude-sonnet-4`

1. engines(`>=24`)を正とし、`.nvmrc` を 24 に、docs/baseline manifest の "22+" を 24 に統一。あるいは 22 を正とするなら engines を下げる — **どちらかに一本化**(実際の動作要件を確認して決定)。
2. `prereq:check`/doctor の Node チェックを floor 検証(`>=` 比較)にし、不足を赤で報告 + `nvm use`/アップグレード手順を案内。
3. テスト: floor 未満 Node で preflight が失敗すること。

### Task 3: 統合 preflight — `claude-sonnet-4`

1. `pnpm prereq:check`(既存の `environment-doctor`/`service_preflight`/`bootstrap_environment` を統合)を「初回に必要な全前提を一括チェックする単一入口」に整備: Node floor・pnpm・reasoning backend(ONB-01 の probe)・Playwright ブラウザ有無・native toolchain・Python(音声を使う場合のみ)。各項目に actionable fix を付ける。
2. first-win スモーク(`check_first_win_smoke`)の前段でこの preflight を走らせ、ブラウザ不在なら「`npx playwright install chromium` を実行」と明示(無言フォールバックの前に警告)。
3. テスト: 各前提の欠落が preflight で検出・案内されること。

### Task 4: Playwright 導入と allowBuilds 解決 — `claude-haiku`

1. Playwright ブラウザ導入を手順に明記し、`postinstall`(または `prereq:check` の自動修正オプション)で `npx playwright install chromium` を実行できるようにする。重い/ネットワーク前提なので既定は「案内」、`--install-browsers` で実行。
2. `pnpm-workspace.yaml` の `allowBuilds` プレースホルダ 2 件を、実際の必要性を確認して true/false に確定。
3. `pnpm install` → first-win スモークがブラウザ経路で通ることを確認。

## リスクと注意

- Node バージョンの一本化は既存環境に影響する。市村さんの現環境の Node を確認し、24 統一で問題が出るなら 22 を正にする判断を先に固める(engines を実態に合わせる)。
- Playwright の自動インストールはネットワーク・ディスクを要し、CI や制限環境で失敗し得る。既定は「案内」に留め、明示フラグでのみ自動実行。
- 手順の単一正本化は多数の doc を触る。実体は INITIALIZATION に集約し、他はリンク化して二重管理を断つ(IP-04 の参照整合・OP-03 のインストール記述と衝突しないよう相互参照)。
