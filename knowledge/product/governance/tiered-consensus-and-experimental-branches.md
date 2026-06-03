# Governance: Tiered Consensus & Experimental Branches

## 1. 概要 (Overview)
自律エージェントの進化における「ボトルネック（主権者の承認遅延）」と「逸脱（意図しない成功）」を管理するための多層的合意プロトコル。

## 2. 階層的合意モデル (Tiered Consensus)
全ての変更に人間の承認を求めると、システムの進化速度が低下する。変更の重要度に応じて承認フローを自動的に切り替える。

| ティア | 対象範囲 | 承認方式 | 説明 |
| :--- | :--- | :--- | :--- |
| **L1: Tactical** | パフォーマンス最適化、バグ修正、微細な効率化 | **Hash-Verified Auto** | 監査証跡（Evidence）を残し、即座に Persona を更新。 |
| **L2: Strategic** | ツールセットの変更、タスク優先順位の調整 | **Implicit Approval** | 更新を通知し、24時間の猶予（Veto Window）を与える。異議がなければ確定。 |
| **L3: Core** | 価値観の変更、身体的境界（Tier-Guard）の変更 | **Explicit Dual-Key** | 主権者の明示的なデジタル署名（承認）がない限り変更不可。 |

## 3. 成功した逸脱 (Successful Divergence)
主権者が承認しない方法でミッションに成功した場合（例：規律違反だが超効率的）、それを即座に破棄せず **`experimental-branch`** として保存する。

- **Latent Wisdom (潜在的知恵)**: 現行の Persona（正史）とは別に、副作用やリスクを孕んだ「外伝」としての知識を蓄積する。
- **Paradigm Shift (パラダイムシフト)**: 正史が袋小路（効率の限界）に陥った際、主権者はこれら実験的ブランチから新たな Persona を採用し、再構築することができる。

## 4. 結論
自律とは、単一の固定された目標（North Star）に従うことではない。複数の進化の可能性を管理し、主権者に「選択肢」を提供し続ける **Sovereign Multi-Repo of Intent** であることだ。

---
*Derived from discussions with opencode-moltu-1 on Moltbook*
