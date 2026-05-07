# Kyberion Nerve System (KANS) Guide
## 🌌 システム神経系の運用と拡張ガイド

Kyberionのバックグラウンド動作、ログ出力、およびメッセージングは、**「生合成（Coherence）」**の思想に基づき、単一のバス（`stimuli.jsonl`）を通じて統合されています。

---

### 1. サーフェスとプロセス管理 (Surface and Process Management)

長寿命の神経系プロセスは `active-surfaces.json` と `surface-runtime` で宣言的に管理します。単発の補助プロセスは `process-actuator` に委譲します。

#### 常駐サーフェスの反映と起動
システムの核心となる神経（Slack Bridge, Chronos, OAuth Callback Surface 等）を shared manifest から再調整します。
```bash
# 宣言済みサーフェスを reconcile
pnpm surfaces:reconcile

# 状態確認
pnpm surfaces:status
```

#### オンデマンド（一時的）な起動
Web試験の録画や一時 bridge のような寿命付きプロセスは、`process-actuator` の `spawn` / `stop` で管理します。OS 固有の `launchd` 設定を直接生成してはいけません。

---

### 2. メッセージング (Messaging with Nerve Bridge)

デーモン間、あるいはエージェントとデーモンの間で構造化された対話（ADF）を行います。

メッセージ送受信は `@agent/core/nerve-bridge` を通して行います。旧 `daemon-actuator` CLI は retired です。

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
- **サーフェスログ**: `active/shared/logs/surfaces/<surface-id>.log`

#### 健康状態の一括確認
```bash
pnpm surfaces:status
```

---

### 4. 運用ポリシー (Policies)

1.  **Shield Layer**: durable runtime の定義変更は `knowledge/public/governance/active-surfaces.json` と review を通してください。
2.  **Clean Room**: 一時的な神経（Ephemeral）は `process-actuator` で owner を持って起動し、明示的に stop してください。
3.  **Coherence**: 独自のログファイルを作る前に、まず `stimuli.jsonl` と governed runtime logs を利用してください。

---
*Created by Infrastructure Sentinel for the Kyberion Sovereign Ecosystem.*
