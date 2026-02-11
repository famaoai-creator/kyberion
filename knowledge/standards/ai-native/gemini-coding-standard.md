# Gemini AI-Native Coding Standard

## 1. Intelligence over Syntax
- **Predictable Patterns**: `yargs` や `runSkill` のような確立されたフレームワーク標準を必ず使用する。AI は未知のパターンよりも、既知のパターンの組み合わせにおいて最高の精度を発揮する。
- **Self-Documenting Code**: 関数名や変数名は極めて説明的にする。コメントは「何をしているか」ではなく、AI が見落としがちな「なぜそうしたか（ビジネスロジックの背景）」に集中する。

## 2. Decoupling Logic and Assets
- **The ADF Rule**: ロジック（コード）の中に、デザイン（SVGのパス, CSS）やデータ（固定の数値）を埋め込まない。
- **Externalize Knowledge**: 定数やマッピングテーブルは `knowledge/` 配下の JSON に切り出す。これにより、コードを壊さずに AI がナレッジだけをアップデートできる。

## 3. Robust Error Handling (SAAP)
- **Standardized Catch**: `catch (err)` を一貫して使用し、`ReferenceError` を防止する。
- **Informative Errors**: エラーメッセージには「何が足りないか（例：Missing --dir arg）」と「どうすれば直るか」のヒントを含める。

## 4. Test-First Evolution
- **Atomic Tests**: すべてのスキルは、独立して動作する `tests/unit.test.cjs` を持たなければならない。
- **Zero-Dependency Tests**: 外部ツール（Mocha等）に依存せず、`@gemini/core/test-utils` を使用して、どの環境でも即座に実行可能にする。

---
*Maintained by the Gemini Skills Orchestrator*
