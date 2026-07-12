# AR-07: ループ内セマンティック op — pipeline 実行中の LLM 判断を第一級にする

> 優先度: P1 / 規模: M / 依存: AR-01(canonical engine)・AR-02(op registry) / 関連: REVIEW_LLM_BOUNDARY_2026-07-13、HN-03(決定論)、OP-01(コスト)

## 背景と課題

LLM × pipeline の連携は4層に整理できるが、**T2(ループ内セマンティック op)だけが実質空白**で、ブラウザ操作などが「全実行 → 結果分析 → 全体リトライ」(T3)か「完全エージェンティック」(T4)に二極化している。

| 層  | パターン                                                        | 現状                                                |
| --- | --------------------------------------------------------------- | --------------------------------------------------- |
| T1  | 実行前起草(brief / visual direction / テーマ選択)               | 整備済み(2026-07 スプリント)                        |
| T2  | **ループ内判断**: 観測を蒸留し、その場で LLM が次の一手を決める | **空白**(`reasoning:*` は汎用すぎて未使用)          |
| T3  | 実行後分析 + リトライ(autonomous-repair)                        | 存在するが粒度が粗い(1ステップの失敗で全体リトライ) |
| T4  | 完全エージェンティック(claude-task-runner、maxTurns)            | 承認ゲート付きで存在(コスト高)                      |

## actuator 全体監査(2026-07-13)

| actuator                | 観測 op(蒸留元)                                      | 判断ギャップ                                                | 処置                                                                                               |
| ----------------------- | ---------------------------------------------------- | ----------------------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| browser                 | snapshot / content / query_elements                  | セレクタ特定・次アクション選択が LLM 不在で、失敗は T3 送り | **本計画で実装**: `distill_dom`(決定論蒸留)+ `llm_decide`(選択優先の判断)+ fillWithFallback 最終段 |
| android / ios           | `extract_ui_tree` / `summarize_ui_tree`(蒸留は既存!) | UI ツリー → ノード選択の判断が決定論 find のみ              | 次候補(core `decideFromObservation` に UI ツリーを渡すだけで接続可能)                              |
| terminal                | poll / poll_terminal                                 | 対話 CLI の出力 → 次入力の判断                              | 次候補(同パターン)                                                                                 |
| meeting                 | listen(transcript)                                   | 発言タイミング/内容判断                                     | T4 寄り。consent ゲートがあるため慎重に別計画                                                      |
| system / network / file | exec / fetch / read の出力                           | 汎用 `reasoning:analyze` で可能だが蒸留なしでトークン浪費   | ログ tail 圧縮等の蒸留ヘルパを推奨(横展開時)                                                       |
| media / video / deck    | —                                                    | T1 で整備済み(visual direction / テーマ選択 / 本文起草)     | 完了                                                                                               |

## 設計原則(REVIEW_LLM_BOUNDARY より継承)

1. **蒸留(決定論)と判断(LLM)を分離**: 生 DOM/ログを LLM に渡さない。蒸留 op は同じ入力に同じ出力。
2. **選択 > 生成**: 判断 op は可能な限り「候補リストからの選択」。カタログ/候補外の応答は縮退。
3. **明示 op として可視化**: budget に計上され、trace に判断が記録され(再現性)、spend-guard に連動。
4. **縮退が常に定義される**: LLM 不調時は決定論フォールバックへ。判断 op の失敗が pipeline を殺さない。

## 実装タスク

1. **core `semantic-decide.ts`**: `decideFromObservation({goal, observation, options?, generate?})` — options 指定時はメンバーシップ検証(選択)、非指定時は短文自由回答。失敗は null(caller が縮退)。
2. **browser `distill_dom`(capture)**: インタラクティブ要素の目録(tag/role/text/セレクタ候補/可視性)を要素数・バイト上限付きで構造化。
3. **browser `llm_decide`(transform)**: distillate + goal → 判断 JSON を ctx へ。trail 記録。
4. **fillWithFallback 最終段**: 全縮退失敗時に distill → 候補セレクタから LLM 選択 → 1回だけ再試行(`fallback_strategy: llm_pick`)。
5. android/terminal への横展開は受入後の別スライス。

## 受入条件

1. distill_dom が決定論(同一 DOM → 同一出力)でサイズ上限を守る。
2. llm_decide が options 外の応答を採用しない(テストで固定)。
3. fillWithFallback の llm_pick 段が「LLM 不調でも従来のエラーメッセージに縮退」する。
4. すべて `KYBERION_REASONING_BACKEND=stub` + generate 注入で決定論テスト可能。
