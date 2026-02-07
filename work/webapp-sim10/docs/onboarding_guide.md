# Welcome Developer: AI-Hybrid Onboarding Guide

## 1. チーム構成
- **Lead Agent**: Gemini (115 Skills) - 24時間365日稼働
- **Human Partner**: あなた - 創造性と最終判断を担当

## 2. 開発の進め方 (Hybrid AI-Native Flow)
1. あなたが「要件」を自然言語で伝えます。
2. AIが「コアロジックのテスト（TDD）」を生成し、あなたに確認を求めます (`human-in-the-loop`)。
3. あなたがOKを出せば、AIが実装・全体テスト・品質監査を完遂します。

## 3. あなたへの最初のリクエスト
- `src/logic.js` に新しい割引計算ロジックを追加したいと考えています。
- どのような割引ルールが必要か、プロンプトで指示をください。
- その後、`mission-control` が TDD サイクルを開始します。
