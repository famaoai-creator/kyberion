# Kyberion Autonomy System Guide
## 🧠 究極の抽象化：自律神経系の運用ガイド

本ドキュメントでは、Kyberionが「生命」として自律的に思考・反応・進化するための4つのコア機能（AUTONOMY層）について解説します。

---

### 1. 共通短期記憶 (Shared Sensory Memory)

システム全体の「今」を共有するメモリ空間です。

#### 活用方法
プログラムから現在の文脈（Context）を問い合わせることができます。
```typescript
import { sensoryMemory } from '@agent/core';

// 直近10分以内に特定のイベントが発生したかを確認
const isUnderAttack = sensoryMemory.hasActiveContext('SECURITY_ALERT', 600000);
```

---

### 2. 反射設計図 (Reflex ADF)

特定の刺激（Stimulus）に対する「無意識の反応」をコードなしで定義します。

#### 反射の定義 (`knowledge/procedures/reflexes/*.adf.json`)
```json
{
  "id": "auto-notifier",
  "trigger": { "intent": "alert", "keyword": "CRITICAL" },
  "action": {
    "actuator": "service-actuator",
    "command": "chat.postMessage",
    "params": { "channel": "ALERTS", "text": "緊急：{{payload}}" }
  }
}
```

#### 反射の活性化
反射を常駐化する場合は `knowledge/public/governance/surfaces/*.json` に surface を宣言し、`surface-runtime` で反映します。`active-surfaces.json` は互換 snapshot です。単発実行なら `process-actuator` か governed pipeline を使います。
```bash
pnpm surfaces:reconcile
pnpm surfaces:status
```

---

### 3. 動的権限昇格 (Dynamic Permission)

「異常事態」や「特定のミッション中」のみ、安全に権限を一時開放する仕組みです。

#### ポリシーの定義 (`knowledge/governance/dynamic-policies.json`)
```json
{
  "policies": [
    {
      "id": "emergency-access",
      "condition": { "intent": "alert", "keyword": "CRITICAL", "lookback_ms": 300000 },
      "grant": { "role": "infrastructure_sentinel", "allow_paths": ["active/archive/"] }
    }
  ]
}
```
※ `safe-io` 経由のファイル操作時に、バックグラウンドで自動的に評価されます。

---

### 4. 分散神経クラスター (Nerve Cluster)

複数のプロセス間での信号の重複や無限ループを防ぎ、スケーラブルな通信を実現します。

- **Node ID**: 各プロセスに自動で一意の ID が付与されます。
- **Loopback Prevention**: 自分が発信したメッセージには反応しないよう自動制御されます。

---

### 開発・運用の指針

1.  **Memory-First**: ロジックを組む前に、`SensoryMemory` に必要な情報があるか確認してください。
2.  **Reflex-Over-Code**: 定型的な反応は TypeScript を書かず、`Reflex ADF` で定義してください。
3.  **Governance-Aware**: 動的権限を利用する際は、必ず `lookback_ms` を最小限に設定し、権限の「出しっぱなし」を防いでください。

---
*Created by Ecosystem Architect for the Kyberion Sovereign Ecosystem.*
