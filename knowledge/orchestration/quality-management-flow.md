# エンタープライズ品質管理フロー (Quality Management Flow)

成果物の品質を担保し、エンタープライズの監査に耐えうるエビデンスを残すための標準フロー。

## ステップ

1. **成果物レビュー (Audit Phase)**:
   - 既存の定義（RD, NFR等）に対し、`requirements-wizard` 等を用いて標準との乖離を特定。
2. **レビュー結果報告書の作成 (Evidence Phase)**:
   - 指摘事項、判定（合格/条件付/不合格）、改善方針を `docs/review_results.md` として保存。
3. **自律的改善 (Improvement Phase)**:
   - `mission-control` が報告書に基づき、各ドキュメントを自律的に修正。
4. **最終検証 (Final Verification)**:
   - 修正後の差分を確認し、指摘事項がすべて解消されたことを確認して「完了」とする。
