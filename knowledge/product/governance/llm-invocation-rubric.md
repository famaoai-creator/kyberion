---
title: 'LLM Invocation Rubric — どのポイントで LLM に頼むか'
last_updated: 2026-11-28
---

# LLM Invocation Rubric — どのポイントで LLM に頼むか

> **正本** (LC-05, LOOP_CLOSURE_PLAN 2026-07-13)。pipeline / ADF / ワーカータスクを設計するとき、
> 各判断点をこのラダーのどの段に置くかを決めてから書く。分散していた AR-07 / HN-01 / HN-02 / MO-05 / MO-07 の
> 判断基準の1枚化。preflight lint(`llm-decide-without-distill` / `llm-decide-without-fallback`)はこの文書を根拠とする。

## ラダー(上から順に検討し、最初に成立した段で止める)

| 段                     | 手段                                         | 成立条件                                                   | コスト/決定性                                  |
| ---------------------- | -------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------- |
| **0. 決定論 op**       | 既存 actuator op / `core:*` 制御 op          | 入力→出力が規則で書ける。観測の解釈が不要                  | ゼロトークン・完全再現                         |
| **1. 蒸留 + 一点選択** | `distill_*` → `llm_decide`(**options 付き**) | 判断は必要だが、**候補が列挙できる**(セレクタ・分岐・分類) | 1呼び出し・options 外は拒否され決定論 fallback |

> **System-1 優先経路 (`semantic-decide.ts`)**: `options` が 2 つ以上あり、かつ `KYBERION_JUDGMENT_PROVIDERS` 等で `judgment-backend` の System-1 プロバイダ（`laya-mlx` / `gemini-decision` / `openai-decision` / `typesafe-jev`）が登録されている場合、`decideFromObservation` は先に `assistWithJudgment` を呼ぶ（`tier` 未指定時は安全側で `confidential` 扱い・`egress` フィルタ適用）。System-1 が回答できない場合のみ従来の `ReasoningBackend` へフォールバックする。
> | **2. 蒸留 + 一点生成** | `distill_*` → `llm_decide`(options なし) | 候補列挙が不可能で、短い自由出力が要る | 1呼び出し・`on_degraded` の宣言必須(lint) |
> | **3. schema 強制委譲** | `delegateStructured<T>`(HN-02) | 構造化された成果物の生成(計画・タスク結果・契約)。**出力が schema 化できる** | retry-on-mismatch 付き・検証済みオブジェクト返却 |
> | **4. 品質最大化委譲** | best-of-N + judge / draft→refine(MO-07) | リスク tier が high / high_stakes、または品質クリティカルな文書 | N倍コスト。opt-out は `KYBERION_BEST_OF_N=0` |
> | **5. 人間** | 承認ゲート / ask-why(LC-10) | 不可逆・対外・規制、または機械の判断根拠が立たない | 最終責任は常に人間(CO-06) |

## 各段の判定質問

1. **決定論で書けるか?** — 「同じ入力なら常に同じ出力でよいか」。Yes なら op を書く。繰り返すなら pipeline へ昇格(LC-02)。
2. **観測は蒸留できるか?** — LLM に渡す前に決定論 op で観測を縮約する(`distill_dom` 等、上限 12,000 字)。生ログ・生 DOM を直接渡さない。
3. **候補は列挙できるか?** — できるなら必ず options を渡す(選択>生成)。options 外の返答は自動拒否され、呼び出し元の決定論 fallback が動く。
4. **出力は schema 化できるか?** — 生成が要るなら `delegateStructured` で契約を先に決める。bare-JSON パースに戻らない。
5. **失敗したらどうなるか?** — 縮退(null fallback)は設計だが**観測されなければならない**(LC-09: `<export_as>_degraded` / run summary)。縮退が業務上許されない step は `on_degraded: fail` を宣言する。
6. **判断の供給源は本物か?** — stub 縮退時は完了がブロックされる(LC-07/08)。テストで stub を使うなら `KYBERION_REASONING_BACKEND=stub` を明示する。

## アンチパターン

- 蒸留なしで生の観測を LLM に渡す(トークン浪費・非決定性の増幅)
- 列挙できる候補があるのに生成させる(検証不能な自由出力)
- LLM 呼び出しの成功 = 「throw しなかった」で済ませる(品質シグナルを読む: MO-07 / LC-06)
- 縮退 fallback に暗黙依存して「動いているように見える」pipeline(LC-09 の縮退カウントを確認する)
- 繰り返し実行する決定論手順を毎回 LLM に再発明させる(成功後に `pipelines/` へ昇格する — AGENTS.md §2)

## 不確実性・分布外（OOD）時の事前振る舞い仕様（既定: 助言 / opt-in で契約必須化）

LLM を組み込む工程では、「例外を投げなかった」だけでなく、判断に迷う境界での振る舞いを事前に定義しておく。

| 不確実性の状況                   | 取り得る安全側アクション（要件に応じて選択）                                                | Kyberion での受け皿                                                              |
| -------------------------------- | ------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| **低確信（閾値未満・候補拮抗）** | 上位候補提示、`delegateStructured` 再試行、または安全側デフォルトへ縮退（`_degraded` 記録） | `options` 制約 / 決定論 fallback / `on_degraded`                                 |
| **入力が前提外・分布外（OOD）**  | 未知入力を自動処理せず拒否・診断警告を出し、自律コミットを迂回する                          | preflight schema 検証 / fail-closed ゲート                                       |
| **根拠不足・証拠矛盾**           | 推測補完せず不足事実を `needs_input` / `customer_decisions` として切り出す                  | [question-resolution-playbook](../orchestration/question-resolution-playbook.md) |
| **高リスク・不可逆判断**         | 対外副作用を保留し、責任者（人間）の承認ゲートへエスカレーションする                        | [ai-use-charter-operations](./ai-use-charter-operations.md) ハードフロア         |

既定では設計時の**助言チェックリスト**として扱い、事前宣言の強制制約化はプロジェクト・テナント・ワークフロー方針で明示的に **opt-in** された場合のみ必須化する（既存の `on_degraded: fail` や charter ハードフロアは常に維持）。

## 関連正本

- [ORCHESTRATION_HARNESS_MODEL](../../../docs/developer/ORCHESTRATION_HARNESS_MODEL.ja.md) — 分解・ブリフ・評価ループの原則体系
- [AR-07](../../../docs/developer/improvement-plans-archive/2026-07/AR-07_SEMANTIC_INLOOP_OPS.ja.md) — in-loop semantic op のタクソノミ
- [LOOP_CLOSURE_PLAN](../../../docs/developer/improvement-plans-archive/2026-07/LOOP_CLOSURE_PLAN_2026-07-13.ja.md) — 本 rubric を含む4ループ計画
- [ai-requirements-governance-playbook](../orchestration/ai-requirements-governance-playbook.md) — 不確実性仕様と成熟度別 opt-in 制約の全体設計
