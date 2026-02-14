# VoltMX Development Best Practices

効率的で保守性の高い VoltMX アプリケーションを構築するための指針。

## 1. UI Layout (Iris)
- **Flex Layout の活用**: `FlexContainer` を使い、パーセント指定や `preferred` サイズを適切に設定することで、レスポンシブなデザインを実現する。
- **Widget の深さを抑える**: コンポーネントの入れ子が深すぎると、レンダリング性能が低下するため注意が必要。
- **Segment の最適化**: 大量のデータを表示する場合は、`viewType` や `onRowDisplay` を活用してメモリ消費を抑える。

## 2. Coding (JavaScript)
- **グローバル変数の禁止**: `Module` 内でスコープを閉じ、`Require` JS を使用して依存関係を管理する。
- **Async/Await**: 非同期処理は `Promise` または `Async/Await` で記述し、コールバック地獄を避ける。
- **Form Lifecycle**: `onMapping`, `preShow`, `postShow` などのフォームライフサイクルを理解し、適切なタイミングでデータをロードする。

## 3. Middleware (Foundry)
- **Object Services の優先**: 単純なデータ操作には Integration Service よりも Object Services を使用することで、マッピング工数を削減する。
- **Caching**: 頻繁に変更されないデータは Foundry のキャッシュ層（Result Caching）を活用する。

---
*Created: 2026-02-14 | Focused Craftsman*
