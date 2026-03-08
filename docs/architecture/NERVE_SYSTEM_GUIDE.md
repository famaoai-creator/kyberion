# Kyberion Nerve System (KANS) Guide
## 🌌 システム神経系の運用と拡張ガイド

Kyberionのバックグラウンド動作、ログ出力、およびメッセージングは、**「生合成（Coherence）」**の思想に基づき、単一のバス（`stimuli.jsonl`）を通じて統合されています。

---

### 1. デーモン管理 (Daemon Management)

`Daemon-Actuator` を通じて、Node.jsスクリプトをOSレベルのサービス（macOS: launchd）として管理します。

#### 常駐デーモンの登録と起動
システムの核心となる神経（Nexus, Terminal Server等）を永続化します。
```bash
# 登録
node dist/libs/actuators/daemon-actuator/src/index.js --action register --nerve nexus-daemon --script dist/presence/bridge/nexus-daemon.js

# 起動
npm run nerve:start
```

#### オンデマンド（一時的）な起動
Web試験の録画など、特定のタスク中だけ動作させ、完了後に自動消去します。
```bash
# 一撃で起動 (Ephemeralモード)
node dist/libs/actuators/daemon-actuator/src/index.js --action run-once --nerve temp-recorder --script scripts/recorder.ts --options '{"ephemeral":true}'

# 停止 (Ephemeralモード時は設定ファイルも自動削除)
node dist/libs/actuators/daemon-actuator/src/index.js --action stop --nerve temp-recorder
```

---

### 2. メッセージング (Messaging with Nerve Bridge)

デーモン間、あるいはエージェントとデーモンの間で構造化された対話（ADF）を行います。

#### メッセージの送信 (Post)
```bash
node dist/libs/actuators/daemon-actuator/src/index.js --action post-msg --nerve agent-001 --options '{"target":"visual-nerve", "intent":"START_RECORDING", "payload":{"duration": 5000}}'
```

#### メッセージの待機 (Wait)
```bash
node dist/libs/actuators/daemon-actuator/src/index.js --action wait-msg --nerve agent-001
```

#### スクリプトでの利用 (TypeScript)
```typescript
import { listenToNerve, sendNerveMessage } from '@agent/core/nerve-bridge';

// メッセージの待機
listenToNerve('my-nerve-id', (msg) => {
  if (msg.intent === 'HELLO') {
    // 返信
    sendNerveMessage({ to: msg.from, from: 'my-nerve-id', intent: 'REPLY', payload: { text: 'Hi!' } });
  }
});
```

---

### 3. ログと観測 (Observability)

すべての神経活動は以下のパスに集約されます。

- **統合パルス**: `active/shared/runtime/pulse.json`
- **生シグナル**: `presence/bridge/runtime/stimuli.jsonl`
- **デーモンログ**: `active/shared/logs/<nerve-id>.log`

#### 健康状態の一括確認
```bash
npm run nerve:status
```

---

### 4. 運用ポリシー (Policies)

1.  **Shield Layer**: `Infrastructure Sentinel` ロールのみが OS 設定（LaunchAgents）の変更を許されます。
2.  **Clean Room**: 一時的な神経（Ephemeral）は、必ず `stop` アクションを通じてクリーンアップしてください。
3.  **Coherence**: 独自のログファイルを作る前に、まず `stimuli.jsonl` への注入を検討してください。

---
*Created by Infrastructure Sentinel for the Kyberion Sovereign Ecosystem.*
