# IP-13: モデルIDの一元管理と陳腐化解消

> 優先度: P1 / 規模: S / 依存: なし / 関連: IP-07 Task 2(アダプタテストが回帰網)

## 背景と課題

- LLM のモデルIDがアダプタ各所にリテラルで散在しており、モデル世代の移行時に漏れが出る構造になっている。
  - `libs/core/anthropic-reasoning-backend.ts:39` — `DEFAULT_MODEL = 'claude-opus-4-7'`(ヘッダコメント `:3` も "Opus 4.7")。**現行世代より古い**。
  - `libs/core/agent-lifecycle.ts:95-96` — `gemini-2.5-flash`, `claude-sonnet-4`
  - `libs/core/acp-mediator.ts:125` — リテラル
  - `libs/core/agent-adapter.ts:302,404` — `gemini-2.5-flash`
  - テスト内にも `gpt-5` / `gemini-2.5-pro` 等が散在
- 一方で `libs/core/reasoning-model-routing.ts` というルーティングモジュールが既に存在するのに、アダプタはそれを通っていない。

## ゴール(受入条件)

1. モデルIDのリテラルが `reasoning-model-routing.ts`(または同モジュールが読む単一の設定)に集約され、アダプタ・lifecycle・mediator はそこから取得する。
2. 既定モデルが現行世代に更新される(**実装時に各プロバイダの最新モデル一覧を必ず確認**して決定する。この文書に書かれた ID を鵜呑みにしない)。
3. 環境変数(例: `KYBERION_REASONING_MODEL`)による上書き経路が動作し、テストされる。
4. `grep -rn "claude-\|gemini-\|gpt-" libs/core --include='*.ts'` のモデルIDヒット(テスト・fixture を除く)が routing モジュールのみになる。

## 実装タスク

## 実装状況 (2026-07-03)

- **完了(代表スライス)**: `libs/core/runtime-model-defaults.ts` を追加し、runtime 用の既定モデルを `resolveRuntimeModelId(role, env)` に集約した。`anthropic-*`、`gemini-*`、`openai-vision`、`codex-default`、`copilot-default` を対象に env override を持つ。
- **完了(代表スライス)**: `agent-lifecycle`、`acp-mediator`、`agent-adapter`、`reasoning-bootstrap`、`intent-contract`、`codex-cli-query`、`anthropic-*`、`GeminiCliBackend`、OCR bridge の実行既定値を routing/defaults 経由に寄せた。
- **完了(代表スライス)**: 公式 docs 確認に基づき、Anthropic は `claude-opus-4-8` / `claude-sonnet-5`、Gemini は `gemini-3.5-flash` / `gemini-3.1-flash-lite`、OpenAI/Codex primary は `gpt-5.5` を既定にした。`gpt-5.4-mini` は fast lane の既存 candidate として維持。
- **完了(代表スライス)**: `knowledge/product/governance/model-registry.json` と `reasoning-level-policy.json` の primary route を `openai:gpt-5.5` に更新した。
- **検証済み**: `pnpm exec vitest run libs/core/reasoning-model-routing.test.ts`、`pnpm run typecheck`、`pnpm run check:contract-schemas`、`pnpm run check:catalogs`、`pnpm lint`。
- **完了**: `provider-discovery.ts` と `metrics.ts` の fallback は knowledge tier の fallback JSON に外出しし、コード内の model ID リテラルを消した。`provider-discovery.ts` / `metrics.ts` の code ヒットは routing / settings 以外になくなった。

### Task 1: 現状マップの作成 — `claude-haiku`

- `grep -rn "claude-[a-z0-9.-]\+\|gemini-[a-z0-9.-]\+\|gpt-[a-z0-9.-]\+" libs/ scripts/ --include='*.ts'` を実行し、非テストのヒットを「ファイル / 行 / 用途(既定値・フォールバック・ルーティング条件)」の表にして本文書末尾に追記する。`reasoning-model-routing.ts` の現在の公開 API も要約する。

### Task 2: routing への集約 — `claude-sonnet-4`

1. `reasoning-model-routing.ts` を読み、「役割(primary reasoning / fast / vision 等)→ モデルID」の解決関数が既にあるか確認する。無ければ `resolveModelId(role: 'default'|'fast'|'subagent'|...): string` を追加し、既定値テーブルと env 上書き(`KYBERION_REASONING_MODEL` 等、既存の env 命名規約 `KYBERION_*` に従う)を実装する。
2. Task 1 の表の各リテラルを `resolveModelId()` 呼び出しへ置換する。各ファイルの用途(fast 系が必要な箇所に default を入れない)に注意する。
3. 既定モデルIDの更新: 実装時点の Anthropic / Google の公開モデル一覧を確認し、現行の安定版へ更新する(例: Opus 4.7 → 現行 Opus 系)。**モデルIDの変更はこのコミットに孤立させ**、コスト・レイテンシ特性が変わることを PR/パッチ説明に明記する。
4. `reasoning-model-routing.test.ts` に「役割ごとの解決」「env 上書き」「未知の役割はエラー」のテストを追加する。

### Task 3: 回帰確認 — `claude-sonnet-4`

- `pnpm test:core` 全体と、IP-07 Task 2 のアダプタテストが存在すればそれを実行。stub backend での動作(`KYBERION_REASONING_BACKEND=stub`)に影響が無いことを確認する。`docs/` 内にモデルIDを記載した箇所があれば grep して追従更新する。

## 検証メモ (2026-07-03)

- `pnpm exec vitest run libs/core/provider-capability-catalog.test.ts libs/core/provider-capability-catalog-writer.test.ts libs/core/agent-provider-resolution.test.ts`
- `pnpm lint`
- `pnpm run typecheck`
- `rg -n "claude-|gemini-|gpt-" libs/core/provider-discovery.ts libs/core/metrics.ts` はヒットなし

## リスクと注意

- 既定モデルの世代更新は挙動(品質・コスト・レート制限)が変わる運用上の変更。**集約リファクタと ID 更新を別コミットに分け**、ID 更新側はロールバックが 1 revert で済むようにする。
- `knowledge/` 配下のカタログや契約(capability broker 等)にモデルIDが埋まっている場合、コード側と二重管理になっていないか Task 1 で確認し、あれば片方を正とする提案を報告に含める。
