# UX-06: オンボーディングとダッシュボードの整合性修正

> 優先度: P1 / 規模: S〜M / 依存: なし / 関連: 既存の [PRODUCT_UX_EVALUATION_2026-05-29](../PRODUCT_UX_EVALUATION_2026-05-29.ja.md) の UX-0/1/2 提言(first-run 安定化・surface health)と補完関係。本 IP は同評価が触れていない**バグと整合性**に限定する。

## 背景と課題

### A. オンボーディングに「静かな半構成状態」バグ

`scripts/onboarding_wizard.ts` の identity フェーズは、**成果物を書く前に**フェーズ完了を保存する:

- `:287-290` で `saveState(state)`(identity 完了・`current_phase: 'services'` へ前進)
- その**後**に `my-identity.json`(`:292`)、`my-vision.md`(`:302`)、`agent-identity.json`(`:304`)を書く

この間に中断されると、state 上は完了扱いなのに identity ファイル群が存在しない。再開時はフェーズスキップ(`:630`)により**二度と生成されない**。ユーザーへの唯一のシグナルは後日の vital チェック失敗で、原因への導線が無い。

### B. ダッシュボードが customer オーバーレイを無視して空表示になる

オンボーディングは `KYBERION_CUSTOMER` 設定時に `customer/{slug}/` へ書く(`onboarding_wizard.ts:92-93`、`docs/INITIALIZATION.md:139-156`)。`mission_controller.ts:656-704` は customer root を尊重するが、**`sovereign_dashboard.ts` は `knowledge/personal/` をハードコード**(`:86,:130,:190,:316,:327-328,:394`)。customer 構成のユーザーが `pnpm dashboard` を開くと Identity 既定値・Tenants 0・Connections none の**空ダッシュボード**が出る。

### C. ダッシュボードの固定値・不整合

- `sovereign_dashboard.ts:40` — ユーザー名 `'famao'` をハードコード、`Status: OPERATIONAL` を無条件表示(直下の doctor 結果と矛盾し得る)。
- バナーのバージョンが面ごとに無関係(`cli.ts:290` v2.2 / `mission_controller.ts:1080` v2.0 / `sovereign_dashboard.ts:38` v1.0)。

### D. 導線の行き止まり

- `pnpm onboard` はビルド前だと raw の "cannot find module dist/..." で落ちる(`docs/INITIALIZATION.md:13-40` は build 前提を強調していない)。
- `cli.ts intent` の不一致時(`:1444-1452`)は候補列挙だけで終了し、言い換え・明確化フローへの誘導が無い。intent はあるが pipeline が無い場合(`:1498`)も「Use a task session instead.」のみで具体コマンドが無い。
- `onboard:apply` は JSON のみ出力(`onboarding_apply.ts:257,279`)で人間向け確認が無い。
- オンボーディングに所要時間・中断可否(resume 対応済み)の案内が無い(`:598-599`)。

## ゴール(受入条件)

1. オンボーディングの各フェーズが「成果物を書いてから完了を記録する」順序になり、中断→再開で欠損が生じない。既存の半構成状態を検出して修復する導線がある。
2. ダッシュボードが customer オーバーレイ構成でも正しいデータを表示する。
3. ダッシュボードのユーザー名・ステータスが実データ(identity / doctor 結果)を反映する。
4. ビルド未実施・intent 不一致・apply 成功時に、次の一手が表示される。

## 実装タスク

### Task 1: フェーズ完了順序の修正 — `claude-sonnet-4`

1. `runIdentityPhase` を「成果物書き込み(`:292-304`)→ 検証(書いたファイルの存在確認)→ `saveState`」の順に入れ替える。他フェーズ(services/tenants/tutorial)にも同パターンが無いか確認し、あれば同様に修正する。
2. 再開時(`:630` のスキップループ)に、完了済みフェーズの**成果物存在チェック**を追加し、欠けていれば「completed 扱いだが成果物がありません。再実行します」と表示してフェーズを再実行する(これが既存被害の修復導線になる)。
3. テスト: フェーズ途中中断をシミュレートし、再開で成果物が揃うことを確認する unit test(state ファイルと成果物パスは fixture ディレクトリ)。

