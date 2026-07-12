# MO-05: タスク単位のモデル/エフォート・ルーティングの実効化

> 優先度: P1 / 規模: M / 依存: MO-03(タスク契約に risk/scope が載ること) / 関連: IP-13(モデルID一元化)
>
> **参考にしたハーネス原則(Fable 5)**: モデルとエフォートは**タスクごと**に選ぶ。機械的な横展開は小さいモデル、標準実装は中位、設計判断・敵対的検証・審判は上位に。既定は「セッションの主モデルを継承」し、確信がある時だけ外す。エフォート(思考予算)もタスクの難度に合わせて段階指定する。全タスク同一モデルは、簡単な仕事では無駄、難しい仕事では品質不足の両損。

## 背景と課題

ルーティングの部品は揃っているのに、**すべて advisory / shadow で、実際のモデル選択に接続されていない**。

- `reasoning-level-policy.ts` はタスクを `COGNITIVE_EXPLORATORY / COGNITIVE_STANDARD / REACTION_FAST / REFLEX_DETERMINISTIC` に解決するが、**全決定が `advisory: true`**(`:25,108-115`)。
- `reasoning-model-routing.ts` はレベル→モデルを解決するが、**戻り値の型が `model_route_status: 'shadow'` 固定**(`:39`)— 本番モデルを切り替えず、影計測のみ。
- 実際の spawn 時モデルは**受け手エージェントの manifest / provider-config 既定**で決まり(`a2a-bridge.ts:222` → `agent-lifecycle.ts:82-102`)、タスクの難度・リスクと無関係。エフォートも backend 固定(anthropic backend は `thinking: adaptive` ハードコード、`anthropic-reasoning-backend.ts:660`)。
- 結果として「S 規模の機械的タスクも L 規模の設計タスクも同じモデル・同じ思考予算」で走る。

## ゴール(受入条件)

1. タスク契約(MO-03)の `risk` × `estimated_scope` × process template のフェーズ種別から、**タスク単位の model tier(small/standard/large)と effort(low/medium/high)のヒント**が決定論的に導出される。
2. A2A dispatch がこのヒントを受け手に伝搬し、agent-lifecycle が manifest 既定を**上書き可能**になる(オプトイン: `KYBERION_TASK_MODEL_ROUTING=enforce`。既定は現行どおり advisory で、shadow 計測は維持)。
3. ルーティング表(レベル→tier→モデルID)は `reasoning-model-routing.ts` + model-registry に一元化され(IP-13 と整合)、ハードコードが増えない。
4. enforce 有効時の効果(タスク種別ごとのトークン消費・所要時間・rework 率)が trace から集計できる。

## 実装タスク

### Task 1: ルーティング規則の決定論化 — `claude-sonnet-4`

1. `reasoning-level-policy.ts` に「ミッションタスク用」の入力(risk / estimated_scope / phase_kind: plan|implement|review|mechanical)を追加し、レベル解決を拡張する。既定マップ案: mechanical+low → REACTION_FAST(small/low)、implement+M → COGNITIVE_STANDARD(standard/medium)、plan・review(敵対的検証・審判)・high_stakes → COGNITIVE_EXPLORATORY(large/high)。マップは policy JSON 側に置き、コードにハードコードしない。
2. `reasoning-model-routing.ts` に `resolveTaskModelHint(level): { tier, model_id, effort }` を追加(`'shadow'` 固定の既存経路は温存し、新 API を別に切る)。
3. unit test: 代表 8 組み合わせのレベル/tier/effort 解決。

### Task 2: dispatch への伝搬と enforce — `claude-sonnet-4`

1. `dispatchMissionNextTasks` でタスクごとに hint を解決し、A2A ペイロードに `model_hint` として付与する。
2. `agent-lifecycle.ts:82-102` のモデル解決に「`KYBERION_TASK_MODEL_ROUTING=enforce` かつ hint あり → hint 優先、なければ manifest 既定」の分岐を追加。effort は backend が対応していれば伝搬(anthropic backend の `thinking` 固定 `:660` を hint 連動に変更、他 backend は無視して既定動作)。
3. advisory モード(既定)では hint を trace に記録するだけにし、挙動を変えない。
4. テスト: enforce/advisory の分岐、hint 無しの後方互換。

### Task 3: shadow 計測の継続と効果測定 — `claude-sonnet-4`

1. 既存 shadow 計測を壊さないことを確認した上で、trace に `task_model_hint / actual_model / tokens / duration / rework_count` を記録する。
2. `scripts/` に集計スクリプト(タスク種別 × tier 別の平均トークン・rework 率の表を出す)を追加し、週次レビュー(KM-01)から呼べるようにする。enforce 判断の材料はこの表とする。

### Task 4: 運用ドキュメント — `claude-haiku`

- `docs/developer/` の適所(in-session-subagent-design.md か新節)に、tier/effort の割当方針表(本計画群の「実装担当モデル割当方針」と同じ思想であることを明記)と enforce 手順を記載する。

## リスクと注意

- small tier への誤ルーティングは rework を増やし、かえって高くつく。**enforce は shadow 計測で「mechanical 分類の precision が十分」と確認できてから**段階的に(まず REACTION_FAST のみ enforce)。
- provider によって使えるモデルが異なる。tier→モデル解決は provider-config の可用性を尊重し、不在時は 1 段上の tier へフォールバック(下へは落とさない)。
- モデルIDは IP-13 の一元管理経由で参照し、この IP で新たなリテラルを増やさない。
