---
title: Pipeline Crystallization Loop
category: Orchestration
tags: [adf, pipeline, crystallization, deterministic, reproducibility, governance]
importance: 9
author: Kyberion
last_updated: 2026-05-04
---

# Pipeline Crystallization Loop

このループは、mission を stable な ADF pipeline に固める前段階を扱う。

目標は、現実の開発プロジェクトを完全 deterministic にすることではない。
それは要件、依存関係、関係者判断が変わる以上、普通は無理がある。
目標はもっと狭い。

- 曖昧さを減らして、流れを pipeline として表現できる状態にする
- 安定した部分を明示的な step と guard に固定する
- 結果の pipeline を rerun / compare / repair できる程度に再現可能にする

## 1. このループが必要な理由

仕事の出発点が探索であることは多い。

- 問題定義がまだ完全ではない
- どの順序で進めるべきか未確定
- 有効な実行形が複数ある
- 実行前に案を比較したい

この段階で無理に deterministic に寄せると、pipeline はたいてい brittle になる。

そのため、まずは探索形を governed な pipeline artifact に変換するための crystallization loop を通す。

## 2. ここでいう deterministic

deterministic とは、「世界に不確定性がない」という意味ではない。
意味するのは次の通り。

- 同じ input context なら同じ execution graph をたどる
- 同じ guard なら同じ branch decision を選ぶ
- runtime 依存は明示的に宣言される
- 同じ output 形を rerun 間で再現または diff できる

完全 deterministic にできない仕事でも、pipeline は再現可能であるべきだ。

- 入力 contract が固定されている
- fallback behavior が明示されている
- artifact path が安定している
- failure mode が見える
- runtime assumption に version が付いている

## 3. ループの段階

### 3.1 Explore

task がまだ under-specified なときに使う。

許容される振る舞い:

- approach を比較する
- alternative design に fan out する
- evidence を集める
- 意図する flow を書き直す

ここでは、まだ flow を固定しない。

### 3.2 Normalize

選んだ approach を stable な形に整える。

行うこと:

- input を命名する
- output を命名する
- guard を特定する
- live execution と post-processing を分ける
- brittle な shell や backend の詳細を actuator の向こうに寄せる

### 3.3 Crystallize

normalized な形を pipeline に変換する。

pipeline には次が必要。

- explicit steps
- explicit context variables
- explicit failure conditions
- 必要な explicit fallback paths
- explicit artifact locations

### 3.4 Verify

real data か representative data で pipeline を走らせる。

確認すること:

- end-to-end で動くか
- artifact が期待通りに出るか
- fallback branch が文書化されているか
- rerun して output を比較できるか

### 3.5 Freeze

十分に安定したら、その pipeline を source of truth として扱う。

freeze 後は:

- 変更は patch か repair 経由にする
- exploration ロジックを pipeline の外に出す
- nondeterministic な挙動は isolate して document する

## 4. 退出条件

次の条件を満たしたら、work item は crystallization loop を抜けてもよい。

- flow が pipeline か fragment として表現されている
- runtime input が explicit である
- fallback behavior が文書化されている
- smoke test が通っている
- 残る variance が理解され、許容できる

これらが満たされないなら、仕事はまだ exploratory であり、loop に残す。

## 5. 実務ルール

目安は次の通り。

- 仕事の形がまだ変わるなら crystallization loop に留める
- 仕事の形が固定されたら deterministic pipeline execution に移す
- runtime を完全 deterministic にできないなら、nondeterminism を明示し、それ以外を再現可能に保つ
