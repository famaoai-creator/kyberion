---
title: パイプライン結晶化ループ設計メモ
category: Orchestration
tags: [adf, pipeline, crystallization, deterministic, reproducibility, governance]
importance: 9
author: Kyberion
last_updated: 2026-05-04
---

# パイプライン結晶化ループ設計メモ

このメモは、実際の開発プロジェクトのように不確定要素が多い仕事を、どこまで pipeline 化し、どこから deterministic な実行に移すかを定義する。

結論:

- 実プロジェクト全体を完全 deterministic にする必要はない
- ただし pipeline に落とせる部分は、再実行可能で比較可能な形まで固める
- 固まった後は、探索ではなく governed execution として扱う

## 1. 三つのループ

### 1.1 探索ループ

目的:

- 要件の曖昧さを減らす
- 複数案を比較する
- 実装前の判断材料を集める

扱うもの:

- 仕様が未確定の仕事
- 設計方針の候補
- 依存関係の不明点

この段階では、まだ pipeline に固定しない。

### 1.2 結晶化ループ

目的:

- 探索結果を stable な pipeline 形状へ落とす
- step, input, output, guard, fallback を固定する
- 再実行時の差分を追えるようにする

扱うもの:

- `ADF` / `pipeline` の skeleton
- shared fragment 化
- preflight
- deterministic fallback
- artifact path の固定

この段階での目標は、完全な確定ではなく「十分に再現可能」であること。

### 1.3 実行ループ

目的:

- 完成した pipeline を実行する
- 失敗時は repair か validation に回す
- 新しい設計判断を増やさない

扱うもの:

- deterministic pipeline execution
- fallback の実行
- failed contract の修復
- 既存 pipeline の再実行

ここでは、探索や大きな設計変更をしない。

## 2. deterministic の意味

ここでいう deterministic は、「世界が完全に固定されている」という意味ではない。

意味するのは次の通り。

- 同じ入力なら同じ execution graph をたどる
- guard が同じなら同じ分岐を選ぶ
- input / output / artifact path が明示されている
- 成果物が rerun で比較できる

開発プロジェクトでは、外部 API、browser state、権限、タイミングなどで揺れが出る。
そのため、完全 deterministic を強制するより、**揺れる部分を明示して、残りを再現可能にする**ほうが現実的である。

## 3. 境界のルール

### 探索ループに残す条件

- 仕事の形がまだ変わる
- どの actuator / backend を使うか未確定
- 出力の正解形が未確定
- 複数の設計案を比較したい

### 結晶化ループへ進める条件

- 仕事の形がほぼ定まった
- 主要な依存関係が見えた
- 失敗条件を列挙できる
- 出力 artifact の形が決まった

### 実行ループへ移す条件

- pipeline / fragment として表現済み
- 入出力が固定済み
- fallback が明文化済み
- smoke test が通った

## 4. 運用原則

- 仕様が揺れている間は、無理に deterministic にしない
- pipeline 化できたら、そこからは再現性を優先する
- 再現性は「完全一致」ではなく「比較可能性」と「修復可能性」を含む
- 実行中の失敗は、自律デバッグ・ループで扱う

## 5. 既存ループとの関係

- `Pipeline Crystallization Loop` は、探索から実行へ移る前段階を担う
- `Autonomous Debug Loop` は、完成済みの実行で失敗した後の復旧を担う

つまり:

- 形を作る前は探索
- 形を固める間は結晶化
- 固まった後の失敗はデバッグ

