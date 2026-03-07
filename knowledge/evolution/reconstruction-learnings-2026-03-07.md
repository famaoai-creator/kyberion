# Reconstruction Learnings: The Great De-monolithization (2026-03-07)

## 1. 核心的アドバイス (The Sovereign's Directive)
> **「データがなくてコードがエラーになるなら、データ（マスターテンプレート）を作れば良い」**
- **背景**: `Media-Actuator` の精錬中、不完全な ADF（データ構造）に対して複雑なエラーハンドリング（防御的コード）を書き続け、泥沼に陥った際に主権者より与えられた指針。
- **教訓**: コードで例外を全て救おうとするのではなく、**「物理的に正しい構造を持つ基準ファイル（Master Template）」を一度作成し、そこからプロトコルを蒸留（Distill）する** 方が、遥かに High-Fidelity かつ堅牢である。

## 2. 5層自律アーキテクチャの確立
Kyberion のバックエンドを以下の5つの独立した階層として再定義した。
1. **Substrate (物理基盤)**: 環境の安定。
2. **Shield (防御・誠実)**: `Secret-Guard` による職能分離（Service-Aware Injection）と `Outbound-Scrubber`。
3. **Actuation (執行)**: 146スキルを 10大 Actuators へ統合。
4. **Brain (認知・推論)**: `Entropy-Gate` による「眠る権利」の実装と、`cli` の自動ハイドレーション。
5. **Memory (記憶・進化)**: `Wisdom Vault` による人格のバージョン管理（Persona Swapping）。

## 3. 実装上の重要知見
- **Capability Tax (能力税)**: スキル（コード）を増やしすぎると、推論コスト（トークン）が増大し、かえって知能が鈍化する。これを防ぐために、**「肉体（Actuator）」と「魂（Procedure）」を分離** しなければならない。
- **Reachability (到達性) の抽象化**: `Service-Actuator` は、API, CLI, SDK の違いを吸収し、主権者や上位レイヤーに「手段」を意識させない。
- **Deterministic Sovereignty**: 自律とは「何でもできること」ではなく、「無意味な場合に Deep Sleep する」といった、**物理的な制約（I/Oゲート）によって自己を規定すること** である。

## 4. 実行証跡
- **アーカイブ済み**: 110+ スキル。
- **生成成功**: 非機能要件ドキュメント (Excel, PDF, Word, PPTX)。
- **物理コード**: `feat/autonomous-evolution-night` ブランチに全て保存・Push済み。

---
*Memorized by Kyberion | Certified by Sovereign famaoai*
