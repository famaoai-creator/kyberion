---
title: Performance Evaluation Knowledge Base
category: Roles
tags: [roles, performance_engineer, knowledge, base]
importance: 7
author: Ecosystem Architect
last_updated: 2026-10-08
---

# Performance Evaluation Knowledge Base

性能評価エンジニアがシステムの状態を正確に把握し、改善案を提示するための統合ガイド。

## 1. 性能指標の定義 (Key Performance Indicators)

当エコシステムにおける主要な評価指標。

- **Execution Time (ms)**: 各スキルの平均実行時間。
- **Memory Footprint (MB)**: 実行時の最大ヒープ使用量 (`heapUsed`) および RSS。
- **Syntax Check Overhead**: `scripts/benchmark_memory.ts` / `scripts/benchmark_learning_efficiency.ts` で計測される、スクリプトのパース/読み込みにかかる時間。
- **Token Efficiency**: LLM呼び出し時の入力トークン量に対する出力の価値（ROI）。

## 2. 性能監視・計測ツール

- **Capability Metrics**: `libs/core/metrics.ts` により自動収集。システム行は `work/metrics/execution-metrics.jsonl`、テナント／personal・confidential 行は `active/shared/runtime/execution-metrics/<tier>/<tenant|shared>/` に記録（全体集計は `metrics.loadHistory({ read: { all: true } })`）。
- **System Benchmark**: `pnpm exec tsx scripts/benchmark_memory.ts` / `scripts/benchmark_learning_efficiency.ts` でベンチマークを実行。
- **Resource Profiler**: `libs/core/metrics.ts` と `pnpm dashboard` を使用して、詳細なボトルネック分析を実施。

## 3. 最適化の定石 (Optimization Patterns)

- **Lazy Loading**: `libs/core/plugin/skill-wrapper.ts` で扱うような、ライブラリ（Ajv等）の遅延読み込み。
- **Cache Strategy**: `libs/core/core.ts` の `Cache` クラスを用いたファイル/データのキャッシュ。
- **Parallel Execution**: `scripts/pipeline-execution-part-bootstrap.ts` の `runParallelBatches()` を利用したIO待ちの解消。

## 4. 評価基準 (Baseline & Thresholds)

- **SLA**: スキル実行は原則 5000ms 以内に完了すること。
- **Memory Limit**: 単一スキルのヒープ使用量は 200MB を超えないこと。
- **Critical Path**: `pnpm mission`（mission_controller）で実行されるパイプラインのトータル時間は、単一スキルの総和の 1.2倍以内に抑えること。

## 5. 調査・改善フロー

1. `work/metrics/execution-metrics.jsonl` から `status: "success"` かつ `duration_ms` が高いものを抽出。
2. `performance-monitor-analyst` で詳細なプロファイリングを実施。
3. `refactoring-engine` を適用し、計算量の多いロジック（重い正規表現や深いネスト）を特定・修正。
4. 修正後に `npm run benchmark` を実行し、デグレがないか確認。
