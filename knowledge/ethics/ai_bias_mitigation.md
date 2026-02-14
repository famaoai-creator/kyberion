# Data Ethics & AI Bias Mitigation Standard

AIが生成する判断やコードが、倫理的に中立であることを保証するための監査基準。

## 1. 公平性 (Fairness) の定義
- **Group Fairness**: 性別、人種、年齢などの属性によって、AIの出力（採用判定、与信枠など）に統計的な有意差が生じていないか。
- **Counterfactual Fairness**: 「もしその属性が違っていたら、結果はどう変わったか？」をシミュレーションする。

## 2. データセットの監査 (Dataset Auditing)
- **Representativeness**: 訓練データが対象人口を適切に代表しているか（サンプリングバイアス）。
- **Historical Bias**: 過去の差別的な慣習が含まれるデータ（例：過去の給与格差）をそのまま学習させていないか。

## 3. Explainability (説明可能性)
- ブラックボックスな判断を避け、なぜその結果になったのかを人間が理解できる言語で説明する機能を実装する（XAI）。

---
*Created: 2026-02-14 | Guardian of Ethics*
