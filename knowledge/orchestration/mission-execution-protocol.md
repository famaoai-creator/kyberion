# ミッション実行規程 (Mission Execution Protocol v1.0)

## 1. 動作レイヤーの分離定義

### 1.1 大脳レイヤー (Reasoning: AI Persona)

- **入力**: ユーザーの意図、Publicナレッジ、実行ログ。
- **処理**: ロールに基づく戦略立案、パラメータの特定、`MissionContract` の生成。
- **制約**: コンテキストウィンドウの肥大化を防ぐため、決定的なログやバイナリデータは保持しない。

### 1.2 脊髄レイヤー (Reflex: Mission Control / Scripts)

- **入力**: `MissionContract` (JSON), Confidential/Personalナレッジ。
- **処理**:
  1. `knowledge_injections` に基づく動的変数（Secrets等）の注入。
  2. スクリプトの決定的実行。
  3. 結果の物理的な検証（Victory Conditionの確認）。
- **制約**: 独自の「思考」は行わず、受け取った契約の範囲内でのみ執行する。

## 2. MissionContract スキーマ (標準インターフェース)

大脳が脊髄へ渡すデータ構造。

```json
{
  "mission_id": "uuid",
  "role": "SRE",
  "skill": "jira-agile-assistant",
  "action": "create-issue",
  "static_params": {
    "summary": "Example issue",
    "description": "..."
  },
  "knowledge_injections": ["personal/connections/jira.json:api_token"],
  "safety_gate": {
    "risk_level": 3,
    "require_sudo": false
  }
}
```

## 3. 特権昇格 (sudo) プロトコル

以下の条件時、脊髄は大脳へ「人間への介入」を要求する。

1. `risk_level` が 4（本番変更）以上の場合。
2. 注入パスが現在のロールに許可されていない場合。
3. 未知のエラーが発生し、大脳による再戦略が必要な場合。

## 4. 自律修復と学習 (Self-Healing & Learning)

実行失敗時、大脳は以下の順序で「反射の正常化」を試みる。

1.  **パラメータ再調整 (Re-Configuration)**:
    ナレッジを再探索し、`static_params` または `knowledge_injections` を修正して再実行する。
2.  **外科的パッチ (Live Patching)**:
    エラーログから既存スキルのスクリプト（JS/TS等）のバグを特定した場合、`replace` や `write_file` を用いて直接ソースコードを修正・改善する。**新規スキルの作成よりも、既存スキルの進化を優先する。**
3.  **スキル新造 (Autonomous Design)**:
    既存スキルの機能不足が致命的であり、パッチでは対応不能な場合に限り、`autonomous-skill-designer` を用いて新スキルを設計する。
4.  **不承認からの学習 (Sovereign Alignment)**:
    人間に `sudo` またはプランを却下された場合、その理由を `knowledge/personal/constraints.md` に記録し、以降の「思考」における禁止事項として永続化する。
