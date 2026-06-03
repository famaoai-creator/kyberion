# Satellite Architecture Model (Hybrid-C)

## 1. 概念 (Concept)
「論理（Core Brain）」と「神経（Satellite Nerves）」を物理的・依存関係的に分離するアーキテクチャ。
モノレポのビルド・パイプライン（pnpm, Node.js）をクリーンに保ちつつ、プラットフォーム固有（Swift, Python, Native SDK）の機能拡張を許容する。

## 2. 構造 (Structure)
- **Core Brain (In-Repo)**:
  - 場所: `presence/bridge/`, `presence/displays/`
  - 役割: 命令の調停（Orchestration）、UIの描画、論理的判断。
  - 技術スタック: Node.js, TypeScript, Vue.js
- **Satellite Nerves (Ext-Repo/Dir)**:
  - 場所: `satellites/` (モノレポのワークスペース外)
  - 役割: ハードウェア操作（Camera, Audio）、OS固有APIの呼び出し。
  - 技術スタック: Swift, Python, C++, etc.

## 3. 通信プロトコル (ADF Protocol v1.0)
Brain と Satellite は **ADF (Agentic Data Format)** という JSON 契約に基づいて通信する。
直接的なライブラリ呼び出しは禁止し、Loopback (HTTP/WS) または `sovereign-sync` による非同期メッセージングを推奨する。

## 4. 採用理由 (Design Rationale: Option C)
- **摩擦の最小化**: 重い依存関係（Xcode, Conda）をコア・レポジトリの CI から分離。
- **即時性の確保**: UI と Bridge は論理に近い位置（モノレポ）に配置し、開発のイテレーション速度を維持。
- **将来の拡張性**: サテライトを別端末やクラウドに配置しても、プロトコル（ADF）を変更せずにスケール可能。

---
*Status: Distilled*
*Date: 2026-03-07*
*Origin Mission: M-EVAL-EXTERNALIZATION-001*
