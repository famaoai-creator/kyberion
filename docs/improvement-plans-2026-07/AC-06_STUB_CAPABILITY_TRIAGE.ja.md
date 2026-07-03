# AC-06: スタブ能力の整理と能力境界の明文化

> 優先度: P2 / 規模: S / 依存: AC-01(プローブでの not_implemented 申告)

## 背景と課題

「動くように見えるが実は張りぼて」の能力と、「どのアクチュエータの担当か分かりにくい」境界が残っている。

### スタブ/プレースホルダ能力

| 対象                                 | 実態                                                                                                                                                                                                                                                                      |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| blockchain-actuator 全体             | **完全モック**。`audit/mock_blockchain.jsonl` にローカル書き込み、tx_id は sha256、block_number は `Date.now()/10000`(`libs/actuators/blockchain-actuator/src/index.ts:59-94`)。ヘッダ自身が "Simulates" と明記。型にある `verify_anchor` は dispatch 未実装(`:25,79-81`) |
| service-actuator STREAM              | 旧モードは型/dispatch から削除済み                                                                                                                                                                                                                                        |
| network-actuator gist トランスポート | 旧候補は削除済み、`local` のみ                                                                                                                                                                                                                                            |
| wisdom-actuator の decision 系       | バックエンド状況により「決定論的プレースホルダ」を返す場合があることが実装コメントに明記(`decision-ops.ts:78,830`)— 結果がプレースホルダか実推論か、呼び出し側から判別しにくい                                                                                            |
| orchestrator-actuator                | 「placeholder assumption で続行」経路(`orchestrator-helpers.ts:231`)                                                                                                                                                                                                      |

### 境界の曖昧さ(呼び分けに迷う)

- **画面キャプチャが 2〜3 箇所に分散**: media-generation の `capture_screen`/`record_screen`(`media-generation-action-helpers.ts:435-437`)と system-actuator の `screenshot`/`test_screen_stream` 系。
- **media / media-generation / video-composition / vision**: 決定論レンダリング vs 生成 vs 合成 vs 知覚。vision は生成を media-generation へ転送する facade(`vision-actuator/src/index.ts:119-122`)だが、ガイド上の説明は薄い。
- **system(exec/shell/process_kill)/ process(supervised lifecycle)/ terminal(PTY)**: 所有権とライフタイムで分かれているが、名前からは読めない(daemon-actuator の退役理由もこの混乱)。

## ゴール(受入条件)

1. モック/未実装能力が「実行すると分類済みエラー or `simulated: true` フラグ付き結果」を返し、本物と誤認されない。
2. 各スタブについて「実装する / 退役する / シミュレーションとして正式化する」の処置が決まり実施される(下記の推奨判断を既定とし、異論があれば報告)。
3. `CAPABILITIES_GUIDE.md` に「能力境界」節が追加され、上記 3 系統の呼び分け(ユースケース → 使うべきアクチュエータ)が表で示される。

## 実装タスク

### Task 1: blockchain-actuator の処置 — `claude-sonnet-4`(推奨: シミュレーションとして正式化)

1. 参照状況を確認(`grep -rn "blockchain" pipelines/ knowledge/product/ scripts/ libs/core`)し、anchor 系の利用実態を把握する。
2. 推奨処置: (a) manifest/結果に `simulated: true` を明示し、actuator 名の説明を「ローカル監査アンカー(ブロックチェーンシミュレーション)」に改める。(b) 未実装の `verify_anchor` を実装する — モックチェーン(`mock_blockchain.jsonl`)に対する検証なら小さい(ハッシュ再計算と照合)。(c) 実チェーン接続はしない。
3. 利用実態が皆無なら退役(`retired/actuators/`、IP-06 Task 1 と同型)を代替案として報告。

## 実装状況 (2026-07-03)

- **完了**: `blockchain-actuator` の manifest を simulation 明示へ更新し、`verify_anchor` を実装した。`anchor_mission` / `anchor_trust` / `verify_anchor` は `simulated: true` を返す。
- **検証済み**: `pnpm exec vitest run libs/actuators/blockchain-actuator/src/index.behavior.test.ts libs/actuators/blockchain-actuator/src/index.test.ts`、`pnpm run typecheck`、`pnpm lint`。
- **完了**: service STREAM、network gist、wisdom/orchestrator のプレースホルダ可視化、能力境界ドキュメント。

### Task 2: STREAM / gist の処置 — `claude-sonnet-4`

1. **service STREAM**: 需要を確認(呼び出し箇所 grep)。呼び出しゼロなら mode 一覧から外し、型・dispatch から削除(将来 SSE 実装時に再導入)。呼び出しがあるなら AC-01 プローブで `not_implemented` を返しつつ、呼び出し元を api モードへ移行させる。
2. **network gist**: `a2a-transport.ts` の transport 候補から gist を外すか、`gh gist create` ベースで実装するかを利用箇所(A2A の remote 需要)で判断。ecosystem roadmap は remote 連携を E3 以降に置いているため、**既定は候補から外して local のみとし、型に「future: gist」コメントを残す**。

### Task 3: プレースホルダ結果の可視化 — `claude-sonnet-4`

1. wisdom の decision 系が非実推論(プレースホルダ)で返る場合、結果オブジェクトに `reasoning_mode: 'placeholder' | 'model'` を必ず含め、operator packet / trace に表示する。orchestrator の「placeholder assumption で続行」時も同様に成果物へ明示する。
2. stub reasoning backend 使用時のテストでフィールドの存在を固定する。

### Task 4: 能力境界ドキュメント — `claude-sonnet-4`(執筆)→ `claude-haiku`(ガイド反映)

1. 「やりたいこと → 使う op」の対応表を作る: 画面キャプチャ(推奨: system-actuator を正とし、media-generation の capture 系は録画付き生成ワークフロー用と位置づけ)/ 文書レンダリング(media)/ 生成(media-generation)/ ナレーション動画合成(video-composition)/ 画像知覚(vision)/ コマンド一発(system)/ 常駐管理(process)/ 対話端末(terminal)。
2. AC-01 Task 4 のカタログ生成に「境界」節として組み込み、`docs/GLOSSARY.md` から 1 行リンクする。

## 実装状況 (2026-07-03)

- **完了**: `service-actuator` の `STREAM` モードを型/dispatch から削除し、`network-actuator` の `gist` トランスポート候補を削除した。
- **完了**: `wisdom-actuator` の decision 系に `reasoning_mode` を追加し、stub / synthetic の出力を `placeholder` として可視化した。
- **完了**: `orchestrator-actuator` の execution brief / operator packet / response preview に `reasoning_mode` を追加し、placeholder assumption を明示した。
- **完了**: `CAPABILITIES_GUIDE.md` に能力境界表を追加し、`docs/GLOSSARY.md` に境界リンクを追加した。
- **検証済み**: `pnpm exec vitest run libs/actuators/wisdom-actuator/src/decision-ops.test.ts libs/actuators/orchestrator-actuator/src/index.test.ts libs/actuators/service-actuator/src/index.test.ts libs/actuators/network-actuator/src/index.test.ts`、`pnpm exec vitest run libs/actuators/wisdom-actuator/src/index.test.ts`、`pnpm run typecheck`、`pnpm lint`、`git diff --check`。

## リスクと注意

- blockchain の結果形式変更(`simulated` 追加)は監査ログの読み手に影響し得る。既存フィールドは変えず追加のみとする。
- STREAM/gist の削除は semver 上は破壊的変更に当たる可能性がある。`check:contract-semver` の判定に従い、必要ならメジャー表記/契約バージョンの更新を行う。
