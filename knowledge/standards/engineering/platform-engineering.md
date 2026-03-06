---
title: Platform Engineering & DevEx Standards
category: Standards
tags: [standards, engineering, platform]
importance: 10
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Platform Engineering & DevEx Standards

このドキュメントは、開発者の認知負荷を下げ、高品質なソフトウェアを「セルフサービス」で高速にリリースするための、プラットフォームエンジニアリングと開発者体験 (DevEx) の標準規約である。

## 1. ゴールデン・パス (Golden Paths)

「ゴールデン・パス」とは、特定のタスク（例：新規マイクロサービスの作成）を完了するための、推奨され、サポートされた、自動化されたパスのことである。

- **セルフサービス**: 開発者がチケットを発行して待つのではなく、ポータルやCLIからオンデマンドで環境やリソースを払い出せる。
- **抽象化**: インフラの複雑さ（KubernetesのYAML、IAM設定等）をプラットフォーム層で隠蔽し、開発者がアプリケーションコードに集中できるようにする。

## 2. 開発者体験 (DevEx) の 3 つの柱

1.  **フィードバック・ループの短縮**: ローカル開発環境、CIテスト、プレビュー環境の実行速度を極限まで高める。
2.  **認知負荷の軽減**: 開発者が覚えるべきツールや概念を最小限に抑える。
3.  **フロー状態の維持**: コンテキストスイッチを減らし、中断のない開発体験を提供する。

## 3. IDP (Internal Developer Platform) の構成要素

- **環境管理**: テスト用、ステージング用の一時的な環境（Ephemeral Environments）の自動生成。
- **可観測性の一体化**: ログ、メトリクス、トレースがデフォルトで設定され、ダッシュボードが自動提供される。
- **ガバナンスのガードレール**: セキュリティスキャンやコンプライアンスチェックが、開発者の手を煩わせることなくバックグラウンドで実行される。

## 4. 評価指標

- **Developer Lead Time**: コードの最初のコミットから本番稼働までの時間。
- **Onboarding Time**: 新しい開発者が最初のコードをデプロイするまでにかかる時間。
- **Tooling Satisfaction**: 開発者アンケートによる満足度調査。

---
*Created by Gemini Ecosystem Architect - 2026-02-28*
