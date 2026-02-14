# Software Development Life Cycle (SDLC) Methodologies

## 1. Waterfall (ウォーターフォール)

「計画重視・後戻り不可」の逐次型プロセス。品質と合意形成を最優先するエンタープライズ開発の標準。

### 1.1. Phases & Artifacts

| Phase               | Traditional Artifact           | Gemini ADF Equivalent         |
| :------------------ | :----------------------------- | :---------------------------- |
| **Requirements**    | 要件定義書 (PRD), WBS          | `requirements.adf.json`       |
| **External Design** | 基本設計書, システム構成図     | `design.adf.json`             |
| **Internal Design** | 詳細設計書, DB定義書           | `schema.adf.json`             |
| **Implementation**  | ソースコード, 単体テスト仕様書 | `src/`, `tests/unit.test.cjs` |
| **Testing**         | テスト結果報告書, エビデンス   | `test-results.adf.json`       |
| **Delivery**        | 納品報告書, ユーザーマニュアル | `delivery.adf.json`           |

---

## 2. Agile (アジャイル)

「対話と変化への対応」を重視する反復型プロセス。価値の早期提供と継続的改善を目指す。

### 2.1. Core Values

- プロセスやツールよりも**個人との対話**
- 包括的なドキュメントよりも**動くソフトウェア**
- 契約交渉よりも**顧客との協調**
- 計画に従うことよりも**変化への対応**

### 2.2. Artifacts

- **Product Vision**: プロジェクトの究極のゴール。
- **User Stories**: 「誰が」「何のために」「何をしたいか」を記述した簡潔なテキスト。
- **Roadmap**: 長期的なリリース計画。

---

## 3. Scrum (スクラム)

アジャイルを具現化するためのフレームワーク。「透明性・検査・適応」の 3 柱に基づき、スプリント単位で進める。

### 3.1. Roles

- **Product Owner (PO)**: 製品価値の最大化責任者。
- **Scrum Master**: スクラムの理解と成立の責任者。
- **Developers**: スプリント毎にインクリメントを作成する専門家。

### 3.2. Ceremonies & Artifacts

| Category     | Event / Artifact | Purpose                                        |
| :----------- | :--------------- | :--------------------------------------------- |
| **Planning** | Product Backlog  | 全ての要求事項の優先順位付けリスト。           |
| **Sprint**   | Sprint Backlog   | 今スプリントで完了させるタスクのリスト。       |
| **Review**   | Increment        | スプリント終了時に完成している「動く成果物」。 |
| **Tracking** | Burndown Chart   | 残タスクと時間の可視化。                       |

---

## 4. Gemini Hybrid Protocol (AI-Native SDLC)

本エコシステムでは、ウォーターフォールの「厳格な証跡」とアジャイルの「高速な回転」を、**ADF (Text-First)** を介して統合する。

- **Planned Waterfall**: 大規模な変更は ADF で計画し、AI が一気に成果物をレンダリングする。
- **Continuous Agile**: スプリント毎の差分を AI が検知し、ADF とドキュメントを自動同期（Self-Sync）する。

---

_Reference: Synthesized from Agile Manifesto, Scrum Guide, and IEEE/ISO Standards_
