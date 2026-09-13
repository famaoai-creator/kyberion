---
title: テナントナレッジと actuator 活用のコンセプト評価・改善計画
tags: [tenant, knowledge, actuator, browser, computer-use, design, multimedia]
last_updated: 2026-09-11
status: active
---

# テナントナレッジと actuator 活用のコンセプト評価・改善計画

## 評価

Kyberion の強みは、モデルの判断、実行する actuator、権限・承認・証跡を分け、
ナレッジを実行コンテキストへ供給できる点にある。ブラウザ、文書、画像、音声、動画を
同じ実行基盤で扱う方向性も妥当。ただし、機能数だけでは業務の再現性は保証されない。
**ナレッジを置く範囲 → 検索する範囲 → 実行セッション → 制作物と観測結果**を通して、
同じスコープと検証条件を保つことが次の重点になる。

今回の評価はローカルの実装・契約・テストに基づく。実顧客データの移動や外部公開は行わない。
ミッション: `TENANT-ACTUATOR-REVIEW-20260911`。

## ナレッジの置き方

物理ディレクトリによる分離は、人が説明でき、バックアップ・削除・監査の対象も明確になる。
一方、テーマ名や顧客名のような意味的な名前から権限を推測すると、その利点が失われる。
配置先は「誰が再利用すべきか」で選び、検索時の関連度とは分離する。

| 対象                                       | 配置・扱い                                       | 注意点                                                 |
| ------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------ |
| 製品の実行ルール・操作手順                 | `knowledge/product/`                             | 個別顧客の値を埋め込まない                             |
| 全体に公開可能なテンプレート・デザイン素材 | `knowledge/public/`                              | 機密素材の自動コピー先にしない                         |
| テナント全体の用語、ブランド、業務規程     | `knowledge/confidential/{tenant}/`               | テナントは registry と実行スコープで特定する           |
| 組織・プロジェクトに限定する知識           | 上記の `organizations/{org}/projects/{project}/` | 同一文字列の ID が別階層に存在しても区別する           |
| ミッション・タスクだけの条件               | 必要な親 chain 配下の `missions/.../tasks/...`   | 親が欠けた状態で広い場所へ保存しない                   |
| 個人用の制作設定                           | personal tier のスコープ内                       | confidential/public の制作へ暗黙に混入させない         |
| テナント間の共通知識                       | 承認された `confidential/common/` 等             | 集約・匿名化・昇格は既存の broker / steward 経路を使用 |

`customer/{slug}/` は stance の overlay であり、tenant の別名ではない。
`pnpm scope show --json` で現在地を確認し、`pnpm knowledge place` の dry-run で
保存先を確認してから配置する。単なるコピーやテーマ名による全テナント検索を避ける。

既存基盤: `knowledge-scope.ts`、`tenant-knowledge-retrieval.ts`、`scope-context.ts`、
`knowledge-feedback-loop`。既存計画の正本は
[スコープ運用性計画](./KNOWLEDGE_SCOPE_OPERABILITY_PLAN_2026-08-16.ja.md)。

## actuator の使い分け

| 仕事                     | 優先する経路                                                             | 完了を判断する証拠                                                                   |
| ------------------------ | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------ |
| 反復する Web 業務        | 記録・承認した procedure → browser-actuator の Playwright/extension 経路 | 実行後の DOM、期待値、必要な screenshot。操作の成功だけでは業務完了としない          |
| 画面構造が変わる対話操作 | computer interaction の観測 → 判断 → 操作 → 再観測                       | 操作後の状態、停止理由、承認待ち。DOM ref で表せる対象は ref を使う                  |
| デスクトップ固有の操作   | system 側の computer interaction と readiness probe                      | OS 権限と対象の可用性、操作結果。未対応操作は blocked として扱う                     |
| スライド・文書・表       | semantic brief → theme / pattern / design defaults → media actuator      | 内容の一致、ページ・スライドの描画、文字欠け・overflow・可読性                       |
| 画像・音声素材           | media-generation / voice の登録済み provider と能力契約                  | ファイル実在、形式、意図への適合。ジョブ受理と素材完成を区別                         |
| 合成動画                 | video-composition の compile → prepare → await → verify                  | 生成ジョブ完了、音声・映像 stream、画面品質。stream の存在だけで編集品質を保証しない |

制作時は brief（目的・相手・伝える内容）、theme（ブランド・視覚設定）、pattern（構造）を
別々に指定する。`resolveCreativeDesign` の既存投影を使い、要素ごとの色やフォントを
モデルに繰り返し生成させない。再実行できる業務パターンは
`knowledge/product/pipeline-templates/` に置き、テナントが実体化する。
`pipelines/` は Kyberion 自身の運用用であり、ユーザー向け制作パターンの置き場と混同しない。

## 確認した不具合と実装

