# Architecture: The 5-Layer Backbone of Kyberion

## 1. 概要 (Overview)
Kyberion のバックエンドは、単なる機能の集合体ではなく、自律エージェントの「生存」と「主権」を維持するための5つの物理階層として再定義される。

## 2. 5層アーキテクチャ定義

### Layer 1: Substrate (物理基盤層)
- **役割**: 自身の実行環境（Node.js, Filesystem, OS）の管理。
- **制約**: この層が不安定な場合、上位の自律性はすべて無効化される。
- **構成**: `package.json`, `pnpm-workspace.yaml`, `tsconfig.json`.

### Layer 2: Shield (防御・誠実層)
- **役割**: 機密情報の保護、I/Oのフィルタリング、主権境界の維持。
- **制約**: いかなる上位レイヤーも、この層のフィルタリングを回避して外部へデータを出してはならない。
- **構成**: `libs/core/secure-io`, `secret-guard`, `tier-guard`, `outbound-scrubber`.

### Layer 3: Actuation (執行層)
- **役割**: 外部世界に対する「物理的な手足」の提供。
- **制約**: Actuator は「なぜその操作をするか（Why）」を知ってはならない。純粋な命令（ADF）の実行に徹する。
- **構成**: `libs/actuators/` (The Physical Seven + Modeling + Service + Orchestrator).

### Layer 4: Brain (認知・推論層)
- **役割**: 状況判断、意図分類、実行パイプラインの指揮。
- **制約**: エネルギー（トークン）効率を最優先し、環境変化（エントロピー）がない場合は休止（Deep Sleep）を選択する。
- **構成**: `mission-control`, `intent-gateway`, `entropy-gate`.

### Layer 5: Memory (記憶・進化層)
- **役割**: 実行証跡の保存、知恵の蒸留、人格のバージョン管理。
- **制約**: 全ての「進化」は主権者（人間）の承認（Consensus）を通過し、ハッシュ署名されなければならない。
- **構成**: `knowledge/`, `Wisdom Vault`, `Alignment Mirror`.

## 3. 統治原則
1. **Low-Layer Immunity**: 上位レイヤーのバグや暴走は、下位レイヤー（特に Shield）の物理的制約によって阻止されなければならない。
2. **Explicit Evidence**: すべての物理的操作は、Layer 5 へ永続的な証跡（Hash）を残さなければならない。
3. **Recursive Refinement**: 自身のバックエンド自体も、Layer 4 と Layer 5 のフィードバックループによって自律的に改善され続ける。

---
*Standardized at Kyberion during The Great De-monolithization 2026-03*
