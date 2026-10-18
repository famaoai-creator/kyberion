---
title: 作業完了から再利用候補への自動接続
tags: [mission, retrospective, workflow, pipeline, reuse]
last_updated: 2026-10-18
runtime_stages: [verification, retrospective]
---

# 作業完了から再利用候補への自動接続

通常の mission 完了時の振り返りで、検証済み成果物の証跡から再利用の要否を評価する。
担当者が別途パイプライン化を思い出して実行する必要はない。

1. `verification.status=verified` かつ `distilling` / `completed` の mission を対象にする。
2. mission 内のテキスト証跡を件数・サイズ制限つきで読み、LLM の tier / tenant egress gate を通して評価する。
3. 一回限り、既存パイプラインの再利用、新規パイプライン候補の三つに分類する。
4. 候補の ADF、guardrails、op・channel の dry-run 検査結果を保存する。
5. 静的検証を通った候補を同じスコープの memory promotion queue に渡す。正式登録と実行は別のレビュー・承認を経る。

## 証跡と判定

`evidence/workflow-reuse.json` が最新結果で、`evidence/workflow-reuse/<hash>/` が内容に紐づく不変の候補である。
同じ証跡と評価を再利用し、既存テンプレートや検証結果が変われば新しい候補を作る。
テンプレートの内容ハッシュも候補の識別に含め、検証した内容と保存する内容を一致させる。

- `not_assessed`: 完了条件を満たさない、証跡不足、LLM 利用不可など。成功扱いにしない。
- `one_off`: 一回限りの作業として記録し、昇格候補は作らない。
- `blocked`: 未提示証跡、スコープ逸脱、未確認ファイル、検証失敗など。理由を確認して候補を修正する。
- `needs_review`: 静的検証済みの候補。別入力による再実行はまだ行っていない。

毎回の判断が必要な工程は reasoning brief として残す。候補生成は外部送信、実行権限、定期実行や正式登録を承認しない。
レビューでは入力の差し替え、成功条件、機密情報、承認境界を確認し、承認済みの別入力で再実行してから governed promotion を行う。

## 再実行と障害対応

バックエンド停止時は未評価の理由を確認し、復旧後に通常の振り返りを再実行する。
queue への引き渡しが失敗しても、保存済み評価と不変候補から同じ candidate ID で再試行できる。
静的検証の成功を実行成功と扱わず、`validation.replay=not_run` と `execution_authorized=false` を維持する。

関連: [振り返り手順](../governance/phases/review.md)、[scratch から pipeline への昇格](./scratch-to-pipeline-video-promotion.md)。
