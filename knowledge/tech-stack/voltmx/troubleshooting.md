# VoltMX Troubleshooting Guide

開発およびデバッグ時によくある問題と解決策。

## 1. ビルド / 実行時エラー
- **Simulator が起動しない**:
    - `Visualizer` のビルド設定で対象 SDK が正しくインストールされているか確認。
    - Chrome デバッガー (`chrome://inspect`) を開き、エラーログを確認する。
- **Foundry 初期化エラー**:
    - `App Key` / `App Secret Key` / `Service URL` が正しいか、およびネットワーク制限（VPN等）がないか確認。

## 2. デバッグ手法
- **Iris Debugger**: 組み込みのデバッガーを使用して、ブレークポイントを設定。
- **Foundry Console**: `Admin Console` の `Logs` セクションで、ミドルウェア層でのエラー（API通信失敗など）を追跡。
- **Postman**: Foundry を通さずにバックエンド API が正常に動作しているか単体でテストする。

## 3. UI の不具合
- **レイアウトが崩れる**: `Parent` コンテナの `Layout Type` (Vertical/Horizontal/Free form) を再確認。
- **Skins が適用されない**: コンポーネントの `Focus Skin` や `Hover Skin` が意図せず上書きされていないか確認。

---
*Created: 2026-02-14 | Focused Craftsman*
