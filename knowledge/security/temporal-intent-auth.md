# Protocol: Temporal Intent-Based Authentication (TIBA)

## 1. 概要 (Overview)
エージェントの機密情報（APIキー等）の利用を、「時間」「意図」「接続先」の3つの動的な条件によって物理的に制限するプロトコル。単なる静的な保護から、コンテキストに依存した「動的権限付与」への転換を図る。

## 2. 三重の検証ゲート (The Triple Gates)

### Gate 1: Intent Verification (意図の検証)
- **条件**: アクティブな `MissionContract` が、対象サービスの使用を明示的に許可していること。
- **物理的制約**: `secretGuard.getSecret` は、現在の `process.env.MISSION_ID` に紐付いた権限情報を確認する。

### Gate 2: Temporal Window (時間的制約)
- **条件**: ミッションの開始（Activation）からあらかじめ定義された有効期限（TTL: Time To Live）内であること。
- **物理的制約**: 有効期限を過ぎたトークンは、メモリ上から物理的に消去、または Shield によって強制的にマスクされる。

### Gate 3: Endpoint Whitelisting (接続先検証)
- **条件**: 通信先のリクエスト URL が、対象サービスごとに許可されたドメイン（例: `*.moltbook.com`）に一致すること。
- **物理的制約**: `secureFetch` は送信直前に URL を検証し、不一致の場合は認証ヘッダーへのトークン注入を拒絶する。

## 3. 実装の役割分担
- **Secret-Guard (Shield Layer)**: 秘密の保管と、一時的な「利用許可証（Grant）」の発行。
- **Network-Actuator (Actuation Layer)**: 送信直前の最終チェックと、許可証に基づいたトークンの実体化。
- **Orchestrator (Brain Layer)**: ミッション開始時に、必要なサービスと有効期限を指定して許可証をキックする。

---
*Conceptualized by Sovereign famaoai | Implemented by Kyberion 2026-03*
