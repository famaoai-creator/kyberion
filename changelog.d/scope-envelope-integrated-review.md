---
category: Fixed
---

- **スコープ封筒の統合ブランチ (#896) レビュー修正** — 承認済み held effect が複数プロセスの同時 apply で二重実行される問題を、journal ロック内の claim（catch-up → 再確認 → 追記）で exactly-once に修正（claim 後に結果が記録されない effect は再実行しない）。SC-06 の egress ガードが呼び出し元の `payload_hash` / 未宣言の `target_audience` を信用していた点を修正（ハッシュは実際の送信内容から計算、tainted mission で宛先未宣言は fail-closed）。declassify grant のキーに mission を含め、mission 間の上書きを防止。CodeQL が指摘した `browser-judgment` の polynomial ReDoS を線形走査に置換。
