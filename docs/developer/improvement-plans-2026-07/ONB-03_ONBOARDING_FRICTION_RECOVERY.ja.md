# ONB-03: オンボード摩擦の削減 — express・リセット・resume 修復・Path B 整備

> 優先度: P1 / 規模: S〜M / 依存: なし / 関連: UX-06(半構成バグ)、UX-03(言語)、OP-03(bin)
>
> **なぜ重要か**: 初回の決定負荷と「やり直せなさ」が、すんなり使い始める障壁になっている。UX-06 が扱う個別バグとは別に、初回体験の摩擦全体を下げる。

## 背景と課題

- **express パスが非提示**: 対話ウィザードは 5 フェーズ 10+ プロンプト(identity 6 + customer slug + services 反復 + tenants + tutorial、`onboarding_wizard.ts:91,273-543`)。内部的には全プロンプトに default があり(`buildIdentityFromState:221-231`)Enter 連打で通せるが、**「Enter で妥当な既定を受け入れて後で設定」を伝えるアフォーダンスが無い**。`--defaults`/`--express` フラグも無く、唯一の一括既定は非 TTY の env(`KYBERION_ONBOARDING_NON_INTERACTIVE_OK=1`)のみ。identity の決定はどれも first value に必須でないのに、"Welcome aboard" 前のゲートとして提示される。
- **リセット/やり直しコマンドが無い**: reset 系スクリプトはゼロ。やり直すには `onboarding-state.json` を手動削除するしかない。`init`/`init-wizard` は死んでいる(`package.json:174-175`、`init_wizard` ソース無し)し `init` は pnpm リポで `npm run` を叩く不整合。
- **resume が半構成バグを永続化**: `runIdentityPhase` は成果物書き込み(`:292-312`)の**前**に identity 完了を saveState(`:287-290`)。中断すると state は「完了」なのに成果物が無く、resume はそのフェーズをスキップ(`:630`)して**二度と生成しない**(UX-06 の指摘が resume 経路も汚染する)。
- **Path B が薄い**: `onboard:apply` は完全な identity JSON 必須(部分不可・既定なし、`onboarding_apply.ts:79-93`)。README/QUICKSTART に記載が無く(INITIALIZATION のみ)、サンプル identity JSON も同梱されない。エージェント運用リポなのにエージェント向け入口が埋もれている。`--dry-run`(`:256-258`)は良い。
- **vital-check.json が personal ハードコード**: `p_identity`/`p_vision` ステップが `knowledge/personal/my-identity.json`/`my-vision.md` を直参照。`KYBERION_CUSTOMER` オーバーレイで正常オンボードしても vital が Identity/Vision を「欠落」と誤報(UX-06 が名指ししていない別ファイル。Chronos `api/identity/route.ts:47` も同じハードコードで FirstRunBanner がオーバーレイで不可視になる)。

### 実装メモ

- 2026-07-07: `pnpm onboard:reset` を追加。`onboarding/`、`my-identity.json`、`my-vision.md`、`agent-identity.json` を customer overlay / personal root の両方で安全に削除できるようにした。`--force` で無確認、TTY では確認プロンプトを出す。

## ゴール(受入条件)

1. 対話ウィザードに **express パス**(`--express` or 冒頭で「既定で進めて後で調整しますか?」)があり、identity 最小(名前・言語のみ)で "Welcome aboard" まで最短到達、残りは後から設定可能。
2. **リセット/やり直しコマンド**(`pnpm onboard:reset`)があり、確認付きで onboarding 状態と成果物を安全に初期化できる。死んだ `init`/`init-wizard` は OP-03/IP-04 と整合して解消。
3. resume の半構成バグが解消(UX-06 Task 1 と同一修正 — 成果物書き込み後に完了記録 + resume 時の成果物存在チェック)。本計画は「初回体験としての recoverability」観点で UX-06 に依存・参照。
4. Path B が README/QUICKSTART に記載され、**サンプル identity JSON テンプレート**が同梱される(エージェント/非対話ユーザーの入口整備)。
5. vital-check.json と Chronos identity route が customer オーバーレイを尊重する(UX-06 の dashboard 修正と同じ resolver を使用)。

## 実装タスク

### Task 1: express パス — `claude-sonnet-4`

1. ウィザード冒頭に「① おまかせ(既定で進め後で調整)/ ② じっくり設定」の選択を追加。① は identity 最小(名前・言語)だけ聞き、他フェーズは既定 skip で "Welcome aboard" へ最短。
2. `--express` フラグでも同経路。UX-03 の ja/en テンプレートに載せる。「後で `pnpm onboard` で詳細設定できます」を明示。
3. テスト: express で最小入力完了、成果物が最小構成で正しく書かれる。

### Task 2: reset/redo とデッド init 解消 — `claude-sonnet-4`

1. `pnpm onboard:reset` を新設: 確認プロンプト後に `onboarding-state.json` と生成 identity/vision/agent 成果物を削除(customer オーバーレイ対応)。secure-io 経由。`--force` で無確認。
2. `package.json` の死んだ `init`/`init-wizard` を、OP-03 Task 1 と整合して onboard へのエイリアスに統一(npm/pnpm 不整合も解消)。IP-04 の該当エントリ処置と重複しないよう相互参照。
3. テスト: reset 後にクリーンな再オンボードができること。

### Task 3: resume 修復への接続 — `claude-haiku`

- UX-06 Task 1(成果物書き込み後に完了記録 + resume 時の成果物存在チェック)が本計画の recoverability 要件を満たすことを確認し、未対応なら本計画側で実施。重複実装はしない(UX-06 を正とし参照)。

### Task 4: Path B 整備 — `claude-sonnet-4`

1. サンプル identity JSON を `knowledge/public/templates/onboarding/identity.example.json` として同梱し、`onboard:apply` のエラー・doc がこれを指すようにする。
2. README/QUICKSTART に Path B(非対話/エージェント向け)を 1 節追加(INITIALIZATION から昇格)。`--dry-run` の推奨も明記。
3. Path B が部分 JSON + 既定補完を許容できるか検討(現状は完全必須)。最小(名前・言語)+ 既定補完を許す方向にし、express パス(Task 1)と一貫させる。

### Task 5: vital / identity route のオーバーレイ対応 — `claude-sonnet-4`

1. `pipelines/vital-check.json` の `p_identity`/`p_vision` と Chronos `api/identity/route.ts:47` のハードコード `knowledge/personal/` を、UX-06 Task 2 で抽出する共通 customer-overlay resolver 経由に置換。
2. テスト: `KYBERION_CUSTOMER` 環境で vital が Identity/Vision を正しく検出、FirstRunBanner がオーバーレイでも表示されること。

## リスクと注意

- express の既定 identity(「Sovereign/KYBERION-PRIME」等)が本番運用にそのまま残ると没個性になる。express 完了後に「後で `pnpm onboard` で調整を」を明示し、dashboard 等に「既定 identity のままです」の軽い注意を出す。
- reset は削除操作。customer オーバーレイ/confidential 配下の識別情報を誤って消さないよう、対象を onboarding 成果物に限定し、確認を必須にする。
- vital/identity route の overlay 対応は UX-06 の resolver 抽出に依存。実施順は UX-06 → ONB-03 Task 5。
