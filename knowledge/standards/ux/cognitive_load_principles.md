# Cognitive Load Principles for UX Design

`ux-visualizer` が設計・解析を行う際に遵守すべき、人間中心のUX原則。

## 1. Miller's Law (マジカルナンバー7)
- **原則**: 人間が一度に保持できる情報は 7±2 個である。
- **解析指標**: `NavBar` のリンク数や、1画面内の重要アクション数が多すぎないかをチェック。

## 2. Hick's Law (ヒックの法則)
- **原則**: 選択肢の数が増えるほど、意思決定にかかる時間は対数的に増大する。
- **解析指標**: コンポーネント内のボタン配置を分析し、ユーザーの迷いをスコアリング。

## 3. Gestalt Principles (ゲシュタルト要因)
- **原則**: 近接、類同、閉合などにより、要素はグループとして認識される。
- **解析指標**: `ux-visualizer` で生成する Mermaid 図において、関連する機能を `subgraph` でまとめる論理的根拠とする。

## 4. Progressive Disclosure (段階的開示)
- **原則**: 情報を一度に出さず、ユーザーの必要に応じて段階的に開示する。
- **解析指標**: 初期画面（Default View）とホバー/クリック後（Interaction View）の情報の密度バランスを評価。

---
*Created: 2026-02-14 | Aesthetic Pragmatist*
