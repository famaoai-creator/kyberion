# Reverse Design Protocol (RDP)

## 1. Overview
本プロトコルは、既存のソースコード（実装）から、システムの意図、構造、および振る舞いを記述した設計ドキュメントを再構築するための体系的なプロセスを定義する。

## 2. The Abstraction Ladder (抽象化の梯子)
解析は以下の順序で低レベルから高レベルへと情報を引き上げる。

1.  **Artefacts (事実)**: ソースコード、設定ファイル、ディレクトリ。
2.  **Structures (構造)**: 依存グラフ、クラス図、ディレクトリマップ。
3.  **Interactions (振る舞い)**: シーケンス図、データフロー、状態遷移。
4.  **Rationales (意図)**: ビジネスルール、設計判断の背景、制約。

## 3. Systematic Extraction Process

### Phase 1: Contextual Discovery (コンテキストの発見)
- **Dependency Mapping**: `package.json` や `imports` から外部ライブラリと内部モジュールの境界を特定する。
- **Entry Point Identification**: CLIの引数処理、main関数、APIエンドポイントを起点に、ユーザーとの接点を把握する。

### Phase 2: Structural Extraction (構造の抽出)
- **Module Boundaries**: 関連するファイル群を「コンポーネント」として括り出し、役割をラベル化する。
- **Data Modeling**: スキーマ定義や型定義（TypeScript 等）から、システムが扱うエンティティの属性と関係性を抽出する。

### Phase 3: Behavioral Synthesis (振る舞いの合成)
- **Success Paths**: 主要なユースケースにおける関数呼び出しの連鎖をトレースし、シーケンス図として記述する。
- **Error Handling Strategies**: catchブロックの共通パターンから、システムの耐障害性（Resilience）設計を読み取る。

### Phase 4: Intent Recovery (意図の修復)
- **Comment Analysis**: `TODO`, `FIXME`, 文中の「なぜなら」という記述から、未解決の課題や設計上の妥協点を特定する。
- **Git History Insight**: コミットメッセージから、機能追加の動機や修正の背景にある「ビジネス上の要請」を推定する。

## 4. Output Formats (ADF Alignment)
抽出された情報は、Gemini ADF (Architecture Description Format) に変換され、以下の人間用成果物へとレンダリングされる。

- **System Context Diagram**: `design.adf.json` -> SVG
- **API/Interface Specification**: `schema.adf.json` -> Excel
- **Operation / Deployment Guide**: `delivery.adf.json` -> Word/PPT

---
*Maintained by Gemini Engineering Standards Board*
