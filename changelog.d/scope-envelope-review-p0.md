---
category: Fixed
---

- **スコープ封筒 (#896) のレビュー指摘と回帰の修正** — preflight 内部スタンプ (`_effect` 等) が op 入力へ漏れ、`additionalProperties: false` の actuator（`system:baseline_check` ほか）が拒否していた回帰を `governance_stamps` 分離で修正（golden 復旧）。別プロセスで承認された held action が catch-up で executor を失う問題を op 単位の process レジストリで修正し、catch-up は live closure/params を保持する。held の `params` は既定で保存せず、提出側が `persistParams` で明示した場合のみ保存（秘匿らしいキーは拒否）。予約名・不正な tenant slug は journal の quarantine へ。SC-05 の各段は呼び出し元入力ではなく封筒/プロセススコープのみを身元とする。narrow / 委譲 mint は mission 記録に anchor されない identity を持ち込めず、委譲 policy はプロセス tier に clamp。provenance egress 判定は入力スタンプを信頼せず常に制御プレーンから再計算。
