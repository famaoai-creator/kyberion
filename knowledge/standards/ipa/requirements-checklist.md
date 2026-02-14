# IPA-Aligned Requirements Engineering Standard

## 1. Functional Requirements (機能要件)

要件は以下の 3 つの「完全性」を満たさなければならない：

- **Validity (妥当性)**: ビジネスの目的に対して必要十分か？
- **Unambiguity (一義性)**: 読み手によって解釈が分かれないか？
- **Testability (検証可能性)**: 客観的なテストによって合格・不合格を判定できるか？

## 2. Non-Functional Requirements (非機能要件)

IPA「非機能要求グレード」に基づく 6 大項目を AI 監査の基準とする：

### 2.1 Availability (可用性)

- 稼働時間、ダウンタイムの許容範囲。
- バックアップ・リカバリ手順の有無。

### 2.2 Performance (性能)

- レスポンスタイム目標。
- 同時実行ユーザー数、データ処理能力。

### 2.3 Security (セキュリティ)

- 認証、認可、アクセス制御。
- 暗号化、脆弱性スキャン、ログ監視。

### 2.4 Scalability (拡張性)

- データ増加に伴うリソース追加の容易さ。

### 2.5 Usability (運用・保守性)

- ログの可読性。
- ドキュメント（README, ADF）の整備。

### 2.6 Sustainability (継続性)

- 依存ライブラリのEOL管理、技術スタックの選定。

---

_Reference: Derived from IPA Non-functional Requirements Grade 2018_