| ID    | 優先度 | 事実・影響                                                                                                    | 修正・受入条件                                                                                                                                | 状態               |
| ----- | ------ | ------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| KA-01 | P1     | `knowledgeWritePathFor` が tenant 指定でも子階層を追加し、ID の値で停止していた。共有範囲を誤る               | 階層名で停止。tenant は tenant root。重複 ID、欠落した親、拡張子によるパス逸脱を検査                                                          | 検証済み           |
| KA-02 | P1     | `resolveConfidentialThemePack` がテーマ名から tenant を推測し、全 confidential ディレクトリへ検索を広げていた | `currentScope()` の confidential tenant の正確な `design/theme.json` のみを対象にする。別 tenant の同名テーマ・無スコープ・public tier を検査 | 検証済み           |
| KA-03 | P1     | `loadThemeCatalog` が personal のテーマを全制作へ混ぜていた                                                   | personal tier のみ個人 overlay を読む。tenant がある場合はその personal 区画に限定し、global personal へ fallback しない                      | 検証済み           |
| KA-04 | P1     | computer interaction の観測指定が `snapshot` 以外で無視され、ref 操作では操作前の snapshot しか残らなかった   | 要求された DOM/screenshot/console/network を操作後に追加。mixed/screen/dom_snapshot mode を反映し、既に行った観測は重複させない               | 検証済み           |
| KA-05 | P1     | browser session が session ID のみで選択され、cookie・trail・CDP endpoint の所有者照合が無かった              | セッション確立時に ambient scope (tenant+tier) を binding し、lease 再利用・persisted CDP 再接続・close/restart で照合。不一致は拒否          | 実装済み・検証済み |

KA-02 の scope はホストの canonical execution scope から取得する。テーマ名や action の
任意の `tenant_slug` を新しい認可情報として採用しない。制作呼出元は既存の scope 解決を
設定する必要があり、テーマ名だけで旧来の機密テーマを読み込む挙動は終了する。

## 次段の改善と検証条件

- **KA-05 browser session 所有権（P1、実装済み）**:
  `executePipeline → getOrCreateBrowserContext` の通常 pipeline、computer interaction、
  persisted CDP 再接続、新規 launch で ambient scope (tenant+tier) を session lease と
  metadata に binding し、異なる scope や owner 不明の retained metadata は
  `[BROWSER_SESSION_OWNER_MISMATCH]` で拒否する。明示 CDP endpoint 自体の attestation は
  Chrome 側運用の責任として残る。明示 `user_data_dir` を別 session ID から共有する経路は
  パス所有権の追加設計が必要で、次段の残余リスクとして残る。
- **KA-06 制作物の一貫した最終検証（P2、設計提案のまま）**:
  video の `verify_rendered_video_artifact` は stream 存在を確認するが、字幕の見切れや
  音声との同期は保証しない。既存の visual review と組み合わせ、brief の受入条件から
  内容・描画・音声のチェックを選ぶ。PPTX / doc / video を横断する fixture で
  「ジョブ受理」「ファイル生成」「内容検証」「人による公開承認」を区別して表示する。
  横断検証層の新設になるため別 work item とする。
- **KA-07 実行ルートの運用受入（P2、環境待ち）**:
  今回の baseline は `needs_attention / L5`、desktop bridge は利用不可だった。
  接続を整えた環境で、テナント別のブラウザ操作と制作サンプルを同じ brief から再実行し、
  費用・所要時間・承認回数・成果物の品質を記録する。未実施を成功扱いしない。

## 検証記録

2026-09-11 の実行結果:

- `pnpm exec vitest run libs/core/knowledge-scope.test.ts libs/core/tenant-knowledge-retrieval.test.ts libs/core/creative-design-resolver.test.ts libs/actuators/browser-actuator/src/browser-interaction-helpers.test.ts libs/actuators/browser-actuator/src/index.test.ts libs/actuators/media-actuator/src/media-theme-scope.test.ts libs/actuators/media-actuator/src/media-theme-catalog.test.ts libs/actuators/media-actuator/src/personal-theme-overlay.test.ts`: **8 files / 98 tests passed**。
- `pnpm typecheck`: **passed**。
- KA-05 の live lease / retained metadata owner binding: `vitest run libs/actuators/browser-actuator/src/index.test.ts libs/actuators/browser-actuator/src/browser-session-ownership.test.ts` → **41 tests passed**。
- `scripts/check_contract_schemas.test.ts` → **2 tests passed**。`pnpm check:contract-semver` → **32 actuators, 0 warnings**。
- KA-05 修正後の独立再検証: browser actuator **2 files / 41 tests passed**。lease、retained/released metadata、close の owner mismatch を確認。
- `git diff --check`: **passed**。
- `pnpm validate`: build と typecheck は通過。full check は既存の `scripts/sketch-input` i18n baseline 未登録と、sandbox の Chronos `listen EPERM` (`127.0.0.1:3317`) で停止。今回の変更に関係する gate は通過。
- ブラウザ実機、CDP、デスクトップ bridge、外部 provider は未実行。baseline は `needs_attention / L5`、desktop bridge は利用不可だった。

テスト fixture は架空の tenant を使用し、
実顧客のナレッジ・デザイン素材を検証のために列挙しない。