### Task 2: ダッシュボードの customer オーバーレイ対応 — `claude-sonnet-4`

1. `sovereign_dashboard.ts` の `pathResolver.knowledge('personal/...')` 直書き(`:86,:130,:190,:316,:327-328,:394`)を、`onboarding_wizard.ts:92-93` と同じ `customerResolver.customerRoot('') ?? knowledge('personal')` の解決に置換する(解決ロジックは共通関数として `@agent/core` へ抽出し、wizard・dashboard・mission_controller で共用)。
2. 検証: `KYBERION_CUSTOMER` を設定した fixture で dashboard のデータ読込関数が customer 側を読むことの unit test。

### Task 3: 固定値の実データ化 — `claude-haiku`

1. `sovereign_dashboard.ts:40` のユーザー名を identity(`my-identity.json`)から取得(未設定時は "Operator")。`Status: OPERATIONAL` は doctor/vital 集計結果(既存の判定があればそれ)に連動させ、無条件表示をやめる。
2. 3 面のバナーバージョンを `package.json` の version 1 箇所から取得する共通ヘルパーに置換する。

### Task 4: 行き止まり導線の修正 — `claude-sonnet-4`

1. `pnpm onboard` 等の dist 実行系エントリに、dist 欠落時の「先に `pnpm build` を実行してください」メッセージを出す薄いランチャ(または `onboard` script を `node -e` で存在チェックしてから実行する形)を入れる。`docs/INITIALIZATION.md` の Quick Commands に build ステップを明記する。
2. `cli.ts:1444-1452`(intent 不一致): 候補列挙に加えて「言い換えのヒント + `pnpm cli -- intent --clarify "<発話>"` などの次の一手」を表示する(clarify 相当の既存機能を確認し、あるものに誘導する。無ければ質問フロー `question-resolver` への接続を検討し、無理なら文言のみ)。`:1498` は task session 開始の実コマンドを表示する。
3. `onboarding_apply.ts:257,279` の JSON 出力に `--json` フラグを新設して従来挙動を残し、既定では人間向けサマリ(何が設定されたか・次の一手)を表示する。

### Task 5: 開始時の期待値設定 — `claude-haiku`

- wizard の開始バナー(`:598-599`)に「所要 5〜10 分 / いつでも Ctrl-C で中断可・再開可能」の 2 行を追加(UX-03 の ja/en テンプレートに載せる)。

## リスクと注意

- Task 1 の順序入れ替えは、書き込み失敗時に「フェーズ未完了のまま途中成果物が残る」ケースを生む。成果物書き込みは既存の secure-io 経由なので atomic write が効いているはずだが、複数ファイルの途中失敗時は「再実行で上書きされる」ことをテストで確認する。
- Task 4-1 のランチャは全 dist 実行 script への一般化(IP-12 と重複)をしない。onboard 系の入口 1〜2 個に限定する。

## 実装メモ

- `resolveActiveProfileRoot()` を `@agent/core` に追加し、`onboarding_wizard.ts` / `sovereign_dashboard.ts` / `mission-state.ts` の profile root 解決を共通化した。
- `runIdentityPhase` は identity 成果物の書き込み後に state を `complete` 側へ進めるよう変更した。
- `runOnboarding()` は完了済み identity フェーズで成果物欠損を見つけた場合、再実行するようにした。
- dashboard は customer overlay の `connections` / `tenants` / `onboarding` を読むように寄せた。ヘッダの user も identity から取るようにした。
- `pnpm onboard` / `pnpm onboard:apply` は dist 欠落時に build を促す薄いガードを挟み、`onboarding_apply` は既定で human-readable summary を出し `--json` で機械出力に戻せるようにした。
- `onboarding_wizard` は開始時に所要時間と Ctrl-C 再開可否を案内するようにした。
