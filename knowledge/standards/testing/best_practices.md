# Test Automation Best Practices

「自動化されたテストが負債にならない」ための、継続的な品質維持の鉄則。

## 1. テストピラミッドの遵守
- **Unit (70%)**: ロジックの検証。高速、低コスト。
- **Integration (20%)**: スキル間、コンポーネント間の通信。
- **E2E (10%)**: 画面を通じた最終確認。最小限に絞り、重要シナリオのみを自動化する。

## 2. 不安定なテスト (Flaky Test) 対策
- **No Hard Sleeps**: `sleep(1000)` を禁じ、要素の出現を待つ `await expect().toBeVisible()` を徹底。
- **Auto-Retry**: 一時的なエラーに対し、CI上での自動再試行（最大3回）を設定。
- **Quarantine Logic**: 頻繁に落ちるテストは、修正されるまでメインパイプラインから「検疫」し、報告させる。

## 3. エビデンスとしての活用 (Chronos Mirror 連携)
- テスト失敗時の「動画（Video）」と「トレース（Trace）」を自動で Chronos Mirror のミッションログに添付し、ACEでのデバッグ判断材料とする。

---
*Created: 2026-02-14 | Focused Craftsman*
