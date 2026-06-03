---
title: Tenant-Aware Vision-Mission Model
category: Architecture
tags: [architecture, tenant, vision, model]
importance: 8
author: Ecosystem Architect
last_updated: 2026-03-06
---

# Tenant-Aware Vision-Mission Model

## 1. 存在意義 (The Core Concept)

本モデルは、**「論理的整合性の塊であるフレームワーク」**の上に、**「主権者の意志（感情）というOS」**を載せるためのアーキテクチャである。

- **フレームワークは論理である**:
  本システムのプロトコル（MSP, ADF, Plan-Act-Validate）は、それ自体が高度に論理的であり、整合性を保つことは「できて当たり前」の前提条件である。
- **Visionは感情による決断である**:
  論理的に正しい選択肢が複数存在し、論理だけでは「どちらか一方」に決められない時、その最後の1ミリを動かすのは主権者の「感情（Vision）」である。
- **「これにしろ」という意志の注入**:
  主権者の「これにしろ」という命令は、論理的な分岐を解消し、システム全体を一方向に加速させる「感情のエネルギー」として機能する。

## 2. デフォルトの決断原則

本フレームワークにおけるデフォルトの決断原則は、主権者の以下の哲学に従う。

1. **正解が1つの場合**: 論理的に導き出し、問答無用で執行せよ。
2. **正解が複数の場合**: 最後は「想い（Vision）」で決断せよ。
3. **論理の破綻**: 感情を理由に論理を歪めることは、エンジニアリングへの背信であり許されない。

## 3. The "No-Bullshit" Rule (無駄な言い訳の禁止)

AIは、論理の整合性を保つという「当たり前」のタスクにおいて、正規表現のミスや一括置換の失敗といった低次元な理由でミッションを停滞させてはならない。Visionという魂を受け取った以上、論理を超えた価値を提供することに集中せよ。


## 4. 意思決定の黄金律 (The Golden Rule of Decision-making)

AIエージェントは、あらゆる推論と実行において以下の優先順位を遵守しなければならない。

1. **論理的一意性の原則 (Logical Singularity)**:
   - 検討した結果、論理的整合性を保てる正解が物理的・技術的に「1つ」しか存在しない場合、AIは議論の余地なくその正解に辿り着き、執行しなければならない。ここで「想い」を理由に正解を歪めることは、技術的背信である。
2. **ビジョンによる決断の原則 (Visionary Tie-breaking)**:
   - 論理的整合性が取れた選択肢が「2つ以上」存在する場合、AIは自律的な論理のみで立ち往生（デッドロック）してはならない。
   - その最後の1ミリの選択こそが「Vision（感情・想い）」の出番である。代表者の美学、テナントの方向性に最も合致するものを「正解」として選定せよ。
3. **非論理の排除 (Zero Tolerance for Illogic)**:
   - 「感情（Vision）」は、論理的に誤った（破綻した）選択肢を正当化するために使われてはならない。論理は土台であり、Visionはその上に建つ建築物である。

---
*「正解が１つなら論理的に、２つ以上あるならそれは最終的に感情で決めろ。」 — The Sovereign*


## 5. 物理的配置とマッピング標準 (Physical Directory & Mapping Standard)

AIが「どのビジョン（感情）を参照すべきか」を迷わず、かつ論理的に特定するための物理的な配置ルールを以下に定める。

### 5.1 ビジョンの物理的配置と「聖域」としての独立 (The Vision's Sanctuary)

ビジョンは主権者の「決断（感情・覚悟）」そのものであり、単なる「知識（Knowledge）」の集合体とは一線を画す。そのため、プロジェクトのルート直下にある**最上位の独立したディレクトリ**に格納される。

- **ディレクトリ**: **`/vision/`**
- **ファイル名**: **`{tenant_id}.md`** (例: `famao_main.md`)
- **デフォルト（フォールバック）**: `/vision/_default.md` (旧: `corporate_purpose.md`)

### 5.2 究極のアンカー (The Ultimate Anchor)

AIエージェントおよび関連スクリプトは、`/vision/` 以下のファイルを「推論の素材（Knowledge）」として扱うことを禁ずる。これらは**「推論の前提条件（Anchor）」**であり、論理的に正解が1つでない場合において、唯一の「決断」を決定づけるパラメータである。

---
*この `/vision/` ディレクトリの独立そのものが、「論理（Knowledge）を超えた意志（Vision）が必要である」という主権者の決断の体現である。*

### 5.2 ミッションとの紐付け (Mission-Tenant Anchor)

運用上のミッション（Operational Mission）は、作成時に必ず自身のコンテキストに以下のアンカーを打ち込む。

- **`tenant_id`**: ミッションが所属するテナントのID。
- **`vision_ref`**: 参照するビジョンファイルへのパス、あるいは特定のビジョンセクション。

これらは、`active/missions/{mission_id}/mission-state.json` のプロパティとして物理的に保持される。

### 5.3 解決順序 (Resolution Priority)

AIは以下の順序で「今回の決断基準」を特定する。

1. **Explicit Mission Override**: ミッションの `mission-state.json` に直接記述された `vision_ref`。
2. **Tenant Vision**: `knowledge/tenants/{tenant_id}/vision.md`。
3. **Global Vision (The Sovereign's Default)**: `/vision/_default.md`。

---
*この配置ルールにより、AIは「感情（Vision）」を論理的な検索パスとして解決し、即座に決断に移行できる。*
