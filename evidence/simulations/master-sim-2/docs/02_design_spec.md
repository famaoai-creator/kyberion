# 基本・詳細設計書：請求判定モジュール

## 1. システム構成 (Architecture)
- **Layer 1: Entry**: API Gateway によるリクエスト受信。
- **Layer 2: Logic**: `ClaimValidator` による整合性チェック。
- **Layer 3: Calc**: `PayoutCalculator` による金額計算。

## 2. 処理アルゴリズム (Detailed Logic)
- **契約期間チェック**: `policy.startDate <= accidentDate <= policy.endDate`
- **支払額計算**: `baseAmount * (1 + specificRiderRate)`
