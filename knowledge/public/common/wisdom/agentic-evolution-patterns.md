---
title: Wisdom: Agentic Evolution & Architecture Patterns
category: Common
tags: [common, wisdom, agentic, evolution, patterns]
importance: 5
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Wisdom: Agentic Evolution & Architecture Patterns

このドキュメントは、Kyberion エコシステムの進化過程から得られた、自律型 AI エージェント基盤における普遍的な設計指針（知恵）を蓄積したものである。

## 1. Evidence-based Skill Genesis (実証に基づくスキルの誕生)
- **Problem**: 想像上のユースケースに基づいたスキルの事前実装は、負債の温床となる。
- **Wisdom**: スキル（恒久的なプログラム）の実装は「最後の手段」である。
- **Practice**: 
  1. まず `scratch/` でのアドホックな試行錯誤（Mission Execution）を通じて、現実の課題を泥臭く解決する。
  2. その解決手順が「再現可能」で「堅牢」であることを実証（Validation）する。
  3. 成功体験の中から不変のロジックのみを抽出し、初めて「スキル」へと昇華（Distillation）させる。

## 2. Brain-Spinal Cord Hierarchy (大脳と脊髄の階層的分離)
- **Problem**: 推論（AI）と実行（Tool）が混ざり合うと、エラー時に手段が目的化し、環境を破壊する。
- **Wisdom**: システムを「推論レイヤー（大脳）」と「決定論的実行レイヤー（脊髄）」に物理的・論理的に分離せよ。
- **Practice**:
  - **Alignment Phase (大脳)**: ツールを封印し、純粋な推論で意図（Intent）を解釈し、タスクボードを設計する。
  - **Execution Phase (脊髄)**: 推論を介入させず、定義されたタスクを決定論的なプログラムとして淡々と実行する。
  - **Exception**: 実行中に前提が崩れた場合は、脊髄反射で直そうとせず、直ちに「再アラインメント」を要求して大脳に制御を戻す。

## 3. Dynamic Triage & Mode Switching (動的トリアージ)
- **Problem**: 一律の重厚なプロセスはアジリティを殺し、一律の自由は安全性を殺す。
- **Wisdom**: ミッションの「確信度（Confidence）」と「リスク（Risk）」に基づく動的なモード切り替えを導入せよ。
- **Practice**:
  - **Low Risk / High Confidence**: 官僚的な手続きをスキップする「YOLOモード」を奨励し、ベロシティを最大化する。
  - **High Risk**: 厳格な計画・シミュレーション・承認（Sudo Gate）を強制する。
  - **Judge**: この切り替え判断（Triage）こそが、エージェントの最も重要な知能のひとつである。

## 4. Knowledge Abstraction & Provider Pattern (知識アクセスの抽象化)
- **Problem**: 物理ファイルへの直接依存は、テストの脆弱性と環境の不整合を招く。
- **Wisdom**: 知識ベース（Rules/Standards）へのアクセスを抽象化レイヤーで包み、DI（依存性の注入）を可能にせよ。
- **Practice**:
  - `KnowledgeProvider` 等を通じて知識を取得することで、本番環境では物理ファイルを、テスト環境ではメモリ上のモックデータを透過的に扱えるようにする。これにより、スキルのポータビリティと信頼性が保証される。

---
*Last Refined: 2026-03-03*
*Genesis: MSN-STABILIZATION-20260303*
