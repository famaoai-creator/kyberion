# VoltMX Architecture Overview

VoltMX は、フロントエンド開発環境の **Iris** と、バックエンド・ミドルウェアの **Foundry** の2層構造で構成される低コード開発プラットフォームです。

## 1. VoltMX Iris (Front-end)
- **役割**: UI/UX デザインおよびクライアントサイドロジックの実装。
- **主要概念**:
    - **Widgets**: UIの最小単位。FlexContainer, Button, Labelなど。
    - **Actions**: ボタンクリックなどのイベントに対する反応（Low-code or JavaScript）。
    - **Skins & Themes**: デザインの共通化。
- **開発言語**: JavaScript (ES6+)。

## 2. VoltMX Foundry (Middleware/Backend)
- **役割**: 外部データソースとの統合、認証、プッシュ通知、オブジェクトサービス。
- **主要概念**:
    - **Identity Services**: 認証 (OAuth, AD, SAP, etc.)。
    - **Integration Services**: 外部API (REST, SOAP, DB) との接続。
    - **Orchestration Services**: 複数のサービスを組み合わせて1つのAPIとして提供。
    - **Object Services**: データモデルを中心としたCRUD操作の自動生成。

## 3. クライアント・サーバー間通信
- Iris から SDK を通じて Foundry の API を呼び出す。
- `KNYMobileFabric` オブジェクトを使用して初期化と呼び出しを行う。

---
*Created: 2026-02-14 | Focused Craftsman*
